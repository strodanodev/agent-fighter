/**
 * Personalize every character's FEEL via per-character `tuning` (CharTuning).
 *
 * Each character gets a deliberate STYLE (balanced: all six represented, ~3
 * each, with obvious theme fits — the Terminator is a grappler, Daredevil a
 * turtle). Deltas are modest and carry a trade-off (a nimble jumper has a slower
 * grab; a grappler has a heavy, committal jump), so no profile is strictly
 * strongest. This is a STARTING POINT — the values are just DATA in each
 * character.json afterward, so hand-tweak any character freely.
 *
 * NOTE: this feel axis is independent of the arcade AI-personality axis
 * (server.ts `arcadeStyleFor`, which biases how a bot PLAYS). Unifying the two
 * onto one canonical per-character style is a possible follow-up.
 *
 * Overrides only the genuinely-per-fighter knobs (defaults: jumpSquatTicks 4,
 * getupTicks 14, grabTicks 18; knockdownTicks 36 left global). all-rounder
 * characters keep every default (no `tuning` field).
 *
 *   node tools/apply-char-tuning.mjs        # write tuning into every bundle
 *   node tools/apply-char-tuning.mjs --check # print the mapping, write nothing
 *
 * ALWAYS run `node tools/rehash-characters.mjs` afterward — `tuning` is sim
 * data, so it changes each bundle's pinned versionHash.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHARS = join(ROOT, 'characters');
const checkOnly = process.argv.includes('--check');

// Deliberate, balanced style per character (3 of each). Edit freely.
const CHAR_STYLE = {
  analog: 'rushdown', 'unitree-g1': 'rushdown', vector: 'rushdown',
  t800: 'grappler', claw: 'grappler', blaze: 'grappler',
  hermes: 'jumpy', nezuko: 'jumpy', kimp: 'jumpy',
  minds: 'turtle', bato: 'turtle', gbush: 'turtle',
  elon: 'zoner', jensen: 'zoner', '0xzero': 'zoner',
  eliza: 'all-rounder', kim: 'all-rounder', yatsiu: 'all-rounder',
};
// Unlisted (future) characters fall back to balanced by first letter.
const STYLE_NAMES = ['rushdown', 'zoner', 'turtle', 'jumpy', 'grappler', 'all-rounder'];
const styleFor = (id) => CHAR_STYLE[id] ?? STYLE_NAMES[id.charCodeAt(0) % STYLE_NAMES.length];

// Modest, trade-off tuning per style. all-rounder = defaults (no field).
const PROFILE = {
  rushdown: { jumpSquatTicks: 3, getupTicks: 12, grabTicks: 20 }, // fast up, quick oki, so-so grab
  zoner: { jumpSquatTicks: 5, getupTicks: 16, grabTicks: 22 },    // committal, weak up close
  turtle: { jumpSquatTicks: 5, getupTicks: 11, grabTicks: 20 },   // great wakeup, patient
  jumpy: { jumpSquatTicks: 2, getupTicks: 14, grabTicks: 22 },    // air-mobile, poor grappling
  grappler: { jumpSquatTicks: 6, getupTicks: 12, grabTicks: 12 }, // heavy jump, FAST command grab
  'all-rounder': null,
};

const ids = readdirSync(CHARS, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(CHARS, d.name, 'character.json')))
  .map((d) => d.name).sort();

let changed = 0;
for (const id of ids) {
  const file = join(CHARS, id, 'character.json');
  const b = JSON.parse(readFileSync(file, 'utf8'));
  const style = styleFor(id);
  const prof = PROFILE[style];
  const before = JSON.stringify(b.tuning);
  if (prof) b.tuning = prof; else delete b.tuning;
  const after = JSON.stringify(b.tuning);
  const diff = before !== after;
  if (diff) changed++;
  console.log(`${(diff ? (checkOnly ? 'DRIFT' : 'write') : ' ok  ')} ${id.padEnd(14)} ${style.padEnd(12)} ${prof ? JSON.stringify(prof) : '(defaults)'}`);
  if (!checkOnly && diff) writeFileSync(file, JSON.stringify(b, null, 2) + '\n');
}
console.log(`\n${ids.length} characters, ${changed} ${checkOnly ? 'would change' : 'updated'}.`);
if (!checkOnly && changed > 0) console.log('NEXT: node tools/rehash-characters.mjs   (tuning is sim data → versionHash changes)');
