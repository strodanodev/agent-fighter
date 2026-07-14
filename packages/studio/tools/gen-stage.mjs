/**
 * One-shot stage background generator (CLI twin of the Studio Stage tab).
 *   node tools/gen-stage.mjs <stage-id> "<prompt>" [seed]
 * Writes stages/<id>/background.png. floorY in stage.json needs a human eye —
 * set it in the Studio Stage tab (or edit the json) after inspecting.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..', '..', '..');

const env = {};
for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const MODEL = env.NV_MODEL || 'black-forest-labs/flux.2-klein-4b';

const [id, prompt, seedArg] = process.argv.slice(2);
if (!id || !prompt) {
  console.error('usage: node tools/gen-stage.mjs <stage-id> "<prompt>" [seed]');
  process.exit(1);
}

const res = await fetch(`https://ai.api.nvidia.com/v1/genai/${MODEL}`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${env.NVAPI_KEY}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  },
  body: JSON.stringify({
    prompt,
    width: 1536,
    height: 640,
    steps: 4,
    seed: Number(seedArg ?? 7),
  }),
});
if (!res.ok) {
  console.error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  process.exit(1);
}
const body = await res.json();
const b64 = body.artifacts?.[0]?.base64;
if (!b64) {
  console.error('no image in response');
  process.exit(1);
}
const dir = join(ROOT, 'stages', id);
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'background.png'), Buffer.from(b64, 'base64'));
const jsonPath = join(dir, 'stage.json');
if (!existsSync(jsonPath)) {
  writeFileSync(jsonPath, JSON.stringify({
    name: id, imageW: 1536, imageH: 640, floorY: 520,
    skyColor: '#2b1b4d', deckColor: '#3a3644',
  }, null, 2) + '\n');
}
console.log(`stage → ${join(dir, 'background.png')}`);
