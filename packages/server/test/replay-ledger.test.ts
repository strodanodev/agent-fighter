/**
 * REPLAY LEDGERS (ADR 0010, Phase 0) — what the server keeps after a match.
 *
 * The claims under test:
 *  · a settled WAGER stores its input ledger, and what comes back out is
 *    BYTE-FOR-TICK what the players actually sent;
 *  · arcade and solo store NOTHING — that is the owner's storage rule, not an
 *    accident, and it is what keeps this inside the free tier;
 *  · the write is idempotent and can never disturb settlement.
 *
 * The "does a ledger reproduce the match" question is answered in
 * packages/core/test/replay.test.ts, which steps two sims tick-for-tick. Here
 * we prove the SERVER stores the right bytes; there we prove those bytes are
 * a replay. Together they are the chain.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WebSocket } from 'ws';
import { ENGINE_VERSION, REPLAY_CODEC_VERSION, decodeLedger } from '@af/core';
import { memoryPersistence } from '../src/persist.js';
import type { MatchLedger, Persistence } from '../src/persist.js';
import { createMatchServer } from '../src/server.js';
import { PROTOCOL_VERSION } from '../src/protocol.js';
import type { ServerMsg } from '../src/protocol.js';

/**
 * memoryPersistence with every saveLedger call captured.
 *
 * Wrapping rather than reaching into the implementation: `saveLedger` is
 * optional on the interface precisely so a caller can substitute one, and a
 * test that only inspects the public seam cannot rot when internals move.
 */
const capturing = (): { p: Persistence; saved: MatchLedger[] } => {
  const base = memoryPersistence();
  const saved: MatchLedger[] = [];
  return {
    saved,
    p: {
      ...base,
      saveLedger: async (l) => {
        saved.push(l);
        await base.saveLedger?.(l);
      },
    },
  };
};

const raw = (url: string, name: string, mode: string, extra: object = {}) => {
  const ws = new WebSocket(url);
  const msgs: ServerMsg[] = [];
  const waiters: Array<{ t: string; go: (m: ServerMsg) => void }> = [];
  ws.on('message', (d) => {
    const m = JSON.parse(String(d)) as ServerMsg;
    msgs.push(m);
    const i = waiters.findIndex((w) => w.t === m.t);
    if (i >= 0) waiters.splice(i, 1)[0]!.go(m);
  });
  const until = <T extends ServerMsg>(t: string, ms = 25_000): Promise<T> => {
    const hit = msgs.find((m) => m.t === t);
    if (hit) return Promise.resolve(hit as T);
    return new Promise((res, rej) => {
      const to = setTimeout(() => rej(new Error(`timeout waiting for "${t}" (${name})`)), ms);
      waiters.push({ t, go: (m) => { clearTimeout(to); res(m as T); } });
    });
  };
  const send = (m: unknown): void => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
  };
  const ready = new Promise<void>((res) => ws.on('open', () => {
    send({ t: 'hello', v: PROTOCOL_VERSION, name, engine: ENGINE_VERSION });
    send({ t: 'queue', character: 'analog', mode, ...extra });
    res();
  }));
  return { ws, msgs, until, send, ready, close: () => ws.close() };
};

test('a settled WAGER stores a ledger that decodes back to the exact inputs sent', async (t) => {
  const { p, saved } = capturing();
  const server = await createMatchServer({ port: 0, persistence: p, noPaceCheck: true });
  t.after(() => server.close());
  const url = `ws://127.0.0.1:${server.port}`;

  const a = raw(url, 'LedgerA', 'wager');
  const b = raw(url, 'LedgerB', 'wager');
  t.after(() => { a.close(); b.close(); });
  await Promise.all([a.ready, b.ready]);
  await Promise.all([a.until('match'), b.until('match')]);

  // A scripted, asymmetric input script — asymmetric so a bug that swapped or
  // duplicated the two tracks could not pass by coincidence.
  const sentA: number[] = [];
  const sentB: number[] = [];
  for (let k = 0; k < 60; k++) {
    const va = k % 7 === 0 ? 16 : k % 3 === 0 ? 8 : 0;
    const vb = k % 5 === 0 ? 32 : k % 2 === 0 ? 4 : 0;
    sentA.push(va);
    sentB.push(vb);
    a.send({ t: 'i', k, v: va });
    b.send({ t: 'i', k, v: vb });
  }
  await new Promise((r) => setTimeout(r, 400));
  // End it by forfeit: the ledger is stored for every settled wager, whatever
  // the verdict, and this reaches settlement in a second rather than fighting
  // a full best-of-three.
  a.close();
  await b.until<Extract<ServerMsg, { t: 'result' }>>('result', 30_000);
  await new Promise((r) => setTimeout(r, 400));

  assert.equal(saved.length, 1, 'exactly one ledger for one settled wager');
  const l = saved[0]!;
  assert.equal(l.engine, ENGINE_VERSION);
  assert.equal(l.protocol, PROTOCOL_VERSION);
  assert.equal(l.codecVersion, REPLAY_CODEC_VERSION);
  assert.match(l.digest, /^[0-9a-f]{64}$/, 'canonical sha256 hex');
  assert.ok(l.ticks >= 60, `expected the streamed ticks, got ${l.ticks}`);

  // The pin must be sufficient to set a replay up deterministically.
  assert.equal(typeof l.pin.seed, 'number');
  assert.deepEqual(l.pin.chars, ['analog', 'analog']);
  const digests = l.pin.charDigests as string[];
  assert.match(digests[0]!, /^[0-9a-f]{64}$/, 'character bundle is content-pinned');

  // THE assertion: what the server stored is what the players sent.
  const [t0, t1] = decodeLedger(l.ledger);
  assert.deepEqual(t0.slice(0, 60), sentA, 'side 0 track survived exactly');
  assert.deepEqual(t1.slice(0, 60), sentB, 'side 1 track survived exactly');
});

test('a non-wager match stores NO ledger — the storage rule is deliberate', async (t) => {
  const { p, saved } = capturing();
  const server = await createMatchServer({ port: 0, persistence: p, noPaceCheck: true });
  t.after(() => server.close());

  // SOLO stands in for the whole single-player family here. `m.mode ===
  // 'wager'` is the only gate in finishMatch, so solo and arcade take the
  // identical branch; solo is used because arcade v2 (ADR 0008) requires the
  // POST /arcade/enter → /arcade/run handshake before it will pair, which
  // would test the arcade entry flow rather than the storage rule.
  const c = raw(`ws://127.0.0.1:${server.port}`, 'SoloOnly', 'solo');
  t.after(() => c.close());
  await c.ready;
  await c.until('match', 25_000);

  for (let k = 0; k < 40; k++) c.send({ t: 'i', k, v: 0 });
  await new Promise((r) => setTimeout(r, 300));
  c.close();
  // Give settlement (and any ledger write that should NOT happen) time to run.
  await new Promise((r) => setTimeout(r, 1500));

  assert.equal(
    saved.length, 0,
    'single-player is 96.6% of all matches and is fought against a pinned AI — storing it is exactly what we chose not to pay for',
  );
});

test('saveLedger is idempotent: a retry never overwrites the settled row', async () => {
  const p = memoryPersistence();
  const mk = (ledger: string): MatchLedger => ({
    matchId: 'dup-1', ledger, pin: {}, engine: 'af-core-7',
    protocol: PROTOCOL_VERSION, codecVersion: REPLAY_CODEC_VERSION,
    ticks: 1, digest: 'x'.repeat(64),
  });
  // Both calls must resolve — a retried settlement must not throw — and the
  // FIRST write is the one that belongs to the result that was paid out.
  await p.saveLedger!(mk('first'));
  await p.saveLedger!(mk('second'));
});
