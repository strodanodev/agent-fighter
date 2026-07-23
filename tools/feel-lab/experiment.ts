/**
 * TUNING experiment — proves (or disproves) that a TUNING knob changes match
 * OUTCOMES, empirically, over many bot-vs-bot matches.
 *
 * The AI is an InputSource, so bot-vs-bot IS the balance harness (same as
 * core/test/ai.test.ts). We run the same seeds under DEFAULT tuning and under a
 * modified knob and compare aggregate feel metrics. Fully deterministic: same
 * seed + same TUNING → identical match, so any difference is the knob.
 *
 * Run: npx tsx tools/feel-lab/experiment.ts
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createGameState, step, setCharacters, loadCharacter,
  Phase, TUNING, applyTuning, resetTuning, createAi, aiPoll,
} from '@af/core';
import type { CharacterBundle } from '@af/core';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const bundle = (id: string): CharacterBundle =>
  JSON.parse(readFileSync(join(root, 'characters', id, 'character.json'), 'utf8')) as CharacterBundle;

const CHAR = 'analog';
const SEEDS = 60;
const SKILL = 70;
const MAX_TICKS = 60 * 99 * 3; // three 99s rounds

interface Metrics { dmg: number; ticks: number; maxCombo: number; decisive: number; matches: number; }

const run = (seed: number): { dmg: number; ticks: number; maxCombo: number; decided: boolean } => {
  setCharacters(loadCharacter(bundle(CHAR)), loadCharacter(bundle(CHAR)));
  const g = createGameState(seed);
  const a0 = createAi(0, SKILL, seed * 7 + 1);
  const a1 = createAi(1, SKILL, seed * 13 + 3);
  const startHp = g.fighters[0].health + g.fighters[1].health;
  let maxCombo = 0;
  let t = 0;
  for (; t < MAX_TICKS && g.phase !== Phase.MatchOver; t++) {
    step(g, [aiPoll(a0, g), aiPoll(a1, g)]);
    maxCombo = Math.max(maxCombo, g.fighters[0].comboHits, g.fighters[1].comboHits);
  }
  // Damage dealt = starting HP pool minus what's left, summed over the rounds
  // it took (health resets per round, so approximate with combo/round signal).
  const dmg = startHp * (g.roundsWon0 + g.roundsWon1)
    - (g.fighters[0].health + g.fighters[1].health);
  return { dmg, ticks: t, maxCombo, decided: g.phase === Phase.MatchOver };
};

const measure = (label: string, patch: Partial<typeof TUNING> | null): Metrics => {
  resetTuning();
  if (patch) applyTuning(patch);
  const m: Metrics = { dmg: 0, ticks: 0, maxCombo: 0, decisive: 0, matches: SEEDS };
  for (let s = 1; s <= SEEDS; s++) {
    const r = run(s);
    m.dmg += r.dmg; m.ticks += r.ticks; m.maxCombo += r.maxCombo; m.decisive += r.decided ? 1 : 0;
  }
  resetTuning();
  const avg = (n: number) => (n / SEEDS).toFixed(0);
  console.log(
    `${label.padEnd(28)} avgDmg ${avg(m.dmg).padStart(6)}  avgTicks ${avg(m.ticks).padStart(5)}`
    + `  avgMaxCombo ${(m.maxCombo / SEEDS).toFixed(1).padStart(4)}  decisive ${((m.decisive / SEEDS) * 100).toFixed(0)}%`,
  );
  return m;
};

console.log(`\nTUNING experiment — ${SEEDS} bot-vs-bot matches (${CHAR} mirror, skill ${SKILL}) per condition\n`);
measure('DEFAULT', null);
measure('scalingMult 900→1000 (no scale)', { scalingMult: 1000 });
measure('scalingMult 900→700 (harsh)', { scalingMult: 700 });
measure('juggleBudget 8→2 (short air)', { juggleBudget: 2 });
measure('juggleBudget 8→20 (long air)', { juggleBudget: 20 });
measure('minHitstun 8→2 (drop combos)', { minHitstun: 2 });
measure('minHitstun 8→20 (sticky)', { minHitstun: 20 });
console.log('\n(each row is the SAME 60 seeds; any delta is that knob alone)\n');
