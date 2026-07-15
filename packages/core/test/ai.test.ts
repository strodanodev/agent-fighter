import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  Phase, aiPoll, createAi, createGameState, stateHash, step,
} from '../src/index.js';
import type { AiState, GameState } from '../src/index.js';

/**
 * Bot-vs-bot: the AI is an InputSource, so these double as the balance smoke
 * tests from spec §8 — headless matches far faster than realtime.
 */

interface MatchResult {
  winner: number;
  ticks: number;
  maxCombo: number;
  dmg: [number, number]; // damage DEALT by each side
  hash: number;
}

const runMatch = (seed: number, skill0: number, skill1: number, maxTicks = 60 * 60 * 6): MatchResult => {
  const g: GameState = createGameState(seed);
  const a0: AiState = createAi(0, skill0, seed * 7 + 1);
  const a1: AiState = createAi(1, skill1, seed * 13 + 2);
  let maxCombo = 0;
  const dmg: [number, number] = [0, 0];
  let ph: [number, number] = [g.fighters[0].health, g.fighters[1].health];
  let t = 0;
  while (g.phase !== Phase.MatchOver && t++ < maxTicks) {
    step(g, [aiPoll(a0, g), aiPoll(a1, g)]);
    maxCombo = Math.max(maxCombo, g.fighters[0].comboHits, g.fighters[1].comboHits);
    for (const i of [0, 1] as const) {
      const h = g.fighters[i].health;
      if (h < ph[i]) dmg[1 - i] += ph[i] - h;
      ph[i] = h;
    }
    if (g.phase === Phase.PreRound) ph = [g.fighters[0].health, g.fighters[1].health];
  }
  return { winner: g.winner, ticks: t, maxCombo, dmg, hash: stateHash(g) };
};

describe('AI determinism', () => {
  it('same seeds → bit-identical matches (AI inputs are replayable)', () => {
    const a = runMatch(11, 60, 60);
    const b = runMatch(11, 60, 60);
    assert.equal(a.hash, b.hash);
    assert.equal(a.ticks, b.ticks);
    assert.equal(a.winner, b.winner);
  });

  it('different seeds → different matches (personality/decisions vary)', () => {
    const hashes = new Set([11, 22, 33].map((s) => runMatch(s, 60, 60).hash));
    assert.ok(hashes.size > 1);
  });
});

describe('AI matches complete + stay sane (balance smoke, spec §8)', () => {
  it('bot-vs-bot matches end, both sides land damage, no runaway combos', () => {
    let bothDealt = 0;
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const r = runMatch(seed, 55, 55);
      assert.equal(r.winner === -1, false, `seed ${seed}: match never ended`);
      // Juggle budget + scaling must bound combos (infinite-combo guard).
      assert.ok(r.maxCombo <= 25, `seed ${seed}: runaway combo ${r.maxCombo}`);
      if (r.dmg[0] > 800 && r.dmg[1] > 800) bothDealt++;
    }
    // At equal skill both sides should usually be in the game.
    assert.ok(bothDealt >= 4, `both sides dealt damage in only ${bothDealt}/6 matches`);
  });

  it('low-skill AI still functions (no stalls to double-timeout draws only)', () => {
    const r = runMatch(9, 10, 10);
    assert.notEqual(r.winner, -1);
    assert.ok(r.dmg[0] + r.dmg[1] > 1000, 'nobody did anything all match');
  });
});

describe('the skill lever actually levers', () => {
  it('skill 85 beats skill 25 in a clear majority of matches', () => {
    let wins = 0, decided = 0;
    for (let seed = 1; seed <= 11; seed++) {
      const r = runMatch(seed * 101, 85, 25);
      if (r.winner === 0 || r.winner === 1) {
        decided++;
        if (r.winner === 0) wins++;
      }
    }
    assert.ok(decided >= 8, `too many draws/timeouts: ${decided}/11 decided`);
    assert.ok(wins / decided >= 0.7,
      `skill 85 won only ${wins}/${decided} — lever too weak`);
  });

  it('high skill deals more damage than low skill on average', () => {
    let hi = 0, lo = 0;
    for (const seed of [7, 14, 21, 28]) {
      const r = runMatch(seed, 90, 15);
      hi += r.dmg[0];
      lo += r.dmg[1];
    }
    assert.ok(hi > lo, `high-skill damage ${hi} ≤ low-skill ${lo}`);
  });
});
