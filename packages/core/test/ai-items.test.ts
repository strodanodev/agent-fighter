import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  Phase, TUNING, aiPoll, characters, createAi, createGameState, fp,
  setMatchItems, step,
} from '../src/index.js';
import type { AiState, GameState, ItemEffect } from '../src/index.js';

/**
 * THE AI DRINKS (ADR 0009 supporting fix) — a carried can in an AI's hands
 * was dead weight: ai.ts had zero item awareness, so a trained agent or
 * arcade guard pinned with a loadout fought as if its slots were empty.
 *
 * The load-bearing design claim, tested here: the drink triggers are
 * RNG-FREE. An item-less match must consume the AI's rng stream exactly as
 * before, so goldens stay green and a behavior change can never be confused
 * with a stream shift.
 */

const MAXHP = characters[0].b.maxHealth;
const HEAL = (amount: number): ItemEffect => ({ kind: 'heal', amount, durationTicks: 0 });
const MTR = (amount: number): ItemEffect => ({ kind: 'meterGain', amount, durationTicks: 0 });

afterEach(() => setMatchItems(null, null));

const startFight = (seed = 1): GameState => {
  const s = createGameState(seed);
  while (s.phase === Phase.PreRound) step(s, [0, 0]);
  return s;
};

/** Step with the AI driving side 1 and side 0 idle. */
const advAi = (s: GameState, ai: AiState, n: number): void => {
  for (let i = 0; i < n; i++) step(s, [0, aiPoll(ai, s)]);
};

describe('ai: drinks carried cans', () => {
  it('PATCH: heals itself once its health drops under 35%', () => {
    setMatchItems(null, [HEAL(400)]);
    const s = startFight(7);
    const ai = createAi(1, 60, 1234);
    const f = s.fighters[1];
    // Hurt the AI below the emergency line (35% of max), out of range so the
    // idle side-0 dummy can never interfere with the free-ground check.
    f.health = Math.trunc(MAXHP * 0.3);
    s.fighters[0].x = fp(200);
    f.x = fp(1200);
    const before = f.health;
    advAi(s, ai, 240);
    assert.ok(f.health > before, `AI never drank its PATCH (still ${f.health})`);
    assert.equal(f.itemKind0, 0, 'the can was consumed');
  });

  it('VOLT: banks meter in early neutral instead of hoarding the can', () => {
    setMatchItems(null, [MTR(500)]);
    const s = startFight(7);
    const ai = createAi(1, 60, 1234);
    const f = s.fighters[1];
    s.fighters[0].x = fp(200);
    f.x = fp(1200); // far apart = neutral at range
    advAi(s, ai, 300);
    assert.ok(f.meter > 0, 'AI never drank its VOLT');
    assert.equal(f.itemKind0, 0, 'the can was consumed');
  });

  it('RNG-FREE triggers: an item-less match replays bit-identically', () => {
    // Two identical item-less runs, one simulated before any drink logic can
    // matter — if drinkSlot consumed rng (or drank a phantom can), the input
    // streams would diverge. This is the goldens' guarantee in miniature.
    const runInputs = (): number[] => {
      setMatchItems(null, null);
      const s = startFight(3);
      const ai = createAi(1, 70, 4242);
      const out: number[] = [];
      for (let i = 0; i < 600; i++) {
        const frame = aiPoll(ai, s);
        out.push(frame);
        step(s, [0, frame]);
      }
      return out;
    };
    assert.deepEqual(runInputs(), runInputs());
  });
});

describe('ai: coachable thirst (owner feature 2026-07-29)', () => {
  it('a hoarder (thirst 0) sits on a can a guzzler (thirst 255) drinks', () => {
    // Health at 40% of max: inside thirst-255's PATCH window (47.7%), outside
    // thirst-0's (22.2%) — and THIRST_DEFAULT=128 (35%) also refuses, which
    // pins "uncoached == the previously hardcoded doctrine".
    const at40 = (thirst?: number): number => {
      setMatchItems(null, [{ kind: 'heal', amount: 400, durationTicks: 0 }]);
      const s = startFight(11);
      const ai = createAi(1, 60, 999, thirst === undefined ? undefined : { thirst });
      const f = s.fighters[1];
      f.health = Math.trunc(MAXHP * 0.4);
      s.fighters[0].x = fp(200);
      f.x = fp(1200);
      advAi(s, ai, 240);
      setMatchItems(null, null);
      return f.itemKind0; // 0 = drank, 1 = still holding the heal
    };
    assert.equal(at40(255), 0, 'the guzzler drinks at 40%');
    assert.equal(at40(0), 1, 'the hoarder holds at 40%');
    assert.equal(at40(undefined), 1, 'uncoached default holds at 40% (35% line)');
  });
});
