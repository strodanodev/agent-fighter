import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMatchServer } from '../src/server.js';
import type { MatchServer } from '../src/server.js';
import { playOneMatch } from '../src/agent-session.js';

/**
 * The Phase A proof (ADR 0003): two headless agents play a REAL online match
 * through the REAL server — queue, relay, ledger, verification — and the
 * server-derived result matches both clients' local simulations bit-for-bit.
 * This is simultaneously the netcode integration test and the demonstration
 * that the agent story works end to end.
 */

const here = dirname(fileURLToPath(import.meta.url));
const charactersDir = join(here, '..', '..', '..', 'characters');

let server: MatchServer;

after(() => server?.close());

describe('online match: two agents through the real server', () => {
  it('plays a full verified match; server hash == both local hashes', async () => {
    server = await createMatchServer({ port: 0 });
    const url = `ws://localhost:${server.port}`;

    const [a, b] = await Promise.all([
      playOneMatch({ url, name: 'AgentA', character: 'analog', skill: 70, charactersDir, aiSeed: 111, paceMs: 1 }),
      playOneMatch({ url, name: 'AgentB', character: 'vector', skill: 55, charactersDir, aiSeed: 222, paceMs: 1 }),
    ]);

    // Both got the SAME verified result.
    assert.equal(a.result.reason, 'verified');
    assert.equal(b.result.reason, 'verified');
    assert.equal(a.result.winner, b.result.winner);
    assert.ok(a.result.winner === 0 || a.result.winner === 1 || a.result.winner === 2);
    assert.deepEqual(a.result.rounds, b.result.rounds);
    assert.equal(a.result.hash, b.result.hash);

    // The trust anchor: server re-sim == both clients' local sims, bit for bit.
    assert.equal(a.localHash, a.result.hash >>> 0, 'client A desynced from the verifier');
    assert.equal(b.localHash, b.result.hash >>> 0, 'client B desynced from the verifier');

    // Nobody was (falsely) flagged as a deviator.
    assert.equal(a.result.deviator, undefined);

    // The match was a real fight, not a stall (rounds were actually won).
    assert.ok(a.result.rounds[0] + a.result.rounds[1] >= 2, 'no rounds were decided');
  });

  it('a second match runs on the same server (no leaked match state)', async () => {
    const url = `ws://localhost:${server.port}`;
    const [a, b] = await Promise.all([
      playOneMatch({ url, name: 'AgentC', character: 'blaze', skill: 60, charactersDir, aiSeed: 333, paceMs: 1 }),
      playOneMatch({ url, name: 'AgentD', character: 'gbush', skill: 60, charactersDir, aiSeed: 444, paceMs: 1 }),
    ]);
    assert.equal(a.result.reason, 'verified');
    assert.equal(a.localHash, a.result.hash >>> 0);
    assert.equal(b.localHash, b.result.hash >>> 0);
  });
});
