/**
 * Gauntlet mode: ONE placed match, run by a litnode node.
 *
 * When the LIT GAMES mesh places an Agent Fighter match, the host node
 * (github.com/strodanodev/litnode node/gauntlet.js) spawns this server for
 * that match alone, on a loopback port behind its gateway, and ends it once
 * the match settles. Nothing here needs a secret the publisher holds:
 *
 *   - no database: persistence is off, so no credits, items, escrow or XP
 *     (progression comes from the chain's settled results, not from here);
 *   - no AIR: a player is the litnode key the mesh placed, proven by the
 *     seat ticket the node minted for that key (HMAC over the claims with a
 *     per-match secret the node hands only to this process);
 *   - no choice of seed: the seed is the placement's, H(beacon, matchId),
 *     the one every witness replays with.
 *
 * At the end the server posts the input log, both players' ledger
 * signatures and the pin to the node's /ledger, which replays it and settles
 * it. Then the process exits. Environment (set by the node):
 *
 *   GAUNTLET_PORT GAUNTLET_SECRET GAUNTLET_SEATS GAUNTLET_MATCH_ID
 *   GAUNTLET_ROOM GAUNTLET_SEED GAUNTLET_BUILD GAUNTLET_NODE_URL
 *   GAUNTLET_PLACED_MODE GAUNTLET_RULESET
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface GauntletSeat { sub: string; team: number; slot: number }

export interface GauntletOutcome {
  /** The node accepted the result (HTTP 200). */
  posted: boolean;
  status?: number;
  error?: string;
  /** How many of the two players signed the ledger. */
  signatures: number;
}

export interface GauntletConfig {
  matchId: string;
  room: string;
  /** The placement's seed, H(beacon, matchId), 64 hex. */
  seed: string;
  /** What the engine is seeded with: the seed's first 32 bits, as the litnode ruleset reads it. */
  seedInt: number;
  buildHash: string | null;
  secret: string;
  seats: GauntletSeat[];
  /** The node's loopback URL; the result goes to <nodeUrl>/ledger. */
  nodeUrl: string;
  placedMode: 'ranked' | 'casual';
  rulesetId: string;
  /** How long to wait for both ledger signatures after the result (default 20 s). */
  signWaitMs?: number;
  /** Called once, after the result was handed to the node (or could not be). */
  onDone?: (outcome: GauntletOutcome) => void;
}

export interface TicketClaims { sub: string; matchId: string; team: number; slot: number; mode: string; exp: number }

/**
 * The node's join ticket (litnode node/gauntlet.js mintTicket):
 * base64url(claims JSON) '.' base64url(HMAC-SHA256(payload, secret)), the
 * secret used as a string key. Null unless the MAC verifies and the claims parse.
 */
export function verifyTicket(ticket: unknown, secret: string): TicketClaims | null {
  if (typeof ticket !== 'string' || !secret) return null;
  const dot = ticket.indexOf('.');
  if (dot <= 0) return null;
  const payload = ticket.slice(0, dot);
  const want = Buffer.from(createHmac('sha256', secret).update(payload).digest('base64url'));
  const got = Buffer.from(ticket.slice(dot + 1));
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  try {
    const c = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as TicketClaims;
    return typeof c?.sub === 'string' && typeof c.matchId === 'string' && typeof c.exp === 'number' ? c : null;
  } catch { return null; }
}

/** The engine seed from the placement's seed: its first 32 bits, kept positive (the stage pick is seed % n). */
export const seedIntOf = (seedHex: string): number => parseInt(seedHex.slice(0, 8), 16) & 0x7fffffff;

const HEX64 = /^[0-9a-f]{64}$/;

/** Read the node's GAUNTLET_* environment. Throws on anything missing or malformed: a process the node
 *  started wrong must not open a port. */
export function gauntletFromEnv(env: NodeJS.ProcessEnv = process.env): GauntletConfig {
  const need = (k: string): string => { const v = env[k]; if (!v) throw new Error(`gauntlet: ${k} is not set (this server is started by a litnode node)`); return v; };
  const matchId = need('GAUNTLET_MATCH_ID').toLowerCase();
  const seed = need('GAUNTLET_SEED').toLowerCase();
  if (!HEX64.test(matchId)) throw new Error('gauntlet: GAUNTLET_MATCH_ID must be 64 hex');
  if (!HEX64.test(seed)) throw new Error('gauntlet: GAUNTLET_SEED must be 64 hex');
  const seats = JSON.parse(need('GAUNTLET_SEATS')) as GauntletSeat[];
  if (!Array.isArray(seats) || seats.length !== 2 || !seats.every((s) => HEX64.test(String(s?.sub)))) throw new Error('gauntlet: Agent Fighter seats exactly two placed player keys');
  if (new Set(seats.map((s) => s.team)).size !== 2) throw new Error('gauntlet: the two seats must be on different teams');
  const build = (env.GAUNTLET_BUILD ?? '').toLowerCase();
  return {
    matchId,
    room: need('GAUNTLET_ROOM'),
    seed,
    seedInt: seedIntOf(seed),
    buildHash: HEX64.test(build) ? build : null,
    secret: need('GAUNTLET_SECRET'),
    seats,
    nodeUrl: need('GAUNTLET_NODE_URL').replace(/\/+$/, ''),
    placedMode: env.GAUNTLET_PLACED_MODE === 'ranked' ? 'ranked' : 'casual',
    rulesetId: env.GAUNTLET_RULESET || 'agent-fighter.v1',
  };
}
