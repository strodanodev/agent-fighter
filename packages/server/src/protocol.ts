/**
 * The one wire protocol (ADR 0003): humans and agents speak exactly this.
 * JSON text frames over WebSocket. Inputs are per-tick and idempotent —
 * the first value the server accepts for a (side, tick) is final.
 *
 * The client game renders it; an agent skill runs a policy over it; the
 * server relays it and re-simulates the ledger to derive the result.
 */

export const PROTOCOL_VERSION = 3; // v3: local-sim ranked solo (zero-latency)
export const DEFAULT_PORT = 8477;

/** Local-input delay (ticks) applied by both sides — symmetric by design. */
export const INPUT_DELAY = 3;

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

/** Client must not simulate further than this past the opponent's inputs. */
export const MAX_AHEAD = 10;

/** How often clients report stateHash (ticks) — desync forensics. */
export const HASH_EVERY = 60;

/** Reconnect grace before a mid-match disconnect becomes a forfeit (ms). */
export const FORFEIT_GRACE_MS = 10_000;

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
}
/**
 * Queue modes (M5 credits):
 *  · 'wager' — PvP. Entrance WAGER_FEE credits each; winner takes the pot.
 *  · 'solo'  — ranked vs the HOUSE agent at your level. SOLO_FEE credits;
 *    win nets +1 credit, a loss burns the fee AND −15 XP.
 * Both require a verified account with enough credits (server-enforced).
 */
export interface CQueue {
  t: 'queue';
  character: string;
  bundleHash?: string;
  mode?: 'wager' | 'solo'; // default 'wager'
}
export interface CInput { t: 'i'; k: number; v: number }
export interface CHash { t: 'h'; k: number; x: number }
export interface COver { t: 'over'; k: number }
export type ClientMsg = CHello | CQueue | CInput | CHash | COver;

// ---- server → client
export interface SWelcome { t: 'welcome'; id: string; engine: string }
export interface SQueued { t: 'queued' }
export interface SMatch {
  t: 'match';
  matchId: string;
  side: 0 | 1;
  seed: number;
  stage: string;
  delay: number; // INPUT_DELAY — both sides use it
  chars: [{ id: string; hash?: string }, { id: string; hash?: string }];
  names: [string, string];
  agents: [boolean, boolean];
  mode: 'wager' | 'solo';
  /** Credits escrowed per side (pot = fee×2 in wager mode). */
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
  solo?: { skill: number; aiSeed: number };
}
export interface SInput { t: 'i'; k: number; v: number }
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
}
/**
 * Post-match progression for YOUR account, sent after the result once the
 * server has persisted the verified outcome (authenticated players only).
 * Arrives asynchronously — persistence must never delay the result itself.
 * `gained` can be negative (ranked solo loss burns XP); `creditsDelta` is
 * net of the entrance fee (wager win = +fee, loss = −fee).
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
}
export type ServerMsg = SWelcome | SQueued | SMatch | SInput | SResult | SError | SAccount | SXp;
