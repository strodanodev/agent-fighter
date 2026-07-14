/**
 * Golden replay scenarios — the anti-drift backbone.
 *
 * Each scenario is a fully-deterministic match: a fixed seed + a fixed,
 * procedurally-generated input log. `runScenario` folds the per-tick state
 * hashes into a trace hash and records the final hash. Those hashes are
 * committed in `hashes.json`; `golden.test.ts` re-simulates and asserts an
 * EXACT match.
 *
 * Why this matters across model/context switches: the determinism tests prove
 * "same run twice → same hash" (self-consistency). The golden corpus proves
 * "the game still does the SAME THING it did before" (stability over time). A
 * new agent — Claude, Grok, human — can rewrite the sim, keep it internally
 * deterministic, and silently change behavior; only a committed golden hash
 * catches that. A red golden test means: either you introduced a bug, or you
 * made a DELIBERATE balance/mechanics change and must re-bless the hashes
 * (`npm run golden:bless`) in a reviewable commit.
 *
 * Pure: no Date/Math.random here either — scenarios must reproduce forever.
 */
import { createGameState, stateHash, step } from '../../src/index.js';
import type { InputFrame } from '../../src/index.js';
import { Phase } from '../../src/index.js';

export interface Scenario {
  readonly name: string;
  readonly seed: number; // sim RNG seed
  readonly inputSeed: number; // drives the pseudo-random input log
  readonly ticks: number;
}

/**
 * Deterministic pseudo-random input log (LCG). Full 10-bit input space so the
 * script exercises directions + all six attack buttons — i.e. every mechanic:
 * chains, specials, supers, throws, projectiles, blocking, round flow.
 */
export const makeInputScript = (seed: number, ticks: number): [InputFrame, InputFrame][] => {
  let s = seed >>> 0;
  const rand = (): number => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s;
  };
  const script: [InputFrame, InputFrame][] = [];
  let a = 0, b = 0;
  for (let i = 0; i < ticks; i++) {
    if (rand() % 5 === 0) a = rand() % 1024;
    if (rand() % 5 === 0) b = rand() % 1024;
    script.push([a, b]);
  }
  return script;
};

/** FNV-1a fold of one 32-bit value into a running accumulator. */
const fold = (acc: number, v: number): number => {
  let h = acc >>> 0;
  for (let byte = 0; byte < 4; byte++) {
    h ^= (v >>> (byte * 8)) & 0xff;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
};

export interface ScenarioResult {
  readonly name: string;
  readonly finalHash: number; // stateHash of the end state
  readonly traceHash: number; // fold of every per-tick stateHash (catches mid-run divergence)
  readonly endTick: number;
  readonly endPhase: number; // human-readable divergence hint
  readonly roundsWon0: number;
  readonly roundsWon1: number;
}

/** Simulate one scenario end-to-end and derive its golden hashes. */
export const runScenario = (sc: Scenario): ScenarioResult => {
  const s = createGameState(sc.seed);
  const script = makeInputScript(sc.inputSeed, sc.ticks);
  let trace = 0x811c9dc5 >>> 0;
  for (const inputs of script) {
    step(s, inputs);
    trace = fold(trace, stateHash(s));
    // Matches end early; keep ticking (MatchOver is terminal but tick advances)
    // so the tick count — and thus the trace length — is fixed per scenario.
  }
  return {
    name: sc.name,
    finalHash: stateHash(s),
    traceHash: trace,
    endTick: s.tick,
    endPhase: s.phase,
    roundsWon0: s.roundsWon0,
    roundsWon1: s.roundsWon1,
  };
};

/**
 * The corpus. Varied seeds + lengths so different match trajectories are
 * covered: short neutral, mid-length exchanges, and full multi-round matches
 * that cross PreRound/RoundOver/MatchOver transitions. Add scenarios freely
 * (then `npm run golden:bless`); never silently change an existing one.
 */
export const SCENARIOS: readonly Scenario[] = [
  { name: 'neutral-short', seed: 1, inputSeed: 0xc0ffee, ticks: 600 },
  { name: 'exchange-mid', seed: 42, inputSeed: 0xbeef, ticks: 1800 },
  { name: 'full-match-a', seed: 7, inputSeed: 0xdead, ticks: 7200 },
  { name: 'full-match-b', seed: 99, inputSeed: 0x1234, ticks: 7200 },
  { name: 'mash-heavy', seed: 3, inputSeed: 0x5150, ticks: 3600 },
  { name: 'long-run', seed: 11, inputSeed: 0x777, ticks: 14400 },
];

/** Terminal phase constant re-exported for the bless tool's readout. */
export const MATCH_OVER = Phase.MatchOver;
