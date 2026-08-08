/**
 * The one wire protocol (ADR 0003): humans and agents speak exactly this.
 * JSON text frames over WebSocket. Inputs are per-tick and idempotent —
 * the first value the server accepts for a (side, tick) is final.
 *
 * The client game renders it; an agent skill runs a policy over it; the
 * server relays it and re-simulates the ledger to derive the result.
 */

// v9: PETS (ADR 0011). SMatch.pets is structurally additive, but it is part
// of the DETERMINISTIC contract: a client that ignored it would install no
// aura, simulate a different match than the verifier, and be convicted as the
// deviator for its own opponent's pet. A silent desync is worse than a forced
// update — old clients get a clean "protocol 9 required" and must reload.
// (v8: TICKETS, ADR 0009 — a decided wager burns both fees instead of paying
// a pot, so a v7 client would have lied to the player about the money.)
export const PROTOCOL_VERSION = 9;
export const DEFAULT_PORT = 8477;

/**
 * Local-input delay (ticks) applied by both sides — symmetric by design.
 * FALLBACK value: PvP matches use an ADAPTIVE delay derived from both
 * clients' measured RTT to the relay (see adaptive bounds below); this
 * constant is used only when either side's RTT is unknown (old client,
 * instant pair, agents that don't answer pings).
 */
export const INPUT_DELAY = 3;

/** One sim tick in milliseconds (60 ticks/sec) — RTT→ticks conversion. */
export const TICK_MS = 1000 / 60;

/**
 * Adaptive-delay bounds. The relay computes
 *   delay = round(oneWayMs / TICK_MS / 2), clamped to [MIN, MAX]
 * where oneWayMs = (rttA + rttB) / 2 (A→server + server→B). Half the
 * one-way latency is absorbed by input delay, the other half by rollback —
 * the classic split that keeps local inputs snappy without deep visual
 * corrections. MAX stays modest on purpose: past 6 ticks of delay the game
 * feels muddy, and rollback (MAX_AHEAD below) covers the remainder.
 */
export const INPUT_DELAY_MIN = 2;
export const INPUT_DELAY_MAX = 6;

/**
 * Lobby/queue RTT probe cadence (server→client `ping`; client echoes
 * `pong`). Additive to protocol 6 — clients that don't answer simply get
 * the INPUT_DELAY fallback. Agents are never pinged (headless players
 * don't care about 30 ms, and third-party skills may not echo).
 */
export const PING_INTERVAL_MS = 2_000;

/**
 * Ranked-solo pace sanity (server-side): the client sims locally, so wall
 * time is the ONLY honesty signal about pacing. A finished match whose wall
 * time is under MIN×sim (scripted fast-forward) or over MAX×sim + slack
 * (tool-assisted slow-motion) settles as 'incomplete' → fees refund, no
 * XP/credits move. Generous bounds: pauses/alt-tabs stay legal.
 */
export const SOLO_PACE_MIN = 0.7;
export const SOLO_PACE_MAX = 3;
export const SOLO_PACE_SLACK_MS = 20_000;

/**
 * Client must not simulate further than this past the opponent's inputs.
 * 15 ticks (~250 ms) of prediction headroom: past it the client stalls.
 * Raised from 10 (2026-07-18) — on high-latency paths the old value put
 * the sim permanently at the stall threshold (constant stutter); deeper
 * prediction trades those halts for rollback corrections, which read far
 * better in play. Bounded well inside the client's 128-slot snapshot ring
 * and the 100-tick hash-checkpoint window.
 */
export const MAX_AHEAD = 15;

/** How often clients report stateHash (ticks) — desync forensics. */
export const HASH_EVERY = 60;

/**
 * Reconnect grace before a mid-match disconnect settles (ms). This window is
 * REAL: the dropped client can rejoin with its resume token (CResume) and
 * continue the match. 20s = notice the drop + a few reconnect attempts.
 * Must stay below IDLE_FORFEIT_MS or the idle sweep fires first.
 */
export const FORFEIT_GRACE_MS = 20_000;

/**
 * A connected-but-silent client forfeits after this long without sending an
 * input (ADR 0003 disconnect policy). Closing the socket is only the HONEST
 * way to quit — without this, a wager griefer could hold the socket open,
 * stop playing, and freeze the opponent's escrowed credits forever. Generous
 * enough to survive a tab-switch stutter or a long stall, short enough that
 * nobody's pot is held hostage.
 */
export const IDLE_FORFEIT_MS = 30_000;

/**
 * AGENT ARCADE: how long a run may sit between fights before its token
 * expires. 2min → 5min (ADR 0007: pre-paid non-refundable entries + PWA
 * resume) → 30min (ADR 0008).
 *
 * The v2 raise is a design consequence, not a tuning whim. Between fights the
 * player now sits on the MAP — a 32×32 board they are meant to STUDY, with an
 * unbanked bag riding on the decision. Five minutes was generous for tapping
 * "next challenger"; it is hostile to someone weighing whether a 12-credit
 * pile is worth another fight, and expiry would cost them a paid run AND the
 * bag. Nothing is held hostage by a long window either — unlike a wager pot,
 * an arcade run has no opponent waiting and no escrow to strand; the only
 * cost is one small run object in server memory.
 */
export const ARCADE_NEXT_GRACE_MS = 1_800_000;

// ---- client → server
export interface CHello {
  t: 'hello';
  v: number; // PROTOCOL_VERSION
  name: string;
  agent?: boolean;
  engine: string; // ENGINE_VERSION — pinned
  /**
   * AIR-account email — the TARGET for the reputation-credential write-back
   * (ADR 0004), nothing else. Progression keys on the verified token's sub;
   * this only addresses where AIR delivers the attestation.
   */
  email?: string;
  /**
   * AIR Kit session JWT (optional). The server verifies it against the AIR
   * JWKS and, if valid, ties this connection to the account (`sub`) for
   * persistent XP/W-L. Anonymous play stays allowed — identity only gates
   * PROGRESSION, never the queue. Agents pass their owner's token here.
   */
  auth?: string;
  /**
   * Durable agent key (ADR 0006, `afk_…` — minted at POST /agent/key).
   * Alternative to `auth` for headless agents: resolves to the OWNER's
   * profile and forces `agent: true` (a key can never pose as human hands).
   * Ignored when `auth` verifies.
   */
  agentKey?: string;
  /**
   * Referral dare code (?ref= from a shared /dare/<code> link), stashed by
   * the client until the first authenticated hello. Best-effort: an invalid
   * or already-used code grants nothing and never blocks login.
   */
  ref?: string;
}
/**
 * Queue modes (M5 credits):
 *  · 'wager'  — PvP. Entrance WAGER_FEE credits each; BOTH BURN and the
 *    winner mints a non-transferable TICKET (ADR 0009). There is no pot.
 *  · 'solo'   — a single match vs the HOUSE agent at your level. SOLO_FEE
 *    credits; win nets +1 credit, a loss burns the fee AND −15 XP.
 *  · 'arcade' — AGENT ARCADE, the RANKED gauntlet map (v7, ADR 0008):
 *    ARCADE_FEE credits buys ONE RUN across a generated 32×32 board. Each
 *    battle is a solo-style local-sim match, server-verified, settling
 *    XP/W-L on the same ranked ladder. Winning arms the run token for the
 *    next MOVE (re-queue with `runToken` + `arcadeNode`); any loss ends the
 *    run AND forfeits everything picked up but not yet extracted.
 *    **Wins pay no credits.** Credits come only from board pickups, banked
 *    by reaching an exit alive (POST /arcade/extract) — the whole point of
 *    the mode is that fighting is the cost and the board is the earning.
 *  · 'friendly' — private challenge (v5): the two sockets presenting the
 *    same `room` code are paired with each other instead of the public
 *    FIFO. FREE and UNRANKED by design (no fee, no pot, no XP, no W-L —
 *    the anti-collusion stance for invited games): the server still
 *    re-simulates the ledger and names a VERIFIED winner, but settlement
 *    skips persistence entirely. Bragging rights only.
 * All modes require a verified account (server-enforced); all but
 * 'friendly' also require enough credits.
 */
export interface CQueue {
  t: 'queue';
  character: string;
  bundleHash?: string;
  mode?: 'wager' | 'solo' | 'arcade' | 'friendly'; // default 'wager'
  /**
   * AGENT ARCADE continuation: the run token from the previous battle's
   * setup. Omitted = start a NEW run (charges the entry fee). The token is a
   * bearer secret tied to the account that started the run.
   */
  runToken?: string;
  /**
   * AGENT ARCADE v2 (ADR 0008): the board node the player chose to move to.
   * It must be a FIGHT node adjacent to where the run currently stands —
   * the server validates the edge against its own copy of the board, so
   * this is a request, never an assertion. THE MOVE IS THE QUEUE: choosing
   * a route and starting the match are one action, which is why there is no
   * separate /arcade/move endpoint.
   *
   * Omitted = AUTOPILOT: the server walks the cheapest line toward the deep
   * exit itself. Headless agents (npm run agent / npm run fleet) rely on
   * this — they are agent-class and economically inert, so which loot they
   * skip is nobody's money.
   */
  arcadeNode?: number;
  /**
   * Friendly rendezvous code (required when mode === 'friendly'): both
   * players present the SAME string and meet. By convention it's the
   * inviter's ref_code (globally unique by construction — no collisions),
   * carried to the friend by the challenge link's ?room= param.
   */
  room?: string;
  /**
   * DARE-VS-AGENT / SPARRING (ADR 0006, solo mode only): the ref code of the
   * profile whose TRAINED agent to fight instead of the house AI. The server
   * resolves it to that profile's agent_config and pins {skill from the
   * OWNER's level (same house ramp — never coachable), aiSeed, personality,
   * character} into `solo`. Your own code = VS MY AGENT sparring. Economy is
   * exactly ranked solo (fee/payout vs the house; the agent's owner earns
   * nothing — no new exploit surface). Additive field: servers ignore it in
   * other modes, and `solo.personality` is only ever sent to the client that
   * asked for it, so no protocol bump is needed.
   */
  agentOf?: string;
  /**
   * DEPRECATED (af-core-5): drinks are now EQUIPPED in the vending-machine
   * screen and the server reads the profile's loadout itself at queue time
   * — this field is ignored. Kept in the type so old payloads still parse.
   */
  item?: number;
}
export interface CInput { t: 'i'; k: number; v: number }
export interface CHash { t: 'h'; k: number; x: number }
export interface COver { t: 'over'; k: number }
/**
 * RTT probes (additive, 2026-07-18 — no protocol bump: both sides ignore
 * unknown message types, so old peers degrade to the INPUT_DELAY fallback).
 * Symmetric: either side may send `ping` with its own clock in `ts`; the
 * receiver echoes `ts` back verbatim in `pong`. The CLIENT pings to drive
 * its connection-quality overlay; the SERVER pings queued humans to size
 * the adaptive input delay at pair time.
 */
export interface CPing { t: 'ping'; ts: number }
export interface CPong { t: 'pong'; ts: number }
/**
 * Rejoin a live match after a dropped socket (sent instead of `queue`, within
 * FORFEIT_GRACE_MS). The token is a per-side bearer secret from the match
 * setup — only its owner ever received it, so possession IS authorization.
 */
export interface CResume { t: 'resume'; matchId: string; token: string }
export type ClientMsg = CHello | CQueue | CInput | CHash | COver | CResume | CPing | CPong;

// ---- server → client
export interface SWelcome { t: 'welcome'; id: string; engine: string }
export interface SQueued { t: 'queued' }
export interface SMatch {
  t: 'match';
  matchId: string;
  side: 0 | 1;
  seed: number;
  stage: string;
  /**
   * The stage's playfield bounds in world px (the region camera + walls lock
   * to). Server-authoritative and part of the deterministic contract: BOTH
   * simulating ends must pass this to `createGameState(seed, bounds)` so the
   * fighter walls agree. Absent = full-width stage (the engine default).
   */
  bounds?: { left: number; right: number };
  delay: number; // INPUT_DELAY — both sides use it
  chars: [{ id: string; hash?: string }, { id: string; hash?: string }];
  names: [string, string];
  agents: [boolean, boolean];
  mode: 'wager' | 'solo' | 'arcade' | 'friendly';
  /** Credits escrowed per side (pot = fee×2 in wager mode). Arcade: the run
   * entry fee on battle 1, then 0 — one credit buys the whole run.
   * Friendly: always 0. */
  fee: number;
  /**
   * v3 LOCAL-SIM SOLO: present iff mode === 'solo'. There is NO house-bot
   * connection and NO input relay — the client simulates the opponent
   * ITSELF with the deterministic built-in AI pinned here, at ZERO added
   * latency (identical feel to offline play), and streams only its own
   * per-tick inputs. The server re-derives the SAME AI from (skill, aiSeed)
   * during verification, so the opponent cannot be puppeteered: any client
   * that simulates a different opponent fails the ledger re-sim.
   */
  solo?: {
    skill: number;
    aiSeed: number;
    /**
     * Present when the opponent is a coached style (dare-vs-agent, or a live
     * roster/fleet agent with a saved personality). The client and verifier
     * must construct the opponent with createAi(1, skill, aiSeed, personality)
     * — knobs are clamped server-side to AI_PERSONALITY_RANGES before they
     * ride this message. Omitted for the plain generic house AI.
     */
    personality?: Record<string, number>;
  };
  /**
   * AGENT ARCADE v2 (v7, ADR 0008): present iff mode === 'arcade'. Battles
   * are otherwise exactly local-sim solo matches (`solo` above is set too).
   *
   * The BOARD itself does not ride this message — the client fetches it once
   * per run from POST /arcade/run (it is far too big to repeat every battle,
   * and it never changes mid-run). What rides here is only where this
   * particular fight sits on it:
   *  · `node`   — the board node being fought (the one the player moved to)
   *  · `fights` — fights already WON this run, so the HUD can say where you are
   *  · `total`  — fights on the cheapest line to the deep exit (the 7 in "7 min")
   *  · `token`  — re-arms the run for the next move (CQueue.runToken)
   */
  arcade?: { token: string; node: number; fights: number; total: number };
  /**
   * CONSUMABLES (ADR 0007 final shape): the pinned per-side drink LOADOUTS
   * (each side's EQUIPPED cans, slot order, ≤ 3). BOTH simulating ends
   * (client + verifier + any rollback peer) must install this via core
   * `setMatchItems` BEFORE createGameState — the pin is part of the
   * deterministic contract exactly like characters and `solo.personality`.
   * Values are re-clamped in core. Absent = item-less match. The server
   * reads each profile's equipped loadout itself at queue time (the client
   * no longer nominates rows), and settlement consumes ONLY the cans the
   * verified re-sim shows were drunk.
   */
  items?: [ItemPin[], ItemPin[]];
  /**
   * PETS (ADR 0011): the pinned per-side companion, or null for a side with
   * none equipped. Same deterministic contract as `items` — BOTH simulating
   * ends install it via core `setMatchPets` BEFORE createGameState, and core
   * re-clamps every line. Absent = pet-less match.
   *
   * The server reads each profile's equipped pet itself at queue time; the
   * client never nominates one. Unlike a drink an aura is never consumed, so
   * there is no settlement counterpart — it is pure setup.
   *
   * The `id` is what the RENDERER needs (which sprite floats behind that
   * fighter); the aura is what the SIM needs. Both sides see both, which is
   * what makes open carry disclosed rather than hidden.
   */
  pets?: [PetPin | null, PetPin | null];
  /** This side's resume token (bearer secret — never shown to the opponent). */
  resume?: string;
}

/** One pinned drink as it rides SMatch (display fields + the sim effect). */
export interface ItemPin {
  id: string;
  name: string;
  tier: number;
  effect: { kind: string; amount: number; durationTicks: number };
}
/**
 * One pinned pet as it rides SMatch (ADR 0011): display fields + the rolled
 * aura the sim installs. Per-mille integers, re-clamped by core.
 */
export interface PetPin {
  id: string;
  name: string;
  rarity: number;
  aura: {
    atk: number; def: number; hpRegen: number; crit: number; energyRegen: number;
  };
}
export interface SInput { t: 'i'; k: number; v: number }
/**
 * Successful resume: the full pinned setup again PLUS the input ledger so
 * far (null = tick not yet received), so the client can rebuild its sim by
 * replaying and then continue live. New opponent inputs follow as SInput.
 */
export interface SResumed extends Omit<SMatch, 't'> {
  t: 'resumed';
  inputs: [(number | null)[], (number | null)[]];
}
export interface SResult {
  t: 'result';
  winner: number; // -1 undecided, 0/1 side, 2 draw
  reason: 'verified' | 'forfeit' | 'incomplete';
  rounds: [number, number];
  endTick: number;
  hash: number; // server re-sim final stateHash (0 for forfeit)
  deviator?: 0 | 1; // side whose reported hashes diverged from the re-sim
}
export interface SError { t: 'error'; msg: string; code?: 'credits' | 'auth' }
/**
 * PvP heads-up (v6): the OPPONENT's socket just dropped. Sent to the SURVIVOR
 * the instant it happens so the client can show "OPPONENT DISCONNECTED —
 * reconnecting… Ns" instead of silently freezing (its rollback sim stalls
 * once it runs out of the vanished peer's inputs). `graceMs` is the window
 * the server will hold before forfeiting the missing side (FORFEIT_GRACE_MS)
 * — the countdown the client renders. Solo/arcade never send this (no peer
 * socket). Purely informational: the authoritative verdict is still the
 * later `result`.
 */
export interface SOppGone { t: 'oppgone'; graceMs: number }
/** The dropped opponent rejoined within grace (v6) — clear the notice. */
export interface SOppBack { t: 'oppback' }
/**
 * Your account snapshot — sent once the hello token verifies (and again on
 * demand). `dailyGranted` = THIS connection claimed today's login bonus.
 */
export interface SAccount {
  t: 'account';
  credits: number;
  level: number;
  xp: number;
  wins: number;
  losses: number;
  dailyGranted: boolean;
  /** This player's shareable dare code (landing /dare/<code>). */
  refCode: string;
  /** Credits granted by THIS call redeeming a referral (0 = none). */
  referralGranted: number;
  /** Friends who ever redeemed this player's dare code (inviter side). */
  daresAccepted: number;
  /** Inviter payouts credited in the rolling week (capped at 10). */
  daresPaidWeek: number;
  /**
   * Friends who redeemed this code but whose inviter payout has NOT been
   * released yet — they have not finished a first decided match. The invite
   * screen shows this so "accepted" never silently outruns "paid".
   */
  daresPending: number;
  /**
   * Unredeemed wager TICKETS (ADR 0009). Non-transferable prize tokens minted
   * by winning a decided wager; always 0 for agent-class accounts.
   */
  tickets: number;
}
/**
 * Post-match progression for YOUR account, sent after the result once the
 * server has persisted the verified outcome (authenticated players only).
 * Arrives asynchronously — persistence must never delay the result itself.
 * `gained` can be negative (ranked solo loss burns XP); `creditsDelta` is
 * net of the entrance fee. NOTE since ADR 0009 a DECIDED wager burns both
 * fees, so `creditsDelta` is −fee for BOTH sides — the winner's reward is
 * `ticket`, not credits.
 */
export interface SXp {
  t: 'xp';
  gained: number;
  levelsUp: number;
  level: number;
  xp: number;
  wins: number;
  losses: number;
  creditsDelta: number;
  credits: number;
  /**
   * Free vending-machine pulls earned by levelling up THIS match (one per
   * level gained). Server-rolled and already persisted to inventory — the
   * client only reveals them. Absent/empty when no level-up (or agent-class,
   * which never earns pulls). Each entry is the granted item's id + tier.
   */
  freePulls?: { itemId: string; tier: number }[];
  /**
   * TICKETS (ADR 0009): this settlement minted a wager ticket for you. Only
   * ever true for a decided wager WIN by a non-agent account. `tickets` is
   * the resulting unredeemed balance.
   */
  ticket?: boolean;
  tickets?: number;
}
/** Server-side RTT probe / echo — same shape and rules as CPing/CPong. */
export interface SPing { t: 'ping'; ts: number }
export interface SPong { t: 'pong'; ts: number }
export type ServerMsg = SWelcome | SQueued | SMatch | SResumed | SInput | SResult | SError | SAccount | SXp | SOppGone | SOppBack | SPing | SPong;
