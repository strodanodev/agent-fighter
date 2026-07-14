import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCENARIOS, runScenario } from './golden/scenarios.js';

/**
 * GOLDEN REPLAY TEST — behavior-stability lock.
 *
 * Re-simulates every committed scenario and asserts its final + trace hashes
 * EXACTLY match the blessed values in golden/hashes.json. This is the guard
 * that survives model/context switches: it detects any change to what the game
 * actually DOES, even one that stays internally deterministic and type-clean.
 *
 * If this fails:
 *   • You did NOT intend to change gameplay → you have a regression. Fix the
 *     code until this passes. Do not touch hashes.json.
 *   • You DID intend it (balance/mechanic/bugfix) → run
 *     `npm run golden:bless -w @af/core` and commit the regenerated hashes in
 *     the same change, so the diff documents exactly which matches changed.
 */

const hashesPath = join(dirname(fileURLToPath(import.meta.url)), 'golden', 'hashes.json');
const golden = JSON.parse(readFileSync(hashesPath, 'utf8')) as Record<string, {
  finalHash: number; traceHash: number; endTick: number;
  endPhase: number; roundsWon0: number; roundsWon1: number;
}>;

describe('golden replay corpus (behavior stability)', () => {
  it('the fixture covers every scenario (no silently-dropped coverage)', () => {
    for (const sc of SCENARIOS) {
      assert.ok(golden[sc.name], `scenario "${sc.name}" has no blessed hash — run golden:bless`);
    }
  });

  for (const sc of SCENARIOS) {
    it(`${sc.name} reproduces its blessed final + trace hash`, () => {
      const want = golden[sc.name]!;
      const got = runScenario(sc);
      const detail = `\n  got   final=${got.finalHash.toString(16)} trace=${got.traceHash.toString(16)}`
        + ` end=tick${got.endTick}/phase${got.endPhase} rounds ${got.roundsWon0}-${got.roundsWon1}`
        + `\n  want  final=${want.finalHash.toString(16)} trace=${want.traceHash.toString(16)}`
        + ` end=tick${want.endTick}/phase${want.endPhase} rounds ${want.roundsWon0}-${want.roundsWon1}`
        + '\n  → if this change was intentional: npm run golden:bless -w @af/core';
      assert.equal(got.traceHash, want.traceHash, `trace hash diverged (behavior changed mid-run)${detail}`);
      assert.equal(got.finalHash, want.finalHash, `final hash diverged${detail}`);
      // Cross-check the human-readable outcome too (a fast sanity signal).
      assert.equal(got.endPhase, want.endPhase, `end phase changed${detail}`);
      assert.equal(got.roundsWon0, want.roundsWon0, `P1 round wins changed${detail}`);
      assert.equal(got.roundsWon1, want.roundsWon1, `P2 round wins changed${detail}`);
    });
  }
});
