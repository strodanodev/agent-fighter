/**
 * Settlement proof for mesh matches (litnode docs/SETTLEMENT-STANDARD.md, protocol 4).
 *
 * Every result the mesh settles carries a PROOF LEVEL the node derived from what it could check, committed in
 * the result hash and never upgraded afterwards:
 *
 *   L3 verified   — independent nodes replayed the input log both players signed (the only official ladder)
 *   L2 checkable  — a log an authorized key vouched for, held by the mesh, re-runnable by anyone
 *   L1 attested   — an authorized court signed the report
 *   L0 host       — one node's word
 *
 * This module reads it from the node the arcade talks to (`GET /delta/<matchId>?chain=1`, and
 * `/deltas?player=<key>` for a player's recent record; litnode 0.12.0) and builds the links a player follows to
 * check it: the arcade's own receipt page for the match (which lists its MatchBook transactions on the
 * explorer), or — for a result that never reaches MatchBook — EpochAnchor, the contract its hourly root lands
 * in, on the explorer. The arcade origin, the explorer and every address come only from the contract set the
 * arcade served (mesh.ts contractSet); nothing here is hard-coded and nothing falls back. Display only: the
 * game never decides anything from these answers.
 */
import { contractSet } from './mesh.js';

export type ProofLevel = 'verified' | 'checkable' | 'attested' | 'host';

export interface MatchProof {
  matchId: string;
  /** null = the node holds no settled result for this match (yet). */
  proof: ProofLevel | null;
  mode: 'ranked' | 'casual' | null;
  /** The match's on-chain status when the node reads MatchBook: none | committed | settled | final | void | … */
  chain: string | null;
  official: boolean;
  participants: string[];
  scores: Record<string, number>;
  /** Epoch hour the result was settled in (its EpochAnchor root). */
  epoch: number | null;
}

const LEVELS: readonly ProofLevel[] = ['verified', 'checkable', 'attested', 'host'];
const RULESET = 'agent-fighter.v1';
const HEX64 = /^[0-9a-f]{64}$/;

const toProof = (d: Record<string, unknown> | null, matchId: string): MatchProof => ({
  matchId,
  proof: LEVELS.includes(d?.proof as ProofLevel) ? (d!.proof as ProofLevel) : null,
  mode: d?.mode === 'ranked' || d?.mode === 'casual' ? d.mode : null,
  chain: typeof d?.chain === 'string' ? d.chain : null,
  official: d?.official === true,
  participants: Array.isArray(d?.participants) ? (d!.participants as unknown[]).filter((p): p is string => typeof p === 'string') : [],
  scores: d?.scores && typeof d.scores === 'object' ? d.scores as Record<string, number> : {},
  epoch: typeof d?.epoch === 'number' ? d.epoch : null,
});

const base = (nodeUrl: string): string => nodeUrl.replace(/\/+$/, '');

/** A match the node does not hold a result for yet. */
export const pendingProof = (matchId: string): MatchProof => toProof(null, matchId);

/**
 * The settled result of one match on this node, or a pending one (`proof: null`) when the node does not hold it
 * yet. Null only when the node cannot be asked at all. `?chain=1` asks the node to add the match's MatchBook
 * status and the official flag; it is opt-in because witnesses fetch the bare delta from the same route.
 */
export async function fetchMatchProof(nodeUrl: string, matchId: string): Promise<MatchProof | null> {
  if (!nodeUrl || !HEX64.test(matchId)) return null;
  try {
    const r = await fetch(`${base(nodeUrl)}/delta/${matchId}?chain=1`, { signal: AbortSignal.timeout(8000), cache: 'no-store' });
    if (r.status === 404) return toProof(null, matchId);
    if (!r.ok) return null;
    return toProof((await r.json()) as Record<string, unknown>, matchId);
  } catch { return null; }
}

/**
 * This player's most recent settled Agent Fighter results on this node, newest first — the in-game history.
 * `/deltas` carries the MatchBook status and the official flag beside each result, and `player=` has the node
 * return only this key's results. The participant filter stays as a guard: a node before 0.12.0 ignores
 * `player=` and answers with every result.
 */
export async function fetchMeshHistory(nodeUrl: string, player: string, limit = 4): Promise<MatchProof[]> {
  if (!nodeUrl || !HEX64.test(player)) return [];
  try {
    const r = await fetch(`${base(nodeUrl)}/deltas?ruleset=${RULESET}&player=${player}`, { signal: AbortSignal.timeout(10_000), cache: 'no-store' });
    if (!r.ok) return [];
    const j = (await r.json()) as { deltas?: Record<string, unknown>[] };
    return (j.deltas ?? [])
      .filter((d) => Array.isArray(d.participants) && (d.participants as unknown[]).includes(player) && typeof d.matchId === 'string')
      .sort((a, b) => Number(b.epoch ?? 0) - Number(a.epoch ?? 0) || String(b.matchId).localeCompare(String(a.matchId)))
      .slice(0, limit)
      .map((d) => toProof(d, d.matchId as string));
  } catch { return []; }
}

/** The level in words, as the arcade badges it. */
export const proofLabel = (p: ProofLevel | null): string => (
  p === 'verified' ? 'L3 VERIFIED' : p === 'checkable' ? 'L2 CHECKABLE' : p === 'attested' ? 'L1 ATTESTED' : p === 'host' ? 'L0 HOST' : 'SETTLING…');

/**
 * Where a player checks this result, one source per kind and no fallbacks:
 *  - on MatchBook: the receipt page of the arcade the contract set came from (the match's commit / settle /
 *    attest / finalize transactions on the explorer, each re-checked against the chain);
 *  - off MatchBook: EpochAnchor, where the node's hourly root over its results lands, at the explorer the
 *    contract set names (`explorer` in contracts.json / cabinet:init.chain).
 * Null when the set does not name what that kind needs (no set read, no arcade origin, no explorer, no
 * EpochAnchor address): then there is nothing honest to link to.
 */
export function proofLink(p: MatchProof): { label: string; url: string } | null {
  const set = contractSet();
  if (!set) return null;
  if (p.chain != null && p.chain !== 'none') {
    return set.arcade ? { label: 'MATCHBOOK RECEIPT', url: `${set.arcade}/#/match/${p.matchId}` } : null;
  }
  const ea = set.addresses.EpochAnchor;
  return ea && set.explorer ? { label: 'EPOCHANCHOR', url: `${set.explorer}/address/${ea}` } : null;
}
