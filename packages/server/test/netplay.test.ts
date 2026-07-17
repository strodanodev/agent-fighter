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
    // persistence: null — tests must NEVER write to a real Supabase project,
    // even when the developer's .env carries live keys.
    server = await createMatchServer({ port: 0, persistence: null });
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

describe('persistence hook (Phase B)', () => {
  it('a finished match is recorded exactly once with the verified outcome', async () => {
    const records: import('../src/persist.js').MatchRecord[] = [];
    const mock: import('../src/persist.js').Persistence = {
      // Dev identities so agents can queue without AIR tokens; generous
      // credits so escrow doesn't block the Phase-B recordMatch assertion.
      dev: true,
      getAccount: async () => ({
        credits: 100, level: 1, xp: 0, wins: 0, losses: 0, dailyGranted: false,
        refCode: 'TEST-0000', referralGranted: 0, daresAccepted: 0, daresPaidWeek: 0,
      }),
      escrowMatch: async () => {},
      recordMatch: async (r) => { records.push(r); return []; },
      sweepOrphanedEscrow: async () => 0,
      releaseReferral: async () => 0,
      leaderboard: async () => [],
      agentRoster: async () => [],
      houseStats: async () => ({ wins: 0, losses: 0, streak: 0, battles: 0 }),
      getAgent: async () => null,
      setAgentConfig: async () => false,
      setAgentKey: async () => false,
      findByAgentKey: async () => null,
    };
    const s2 = await createMatchServer({ port: 0, persistence: mock });
    try {
      const url = `ws://localhost:${s2.port}`;
      const [a] = await Promise.all([
        playOneMatch({ url, name: 'AgentE', character: 'analog', skill: 60, charactersDir, aiSeed: 555, paceMs: 1 }),
        playOneMatch({ url, name: 'AgentF', character: 'vector', skill: 60, charactersDir, aiSeed: 666, paceMs: 1 }),
      ]);
      // recordMatch fires right after the result goes out — same tick.
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(records.length, 1, 'one match → one record');
      const rec = records[0]!;
      assert.equal(rec.reason, 'verified');
      assert.equal(rec.winner, a.result.winner);
      assert.deepEqual(rec.names.slice().sort(), ['AgentE', 'AgentF']);
      assert.deepEqual(rec.agents, [true, true]);
      // Dev persistence mints name-keyed identities so escrow/record can run
      // without AIR tokens (production supabasePersistence never does this).
      assert.deepEqual(rec.identities.map((i) => i?.sub ?? null).sort(), ['dev:AgentE', 'dev:AgentF']);
      assert.equal(rec.mode, 'wager');
      assert.equal(rec.fee, 10);
      assert.equal(rec.hash >>> 0, a.result.hash >>> 0);
    } finally {
      s2.close();
    }
  });
});
