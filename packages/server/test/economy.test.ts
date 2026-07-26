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

test('wager settle: BOTH fees burn, the winner mints a ticket (ADR 0009)', async () => {
  const p = memoryPersistence();
  await p.getAccount(id('a'), 'A', false);
  await p.getAccount(id('b'), 'B', false);
  await p.escrowMatch('mt1', ['a', 'b'], WAGER_FEE);
  const awards = await p.recordMatch(baseRecord({}));
  const a = awards.find((x) => x.side === 0)!;
  const b = awards.find((x) => x.side === 1)!;
  // THE CUTOVER: there is no pot. Winning costs the same as losing —
  // the reward is the ticket, not credits.
  assert.equal(a.creditsDelta, -WAGER_FEE, 'winner does NOT get paid credits');
  assert.equal(a.credits, 0);
  assert.equal(a.ticket, true, 'winner minted a ticket');
  assert.equal(a.tickets, 1);
  assert.equal(a.gained, XP_WIN);
  assert.equal(a.wins, 1);
  assert.equal(b.creditsDelta, -WAGER_FEE);
  assert.equal(b.credits, 0);
  assert.equal(b.ticket, false, 'the loser mints nothing');
  assert.equal(b.gained, XP_LOSS);
  assert.equal(b.losses, 1);
  // The pot is GONE, not moved: 20 credits left the economy entirely.
  assert.equal(a.credits + b.credits, 0, 'both entries burned');
  // Idempotent: replaying the settlement mints no second ticket.
  assert.deepEqual(await p.recordMatch(baseRecord({})), []);
  const after = await p.getAccount(id('a'), 'A', false);
  assert.equal(after.credits, 0);
  assert.equal(after.tickets, 1, 'a settlement retry never mints twice');
});

test('a ticket needs a DECIDED win: draws and no-contests mint nothing', async () => {
  const p = memoryPersistence();
  await p.getAccount(id('a'), 'A', false);
  await p.getAccount(id('b'), 'B', false);
  await p.escrowMatch('d1', ['a', 'b'], WAGER_FEE);
  for (const x of await p.recordMatch(baseRecord({ matchId: 'd1', winner: 2 }))) {
    assert.equal(x.ticket, false, 'a draw mints nothing');
    assert.equal(x.creditsDelta, 0, 'a draw refunds the entry');
  }
  await p.escrowMatch('d2', ['a', 'b'], WAGER_FEE);
  for (const x of await p.recordMatch(
    baseRecord({ matchId: 'd2', winner: -1, reason: 'incomplete' }),
  )) {
    assert.equal(x.ticket, false, 'a no-contest mints nothing');
  }
  assert.equal((await p.getAccount(id('a'), 'A', false)).tickets, 0);
});

test('a FORFEIT win mints — a win is a win (owner decision 2026-07-26)', async () => {
  const p = memoryPersistence();
  await p.getAccount(id('a'), 'A', false);
  await p.getAccount(id('b'), 'B', false);
  await p.escrowMatch('f1', ['a', 'b'], WAGER_FEE);
  const awards = await p.recordMatch(
    baseRecord({ matchId: 'f1', winner: 0, reason: 'forfeit' }),
  );
  assert.equal(awards.find((x) => x.side === 0)!.ticket, true);
  assert.equal(awards.find((x) => x.side === 1)!.ticket, false);
  // Still a burn: the quitter's entry is not handed to the stayer.
  assert.equal(awards.find((x) => x.side === 0)!.creditsDelta, -WAGER_FEE);
});

test('HUMAN HANDS ONLY: neither agent-class nor declared-agent wins mint', async () => {
  const p = memoryPersistence();
  // Gate 1 — the inert account CLASS.
  const bot = 'agent:1111-2222';
  await p.getAccount(id(bot), 'BOT', true);
  await p.getAccount(id('h'), 'H', false);
  await p.escrowMatch('ag1', [bot, 'h'], 0);
  const cls = await p.recordMatch(baseRecord({
    matchId: 'ag1', fee: 0, identities: [id(bot), id('h')], winner: 0,
  }));
  assert.equal(cls.find((x) => x.side === 0)!.ticket, false, 'a bot never mints');
  assert.equal((await p.getAccount(id(bot), 'BOT', true)).tickets, 0);

  // Gate 2 — the CONNECTION declared itself an agent. This sub is an
  // ordinary human profile (a coached-owner headless runner plays AS its
  // owner), so only the agents[] flag can stop it farming.
  await p.getAccount(id('owner'), 'OWNER', false);
  await p.getAccount(id('foe'), 'FOE', false);
  await p.escrowMatch('ag2', ['owner', 'foe'], WAGER_FEE);
  const hands = await p.recordMatch(baseRecord({
    matchId: 'ag2', identities: [id('owner'), id('foe')],
    agents: [true, false], winner: 0,
  }));
  assert.equal(hands.find((x) => x.side === 0)!.ticket, false,
    'an owner\'s headless runner must not mint while they sleep');
  assert.equal((await p.getAccount(id('owner'), 'OWNER', false)).tickets, 0);
  // …but the win itself still counts: only the TICKET is withheld.
  assert.equal(hands.find((x) => x.side === 0)!.wins, 1);
});

test('only WAGER mints: solo and arcade wins never do', async () => {
  const p = memoryPersistence();
  await p.getAccount(id('u'), 'U', false);
  await p.escrowMatch('so1', ['u', null], SOLO_FEE);
  const [solo] = await p.recordMatch(baseRecord({
    matchId: 'so1', mode: 'solo', fee: SOLO_FEE, identities: [id('u'), null], winner: 0,
  }));
  assert.equal(solo!.ticket, false);
  const [arc] = await p.recordMatch(baseRecord({
    matchId: 'ar1', mode: 'arcade', fee: 0, identities: [id('u'), null], winner: 0,
  }));
  assert.equal(arc!.ticket, false);
  assert.equal((await p.getAccount(id('u'), 'U', false)).tickets, 0);
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

test('deviator forfeits the TICKET even when the re-sim says it won', async () => {
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
  assert.equal(cheat.ticket, false, 'a deviator can never mint');
  // The honest side takes the win (and the ticket) — but not the cheat's
  // credits: those burned like everyone else's.
  assert.equal(honest.creditsDelta, -WAGER_FEE);
  assert.equal(honest.ticket, true);
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

test('LIVE wager: both entries burn, winner holds a ticket; broke player is refused', async (t) => {
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
    assert.equal(a.tickets + b.tickets, 0, 'a draw mints nothing');
  } else {
    const [w, l] = ra.result.winner === 0 ? [a, b] : [b, a];
    // ADR 0009: the pot is burned, so BOTH sides end at zero.
    assert.equal(w.credits, 0, 'winning costs the same as losing');
    assert.equal(l.credits, 0);
    assert.equal(w.wins, 1);
    assert.equal(l.losses, 1);
    // HUMAN HANDS ONLY: both sides here are headless runners (playOneMatch
    // declares agent:true), so the win is recorded but NOTHING mints. This
    // is the anti-farm valve, asserted on a real socket rather than a unit.
    assert.equal(w.tickets, 0, 'a headless runner never mints, even winning');
    assert.equal(l.tickets, 0);

    // BOTH players are now broke — re-queueing must be refused, no charge.
    for (const who of ['Alice', 'BobBot'] as const) {
      await assert.rejects(
        playOneMatch({
          url, name: who, character: 'vector', skill: 20,
          charactersDir, aiSeed: 11, paceMs: 1,
        }),
        /credit/,
      );
      assert.equal((await persistence.getAccount(
        { sub: `dev:${who}` }, 'x', true,
      )).credits, 0);
    }
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
