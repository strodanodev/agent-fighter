import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  Action, Btn, Phase, TUNING, characters, createGameState, fp, resetRound, setMatchItems, step,
} from '../src/index.js';
import type { GameState, InputFrame, ItemEffect } from '../src/index.js';

/**
 * CONSUMABLE ITEMS (ADR 0007, af-core-5 shape) — up to THREE equipped
 * drinks per fighter, each drunk by its own input bit (Btn.Item/Item2/
 * Item3). Same harness style as combat.test.ts.
 *
 * matchItems is MODULE state (the setCharacters pattern), so every test
 * must leave it cleared — afterEach guards the rest of the suite.
 */

const MAXHP = characters[0].b.maxHealth;
const JAB = 300; // Analog 5LP damage at full scaling (combat.test.ts contract)

const HEAL = (amount: number): ItemEffect => ({ kind: 'heal', amount, durationTicks: 0 });
const DMG = (amount: number, dur = 600): ItemEffect => ({ kind: 'damageMult', amount, durationTicks: dur });
const DEF = (amount: number, dur = 600): ItemEffect => ({ kind: 'defenseMult', amount, durationTicks: dur });
const MTR = (amount: number): ItemEffect => ({ kind: 'meterGain', amount, durationTicks: 0 });

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

/** Press one drink bit for a tick while idle (rising edge → drinks it). */
const drinkP0 = (s: GameState, bit: number = Btn.Item): void => {
  step(s, [bit, 0]);
  step(s, [0, 0]);
};

const jabP0 = (s: GameState): void => {
  teleport(s, 770, 840);
  step(s, [Btn.LP, 0]);
  adv(s, 20);
};

describe('items: 3-slot carry', () => {
  it('a full loadout is carried at spawn — no effect until pressed', () => {
    setMatchItems([HEAL(350), DMG(100), MTR(500)], null);
    const s = createGameState(1);
    const f = s.fighters[0];
    assert.equal(f.health, MAXHP, 'no auto-effects at spawn');
    assert.deepEqual([f.itemKind0, f.itemKind1, f.itemKind2], [1, 2, 4]);
    assert.equal(s.fighters[1].itemKind0, 0, 'opponent carries nothing');
  });

  it('each slot answers only ITS bit', () => {
    setMatchItems([MTR(100), MTR(200), MTR(300)], null);
    const s = startFight();
    drinkP0(s, Btn.Item2); // middle slot only
    const f = s.fighters[0];
    assert.equal(f.meter, 200, 'slot 1 drank');
    assert.deepEqual([f.itemKind0, f.itemKind1, f.itemKind2], [4, 0, 4], 'slots 0/2 still carried');
  });

  it('a 4th pinned drink is clamped away (loadout ≤ 3)', () => {
    setMatchItems([MTR(1), MTR(2), MTR(3), MTR(4)] as ItemEffect[], null);
    const s = createGameState(1);
    assert.equal(s.fighters[0].itemKind2, 4, 'slot 2 exists');
    // Nothing to assert for slot 3 — the field doesn't exist; the clamp is
    // that only three slots ever load.
  });

  it('no items = the exact pre-item jab (strictly additive change)', () => {
    const s = startFight();
    jabP0(s);
    assert.equal(s.fighters[1].health, MAXHP - JAB);
  });
});

describe('items: activation effects', () => {
  it('HEAL restores health, capped at max', () => {
    setMatchItems([HEAL(350)], null);
    const s = startFight();
    s.fighters[0].health = 4000;
    drinkP0(s);
    assert.equal(s.fighters[0].health, 4000 + Math.trunc((MAXHP * 350) / 1000));
    assert.equal(s.fighters[0].itemKind0, 0, 'slot spent');
  });

  it('OVERCLOCK scales damage only AFTER drinking', () => {
    setMatchItems([DMG(100)], null);
    const s = startFight();
    jabP0(s);
    assert.equal(s.fighters[1].health, MAXHP - JAB, 'undrunk = no buff');
    s.fighters[1].health = MAXHP;
    drinkP0(s);
    jabP0(s);
    assert.equal(s.fighters[1].health, MAXHP - Math.trunc((JAB * 1100) / 1000));
  });

  it('OVERCLOCK and FIREWALL run on INDEPENDENT timers (they coexist)', () => {
    setMatchItems([DMG(100, 600), DEF(100, 50)], null);
    const s = startFight();
    drinkP0(s, Btn.Item); // dmg, 600 ticks
    drinkP0(s, Btn.Item2); // def, 50 ticks
    const f = s.fighters[0];
    assert.ok(f.itemDmgLeft > 0 && f.itemDefLeft > 0, 'both live');
    adv(s, 60); // def expires, dmg keeps running
    assert.equal(f.itemDefLeft, 0, 'FIREWALL expired');
    assert.ok(f.itemDmgLeft > 0, 'OVERCLOCK still live');
    jabP0(s);
    assert.equal(s.fighters[1].health, MAXHP - Math.trunc((JAB * 1100) / 1000),
      'damage buff still applies after the defense buff died');
  });

  it('re-drinking a kind REFRESHES the timer, never stacks the amount', () => {
    setMatchItems([DMG(100, 100), DMG(150, 600)], null);
    const s = startFight();
    drinkP0(s, Btn.Item);
    adv(s, 80); // first buff nearly out
    drinkP0(s, Btn.Item2);
    const f = s.fighters[0];
    assert.equal(f.itemDmg, 150, 'amount REPLACED (the newer drink), not 250');
    assert.ok(f.itemDmgLeft > 500, 'timer refreshed to the new duration');
  });

  it('VOLT grants meter, clamped to the cap', () => {
    setMatchItems([MTR(500)], null);
    const s = startFight();
    s.fighters[0].meter = TUNING.meterMax - 100;
    drinkP0(s);
    assert.equal(s.fighters[0].meter, TUNING.meterMax);
  });
});

describe('items: rules + persistence', () => {
  it('cannot drink mid-attack (free ground states only)', () => {
    setMatchItems([MTR(500)], null);
    const s = startFight();
    step(s, [Btn.LP, 0]);
    adv(s, 3);
    assert.equal(s.fighters[0].action, Action.Attack, 'setup: actually attacking');
    step(s, [Btn.Item, 0]);
    assert.equal(s.fighters[0].itemKind0, 4, 'drink still carried — no mid-move sip');
    assert.ok(s.fighters[0].meter < 500, 'the 500-meter grant did not fire');
  });

  it('cannot drink mid-air', () => {
    setMatchItems([MTR(500)], null);
    const s = startFight();
    adv(s, 8, Btn.Up, 0);
    assert.equal(s.fighters[0].action, Action.Air, 'setup: airborne');
    step(s, [Btn.Item, 0]);
    assert.equal(s.fighters[0].itemKind0, 4, 'no sipping in the air');
  });

  it('a spent slot stays spent; pressing again does nothing', () => {
    setMatchItems([MTR(500)], null);
    const s = startFight();
    drinkP0(s);
    assert.equal(s.fighters[0].meter, 500);
    drinkP0(s);
    assert.equal(s.fighters[0].meter, 500, 'no second grant');
  });

  it('UNDRUNK slots survive a round reset; DRUNK stay spent; buffs do not carry', () => {
    setMatchItems([HEAL(200), DMG(150, 900), MTR(500)], null);
    const s = startFight();
    drinkP0(s, Btn.Item2); // arm the dmg buff, spend slot 1
    assert.ok(s.fighters[0].itemDmgLeft > 0);
    resetRound(s);
    const f = s.fighters[0];
    assert.equal(f.itemKind0, 1, 'heal still carried next round');
    assert.equal(f.itemKind1, 0, 'drunk slot stays spent');
    assert.equal(f.itemKind2, 4, 'meter still carried');
    assert.equal(f.itemDmgLeft, 0, 'buff timer resets with the round');
    assert.equal(f.itemDmg, 0);
  });
});

describe('items: determinism + clamps', () => {
  it('setMatchItems clamps hostile pins (amount ≤ 500, duration ≤ 7200)', () => {
    setMatchItems([DMG(99999, 999999)], null);
    const s = createGameState(1);
    assert.equal(s.fighters[0].itemAmount0, 500);
    assert.equal(s.fighters[0].itemDur0, 7200);
  });

  it('same loadout + same presses → bit-identical replay', () => {
    setMatchItems(
      [DMG(150, 900), HEAL(200), MTR(400)],
      [DEF(100, 600)],
    );
    const run = (): number => {
      const s = createGameState(77);
      for (let i = 0; i < 900; i++) {
        const p0 = i === 120 ? Btn.Item : i === 300 ? Btn.Item2 : i === 500 ? Btn.Item3
          : (i >> 2) % 3 === 0 ? Btn.Right | Btn.LP : Btn.Right;
        step(s, [p0, i === 140 ? Btn.Item : Btn.Left]);
      }
      return s.fighters[0].health * 1e9 + s.fighters[1].health * 1e3 + s.tick;
    };
    assert.equal(run(), run());
  });
});
