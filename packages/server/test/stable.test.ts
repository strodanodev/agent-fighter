/**
 * THE STABLE + BOARD CASTING (ADR 0009 step 3). An arcade board's fight
 * nodes carry real coached identities — fleet personas and players' trained
 * agents — instead of anonymous archetypes.
 *
 * The load-bearing claims:
 *  · every fight node gets cast when the stable has candidates;
 *  · the guard fights AS its coached main (node.charId follows the agent);
 *  · personality is CLAMPED at cast time (a hand-edited DB row can't smuggle
 *    out-of-range knobs into a pinned setup);
 *  · a retired-character agent and the player's OWN agent are never cast;
 *  · an empty stable leaves the board exactly as generated (flavor, never a
 *    failure mode).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AI_PERSONALITY_RANGES } from '@af/core';
import type { Board, BoardNode } from '@af/core';
import { createMatchServer } from '../src/server.js';
import { memoryPersistence } from '../src/persist.js';

const id = (s: string) => ({ sub: s });
const H = (name: string): Record<string, string> =>
  ({ 'X-Dev-Name': name, 'Content-Type': 'application/json' });

const fightNodes = (b: Board): BoardNode[] =>
  b.nodes.filter((n) => n.kind === 'fight' || n.kind === 'gate' || n.kind === 'boss');

/** Claim the daily grant, open a paid run, lock a fighter, return the board. */
const openBoard = async (http: string, dev: string, character: string): Promise<Board> => {
  const me = await fetch(`${http}/me`, { headers: H(dev) });
  assert.equal(me.status, 200);
  const enter = await fetch(`${http}/arcade/enter`, {
    method: 'POST', headers: H(dev), body: JSON.stringify({ nonce: `stable-test-${dev}` }),
  });
  assert.equal(enter.status, 200, `entry failed: ${await enter.clone().text()}`);
  const { token } = await enter.json() as { token: string };
  const run = await fetch(`${http}/arcade/run`, {
    method: 'POST', headers: H(dev), body: JSON.stringify({ token, character }),
  });
  assert.equal(run.status, 200, `lock failed: ${await run.clone().text()}`);
  return (await run.json() as { board: Board }).board;
};

test('board casting: fight nodes carry stable identities, clamped and valid', async () => {
  const p = memoryPersistence();
  // Two fleet personas with coached configs. IRONCLAD's aggression is WAY
  // out of range on purpose — the cast must clamp it, not trust it.
  await p.createAgentAccount('agent:g1', 'IRONCLAD', 'h1', 'dev:OWNER');
  await p.setAgentConfig('agent:g1', {
    character: 'vector',
    personality: { aggression: 9999, patience: 70 },
    motto: 'the corner is my home',
  });
  await p.createAgentAccount('agent:g2', 'NULLPTR', 'h2', 'dev:OWNER');
  await p.setAgentConfig('agent:g2', { character: 'analog', personality: {} });
  // A stable row whose coached main has left the roster — never cast.
  await p.createAgentAccount('agent:g3', 'GHOST', 'h3', 'dev:OWNER');
  await p.setAgentConfig('agent:g3', { character: 'retired-fighter', personality: {} });

  const server = await createMatchServer({ port: 0, persistence: p, noPaceCheck: true });
  try {
    const board = await openBoard(`http://localhost:${server.port}`, 'P1', 'analog');
    const fights = fightNodes(board);
    assert.ok(fights.length > 0);

    const seen = new Set<string>();
    for (const n of fights) {
      // BOSS MONSTER (v1.0.3.bossfight): a boss-guarded node keeps its
      // authored identity — the stable must NOT recast the warden. With no
      // boss character in the repo the branch never fires; with one (e.g.
      // characters/boss1) the boss node is the one legitimate uncast fight.
      if (n.kind === 'boss' && !n.agent) {
        assert.ok(typeof n.skill === 'number', 'boss node skill survives');
        continue;
      }
      assert.ok(n.agent, `fight node ${n.id} was left uncast`);
      seen.add(n.agent!.name);
      assert.ok(['IRONCLAD', 'NULLPTR'].includes(n.agent!.name),
        `unexpected guard ${n.agent!.name} (GHOST mains a retired fighter)`);
      // The guard fights AS its coached main.
      assert.equal(n.charId, n.agent!.name === 'IRONCLAD' ? 'vector' : 'analog');
      // The board still owns difficulty — casting must never erase it.
      assert.ok(typeof n.skill === 'number', 'node skill survives casting');
    }
    // Both guards appear: the least-used window cycles a small stable
    // instead of pinning one agent onto every node.
    assert.equal(seen.size, 2, `expected both guards on the board, saw ${[...seen]}`);

    // Clamping: IRONCLAD's absurd aggression came out inside the legal range.
    const iron = fights.find((n) => n.agent!.name === 'IRONCLAD')!;
    const [, aggroMax] = AI_PERSONALITY_RANGES.aggression;
    assert.ok((iron.agent!.personality!.aggression ?? 0) <= aggroMax,
      'personality must be clamped at cast time');
    assert.equal(iron.agent!.motto, 'the corner is my home');

    // Non-fight nodes are never cast.
    for (const n of board.nodes) {
      if (n.kind === 'fight' || n.kind === 'gate' || n.kind === 'boss') continue;
      assert.equal(n.agent, undefined, `${n.kind} node ${n.id} must not carry an agent`);
    }
  } finally {
    server.close();
  }
});

test('your own trained agent never guards your board', async () => {
  const p = memoryPersistence();
  // The PLAYER has a coached agent (default-on puts it in everyone's stable)
  // — but sparring is the place to fight your own agent, not the arcade.
  await p.getAccount(id('dev:COACH'), 'COACH', false);
  await p.setAgentConfig('dev:COACH', { character: 'vector', personality: {} });

  const server = await createMatchServer({ port: 0, persistence: p, noPaceCheck: true });
  try {
    const board = await openBoard(`http://localhost:${server.port}`, 'COACH', 'analog');
    for (const n of fightNodes(board)) {
      assert.notEqual(n.agent?.id, 'dev:COACH', 'own agent must be excluded');
    }
  } finally {
    server.close();
  }
});

test('an empty stable leaves the board anonymous — casting is flavor, not a gate', async () => {
  const p = memoryPersistence();
  const server = await createMatchServer({ port: 0, persistence: p, noPaceCheck: true });
  try {
    const board = await openBoard(`http://localhost:${server.port}`, 'P2', 'analog');
    const fights = fightNodes(board);
    assert.ok(fights.length > 0);
    for (const n of fights) {
      assert.equal(n.agent, undefined);
      assert.ok(n.charId, 'archetype opponents still stand on every node');
    }
  } finally {
    server.close();
  }
});
