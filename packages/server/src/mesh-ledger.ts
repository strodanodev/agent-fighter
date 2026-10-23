/**
 * The litnode ledger commitment, ported so a gauntlet can tell both players
 * what to sign at match end (github.com/strodanodev/litnode protocol/log.js).
 * Kept dependency-free and byte-for-byte compatible:
 *
 *   entries  = [{k, inputs:[side0[k]|0, side1[k]|0]} for k < min(len0, len1)]
 *   head     = fold over entries of sha256(`tick` NUL prev NUL canonical(entry))
 *   body     = { matchId, ticks, head, buildHash }   (what the player signs)
 *
 * canonical() is JSON with recursively sorted object keys. The node rebuilds
 * the same entries from the submission's `entries`, so a head computed here
 * over `m.inputs` is the head the node verifies.
 */
import { createHash, createPublicKey, verify as edVerify } from 'node:crypto';

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

const HEX64 = /^[0-9a-f]{64}$/;
const SIG_HEX = /^[0-9a-f]{128}$/;
/** SPKI DER prefix for a raw 32-byte ed25519 public key (RFC 8410). */
const ED25519_SPKI = Buffer.from('302a300506032b6570032100', 'hex');

/** litnode protocol/keys.js verify(): ed25519 over `tag NUL canonical(body)`, key and signature as hex. Never throws. */
function verifyTagged(tag: string, body: unknown, sigHex: string, keyHex: string): boolean {
  if (!HEX64.test(keyHex) || !SIG_HEX.test(sigHex)) return false;
  try {
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI, Buffer.from(keyHex, 'hex')]), format: 'der', type: 'spki' });
    return edVerify(null, Buffer.from(`${tag}\0${canonical(body)}`, 'utf8'), key, Buffer.from(sigHex, 'hex'));
  } catch {
    return false;
  }
}

/** A placement envelope as litnode's GET /match serves it and the arcade hands it on (cabinet:init match.descriptor). */
export interface DescriptorEnvelope { body: Record<string, unknown>; signer: string; sig: string }

/**
 * Why this envelope is not the placement of the match a gauntlet is serving, or null when it is.
 *
 * litnode 0.11.31 binds a ranked ledger to the placement the CLIENT was served: the submission carries the
 * host's signed envelope as `descriptor`, so the match still settles after the host's own book let the
 * placement go (15 min TTL, a rival, a restart). Players hand it back; this checks it names THIS match —
 * id, ruleset, mode, the two seated keys — and that its placer signed it (`match NUL canonical(body)`, the
 * placer being `computedBy`). Whether that placer was bonded at the pinned block, and the beacon, only the node
 * can check (node/litnode.js verifyDescriptor); it does, on every envelope a ledger carries.
 */
export function descriptorProblem(
  env: unknown,
  want: { matchId: string; rulesetId: string; mode: 'ranked' | 'casual'; participants: readonly string[] },
): string | null {
  const e = env as Partial<DescriptorEnvelope> | null;
  const d = e?.body;
  if (!e || typeof e !== 'object' || !d || typeof d !== 'object' || typeof e.signer !== 'string' || typeof e.sig !== 'string') return 'not an envelope { body, signer, sig }';
  if (d.matchId !== want.matchId) return 'names another match';
  if (d.rulesetId !== want.rulesetId) return `binds ${String(d.rulesetId)}`;
  if ((d.mode ?? 'casual') !== want.mode) return `mode ${String(d.mode ?? 'casual')}, this match is ${want.mode}`;
  const ps = Array.isArray(d.participants) ? (d.participants as unknown[]) : [];
  if (ps.length !== want.participants.length || !want.participants.every((p) => ps.includes(p))) return 'participants differ from the seats';
  if (d.computedBy !== e.signer) return 'not signed by the node that computed it';
  return verifyTagged('match', d, e.sig, e.signer) ? null : 'bad placer signature';
}
