/**
 * Verification DoS hardening (audit 2026-07-18, server finding 2).
 *
 * The hole: input ticks were capped only at 108,000 and desync forensics
 * re-simulated FROM TICK ZERO once per reported hash (cap 400) — one hostile
 * connection could buy tens of millions of synchronous sim steps inside a
 * single finishMatch, freezing the event loop for every match on the server.
 *
 * The fixes under test:
 *  1. Forensics is ONE forward pass over the ledger (O(n), not O(hashes×n))
 *     — a max-length ledger with 400 high-tick hashes settles in bounded time.
 *  2. Input ticks must be plausible against wall clock (a match can't have
 *     more ticks than elapsed time allows) — implausible ticks are dropped
 *     at ingest, before any sim ever sees them.
 *  3. ws maxPayload is a few KiB (the ws default is 100 MiB per frame).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import {
  ENGINE_VERSION, Phase, aiPoll, createAi, createGameState, loadCharacter,
  setCharacters, stateHash, step,
} from '@af/core';
import type { CharacterBundle } from '@af/core';
import { memoryPersistence } from '../src/persist.js';
import { createMatchServer } from '../src/server.js';
import { PROTOCOL_VERSION } from '../src/protocol.js';
import type { SMatch, SResult, ServerMsg } from '../src/protocol.js';

const here = dirname(fileURLToPath(import.meta.url));
const charactersDir = join(here, '..', '..', '..', 'characters');
const bundleOf = (id: string): CharacterBundle =>
  JSON.parse(readFileSync(join(charactersDir, id, 'character.json'), 'utf8')) as CharacterBundle;

/** A raw protocol client — lets a test misbehave in ways the real one can't. */
const rawClient = (url: string, name: string, mode: 'wager' | 'solo') => {
  const ws = new WebSocket(url);
  const msgs: ServerMsg[] = [];
  const waiters: Array<{ t: string; go: (m: ServerMsg) => void }> = [];
  ws.on('message', (d) => {
    const m = JSON.parse(String(d)) as ServerMsg;
    msgs.push(m);
    const i = waiters.findIndex((w) => w.t === m.t);
    if (i >= 0) waiters.splice(i, 1)[0]!.go(m);
  });
  const until = <T extends ServerMsg>(t: string, ms = 20_000): Promise<T> => {
    const hit = msgs.find((m) => m.t === t);
    if (hit) return Promise.resolve(hit as T);
    return new Promise((res, rej) => {
      const to = setTimeout(() => rej(new Error(`timeout waiting for "${t}" (${name})`)), ms);
      waiters.push({ t, go: (m) => { clearTimeout(to); res(m as T); } });
    });
  };
  const send = (m: unknown): void => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)); };
  const ready = new Promise<void>((res) => ws.on('open', () => {
    send({ t: 'hello', v: PROTOCOL_VERSION, name, engine: ENGINE_VERSION });
    send({ t: 'queue', character: 'analog', mode });
    res();
  }));
  return { ws, msgs, until, send, ready, close: () => ws.close() };
};

/**
 * Play an idle-player solo match by pre-simulating the WHOLE ledger locally
 * (exactly the client's aiPoll-before-step ordering), then dumping the full
 * input ledger + the 400 HIGHEST-tick hashes at once — the audited worst
 * case. `corruptLast` swaps the final reported hash for garbage.
 */
const runForensicsMatch = async (
  url: string, name: string, corruptLast: boolean,
): Promise<{ res: SResult; endTick: number; elapsedMs: number }> => {
  const c = rawClient(url, name, 'solo');
  await c.ready;
  const setup = await c.until<SMatch>('match');
  assert.ok(setup.solo, 'solo setup carries the pinned house AI');

  // Ground-truth sim: idle player (0) vs the pinned deterministic house AI.
  setCharacters(loadCharacter(bundleOf(setup.chars[0].id)), loadCharacter(bundleOf(setup.chars[1].id)));
  const g = createGameState(setup.seed);
  const ai = createAi(1, setup.solo.skill, setup.solo.aiSeed);
  const hashAfter: number[] = []; // hashAfter[t] = stateHash after t+1 steps
  while (g.phase !== Phase.MatchOver && hashAfter.length < 60 * 60 * 30) {
    const opp = aiPoll(ai, g);
    step(g, [0, opp]);
    hashAfter.push(stateHash(g));
  }
  const endTick = hashAfter.length;
  assert.ok(endTick > 500, `idle solo match decides after a real fight (got ${endTick} ticks)`);

  // The hostile dump: every input at once, then 400 hashes at the HIGHEST
  // ticks (each previously bought a from-zero re-sim), then 'over'.
  for (let k = 0; k < endTick; k++) c.send({ t: 'i', k, v: 0 });
  const firstHashTick = Math.max(1, endTick - 399);
  for (let tick = firstHashTick; tick <= endTick; tick++) {
    const x = corruptLast && tick === endTick ? 0xdeadbeef : hashAfter[tick - 1]! >>> 0;
    c.send({ t: 'h', k: tick, x });
  }
  const t0 = Date.now();
  c.send({ t: 'over', k: endTick });
  const res = await c.until<SResult>('result', 60_000);
  const elapsedMs = Date.now() - t0;
  c.close();
  return { res, endTick, elapsedMs };
};

test('forensics: max ledger + 400 high-tick hashes verifies in bounded time', async (t) => {
  const server = await createMatchServer({ port: 0, persistence: memoryPersistence(), noPaceCheck: true });
  t.after(() => server.close());
  const { res, endTick, elapsedMs } = await runForensicsMatch(
    `ws://127.0.0.1:${server.port}`, 'HashFlood', false,
  );
  assert.equal(res.reason, 'verified');
  assert.equal(res.endTick, endTick);
  assert.equal(res.deviator, undefined, 'honest hashes never flag a deviator');
  // One forward pass: well under a second in practice. The pre-fix code
  // (400 from-zero replays + 800 bundle loads) took orders of magnitude
  // longer; 5s is a generous CI-safe ceiling that still catches regression.
  assert.ok(elapsedMs < 5_000, `settled in ${elapsedMs}ms — forensics must be one pass`);
});

test('forensics: a single wrong high-tick hash still convicts the deviator', async (t) => {
  const server = await createMatchServer({ port: 0, persistence: memoryPersistence(), noPaceCheck: true });
  t.after(() => server.close());
  const { res } = await runForensicsMatch(
    `ws://127.0.0.1:${server.port}`, 'Desyncer', /* corruptLast */ true,
  );
  assert.equal(res.reason, 'verified');
  assert.equal(res.deviator, 0, 'the diverging side is named even at the last reported tick');
});

test('ingest cap (PvP): a tick the match cannot have reached yet is dropped, not relayed', async (t) => {
  // NO noPaceCheck — this test exercises the production wall-clock cap.
  const server = await createMatchServer({ port: 0, persistence: memoryPersistence() });
  t.after(() => server.close());
  const url = `ws://127.0.0.1:${server.port}`;

  const a = rawClient(url, 'Flooder', 'wager');
  const b = rawClient(url, 'Victim', 'wager');
  await Promise.all([a.ready, b.ready]);
  await Promise.all([a.until('match'), b.until('match')]);

  a.send({ t: 'i', k: 50_000, v: 1 }); // ~14 minutes of ticks, 0s into the match
  a.send({ t: 'i', k: 5, v: 2 });      // plausible — must still flow
  const relayed = await b.until<Extract<ServerMsg, { t: 'i' }>>('i', 5_000);
  assert.equal(relayed.k, 5, 'the plausible tick is relayed');
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(
    !b.msgs.some((m) => m.t === 'i' && m.k === 50_000),
    'the implausible tick never reaches the opponent',
  );
  a.close(); b.close();
});

test('ingest cap (solo): implausible ticks never lengthen the verified ledger', async (t) => {
  const server = await createMatchServer({ port: 0, persistence: memoryPersistence() });
  t.after(() => server.close());
  const c = rawClient(`ws://127.0.0.1:${server.port}`, 'FastForward', 'solo');
  await c.ready;
  await c.until('match');
  for (let k = 0; k < 10; k++) c.send({ t: 'i', k, v: 0 });
  c.send({ t: 'i', k: 6_000, v: 0 }); // 100s of sim ticks, ~0s of wall clock
  c.send({ t: 'over', k: 6_001 });
  const res = await c.until<SResult>('result');
  assert.ok(res.endTick <= 10, `verified ledger stops at the plausible ticks (endTick=${res.endTick})`);
  c.close();
});

test('ws maxPayload: an oversized frame closes the socket instead of buffering 100 MiB', async (t) => {
  const server = await createMatchServer({ port: 0, persistence: memoryPersistence() });
  t.after(() => server.close());
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}`);
  const closed = new Promise<number>((res) => ws.on('close', (code) => res(code)));
  await new Promise<void>((res) => ws.on('open', () => res()));
  ws.on('error', () => { /* 1009 surfaces as an error too — close still fires */ });
  ws.send('x'.repeat(64 * 1024));
  const code = await closed;
  assert.equal(code, 1009, 'ws must reject the frame with "message too big"');
});
