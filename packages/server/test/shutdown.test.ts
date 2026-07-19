/**
 * Graceful drain (deploy hardening, 2026-07-20): shutdown() must settle
 * every live match through the normal ladder — an undecided wager becomes
 * a no-contest that REFUNDS both fees and tells both clients, instead of
 * the old behavior (process dies, clients stranded at "VERIFYING WITH
 * SERVER…", fees frozen until the sweeper). Plus the items twin of the
 * escrow sweeper: cans claimed by a match that never settled come back.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WebSocket } from 'ws';
import { ENGINE_VERSION, ITEM_COST } from '@af/core';
import { DAILY_CREDITS, memoryPersistence } from '../src/persist.js';
import { createMatchServer } from '../src/server.js';
import { PROTOCOL_VERSION } from '../src/protocol.js';
import type { SMatch, ServerMsg } from '../src/protocol.js';

/** Raw protocol client (same scripted shape as resume.test.ts). */
const rawClient = (url: string, name: string) => {
  const ws = new WebSocket(url);
  const msgs: ServerMsg[] = [];
  const waiters: Array<{ t: string; go: (m: ServerMsg) => void }> = [];
  ws.on('message', (d) => {
    const m = JSON.parse(String(d)) as ServerMsg;
    msgs.push(m);
    const i = waiters.findIndex((w) => w.t === m.t);
    if (i >= 0) waiters.splice(i, 1)[0]!.go(m);
  });
  const until = <T extends ServerMsg>(t: string, ms = 15_000): Promise<T> => {
    const hit = msgs.find((m) => m.t === t);
    if (hit) return Promise.resolve(hit as T);
    return new Promise((res, rej) => {
      const to = setTimeout(() => rej(new Error(`timeout waiting for "${t}" (${name})`)), ms);
      waiters.push({ t, go: (m) => { clearTimeout(to); res(m as T); } });
    });
  };
  const send = (m: unknown): void => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)); };
  const open = new Promise<void>((res) => ws.on('open', () => res()));
  const hello = (): void => send({ t: 'hello', v: PROTOCOL_VERSION, name, engine: ENGINE_VERSION });
  return { ws, msgs, until, send, open, hello, close: () => ws.close() };
};

test('DRAIN: shutdown settles a live undecided wager as a refunded no-contest and both clients hear it', async () => {
  const persistence = memoryPersistence();
  const server = await createMatchServer({ port: 0, persistence, noPaceCheck: true });
  const url = `ws://127.0.0.1:${server.port}`;

  const a = rawClient(url, 'Drainee');
  const b = rawClient(url, 'Bystander');
  await Promise.all([a.open, b.open]);
  a.hello(); a.send({ t: 'queue', character: 'analog', mode: 'wager' });
  b.hello(); b.send({ t: 'queue', character: 'vector', mode: 'wager' });
  await Promise.all([a.until<SMatch>('match'), b.until<SMatch>('match')]);

  // A few ticks in, mid-fight, the deploy lands.
  for (let k = 0; k < 60; k++) { a.send({ t: 'i', k, v: 0 }); b.send({ t: 'i', k, v: 0 }); }
  await new Promise((r) => setTimeout(r, 200));
  await server.shutdown();

  // Both clients got a RESULT (no eternal "VERIFYING WITH SERVER…"), the
  // undecided ledger settled as a no-contest, and both fees came back.
  const [ra, rb] = await Promise.all([
    a.until<Extract<ServerMsg, { t: 'result' }>>('result', 2_000),
    b.until<Extract<ServerMsg, { t: 'result' }>>('result', 2_000),
  ]);
  assert.equal(ra.reason, 'incomplete');
  assert.equal(ra.winner, -1);
  assert.equal(rb.reason, 'incomplete');
  for (const who of ['Drainee', 'Bystander']) {
    const acc = await persistence.getAccount({ sub: `dev:${who}` }, who, false);
    assert.equal(acc.credits, DAILY_CREDITS, `${who}'s wager fee refunded by the drain`);
  }
  a.close(); b.close();
});

test('DRAIN: while draining, new queues are refused with a message (not silently ignored)', async () => {
  const server = await createMatchServer({ port: 0, persistence: memoryPersistence(), noPaceCheck: true });
  const url = `ws://127.0.0.1:${server.port}`;
  const late = rawClient(url, 'TooLate');
  await late.open;
  late.hello();
  await server.shutdown(); // nothing live — resolves immediately, socket still open
  late.send({ t: 'queue', character: 'analog', mode: 'solo' });
  const err = await late.until<Extract<ServerMsg, { t: 'error' }>>('error', 3_000);
  assert.match(err.msg, /restarting/);
  late.close();
});

test('ITEM SWEEP: cans stranded by a crash come back; settled + fresh claims stay put', async () => {
  const p = memoryPersistence();
  const sub = 'dev:Sweepy';
  await p.getAccount({ sub }, 'Sweepy', false);
  // Fund: daily 10 covers two 5-credit cans.
  const c1 = await p.buyItem(sub, ITEM_COST, 'heal_1', 1, 'sweep-nonce-1');
  const c2 = await p.buyItem(sub, ITEM_COST, 'crit_2', 2, 'sweep-nonce-2');

  // Can 1: claimed by a match that NEVER settles (crash strand).
  await p.consumeItem(sub, c1.rowId, 'm-crashed-1');
  // Can 2: claimed AND properly settled as drunk — consumed forever.
  await p.consumeItem(sub, c2.rowId, 'm-settled-1');
  await p.recordMatch({
    matchId: 'm-settled-1', mode: 'solo', fee: 0,
    identities: [{ sub }, null], names: ['Sweepy', 'HOUSE'],
    agents: [false, true], chars: ['analog', 'analog'],
    winner: 0, reason: 'verified', rounds: [2, 0], endTick: 1000, hash: 1,
    engine: ENGINE_VERSION,
  });
  await p.settleItems('m-settled-1', [c2.rowId]);

  // Cutoff 0 = everything old enough. The stranded can returns; the drunk
  // one stays consumed.
  assert.equal(await p.sweepOrphanedItems(0), 1);
  const stash = await p.listItems(sub);
  assert.deepEqual(stash.map((i) => i.rowId), [c1.rowId], 'stranded can back, drunk can gone');
  // Idempotent: nothing left to release.
  assert.equal(await p.sweepOrphanedItems(0), 0);

  // Escrow-sweeper ghosts do NOT count as settled for items (0018 mirror):
  // a can claimed by a ghost the FEE sweeper already claimed still returns.
  const c3 = await p.buyItem(sub, 0, 'def_1', 1, 'sweep-nonce-3');
  await p.consumeItem(sub, c3.rowId, 'm-ghost-1');
  await p.escrowMatch('m-ghost-1', [sub, null], 0);
  await p.sweepOrphanedEscrow(0); // claims the ghost with a synthetic matches row
  assert.equal(await p.sweepOrphanedItems(0), 1, 'ghost-claimed match releases its can');
});
