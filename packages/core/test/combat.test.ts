import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  Action, Btn, Phase, TUNING, characters, createGameState, fp, fpToPx, loadCharacter, setCharacters, step,
} from '../src/index.js';
import type { CharacterBundle, GameState, HitboxDef, InputFrame } from '../src/index.js';

/**
 * M1 combat mechanics coverage. These tests drive the sim exclusively through
 * step() with scripted InputFrames (positions may be teleported between ticks
 * as scenario setup — position is plain state).
 */

const MAXHP = characters[0].b.maxHealth;

const startFight = (seed = 1): GameState => {
  const s = createGameState(seed);
  while (s.phase === Phase.PreRound) step(s, [0, 0]);
  return s;
};

const adv = (s: GameState, n: number, a: InputFrame = 0, b: InputFrame = 0): void => {
  for (let i = 0; i < n; i++) step(s, [a, b]);
};

/** Place fighters at pixel x-positions and settle facing for one tick. */
const teleport = (s: GameState, x0: number, x1: number): void => {
  s.fighters[0].x = fp(x0);
  s.fighters[1].x = fp(x1);
  adv(s, 1);
};

/** Step until cond or max ticks, feeding constant inputs. Returns ticks run. */
const until = (
  s: GameState, cond: () => boolean, a: InputFrame = 0, b: InputFrame = 0, max = 600,
): number => {
  let n = 0;
  while (!cond() && n++ < max) step(s, [a, b]);
  return n;
};

describe('normals + chains (magic series)', () => {
  it('a jab connects and deals exact unscaled damage', () => {
    const s = startFight();
    teleport(s, 770, 840);
    step(s, [Btn.LP, 0]);
    adv(s, 20);
    assert.equal(s.fighters[1].health, MAXHP - 300);
    assert.equal(s.fighters[1].comboHits, 1);
  });

  it('L→M chain cancels on hit and applies 90% scaling to hit two', () => {
    const s = startFight();
    teleport(s, 770, 840);
    step(s, [Btn.LP, 0]);
    adv(s, 6); // jab connects (hitstop holds the buffer window open)
    step(s, [Btn.MP, 0]);
    adv(s, 40);
    // 300 + trunc(550 * 0.9) = 300 + 495
    assert.equal(s.fighters[1].health, MAXHP - 300 - 495);
    assert.ok(s.fighters[1].comboHits >= 2);
  });

  it('reverse chain (H → L) is not in the cancel graph', () => {
    const s = startFight();
    teleport(s, 770, 840);
    step(s, [Btn.HP, 0]);
    adv(s, 12); // 5HP connects
    step(s, [Btn.LP | Btn.Down, 0]);
    adv(s, 6);
    // Still inside 5HP (29 total frames); the jab did not come out.
    assert.equal(s.fighters[0].action, Action.Attack);
    assert.equal(s.fighters[1].comboHits, 1);
    assert.equal(s.fighters[1].health, MAXHP - 800);
  });

  it('whiffed normals cannot chain (magic series needs contact)', () => {
    const s = startFight();
    teleport(s, 400, 1200); // far out of reach
    step(s, [Btn.LP, 0]);
    adv(s, 2);
    step(s, [Btn.MP, 0]);
    adv(s, 3);
    // Still in the jab — the MP did not cancel a whiff.
    assert.equal(s.fighters[0].action, Action.Attack);
    assert.equal(characters[0].b.moves[s.fighters[0].moveIdx]!.id, '5LP');
  });
});

describe('movement', () => {
  it('walking forward moves, walking back is slower', () => {
    const s = startFight();
    const x0 = s.fighters[0].x;
    adv(s, 30, Btn.Right, 0); // P0 faces right → forward
    const fwd = s.fighters[0].x - x0;
    const s2 = startFight();
    const x1 = s2.fighters[0].x;
    adv(s2, 30, Btn.Left, 0);
    const back = x1 - s2.fighters[0].x;
    assert.ok(fwd > 0 && back > 0);
    assert.ok(fwd > back);
  });

  it('double-tap forward dashes (faster than walking)', () => {
    const s = startFight();
    const start = s.fighters[0].x;
    step(s, [Btn.Right, 0]);
    step(s, [0, 0]);
    step(s, [Btn.Right, 0]);
    assert.equal(s.fighters[0].action, Action.DashF);
    adv(s, characters[0].b.dashFTicks);
    const dashDist = s.fighters[0].x - start;

    const s2 = startFight();
    const start2 = s2.fighters[0].x;
    adv(s2, characters[0].b.dashFTicks + 3, Btn.Right, 0);
    assert.ok(dashDist > s2.fighters[0].x - start2);
  });

  it('tap down → up super jumps higher than a normal jump', () => {
    const measureApex = (superJ: boolean): number => {
      const s = startFight();
      if (superJ) adv(s, 3, Btn.Down, 0);
      adv(s, TUNING.jumpSquatTicks + 1, Btn.Up, 0);
      let apex = 0;
      until(s, () => {
        apex = Math.max(apex, 460 - fpToPx(s.fighters[0].y));
        return s.fighters[0].action !== Action.Air && s.fighters[0].action !== Action.JumpSquat;
      }, 0, 0, 300);
      return apex;
    };
    const normal = measureApex(false);
    const sj = measureApex(true);
    assert.ok(normal > 60, `normal jump apex ${normal}`);
    assert.ok(sj > normal + 40, `super jump ${sj} vs normal ${normal}`);
  });

  it('double jump gains extra height mid-air', () => {
    const s = startFight();
    adv(s, TUNING.jumpSquatTicks + 1, Btn.Up, 0);
    // Release up, wait a bit, jump again mid-air.
    adv(s, 10);
    assert.equal(s.fighters[0].action, Action.Air);
    const velBefore = s.fighters[0].velY;
    step(s, [Btn.Up, 0]);
    assert.ok(s.fighters[0].velY < velBefore, 'double jump resets upward velocity');
    assert.equal(s.fighters[0].jumpsLeft, 0);
  });
});

describe('blocking + guard levels', () => {
  // P0 attacks from the left; P1 blocks by holding Right (away) ± Down.
  it('standing block stops a mid and takes zero damage from normals', () => {
    const s = startFight();
    teleport(s, 770, 840);
    step(s, [Btn.HP, Btn.Right]);
    adv(s, 16, 0, Btn.Right);
    assert.equal(s.fighters[1].health, MAXHP);
    assert.equal(s.fighters[1].action, Action.BlockStand);
  });

  it('lows must be crouch-blocked', () => {
    const stand = startFight();
    teleport(stand, 770, 840);
    step(stand, [Btn.MK | Btn.Down, Btn.Right]); // 2MK is a low
    adv(stand, 20, Btn.Down, Btn.Right);
    assert.equal(stand.fighters[1].health, MAXHP - 500, 'standing block loses to a low');

    const crouch = startFight();
    teleport(crouch, 770, 840);
    step(crouch, [Btn.MK | Btn.Down, Btn.Right | Btn.Down]);
    adv(crouch, 20, Btn.Down, Btn.Right | Btn.Down);
    assert.equal(crouch.fighters[1].health, MAXHP, 'crouch block stops a low');
  });

  it('jump-ins are overheads: crouch block loses, stand block works', () => {
    const run = (blockInput: InputFrame): number => {
      const s = startFight();
      teleport(s, 776, 840);
      // P0 jumps straight up, then presses HK on the way down near the ground.
      adv(s, TUNING.jumpSquatTicks + 1, Btn.Up, blockInput);
      until(s, () => s.fighters[0].velY > 0 && fpToPx(s.fighters[0].y) > 460 - 175, 0, blockInput);
      step(s, [Btn.HK, blockInput]);
      until(s, () => s.fighters[0].action !== Action.Air && s.fighters[0].action !== Action.Attack, 0, blockInput, 240);
      adv(s, 10, 0, blockInput);
      return s.fighters[1].health;
    };
    assert.equal(run(Btn.Right), MAXHP, 'stand block stops the jump-in');
    assert.ok(run(Btn.Right | Btn.Down) < MAXHP, 'crouch block gets clipped by the overhead');
  });

  it('pushblock (advancing guard) creates extra separation', () => {
    const gap = (pushblock: boolean): number => {
      const s = startFight();
      teleport(s, 770, 840);
      step(s, [Btn.HP, Btn.Right]);
      adv(s, 12, 0, Btn.Right); // 5HP gets blocked
      assert.equal(s.fighters[1].action, Action.BlockStand);
      if (pushblock) step(s, [0, Btn.Right | Btn.LP | Btn.MP]);
      adv(s, 30, 0, Btn.Right);
      return fpToPx(s.fighters[1].x - s.fighters[0].x);
    };
    const normal = gap(false);
    const pushed = gap(true);
    assert.ok(pushed > normal + 20, `pushblock gap ${pushed} vs normal ${normal}`);
  });

  it('blocked specials chip; clean block of a normal does not', () => {
    const s = startFight();
    teleport(s, 500, 900);
    // P0: QCF+P fireball. P1 holds back the whole time.
    step(s, [Btn.Down, Btn.Right]);
    step(s, [Btn.Down, Btn.Right]);
    step(s, [Btn.Down | Btn.Right, Btn.Right]);
    step(s, [Btn.Right, Btn.Right]);
    step(s, [Btn.Right | Btn.LP, Btn.Right]);
    until(s, () => s.fighters[1].health < MAXHP || s.fighters[1].action === Action.BlockStand, 0, Btn.Right, 300);
    adv(s, 5, 0, Btn.Right);
    assert.equal(s.fighters[1].health, MAXHP - 700 + 700 - 90); // chip only
    assert.equal(s.fighters[1].action, Action.BlockStand);
  });
});

describe('specials + super', () => {
  it('236+P spawns a fireball that travels and hits', () => {
    const s = startFight();
    teleport(s, 500, 1000);
    step(s, [Btn.Down, 0]);
    step(s, [Btn.Down, 0]);
    step(s, [Btn.Down | Btn.Right, 0]);
    step(s, [Btn.Right, 0]);
    step(s, [Btn.Right | Btn.LP, 0]);
    // The motion resolved into the special, not a normal.
    assert.equal(s.fighters[0].action, Action.Attack);
    assert.equal(characters[0].b.moves[s.fighters[0].moveIdx]!.id, '236P');
    until(s, () => s.projectiles.some((p) => p.active === 1), 0, 0, 30);
    assert.ok(s.projectiles.some((p) => p.active === 1), 'projectile spawned');
    until(s, () => s.fighters[1].health < MAXHP, 0, 0, 200);
    assert.equal(s.fighters[1].health, MAXHP - 700);
    assert.ok(s.projectiles.every((p) => p.active === 0), 'fireball dies on hit');
  });

  it('623+P dragon punch launches the victim', () => {
    const s = startFight();
    teleport(s, 780, 840);
    step(s, [Btn.Right, 0]);
    step(s, [Btn.Right, 0]);
    step(s, [Btn.Down, 0]);
    step(s, [Btn.Down | Btn.Right, 0]);
    step(s, [Btn.Down | Btn.Right | Btn.HP, 0]);
    assert.equal(characters[0].b.moves[s.fighters[0].moveIdx]!.id, '623P');
    until(s, () => s.fighters[1].action === Action.AirHitstun, 0, 0, 60);
    assert.equal(s.fighters[1].action, Action.AirHitstun);
    assert.ok(s.fighters[1].velY < 0, 'victim launched upward');
    // Untechable: victim ends up knocked down.
    until(s, () => s.fighters[1].action === Action.Knockdown, 0, 0, 400);
    assert.equal(s.fighters[1].action, Action.Knockdown);
  });

  it('super needs a bar, freezes with super flash, spends the meter', () => {
    const s = startFight();
    teleport(s, 700, 840);
    // No meter: motion + 2 punches gives a normal instead.
    step(s, [Btn.Down, 0]);
    step(s, [Btn.Down | Btn.Right, 0]);
    step(s, [Btn.Right, 0]);
    step(s, [Btn.Right | Btn.LP | Btn.MP, 0]);
    assert.notEqual(characters[0].b.moves[s.fighters[0].moveIdx]?.id, '236PP');

    const s2 = startFight();
    teleport(s2, 700, 840);
    s2.fighters[0].meter = TUNING.meterBar;
    step(s2, [Btn.Down, 0]);
    step(s2, [Btn.Down | Btn.Right, 0]);
    step(s2, [Btn.Right, 0]);
    step(s2, [Btn.Right | Btn.LP | Btn.MP, 0]);
    assert.equal(characters[0].b.moves[s2.fighters[0].moveIdx]!.id, '236PP');
    assert.equal(s2.fighters[0].meter, 0);
    assert.ok(s2.superFlashLeft > 0, 'super flash freeze started');
    const frozenY = s2.fighters[1].x;
    adv(s2, TUNING.superFlashTicks - 1, 0, Btn.Right | Btn.Left); // victim mashes, frozen
    assert.equal(s2.fighters[1].x, frozenY, 'world frozen during flash');
    // Multi-hit rush lands (victim not blocking: was mashing both dirs).
    until(s2, () => s2.fighters[1].comboHits >= 3, 0, 0, 120);
    assert.ok(s2.fighters[1].comboHits >= 3, `super multi-hits (${s2.fighters[1].comboHits})`);
  });

  it('meter builds on whiff and on hit', () => {
    const s = startFight();
    teleport(s, 400, 1200);
    step(s, [Btn.LP, 0]);
    adv(s, 15);
    assert.equal(s.fighters[0].meter, 5); // whiff gain
    const s2 = startFight();
    teleport(s2, 770, 840);
    step(s2, [Btn.LP, 0]);
    adv(s2, 15);
    assert.equal(s2.fighters[0].meter, 5 + 40); // whiff + on-hit
    assert.equal(s2.fighters[1].meter, Math.trunc(300 / TUNING.victimMeterDivisor));
  });
});

describe('launcher + air combo + juggle', () => {
  it('2HP launches; holding up jump-cancels into a super jump', () => {
    const s = startFight();
    teleport(s, 776, 840);
    step(s, [Btn.Down | Btn.HP, 0]);
    until(s, () => s.fighters[1].action === Action.AirHitstun, Btn.Down | Btn.HP, 0, 30);
    assert.equal(s.fighters[1].action, Action.AirHitstun);
    assert.ok(s.fighters[1].velY < 0);
    // Hold up: launcher is jump-cancelable on hit into a super jump.
    until(s, () => s.fighters[0].action === Action.JumpSquat, Btn.Up, 0, 20);
    assert.equal(s.fighters[0].action, Action.JumpSquat);
    assert.equal(s.fighters[0].superJumped, 1);
  });

  it('air chain after launcher scores extra hits and ends in knockdown', () => {
    const s = startFight();
    teleport(s, 776, 840);
    step(s, [Btn.Down | Btn.HP, 0]);
    until(s, () => s.fighters[1].action === Action.AirHitstun, Btn.Down | Btn.HP, 0, 30);
    // Jump-cancel with up-forward so the attacker drifts with the victim.
    until(s, () => s.fighters[0].action === Action.Air, Btn.Up | Btn.Right, 0, 20);
    // Rising air chain, done fast (MvC timing): j.LP → j.MP → j.HP.
    step(s, [Btn.LP, 0]);
    step(s, [0, 0]);
    step(s, [Btn.MP, 0]); // buffered; consumed the moment j.LP connects
    adv(s, 8);
    step(s, [Btn.HP, 0]); // buffered; cancels j.MP on contact
    adv(s, 40);
    assert.ok(s.fighters[1].comboHits >= 3, `air combo hits: ${s.fighters[1].comboHits}`);
    until(s, () => s.fighters[1].action === Action.Knockdown, 0, 0, 400);
    assert.equal(s.fighters[1].action, Action.Knockdown);
    assert.ok(s.fighters[1].juggleBudget < TUNING.juggleBudget, 'air hits consumed juggle points');
  });

  it('knocked-down fighters are invulnerable until they get up', () => {
    const s = startFight();
    teleport(s, 776, 840);
    // Sweep: 2HK knocks down.
    step(s, [Btn.Down | Btn.HK, 0]);
    until(s, () => s.fighters[1].action === Action.Knockdown, 0, 0, 200);
    const hpAtKD = s.fighters[1].health;
    teleport(s, s.fighters[1].x / 256 - 60, s.fighters[1].x / 256);
    step(s, [Btn.LP, 0]);
    adv(s, 20);
    assert.equal(s.fighters[1].health, hpAtKD, 'OTG jab whiffs on a knockdown');
  });
});

describe('throws', () => {
  it('forward throw at close range damages and knocks down', () => {
    const s = startFight();
    teleport(s, 790, 845);
    step(s, [Btn.Right | Btn.HP, 0]);
    assert.equal(s.fighters[0].action, Action.Grab);
    assert.equal(s.fighters[1].action, Action.Thrown);
    adv(s, TUNING.grabTicks + 2, Btn.Right, 0);
    assert.equal(s.fighters[1].health, MAXHP - characters[0].b.throwDamage);
    until(s, () => s.fighters[1].action === Action.Knockdown, 0, 0, 300);
    assert.equal(s.fighters[1].action, Action.Knockdown);
  });

  it('throw tech escapes with no damage', () => {
    const s = startFight();
    teleport(s, 790, 845);
    step(s, [Btn.Right | Btn.HP, 0]);
    assert.equal(s.fighters[1].action, Action.Thrown);
    step(s, [Btn.Right, Btn.HP]); // tech inside the window
    adv(s, 3);
    assert.equal(s.fighters[1].health, MAXHP);
    assert.notEqual(s.fighters[1].action, Action.Thrown);
    assert.notEqual(s.fighters[0].action, Action.Grab);
  });

  it('a lingering projectile cannot orphan a thrown fighter (Grab is strike-invulnerable)', () => {
    // Audit 2026-07-20 CT-3: "throw the fireballer". The victim (f1) had a
    // fireball in flight when f0 threw it; the fireball then strikes the GRABBER
    // (f0) mid-throw. Pre-fix, Grab was not strike-invulnerable, so f0 was
    // knocked to Hitstun and f1 was stranded in Thrown until the round timer —
    // a ~99s soft-lock read as a freeze. The throw must be uninterruptible.
    const s = startFight();
    teleport(s, 790, 845);
    step(s, [Btn.Right | Btn.HP, 0]); // f0 throws f1
    assert.equal(s.fighters[0].action, Action.Grab);
    assert.equal(s.fighters[1].action, Action.Thrown);

    // f1's in-flight fireball, overlapping the grabber (owner 1 → targets f0).
    const projIdx = characters[1].b.moves.findIndex((m) => m.projectile);
    assert.ok(projIdx >= 0, 'the character has a projectile move');
    const p = s.projectiles[0]!;
    p.active = 1; p.owner = 1; p.moveIdx = projIdx; p.hasHit = 0; p.life = 90;
    p.x = s.fighters[0].x; p.y = s.fighters[0].y; p.velX = 0; // sits on the grabber

    // Run well past the throw's resolution. No fighter may remain in Thrown, and
    // the throw must have connected (the projectile did not cancel it).
    let stranded = false;
    for (let i = 0; i < TUNING.grabTicks + 150; i++) {
      step(s, [0, 0]);
      if (i > TUNING.grabTicks + 5
        && (s.fighters[0].action === Action.Thrown || s.fighters[1].action === Action.Thrown)) {
        stranded = true;
      }
    }
    assert.equal(stranded, false, 'no fighter is stranded in Thrown after the throw resolves');
    assert.ok(s.fighters[1].health < MAXHP, 'the throw connected — the projectile did not interrupt it');
  });

  it('out of range, 6+HP is just a normal', () => {
    const s = startFight();
    teleport(s, 600, 1000);
    step(s, [Btn.Right | Btn.HP, 0]);
    assert.equal(s.fighters[0].action, Action.Attack);
    assert.equal(characters[0].b.moves[s.fighters[0].moveIdx]!.id, '5HP');
  });
});

describe('hitstop + round flow', () => {
  it('hitstop freezes both fighters on contact', () => {
    const s = startFight();
    teleport(s, 770, 840);
    step(s, [Btn.LP, 0]);
    until(s, () => s.hitstopLeft > 0, 0, 0, 10);
    assert.ok(s.hitstopLeft > 0);
    const f0 = s.fighters[0].actionFrame;
    const x1 = s.fighters[1].x;
    step(s, [0, Btn.Left]);
    assert.equal(s.fighters[0].actionFrame, f0, 'attacker frozen');
    assert.equal(s.fighters[1].x, x1, 'victim frozen');
  });

  it('KO ends the round, best-of-3 ends the match, meter persists', () => {
    const s = startFight();
    const winRound = (): void => {
      until(s, () => s.phase !== Phase.Fighting, 0, 0, 20);
      teleport(s, 770, 840);
      s.fighters[1].health = 1;
      step(s, [Btn.LP, 0]);
      until(s, () => s.phase === Phase.RoundOver, 0, 0, 30);
      assert.equal(s.phase, Phase.RoundOver);
    };
    winRound();
    assert.equal(s.roundsWon0, 1);
    const meterAfterR1 = s.fighters[0].meter;
    assert.ok(meterAfterR1 > 0);
    // Round transition: health resets, meter persists.
    until(s, () => s.phase === Phase.PreRound, 0, 0, TUNING.roundOverTicks + 5);
    assert.equal(s.fighters[1].health, MAXHP);
    assert.equal(s.fighters[0].meter, meterAfterR1);
    until(s, () => s.phase === Phase.Fighting, 0, 0, TUNING.preRoundTicks + 5);
    winRound();
    assert.equal(s.roundsWon0, 2);
    until(s, () => s.phase === Phase.MatchOver, 0, 0, TUNING.roundOverTicks + 5);
    assert.equal(s.phase, Phase.MatchOver);
    assert.equal(s.winner, 0);
  });

  it('timeout awards the round to the healthier fighter', () => {
    const s = startFight();
    teleport(s, 770, 840);
    step(s, [Btn.LP, 0]);
    adv(s, 20);
    assert.ok(s.fighters[1].health < MAXHP);
    s.timerTicks = 5;
    adv(s, 6);
    assert.equal(s.phase, Phase.RoundOver);
    assert.equal(s.roundWinner, 0);
  });
});

describe('bundle value validation (audit 2026-07-18 holes + 2026-07-20 CT-3 soft-lock)', () => {
  const base = (): CharacterBundle => structuredClone(characters[0]!.b);
  /** Corrupt a cloned shipped bundle and assert loadCharacter rejects it. */
  const rejects = (mut: (b: CharacterBundle) => void, msg: RegExp): void => {
    const b = base();
    mut(b);
    assert.throws(() => loadCharacter(b), msg);
  };
  /** The first hitbox in the bundle (every character has attacks). */
  const firstHit = (b: CharacterBundle): HitboxDef => {
    for (const m of b.moves) for (const st of m.steps) for (const h of st.hitboxes ?? []) return h;
    throw new Error('no hitbox in bundle');
  };

  it('accepts every shipped bundle unchanged', () => {
    for (const c of characters) assert.doesNotThrow(() => loadCharacter(structuredClone(c.b)));
  });
  it('rejects maxHealth <= 0', () => rejects((b) => { b.maxHealth = 0; }, /maxHealth/));
  it('rejects gravity <= 0 (fighters never fall)', () => rejects((b) => { b.gravity = 0; }, /gravity/));
  it('rejects a non-upward throw toss (AirHitstun soft-lock)', () => rejects((b) => { b.throwTossVelY = 0; }, /throwTossVelY/));
  it('rejects a non-upward launcher (AirHitstun soft-lock)', () => rejects((b) => {
    let found = false;
    outer: for (const m of b.moves) for (const st of m.steps) for (const h of st.hitboxes ?? []) {
      if (h.launchVelY !== undefined) { h.launchVelY = 0; found = true; break outer; }
    }
    if (!found) firstHit(b).launchVelY = 0; // inject one so the test is meaningful
  }, /launchVelY/));
  it('rejects negative chip (heals the victim)', () => rejects((b) => { firstHit(b).chip = -50; }, /chip/));
  it('rejects negative juggleCost (infinite combo)', () => rejects((b) => { firstHit(b).juggleCost = -1; }, /juggleCost/));
  it('rejects negative meterCost (mints meter)', () => rejects((b) => {
    for (const m of b.moves) if (m.meterCost !== undefined) { m.meterCost = -1; return; }
    throw new Error('no super with meterCost in bundle');
  }, /meterCost/));
  it('rejects NaN numerics', () => rejects((b) => { b.gravity = NaN; }, /finite/));
  it('rejects an unknown tuning override key', () => rejects((b) => { b.tuning = { nope: 5 } as never; }, /unknown tuning/));
  it('rejects a non-positive tuning value', () => rejects((b) => { b.tuning = { grabTicks: 0 }; }, /tuning\.grabTicks/));
  it('rejects a non-integer tuning value', () => rejects((b) => { b.tuning = { jumpSquatTicks: 4.5 }; }, /tuning\.jumpSquatTicks/));
  it('accepts a valid tuning override', () => {
    const b = base(); b.tuning = { jumpSquatTicks: 10, grabTicks: 8 };
    assert.doesNotThrow(() => loadCharacter(b));
  });
});

describe('per-character tuning overrides change behavior (archetype feel)', () => {
  const orig0 = characters[0]!, orig1 = characters[1]!;
  after(() => setCharacters(orig0, orig1)); // don't leak the swap to other suites

  /** Frames the fighter spends in JumpSquat before leaving the ground. */
  const jumpSquatFrames = (): number => {
    const s = createGameState(1);
    while (s.phase === Phase.PreRound) step(s, [0, 0]);
    let g = 0;
    while (s.fighters[0].action !== Action.JumpSquat && g++ < 30) step(s, [Btn.Up, 0]);
    let f = 0;
    while (s.fighters[0].action === Action.JumpSquat && f++ < 90) step(s, [Btn.Up, 0]);
    return f;
  };

  it('a heavier jumpSquatTicks delays the jump by exactly the override delta', () => {
    setCharacters(loadCharacter(structuredClone(orig0.b)), loadCharacter(structuredClone(orig1.b)));
    const base = jumpSquatFrames();
    const heavy = structuredClone(orig0.b);
    heavy.tuning = { jumpSquatTicks: TUNING.jumpSquatTicks + 8 };
    setCharacters(loadCharacter(heavy), loadCharacter(structuredClone(orig1.b)));
    const slow = jumpSquatFrames();
    assert.equal(slow, base + 8, `override adds exactly its delta to prejump (${slow} vs ${base})`);
  });

  it('the override is per-fighter: P1 (no override) still jumps at the default', () => {
    const heavy = structuredClone(orig0.b);
    heavy.tuning = { jumpSquatTicks: TUNING.jumpSquatTicks + 8 };
    setCharacters(loadCharacter(heavy), loadCharacter(structuredClone(orig1.b)));
    const s = createGameState(1);
    while (s.phase === Phase.PreRound) step(s, [0, 0]);
    // Drive BOTH into jumpsquat; P1 (default) must leave first.
    let g = 0;
    while ((s.fighters[0].action !== Action.JumpSquat || s.fighters[1].action !== Action.JumpSquat) && g++ < 30) {
      step(s, [Btn.Up, Btn.Up]);
    }
    let p1LeftAt = -1, p0LeftAt = -1, f = 0;
    while ((p0LeftAt < 0 || p1LeftAt < 0) && f++ < 90) {
      step(s, [Btn.Up, Btn.Up]);
      if (p1LeftAt < 0 && s.fighters[1].action !== Action.JumpSquat) p1LeftAt = f;
      if (p0LeftAt < 0 && s.fighters[0].action !== Action.JumpSquat) p0LeftAt = f;
    }
    assert.ok(p1LeftAt >= 0 && p0LeftAt > p1LeftAt, `P0 (heavy) leaves after P1 (default): ${p0LeftAt} > ${p1LeftAt}`);
  });
});
