/**
 * Recompute every character's `versionHash` with the canonical SIM-ONLY hash
 * (packages/studio/bundle-hash.mjs). Run once after changing what the hash
 * covers, so the committed bundles carry hashes the Studio would now produce —
 * otherwise the next cosmetic save would flip them and re-open the deploy-skew
 * "bundle hash mismatch" outage.
 *
 *   node tools/rehash-characters.mjs          # rewrite in place
 *   node tools/rehash-characters.mjs --check  # report drift, write nothing (exit 1 if any)
 *
 * Rewrites ONLY versionHash; the rest of character.json is preserved verbatim
 * (parse → set field → re-serialize with the Studio's 2-space + trailing-\n
 * format), so a no-op run produces an empty diff.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleHash } from '../packages/studio/bundle-hash.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHARACTERS = join(ROOT, 'characters');
const checkOnly = process.argv.includes('--check');

const ids = existsSync(CHARACTERS)
  ? readdirSync(CHARACTERS, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(CHARACTERS, d.name, 'character.json')))
    .map((d) => d.name)
  : [];

let changed = 0;
for (const id of ids) {
  const file = join(CHARACTERS, id, 'character.json');
  const bundle = JSON.parse(readFileSync(file, 'utf8'));
  const next = bundleHash(bundle);
  const prev = bundle.versionHash;
  if (prev === next) { console.log(`  ok   ${id}  ${next}`); continue; }
  changed++;
  console.log(`${checkOnly ? 'DRIFT' : 'write'} ${id}  ${prev ?? '(none)'} -> ${next}`);
  if (!checkOnly) {
    bundle.versionHash = next;
    writeFileSync(file, JSON.stringify(bundle, null, 2) + '\n');
  }
}

console.log(`\n${ids.length} characters, ${changed} ${checkOnly ? 'drifted' : 'rehashed'}.`);
if (checkOnly && changed > 0) process.exit(1);
