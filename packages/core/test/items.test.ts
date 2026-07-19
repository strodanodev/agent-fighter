import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  Action, Btn, Phase, TUNING, characters, createGameState, fp, resetRound, setMatchItems, step,
} from '../src/index.js';
import type { GameState, InputFrame } from '../src/index.js';

/**
 * CONSUMABLE ITEMS (ADR 0007 Phase 3) — the carried drink is DRUNK on the
 * Btn.Item press, not auto-applied at spawn. Same harness as combat.test.ts:
 * drive step() with scripted inputs, teleport as setup.
 *
 * matchItems is MODULE state (the setCharacters pattern), so every test
 * must leave it cleared — afterEach guards the rest of the suite.
 */

const MAXHP = characters[0].b.maxHealth;
const JAB = 300; // Analog 5LP damage at full scaling (combat.test.ts contract)

afterEach(() => setMatchItems(null, null));

const startFight = (seed = 1): GameState => {
  const s = createGameState(seed);
  while (s.phase === Phase.PreRound) step(s, [0, 0]);
  return s;
};

const adv = (s: GameState, n: number, a: InputFrame = 0, b: InputFrame = 0): void => {
  for (let i = 0; i < n; i++) step(s, [a, b]);
};

const teleport = (s: GameState, x0: number, x1: number): void => {
  s.fighters[0].x = fp(x0);
  s.fighters[1].x = fp(x1);
  adv(s, 1);
};

/** Press Item for one tick while idle (rising edge → drinks the can). */
const drinkP0 = (s: GameState): void => {
  step(s, [Btn.Item, 0]);
  step(s, [0, 0]); // release, so a follow-up press would be a fresh edge
};

const jabP0 = (s: GameState): void => {
  teleport(s, 770, 840);
  step(s, [Btn.LP, 0]);
  adv(s, 20);
};

describe('items: carried, not spawned', () => {
  it('a drink is CARRIED at spawn — no effect until pressed', () => {
    setMatchItems({ kind: 'heal', amount: 350, durationTicks: 0 }, null);
    const s = createGameState(1);
    assert.equal(s.fighters[0].health, MAXHP, 'no overheal at spawn anymore');
    assert.equal(s.fighters[0].itemKind, 1, 'carried heal drink (kind 1)');
    assert.equal(s.fighters[0].itemAmount, 350);
    assert.equal(s.fighters[1].itemKind, 0, 'opponent carries nothing');
  });

  it('no items = the exact pre-item jab (strictly additive change)', () => {
    const s = startFight();
    jabP0(s);
    assert.equal(s.fighters[1].health, MAXHP - JAB);
  });
});

describe('items: activation effects', () => {
  it('HEAL restores health when drunk, capped at max (no mid-fight overheal)', () => {
    setMatchItems({ kind: 'heal', amount: 350, durationTicks: 0 }, null);
    const s = startFight();
    s.fighters[0].health = 4000; // hurt first
    drinkP0(s);
    assert.equal(s.fighters[0].health, 4000 + Math.trunc((MAXHP * 350) / 1000)); // 4000 + 3500
    assert.equal(s.fighters[0].itemKind, 0, 'drink spent');
    // A full-health drink is capped (wasted) — you can't exceed max.
    setMatchItems({ kind: 'heal', amount: 350, durationTicks: 0 }, null);
    const s2 = startFight();
    drinkP0(s2);
    assert.equal(s2.fighters[0].health, MAXHP, 'capped at full');
  });

  it('OVERCLOCK (+10%) only scales damage AFTER it is drunk', () => {
    setMatchItems({ kind: 'damageMult', amount: 100, durationTicks: 600 }, null);
    const s = startFight();
    // Before drinking: a jab is base damage.
    jabP0(s);
    assert.equal(s.fighters[1].health, MAXHP - JAB, 'undrunk = no buff');
    // Drink, then the next jab is boosted.
    s.fighters[1].health = MAXHP;
    drinkP0(s);
    assert.equal(s.fighters[0].itemDmg, 100);
    assert.ok(s.fighters[0].itemBuffLeft > 0);
    jabP0(s);
    assert.equal(s.fighters[1].health, MAXHP - Math.trunc((JAB * 1100) / 1000)); // 330
  });

  it('FIREWALL (−10% taken) only reduces damage AFTER the victim drinks it', () => {
    setMatchItems(null, { kind: 'defenseMult', amount: 100, durationTicks: 600 });
    const s = startFight();
    // P1 drinks its own can (press Item on side 1 while idle).
    step(s, [0, Btn.Item]);
    step(s, [0, 0]);
    assert.equal(s.fighters[1].itemDef, 100);
    jabP0(s);
    assert.equal(s.fighters[1].health, MAXHP - Math.trunc((JAB * 900) / 1000)); // 270
  });

  it('VOLT grants meter when drunk, clamped to the bar cap', () => {
    setMatchItems({ kind: 'meterGain', amount: 500, durationTicks: 0 }, null);
    const s = startFight();
    assert.equal(s.fighters[0].meter, 0, 'no meter until drunk');
    drinkP0(s);
    assert.equal(s.fighters[0].meter, 500);
    // Near-full: the grant clamps.
    setMatchItems({ kind: 'meterGain', amount: 500, durationTicks: 0 }, null);
    const s2 = startFight();
    s2.fighters[0].meter = TUNING.meterMax - 100;
    drinkP0(s2);
    assert.equal(s2.fighters[0].meter, TUNING.meterMax);
  });
});

describe('items: rules + persistence', () => {
  it('cannot drink mid-attack (free ground states only)', () => {
    setMatchItems({ kind: 'meterGain', amount: 500, durationTicks: 0 }, null);
    const s = startFight();
    step(s, [Btn.LP, 0]); // throw a jab
    adv(s, 3); // firmly inside the attack (startup + active)
    assert.equal(s.fighters[0].action, Action.Attack, 'setup: actually attacking');
    step(s, [Btn.Item, 0]); // press Item mid-move
    assert.equal(s.fighters[0].itemKind, 4, 'drink still carried — no mid-move sip');
    // Meter builds a little from the whiffed jab, but NOT the +500 VOLT grant.
    assert.ok(s.fighters[0].meter < 500, 'the 500-meter grant did not fire');
  });

  it('cannot drink mid-air', () => {
    setMatchItems({ kind: 'meterGain', amount: 500, durationTicks: 0 }, null);
    const s = startFight();
    adv(s, 8, Btn.Up, 0); // jump — now airborne
    assert.equal(s.fighters[0].action, Action.Air, 'setup: airborne');
    step(s, [Btn.Item, 0]);
    assert.equal(s.fighters[0].itemKind, 4, 'no sipping in the air');
  });

  it('one can per MATCH: pressing again after drinking does nothing', () => {
    setMatchItems({ kind: 'meterGain', amount: 500, durationTicks: 0 }, null);
    const s = startFight();
    drinkP0(s);
    assert.equal(s.fighters[0].meter, 500);
    drinkP0(s); // second press, nothing left
    assert.equal(s.fighters[0].meter, 500, 'no second grant');
  });

  it('an UNDRUNK drink survives a round reset (carry it into the next round)', () => {
    setMatchItems({ kind: 'heal', amount: 200, durationTicks: 0 }, null);
    const s = createGameState(1);
    assert.equal(s.fighters[0].itemKind, 1);
    resetRound(s);
    assert.equal(s.fighters[0].itemKind, 1, 'still carried next round');
    assert.equal(s.fighters[0].itemAmount, 200);
  });

  it('a DRUNK drink stays spent across a round reset', () => {
    setMatchItems({ kind: 'meterGain', amount: 500, durationTicks: 0 }, null);
    const s = startFight();
    drinkP0(s);
    assert.equal(s.fighters[0].itemKind, 0);
    resetRound(s);
    assert.equal(s.fighters[0].itemKind, 0, 'no drink respawns next round');
  });

  it('an armed buff does NOT carry across a round reset', () => {
    setMatchItems({ kind: 'damageMult', amount: 150, durationTicks: 900 }, null);
    const s = startFight();
    drinkP0(s);
    assert.ok(s.fighters[0].itemBuffLeft > 0);
    resetRound(s);
    assert.equal(s.fighters[0].itemBuffLeft, 0, 'buff timer resets with the round');
    assert.equal(s.fighters[0].itemDmg, 0);
  });
});

describe('items: determinism + clamps', () => {
  it('setMatchItems clamps hostile pins (amount ≤ 500, duration ≤ 7200)', () => {
    setMatchItems({ kind: 'damageMult', amount: 99999, durationTicks: 999999 }, null);
    const s = createGameState(1);
    assert.equal(s.fighters[0].itemAmount, 500);
    assert.equal(s.fighters[0].itemDur, 7200);
  });

  it('same items + same presses → bit-identical replay', () => {
    setMatchItems(
      { kind: 'damageMult', amount: 150, durationTicks: 900 },
      { kind: 'heal', amount: 200, durationTicks: 0 },
    );
    const run = (): number => {
      const s = createGameState(77);
      for (let i = 0; i < 900; i++) {
        // Both sides drink around tick 120 (idle window at match start).
        const drink = i === 120;
        step(s, [
          (i >> 2) % 3 === 0 ? Btn.Right | Btn.LP : (drink ? Btn.Item : Btn.Right),
          drink ? Btn.Item : Btn.Left,
        ]);
      }
      return s.fighters[0].health * 1e9 + s.fighters[1].health * 1e3 + s.tick;
    };
    assert.equal(run(), run());
  });
});
