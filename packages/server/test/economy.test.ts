/**
 * M5 credits economy — unit tests against memoryPersistence (which mirrors
 * the Supabase SQL in supabase/migrations/0002_credits.sql; if a rule
 * changes here, change it there) plus live-server integration: a ranked
 * solo match against a spawned house bot, and wager settlement, both over
 * the real WebSocket protocol with the DEV economy.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DAILY_CREDITS, InsufficientCredits, SOLO_FEE, WAGER_FEE, XP_LOSS, XP_WIN,
  memoryPersistence,
} from '../src/persist.js';
import type { MatchRecord } from '../src/persist.js';
import { createMatchServer } from '../src/server.js';
import { playOneMatch } from '../src/agent-session.js';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(here, '..', '..', '..');
const charactersDir = join(REPO_ROOT, 'characters');

const id = (s: string) => ({ sub: s });

const baseRecord = (over: Partial<MatchRecord>): MatchRecord => ({
  matchId: 'mt1', mode: 'wager', fee: WAGER_FEE,
  identities: [id('a'), id('b')], names: ['A', 'B'], agents: [false, false],
  chars: ['analog', 'vector'], winner: 0, reason: 'verified',
  rounds: [2, 0], endTick: 3000, hash: 1, engine: 'af-core-1',
  ...over,
});

test('daily bonus: +10 once per day, idempotent within the day', async () => {
  const p = memoryPersistence();
  const a1 = await p.getAccount(id('u1'), 'U1', false);
  assert.equal(a1.credits, DAILY_CREDITS);
  assert.equal(a1.dailyGranted, true);
  const a2 = await p.getAccount(id('u1'), 'U1', false);
  assert.equal(a2.credits, DAILY_CREDITS); // no double grant
  assert.equal(a2.dailyGranted, false);
});

test('escrow: atomic, idempotent, throws INSUFFICIENT with the broke side', async () => {
  const p = memoryPersistence();
  await p.getAccount(id('rich'), 'R', false); // 10
  await p.getAccount(id('poor'), 'P', false); // 10
  await p.escrowMatch('m1', ['rich', 'poor'], WAGER_FEE); // both to 0
  await p.escrowMatch('m1', ['rich', 'poor'], WAGER_FEE); // retry = no-op
  assert.equal((await p.getAccount(id('rich'), 'R', false)).credits, 0);

  // Neither side can cover another wager now; side 0 is reported broke and
  // NOTHING is charged (all-or-none).
  await assert.rejects(
    p.escrowMatch('m2', ['rich', 'poor'], WAGER_FEE),
    (e: unknown) => e instanceof InsufficientCredits && e.side === 0,
  );
  assert.equal((await p.getAccount(id('poor'), 'P', false)).credits, 0);
});

test('wager settle: winner takes the pot, loser XP still grows', async () => {
  const p = memoryPersistence();
  await p.getAccount(id('a'), 'A', false);
  await p.getAccount(id('b'), 'B', false);
  await p.escrowMatch('mt1', ['a', 'b'], WAGER_FEE);
  const awards = await p.recordMatch(baseRecord({}));
  const a = awards.find((x) => x.side === 0)!;
  const b = awards.find((x) => x.side === 1)!;
  assert.equal(a.creditsDelta, WAGER_FEE); // net +10 (pot 20 − fee 10)
  assert.equal(a.credits, DAILY_CREDITS + WAGER_FEE);
  assert.equal(a.gained, XP_WIN);
  assert.equal(a.wins, 1);
  assert.equal(b.creditsDelta, -WAGER_FEE);
  assert.equal(b.credits, 0);
  assert.equal(b.gained, XP_LOSS);
  assert.equal(b.losses, 1);
  // Idempotent: replaying the settlement changes nothing.
  assert.deepEqual(await p.recordMatch(baseRecord({})), []);
  assert.equal((await p.getAccount(id('a'), 'A', false)).credits, DAILY_CREDITS + WAGER_FEE);
});

test('wager draw/incomplete: both refunded', async () => {
  const p = memoryPersistence();
  await p.getAccount(id('a'), 'A', false);
  await p.getAccount(id('b'), 'B', false);
  await p.escrowMatch('mt1', ['a', 'b'], WAGER_FEE);
  const awards = await p.recordMatch(baseRecord({ winner: -1, reason: 'incomplete' }));
  for (const x of awards) {
    assert.equal(x.creditsDelta, 0);
    assert.equal(x.credits, DAILY_CREDITS);
    assert.equal(x.gained, 0);
    assert.equal(x.wins + x.losses, 0);
  }
});

test('deviator forfeits the pot even when the re-sim says it won', async () => {
  const p = memoryPersistence();
  await p.getAccount(id('cheat'), 'C', false);
  await p.getAccount(id('honest'), 'H', false);
  await p.escrowMatch('mt1', ['cheat', 'honest'], WAGER_FEE);
  const awards = await p.recordMatch(baseRecord({
    identities: [id('cheat'), id('honest')], winner: 0, deviator: 0,
  }));
  const cheat = awards.find((x) => x.side === 0)!;
  const honest = awards.find((x) => x.side === 1)!;
  assert.equal(cheat.creditsDelta, -WAGER_FEE);
  assert.equal(cheat.gained, 0);
  assert.equal(cheat.losses, 1);
  assert.equal(honest.creditsDelta, WAGER_FEE);
  assert.equal(honest.wins, 1);
});

test('solo: win nets +1 credit; loss burns the fee and −15 XP clamped at 0', async () => {
  const p = memoryPersistence();
  await p.getAccount(id('u'), 'U', false);
  // Win: fee 1 escrowed, payout 2 → net +1, +60 XP.
  await p.escrowMatch('s1', ['u', null], SOLO_FEE);
  const [w] = await p.recordMatch(baseRecord({
    matchId: 's1', mode: 'solo', fee: SOLO_FEE, identities: [id('u'), null], winner: 0,
  }));
  assert.equal(w!.creditsDelta, 1);
  assert.equal(w!.credits, DAILY_CREDITS + 1);
  assert.equal(w!.gained, XP_WIN);
  // Loss: net −1 credit, −15 XP but clamped at the level floor (xp was 60).
  await p.escrowMatch('s2', ['u', null], SOLO_FEE);
  const [l] = await p.recordMatch(baseRecord({
    matchId: 's2', mode: 'solo', fee: SOLO_FEE, identities: [id('u'), null], winner: 1,
  }));
  assert.equal(l!.creditsDelta, -1);
  assert.equal(l!.gained, -15);
  assert.equal(l!.xp, 45); // 60 − 15
  assert.equal(l!.level, 1); // never de-levels
  // Clamp: burn XP below zero stays at zero.
  for (const m of ['s3', 's4', 's5', 's6']) {
    await p.escrowMatch(m, ['u', null], SOLO_FEE);
    await p.recordMatch(baseRecord({
      matchId: m, mode: 'solo', fee: SOLO_FEE, identities: [id('u'), null], winner: 1,
    }));
  }
  const acc = await p.getAccount(id('u'), 'U', false);
  assert.equal(acc.xp, 0);
  assert.equal(acc.level, 1);
});

// ------------------------------------------------------------- integration
test('LIVE ranked solo: house bot spawns, fee + settlement land on the account', async (t) => {
  const persistence = memoryPersistence();
  const server = await createMatchServer({ port: 0, persistence, noPaceCheck: true });
  t.after(() => server.close());

  const { result, localHash } = await playOneMatch({
    url: `ws://127.0.0.1:${server.port}`,
    name: 'SoloGrinder', character: 'vector', skill: 85,
    charactersDir, aiSeed: 42, paceMs: 1, mode: 'solo',
  });
  assert.equal(result.reason, 'verified');
  assert.equal(result.deviator, undefined);
  assert.equal(localHash, result.hash >>> 0);

  // recordMatch runs async after the result — settle before asserting.
  await new Promise((r) => setTimeout(r, 300));
  const acc = await persistence.getAccount({ sub: 'dev:SoloGrinder' }, 'SoloGrinder', true);
  const won = acc.wins === 1;
  const draw = result.winner === 2;
  const expected = DAILY_CREDITS - SOLO_FEE + (won ? SOLO_FEE + 1 : draw ? SOLO_FEE : 0);
  assert.equal(acc.credits, expected);
  assert.equal(acc.wins + acc.losses, draw ? 0 : 1);
  if (won) assert.ok(acc.xp > 0 || acc.level > 1);

  // The house side must never appear in the standings.
  const board = await persistence.leaderboard(10) as Array<{ name: string }>;
  assert.ok(!board.some((r) => r.name.startsWith('HOUSE')));
});

test('LIVE wager: pot settles winner +10 / loser −10; broke player is refused', async (t) => {
  const persistence = memoryPersistence();
  const server = await createMatchServer({ port: 0, persistence, noPaceCheck: true });
  t.after(() => server.close());
  const url = `ws://127.0.0.1:${server.port}`;

  const [ra, rb] = await Promise.all([
    playOneMatch({ url, name: 'Alice', character: 'analog', skill: 80, charactersDir, aiSeed: 7, paceMs: 1 }),
    playOneMatch({ url, name: 'BobBot', character: 'vector', skill: 20, charactersDir, aiSeed: 9, paceMs: 1 }),
  ]);
  assert.equal(ra.result.reason, 'verified');
  assert.equal(ra.result.hash, rb.result.hash);

  await new Promise((r) => setTimeout(r, 300));
  const a = await persistence.getAccount({ sub: 'dev:Alice' }, 'Alice', true);
  const b = await persistence.getAccount({ sub: 'dev:BobBot' }, 'BobBot', true);
  if (ra.result.winner === 2) {
    assert.equal(a.credits + b.credits, DAILY_CREDITS * 2); // both refunded
  } else {
    const [w, l] = ra.result.winner === 0 ? [a, b] : [b, a];
    assert.equal(w.credits, DAILY_CREDITS + WAGER_FEE);
    assert.equal(l.credits, 0);
    assert.equal(w.wins, 1);
    assert.equal(l.losses, 1);

    // The loser is now broke — re-queueing must be refused, with no charge.
    await assert.rejects(
      playOneMatch({
        url, name: ra.result.winner === 0 ? 'BobBot' : 'Alice',
        character: 'vector', skill: 20, charactersDir, aiSeed: 11, paceMs: 1,
      }),
      /credit/,
    );
    assert.equal((await persistence.getAccount(
      { sub: ra.result.winner === 0 ? 'dev:BobBot' : 'dev:Alice' },
      'x', true,
    )).credits, 0);
  }
});

// ------------------------------------------------------------ escrow sweeper
test('sweeper: refunds fees stranded by a crash; settled + young escrows untouched', async () => {
  const p = memoryPersistence();
  await p.getAccount(id('crashA'), 'CA', false); // 10
  await p.getAccount(id('crashB'), 'CB', false); // 10
  await p.getAccount(id('winner'), 'W', false);  // 10

  // A wager whose settlement never ran (the "server died" ghost)…
  await p.escrowMatch('ghost', ['crashA', 'crashB'], WAGER_FEE);
  // …a match that settled normally…
  await p.escrowMatch('done', ['winner', null], SOLO_FEE);
  await p.recordMatch(baseRecord({
    matchId: 'done', mode: 'solo', fee: SOLO_FEE, identities: [id('winner'), null], winner: 0,
  }));
  // …and a fee young enough to belong to a match still in progress.
  await p.escrowMatch('inflight', ['winner', null], SOLO_FEE);

  const swept = await p.sweepOrphanedEscrow(0); // cutoff 0 → ghost qualifies…
  // …but 'inflight' also has age 0 — so use the count to prove ONLY unsettled
  // matches were touched: ghost (2 fees) + inflight (1 fee) = 3, 'done' = 0.
  assert.equal(swept, 3, 'both unsettled matches swept; the settled one untouched');
  assert.equal((await p.getAccount(id('crashA'), 'CA', false)).credits, DAILY_CREDITS);
  assert.equal((await p.getAccount(id('crashB'), 'CB', false)).credits, DAILY_CREDITS);

  // Idempotent: a second sweep refunds nothing.
  assert.equal(await p.sweepOrphanedEscrow(0), 0);

  // THE double-spend guard: a late settlement of a swept match awards NOTHING.
  const late = await p.recordMatch(baseRecord({
    matchId: 'ghost', identities: [id('crashA'), id('crashB')], winner: 0,
  }));
  assert.deepEqual(late, []);
  assert.equal((await p.getAccount(id('crashA'), 'CA', false)).credits, DAILY_CREDITS);
});

test('sweeper: a young orphan is left alone until the cutoff passes', async () => {
  const p = memoryPersistence();
  await p.getAccount(id('u9'), 'U9', false);
  await p.escrowMatch('young', ['u9', null], SOLO_FEE);
  assert.equal(await p.sweepOrphanedEscrow(30), 0, '30-min cutoff spares a fresh escrow');
  assert.equal((await p.getAccount(id('u9'), 'U9', false)).credits, DAILY_CREDITS - SOLO_FEE);
});
