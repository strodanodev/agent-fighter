/**
 * Match resume (ADR 0005): a dropped socket rejoins with its bearer token
 * within the grace window and the match continues — no forfeit, relay
 * re-attached, ledger replayed. Plus the abuse edges: a bad token is
 * rejected, and a settled match cannot be re-entered.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WebSocket } from 'ws';
import { ENGINE_VERSION } from '@af/core';
import { DAILY_CREDITS, WAGER_FEE, memoryPersistence } from '../src/persist.js';
import { createMatchServer } from '../src/server.js';
import { PROTOCOL_VERSION } from '../src/protocol.js';
import type { SMatch, SResumed, ServerMsg } from '../src/protocol.js';

/** Raw protocol client with scripted control over its socket. */
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
  const until = <T extends ServerMsg>(t: string, ms = 20_000): Promise<T> => {
    const hit = msgs.find((m) => m.t === t);
    if (hit) return Promise.resolve(hit as T);
    return new Promise((res, rej) => {
      const to = setTimeout(() => rej(new Error(`timeout waiting for "${t}" (${name})`)), ms);
      waiters.push({ t, go: (m) => { clearTimeout(to); res(m as T); } });
    });
  };
  const send = (m: unknown): void => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)); };
  const open = new Promise<void>((res) => ws.on('open', () => res()));
  return { ws, msgs, until, send, open, close: () => ws.close() };
};

const hello = (c: ReturnType<typeof rawClient>, name: string): void =>
  c.send({ t: 'hello', v: PROTOCOL_VERSION, name, engine: ENGINE_VERSION });

test('RESUME: drop mid-wager, rejoin with the token, keep playing, then WIN by the other side quitting', async (t) => {
  const persistence = memoryPersistence();
  const server = await createMatchServer({ port: 0, persistence, noPaceCheck: true });
  t.after(() => server.close());
  const url = `ws://127.0.0.1:${server.port}`;

  const a = rawClient(url, 'Blinky');
  const b = rawClient(url, 'Steady');
  await Promise.all([a.open, b.open]);
  hello(a, 'Blinky'); a.send({ t: 'queue', character: 'analog', mode: 'wager' });
  hello(b, 'Steady'); b.send({ t: 'queue', character: 'vector', mode: 'wager' });
  const [setupA] = await Promise.all([a.until<SMatch>('match'), b.until<SMatch>('match')]);
  assert.ok(setupA.resume, 'setup carries a resume token');

  // Exchange some ticks, then A's socket "blips".
  for (let k = 0; k < 120; k++) { a.send({ t: 'i', k, v: 0 }); b.send({ t: 'i', k, v: 0 }); }
  await new Promise((r) => setTimeout(r, 300));
  a.close();
  await new Promise((r) => setTimeout(r, 500)); // inside the 20s grace

  // A returns on a fresh socket and resumes with its token.
  const a2 = rawClient(url, 'Blinky');
  await a2.open;
  hello(a2, 'Blinky');
  a2.send({ t: 'resume', matchId: setupA.matchId, token: setupA.resume });
  const resumed = await a2.until<SResumed>('resumed');
  assert.equal(resumed.matchId, setupA.matchId);
  assert.equal(resumed.side, setupA.side);
  assert.ok(resumed.inputs[0].length >= 120, 'the ledger came back for replay');

  // The relay is re-attached: B's new inputs reach A2 and vice versa.
  for (let k = 120; k < 160; k++) { a2.send({ t: 'i', k, v: 0 }); b.send({ t: 'i', k, v: 0 }); }
  const relayed = await a2.until<Extract<ServerMsg, { t: 'i' }>>('i');
  assert.ok(relayed.k >= 0, 'opponent inputs flow to the resumed socket');

  // Now STEADY leaves for good — the resumed side must be the forfeit WINNER.
  b.close();
  const result = await a2.until<Extract<ServerMsg, { t: 'result' }>>('result', 30_000);
  assert.equal(result.reason, 'forfeit');
  assert.equal(result.winner, setupA.side, 'the resumed side takes the win');
  await new Promise((r) => setTimeout(r, 400));
  const acc = await persistence.getAccount({ sub: 'dev:Blinky' }, 'Blinky', false);
  assert.equal(acc.credits, DAILY_CREDITS + WAGER_FEE, 'and the pot');
  a2.close();
});

test('RESUME abuse: wrong token rejected; settled match not re-enterable', async (t) => {
  const persistence = memoryPersistence();
  const server = await createMatchServer({ port: 0, persistence, noPaceCheck: true });
  t.after(() => server.close());
  const url = `ws://127.0.0.1:${server.port}`;

  const a = rawClient(url, 'Mark');
  const b = rawClient(url, 'Grifter');
  await Promise.all([a.open, b.open]);
  hello(a, 'Mark'); a.send({ t: 'queue', character: 'analog', mode: 'wager' });
  hello(b, 'Grifter'); b.send({ t: 'queue', character: 'vector', mode: 'wager' });
  const [setupA, setupB] = await Promise.all([a.until<SMatch>('match'), b.until<SMatch>('match')]);

  // The grifter tries to steal MARK's seat with a guessed token.
  const thief = rawClient(url, 'Thief');
  await thief.open;
  hello(thief, 'Thief');
  thief.send({ t: 'resume', matchId: setupA.matchId, token: 'not-the-token' });
  const err = await thief.until<Extract<ServerMsg, { t: 'error' }>>('error');
  assert.match(err.msg, /gone or already settled/);
  thief.close();

  // Settle the match (double forfeit → no contest), then try a LEGIT token.
  a.close();
  b.close();
  await new Promise((r) => setTimeout(r, 22_000)); // grace passes, match settles

  const late = rawClient(url, 'Mark');
  await late.open;
  hello(late, 'Mark');
  late.send({ t: 'resume', matchId: setupB.matchId, token: setupB.resume });
  const err2 = await late.until<Extract<ServerMsg, { t: 'error' }>>('error');
  assert.match(err2.msg, /gone or already settled/);
  late.close();
});
