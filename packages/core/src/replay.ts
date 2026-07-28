/**
 * REPLAY LEDGER CODEC (ADR 0010).
 *
 * A match replay in Agent Fighter is not a video and not a state dump — it is
 * the two INPUT TRACKS plus the pinned setup. Everything else is re-derived by
 * stepping the deterministic sim, which is the same thing the server already
 * does to decide who won. That is why a five-minute match compresses to a few
 * kilobytes: we store the buttons, not the pixels.
 *
 * WHY THIS LIVES IN @af/core
 * Anyone who can replay a match already needs the engine, so putting the codec
 * anywhere else would mean importing two packages to do one job. It also means
 * the format is defined next to `InputFrame`, which is what it encodes.
 *
 * PURITY
 * No Date, no Math.random, no globals, no Buffer, no btoa — the determinism
 * guards in `guards.test.ts` forbid them and, more practically, this code has
 * to produce byte-identical output in Node and in a browser. Base64url is
 * therefore hand-rolled rather than delegated to whichever runtime we happen
 * to be on.
 *
 * This module is DATA ONLY: it never touches GameState and the sim never reads
 * it, so adding it does not move `ENGINE_VERSION` and the golden replays are
 * unaffected.
 */

/**
 * Wire format version, independent of ENGINE_VERSION.
 *
 * They answer different questions. `codec` says "can these bytes be parsed";
 * `engine` says "will replaying them reproduce the recorded result". A stored
 * replay carries both, because a ledger from an older engine is still perfectly
 * readable — it just cannot be trusted to reproduce, which is a decision for
 * the caller rather than the parser.
 */
export const REPLAY_CODEC_VERSION = 1;

/**
 * Guard against a hostile or corrupt payload claiming an absurd run length.
 * 108,000 ticks is 30 minutes of simulation — far beyond any real match (the
 * longest observed is ~13.6k ticks, under 4 minutes) and the same order as the
 * server's own ingest cap.
 */
const MAX_TICKS = 108_000;

// ------------------------------------------------------------------- varint

/** Append an unsigned LEB128 varint. Values are non-negative by construction. */
const putVarint = (out: number[], value: number): void => {
  let v = Math.trunc(value);
  if (v < 0) v = 0;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    // Not `>>> 7`: input bitfields are small, but run COUNTS can exceed the
    // 32-bit shift domain's comfort zone, and division keeps this honest for
    // any value JS can represent exactly.
    v = Math.floor(v / 128);
  }
  out.push(v & 0x7f);
};

interface Reader { bytes: Uint8Array; at: number }

const getVarint = (r: Reader): number => {
  let result = 0;
  let scale = 1;
  for (;;) {
    if (r.at >= r.bytes.length) throw new Error('replay: truncated varint');
    const b = r.bytes[r.at++]!;
    result += (b & 0x7f) * scale;
    if ((b & 0x80) === 0) return result;
    scale *= 128;
    if (scale > 2 ** 53) throw new Error('replay: varint overflow');
  }
};

// -------------------------------------------------------------- input track

/**
 * Run-length encode one side's inputs.
 *
 * Fighting-game input is extremely run-heavy: a player holds a direction or
 * nothing at all for many consecutive ticks, and only a handful of frames per
 * second actually change. RLE therefore does most of the compression work
 * before any general-purpose compressor is involved.
 *
 * HOLES BECOME ZERO, deliberately. A ledger array can be sparse if a tick never
 * arrived, and the server's own verifier reads it as `inputs[t]! | 0` — i.e. a
 * missing input IS neutral input. Encoding holes as 0 makes this codec agree
 * with the authority that decided the match, which matters more than being
 * able to round-trip the sparseness.
 */
export const encodeInputTrack = (inputs: readonly number[]): Uint8Array => {
  const out: number[] = [];
  const n = Math.min(inputs.length, MAX_TICKS);
  putVarint(out, n);

  let i = 0;
  while (i < n) {
    const value = inputs[i] === undefined ? 0 : Math.trunc(inputs[i]!) | 0;
    let run = 1;
    while (i + run < n) {
      const next = inputs[i + run] === undefined ? 0 : Math.trunc(inputs[i + run]!) | 0;
      if (next !== value) break;
      run++;
    }
    // Values are non-negative bitfields; a negative would mean corruption
    // upstream, so clamp rather than emit something undecodable.
    putVarint(out, value < 0 ? 0 : value);
    putVarint(out, run);
    i += run;
  }
  return Uint8Array.from(out);
};

/** Inverse of `encodeInputTrack`. Always returns a dense array. */
export const decodeInputTrack = (bytes: Uint8Array): number[] => {
  const r: Reader = { bytes, at: 0 };
  const n = getVarint(r);
  if (n > MAX_TICKS) throw new Error(`replay: track too long (${n})`);

  const out: number[] = [];
  while (out.length < n) {
    const value = getVarint(r);
    const run = getVarint(r);
    if (run <= 0) throw new Error('replay: zero-length run');
    if (out.length + run > n) throw new Error('replay: run overflows track');
    for (let k = 0; k < run; k++) out.push(value);
  }
  return out;
};

// ------------------------------------------------------------------- base64

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/**
 * base64url without padding — URL-safe so a replay can ride a query string or
 * a path segment without escaping.
 */
export const bytesToBase64Url = (bytes: Uint8Array): string => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = i + 1 < bytes.length ? bytes[i + 1]! : -1;
    const b2 = i + 2 < bytes.length ? bytes[i + 2]! : -1;
    s += B64[b0 >> 2]!;
    s += B64[((b0 & 0x03) << 4) | (b1 < 0 ? 0 : b1 >> 4)]!;
    if (b1 < 0) break;
    s += B64[((b1 & 0x0f) << 2) | (b2 < 0 ? 0 : b2 >> 6)]!;
    if (b2 < 0) break;
    s += B64[b2 & 0x3f]!;
  }
  return s;
};

const B64_INV: Record<string, number> = {};
for (let i = 0; i < B64.length; i++) B64_INV[B64[i]!] = i;

export const base64UrlToBytes = (s: string): Uint8Array => {
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    // Tolerate standard-base64 padding/alphabet so a caller that round-trips
    // through a lax transport does not get a parse error for a cosmetic reason.
    if (c === '=' || c === '\n' || c === '\r') continue;
    const v = B64_INV[c === '+' ? '-' : c === '/' ? '_' : c];
    if (v === undefined) throw new Error(`replay: bad base64url char ${JSON.stringify(c)}`);
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
};

// ------------------------------------------------------- canonical JSON

/**
 * Deterministic JSON: object keys sorted, recursively.
 *
 * WHY THIS EXISTS (learned the hard way, 2026-07-28). The match digest was
 * originally computed over `JSON.stringify(pin)` at settlement — which fixes
 * the field order at the moment of writing and nowhere else. The pin is then
 * stored as Postgres `jsonb`, and **jsonb does not preserve key order**. So
 * anyone reading the row back and re-hashing it got a different string, which
 * defeated the digest's entire purpose: being reproducible by whoever holds
 * the row.
 *
 * Hashing a canonical form instead makes the digest a property of the DATA
 * rather than of the code path that happened to serialise it, so a verifier —
 * ours, or a third party auditing an anchored Merkle root years later — lands
 * on the same bytes without needing our insertion order.
 *
 * Deliberately minimal: sorted keys, `undefined` members dropped, no float
 * canonicalisation (every number in a pin is an integer). Not RFC 8785, and
 * does not claim to be.
 */
export const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
};

// ------------------------------------------------------------------ ledger

/** Both sides' input tracks. Index 0 is side 0. */
export type LedgerTracks = readonly [readonly number[], readonly number[]];

/**
 * Encode a whole ledger to one URL-safe string.
 *
 * Layout: varint(codecVersion) varint(trackCount) then, per track,
 * varint(byteLength) followed by that track's bytes. Length-prefixing each
 * track means a future format can add a third track (a spectator or coach
 * stream) without any existing reader mis-parsing the first two.
 */
export const encodeLedger = (tracks: LedgerTracks): string => {
  const parts: Uint8Array[] = [
    encodeInputTrack(tracks[0]),
    encodeInputTrack(tracks[1]),
  ];
  const out: number[] = [];
  putVarint(out, REPLAY_CODEC_VERSION);
  putVarint(out, parts.length);
  for (const p of parts) {
    putVarint(out, p.length);
    for (let i = 0; i < p.length; i++) out.push(p[i]!);
  }
  return bytesToBase64Url(Uint8Array.from(out));
};

export const decodeLedger = (encoded: string): [number[], number[]] => {
  const r: Reader = { bytes: base64UrlToBytes(encoded), at: 0 };
  const version = getVarint(r);
  if (version !== REPLAY_CODEC_VERSION) {
    throw new Error(`replay: unsupported codec version ${version}`);
  }
  const count = getVarint(r);
  if (count < 2) throw new Error(`replay: expected 2 tracks, got ${count}`);

  const tracks: number[][] = [];
  for (let i = 0; i < count; i++) {
    const len = getVarint(r);
    if (r.at + len > r.bytes.length) throw new Error('replay: truncated track');
    const slice = r.bytes.subarray(r.at, r.at + len);
    r.at += len;
    // Only the two playable sides are returned; any additional track a future
    // writer appended is skipped rather than being an error, which is what
    // makes the length prefix worth paying for.
    if (i < 2) tracks.push(decodeInputTrack(slice));
  }
  return [tracks[0]!, tracks[1]!];
};

/**
 * Uncompressed tick count of an encoded ledger, without materialising it.
 * Cheap enough to call on a listing page.
 */
export const ledgerTicks = (encoded: string): number => {
  const r: Reader = { bytes: base64UrlToBytes(encoded), at: 0 };
  const version = getVarint(r);
  if (version !== REPLAY_CODEC_VERSION) return 0;
  const count = getVarint(r);
  let max = 0;
  for (let i = 0; i < count; i++) {
    const len = getVarint(r);
    const inner: Reader = { bytes: r.bytes.subarray(r.at, r.at + len), at: 0 };
    r.at += len;
    const n = getVarint(inner);
    if (n > max) max = n;
  }
  return max;
};
