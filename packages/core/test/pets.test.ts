import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AURA_MAX, Btn, PET_CRIT_BONUS, PET_REGEN_PERIOD_TICKS, Phase, TUNING,
  characters, clampAura, createGameState, fp, restore, setMatchItems,
  setMatchPets, snapshot, stateHash, step,
} from '../src/index.js';
import type { GameState, InputFrame, PetAura } from '../src/index.js';

/**
 * PET AURAS (ADR 0011). Same harness style as items.test.ts.
 *
 * matchAuras is MODULE state (the setCharacters pattern), so every test must
 * leave it cleared — afterEach guards the rest of the suite.
 */

const MAXHP = characters[0].b.maxHealth;
const JAB = 300; // Analog 5LP damage at full scaling (combat.test.ts contract)

const aura = (a: Partial<PetAura>): PetAura => clampAura(a);

afterEach(() => {
  setMatchPets(null, null);
  setMatchItems(null, null);
});

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

/** P0 jabs P1 once; returns the damage dealt. */
const jabDamage = (s: GameState): number => {
  const before = s.fighters[1].health;
  teleport(s, 770, 840);
  step(s, [Btn.LP, 0]);
  adv(s, 20);
  return before - s.fighters[1].health;
};

describe('pets: the aura is installed, and it never expires', () => {
  it('a pinned aura reaches the fighter at spawn; the other side stays clean', () => {
    setMatchPets(aura({ atk: 80, crit: 40 }), null);
    const s = createGameState(1);
    assert.equal(s.fighters[0].auraAtk, 80);
    assert.equal(s.fighters[0].auraCrit, 40);
    assert.equal(s.fighters[1].auraAtk, 0);
    assert.equal(s.fighters[1].auraCrit, 0);
  });

  it('the aura survives a round reset — unlike a drink, it is never spent', () => {
    setMatchPets(aura({ atk: 80, hpRegen: 50 }), null);
    const s = startFight();
    // Force a round end: KO side 1 outright.
    s.fighters[1].health = 1;
    teleport(s, 770, 840);
    step(s, [Btn.LP, 0]);
    adv(s, 400);
    assert.ok(s.roundNum > 0, 'a round actually ended');
    assert.equal(s.fighters[0].auraAtk, 80, 'atk aura carried into the new round');
    assert.equal(s.fighters[0].auraHpRegen, 50);
    assert.equal(s.fighters[0].auraHpAcc, 0, 'accumulators start the round fresh');
  });

  it('an aura already in flight cannot be re-pinned out from under the match', () => {
    setMatchPets(aura({ atk: 80 }), null);
    const s = startFight();
    setMatchPets(aura({ atk: 10 }), null); // a badly behaved caller, mid-match
    s.fighters[1].health = 1;
    teleport(s, 770, 840);
    step(s, [Btn.LP, 0]);
    adv(s, 400);
    assert.equal(s.fighters[0].auraAtk, 80, 'the running match kept its own pin');
  });
});

describe('pets: damage auras', () => {
  it('+8% ATK scales a clean hit', () => {
    setMatchPets(aura({ atk: 80 }), null);
    const s = startFight();
    assert.equal(jabDamage(s), Math.trunc((JAB * 1080) / 1000));
  });

  it('+8% DEFENSE reduces damage taken', () => {
    setMatchPets(null, aura({ def: 80 }));
    const s = startFight();
    assert.equal(jabDamage(s), Math.trunc((JAB * 920) / 1000));
  });

  it('ATK and DEFENSE compose in a fixed order (attacker first, truncating)', () => {
    setMatchPets(aura({ atk: 80 }), aura({ def: 80 }));
    const s = startFight();
    const expected = Math.trunc((Math.trunc((JAB * 1080) / 1000) * 920) / 1000);
    assert.equal(jabDamage(s), expected);
  });

  it('an aura stacks with a drink without either being lost', () => {
    setMatchPets(aura({ atk: 80 }), null);
    setMatchItems([{ kind: 'damageMult', amount: 100, durationTicks: 600 }], null);
    const s = startFight();
    step(s, [Btn.Item, 0]); // drink the OVERCLOCK
    step(s, [0, 0]);
    const expected = Math.trunc((Math.trunc((JAB * 1080) / 1000) * 1100) / 1000);
    assert.equal(jabDamage(s), expected);
  });
});

describe('pets: the critical aura is random but deterministic', () => {
  /** A guaranteed crit: the roll is `rngSeed % 1000 < chance`. */
  const forceCrit = (s: GameState): void => { s.fighters[0].auraCrit = 1000; };

  it('a crit multiplies the clean hit by PET_CRIT_BONUS and flashes', () => {
    const s = startFight();
    forceCrit(s);
    assert.equal(jabDamage(s), Math.trunc((JAB * (1000 + PET_CRIT_BONUS)) / 1000));
    assert.ok(s.fighters[0].critFlash > 0, 'the renderer is told about it via state');
  });

  it('the flash decays on its own — it is cosmetic, not a buff', () => {
    const s = startFight();
    forceCrit(s);
    jabDamage(s);
    const flash = s.fighters[0].critFlash;
    adv(s, flash + 5);
    assert.equal(s.fighters[0].critFlash, 0);
  });

  it('a pet-less match NEVER advances rngSeed (pre-pet behaviour preserved)', () => {
    const s = startFight(12345);
    const seed = s.rngSeed;
    jabDamage(s);
    adv(s, 120);
    assert.equal(s.rngSeed, seed, 'the seed stayed vestigial without a crit aura');
  });

  it('a crit aura DOES advance the seed, and identically on every re-sim', () => {
    const run = (): GameState => {
      const s = startFight(777);
      s.fighters[0].auraCrit = 300; // ~30%: some hits crit, some do not
      for (let i = 0; i < 12; i++) jabDamage(s);
      return s;
    };
    const a = run();
    const b = run();
    assert.notEqual(a.rngSeed, 777, 'the seed moved');
    assert.equal(stateHash(a), stateHash(b), 'same inputs → same crits → same state');
  });

  it('rollback re-rolls the same crits (snapshot / restore / re-sim)', () => {
    const s = startFight(999);
    s.fighters[0].auraCrit = 500;
    for (let i = 0; i < 4; i++) jabDamage(s);
    const snap = snapshot(s);
    const live: GameState = s;
    for (let i = 0; i < 6; i++) jabDamage(live);
    const after = stateHash(live);
    restore(live, snap);
    for (let i = 0; i < 6; i++) jabDamage(live);
    assert.equal(stateHash(live), after, 'the rolled-back branch replayed identically');
  });
});

describe('pets: regen auras', () => {
  it('HP REGEN pays its full per-mille over one period, exactly', () => {
    setMatchPets(aura({ hpRegen: AURA_MAX }), null);
    const s = startFight();
    s.fighters[0].health = Math.trunc(MAXHP / 2);
    const before = s.fighters[0].health;
    adv(s, PET_REGEN_PERIOD_TICKS);
    assert.equal(
      s.fighters[0].health - before,
      Math.trunc((MAXHP * AURA_MAX) / 1000),
      'one period = one full payout, nothing lost to division',
    );
  });

  it('HP REGEN never overheals and never revives a KO', () => {
    setMatchPets(aura({ hpRegen: AURA_MAX }), null);
    const s = startFight();
    adv(s, 600);
    assert.equal(s.fighters[0].health, MAXHP, 'a healthy fighter stays capped');
    // A downed fighter is not ticked back above zero. (Only the next ROUND
    // restores health — that reset is what `adv` past roundOverTicks would
    // show, and it is not regen.)
    s.fighters[0].health = 0;
    adv(s, 1);
    assert.equal(s.fighters[0].health, 0, 'a KO stays down');
  });

  it('ENERGY REGEN fills meter over the period and clamps at the cap', () => {
    setMatchPets(aura({ energyRegen: AURA_MAX }), null);
    const s = startFight();
    adv(s, PET_REGEN_PERIOD_TICKS);
    assert.equal(s.fighters[0].meter, Math.trunc((TUNING.meterMax * AURA_MAX) / 1000));
    s.fighters[0].meter = TUNING.meterMax;
    adv(s, 600);
    assert.equal(s.fighters[0].meter, TUNING.meterMax);
  });

  it('regen does not tick while the round is not live', () => {
    setMatchPets(aura({ hpRegen: AURA_MAX }), null);
    const s = createGameState(1); // PreRound
    s.fighters[0].health = Math.trunc(MAXHP / 2);
    const before = s.fighters[0].health;
    adv(s, 30); // still inside preRoundTicks
    assert.equal(s.phase, Phase.PreRound);
    assert.equal(s.fighters[0].health, before, 'no regen before the round starts');
  });
});

describe('pets: auras are bounded at the boundary', () => {
  it('clampAura caps every line, floors negatives and survives junk', () => {
    const a = clampAura({ atk: 99999, def: -5, crit: 3.9, hpRegen: NaN } as Partial<PetAura>);
    assert.equal(a.atk, AURA_MAX, 'a hostile pin cannot mint a 10× aura');
    assert.equal(a.def, 0);
    assert.equal(a.crit, 3, 'truncated to an integer — no floats near the sim');
    assert.equal(a.hpRegen, 0);
    assert.equal(a.energyRegen, 0, 'a missing line reads as zero, not NaN');
  });

  it('setMatchPets clamps too — the sim never trusts the pin', () => {
    setMatchPets({ atk: 5000 } as Partial<PetAura>, null);
    const s = createGameState(1);
    assert.equal(s.fighters[0].auraAtk, AURA_MAX);
  });
});
