/**
 * The litnode ledger commitment, ported so the relay can tell both players
 * what to sign at match end (protocol 3, github.com/strodanodev/litnode
 * protocol/log.js). Kept dependency-free and byte-for-byte compatible:
 *
 *   entries  = [{k, inputs:[side0[k]|0, side1[k]|0]} for k < min(len0, len1)]
 *   head     = fold over entries of sha256(`tick` NUL prev NUL canonical(entry))
 *   body     = { matchId, ticks, head, buildHash }   (what the player signs)
 *
 * canonical() is JSON with recursively sorted object keys. The node rebuilds
 * the same entries from the archived ledger (tools/lib/af-submission.mjs),
 * so a head computed here over `m.inputs` is the head the node verifies.
 */
import { createHash } from 'node:crypto';

const canonical = (value: unknown): string =>
  JSON.stringify(value, (_k, v: unknown) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const out: Record<string, unknown> = {};
      const rec = v as Record<string, unknown>;
      for (const k of Object.keys(rec).sort()) if (rec[k] !== undefined && typeof rec[k] !== 'function') out[k] = rec[k];
      return out;
    }
    return v;
  });

const h = (tag: string, ...parts: unknown[]): string =>
  createHash('sha256').update(`${tag}\0${parts.map((p) => (typeof p === 'string' ? p : canonical(p))).join('\0')}`).digest('hex');

export interface MeshLedger { head: string; ticks: number }

/** The chain head over both input tracks, exactly as the node computes it. */
export function meshLedger(inputs: [readonly number[], readonly number[]]): MeshLedger {
  const n = Math.min(inputs[0].length, inputs[1].length);
  let head = 'genesis';
  for (let k = 0; k < n; k++) head = h('tick', head, { k, inputs: [inputs[0][k]! | 0, inputs[1][k]! | 0] });
  return { head, ticks: n };
}
