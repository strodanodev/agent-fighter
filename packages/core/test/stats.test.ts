import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ANALOG, Btn, ENGINE_VERSION, Phase, ROUND_SECONDS, STAT_FIELDS, STATS_SCHEMA, TICKS_PER_SEC,
  TUNING, characters, createGameState, fp, legacyStateHash, loadCharacter, matchStats,
  restore, serialize, snapshot, stateHash, step,
} from '../src/index.js';
import type { GameState, InputFrame } from '../src/index.js';
import { SCENARIOS, makeInputScript } from './golden/scenarios.js';

/**
 * MATCH STATS (settlement v4, af-core-9) and per-match pins.
 *
 * The stats are a consensus surface: litnode witnesses recompute them by
 * replaying the signed log, and they fold into an hourly root on EpochAnchor.
 * So this file pins three things:
 *   1. they are pure OBSERVERS — the game plays identically with them
 *      scrambled, and af-core-8's hashes are still reproducible;
 *   2. each one counts what its name says;
 *   3. matches created with their own pins can interleave in one process.
 */

const MAXHP = characters[0].b.maxHealth;
const ROUND_CLOCK = ROUND_SECONDS * TICKS_PER_SEC;

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

const fold = (acc: number, v: number): number => {
  let h = acc >>> 0;
  for (let byte = 0; byte < 4; byte++) {
    h ^= (v >>> (byte * 8)) & 0xff;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
};

describe('match stats are pure observers', () => {
  it('scrambling every stat field every tick changes nothing else, ever', () => {
    let seed = 0x5eed;
    const junk = (): number => (seed = (Math.imul(seed, 1664525) + 1013904223) | 0) & 0xffff;
    for (const sc of SCENARIOS.slice(0, 4)) {
      const clean = createGameState(sc.seed);
      const dirty = createGameState(sc.seed);
      for (const inputs of makeInputScript(sc.inputSeed, sc.ticks)) {
        for (const f of dirty.fighters) for (const k of STAT_FIELDS) f[k] = junk();
        step(clean, inputs);
        step(dirty, inputs);
        assert.equal(legacyStateHash(dirty), legacyStateHash(clean),
          `${sc.name} tick ${clean.tick}: a stat field leaked into the simulation`);
      }
    }
  });

  // The af-core-8 golden hashes, as committed before the stats existed. The
  // new engine, hashed without its stat fields, must still produce every one
  // of them — final AND per-tick trace. That is the proof the bump changed
  // the bytes, not the game. An intended behaviour change in a later engine
  // retires this block (and legacyStateHash's use for af-core-8 replays).
  const AF_CORE_8: Record<string, [number, number]> = {
    'neutral-short': [4214187224, 1293372196],
    'exchange-mid': [1713896692, 2226795882],
    'full-match-a': [3047395795, 3451908700],
    'full-match-b': [1673420386, 2583549703],
    'mash-heavy': [3042999083, 3156628925],
    'long-run': [4253708601, 3818224202],
  };

  it(`${ENGINE_VERSION} hashed as af-core-8 reproduces every af-core-8 golden`, () => {
    for (const sc of SCENARIOS) {
      const s = createGameState(sc.seed);
      let trace = 0x811c9dc5 >>> 0;
      for (const inputs of makeInputScript(sc.inputSeed, sc.ticks)) {
        step(s, inputs);
        trace = fold(trace, legacyStateHash(s));
      }
      const [final, tr] = AF_CORE_8[sc.name]!;
      assert.equal(trace, tr, `${sc.name}: af-core-8 trace hash not reproduced`);
      assert.equal(legacyStateHash(s), final, `${sc.name}: af-core-8 final hash not reproduced`);
    }
  });

  it('the stats ARE in the af-core-9 hash (witnesses commit to them)', () => {
    const s = startFight();
    const before = stateHash(s);
    const legacyBefore = legacyStateHash(s);
    s.fighters[0].stDamage += 1;
    assert.notEqual(stateHash(s), before);
    assert.equal(legacyStateHash(s), legacyBefore, 'the af-core-8 view ignores stats');
  });
});

describe('match stats count what their names say', () => {
  it('damageDealt is the health actually removed, maxCombo the hits in a row', () => {
    const s = startFight();
    teleport(s, 770, 840);
    step(s, [Btn.LP, 0]);
    adv(s, 20);
    const dealt = MAXHP - s.fighters[1].health;
    assert.ok(dealt > 0, 'the jab landed');
    assert.equal(s.fighters[0].stDamage, dealt);
    assert.equal(s.fighters[0].stMaxCombo, 1);
    assert.equal(s.fighters[1].stDamage, 0, 'the victim dealt nothing');
    assert.equal(s.fighters[1].stTouched, 1);
    assert.equal(s.fighters[0].stTouched, 0);
  });

  it('a KO counts once, records its round-clock time, and overkill is not damage', () => {
    const s = startFight();
    s.fighters[1].health = 1;
    teleport(s, 770, 840);
    step(s, [Btn.LP, 0]);
    adv(s, 20);
    assert.equal(s.phase === Phase.RoundOver || s.roundNum > 0, true, 'the round ended');
    assert.equal(s.fighters[0].stKos, 1);
    assert.equal(s.fighters[0].stDamage, 1, 'only the last point of health counts');
    assert.ok(s.fighters[0].stFastestKo > 0 && s.fighters[0].stFastestKo <= ROUND_CLOCK);
    assert.equal(s.fighters[0].stPerfects, 1, 'won without being touched');
    assert.equal(s.fighters[1].stKos, 0);
    assert.equal(s.fighters[1].stFastestKo, 0);
  });

  it('stats survive the round reset; the per-round touched flag does not', () => {
    const s = startFight();
    s.fighters[1].health = 1;
    teleport(s, 770, 840);
    step(s, [Btn.LP, 0]);
    adv(s, 400);
    assert.ok(s.roundNum > 0, 'a new round started');
    assert.equal(s.fighters[0].stKos, 1);
    assert.equal(s.fighters[0].stPerfects, 1);
    assert.equal(s.fighters[1].stTouched, 0, 'touched resets with the round');
  });

  it('a round won after taking damage is not perfect; a time-out win can be', () => {
    const s = startFight();
    teleport(s, 770, 840);
    step(s, [0, Btn.LP]); // P1 tags P0 first
    adv(s, 20);
    assert.equal(s.fighters[0].stTouched, 1);
    s.fighters[1].health = 1;
    teleport(s, 770, 840);
    step(s, [Btn.LP, 0]);
    adv(s, 20);
    assert.equal(s.fighters[0].stKos, 1);
    assert.equal(s.fighters[0].stPerfects, 0);

    const t = startFight();
    t.fighters[1].health = MAXHP - 1; // P0 ahead on life, nobody touched P0
    t.timerTicks = 2;
    adv(t, 3);
    assert.equal(t.roundWinner, 0);
    assert.equal(t.fighters[0].stKos, 0, 'a time-out is not a KO');
    assert.equal(t.fighters[0].stPerfects, 1);
  });

  it('a super lands once, however many hits it has', () => {
    const s = startFight();
    teleport(s, 700, 840);
    s.fighters[0].meter = TUNING.meterBar;
    step(s, [Btn.Down, 0]);
    step(s, [Btn.Down | Btn.Right, 0]);
    step(s, [Btn.Right, 0]);
    step(s, [Btn.Right | Btn.LP | Btn.MP, 0]);
    adv(s, TUNING.superFlashTicks - 1, 0, Btn.Right | Btn.Left); // frozen
    adv(s, 150); // the victim stands still: every hit is clean
    assert.ok(s.fighters[0].stMaxCombo >= 3, `multi-hit super (${s.fighters[0].stMaxCombo})`);
    assert.equal(s.fighters[0].stSupers, 1);
  });

  it('a teched throw credits the victim with a tech and the thrower with nothing', () => {
    const s = startFight();
    teleport(s, 790, 845);
    step(s, [Btn.Right | Btn.HP, 0]);
    step(s, [Btn.Right, Btn.HP]);
    adv(s, 3);
    assert.equal(s.fighters[1].stTechs, 1);
    assert.equal(s.fighters[0].stDamage, 0);
  });

  it('a landed throw is damage and a one-hit combo', () => {
    const s = startFight();
    teleport(s, 790, 845);
    step(s, [Btn.Right | Btn.HP, 0]);
    adv(s, 60);
    assert.equal(s.fighters[0].stDamage, characters[0].b.throwDamage);
    assert.equal(s.fighters[0].stMaxCombo, 1);
  });

  it('matchStats names the schema, integers only, fastestKo absent when unset', () => {
    const s = startFight();
    s.fighters[1].health = 1;
    teleport(s, 770, 840);
    step(s, [Btn.LP, 0]);
    adv(s, 20);
    const [a, b] = matchStats(s);
    for (const line of [a, b]) {
      for (const [k, v] of Object.entries(line)) {
        assert.ok(k in STATS_SCHEMA, `${k} is in the schema`);
        assert.match(k, /^[a-zA-Z][a-zA-Z0-9]{0,31}$/);
        assert.ok(Number.isSafeInteger(v) && v >= 0, `${k}=${v} is a non-negative integer`);
      }
    }
    assert.equal(a.kos, 1);
    assert.equal(a.roundsWon, 1);
    assert.equal(typeof a.fastestKo, 'number');
    assert.equal('fastestKo' in b, false, 'no KO → no fastestKo for min to fold');
    for (const name of Object.keys(STATS_SCHEMA)) {
      assert.ok(!['matches', 'wins', 'ticks'].includes(name), `${name} shadows a built-in`);
    }
  });
});

describe('per-match pins (createGameState pins / GameState.chars)', () => {
  // A heavier, slower second bundle so the two matches genuinely differ.
  const HEAVY = loadCharacter({ ...ANALOG, id: 'heavy', maxHealth: 12000, gravity: ANALOG.gravity * 1.25 });
  const LIGHT = loadCharacter(ANALOG);
  const DRINK = [{ kind: 'damageMult' as const, amount: 200, durationTicks: 600 }];

  const runAlone = (mk: () => GameState, sc: (typeof SCENARIOS)[number]): number => {
    const s = mk();
    for (const inputs of makeInputScript(sc.inputSeed, sc.ticks)) step(s, inputs);
    return stateHash(s);
  };

  it('two matches with different pins interleave in one process without crosstalk', () => {
    const scA = SCENARIOS[2]!;
    const scB = SCENARIOS[3]!;
    const mkA = (): GameState => createGameState(scA.seed, undefined, { chars: [LIGHT, HEAVY] });
    const mkB = (): GameState => createGameState(scB.seed, undefined, {
      chars: [HEAVY, LIGHT], items: [DRINK, null], pets: [null, { atk: 60, crit: 40 }],
    });
    const aloneA = runAlone(mkA, scA);
    const aloneB = runAlone(mkB, scB);

    const a = mkA();
    const b = mkB();
    const ia = makeInputScript(scA.inputSeed, scA.ticks);
    const ib = makeInputScript(scB.inputSeed, scB.ticks);
    for (let t = 0; t < Math.max(ia.length, ib.length); t++) {
      if (t < ia.length) step(a, ia[t]!);
      if (t < ib.length) step(b, ib[t]!);
    }
    assert.equal(stateHash(a), aloneA, 'match A was disturbed by match B');
    assert.equal(stateHash(b), aloneB, 'match B was disturbed by match A');
    assert.equal(b.fighters[0].itemKind0, 2, 'B carried its own drink');
    assert.equal(a.fighters[0].itemKind0, 0, 'A carried none');
  });

  it('pins are honoured over the process defaults, and a JSON copy stays a bag of numbers', () => {
    const s = createGameState(5, undefined, { chars: [HEAVY, LIGHT] });
    assert.equal(s.fighters[0].health, 12000);
    assert.equal(s.chars[0], HEAVY);
    assert.equal(Object.keys(s).includes('chars'), false, 'chars is non-enumerable');
    assert.equal(JSON.stringify(s).includes('"moves"'), false, 'no bundle leaks into JSON');
    // snapshot/restore carry the pins (rollback stays on the match's own characters)
    const snap = snapshot(s);
    assert.equal(snap.chars, s.chars);
    for (let i = 0; i < 300; i++) step(s, [Btn.Right, 0]);
    const live = createGameState(5);
    restore(live, snap);
    assert.equal(live.chars[0], HEAVY, 'restore installs the snapshot pins');
    assert.deepEqual(Array.from(serialize(live)), Array.from(serialize(snap)));
  });

  it('pinned drinks and auras are clamped exactly like the setters clamp them', () => {
    const s = createGameState(1, undefined, {
      items: [[{ kind: 'heal', amount: 99999, durationTicks: 999999 }], null],
      pets: [{ atk: 9999 }, null],
    });
    assert.equal(s.fighters[0].itemAmount0, 500);
    assert.equal(s.fighters[0].itemDur0, 7200);
    assert.ok(s.fighters[0].auraAtk <= 80);
  });
});
