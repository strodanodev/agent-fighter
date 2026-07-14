/**
 * Re-bless the golden replay hashes. Run DELIBERATELY, never casually:
 *
 *   npm run golden:bless -w @af/core
 *
 * This overwrites test/golden/hashes.json with the current sim's output. Do it
 * only when a golden test failure is an INTENDED behavior change (a balance
 * tweak, a new mechanic, a bug fix that legitimately alters outcomes) — and
 * commit the regenerated hashes in the SAME change, so the diff shows exactly
 * which matches changed and a reviewer can sanity-check it was on purpose.
 *
 * If you did NOT mean to change behavior, do not bless — fix your code until
 * the existing golden test passes again.
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCENARIOS, runScenario } from '../test/golden/scenarios.js';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'test', 'golden', 'hashes.json');

const record: Record<string, unknown> = {
  _comment: 'GOLDEN HASHES — do not hand-edit. Regenerate with `npm run golden:bless -w @af/core` '
    + 'only when a behavior change is intentional. A diff here = the game plays differently.',
};

for (const sc of SCENARIOS) {
  const r = runScenario(sc);
  record[sc.name] = {
    finalHash: r.finalHash,
    traceHash: r.traceHash,
    endTick: r.endTick,
    endPhase: r.endPhase,
    roundsWon0: r.roundsWon0,
    roundsWon1: r.roundsWon1,
  };
  console.log(
    `${sc.name.padEnd(16)} final=${r.finalHash.toString(16).padStart(8, '0')} `
    + `trace=${r.traceHash.toString(16).padStart(8, '0')} `
    + `end=tick${r.endTick}/phase${r.endPhase} rounds ${r.roundsWon0}-${r.roundsWon1}`);
}

writeFileSync(out, JSON.stringify(record, null, 2) + '\n');
console.log(`\nblessed ${SCENARIOS.length} scenarios → ${out}`);
