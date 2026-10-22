/**
 * ARCADE IDENTITY ON THE RELAY (ADR 0014).
 *
 * A participant is the player's ed25519 key whenever the arcade launched the
 * game — but on the relay `hello.playerKey` is only a claim. The relay names a
 * key in the archived ledger only once that key signed the very log being
 * archived (litnode's ledger body, `ledger NUL canonical(body)`). A side that
 * claimed a key it does not hold is archived with no key, which leaves it to
 * the casual, name-labelled path. And a relay-hosted placed room is announced
 * to the client as casual: only a gauntlet may settle ranked.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { memoryPersistence } from '../src/persist.js';
import type { MatchLedger, Persistence } from '../src/persist.js';
import { createMatchServer } from '../src/server.js';
import { playOneMatch } from '../src/agent-session.js';
import { roomCodeFor, verifyLedgerSig } from '../src/mesh-ledger.js';

const here = dirname(fileURLToPath(import.meta.url));
const charactersDir = join(here, '..', '..', '..', 'characters');

/** litnode protocol/canonical.js: JSON with object keys sorted. */
const canonical = (v: unknown): string => JSON.stringify(v, (_k, x: unknown) => (x && typeof x === 'object' && !Array.isArray(x)
  ? Object.fromEntries(Object.keys(x as object).sort().map((k) => [k, (x as Record<string, unknown>)[k]]))
  : x));

/** An arcade player key: ed25519, public key as 64 hex, signing like litnode protocol/keys.js. */
const arcadeKey = (): { id: string; signLedger: (body: object) => string } => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const id = (publicKey.export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32).toString('hex');
  const signWith = (k: KeyObject) => (body: object): string => sign(null, Buffer.from(`ledger\0${canonical(body)}`, 'utf8'), k).toString('hex');
  return { id, signLedger: signWith(privateKey) };
};

const capturing = (): { p: Persistence; saved: MatchLedger[] } => {
  const base = memoryPersistence();
  const saved: MatchLedger[] = [];
  return { saved, p: { ...base, saveLedger: async (l) => { saved.push(l); await base.saveLedger?.(l); } } };
};

test('verifyLedgerSig accepts exactly litnode\'s ledger signature', () => {
  const k = arcadeKey();
  const body = { matchId: randomBytes(32).toString('hex'), ticks: 12, head: 'ab'.repeat(32), buildHash: null };
  const sig = k.signLedger(body);
  assert.equal(verifyLedgerSig(body, sig, k.id), true);
  assert.equal(verifyLedgerSig({ ...body, ticks: 13 }, sig, k.id), false, 'another tick count');
  assert.equal(verifyLedgerSig(body, sig, arcadeKey().id), false, 'another key');
  assert.equal(verifyLedgerSig(body, 'zz', k.id), false, 'garbage never throws');
});

test('the relay archives a placed room with PROVEN keys only, and calls it casual', async (t) => {
  const { p, saved } = capturing();
  const server = await createMatchServer({ port: 0, persistence: p, noPaceCheck: true });
  t.after(() => server.close());
  const url = `ws://127.0.0.1:${server.port}`;

  const meshMatchId = randomBytes(32).toString('hex');
  const room = roomCodeFor(meshMatchId);
  const honest = arcadeKey();
  const claimed = arcadeKey(); // B claims this key …
  const other = arcadeKey(); // … but can only sign with this one.
  const body = (ledger: { head: string; ticks: number }): object => ({ matchId: meshMatchId, ticks: ledger.ticks, head: ledger.head, buildHash: null });

  const [a, b] = await Promise.all([
    playOneMatch({ url, name: 'HONEST', character: 'analog', skill: 70, charactersDir, aiSeed: 1, paceMs: 1, mode: 'friendly', room, playerKey: honest.id, meshMatchId, signLedger: (l) => honest.signLedger(body(l)) }),
    new Promise((r) => setTimeout(r, 200)).then(() => playOneMatch({ url, name: 'CLAIMER', character: 'vector', skill: 55, charactersDir, aiSeed: 2, paceMs: 1, mode: 'friendly', room, playerKey: claimed.id, meshMatchId, signLedger: (l) => other.signLedger(body(l)) })),
  ]);
  assert.deepEqual(a.placed, { intake: 'relay', mode: 'casual' }, 'a relay-hosted placed room is never ranked');
  assert.deepEqual(b.placed, { intake: 'relay', mode: 'casual' });

  for (let i = 0; i < 60 && saved.length === 0; i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(saved.length, 1, 'the placed room was archived');
  const pin = saved[0]!.pin as { names: string[]; playerKeys: string[]; signatures: Record<string, string>; intake: string; meshMatchId: string };
  const sideOf = (name: string): number => pin.names.indexOf(name);
  assert.equal(pin.intake, 'relay');
  assert.equal(pin.meshMatchId, meshMatchId);
  assert.equal(pin.playerKeys[sideOf('HONEST')], honest.id, 'the key that signed the log is kept');
  assert.equal(pin.playerKeys[sideOf('CLAIMER')], '', 'a key that did not sign this log is dropped');
  assert.deepEqual(Object.keys(pin.signatures), [honest.id], 'only the verified signature is archived');
});
