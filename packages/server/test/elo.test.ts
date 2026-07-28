/**
 * ELO RATINGS + SEASONS (ADR 0009, build step 1) — unit tests against
 * memoryPersistence, which mirrors supabase/migrations/0021_elo.sql. If a
 * rule changes here, change it THERE TOO: the dev economy exists to tell the
 * truth about production, and a silent drift between the two is exactly the
 * class of bug the 0002 `NULL = s` lesson came from.
 *
 * The load-bearing claims:
 *  · only a DECIDED WAGER between two human hands moves a rating;
 *  · both ratings are read before either is written (zero-sum);
 *  · a deviator takes the loss whatever the sim said.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ELO_BASE, SEASON_DAYS, SEASON_EPOCH_MS, WAGER_FEE,
  currentSeason, eloK, memoryPersistence,
} from '../src/persist.js';
import type { MatchRecord } from '../src/persist.js';

const id = (s: string) => ({ sub: s });

const rec = (over: Partial<MatchRecord>): MatchRecord => ({
  matchId: 'e1', mode: 'wager', fee: WAGER_FEE,
  identities: [id('a'), id('b')], names: ['A', 'B'], agents: [false, false],
  chars: ['analog', 'vector'], winner: 0, reason: 'verified',
  rounds: [2, 0], endTick: 3000, hash: 1, engine: 'af-core-1',
  ...over,
});

/**
 * Two known profiles. No escrow: ratings are computed from the MATCH RECORD
 * and never read the credit path, so staking is irrelevant here — and the
 * daily grant is exactly one wager fee, which would bankrupt the multi-match
 * tests below on their second escrow.
 */
const funded = async (): Promise<ReturnType<typeof memoryPersistence>> => {
  const p = memoryPersistence();
  await p.getAccount(id('a'), 'A', false);
  await p.getAccount(id('b'), 'B', false);
  return p;
};

test('a decided wager moves both ratings, and the movement is zero-sum', async () => {
  const p = await funded();
  const aw = await p.recordMatch(rec({}));
  const a = aw.find((x) => x.side === 0)!;
  const b = aw.find((x) => x.side === 1)!;

  // Equal ratings (1200 vs 1200) → expectation 0.5 → provisional K=40 splits
  // exactly 20 points. The sum is the point: Elo is a closed system, so a
  // rating can only be created by taking it from someone.
  assert.equal(a.eloDelta, 20);
  assert.equal(b.eloDelta, -20);
  assert.equal(a.eloDelta + b.eloDelta, 0);
  assert.equal(a.elo, ELO_BASE + 20);
  assert.equal(b.elo, ELO_BASE - 20);
  // Season ratings start in their own pool at the same base, so season 1
  // tracks lifetime exactly — they diverge only after a season boundary.
  assert.equal(a.seasonElo, ELO_BASE + 20);
  assert.equal(b.seasonElo, ELO_BASE - 20);
});

test('the underdog gains more than an even match pays', async () => {
  const p = await funded();
  await p.recordMatch(rec({})); // a wins → 1220 / 1180

  const aw = await p.recordMatch(rec({ matchId: 'e2', winner: 1 }));
  const a = aw.find((x) => x.side === 0)!;
  const b = aw.find((x) => x.side === 1)!;

  // b (1180) beating a (1220) is the upset, so it pays more than the 20 an
  // even match pays — and costs the favourite exactly as much.
  assert.equal(b.eloDelta, 22);
  assert.equal(a.eloDelta, -22);
  assert.ok(b.eloDelta > 20, 'upset must out-pay an even win');
});

test('a draw between equals moves nothing', async () => {
  const p = await funded();
  const aw = await p.recordMatch(rec({ winner: 2 }));
  for (const x of aw) {
    assert.equal(x.eloDelta, 0);
    assert.equal(x.elo, ELO_BASE);
  }
});

test('the deviator takes the rating loss even when the sim says it won', async () => {
  const p = await funded();
  // Side 0 "won" the simulation but deviated — ADR 0003/0005: a deviator can
  // never win a settlement, so the rating must follow the settlement, not the
  // re-sim. Getting this backwards would make desyncing a way to farm rating.
  const aw = await p.recordMatch(rec({ winner: 0, deviator: 0 }));
  const a = aw.find((x) => x.side === 0)!;
  const b = aw.find((x) => x.side === 1)!;
  assert.equal(a.eloDelta, -20);
  assert.equal(b.eloDelta, 20);
});

test('unrated: arcade, solo, incomplete, and anything an agent touched', async () => {
  // Each case gets a fresh economy so a stray rating change cannot hide
  // behind another case's movement.
  const cases: Array<[string, Partial<MatchRecord>]> = [
    ['arcade is PvE against a pinned bot', { mode: 'arcade', fee: 0 }],
    ['solo is PvE against a pinned bot', { mode: 'solo', fee: 1 }],
    ['nothing was decided', { winner: -1, reason: 'incomplete' }],
    ['a draw is decided but scores 0.5 — covered above; here: no winner code',
      { winner: 7 }],
    // THE load-bearing gate: a coached-owner headless runner plays as its
    // owner's ordinary human profile, so only the declared-agent flag stops
    // an owner ranking up in their sleep.
    ['side 0 declared itself an agent', { agents: [true, false] }],
    ['side 1 declared itself an agent', { agents: [false, true] }],
  ];
  for (const [why, over] of cases) {
    const p = await funded();
    const aw = await p.recordMatch(rec(over));
    for (const x of aw) {
      assert.equal(x.eloDelta, 0, `${why}: must not move a rating`);
      assert.equal(x.elo, ELO_BASE, `${why}: rating must stay at base`);
      assert.equal(x.seasonEloDelta, 0, `${why}: must not move a season rating`);
    }
  }
});

test('agent-class accounts are rating-inert', async () => {
  const p = memoryPersistence();
  await p.getAccount(id('human'), 'HUMAN', false);
  await p.createAgentAccount('agent:bot1', 'BOT', 'hash', 'human');
  const aw = await p.recordMatch(rec({
    matchId: 'ea', fee: 0,
    identities: [id('human'), id('agent:bot1')], names: ['HUMAN', 'BOT'],
  }));
  for (const x of aw) assert.equal(x.eloDelta, 0);
});

test('K-factor: provisional while finding your level, calm at the top', () => {
  assert.equal(eloK(ELO_BASE, 0), 40, 'a new player converges fast');
  assert.equal(eloK(ELO_BASE, 9), 40);
  assert.equal(eloK(ELO_BASE, 10), 20, 'provisional retires at 10 rated');
  assert.equal(eloK(2400, 50), 10, 'top of the ladder moves slowly');
});

test('seasons are arithmetic over a fixed epoch — no cron, no season table', () => {
  const day = 86_400_000;
  assert.equal(currentSeason(SEASON_EPOCH_MS), 1);
  assert.equal(currentSeason(SEASON_EPOCH_MS + (SEASON_DAYS - 1) * day), 1);
  assert.equal(currentSeason(SEASON_EPOCH_MS + SEASON_DAYS * day), 2);
  assert.equal(currentSeason(SEASON_EPOCH_MS + 2 * SEASON_DAYS * day), 3);
});

test('grinding PvE never ages a player out of the provisional K', async () => {
  const p = await funded();
  // `rated` must advance ONLY on rated matches. Ten arcade battles is past
  // the provisional threshold, so if PvE leaked into the count the wager
  // below would settle at K=20 (a 10-point swing) instead of K=40.
  for (let i = 0; i < 10; i++) {
    await p.recordMatch(rec({ matchId: `arc${i}`, mode: 'arcade', fee: 0 }));
  }
  const aw = await p.recordMatch(rec({ matchId: 'e3' }));
  const a = aw.find((x) => x.side === 0)!;
  assert.equal(a.eloDelta, 20, 'still provisional (K=40) after 10 PvE battles');
});

test('season board: ranks the qualified, still LISTS the provisional', async () => {
  const p = memoryPersistence();
  await p.getAccount(id('vet'), 'VET', false);
  await p.getAccount(id('rook'), 'ROOK', false);
  // 10 rated wagers puts BOTH past the provisional gate; `vet` wins them all.
  for (let i = 0; i < 10; i++) {
    await p.recordMatch(rec({
      matchId: `s${i}`, identities: [id('vet'), id('rook')], names: ['VET', 'ROOK'],
    }));
  }
  // A third player with a decided PvE record only — listed, never ranked.
  await p.getAccount(id('pve'), 'PVE', false);
  await p.recordMatch(rec({
    matchId: 'pve1', mode: 'arcade', fee: 0,
    identities: [id('pve'), null], names: ['PVE', 'HOUSE'],
  }));

  const board = await p.seasonBoard(10) as Array<Record<string, unknown>>;
  const by = (n: string) => board.find((r) => r.name === n)!;

  assert.equal(by('VET').qualified, true);
  assert.equal(by('ROOK').qualified, true);
  assert.equal(by('VET').rank, 1, 'the winner tops the ladder');
  assert.equal(by('ROOK').rank, 2);
  assert.ok((by('VET').elo as number) > (by('ROOK').elo as number));

  // Present, but holding no position a prize could key on.
  assert.equal(by('PVE').qualified, false);
  assert.equal(by('PVE').rank, null, 'provisional players rank NULL, not last');
  assert.equal(by('PVE').elo, ELO_BASE);
  // Ordering: every qualified row precedes every provisional one.
  assert.ok(board.findIndex((r) => r.name === 'PVE')
    > board.findIndex((r) => r.name === 'ROOK'));
});

test('season board excludes profiles with no decided matches at all', async () => {
  const p = memoryPersistence();
  await p.getAccount(id('lurker'), 'LURKER', false); // account, never fought
  assert.equal((await p.seasonBoard(10)).length, 0);
});
