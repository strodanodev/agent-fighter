/**
 * Replay a stored match ledger and check it reproduces the settled result.
 *
 * This is the audit instrument for ADR 0010. The entire esports data layer
 * rests on one claim — that a stored ledger reproduces, bit-exactly, the state
 * the server settled money against. This script is how that claim is checked
 * against PRODUCTION data rather than against a fixture.
 *
 * It deliberately re-does the work the server did, from the outside:
 *   1. recompute the canonical digest over the stored bytes;
 *   2. confirm the character bundles are still the ones the match was fought
 *      with (a retuned bundle breaks reproduction exactly like a bumped
 *      engine — that is why `charDigests` is in the pin);
 *   3. decode the ledger, install the pin, and step the sim;
 *   4. compare winner / rounds / endTick / stateHash to what was recorded.
 *
 * Run:  npx tsx tools/replay-verify.mts [matchId]
 *       (no id = the most recently stored ledger)
 *
 * Reads SUPABASE_URL + SUPABASE_SERVICE_KEY from the repo .env — `match_ledgers`
 * is RLS default-deny, so the anon key cannot see it by design.
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Phase, canonicalJson, createGameState, decodeLedger, loadCharacter,
  setCharacters, setMatchItems, stateHash, step,
} from '@af/core';
import type { CharacterBundle, ItemEffect } from '@af/core';
import { loadDotEnv } from '../packages/server/src/persist.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
loadDotEnv(REPO);

const url = (process.env.SUPABASE_URL ?? '').replace(/\/+$/, '');
const key = process.env.SUPABASE_SERVICE_KEY ?? '';
if (!url || !key) {
  console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY missing from .env');
  process.exitCode = 2;
  throw new Error('aborted');
}

interface LedgerRow {
  match_id: string; ledger: string; digest: string;
  engine: string; protocol: number; codec_version: number; ticks: number;
  pin: {
    seed: number; stage: string; bounds: { left: number; right: number } | null;
    chars: [string, string]; charDigests: [string, string];
    delay: number; names: [string, string];
    items?: [Array<{ effect: ItemEffect }>, Array<{ effect: ItemEffect }>];
    result: {
      hash: number; winner: number; rounds: [number, number];
      endTick: number; reason: string;
    };
  };
}

const matchId = process.argv[2] ?? '';
const q = matchId
  ? `match_id=eq.${encodeURIComponent(matchId)}`
  : 'order=created_at.desc&limit=1';

const res = await fetch(`${url}/rest/v1/match_ledgers?select=*&${q}`, {
  headers: { apikey: key, Authorization: `Bearer ${key}` },
});
if (!res.ok) {
  console.error(`fetch failed ${res.status}: ${await res.text()}`);
  process.exitCode = 2;
  throw new Error('aborted');
}
const rows = (await res.json()) as LedgerRow[];
const row = rows[0];
if (!row) {
  console.error(matchId ? `no ledger for ${matchId}` : 'no ledgers stored yet');
  process.exitCode = 2;
  throw new Error('aborted');
}
const { pin } = row;

console.log(`\n  MATCH   ${row.match_id}   (${pin.result.reason})`);
console.log(`  ${pin.names[0]} · ${pin.chars[0]}   vs   ${pin.names[1]} · ${pin.chars[1]}   @ ${pin.stage}`);
console.log(`  engine ${row.engine} · protocol ${row.protocol} · codec v${row.codec_version}`);
console.log(
  `  ledger ${row.ledger.length} chars for ${row.ticks} ticks `
  + `(${(row.ticks / 60).toFixed(1)}s, ${(row.ledger.length / (row.ticks / 60)).toFixed(0)} bytes/second)\n`,
);

const mark = (ok: boolean) => (ok ? 'MATCH ' : 'DIFFER');

// 1. digest over the stored bytes
// Canonical (sorted-key) json, matching the server. Plain JSON.stringify
// cannot work here: the pin comes back from Postgres jsonb, which does not
// preserve key order.
const recomputed = createHash('sha256')
  .update(canonicalJson([
    row.match_id, row.engine, row.protocol, row.codec_version, row.ledger, pin,
  ]))
  .digest('hex');
const digestOk = recomputed === row.digest;
console.log(`  digest        ${mark(digestOk)}  ${row.digest.slice(0, 32)}…`);

// 2. are the bundles still what it was fought with?
const charFile = (id: string) => join(REPO, 'characters', id, 'character.json');
const charsOk = pin.chars.every(
  (c, i) => createHash('sha256').update(readFileSync(charFile(c))).digest('hex') === pin.charDigests[i],
);
console.log(`  characters    ${mark(charsOk)}  ${charsOk ? 'bundles unchanged since the match' : 'RETUNED — reproduction not expected'}`);

// 3. replay, exactly as the server's verifier does
const [t0, t1] = decodeLedger(row.ledger);
setCharacters(
  loadCharacter(JSON.parse(readFileSync(charFile(pin.chars[0]), 'utf8')) as CharacterBundle),
  loadCharacter(JSON.parse(readFileSync(charFile(pin.chars[1]), 'utf8')) as CharacterBundle),
);
setMatchItems(
  (pin.items?.[0] ?? []).map((p) => p.effect),
  (pin.items?.[1] ?? []).map((p) => p.effect),
);
const g = createGameState(pin.seed, pin.bounds ?? undefined);
const n = Math.min(t0.length, t1.length);
let t = 0;
while (g.phase !== Phase.MatchOver && t < n) {
  step(g, [t0[t]! | 0, t1[t]! | 0]);
  t++;
}

const want = pin.result;
const got = {
  winner: g.winner,
  rounds: `${g.roundsWon0}-${g.roundsWon1}`,
  endTick: t,
  hash: stateHash(g),
};
const wantRounds = `${want.rounds[0]}-${want.rounds[1]}`;

console.log('');
const cmp = (label: string, a: unknown, b: unknown): boolean => {
  const ok = String(a) === String(b);
  console.log(`  ${label.padEnd(13)} ${mark(ok)}  replay=${String(a)}   recorded=${String(b)}`);
  return ok;
};
const okWinner = cmp('winner', got.winner, want.winner);
const okRounds = cmp('rounds', got.rounds, wantRounds);
const okTick = cmp('endTick', got.endTick, want.endTick);
const okHash = cmp('stateHash', got.hash, want.hash);

/**
 * A FORFEIT's winner is not in the ledger, and must not be expected there.
 *
 * When someone disconnects, the verdict is awarded by the settlement ladder
 * (ADR 0005) — not derived by simulation. The ledger still reproduces the
 * portion that was actually PLAYED, which is what `stateHash` proves; the sim
 * simply says "nobody has won yet" (-1), which is the truth about those ticks.
 *
 * This is the same distinction the public API publishes as
 * `resolution.verified` — true only when the outcome came out of a full
 * re-simulation. Demanding a derived winner from a forfeited ledger would be
 * asking the data to lie.
 */
const derived = want.reason === 'verified';
const ok = digestOk && okRounds && okTick && okHash && (derived ? okWinner : true);

console.log('');
if (!derived) {
  console.log(`  NOTE: reason="${want.reason}" — the winner was AWARDED by the`);
  console.log('        settlement ladder, not derived from the ledger. The played');
  console.log('        ticks still reproduce exactly (see stateHash above).');
  console.log('');
}
console.log(`  ${ok
  ? (derived
    ? 'VERIFIED — the replay reproduces the settled result exactly'
    : 'VERIFIED — the played ticks reproduce exactly (verdict awarded, not derived)')
  : 'FAILED — the replay does not reproduce what was recorded'}\n`);
process.exitCode = ok ? 0 : 1;
