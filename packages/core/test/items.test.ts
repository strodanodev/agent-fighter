import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  Btn, Phase, TUNING, characters, createGameState, fp, resetRound, setMatchItems, step,
} from '../src/index.js';
import type { GameState, InputFrame } from '../src/index.js';

/**
 * CONSUMABLE ITEMS (ADR 0007 Phase 2) — the pinned pre-match drink loadout
 * interpreted by the sim. Same harness style as combat.test.ts: drive
 * step() with scripted inputs, teleport as setup.
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

const jabP0 = (s: GameState): void => {
  teleport(s, 770, 840);
  step(s, [Btn.LP, 0]);
  adv(s, 20);
};

describe('items: buffs scale strike() exactly', () => {
  it('OVERCLOCK (+10% damage) — jab deals trunc(300 × 1.1)', () => {
    setMatchItems({ kind: 'damageMult', amount: 100, durationTicks: 600 }, null);
    const s = startFight();
    jabP0(s);
    assert.equal(s.fighters[1].health, MAXHP - Math.trunc((JAB * 1100) / 1000)); // 330
  });

  it('FIREWALL (−10% taken) — jab against it deals trunc(300 × 0.9)', () => {
    setMatchItems(null, { kind: 'defenseMult', amount: 100, durationTicks: 600 });
    const s = startFight();
    jabP0(s);
    assert.equal(s.fighters[1].health, MAXHP - Math.trunc((JAB * 900) / 1000)); // 270
  });

  it('OVERCLOCK vs FIREWALL stack multiplicatively, attacker first', () => {
    setMatchItems(
      { kind: 'damageMult', amount: 100, durationTicks: 600 },
      { kind: 'defenseMult', amount: 100, durationTicks: 600 },
    );
    const s = startFight();
    jabP0(s);
    // trunc(trunc(300·1.1)·0.9) = trunc(330·0.9) = 297
    assert.equal(s.fighters[1].health, MAXHP - 297);
  });

  it('no items = the exact pre-item jab (strictly additive change)', () => {
    const s = startFight();
    jabP0(s);
    assert.equal(s.fighters[1].health, MAXHP - JAB);
  });
});

describe('items: instant effects at spawn', () => {
  it('PATCH grants bonus starting health each round (over max, bar drains normally)', () => {
    setMatchItems({ kind: 'heal', amount: 350, durationTicks: 0 }, null);
    const s = createGameState(1);
    const boosted = Math.trunc((MAXHP * 1350) / 1000);
    assert.equal(s.fighters[0].health, boosted);
    assert.equal(s.fighters[1].health, MAXHP); // opponent unboosted
    // Round reset re-arms the head start (round-scoped, like the buffs).
    s.fighters[0].health = 1;
    resetRound(s);
    assert.equal(s.fighters[0].health, boosted);
  });

  it('VOLT grants meter once at MATCH start; round reset keeps the live meter', () => {
    setMatchItems({ kind: 'meterGain', amount: 500, durationTicks: 0 }, null);
    const s = createGameState(1);
    assert.equal(s.fighters[0].meter, 500);
    assert.equal(s.fighters[1].meter, 0);
    s.fighters[0].meter = 120; // spent some
    resetRound(s);
    assert.equal(s.fighters[0].meter, 120); // no re-grant
  });
});

describe('items: buff lifetime + boundary clamps', () => {
  it('buff ticks only during live fighting and expires after durationTicks', () => {
    setMatchItems({ kind: 'damageMult', amount: 100, durationTicks: 30 }, null);
    const s = createGameState(1);
    assert.equal(s.fighters[0].itemBuffLeft, 30);
    while (s.phase === Phase.PreRound) step(s, [0, 0]);
    // Pre-round burned nothing — the countdown starts at FIGHT.
    assert.equal(s.fighters[0].itemBuffLeft, 30);
    adv(s, 31);
    assert.equal(s.fighters[0].itemBuffLeft, 0);
    jabP0(s); // buff expired → base damage
    assert.equal(s.fighters[1].health, MAXHP - JAB);
  });

  it('setMatchItems clamps hostile pins (amount ≤ 500, duration ≤ 7200)', () => {
    setMatchItems({ kind: 'damageMult', amount: 99999, durationTicks: 999999 }, null);
    const s = createGameState(1);
    assert.equal(s.fighters[0].itemDmg, 500);
    assert.equal(s.fighters[0].itemBuffLeft, 7200);
    // Negative amounts can't heal-on-hit or invert defense (audit lesson).
    setMatchItems({ kind: 'defenseMult', amount: -500, durationTicks: 600 }, null);
    const s2 = createGameState(1);
    assert.equal(s2.fighters[0].itemDef, 0);
  });

  it('same items → bit-identical replay (determinism holds with buffs live)', () => {
    setMatchItems(
      { kind: 'damageMult', amount: 150, durationTicks: 900 },
      { kind: 'heal', amount: 200, durationTicks: 0 },
    );
    const run = (): number => {
      const s = createGameState(77);
      for (let i = 0; i < 900; i++) {
        step(s, [(i >> 2) % 3 === 0 ? Btn.Right | Btn.LP : Btn.Right, Btn.Left]);
      }
      return s.fighters[0].health * 1e9 + s.fighters[1].health * 1e3 + s.tick;
    };
    assert.equal(run(), run());
  });
});
