import {
  ENGINE_VERSION, Phase, createGameState, restore, snapshot, stateHash, step,
} from '@af/core';
import type { GameState, InputFrame } from '@af/core';

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
const NET_PROTOCOL = 2;
const MAX_AHEAD = 10;
const HASH_EVERY = 60;
const SNAP_RING = 128;

export interface NetSetup {
  matchId: string;
  side: 0 | 1;
  seed: number;
  stage: string;
  delay: number;
  chars: [{ id: string; hash?: string }, { id: string; hash?: string }];
  names: [string, string];
  agents: [boolean, boolean];
  mode?: 'wager' | 'solo';
  fee?: number;
}

export interface NetResult {
  winner: number;
  reason: 'verified' | 'forfeit' | 'incomplete';
  rounds: [number, number];
  endTick: number;
  hash: number;
  deviator?: 0 | 1;
}

export type NetStatus = 'connecting' | 'queued' | 'playing' | 'done' | 'error';

/** Live account snapshot from the server (credits economy). */
export interface NetAccount {
  credits: number;
  level: number;
  xp: number;
  wins: number;
  losses: number;
  dailyGranted: boolean;
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

  private ws: WebSocket;
  private myInputs: number[] = [];
  private oppInputs: (number | undefined)[] = [];
  private usedOpp: number[] = [];
  private snaps: (GameState | null)[] = new Array(SNAP_RING).fill(null);
  private localTick = 0;
  private oppKnown = 0; // opponent inputs contiguous from 0 up to (exclusive)
  private resimFrom = -1;
  private overSent = false;
  private nextHashTick = 0; // last CONFIRMED checkpoint reported to the server

  constructor(
    url: string,
    name: string,
    character: string,
    bundleHash?: string,
    authToken?: string,
    mode: 'wager' | 'solo' = 'wager',
  ) {
    this.ws = new WebSocket(url);
    this.ws.onopen = () => {
      this.send({ t: 'hello', v: NET_PROTOCOL, name, engine: ENGINE_VERSION, auth: authToken });
      this.send({ t: 'queue', character, bundleHash, mode });
      this.status = 'queued';
    };
    this.ws.onerror = () => {
      if (this.status !== 'done') { this.status = 'error'; this.error = 'connection failed'; }
    };
    this.ws.onclose = () => {
      if (this.status !== 'done' && this.status !== 'error') {
        this.status = 'error';
        this.error = 'connection lost';
      }
    };
    this.ws.onmessage = (ev) => this.onMessage(String(ev.data));
  }

  close(): void {
    try { this.ws.close(); } catch { /* already closed */ }
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
        return;
      case 'account': {
        this.account = {
          credits: Number(msg.credits ?? 0),
          level: Number(msg.level ?? 1),
          xp: Number(msg.xp ?? 0),
          wins: Number(msg.wins ?? 0),
          losses: Number(msg.losses ?? 0),
          dailyGranted: Boolean(msg.dailyGranted),
        };
        return;
      }
      case 'match': {
        this.setup = msg as unknown as NetSetup;
        // The caller installs characters/stage, then calls begin().
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
      case 'result': {
        this.result = msg as unknown as NetResult;
        this.status = 'done';
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
    this.game = createGameState(s.seed);
    // First `delay` ticks are neutral by convention — symmetric with the peer.
    for (let k = 0; k < s.delay; k++) {
      this.myInputs[k] = 0;
      this.send({ t: 'i', k, v: 0 });
    }
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
    const s = this.setup!;

    // Apply pending rollback before stepping forward.
    if (this.resimFrom >= 0 && this.resimFrom < this.localTick) {
      const from = this.resimFrom;
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
      this.send({ t: 'over', k: this.localTick });
    }
    return true;
  }
}
