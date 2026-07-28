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

test('board casting: unique fighters, one guard per character, clamped', async () => {
  const p = memoryPersistence();
  // THREE coached personas, but TWO main the same fighter — the owner rule
  // (2026-07-29: a gauntlet must never show the same fighter twice) means
  // only one VECTOR main may guard any given board. IRONCLAD's aggression is
  // WAY out of range on purpose — the cast must clamp it, not trust it.
  await p.createAgentAccount('agent:g1', 'IRONCLAD', 'h1', 'dev:OWNER');
  await p.setAgentConfig('agent:g1', {
    character: 'vector',
    personality: { aggression: 9999, patience: 70 },
    motto: 'the corner is my home',
  });
  await p.createAgentAccount('agent:g2', 'NULLPTR', 'h2', 'dev:OWNER');
  await p.setAgentConfig('agent:g2', { character: 'analog', personality: {} });
  await p.createAgentAccount('agent:g4', 'COPYCAT', 'h4', 'dev:OWNER');
  await p.setAgentConfig('agent:g4', { character: 'vector', personality: {} });
  // A stable row whose coached main has left the roster — never cast.
  await p.createAgentAccount('agent:g3', 'GHOST', 'h3', 'dev:OWNER');
  await p.setAgentConfig('agent:g3', { character: 'retired-fighter', personality: {} });

  const server = await createMatchServer({ port: 0, persistence: p, noPaceCheck: true });
  try {
    const board = await openBoard(`http://localhost:${server.port}`, 'P1', 'analog');
    const fights = fightNodes(board);
    assert.ok(fights.length > 0);

    // THE INVARIANT this test exists for: no fighter appears twice in a run —
    // the generator's own "shuffled roster, no repeats" promise, which the
    // first cast broke (two BLAZE mains → two BLAZEs on one board).
    const chars = fights.map((n) => n.charId);
    assert.equal(new Set(chars).size, chars.length,
      `duplicate fighter in the gauntlet: ${chars.sort().join(', ')}`);

    const cast = fights.filter((n) => n.agent);
    const seenAgents = cast.map((n) => n.agent!.name);
    // vector + analog mains → exactly TWO nodes cast (one VECTOR main only);
    // GHOST never appears; no agent guards two nodes.
    assert.equal(new Set(seenAgents).size, seenAgents.length, 'an agent guards at most one node');
    assert.equal(cast.length, 2, `one guard per character: expected 2 cast, got ${seenAgents}`);
    assert.ok(!seenAgents.includes('GHOST'), 'a retired-fighter main is never cast');
    for (const n of cast) {
      const expected = n.agent!.name === 'NULLPTR' ? 'analog' : 'vector';
      assert.equal(n.charId, expected, 'the guard fights AS its coached main');
      assert.ok(typeof n.skill === 'number', 'the board still owns difficulty');
    }

    // Clamping: the cast VECTOR main's absurd aggression came out legal.
    // (Which vector main wins the slot depends on level banding — both are
    // LV1, so the name tiebreak picks deterministically; accept either.)
    const vec = cast.find((n) => n.charId === 'vector')!;
    const [, aggroMax] = AI_PERSONALITY_RANGES.aggression;
    const aggro = vec.agent!.personality?.aggression;
    assert.ok(aggro === undefined || aggro <= aggroMax,
      'personality must be clamped at cast time');

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
