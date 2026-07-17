/**
 * Friendly challenge rooms (protocol v5) — the invite system's live half.
 *
 * The rules under test:
 *  · SYMMETRIC RENDEZVOUS: the two sockets presenting the same room code
 *    pair with each other — and ONLY with each other (different rooms never
 *    cross, the public wager FIFO is never involved).
 *  · FREE AND UNRANKED: no fee is escrowed and NOTHING settles — no credit
 *    movement, no W/L, no XP, even on a forfeit. This is the anti-collusion
 *    stance for invited games: a mode that moves nothing can't be farmed.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WebSocket } from 'ws';
import { ENGINE_VERSION } from '@af/core';
import { DAILY_CREDITS, memoryPersistence } from '../src/persist.js';
import { createMatchServer } from '../src/server.js';
import { PROTOCOL_VERSION } from '../src/protocol.js';
import type { ServerMsg } from '../src/protocol.js';

/** A raw protocol client that queues a friendly into `room`. */
const rawFriendly = (url: string, name: string, room?: string) => {
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
    send({ t: 'queue', character: 'analog', mode: 'friendly', room });
    res();
  }));
  return { ws, msgs, until, send, ready, close: () => ws.close() };
};

test('RENDEZVOUS: same room pairs, different rooms never cross', async (t) => {
  const persistence = memoryPersistence();
  const server = await createMatchServer({ port: 0, persistence, noPaceCheck: true });
  t.after(() => server.close());
  const url = `ws://127.0.0.1:${server.port}`;

  // Two waiters in two DIFFERENT rooms — neither may see a match.
  const a = rawFriendly(url, 'RoomA', 'ALPHA-0001');
  const b = rawFriendly(url, 'RoomB', 'BRAVO-0002');
  await Promise.all([a.ready, b.ready]);
  await Promise.all([a.until('queued'), b.until('queued')]);
  await new Promise((r) => setTimeout(r, 600));
  assert.ok(!a.msgs.some((m) => m.t === 'match'), 'different rooms must not pair');
  assert.ok(!b.msgs.some((m) => m.t === 'match'), 'different rooms must not pair');

  // A challenger presenting room A's code meets EXACTLY room A's waiter.
  const c = rawFriendly(url, 'JoinsA', 'ALPHA-0001');
  await c.ready;
  const [setupA, setupC] = await Promise.all([
    a.until<Extract<ServerMsg, { t: 'match' }>>('match'),
    c.until<Extract<ServerMsg, { t: 'match' }>>('match'),
  ]);
  assert.equal(setupA.mode, 'friendly');
  assert.equal(setupA.fee, 0, 'friendly is free — nothing escrowed');
  assert.equal(setupA.matchId, setupC.matchId, 'both sides are in the SAME match');
  assert.deepEqual(setupA.names, ['RoomA', 'JoinsA'], 'waiter is side 0, joiner side 1');
  assert.ok(!b.msgs.some((m) => m.t === 'match'), 'room B is untouched');

  a.close(); b.close(); c.close();
});

test('UNRANKED: even a forfeited friendly moves NOTHING (credits, W/L, XP)', async (t) => {
  const persistence = memoryPersistence();
  const server = await createMatchServer({ port: 0, persistence, noPaceCheck: true });
  t.after(() => server.close());
  const url = `ws://127.0.0.1:${server.port}`;

  const quitter = rawFriendly(url, 'FQuitter', 'FIGHT-CLUB');
  const stayer = rawFriendly(url, 'FStayer', 'FIGHT-CLUB');
  await Promise.all([quitter.ready, stayer.ready]);
  await Promise.all([quitter.until('match'), stayer.until('match')]);

  // A few neutral ticks — nowhere near a decision — then the quitter bails.
  // In wager mode this exact sequence books a loss and moves the pot
  // (disconnect.test.ts RAGEQUIT); in friendly it must move NOTHING.
  for (let k = 0; k < 30; k++) { quitter.send({ t: 'i', k, v: 0 }); stayer.send({ t: 'i', k, v: 0 }); }
  await new Promise((r) => setTimeout(r, 300));
  quitter.close();

  const res = await stayer.until<Extract<ServerMsg, { t: 'result' }>>('result', 30_000);
  assert.equal(res.reason, 'forfeit', 'the verdict itself still exists (bragging rights)');
  await new Promise((r) => setTimeout(r, 400));

  const q = await persistence.getAccount({ sub: 'dev:FQuitter' }, 'FQuitter', false);
  const s = await persistence.getAccount({ sub: 'dev:FStayer' }, 'FStayer', false);
  assert.equal(q.credits, DAILY_CREDITS, 'quitter: only the daily bonus — nothing burned');
  assert.equal(s.credits, DAILY_CREDITS, 'stayer: only the daily bonus — nothing won');
  assert.equal(q.wins + q.losses + s.wins + s.losses, 0, 'no W/L is ever booked');
  assert.equal(q.xp + s.xp, 0, 'no XP moves');
  stayer.close();
});

test('room code is required — a friendly queue without one is refused', async (t) => {
  const server = await createMatchServer({ port: 0, persistence: memoryPersistence(), noPaceCheck: true });
  t.after(() => server.close());
  const c = rawFriendly(`ws://127.0.0.1:${server.port}`, 'NoRoom', undefined);
  await c.ready;
  const err = await c.until<Extract<ServerMsg, { t: 'error' }>>('error');
  assert.match(err.msg, /room code/i);
  c.close();
});
