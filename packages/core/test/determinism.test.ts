import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  Btn, Phase, createGameState, restore, snapshot, stateHash, step,
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
    if (rand() % 5 === 0) a = rand() % 32;
    if (rand() % 5 === 0) b = rand() % 32;
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
});

describe('snapshot / restore (rollback primitive)', () => {
  it('restore after divergent future re-sims to identical states', () => {
    const script = makeInputScript(0xaaaa, 900);
    const s = createGameState(99);
    for (let i = 0; i < 300; i++) step(s, script[i]!);

    const snap = snapshot(s);
    const hashAtSnap = stateHash(s);

    // Diverge: simulate 60 ticks of *wrong* (mispredicted) inputs.
    for (let i = 300; i < 360; i++) step(s, [Btn.Attack | Btn.Right, Btn.Left]);
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
    for (let i = 0; i < 100; i++) step(s, [Btn.Right | Btn.Attack, Btn.Left | Btn.Attack]);
    assert.equal(stateHash(snap), h);
  });
});

describe('gameplay sanity', () => {
  it('an unanswered attack does damage and can win the match', () => {
    const s = createGameState(1);
    // P0 walks in and mashes attack; P1 does nothing (no blocking in M0).
    let guard = 0;
    while (s.phase === Phase.Fighting && guard++ < 60 * 120) {
      const mash = guard % 20 < 2 ? Btn.Attack : 0;
      step(s, [Btn.Right | mash, 0]);
    }
    assert.equal(s.phase, Phase.Over);
    assert.equal(s.winner, 0);
    assert.equal(s.fighters[1].health, 0);
  });

  it('timeout awards the healthier fighter', () => {
    const s = createGameState(1);
    // Land one hit, then both idle until timeout.
    let guard = 0;
    const startHealth = s.fighters[1].health;
    while (s.fighters[1].health === startHealth && guard++ < 60 * 30) {
      const mash = guard % 20 < 2 ? Btn.Attack : 0;
      step(s, [Btn.Right | mash, 0]);
    }
    assert.ok(s.fighters[1].health < startHealth);
    guard = 0;
    while (s.phase === Phase.Fighting && guard++ < 60 * 110) step(s, [0, 0]);
    assert.equal(s.phase, Phase.Over);
    assert.equal(s.winner, 0);
  });

  it('fighters stay inside the stage and on/above the floor', () => {
    const script = makeInputScript(0x1234, 2400);
    const s = createGameState(3);
    for (const inputs of script) {
      step(s, inputs);
      for (const f of s.fighters) {
        assert.ok(f.y <= 460 * 256);
        assert.ok(f.x >= 24 * 256);
        assert.ok(f.x <= (960 - 24) * 256);
      }
    }
  });
});
