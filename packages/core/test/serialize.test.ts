import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createGameState, restore, serialize, snapshot, stateHash, step,
} from '../src/index.js';
import type { GameState } from '../src/index.js';

/**
 * SERIALIZE / SNAPSHOT COMPLETENESS GUARD.
 *
 * The classic determinism-desync bug: someone adds a field to GameState (and
 * to the constructor), but forgets to add it to serialize()'s field list or to
 * snapshot/restore. Everything compiles, all gameplay tests pass — and then
 * rollback or server-verification silently desyncs because that field isn't in
 * the hash / isn't copied. It's exactly the subtle break a fresh model (no
 * memory of the field-order-is-protocol rule) introduces.
 *
 * This guard is SELF-MAINTAINING: it enumerates the state's fields at RUNTIME
 * (Object.keys on a real GameState), so a newly-added field is automatically
 * covered — no hardcoded list to keep in sync. For every scalar field it
 * asserts:
 *   (a) mutating it changes stateHash   → the field IS in serialize()
 *   (b) snapshot→mutate→restore recovers it → restore() copies it
 * plus the same for the dirHist ring buffers and projectile slots.
 *
 * If you add a state field and this fails: add it to FIGHTER_FIELDS /
 * PROJECTILE_FIELDS / GLOBAL_FIELDS in state.ts (serialize) AND make sure
 * snapshot/restore round-trip it. That is the fix — not skipping this test.
 */

/** A non-trivial live state (mid-match) so fields have varied values. */
const liveState = (): GameState => {
  const s = createGameState(1234);
  // Drive a while so buffers, combos, projectiles, timers are populated.
  let a = 0, b = 0, seed = 0x1234abcd >>> 0;
  const rand = (): number => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  for (let i = 0; i < 400; i++) {
    if (rand() % 4 === 0) a = rand() % 1024;
    if (rand() % 4 === 0) b = rand() % 1024;
    step(s, [a, b]);
  }
  return s;
};

const scalarKeys = (obj: Record<string, unknown>): string[] =>
  Object.keys(obj).filter((k) => typeof obj[k] === 'number');

describe('serialize completeness — every scalar field is in the hash', () => {
  it('mutating any global scalar changes stateHash', () => {
    for (const key of scalarKeys(liveState() as unknown as Record<string, unknown>)) {
      const s = liveState();
      const before = stateHash(s);
      (s as unknown as Record<string, number>)[key] += 1;
      assert.notEqual(stateHash(s), before,
        `GameState.${key} is not captured by serialize() — add it to GLOBAL_FIELDS in state.ts`);
    }
  });

  it('mutating any fighter scalar changes stateHash (both fighters)', () => {
    const sample = liveState();
    for (const fi of [0, 1] as const) {
      for (const key of scalarKeys(sample.fighters[fi] as unknown as Record<string, unknown>)) {
        const s = liveState();
        const before = stateHash(s);
        (s.fighters[fi] as unknown as Record<string, number>)[key] += 1;
        assert.notEqual(stateHash(s), before,
          `FighterState.${key} (fighter ${fi}) is not in serialize() — add it to FIGHTER_FIELDS in state.ts`);
      }
    }
  });

  it('mutating the dirHist ring buffer changes stateHash', () => {
    for (const fi of [0, 1] as const) {
      const s = liveState();
      const before = stateHash(s);
      s.fighters[fi].dirHist[0] = (s.fighters[fi].dirHist[0]! + 1) % 10;
      assert.notEqual(stateHash(s), before, `fighter ${fi} dirHist[0] is not serialized`);
    }
  });

  it('mutating any projectile scalar changes stateHash (all slots)', () => {
    const sample = liveState();
    for (let pi = 0; pi < sample.projectiles.length; pi++) {
      for (const key of scalarKeys(sample.projectiles[pi] as unknown as Record<string, unknown>)) {
        const s = liveState();
        const before = stateHash(s);
        (s.projectiles[pi] as unknown as Record<string, number>)[key] += 1;
        assert.notEqual(stateHash(s), before,
          `ProjectileState.${key} (slot ${pi}) is not in serialize() — add it to PROJECTILE_FIELDS in state.ts`);
      }
    }
  });
});

describe('snapshot / restore completeness — every field round-trips', () => {
  it('snapshot then divergent sim then restore reproduces the exact bytes', () => {
    const s = liveState();
    const snap = snapshot(s);
    const goldBytes = serialize(snap);
    const goldHash = stateHash(snap);

    // Diverge hard: mutate essentially everything, then restore.
    for (let i = 0; i < 120; i++) step(s, [0b1111110101, 0b0101111111]);
    assert.notEqual(stateHash(s), goldHash, 'sanity: divergence actually changed the state');

    restore(s, snap);
    assert.equal(stateHash(s), goldHash, 'restore did not recover the snapshot hash');
    // Byte-exact, not just hash-equal (guards against a hash collision hiding a miss).
    assert.deepEqual(Array.from(serialize(s)), Array.from(goldBytes),
      'restore recovered the hash but not the exact serialized bytes — a field is missed');
  });

  it('snapshot is an independent copy (mutating live state cannot corrupt it)', () => {
    const s = liveState();
    const snap = snapshot(s);
    const h = stateHash(snap);
    for (let i = 0; i < 200; i++) step(s, [0b0000110101, 0b0011001111]);
    assert.equal(stateHash(snap), h, 'snapshot shares mutable state with the live game');
  });
});
