import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  Btn, Phase, STAGE, createGameState, fp, restore, snapshot, stateHash, step,
} from '../src/index.js';
import type { GameState, InputFrame } from '../src/index.js';

/** Seeded LCG for generating pseudo-random input scripts (test-only). */
const makeInputScript = (seed: number, ticks: number): [InputFrame, InputFrame][] => {
  let s = seed >>> 0;
  const rand = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s;
  };
  const script: [InputFrame, InputFrame][] = [];
  let a = 0, b = 0;
  for (let i = 0; i < ticks; i++) {
    // Change inputs every few ticks so they look like real (mashy) play.
    // Full 10-bit input space: dirs + all 6 attack buttons.
    if (rand() % 5 === 0) a = rand() % 1024;
    if (rand() % 5 === 0) b = rand() % 1024;
    script.push([a, b]);
  }
  return script;
};

const runMatch = (seed: number, script: [InputFrame, InputFrame][]): GameState => {
  const s = createGameState(seed);
  for (const inputs of script) step(s, inputs);
  return s;
};

describe('determinism', () => {
  it('same inputs → bit-identical final state, across many runs', () => {
    const script = makeInputScript(0xc0ffee, 3600); // 60 sim-seconds
    const reference = stateHash(runMatch(42, script));
    for (let run = 0; run < 100; run++) {
      assert.equal(stateHash(runMatch(42, script)), reference);
    }
  });

  it('per-tick hash trace is reproducible (not just the final state)', () => {
    const script = makeInputScript(0xdead, 1200);
    const trace = (): number[] => {
      const s = createGameState(7);
      const hashes: number[] = [];
      for (const inputs of script) {
        step(s, inputs);
        hashes.push(stateHash(s));
      }
      return hashes;
    };
    assert.deepEqual(trace(), trace());
  });

  it('different seeds / inputs actually change the hash (hash is not degenerate)', () => {
    const script = makeInputScript(0xbeef, 600);
    const h1 = stateHash(runMatch(1, script));
    const h2 = stateHash(runMatch(2, script));
    const h3 = stateHash(runMatch(1, makeInputScript(0xfeed, 600)));
    assert.ok(new Set([h1, h2, h3]).size > 1);
  });

  it('replay across the full M1 mechanics surface stays reproducible', () => {
    // Long, mashy scripts exercise chains, specials, supers, throws,
    // projectiles, knockdowns, round transitions.
    for (const seed of [0x11, 0x22, 0x33]) {
      const script = makeInputScript(seed, 7200); // 2 minutes: crosses rounds
      const h = stateHash(runMatch(seed, script));
      assert.equal(stateHash(runMatch(seed, script)), h);
    }
  });
});

describe('snapshot / restore (rollback primitive)', () => {
  it('restore after divergent future re-sims to identical states', () => {
    const script = makeInputScript(0xaaaa, 900);
    const s = createGameState(99);
    for (let i = 0; i < 300; i++) step(s, script[i]!);

    const snap = snapshot(s);
    const hashAtSnap = stateHash(s);

    // Diverge: simulate 60 ticks of *wrong* (mispredicted) inputs.
    for (let i = 300; i < 360; i++) step(s, [Btn.LP | Btn.Right, Btn.Left | Btn.HK]);
    assert.notEqual(stateHash(s), hashAtSnap);

    // Rollback and re-sim with the *correct* inputs.
    restore(s, snap);
    assert.equal(stateHash(s), hashAtSnap);
    for (let i = 300; i < 900; i++) step(s, script[i]!);
    const rolledBack = stateHash(s);

    // Control: a straight-through run with the correct inputs.
    const control = createGameState(99);
    for (let i = 0; i < 900; i++) step(control, script[i]!);
    assert.equal(rolledBack, stateHash(control));
  });

  it('snapshot is a real copy — mutating live state does not corrupt it', () => {
    const s = createGameState(5);
    const snap = snapshot(s);
    const h = stateHash(snap);
    for (let i = 0; i < 100; i++) step(s, [Btn.Right | Btn.LP, Btn.Left | Btn.LK]);
    assert.equal(stateHash(snap), h);
  });

  it('rollback mid-combo (hitstop + buffers + projectiles) re-sims identically', () => {
    const script = makeInputScript(0x5150, 2400);
    const control = createGameState(31);
    for (const inputs of script) step(control, inputs);
    const want = stateHash(control);

    // Same script, but snapshot/restore + divergence every 100 ticks.
    const s = createGameState(31);
    for (let i = 0; i < script.length; i++) {
      if (i % 100 === 50) {
        const snap = snapshot(s);
        for (let k = 0; k < 7; k++) step(s, [Btn.HP | Btn.Down, Btn.MP]);
        restore(s, snap);
      }
      step(s, script[i]!);
    }
    assert.equal(stateHash(s), want);
  });
});

describe('bounds sanity', () => {
  it('fighters stay inside the stage and on/above the floor', () => {
    const script = makeInputScript(0x1234, 2400);
    const s = createGameState(3);
    for (const inputs of script) {
      step(s, inputs);
      for (const f of s.fighters) {
        assert.ok(f.y <= STAGE.floorYPx * 256);
        assert.ok(f.x >= STAGE.wallPad * 256);
        assert.ok(f.x <= (STAGE.widthPx - STAGE.wallPad) * 256);
      }
    }
  });

  it('a full random match reaches MatchOver and stays there', () => {
    const script = makeInputScript(0x777, 60 * 60 * 8); // up to 8 minutes
    const s = createGameState(11);
    for (const inputs of script) {
      step(s, inputs);
      if (s.phase === Phase.MatchOver) break;
    }
    // 3 rounds of 99s + transitions fit easily inside 8 minutes.
    assert.equal(s.phase, Phase.MatchOver);
    const h = stateHash(s);
    step(s, [0, 0]);
    step(s, [Btn.LP, Btn.HK]);
    // MatchOver is terminal: only the tick counter advances.
    assert.equal(s.phase, Phase.MatchOver);
    assert.notEqual(stateHash(s), h); // tick still counts (input ledger alignment)
  });
});

describe('view lock (per-stage bounds)', () => {
  const BOUNDS = { left: 300, right: 1300 }; // 1000px region, comfortably > spawn span

  it('createGameState pins fixed-point walls inset by wallPad', () => {
    const s = createGameState(1, BOUNDS);
    assert.equal(s.wallL, fp(BOUNDS.left + STAGE.wallPad));
    assert.equal(s.wallR, fp(BOUNDS.right - STAGE.wallPad));
    // Tighter than the full-stage default in both directions.
    assert.ok(s.wallL > fp(STAGE.wallPad));
    assert.ok(s.wallR < fp(STAGE.widthPx - STAGE.wallPad));
  });

  it('fighters clamp to the custom walls every tick (never the full stage)', () => {
    const script = makeInputScript(0x5eed, 2400);
    const s = createGameState(9, BOUNDS);
    for (const f of s.fighters) { // spawns already inside the tighter walls
      assert.ok(f.x >= s.wallL && f.x <= s.wallR);
    }
    for (const inputs of script) {
      step(s, inputs);
      for (const f of s.fighters) {
        assert.ok(f.x >= s.wallL, `x ${f.x} < wallL ${s.wallL}`);
        assert.ok(f.x <= s.wallR, `x ${f.x} > wallR ${s.wallR}`);
      }
    }
  });

  it('snapshot/restore round-trips the walls', () => {
    const s = createGameState(2, BOUNDS);
    const snap = snapshot(s);
    s.wallL = 0; s.wallR = 0; // corrupt, then restore
    restore(s, snap);
    assert.equal(s.wallL, fp(BOUNDS.left + STAGE.wallPad));
    assert.equal(s.wallR, fp(BOUNDS.right - STAGE.wallPad));
  });

  it('custom bounds diverge from the default-stage hash', () => {
    const script = makeInputScript(0xabc, 600);
    const def = createGameState(4);
    const bnd = createGameState(4, BOUNDS);
    for (const inputs of script) { step(def, inputs); step(bnd, inputs); }
    assert.notEqual(stateHash(def), stateHash(bnd));
  });

  it('default bounds are identical to no bounds (backward-compat)', () => {
    const script = makeInputScript(0xdef, 600);
    const implicit = createGameState(5);
    const explicit = createGameState(5, { left: 0, right: STAGE.widthPx });
    for (const inputs of script) { step(implicit, inputs); step(explicit, inputs); }
    assert.equal(stateHash(implicit), stateHash(explicit));
  });
});
