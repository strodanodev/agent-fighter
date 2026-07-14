/** One-shot: export the in-repo ANALOG TS module to characters/analog/character.json. */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const { ANALOG, loadCharacter } = await import(
  new URL('../../core/src/index.ts', import.meta.url).href
);

loadCharacter(ANALOG); // validates before writing
const dir = join(root, 'characters', 'analog');
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'character.json'), JSON.stringify(ANALOG, null, 2) + '\n');
console.log(`exported ${ANALOG.moves.length} moves, ${ANALOG.cancels.length} cancel edges → ${join(dir, 'character.json')}`);
