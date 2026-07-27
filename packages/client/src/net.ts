import {
  ENGINE_VERSION, Phase, aiPoll, createAi, createGameState, restore, setMatchItems, snapshot, stateHash, step,
} from '@af/core';
import type { AiState, GameState, InputFrame, ItemEffect } from '@af/core';

/**
 * Online netplay session — GGPO-style rollback over the match-server relay
 * (ADR 0003). Transport-agnostic by design: the same prediction/rollback
 * machinery runs unchanged when WebRTC P2P replaces the relay for
 * human↔human latency later.
 *
 * Per tick: my input is scheduled `delay` ticks ahead (symmetric on both
 * sides) and sent; the opponent's input is used if known, otherwise
 * PREDICTED as their last known input. When the real input arrives and the
 * prediction was wrong, we restore the snapshot taken before the first
 * mispredicted tick and re-simulate — a few ticks of a 2-fighter sim,
 * microseconds. If we get too far ahead of the opponent we stall a frame
 * (the classic GGPO throttle) rather than drift.
 */

// Protocol constants — must match packages/server/src/protocol.ts.
// Must match the server's PROTOCOL_VERSION. v8 = TICKETS (ADR 0009): a decided
// wager burns both entries instead of paying a pot, so a v7 client would
// advertise stakes that no longer exist.
const NET_PROTOCOL = 8;
const MAX_AHEAD = 15;
const HASH_EVERY = 60;
const SNAP_RING = 128;
/** Client-initiated RTT probe cadence (connection-quality overlay). */
const PING_MS = 2_000;

export interface NetSetup {
  matchId: string;
  side: 0 | 1;
  seed: number;
  stage: string;
  /** VIEW-LOCK bounds (world px) pinned by the server. Passed to every
   *  createGameState (begin + resume rebuild) so the sim walls match the
   *  server's verifier. Absent = full-width stage. */
  bounds?: { left: number; right: number };
  delay: number;
  chars: [{ id: string; hash?: string }, { id: string; hash?: string }];
  names: [string, string];
  agents: [boolean, boolean];
  mode?: 'wager' | 'solo' | 'arcade' | 'friendly';
  fee?: number;
  /** v3 local-sim solo: the deterministic house AI this client simulates.
   *  `personality` present = the opponent is a TRAINED agent (dare-vs-agent
   *  / sparring, ADR 0006) — the sim MUST construct it with these knobs or
   *  the server's re-sim disagrees and the match won't settle. */
  solo?: { skill: number; aiSeed: number; personality?: Record<string, number> };
  /**
   * AGENT ARCADE (v4): run position + the bearer token that re-queues the
   * run for the next battle after a verified win.
   */
  arcade?: { token: string; node: number; fights: number; total: number };
  /**
   * CONSUMABLES (ADR 0007 Phase 2): the server-pinned per-side drinks. The
   * sim applies items ONLY from this echo — never from what we asked for —
   * so an old server (which ignores CQueue.item) simply means an item-less
   * match, not a desync. Installed via installSetupItems() before EVERY
   * createGameState (begin + resume rebuild); absent clears the slot.
   */
  items?: [NetItemPin[], NetItemPin[]];
  /** This side's resume token — lets a dropped socket rejoin (ADR 0005). */
  resume?: string;
}

/** One pinned drink as it rides the setup (display fields + sim effect). */
export interface NetItemPin {
  id: string;
  name: string;
  tier: number;
  effect: { kind: string; amount: number; durationTicks: number };
}

/** Install a setup's pinned drink loadouts into core — part of match construction. */
const installSetupItems = (s: NetSetup): void => {
  setMatchItems(
    s.items?.[0]?.map((p) => p.effect as ItemEffect) ?? null,
    s.items?.[1]?.map((p) => p.effect as ItemEffect) ?? null,
  );
};

export interface NetResult {
  winner: number;
  reason: 'verified' | 'forfeit' | 'incomplete';
  rounds: [number, number];
  endTick: number;
  hash: number;
  deviator?: 0 | 1;
}

export type NetStatus = 'connecting' | 'queued' | 'playing' | 'reconnecting' | 'done' | 'error';

/** Resume retry policy: a handful of quick attempts inside the server's
 * FORFEIT_GRACE window (20s) — 6 × ~1.6s covers a router blip with room. */
const RESUME_ATTEMPTS = 6;
const RESUME_RETRY_MS = 1_600;

/** Live account snapshot from the server (credits economy). */
export interface NetAccount {
  credits: number;
  level: number;
  xp: number;
  wins: number;
  losses: number;
  dailyGranted: boolean;
  /** This player's shareable dare code (landing /dare/<code>). */
  refCode?: string;
  /** Credits granted by THIS snapshot redeeming a referral (0 = none). */
  referralGranted?: number;
  /** Friends who ever redeemed this player's dare code (inviter side). */
  daresAccepted?: number;
  /** Inviter payouts credited in the rolling week (server caps at 10). */
  daresPaidWeek?: number;
  /** Wager TICKETS (ADR 0009) — a cosmetic collectible, never spendable. */
  tickets?: number;
}

/** Post-match account progression, server-authoritative (Phase B/C). */
export interface NetXp {
  gained: number;
  levelsUp: number;
  level: number;
  xp: number;
  wins: number;
  losses: number;
  creditsDelta: number;
  credits: number;
  /** Free vending pulls earned this match (one per level gained); the client
   *  resolves each id → full item def and reveals it on the results screen. */
  freePulls?: { itemId: string; tier: number }[];
  /** This win minted a wager ticket (ADR 0009); `tickets` = new balance. */
  ticket?: boolean;
  tickets?: number;
}

export class NetSession {
  status: NetStatus = 'connecting';
  error = '';
  setup: NetSetup | null = null;
  result: NetResult | null = null;
  /** Arrives after hello when persistence is on — drives the credits HUD. */
  account: NetAccount | null = null;
  /** Arrives after the result, only when logged in — drives the XP banner. */
  xp: NetXp | null = null;
  game: GameState | null = null;
  /** Ticks currently stalled waiting on the opponent (UI: "connection…"). */
  stalled = 0;
  /**
   * Wall-clock deadline (Date.now() ms) the opponent must reconnect by, set
   * from the server's `oppgone` heads-up (v6); null when the peer is present.
   * Drives the "OPPONENT DISCONNECTED — reconnecting… Ns" countdown. Cleared
   * by `oppback` or the final `result`.
   */
  oppGoneUntil: number | null = null;
  /** Measured round-trip to the relay in ms (EMA; -1 until the first pong). */
  rtt = -1;
  /** Depth (ticks) of the most recent rollback re-sim — connection telemetry. */
  lastRollback = 0;
  /** Deepest rollback this match — how hard prediction is working. */
  maxRollback = 0;
  /** Total ticks spent stalled this match (`stalled` is just the current run). */
  stallTotal = 0;

  private ws!: WebSocket;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private myInputs: number[] = [];
  private oppInputs: (number | undefined)[] = [];
  private usedOpp: number[] = [];
  private snaps: (GameState | null)[] = new Array(SNAP_RING).fill(null);
  private localTick = 0;
  private oppKnown = 0; // opponent inputs contiguous from 0 up to (exclusive)
  private resimFrom = -1;
  private overSent = false;
  /** Wall-clock when 'over' went out — arms the verification watchdog. */
  private overSentAt = 0;
  private nextHashTick = 0; // last CONFIRMED checkpoint reported to the server
  private intentionalClose = false;
  private resumeAttempts = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private url: string,
    private name: string,
    private character: string,
    private bundleHash?: string,
    private authToken?: string,
    private mode: 'wager' | 'friendly' = 'wager',
    private email?: string, // AIR-account email — reputation write-back target only
    private ref?: string, // stashed dare code (?ref=) — redeemed server-side once
    private room?: string, // friendly rendezvous code (mode 'friendly' only)
  ) {
    this.connect(false);
  }

  /** Open a socket — either the initial queue or a resume of a live match. */
  private connect(resume: boolean): void {
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.send({ t: 'hello', v: NET_PROTOCOL, name: this.name, engine: ENGINE_VERSION, auth: this.authToken, email: this.email, ref: this.ref });
      if (resume && this.setup?.resume) {
        this.send({ t: 'resume', matchId: this.setup.matchId, token: this.setup.resume });
      } else {
        this.send({ t: 'queue', character: this.character, bundleHash: this.bundleHash, mode: this.mode, room: this.room });
        this.status = 'queued';
      }
      // RTT probe loop (additive to protocol 6 — an old server just never
      // answers). send() drops pings while the socket is closed/reconnecting.
      this.startPing();
    };
    // A failed pre-match connection is fatal; mid-resume failures fall
    // through to onclose, which schedules the next attempt.
    ws.onerror = () => {
      if (this.status !== 'done' && this.status !== 'reconnecting') {
        this.status = 'error';
        this.error = 'connection failed';
      }
    };
    ws.onclose = () => this.onSocketClose();
    ws.onmessage = (ev) => this.onMessage(String(ev.data));
  }

  /**
   * The reconnect state machine (ADR 0005): a socket dropping MID-MATCH is
   * not the end — the server holds our seat for FORFEIT_GRACE_MS and the
   * resume token gets us back in. Only an intentional close (the player
   * leaving) or exhausted retries settle into 'error'.
   */
  private onSocketClose(): void {
    this.stopPing(); // a fresh loop starts on the next successful onopen
    if (this.intentionalClose || this.status === 'done' || this.status === 'error') return;
    const canResume = !!this.setup?.resume && !this.result;
    if ((this.status === 'playing' && canResume) || this.status === 'reconnecting') {
      if (this.status !== 'reconnecting') {
        this.status = 'reconnecting';
        this.resumeAttempts = 0;
      }
      if (this.resumeAttempts >= RESUME_ATTEMPTS) {
        this.status = 'error';
        this.error = 'could not reconnect';
        return;
      }
      this.resumeAttempts++;
      this.retryTimer = setTimeout(() => this.connect(true), this.resumeAttempts === 1 ? 50 : RESUME_RETRY_MS);
      return;
    }
    this.status = 'error';
    this.error = 'connection lost';
  }

  close(): void {
    this.intentionalClose = true;
    this.stopPing();
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    if (this.status === 'reconnecting') {
      this.status = 'error';
      this.error = 'left the match';
    }
    try { this.ws.close(); } catch { /* already closed */ }
  }

  /** Test hook: sever the socket WITHOUT the intent flag (simulated blip). */
  debugDrop(): void {
    try { this.ws.close(); } catch { /* already closed */ }
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => this.send({ t: 'ping', ts: Date.now() }), PING_MS);
  }

  private stopPing(): void {
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
  }

  private send(msg: unknown): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private onMessage(raw: string): void {
    const msg = JSON.parse(raw) as { t: string } & Record<string, unknown>;
    switch (msg.t) {
      case 'error':
        this.status = 'error';
        this.error = String(msg.msg ?? 'server error');
        this.stopPing();
        return;
      case 'ping':
        // The server's lobby probe (sizes the adaptive input delay): echo
        // its clock back verbatim.
        this.send({ t: 'pong', ts: msg.ts });
        return;
      case 'pong': {
        // Echo of OUR probe — sample = now minus the clock we sent.
        const sample = Date.now() - Number(msg.ts);
        if (Number.isFinite(sample) && sample >= 0 && sample < 60_000) {
          this.rtt = this.rtt < 0 ? sample : Math.round(this.rtt * 0.7 + sample * 0.3);
        }
        return;
      }
      case 'account': {
        this.account = {
          credits: Number(msg.credits ?? 0),
          level: Number(msg.level ?? 1),
          xp: Number(msg.xp ?? 0),
          wins: Number(msg.wins ?? 0),
          losses: Number(msg.losses ?? 0),
          dailyGranted: Boolean(msg.dailyGranted),
          refCode: typeof msg.refCode === 'string' ? msg.refCode : undefined,
          referralGranted: Number(msg.referralGranted ?? 0),
          tickets: Number(msg.tickets ?? 0),
        };
        return;
      }
      case 'match': {
        this.setup = msg as unknown as NetSetup;
        // The caller installs characters/stage, then calls begin().
        return;
      }
      case 'resumed': {
        this.rebuildFrom(msg as unknown as NetSetup & { inputs: [(number | null)[], (number | null)[]] });
        return;
      }
      case 'i': {
        const k = msg.k as number;
        const v = msg.v as number;
        this.oppInputs[k] = v;
        while (this.oppInputs[this.oppKnown] !== undefined) this.oppKnown++;
        // Misprediction? Mark the earliest tick that must be re-simulated.
        if (k < this.localTick && this.usedOpp[k] !== v) {
          this.resimFrom = this.resimFrom < 0 ? k : Math.min(this.resimFrom, k);
        }
        return;
      }
      case 'oppgone': {
        // Opponent's socket dropped (v6) — start the reconnect countdown so
        // the fight screen explains the stall instead of freezing silently.
        this.oppGoneUntil = Date.now() + Number(msg.graceMs ?? 0);
        return;
      }
      case 'oppback': {
        this.oppGoneUntil = null; // opponent reconnected within grace
        return;
      }
      case 'result': {
        this.result = msg as unknown as NetResult;
        this.status = 'done';
        this.oppGoneUntil = null;
        this.stopPing();
        return;
      }
      case 'xp': {
        this.xp = msg as unknown as NetXp;
        if (this.account && this.xp) {
          this.account = {
            ...this.account,
            credits: this.xp.credits,
            level: this.xp.level,
            xp: this.xp.xp,
            wins: this.xp.wins,
            losses: this.xp.losses,
            // Only a MINT carries a balance (ADR 0009) — otherwise keep the
            // count the account snapshot already has.
            ...(this.xp.ticket ? { tickets: this.xp.tickets } : {}),
          };
        }
        return;
      }
      default:
        return;
    }
  }

  /** Call after installing characters for the pinned setup. */
  begin(): void {
    const s = this.setup!;
    installSetupItems(s);
    this.game = createGameState(s.seed, s.bounds);
    // First `delay` ticks are neutral by convention — symmetric with the peer.
    for (let k = 0; k < s.delay; k++) {
      this.myInputs[k] = 0;
      this.send({ t: 'i', k, v: 0 });
    }
    // A throttled tab can receive setup AND the result before its first frame
    // runs begin() (e.g. queue, lock the phone, opponent forfeits). 'done' is
    // terminal — resurrecting 'playing' here left the client in a dead fight
    // the results transition (which keys on 'done') could never leave.
    if (this.status !== 'done') this.status = 'playing';
  }

  /**
   * Successful resume: rebuild the ENTIRE sim from the server's ledger —
   * fresh game state, lockstep replay of the both-known prefix (repopulating
   * the snapshot ring exactly like frame() would have), then hand back to the
   * normal rollback loop. Characters/stage are still installed client-side
   * from the original setup; the pinned data has not changed.
   */
  private rebuildFrom(s: NetSetup & { inputs: [(number | null)[], (number | null)[]] }): void {
    this.setup = s;
    const asSparse = (a: (number | null)[]): (number | undefined)[] =>
      a.map((v) => (v === null ? undefined : v));
    this.myInputs = asSparse(s.side === 0 ? s.inputs[0] : s.inputs[1]) as number[];
    this.oppInputs = asSparse(s.side === 0 ? s.inputs[1] : s.inputs[0]);
    this.usedOpp = [];
    this.snaps = new Array(SNAP_RING).fill(null);
    installSetupItems(s);
    this.game = createGameState(s.seed, s.bounds);
    let t = 0;
    while (
      this.myInputs[t] !== undefined && this.oppInputs[t] !== undefined
      && this.game.phase !== Phase.MatchOver
    ) {
      const opp = this.oppInputs[t]!;
      this.usedOpp[t] = opp;
      this.snaps[t % SNAP_RING] = snapshot(this.game);
      this.stepTick(t, this.myInputs[t]!, opp);
      t++;
    }
    this.localTick = t;
    let k = 0;
    while (this.oppInputs[k] !== undefined) k++;
    this.oppKnown = k;
    this.resimFrom = -1;
    this.overSent = false; // replay may re-reach MatchOver; 'over' is idempotent
    this.overSentAt = 0;
    this.nextHashTick = Math.floor(Math.max(0, this.localTick - 1) / HASH_EVERY) * HASH_EVERY;
    this.resumeAttempts = 0;
    this.status = 'playing';
  }

  /** My side's fighter index (for HUD orientation etc.). */
  get side(): 0 | 1 { return this.setup?.side ?? 0; }

  private lastKnownOpp(): number {
    return this.oppKnown > 0 ? this.oppInputs[this.oppKnown - 1]! : 0;
  }

  private stepTick(t: number, mine: number, opp: number): void {
    const g = this.game!;
    step(g, this.side === 0 ? [mine, opp] : [opp, mine]);
  }

  /**
   * Advance one tick with the local pad input. Renders can always use
   * `this.game`; a false return means we stalled waiting on the opponent.
   */
  frame(pad: InputFrame): boolean {
    if (!this.game || this.status !== 'playing') return false;
    this.checkVerifyWatchdog(); // runs even when MatchOver halts stepping
    const s = this.setup!;

    // Apply pending rollback before stepping forward.
    if (this.resimFrom >= 0 && this.resimFrom < this.localTick) {
      const from = this.resimFrom;
      this.lastRollback = this.localTick - from;
      if (this.lastRollback > this.maxRollback) this.maxRollback = this.lastRollback;
      restore(this.game, this.snaps[from % SNAP_RING]!);
      for (let t = from; t < this.localTick; t++) {
        const opp = this.oppInputs[t] ?? this.lastKnownOpp();
        this.usedOpp[t] = opp;
        this.snaps[t % SNAP_RING] = snapshot(this.game);
        this.stepTick(t, this.myInputs[t] ?? 0, opp);
      }
    }
    this.resimFrom = -1;

    // Desync checkpoints — CONFIRMED ticks only. A hash taken from a
    // predicted state would falsely flag *us* as the deviator when a later
    // correction rewrites it (the snapshot ring holds the state BEFORE each
    // tick, which is exactly the server's "after k steps" re-sim state).
    //
    // Two hard-won bounds (both false-flagged real matches when violated):
    //  · k ≤ localTick-1 — tick k's snapshot only exists once k was STEPPED;
    //    at k == localTick the ring slot still holds tick k-128's state.
    //  · k ≥ localTick-100 — older slots have been overwritten by the ring.
    //    Checkpoints that scrolled out are skipped, never hashed stale.
    const confirmed = Math.min(this.localTick - 1, this.oppKnown);
    if (this.nextHashTick < this.localTick - 100) {
      this.nextHashTick = Math.max(this.nextHashTick,
        Math.floor((this.localTick - 100) / HASH_EVERY) * HASH_EVERY);
    }
    while (this.nextHashTick + HASH_EVERY <= confirmed) {
      this.nextHashTick += HASH_EVERY;
      const snapAt = this.snaps[this.nextHashTick % SNAP_RING];
      if (snapAt) this.send({ t: 'h', k: this.nextHashTick, x: stateHash(snapAt) });
    }

    // GGPO throttle: never simulate too far past the opponent's confirmed inputs.
    if (this.localTick - this.oppKnown > MAX_AHEAD) {
      this.stalled++;
      this.stallTotal++;
      return false;
    }
    this.stalled = 0;

    const t = this.localTick;
    // Schedule + send my input for t+delay (both sides do this — symmetric).
    if (this.myInputs[t + s.delay] === undefined) {
      this.myInputs[t + s.delay] = pad;
      this.send({ t: 'i', k: t + s.delay, v: pad });
    }

    const mine = this.myInputs[t] ?? 0;
    const opp = this.oppInputs[t] ?? this.lastKnownOpp();
    this.usedOpp[t] = opp;
    this.snaps[t % SNAP_RING] = snapshot(this.game);
    this.stepTick(t, mine, opp);
    this.localTick++;

    if (this.game.phase === Phase.MatchOver && !this.overSent) {
      this.overSent = true;
      this.overSentAt = Date.now();
      this.send({ t: 'over', k: this.localTick });
    }
    this.checkVerifyWatchdog();
    return true;
  }

  /**
   * VERIFICATION WATCHDOG: 'over' was sent but no result arrived. Seen live
   * when a server deploy/restart stranded a match mid-verification — the
   * proxied socket never closes cleanly, so without this the client sits on
   * "VERIFYING WITH SERVER…" forever. Money is safe either way (the escrow
   * sweeper settles stranded fees server-side); this just tells the human.
   */
  checkVerifyWatchdog(): void {
    if (this.overSentAt && !this.result && this.status === 'playing'
      && Date.now() - this.overSentAt > 25_000) {
      this.status = 'error';
      this.error = 'the server stopped answering mid-verification — stranded fees refund automatically';
    }
  }
}

// ---------------------------------------------------------- local-sim solo
/**
 * Ranked solo, protocol v3: ZERO-LATENCY local simulation. The server pins a
 * deterministic house AI (skill, aiSeed) in the match setup; this session
 * steps the ENTIRE match locally — your pad against aiPoll — exactly like
 * offline play (no input delay, no prediction, no stalls), and streams only
 * your per-tick inputs. Settlement stays trustless: the verifier re-derives
 * the same AI from the same seed, so a client that simulated any other
 * opponent fails the re-sim. Wall-clock pacing is checked server-side
 * (SOLO_PACE_*) — slow-motion or fast-forward tampering refunds as
 * incomplete instead of settling.
 *
 * Public surface mirrors NetSession — main.ts uses them interchangeably.
 */
export class SoloSession {
  status: NetStatus = 'connecting';
  error = '';
  setup: NetSetup | null = null;
  result: NetResult | null = null;
  account: NetAccount | null = null;
  xp: NetXp | null = null;
  game: GameState | null = null;
  stalled = 0; // never stalls — kept for the shared interface
  oppGoneUntil: number | null = null; // no peer socket — kept for the shared interface
  // Local sim has no netplay telemetry — kept for the shared interface.
  rtt = -1;
  lastRollback = 0;
  maxRollback = 0;
  stallTotal = 0;

  private ws!: WebSocket;
  private houseAi: AiState | null = null;
  /**
   * TRAIN MY AGENT hands-free mode (ADR 0006 obj. 2): non-null = the
   * player's COACHED agent is on the sticks. Its outputs are ordinary
   * side-0 inputs streamed like any others — the server's re-sim neither
   * knows nor cares who generated them, so nothing about verification,
   * pace checks, or settlement changes. Solo/arcade only by construction
   * (this class never runs wager matches).
   */
  private autoAi: AiState | null = null;
  private tick = 0;
  private overSent = false;
  /** Wall-clock when 'over' went out — arms the verification watchdog. */
  private overSentAt = 0;
  private intentionalClose = false;
  private resumeAttempts = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private url: string,
    private name: string,
    private character: string,
    private bundleHash?: string,
    private authToken?: string,
    private email?: string,
    private ref?: string, // stashed dare code (?ref=) — redeemed server-side once
    /**
     * AGENT ARCADE v2 (v7, ADR 0008): queue one battle of a gauntlet run
     * instead of a single solo match. `runToken` continues the run (minted
     * by POST /arcade/enter, re-armed by every verified win) and `node` is
     * the board node the player chose to move to — THE MOVE IS THE QUEUE.
     * Omitting `node` puts the server on autopilot (headless agents only).
     */
    private arcadeQueue?: { runToken?: string; node?: number },
    /**
     * DARE-VS-AGENT / SPARRING (ADR 0006): fight the TRAINED agent behind
     * this dare/ref code instead of the house AI (your own code = sparring).
     * Solo mode only — ignored when arcadeQueue is set.
     */
    private agentOf?: string,
    /**
     * CONSUMABLES (ADR 0007 Phase 2): inventory rowId of ONE drink to carry
     * into this match. The buff only applies if the server echoes it back in
     * setup.items (an old server silently yields an item-less match).
     */
  ) {
    this.connect(false);
  }

  private connect(resume: boolean): void {
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.send({ t: 'hello', v: NET_PROTOCOL, name: this.name, engine: ENGINE_VERSION, auth: this.authToken, email: this.email, ref: this.ref });
      if (resume && this.setup?.resume) {
        this.send({ t: 'resume', matchId: this.setup.matchId, token: this.setup.resume });
      } else {
        this.send({
          t: 'queue', character: this.character, bundleHash: this.bundleHash,
          mode: this.arcadeQueue ? 'arcade' : 'solo',
          runToken: this.arcadeQueue?.runToken || undefined,
          arcadeNode: this.arcadeQueue?.node,
          agentOf: this.arcadeQueue ? undefined : this.agentOf || undefined,
        });
        this.status = 'queued';
      }
    };
    ws.onerror = () => {
      if (this.status !== 'done' && this.status !== 'reconnecting') {
        this.status = 'error';
        this.error = 'connection failed';
      }
    };
    ws.onclose = () => this.onSocketClose();
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data)) as { t: string } & Record<string, unknown>;
      switch (msg.t) {
        case 'error':
          this.status = 'error';
          this.error = String(msg.msg ?? 'server error');
          return;
        case 'account':
          this.account = msg as unknown as NetAccount;
          return;
        case 'match':
          this.setup = msg as unknown as NetSetup;
          return;
        case 'resumed':
          this.rebuildFrom(msg as unknown as NetSetup & { inputs: [(number | null)[], (number | null)[]] });
          return;
        case 'result':
          this.result = msg as unknown as NetResult;
          this.status = 'done';
          return;
        case 'xp':
          this.xp = msg as unknown as NetXp;
          return;
        default:
      }
    };
  }

  /** Same reconnect ladder as NetSession (ADR 0005) — see there for why. */
  private onSocketClose(): void {
    if (this.intentionalClose || this.status === 'done' || this.status === 'error') return;
    const canResume = !!this.setup?.resume && !this.result;
    if ((this.status === 'playing' && canResume) || this.status === 'reconnecting') {
      if (this.status !== 'reconnecting') {
        this.status = 'reconnecting';
        this.resumeAttempts = 0;
      }
      if (this.resumeAttempts >= RESUME_ATTEMPTS) {
        this.status = 'error';
        this.error = 'could not reconnect';
        return;
      }
      this.resumeAttempts++;
      this.retryTimer = setTimeout(() => this.connect(true), this.resumeAttempts === 1 ? 50 : RESUME_RETRY_MS);
      return;
    }
    this.status = 'error';
    this.error = 'connection lost';
  }

  /**
   * Resume rebuild, local-sim style: replay MY OWN contiguous inputs against
   * a fresh copy of the pinned house AI — identical to what the verifier
   * does, so the rebuilt state is exactly where the match really is.
   */
  private rebuildFrom(s: NetSetup & { inputs: [(number | null)[], (number | null)[]] }): void {
    this.setup = s;
    installSetupItems(s);
    this.game = createGameState(s.seed, s.bounds);
    this.houseAi = createAi(1, s.solo!.skill, s.solo!.aiSeed, s.solo!.personality);
    const mine = s.inputs[0];
    let t = 0;
    while (t < mine.length && mine[t] !== null && this.game.phase !== Phase.MatchOver) {
      const opp = aiPoll(this.houseAi, this.game);
      step(this.game, [mine[t]! | 0, opp]);
      t++;
    }
    this.tick = t;
    this.overSent = false; // 'over' is idempotent server-side
    this.overSentAt = 0;
    this.resumeAttempts = 0;
    this.status = 'playing';
  }

  get side(): 0 | 1 { return 0; } // solo player is always side 0

  /** Hands-free state — main.ts renders the AUTO chip off this. */
  get auto(): boolean { return !!this.autoAi; }

  /**
   * Toggle hands-free. `skill` is level-derived by the CALLER (mirror of the
   * server's house ramp — the coached agent is exactly as strong as the
   * house at your level, style aside); `personality` is the agent_config
   * saved by the coach, clamped again inside createAi. Seeding off the
   * match seed + current tick keeps re-toggles from replaying the same
   * decision stream mid-match.
   */
  setAuto(on: boolean, skill: number, personality?: Record<string, number>): void {
    if (!on || !this.setup) { this.autoAi = null; return; }
    this.autoAi = createAi(0, skill, (this.setup.seed ^ 0x0a70 ^ this.tick) | 0, personality);
  }

  close(): void {
    this.intentionalClose = true;
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    if (this.status === 'reconnecting') {
      this.status = 'error';
      this.error = 'left the match';
    }
    try { this.ws.close(); } catch { /* already closed */ }
  }

  /** Test hook: sever the socket WITHOUT the intent flag (simulated blip). */
  debugDrop(): void {
    try { this.ws.close(); } catch { /* already closed */ }
  }

  private send(msg: unknown): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  /** Call after installing characters for the pinned setup. */
  begin(): void {
    const s = this.setup!;
    installSetupItems(s);
    this.game = createGameState(s.seed, s.bounds);
    this.houseAi = createAi(1, s.solo!.skill, s.solo!.aiSeed, s.solo!.personality);
    // Same throttled-tab race as NetSession.begin(): a result that landed
    // before the first frame must keep its terminal status.
    if (this.status !== 'done') this.status = 'playing';
  }

  /** Advance one tick — pure local sim; always succeeds while playing. */
  frame(pad: InputFrame): boolean {
    if (!this.game || !this.houseAi || this.status !== 'playing') return false;
    const g = this.game;
    if (g.phase === Phase.MatchOver) {
      if (!this.overSent) { this.overSent = true; this.overSentAt = Date.now(); this.send({ t: 'over', k: this.tick }); }
      this.checkVerifyWatchdog();
      return false;
    }
    // AUTO: the coached agent's decision replaces the pad wholesale (poll
    // order matters — OUR ai before the house ai, matching createAi order).
    const mine: InputFrame = this.autoAi ? aiPoll(this.autoAi, g) : pad;
    this.send({ t: 'i', k: this.tick, v: mine });
    const opp = aiPoll(this.houseAi, g); // aiPoll BEFORE step — verifier ordering
    step(g, [mine, opp]);
    this.tick++;
    if (this.tick % HASH_EVERY === 0) this.send({ t: 'h', k: this.tick, x: stateHash(g) });
    // step() mutates phase — TS's narrowing from the guard above is stale.
    if ((g.phase as Phase) === Phase.MatchOver && !this.overSent) {
      this.overSent = true;
      this.overSentAt = Date.now();
      this.send({ t: 'over', k: this.tick });
    }
    return true;
  }

  /**
   * VERIFICATION WATCHDOG (mirrors NetSession): 'over' sent, no result.
   * Seen live: a prod deploy restarted the server mid-verification and the
   * proxied socket never closed — the client sat on "VERIFYING WITH
   * SERVER…" forever. Surface the existing net-error overlay instead;
   * stranded fees refund via the server's escrow sweeper.
   */
  checkVerifyWatchdog(): void {
    if (this.overSentAt && !this.result && this.status === 'playing'
      && Date.now() - this.overSentAt > 25_000) {
      this.status = 'error';
      this.error = 'the server stopped answering mid-verification — stranded fees refund automatically';
    }
  }
}

/** What main.ts programs against — rollback PvP or local-sim solo. */
export type Session = NetSession | SoloSession;
