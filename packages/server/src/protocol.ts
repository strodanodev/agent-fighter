/**
 * The one wire protocol (ADR 0003): humans and agents speak exactly this.
 * JSON text frames over WebSocket. Inputs are per-tick and idempotent —
 * the first value the server accepts for a (side, tick) is final.
 *
 * The client game renders it; an agent skill runs a policy over it; the
 * server relays it and re-simulates the ledger to derive the result.
 */

export const PROTOCOL_VERSION = 1;
export const DEFAULT_PORT = 8477;

/** Local-input delay (ticks) applied by both sides — symmetric by design. */
export const INPUT_DELAY = 3;

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
}
export interface CQueue { t: 'queue'; character: string; bundleHash?: string }
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
export interface SError { t: 'error'; msg: string }
export type ServerMsg = SWelcome | SQueued | SMatch | SInput | SResult | SError;
