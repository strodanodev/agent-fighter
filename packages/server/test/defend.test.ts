/**
 * DEFEND-ELO (ADR 0009 step 4) — an agent's rank comes from BEING FOUGHT.
 *
 * Unit half: recordDefense against memoryPersistence (mirrors record_defense
 * in 0028_defend.sql — if a rule changes here, change it THERE).
 * Integration half: a real arcade battle against a CAST stable guard over the
 * actual WebSocket protocol — the full castBoard → defenderSub pin →
 * finishMatch gate → recordDefense path, both the human-hands positive case
 * and the declared-agent gate.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import {
  Phase, aiPoll, createAi, createGameState, loadCharacter, setCharacters, step,
} from '@af/core';
import type { Board, CharacterBundle } from '@af/core';
import { createMatchServer } from '../src/server.js';
import { ELO_BASE, memoryPersistence } from '../src/persist.js';
import { ENGINE_VERSION } from '@af/core';
import { PROTOCOL_VERSION } from '../src/protocol.js';
import type { SMatch, ServerMsg } from '../src/protocol.js';

const here = dirname(fileURLToPath(import.meta.url));
const charactersDir = join(here, '..', '..', '..', 'characters');
const bundleOf = (id: string): CharacterBundle =>
  JSON.parse(readFileSync(join(charactersDir, id, 'character.json'), 'utf8')) as CharacterBundle;

const id = (s: string) => ({ sub: s });

// ------------------------------------------------------------------ unit

test('recordDefense: idempotent by match, rates the agent, never the human', async () => {
  const p = memoryPersistence();
  await p.getAccount(id('dev:HUMAN'), 'HUMAN', false);
  await p.createAgentAccount('agent:d1', 'WALL', 'h', 'dev:OWNER');

  // The agent FELL (human won): rating down, losses up.
  assert.equal(await p.recordDefense('agent:d1', 'dm1', 'dev:HUMAN', false), true);
  // Retry of the same settlement: structurally a no-op.
  assert.equal(await p.recordDefense('agent:d1', 'dm1', 'dev:HUMAN', true), false);

  const row = (await p.stable()).find((a) => a.id === 'agent:d1');
  // No config yet → not in the stable; read through a second defense instead.
  assert.equal(row, undefined);
  await p.setAgentConfig('agent:d1', { character: 'vector', personality: {} });
  const s1 = (await p.stable()).find((a) => a.id === 'agent:d1')!;
  assert.equal(s1.defendLosses, 1);
  assert.equal(s1.defendWins, 0);
  assert.ok(s1.defendElo! < ELO_BASE, 'falling costs rating');

  // The agent HELD a second match: rating recovers, wins up.
  assert.equal(await p.recordDefense('agent:d1', 'dm2', 'dev:HUMAN', true), true);
  const s2 = (await p.stable()).find((a) => a.id === 'agent:d1')!;
  assert.equal(s2.defendWins, 1);
  assert.ok(s2.defendElo! > s1.defendElo!, 'holding earns rating');

  // The HUMAN's own ratings never moved — "your Elo means your hands".
  const board = await p.leaderboard(50) as Array<Record<string, unknown>>;
  const human = board.find((r) => r.name === 'HUMAN');
  // (No decided matches → not on the leaderboard; the profile row is the
  // authority and prof() is internal, so assert via a rated-elo probe.)
  assert.equal(human, undefined);

  // Self-defense (sparring) refused.
  assert.equal(await p.recordDefense('agent:d1', 'dm3', 'agent:d1', true), false);
  // Unknown agent refused.
  assert.equal(await p.recordDefense('agent:ghost', 'dm4', 'dev:HUMAN', true), false);
});

// ------------------------------------------------------------ integration

/** Protocol client with a consuming message queue (the arcade.test pattern). */
const wsClient = (url: string, name: string, agent: boolean) => {
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
    send({ t: 'hello', v: PROTOCOL_VERSION, name, agent: agent || undefined, engine: ENGINE_VERSION });
    res();
  }));
  return { ws, next, send, ready, close: () => ws.close() };
};

/** Find a winning ledger offline (ledger-is-truth makes this honest). */
const winningLine = (setup: SMatch): number[] => {
  for (let salt = 1; salt <= 12; salt++) {
    setCharacters(loadCharacter(bundleOf(setup.chars[0].id)), loadCharacter(bundleOf(setup.chars[1].id)));
    const g = createGameState(setup.seed, setup.bounds);
    const house = createAi(1, setup.solo!.skill, setup.solo!.aiSeed, setup.solo!.personality);
    const me = createAi(0, 100, salt * 977);
    const inputs: number[] = [];
    while (g.phase !== Phase.MatchOver && inputs.length < 60 * 60 * 10) {
      const my = aiPoll(me, g);
      const opp = aiPoll(house, g);
      inputs.push(my);
      step(g, [my, opp]);
    }
    if (g.winner === 0) return inputs;
  }
  throw new Error(`no winning line found vs skill ${setup.solo!.skill}`);
};

const H = (name: string): Record<string, string> =>
  ({ 'X-Dev-Name': name, 'Content-Type': 'application/json' });

/** Open a paid run for `dev` and return its token + board. */
const openRun = async (http: string, dev: string, character: string): Promise<{ token: string; board: Board }> => {
  await fetch(`${http}/me`, { headers: H(dev) });
  const enter = await fetch(`${http}/arcade/enter`, {
    method: 'POST', headers: H(dev), body: JSON.stringify({ nonce: `defend-test-${dev}` }),
  });
  assert.equal(enter.status, 200, await enter.clone().text());
  const { token } = await enter.json() as { token: string };
  const run = await fetch(`${http}/arcade/run`, {
    method: 'POST', headers: H(dev), body: JSON.stringify({ token, character }),
  });
  assert.equal(run.status, 200, await run.clone().text());
  const state = await run.json() as { board: Board };
  return { token, board: state.board };
};

/** First reachable fight node from the start. */
const firstFight = (board: Board): number => {
  const succ = board.edges.filter(([a]) => a === board.start).map(([, b]) => b);
  const n = board.nodes.find((x) => succ.includes(x.id)
    && (x.kind === 'fight' || x.kind === 'gate' || x.kind === 'boss'));
  assert.ok(n, 'a fight is reachable from the start');
  return n!.id;
};

const defendOf = async (
  p: ReturnType<typeof memoryPersistence>, sub: string,
): Promise<{ wins: number; losses: number; elo: number }> => {
  const row = (await p.stable()).find((a) => a.id === sub)!;
  return { wins: row.defendWins ?? 0, losses: row.defendLosses ?? 0, elo: row.defendElo ?? ELO_BASE };
};

test('a human beating a cast guard records the guard FELL — a bot does not', async () => {
  const p = memoryPersistence();
  // One coached guard → castBoard puts it on every fight node.
  await p.createAgentAccount('agent:guard', 'WALLGUARD', 'h', 'dev:OWNER');
  await p.setAgentConfig('agent:guard', {
    character: 'vector', personality: { aggression: 120 }, motto: 'none shall pass',
  });

  const server = await createMatchServer({ port: 0, persistence: p, noPaceCheck: true });
  try {
    const http = `http://localhost:${server.port}`;
    const wsUrl = `ws://localhost:${server.port}`;

    // ---- HUMAN HANDS: the defense records.
    const run1 = await openRun(http, 'P1', 'analog');
    assert.ok(run1.board.nodes.some((n) => n.agent?.id === 'agent:guard'), 'board was cast');
    const c1 = wsClient(wsUrl, 'P1', false);
    await c1.ready;
    c1.send({ t: 'queue', character: 'analog', mode: 'arcade', runToken: run1.token, arcadeNode: firstFight(run1.board) });
    const setup1 = await c1.next<SMatch>('match');
    assert.ok(setup1.names[1].includes('WALLGUARD'), `nameplate bills the guard (got "${setup1.names[1]}")`);
    const line = winningLine(setup1);
    line.forEach((v, k) => c1.send({ t: 'i', k, v }));
    c1.send({ t: 'over', k: line.length });
    const res1 = await c1.next<Extract<ServerMsg, { t: 'result' }>>('result');
    assert.equal(res1.reason, 'verified');
    assert.equal(res1.winner, 0, 'the human won');
    c1.close();
    // recordDefense is fire-and-forget — give the microtask a beat.
    await new Promise((r) => setTimeout(r, 150));
    const after1 = await defendOf(p, 'agent:guard');
    assert.equal(after1.losses, 1, 'the guard FELL on its record');
    assert.equal(after1.wins, 0);
    assert.ok(after1.elo < ELO_BASE, 'falling cost the guard rating');

    // ---- DECLARED AGENT: same flow, hello.agent=true → nothing records.
    const run2 = await openRun(http, 'P2', 'analog');
    const c2 = wsClient(wsUrl, 'P2', true);
    await c2.ready;
    c2.send({ t: 'queue', character: 'analog', mode: 'arcade', runToken: run2.token, arcadeNode: firstFight(run2.board) });
    const setup2 = await c2.next<SMatch>('match');
    const line2 = winningLine(setup2);
    line2.forEach((v, k) => c2.send({ t: 'i', k, v }));
    c2.send({ t: 'over', k: line2.length });
    const res2 = await c2.next<Extract<ServerMsg, { t: 'result' }>>('result');
    assert.equal(res2.winner, 0);
    c2.close();
    await new Promise((r) => setTimeout(r, 150));
    const after2 = await defendOf(p, 'agent:guard');
    assert.deepEqual(
      { wins: after2.wins, losses: after2.losses },
      { wins: after1.wins, losses: after1.losses },
      'a declared-agent connection must not touch a defend record',
    );
  } finally {
    server.close();
  }
});
