/**
 * Disconnect settlement (ADR 0005) — the wagering-abuse surface.
 *
 * The rule under test: THE INPUT LEDGER IS THE TRUTH, and a dropped socket
 * never overrules it. Everything here is about money that must not be
 * mintable or burnable by yanking a cable at the right moment.
 */
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { ENGINE_VERSION } from '@af/core';
import { DAILY_CREDITS, SOLO_FEE, WAGER_FEE, memoryPersistence } from '../src/persist.js';
import { createMatchServer } from '../src/server.js';
import { playOneMatch } from '../src/agent-session.js';
import { PROTOCOL_VERSION } from '../src/protocol.js';
import type { ServerMsg } from '../src/protocol.js';

const here = dirname(fileURLToPath(import.meta.url));
const charactersDir = join(here, '..', '..', '..', 'characters');

/**
 * Every socket this file opens, so the run can ALWAYS drain them.
 *
 * Each test closes its own sockets on the happy path — but a failed assertion
 * jumps over that `close()`, the socket stays open, and `node --test` then
 * never exits. The suite doesn't report a failure, it HANGS: no tally, no
 * diagnostic, process idle-alive. That has now eaten a full verify run and,
 * worse, the failure detail with it. A blanket drain makes a failing test
 * fail loudly instead of silently wedging the runner.
 */
const openSockets: WebSocket[] = [];
after(() => {
  for (const ws of openSockets) {
    try { ws.close(); } catch { /* already gone — draining is best-effort */ }
  }
});

/**
 * Wait for the SETTLEMENT to land rather than sleeping and hoping.
 *
 * Persistence is fire-and-forget on purpose (server.ts: `void
 * persistence.recordMatch(...)` — progression must never delay a verdict), so
 * a fixed sleep here is a race that only loses on a loaded machine. It did:
 * RAGEQUIT passed alone and failed inside a full parallel run. Polling makes
 * these assertions depend on the outcome, not on the CPU.
 */
const settledAccount = async <T>(
  read: () => Promise<T>, done: (v: T) => boolean, ms = 5_000,
): Promise<T> => {
  const deadline = Date.now() + ms;
  let last = await read();
  while (!done(last) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
    last = await read();
  }
  return last;
};

/** A raw protocol client — lets a test misbehave in ways the real one can't. */
const rawClient = (url: string, name: string, mode: 'wager' | 'solo') => {
  const ws = new WebSocket(url);
  openSockets.push(ws);
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

test('LEDGER TRUTH: winning then dropping still WINS (no cable-pull escape either way)', async (t) => {
  const persistence = memoryPersistence();
  const server = await createMatchServer({ port: 0, persistence, noPaceCheck: true });
  t.after(() => server.close());
  const url = `ws://127.0.0.1:${server.port}`;

  // Play a full solo match but NEVER send 'over', then drop the socket. The
  // ledger already contains the KO, so the server must settle it verified —
  // not punish the dropped side.
  const c = rawClient(url, 'Ghoster', 'solo');
  await c.ready;
  const setup = await c.until<Extract<ServerMsg, { t: 'match' }>>('match');
  assert.equal(setup.mode, 'solo');

  // Feed a decided match: the AI at skill 3 will KO an idle player eventually.
  for (let k = 0; k < 60 * 60 * 4; k++) c.send({ t: 'i', k, v: 0 });
  await new Promise((r) => setTimeout(r, 600));
  c.close(); // drop WITHOUT reporting 'over'

  // Grace (20s) then settlement. Poll rather than sleep-and-hope: the write
  // is fire-and-forget, so a fixed wait is a race on a loaded machine.
  const acc = await settledAccount(
    () => persistence.getAccount({ sub: 'dev:Ghoster' }, 'Ghoster', false),
    (a) => a.wins + a.losses === 1,
    30_000);
  // Decided by the ledger → a real W/L was booked, not a refund-y no-contest.
  assert.equal(acc.wins + acc.losses, 1, 'ledger-decided match must book a result');
});

test('RAGEQUIT: dropping an UNDECIDED wager loses it; the stayer mints the ticket', async (t) => {
  const persistence = memoryPersistence();
  const server = await createMatchServer({ port: 0, persistence, noPaceCheck: true });
  t.after(() => server.close());
  const url = `ws://127.0.0.1:${server.port}`;

  const quitter = rawClient(url, 'Quitter', 'wager');
  const stayer = rawClient(url, 'Stayer', 'wager');
  await Promise.all([quitter.ready, stayer.ready]);
  await Promise.all([quitter.until('match'), stayer.until('match')]);

  // A few neutral ticks each — nowhere near a decision — then the quitter bails.
  for (let k = 0; k < 30; k++) { quitter.send({ t: 'i', k, v: 0 }); stayer.send({ t: 'i', k, v: 0 }); }
  await new Promise((r) => setTimeout(r, 300));
  quitter.close();

  const res = await stayer.until<Extract<ServerMsg, { t: 'result' }>>('result', 30_000);
  assert.equal(res.reason, 'forfeit');

  const s = await settledAccount(
    () => persistence.getAccount({ sub: 'dev:Stayer' }, 'Stayer', false),
    (a) => a.wins === 1);
  const q = await settledAccount(
    () => persistence.getAccount({ sub: 'dev:Quitter' }, 'Quitter', false),
    (a) => a.losses === 1);
  // ADR 0009: there is no pot to take. Both entries burn; the deterrent for
  // leaving is the LOSS (and the forfeited ticket), not a credit transfer.
  assert.equal(s.credits, DAILY_CREDITS - WAGER_FEE, 'stayer burns its entry too');
  assert.equal(q.credits, DAILY_CREDITS - WAGER_FEE, 'quitter burns the entry');
  assert.equal(s.tickets, 1, 'a forfeit win is still a win — it mints');
  assert.equal(q.tickets, 0);
  assert.equal(s.wins, 1);
  assert.equal(q.losses, 1);
  stayer.close();
});

test('NO CONTEST: both sides gone on an undecided wager refunds both (never an arbitrary loser)', async (t) => {
  const persistence = memoryPersistence();
  const server = await createMatchServer({ port: 0, persistence, noPaceCheck: true });
  t.after(() => server.close());
  const url = `ws://127.0.0.1:${server.port}`;

  const a = rawClient(url, 'GoneA', 'wager');
  const b = rawClient(url, 'GoneB', 'wager');
  await Promise.all([a.ready, b.ready]);
  await Promise.all([a.until('match'), b.until('match')]);
  for (let k = 0; k < 20; k++) { a.send({ t: 'i', k, v: 0 }); b.send({ t: 'i', k, v: 0 }); }
  await new Promise((r) => setTimeout(r, 200));
  a.close();
  b.close(); // both drop — e.g. a server-side network partition

  const accA = await settledAccount(
    () => persistence.getAccount({ sub: 'dev:GoneA' }, 'GoneA', false),
    (a) => a.credits === DAILY_CREDITS,
    30_000);
  const accB = await settledAccount(
    () => persistence.getAccount({ sub: 'dev:GoneB' }, 'GoneB', false),
    (a) => a.credits === DAILY_CREDITS,
    30_000);
  assert.equal(accA.credits, DAILY_CREDITS, 'A refunded');
  assert.equal(accB.credits, DAILY_CREDITS, 'B refunded');
  assert.equal(accA.wins + accA.losses + accB.wins + accB.losses, 0, 'nobody is charged a loss');
});

test('HEADS-UP: when the opponent drops, the survivor is told immediately (v6 oppgone)', async (t) => {
  const server = await createMatchServer({ port: 0, persistence: memoryPersistence(), noPaceCheck: true });
  t.after(() => server.close());
  const url = `ws://127.0.0.1:${server.port}`;

  const quitter = rawClient(url, 'Dropper', 'wager');
  const stayer = rawClient(url, 'Survivor', 'wager');
  await Promise.all([quitter.ready, stayer.ready]);
  await Promise.all([quitter.until('match'), stayer.until('match')]);
  for (let k = 0; k < 20; k++) { quitter.send({ t: 'i', k, v: 0 }); stayer.send({ t: 'i', k, v: 0 }); }
  await new Promise((r) => setTimeout(r, 150));
  quitter.close();

  // The notice must land WITHOUT waiting out the 20s forfeit grace — that's
  // the whole point (no more silent freeze). It carries the grace to count down.
  const gone = await stayer.until<Extract<ServerMsg, { t: 'oppgone' }>>('oppgone', 4_000);
  assert.ok(gone.graceMs > 0, 'the survivor gets a grace window to render as a countdown');
  stayer.close();
});

test('SOLO IDLE: a silent (backgrounded-tab) player is a no-contest REFUND, not a forfeit loss', async (t) => {
  const persistence = memoryPersistence();
  // Short idle window so the test doesn't wait out the real 30s. The idle
  // sweep itself runs every 5s, so the settle still lands a few seconds in.
  const server = await createMatchServer({ port: 0, persistence, noPaceCheck: true, idleForfeitMs: 500 });
  t.after(() => server.close());
  const url = `ws://127.0.0.1:${server.port}`;

  // Solo, side 1 is the house AI (no socket). Play a few UNDECIDED ticks then
  // go silent WITHOUT closing the socket — exactly what a throttled/hidden tab
  // does (rAF stops firing, the WebSocket stays open). Pre-fix this idle-
  // forfeited the human into a −1 loss even when they were ahead; there is no
  // opponent to grief in PvE, so it must refund instead.
  const c = rawClient(url, 'Backgrounded', 'solo');
  await c.ready;
  await c.until('match');
  for (let k = 0; k < 30; k++) c.send({ t: 'i', k, v: 0 }); // nowhere near a KO
  // ...then nothing. Socket stays open; the idle sweep must settle it.

  const res = await c.until<Extract<ServerMsg, { t: 'result' }>>('result', 15_000);
  assert.equal(res.reason, 'incomplete', 'a silent solo player is a no-contest, not a forfeit');
  assert.equal(res.winner, -1, 'nobody wins an idle solo match');
  await new Promise((r) => setTimeout(r, 400));

  const acc = await persistence.getAccount({ sub: 'dev:Backgrounded' }, 'Backgrounded', false);
  assert.equal(acc.credits, DAILY_CREDITS, 'the entry fee is refunded — no credit burned');
  assert.equal(acc.losses, 0, 'no loss is booked against a backgrounded solo player');
  assert.equal(acc.wins, 0);
  c.close();
});

test('the honest path still settles: a normal solo match pays out', async (t) => {
  const persistence = memoryPersistence();
  const server = await createMatchServer({ port: 0, persistence, noPaceCheck: true });
  t.after(() => server.close());
  const { result } = await playOneMatch({
    url: `ws://127.0.0.1:${server.port}`,
    name: 'Honest', character: 'vector', skill: 80,
    charactersDir, aiSeed: 5, paceMs: 1, mode: 'solo',
  });
  assert.equal(result.reason, 'verified');
  await new Promise((r) => setTimeout(r, 400));
  const acc = await persistence.getAccount({ sub: 'dev:Honest' }, 'Honest', true);
  assert.equal(acc.wins + acc.losses, 1, 'a verified solo match books a W or L');
  // Loss burns the fee (credits stay at DAILY - FEE); win pays out above that.
  // Either outcome is a settle — do not require a win (skill/seed can lose).
  if (result.winner === 0) {
    assert.ok(acc.credits > DAILY_CREDITS - SOLO_FEE, 'solo win pays out');
    assert.equal(acc.wins, 1);
  } else {
    assert.equal(acc.credits, DAILY_CREDITS - SOLO_FEE, 'solo loss burns the fee');
    assert.equal(acc.losses, 1);
  }
});
