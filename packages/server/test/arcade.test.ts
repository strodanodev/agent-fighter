/**
 * AGENT ARCADE (protocol v4) — the ranked gauntlet.
 *
 * The economy under test: ONE ARCADE_FEE credit buys ONE RUN. The fee
 * escrows with battle 1 and is consumed by playing; battles 2+ are free.
 * Credits move only at the ⅓/⅔ milestones and the full clear; every battle
 * settles ranked XP/W-L. A loss kills the run token; tokens are pinned to
 * the account and the locked fighter.
 *
 * The tests exploit the local-sim trust model honestly: the ledger is the
 * truth, so a test can sim battles OFFLINE first (retrying player-AI seeds
 * until it finds a winning line) and then submit exactly that ledger — the
 * server's re-sim reaches the same outcome deterministically.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import {
  ENGINE_VERSION, Phase, aiPoll, createAi, createGameState, loadCharacter,
  setCharacters, step,
} from '@af/core';
import type { CharacterBundle } from '@af/core';
import {
  ARCADE_CLEAR_CREDITS, ARCADE_FEE, DAILY_CREDITS,
  memoryPersistence,
} from '../src/persist.js';
import { arcadeWinPayout, createMatchServer } from '../src/server.js';
import { PROTOCOL_VERSION } from '../src/protocol.js';
import type { SMatch, ServerMsg } from '../src/protocol.js';

const here = dirname(fileURLToPath(import.meta.url));
const charactersDir = join(here, '..', '..', '..', 'characters');

const bundleOf = (id: string): CharacterBundle =>
  JSON.parse(readFileSync(join(charactersDir, id, 'character.json'), 'utf8')) as CharacterBundle;

/** The playable roster, exactly as the server computes it (meta.disabled). */
const enabledIds = (): string[] =>
  readdirSync(charactersDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(charactersDir, d.name, 'character.json')))
    .map((d) => d.name)
    .filter((id) => !(bundleOf(id) as { meta?: { disabled?: boolean } }).meta?.disabled);

/** Protocol client with a CONSUMING message queue — multi-battle safe. */
const arcadeClient = (url: string, name: string) => {
  const ws = new WebSocket(url);
  const queued: ServerMsg[] = [];
  const waiters: Array<{ t: string; go: (m: ServerMsg) => void }> = [];
  ws.on('message', (d) => {
    const m = JSON.parse(String(d)) as ServerMsg;
    const i = waiters.findIndex((w) => w.t === m.t);
    if (i >= 0) waiters.splice(i, 1)[0]!.go(m);
    else queued.push(m);
  });
  const next = <T extends ServerMsg>(t: T['t'], ms = 30_000): Promise<T> => {
    const i = queued.findIndex((m) => m.t === t);
    if (i >= 0) return Promise.resolve(queued.splice(i, 1)[0] as T);
    return new Promise((res, rej) => {
      const to = setTimeout(() => rej(new Error(`timeout waiting for "${t}" (${name})`)), ms);
      waiters.push({ t, go: (m) => { clearTimeout(to); res(m as T); } });
    });
  };
  const send = (m: unknown): void => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)); };
  const ready = new Promise<void>((res) => ws.on('open', () => {
    send({ t: 'hello', v: PROTOCOL_VERSION, name, engine: ENGINE_VERSION });
    res();
  }));
  return { ws, next, send, ready, close: () => ws.close() };
};

/** Sim one battle offline: my policy AI vs the pinned house AI. */
const simBattle = (
  setup: SMatch, mySkill: number, mySeed: number,
): { winner: number; inputs: number[] } => {
  setCharacters(loadCharacter(bundleOf(setup.chars[0].id)), loadCharacter(bundleOf(setup.chars[1].id)));
  // Sim with the SAME per-stage playfield bounds the server verifies against
  // (protocol SMatch.bounds → createGameState(seed, bounds)): omitting them
  // would search for a winning line against default walls that then won't
  // reproduce on the server for a view-locked stage. This is setup PARITY, not
  // the old "flaky since af-core-6" symptom — that flake was the realtime idle
  // sweep settling this offline-sim match as a no-contest while winningLine ran
  // (fixed server-side: noPaceCheck now relaxes the idle window, server.ts).
  const g = createGameState(setup.seed, setup.bounds);
  // Build the house AI from the FULL pin — including the curated arcade
  // personality (SMatch.solo.personality) — exactly as the real client does.
  // Omitting it re-samples a random personality from the seed, whose ledger
  // then won't reproduce on the server's re-sim (false deviator / wrong winner).
  const house = createAi(1, setup.solo!.skill, setup.solo!.aiSeed, setup.solo!.personality);
  const me = mySkill >= 0 ? createAi(0, mySkill, mySeed) : null;
  const inputs: number[] = [];
  while (g.phase !== Phase.MatchOver && inputs.length < 60 * 60 * 10) {
    const my = me ? aiPoll(me, g) : 0; // null policy = idle punching bag
    const opp = aiPoll(house, g); // aiPoll BEFORE step — verifier ordering
    inputs.push(my);
    step(g, [my, opp]);
  }
  return { winner: g.winner, inputs };
};

/** Find a WINNING ledger (the truth model makes this legitimate: the server
 * re-sims whatever inputs we commit — we just pick a line that wins). */
const winningLine = (setup: SMatch): number[] => {
  for (let salt = 1; salt <= 12; salt++) {
    const r = simBattle(setup, 100, salt * 977);
    if (r.winner === 0) return r.inputs;
  }
  throw new Error(`no winning line found vs skill ${setup.solo!.skill}`);
};

const submit = (c: ReturnType<typeof arcadeClient>, inputs: number[]): void => {
  inputs.forEach((v, k) => c.send({ t: 'i', k, v }));
  c.send({ t: 'over', k: inputs.length });
};

test('ARCADE RUN: one entry fee, milestone + clear payouts, ranked W per battle', async (t) => {
  const persistence = memoryPersistence();
  // Skill 0 house + skill 100 policy → winning lines are found immediately.
  const server = await createMatchServer({ port: 0, persistence, noPaceCheck: true, arcadeSkill: () => 0 });
  t.after(() => server.close());

  const enabled = enabledIds();
  const player = enabled[0]!;
  const total = enabled.filter((id) => id !== player).length;
  assert.ok(total >= 3, `need ≥3 enabled opponents for milestones (got ${total})`);

  const c = arcadeClient(`ws://127.0.0.1:${server.port}`, 'Gauntlet');
  await c.ready;
  c.send({ t: 'queue', character: player, mode: 'arcade' });

  let token = '';
  const seenOpponents = new Set<string>();
  for (let b = 0; b < total; b++) {
    const setup = await c.next<SMatch>('match');
    assert.equal(setup.mode, 'arcade');
    assert.equal(setup.arcade!.battle, b, 'server owns the battle index');
    assert.equal(setup.arcade!.total, total);
    assert.equal(setup.fee, b === 0 ? ARCADE_FEE : 0, 'one fee buys the whole run');
    assert.equal(setup.chars[0].id, player, 'fighter locked for the run');
    assert.ok(setup.chars[1].id !== player, 'no mirror in a full roster');
    assert.ok(!seenOpponents.has(setup.chars[1].id), 'each agent appears once');
    seenOpponents.add(setup.chars[1].id);
    token = setup.arcade!.token;

    submit(c, winningLine(setup));
    const res = await c.next<Extract<ServerMsg, { t: 'result' }>>('result');
    assert.equal(res.reason, 'verified');
    assert.equal(res.winner, 0);
    const xp = await c.next<Extract<ServerMsg, { t: 'xp' }>>('xp');
    assert.equal(xp.gained, 60, 'every battle pays ranked XP');
    // ADR 0007 credits rework: +1 EVERY win (+ clear bonus on the last),
    // minus the legacy battle-1 escrow on this old-client path.
    const expected = arcadeWinPayout(b + 1, total) - (b === 0 ? ARCADE_FEE : 0);
    assert.equal(xp.creditsDelta, expected, `battle ${b + 1} creditsDelta`);

    if (b + 1 < total) c.send({ t: 'queue', character: player, mode: 'arcade', runToken: token });
  }

  const acc = await persistence.getAccount({ sub: 'dev:Gauntlet' }, 'Gauntlet', false);
  assert.equal(acc.wins, total, 'every battle books a ranked W');
  assert.equal(acc.losses, 0);
  assert.equal(
    acc.credits,
    DAILY_CREDITS - ARCADE_FEE + total + ARCADE_CLEAR_CREDITS,
    'net = daily − entry + one credit per win + clear bonus',
  );

  // The cleared run's token is spent — no free re-entry.
  c.send({ t: 'queue', character: player, mode: 'arcade', runToken: token });
  const err = await c.next<Extract<ServerMsg, { t: 'error' }>>('error');
  assert.match(err.msg, /over/i);
  c.close();
});

test('PRE-PAID ENTRY (ADR 0007): /arcade/enter debits upfront, battle 1 is fee-free, a loss refunds NOTHING', async (t) => {
  const persistence = memoryPersistence();
  // Battle 1 vs skill 0 (winning lines found immediately); battle 2 vs
  // skill 80 (an idle player is guaranteed to LOSE, not draw out the clock).
  const server = await createMatchServer({
    port: 0, persistence, noPaceCheck: true,
    arcadeSkill: (battle) => (battle === 0 ? 0 : 80),
  });
  t.after(() => server.close());
  const http = `http://localhost:${server.port}`;
  const H = { 'X-Dev-Name': 'Prepaid', 'Content-Type': 'application/json' };

  await fetch(`${http}/me`, { headers: H }); // profile + daily 10

  // Entry is debited BEFORE any battle — and the nonce makes retries safe.
  const enter = await fetch(`${http}/arcade/enter`, {
    method: 'POST', headers: H, body: JSON.stringify({ nonce: 'entry-001' }),
  });
  assert.equal(enter.status, 200);
  const e1 = await enter.json() as { token: string; credits: number };
  assert.equal(e1.credits, DAILY_CREDITS - ARCADE_FEE, 'charged at enter, not at battle 1');

  const replay = await fetch(`${http}/arcade/enter`, {
    method: 'POST', headers: H, body: JSON.stringify({ nonce: 'entry-001' }),
  });
  const e2 = await (replay.json() as Promise<{ token: string; credits: number }>);
  assert.equal(e2.credits, DAILY_CREDITS - ARCADE_FEE, 'replayed nonce charges nothing');

  // Broke wallet: a fresh account with 0 credits gets a clean 402.
  const brokeH = { 'X-Dev-Name': 'BrokeEntry', 'Content-Type': 'application/json' };
  await fetch(`${http}/me`, { headers: brokeH });
  const acctB = await persistence.getAccount({ sub: 'dev:BrokeEntry' }, 'BrokeEntry', false);
  await persistence.debitCredits('dev:BrokeEntry', acctB.credits, 'test', 'drain'); // drain to 0
  const broke = await fetch(`${http}/arcade/enter`, {
    method: 'POST', headers: brokeH, body: JSON.stringify({ nonce: 'entry-poor' }),
  });
  assert.equal(broke.status, 402);

  // First battle queues WITH the token: the fighter locks now, fee is 0.
  const player = enabledIds()[0]!;
  const c = arcadeClient(`ws://127.0.0.1:${server.port}`, 'Prepaid');
  await c.ready;
  c.send({ t: 'queue', character: player, mode: 'arcade', runToken: e1.token });
  const setup = await c.next<SMatch>('match');
  assert.equal(setup.fee, 0, 'pre-paid run: battle 1 carries NO fee');
  assert.equal(setup.arcade!.battle, 0);
  assert.equal(setup.chars[0].id, player, 'fighter locked at first queue');

  // Win battle 1 → +1 credit, clean (no fee riding the settlement).
  submit(c, winningLine(setup));
  const res = await c.next<Extract<ServerMsg, { t: 'result' }>>('result');
  assert.equal(res.winner, 0);
  const xp = await c.next<Extract<ServerMsg, { t: 'xp' }>>('xp');
  assert.equal(xp.creditsDelta, 1, 'every arcade win pays +1');

  // LOSE battle 2 → run dead, and the pre-paid entry is NOT refunded.
  c.send({ t: 'queue', character: player, mode: 'arcade', runToken: setup.arcade!.token });
  const setup2 = await c.next<SMatch>('match');
  const lost = simBattle(setup2, -1, 0); // idle punching bag vs the house
  submit(c, lost.inputs);
  const res2 = await c.next<Extract<ServerMsg, { t: 'result' }>>('result');
  assert.equal(res2.winner, 1, 'the house wins');
  await c.next<Extract<ServerMsg, { t: 'xp' }>>('xp');
  const acc = await persistence.getAccount({ sub: 'dev:Prepaid' }, 'Prepaid', false);
  assert.equal(acc.credits, DAILY_CREDITS - ARCADE_FEE + 1,
    'entry stays spent on a loss — only the battle-1 win credit remains');
  c.close();
});

test('ARCADE LOSS: run dies, entry burned, −15 XP, token unusable', async (t) => {
  const persistence = memoryPersistence();
  const server = await createMatchServer({ port: 0, persistence, noPaceCheck: true, arcadeSkill: () => 80 });
  t.after(() => server.close());

  const player = enabledIds()[0]!;
  const c = arcadeClient(`ws://127.0.0.1:${server.port}`, 'OneAndDone');
  await c.ready;
  c.send({ t: 'queue', character: player, mode: 'arcade' });
  const setup = await c.next<SMatch>('match');
  const token = setup.arcade!.token;

  // An idle player vs a skill-80 house is a guaranteed KO — a real loss.
  const { winner, inputs } = simBattle(setup, -1, 0);
  assert.equal(winner, 1, 'the house must win this one');
  submit(c, inputs);
  const res = await c.next<Extract<ServerMsg, { t: 'result' }>>('result');
  assert.equal(res.reason, 'verified');
  assert.equal(res.winner, 1);
  const xp = await c.next<Extract<ServerMsg, { t: 'xp' }>>('xp');
  assert.equal(xp.creditsDelta, -ARCADE_FEE, 'the run entry is burned');
  assert.equal(xp.gained, -15, 'arcade losses burn XP like ranked solo');

  c.send({ t: 'queue', character: player, mode: 'arcade', runToken: token });
  const err = await c.next<Extract<ServerMsg, { t: 'error' }>>('error');
  assert.match(err.msg, /over/i);

  const acc = await persistence.getAccount({ sub: 'dev:OneAndDone' }, 'OneAndDone', false);
  assert.equal(acc.losses, 1);
  assert.equal(acc.credits, DAILY_CREDITS - ARCADE_FEE);
  c.close();
});

test('ARCADE TOKEN ABUSE: wrong account and fighter swaps are rejected', async (t) => {
  const persistence = memoryPersistence();
  const server = await createMatchServer({ port: 0, persistence, noPaceCheck: true, arcadeSkill: () => 0 });
  t.after(() => server.close());
  const url = `ws://127.0.0.1:${server.port}`;

  const enabled = enabledIds();
  const player = enabled[0]!;
  const other = enabled[1]!;

  const a = arcadeClient(url, 'Owner');
  await a.ready;
  a.send({ t: 'queue', character: player, mode: 'arcade' });
  const setup = await a.next<SMatch>('match');
  const token = setup.arcade!.token;
  submit(a, winningLine(setup));
  await a.next('result');
  await a.next('xp');

  // Another ACCOUNT cannot ride the token.
  const b = arcadeClient(url, 'Thief');
  await b.ready;
  b.send({ t: 'queue', character: player, mode: 'arcade', runToken: token });
  const stolen = await b.next<Extract<ServerMsg, { t: 'error' }>>('error');
  assert.match(stolen.msg, /not your/i);
  b.close();

  // The owner cannot SWITCH FIGHTERS mid-run.
  a.send({ t: 'queue', character: other, mode: 'arcade', runToken: token });
  const swapped = await a.next<Extract<ServerMsg, { t: 'error' }>>('error');
  assert.match(swapped.msg, /locked/i);

  // With the locked fighter, the run continues into battle 2.
  a.send({ t: 'queue', character: player, mode: 'arcade', runToken: token });
  const b2 = await a.next<SMatch>('match');
  assert.equal(b2.arcade!.battle, 1);
  assert.equal(b2.fee, 0);
  a.close();
});
