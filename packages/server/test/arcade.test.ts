/**
 * AGENT ARCADE v2 — the gauntlet map (protocol v7, ADR 0008).
 *
 * The economy under test, in one sentence: **fighting is the cost and the
 * board is the earning.** One ARCADE_FEE credit buys one RUN; wins pay XP
 * and NOTHING else; credits come only from pickups banked by reaching an
 * exit alive; dying forfeits everything carried.
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
  ENGINE_VERSION, EXIT_BONUS, EXIT_FIGHT_FLOOR, Phase, aiPoll, createAi,
  createGameState, exitNodes, generateBoard, isFightNode, loadCharacter,
  minFights, nodeById, pathTo, predecessors, setCharacters, step, successors,
  templateIds, topoOrder, validateBoard,
} from '@af/core';
import type { Board, CharacterBundle } from '@af/core';
import { ARCADE_FEE, DAILY_CREDITS, memoryPersistence } from '../src/persist.js';
import { createMatchServer } from '../src/server.js';
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
  // (protocol SMatch.bounds → createGameState(seed, bounds)) and the SAME
  // pinned personality (SMatch.solo.personality) — anything less re-samples a
  // different opponent whose ledger won't reproduce on the server's re-sim.
  const g = createGameState(setup.seed, setup.bounds);
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

interface RunState {
  token: string; character: string; board: Board; at: number;
  fights: number; total: number;
  bag: { credits: number; drinks: { itemId: string; tier: number }[] };
  awaitingNext: boolean; extracted: boolean;
}

/** Open a paid run and lock a fighter — the real client's title→select flow. */
const openRun = async (
  http: string, H: Record<string, string>, character: string, nonce: string,
): Promise<RunState> => {
  const enter = await fetch(`${http}/arcade/enter`, {
    method: 'POST', headers: H, body: JSON.stringify({ nonce }),
  });
  assert.equal(enter.status, 200, `entry failed: ${await enter.clone().text()}`);
  const { token } = await enter.json() as { token: string };
  const res = await fetch(`${http}/arcade/run`, {
    method: 'POST', headers: H, body: JSON.stringify({ token, character }),
  });
  assert.equal(res.status, 200, `lock failed: ${await res.clone().text()}`);
  return await res.json() as RunState;
};

const runState = async (http: string, H: Record<string, string>, token: string): Promise<RunState> => {
  const res = await fetch(`${http}/arcade/run`, {
    method: 'POST', headers: H, body: JSON.stringify({ token }),
  });
  return await res.json() as RunState;
};

/**
 * Play one fight: queue the chosen node, submit a winning ledger, drain the
 * result + xp. Returns the setup so callers can assert on it.
 */
const winFight = async (
  c: ReturnType<typeof arcadeClient>, character: string, token: string, node: number,
): Promise<{ setup: SMatch; xp: Extract<ServerMsg, { t: 'xp' }> }> => {
  c.send({ t: 'queue', character, mode: 'arcade', runToken: token, arcadeNode: node });
  const setup = await c.next<SMatch>('match');
  submit(c, winningLine(setup));
  const res = await c.next<Extract<ServerMsg, { t: 'result' }>>('result');
  assert.equal(res.reason, 'verified');
  assert.equal(res.winner, 0, 'the submitted ledger wins');
  const xp = await c.next<Extract<ServerMsg, { t: 'xp' }>>('xp');
  return { setup, xp };
};

// ---------------------------------------------------------------- the board

test('BOARD TEMPLATES: every authored skeleton honours the 2/4/7 contract', () => {
  const roster = enabledIds();
  assert.ok(templateIds().length >= 6, 'a handful of skeletons, not one');
  for (const id of templateIds()) {
    // Several seeds each: the shuffle must not be able to break the shape.
    for (const seed of [1, 7, 99, 12345, 88888]) {
      const b = generateBoard({ roster, templateId: id, seed });
      assert.deepEqual(validateBoard(b), [], `${id} @ ${seed}`);
      assert.ok(topoOrder(b), `${id} is a DAG`);

      for (const tier of [1, 2, 3] as const) {
        const exit = exitNodes(b).find((e) => e.exitTier === tier)!;
        assert.ok(exit, `${id} has a tier-${tier} exit`);
        assert.equal(
          minFights(b, b.start, exit.id), EXIT_FIGHT_FLOOR[tier],
          `${id} @ ${seed}: exit ${tier} sits at exactly its fight floor`,
        );
      }

      // THE rule the whole mode rests on: no pickup without a fight in front
      // of it. If this ever passes, the board is a credit printer.
      for (const n of b.nodes) {
        if (n.kind !== 'loot') continue;
        const preds = predecessors(b, n.id).map((p) => nodeById(b, p)!);
        assert.ok(preds.length > 0, `loot ${n.id} is reachable`);
        assert.ok(preds.every(isFightNode), `loot ${n.id} in ${id} is GUARDED`);
      }
    }
  }
});

test('BOARD ROUTES: the fastest line is never the richest line', () => {
  const roster = enabledIds();
  for (const id of templateIds()) {
    const b = generateBoard({ roster, templateId: id, seed: 4242 });
    const deep = exitNodes(b).find((e) => e.exitTier === 3)!;
    const fastest = pathTo(b, b.start, deep.id).map((n) => nodeById(b, n)!);
    // The cheapest route to the deep exit is the pure SPINE: all fights, no
    // pickups. Greed has to cost fights, or greed is free.
    assert.equal(
      fastest.filter((n) => n.kind === 'loot').length, 0,
      `${id}: the cheapest deep line collects nothing`,
    );
    assert.equal(fastest.filter(isFightNode).length, EXIT_FIGHT_FLOOR[3]);
    // …but the board is worth something to a player willing to detour.
    assert.ok(
      b.nodes.some((n) => n.kind === 'loot'),
      `${id}: there is loot to detour for`,
    );
  }
});

test('BOARD REPRODUCIBILITY: (template, seed) rebuilds the exact same board', () => {
  const roster = enabledIds();
  const a = generateBoard({ roster, templateId: 'deep-vault', seed: 31337 });
  const b = generateBoard({ roster, templateId: 'deep-vault', seed: 31337 });
  assert.deepEqual(a, b, 'a support question can rebuild the run a player saw');
});

// ------------------------------------------------------------------- the run

test('ARCADE RUN: entry is paid once, wins pay XP ONLY, extraction banks the bag', async (t) => {
  const persistence = memoryPersistence();
  // Skill 0 house → winning lines are found on the first salt.
  const server = await createMatchServer({ port: 0, persistence, noPaceCheck: true, arcadeSkill: () => 0 });
  t.after(() => server.close());
  const http = `http://localhost:${server.port}`;
  const H = { 'X-Dev-Name': 'Runner', 'Content-Type': 'application/json' };
  await fetch(`${http}/me`, { headers: H }); // profile + daily 10

  const player = enabledIds()[0]!;
  let state = await openRun(http, H, player, 'arcade-run-001');
  assert.equal(state.character, player, 'fighter locks at /arcade/run');
  assert.equal(state.at, state.board.start);
  assert.equal(state.bag.credits, 0);

  const acctAfterEntry = await persistence.getAccount({ sub: 'dev:Runner' }, 'Runner', false);
  assert.equal(acctAfterEntry.credits, DAILY_CREDITS - ARCADE_FEE, 'charged up front');

  // Walk the CHEAPEST line to the shallow exit — 2 fights, no pickups.
  const exit1 = exitNodes(state.board).find((e) => e.exitTier === 1)!;
  const c = arcadeClient(`ws://127.0.0.1:${server.port}`, 'Runner');
  await c.ready;

  let fought = 0;
  for (;;) {
    state = await runState(http, H, state.token);
    if (successors(state.board, state.at).includes(exit1.id)) break;
    const next = pathTo(state.board, state.at, exit1.id)
      .map((n) => nodeById(state.board, n)!)
      .find(isFightNode)!;
    const { setup, xp } = await winFight(c, player, state.token, next.id);
    fought++;
    assert.equal(setup.fee, 0, 'battles are free — the entry was the price');
    assert.equal(setup.chars[0].id, player, 'fighter locked for the run');
    assert.equal(xp.gained, 60, 'every win pays ranked XP');
    assert.equal(xp.creditsDelta, 0, 'A WIN PAYS NO CREDITS — the board pays');
    assert.ok(fought <= EXIT_FIGHT_FLOOR[1], 'no more fights than the floor');
  }
  assert.equal(fought, EXIT_FIGHT_FLOOR[1], 'shallow exit cost exactly 2 fights');

  // Extract. First run of the day → the full 100%.
  const out = await fetch(`${http}/arcade/extract`, {
    method: 'POST', headers: H, body: JSON.stringify({ token: state.token, node: exit1.id }),
  });
  assert.equal(out.status, 200);
  const banked = await out.json() as {
    exitTier: number; bonus: number; granted: number; multiplierPct: number; credits: number;
  };
  assert.equal(banked.exitTier, 1);
  assert.equal(banked.bonus, EXIT_BONUS[1]);
  assert.equal(banked.multiplierPct, 100, 'first run of the day pays full');
  assert.equal(banked.granted, EXIT_BONUS[1], 'spine-only run banks the base bonus');

  const acc = await persistence.getAccount({ sub: 'dev:Runner' }, 'Runner', false);
  assert.equal(acc.wins, EXIT_FIGHT_FLOOR[1], 'each battle books a ranked W');
  assert.equal(acc.losses, 0);
  assert.equal(acc.credits, DAILY_CREDITS - ARCADE_FEE + EXIT_BONUS[1]);

  // The extracted run is spent — no free re-entry, no double payout.
  const replay = await fetch(`${http}/arcade/extract`, {
    method: 'POST', headers: H, body: JSON.stringify({ token: state.token, node: exit1.id }),
  });
  assert.equal(replay.status, 404, 'the run is gone once it extracts');
  c.close();
});

test('GREED: a spur costs one extra fight and pays out on extraction', async (t) => {
  const persistence = memoryPersistence();
  const server = await createMatchServer({ port: 0, persistence, noPaceCheck: true, arcadeSkill: () => 0 });
  t.after(() => server.close());
  const http = `http://localhost:${server.port}`;
  const H = { 'X-Dev-Name': 'Greedy', 'Content-Type': 'application/json' };
  await fetch(`${http}/me`, { headers: H });

  const player = enabledIds()[0]!;
  let state = await openRun(http, H, player, 'greed-001');
  const c = arcadeClient(`ws://127.0.0.1:${server.port}`, 'Greedy');
  await c.ready;

  // Find a spur off the start: a fight whose only successor carries credits.
  const board = state.board;
  const spur = successors(board, state.at)
    .map((id) => nodeById(board, id)!)
    .find((n) => {
      if (!isFightNode(n)) return false;
      const outs = successors(board, n.id).map((o) => nodeById(board, o)!);
      return outs.length === 1 && outs[0]!.loot?.kind === 'credits';
    });
  if (!spur) return c.close(); // this seed's template has no start-adjacent spur

  const pile = nodeById(board, successors(board, spur.id)[0]!)!;
  const worth = pile.loot && pile.loot.kind === 'credits' ? pile.loot.amount : 0;
  assert.ok(worth > 0);

  await winFight(c, player, state.token, spur.id);
  state = await runState(http, H, state.token);
  // AUTO-COLLECT: winning the guard sweeps up the pickup behind it, with no
  // second round trip that a dropped request could lose.
  assert.equal(state.at, pile.id, 'the run walked onto the pickup by itself');
  assert.equal(state.bag.credits, worth, 'the pile is in the bag, UNBANKED');
  assert.equal(state.fights, 1);

  const acc = await persistence.getAccount({ sub: 'dev:Greedy' }, 'Greedy', false);
  assert.equal(acc.credits, DAILY_CREDITS - ARCADE_FEE,
    'nothing is banked until extraction — the bag is not money yet');
  c.close();
});

test('WIPE: losing forfeits the whole bag and kills the run', async (t) => {
  const persistence = memoryPersistence();
  // Fight 1 vs skill 0 (win + collect), fight 2 vs skill 80 (idle = a real KO).
  const server = await createMatchServer({
    port: 0, persistence, noPaceCheck: true,
    arcadeSkill: (fights) => (fights === 0 ? 0 : 80),
  });
  t.after(() => server.close());
  const http = `http://localhost:${server.port}`;
  const H = { 'X-Dev-Name': 'Wiped', 'Content-Type': 'application/json' };
  await fetch(`${http}/me`, { headers: H });

  const player = enabledIds()[0]!;
  let state = await openRun(http, H, player, 'wipe-001');
  const c = arcadeClient(`ws://127.0.0.1:${server.port}`, 'Wiped');
  await c.ready;

  // Win one fight to get SOMETHING in the bag (a spur if this board has one
  // off the start, otherwise the spine — either way the run is alive).
  const first = successors(state.board, state.at)
    .map((id) => nodeById(state.board, id)!)
    .find(isFightNode)!;
  const { xp: xp1 } = await winFight(c, player, state.token, first.id);
  assert.equal(xp1.creditsDelta, 0);
  state = await runState(http, H, state.token);
  const carried = state.bag.credits;

  // Now lose. An idle player vs a skill-80 house is a guaranteed KO.
  const next = successors(state.board, state.at)
    .map((id) => nodeById(state.board, id)!)
    .find(isFightNode)!;
  c.send({ t: 'queue', character: player, mode: 'arcade', runToken: state.token, arcadeNode: next.id });
  const setup = await c.next<SMatch>('match');
  const lost = simBattle(setup, -1, 0);
  assert.equal(lost.winner, 1, 'the house must win this one');
  submit(c, lost.inputs);
  const res = await c.next<Extract<ServerMsg, { t: 'result' }>>('result');
  assert.equal(res.winner, 1);
  const xp2 = await c.next<Extract<ServerMsg, { t: 'xp' }>>('xp');
  assert.equal(xp2.gained, -15, 'arcade losses burn XP like ranked solo');
  assert.equal(xp2.creditsDelta, 0, 'nothing to lose at settlement — the bag was never banked');

  // The run and everything in it are gone.
  const gone = await fetch(`${http}/arcade/run`, {
    method: 'POST', headers: H, body: JSON.stringify({ token: state.token }),
  });
  assert.equal(gone.status, 404, 'the run token died with the run');

  const acc = await persistence.getAccount({ sub: 'dev:Wiped' }, 'Wiped', false);
  assert.equal(acc.losses, 1);
  assert.equal(acc.credits, DAILY_CREDITS - ARCADE_FEE,
    `the ${carried} CR in the bag evaporated and the entry stays spent`);
  c.close();
});

test('MOVE LEGALITY: you can only fight what you can reach, and only fights', async (t) => {
  const persistence = memoryPersistence();
  const server = await createMatchServer({ port: 0, persistence, noPaceCheck: true, arcadeSkill: () => 0 });
  t.after(() => server.close());
  const http = `http://localhost:${server.port}`;
  const H = { 'X-Dev-Name': 'Cheat', 'Content-Type': 'application/json' };
  await fetch(`${http}/me`, { headers: H });

  const player = enabledIds()[0]!;
  const state = await openRun(http, H, player, 'legal-001');
  const board = state.board;
  const c = arcadeClient(`ws://127.0.0.1:${server.port}`, 'Cheat');
  await c.ready;

  // Teleporting to the boss (the richest node, 7 fights deep) is the obvious
  // attack on this design — it must bounce off the server's own board.
  const boss = board.nodes.find((n) => n.kind === 'boss')!;
  c.send({ t: 'queue', character: player, mode: 'arcade', runToken: state.token, arcadeNode: boss.id });
  const jump = await c.next<Extract<ServerMsg, { t: 'error' }>>('error');
  assert.match(jump.msg, /does not lead anywhere/i);

  // Queueing an EXIT is not a fight — exits go through /arcade/extract.
  const deep = exitNodes(board).find((e) => e.exitTier === 3)!;
  c.send({ t: 'queue', character: player, mode: 'arcade', runToken: state.token, arcadeNode: deep.id });
  const notFight = await c.next<Extract<ServerMsg, { t: 'error' }>>('error');
  assert.match(notFight.msg, /does not lead anywhere|not a fight/i);

  // Extracting from an exit you are not standing next to pays nothing.
  const far = await fetch(`${http}/arcade/extract`, {
    method: 'POST', headers: H, body: JSON.stringify({ token: state.token, node: deep.id }),
  });
  assert.equal(far.status, 400);
  assert.match((await far.json() as { error: string }).error, /no exit from where you are standing/i);

  // Another ACCOUNT cannot ride the token.
  const thief = arcadeClient(`ws://127.0.0.1:${server.port}`, 'Thief');
  await thief.ready;
  const legal = successors(board, state.at).map((id) => nodeById(board, id)!).find(isFightNode)!;
  thief.send({ t: 'queue', character: player, mode: 'arcade', runToken: state.token, arcadeNode: legal.id });
  const stolen = await thief.next<Extract<ServerMsg, { t: 'error' }>>('error');
  assert.match(stolen.msg, /not your/i);
  thief.close();

  // …nor can the owner switch fighters mid-run.
  const other = enabledIds()[1]!;
  c.send({ t: 'queue', character: other, mode: 'arcade', runToken: state.token, arcadeNode: legal.id });
  const swapped = await c.next<Extract<ServerMsg, { t: 'error' }>>('error');
  assert.match(swapped.msg, /locked/i);

  // A legal move still works after all that.
  const { setup } = await winFight(c, player, state.token, legal.id);
  assert.equal(setup.arcade!.node, legal.id, 'the setup names the node being fought');
  assert.equal(setup.arcade!.total, EXIT_FIGHT_FLOOR[3]);
  c.close();
});

test('DIMINISHING RETURNS: the second run of the day banks 75%', async (t) => {
  const persistence = memoryPersistence();
  const server = await createMatchServer({ port: 0, persistence, noPaceCheck: true, arcadeSkill: () => 0 });
  t.after(() => server.close());
  const http = `http://localhost:${server.port}`;
  const H = { 'X-Dev-Name': 'Grinder', 'Content-Type': 'application/json' };
  await fetch(`${http}/me`, { headers: H });

  const player = enabledIds()[0]!;
  const c = arcadeClient(`ws://127.0.0.1:${server.port}`, 'Grinder');
  await c.ready;

  const runToShallowExit = async (nonce: string): Promise<number> => {
    let state = await openRun(http, H, player, nonce);
    const exit1 = exitNodes(state.board).find((e) => e.exitTier === 1)!;
    for (;;) {
      state = await runState(http, H, state.token);
      if (successors(state.board, state.at).includes(exit1.id)) break;
      const next = pathTo(state.board, state.at, exit1.id)
        .map((n) => nodeById(state.board, n)!)
        .find(isFightNode)!;
      await winFight(c, player, state.token, next.id);
    }
    const out = await fetch(`${http}/arcade/extract`, {
      method: 'POST', headers: H, body: JSON.stringify({ token: state.token, node: exit1.id }),
    });
    return (await out.json() as { multiplierPct: number }).multiplierPct;
  };

  assert.equal(await runToShallowExit('dimret-run-1'), 100, 'run 1 of the day');
  assert.equal(await runToShallowExit('dimret-run-2'), 75, 'run 2 tapers');
  assert.equal(await runToShallowExit('dimret-run-3'), 50, 'run 3 tapers further');
  assert.equal(await runToShallowExit('dimret-run-4'), 25, 'and floors at 25%');
  c.close();
});

test('AUTOPILOT: a headless agent with no board sense still walks the deep line', async (t) => {
  // persistence OFF — the no-token path is reserved for players who cannot
  // pay and therefore cannot farm: agent-class accounts and this dev economy.
  const server = await createMatchServer({ port: 0, persistence: null, noPaceCheck: true, arcadeSkill: () => 0 });
  t.after(() => server.close());

  // No token, no node: the server opens a run and routes it. This is exactly
  // what `npm run agent` / `npm run fleet` send.
  const player = enabledIds()[0]!;
  const c = arcadeClient(`ws://127.0.0.1:${server.port}`, 'Headless');
  await c.ready;
  c.send({ t: 'queue', character: player, mode: 'arcade' });

  const first = await c.next<SMatch>('match');
  assert.ok(first.arcade, 'a run was opened for it');
  assert.equal(first.arcade!.fights, 0);
  submit(c, winningLine(first));
  const r1 = await c.next<Extract<ServerMsg, { t: 'result' }>>('result');
  assert.equal(r1.winner, 0);

  // …and the token chains to a SECOND fight without the agent naming a node.
  c.send({ t: 'queue', character: player, mode: 'arcade', runToken: first.arcade!.token });
  const second = await c.next<SMatch>('match');
  assert.equal(second.arcade!.fights, 1, 'the run advanced');
  assert.notEqual(second.arcade!.node, first.arcade!.node, 'onto a different node');
  c.close();
});

test('PAID ENTRY IS THE ONLY DOOR: a real account cannot open a run for free', async (t) => {
  const persistence = memoryPersistence();
  const server = await createMatchServer({ port: 0, persistence, noPaceCheck: true, arcadeSkill: () => 0 });
  t.after(() => server.close());
  const http = `http://localhost:${server.port}`;
  const H = { 'X-Dev-Name': 'Freeloader', 'Content-Type': 'application/json' };
  await fetch(`${http}/me`, { headers: H });

  const c = arcadeClient(`ws://127.0.0.1:${server.port}`, 'Freeloader');
  await c.ready;
  c.send({ t: 'queue', character: enabledIds()[0]!, mode: 'arcade' });
  const err = await c.next<Extract<ServerMsg, { t: 'error' }>>('error');
  assert.match(err.msg, /from the title|paid up front/i);

  // A broke wallet gets a clean 402 at the door rather than a half-open run.
  const acct = await persistence.getAccount({ sub: 'dev:Freeloader' }, 'Freeloader', false);
  await persistence.debitCredits('dev:Freeloader', acct.credits, 'test', 'drain-it-all');
  const broke = await fetch(`${http}/arcade/enter`, {
    method: 'POST', headers: H, body: JSON.stringify({ nonce: 'broke-entry-01' }),
  });
  assert.equal(broke.status, 402);
  c.close();
});

test('ENTRY REPLAY: a retried nonce charges once (dropped response, double tap)', async (t) => {
  const persistence = memoryPersistence();
  const server = await createMatchServer({ port: 0, persistence, noPaceCheck: true });
  t.after(() => server.close());
  const http = `http://localhost:${server.port}`;
  const H = { 'X-Dev-Name': 'Retrier', 'Content-Type': 'application/json' };
  await fetch(`${http}/me`, { headers: H });

  const body = JSON.stringify({ nonce: 'retry-entry-001' });
  const a = await (await fetch(`${http}/arcade/enter`, { method: 'POST', headers: H, body })).json() as { credits: number };
  const b = await (await fetch(`${http}/arcade/enter`, { method: 'POST', headers: H, body })).json() as { credits: number };
  assert.equal(a.credits, DAILY_CREDITS - ARCADE_FEE, 'charged at enter');
  assert.equal(b.credits, DAILY_CREDITS - ARCADE_FEE, 'replayed nonce charges nothing');
});
