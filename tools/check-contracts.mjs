#!/usr/bin/env node
/** The baked litVM contract pair in packages/client/src/mesh.ts must be the set litnode currently deploys.
 *  The client READS the current set at runtime (cabinet:init, then https://arcade.litvm.games/contracts.json);
 *  the baked pair is only the last resort — but a stale last resort is exactly what showed SERVER OFFLINE
 *  for a day after the generation-3 deploy (22 Sep 2026). CI runs this on every push: red = litnode moved
 *  a generation and this file did not.
 *
 *    node tools/check-contracts.mjs             compare with strodanodev/litnode master (raw GitHub)
 *    node tools/check-contracts.mjs --arcade    compare with what the arcade serves right now */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'packages', 'client', 'src', 'mesh.ts'), 'utf8');
const baked = src.match(/const BAKED = \{ NODE_DIRECTORY: '(0x[0-9a-fA-F]{40})', NODE_STAKE: '(0x[0-9a-fA-F]{40})', generation: (\d+) \}/);
if (!baked) { console.error('check-contracts: BAKED pair not found in mesh.ts'); process.exit(1); }
const [, dir, stake, gen] = baked;

const url = process.argv.includes('--arcade')
  ? 'https://arcade.litvm.games/contracts.json'
  : 'https://raw.githubusercontent.com/strodanodev/litnode/master/contracts/deployed.testnet.json';
const r = await fetch(url, { signal: AbortSignal.timeout(15_000) });
if (!r.ok) { console.error(`check-contracts: ${url} → HTTP ${r.status}`); process.exit(1); }
const doc = await r.json();
// deployed.testnet.json keys contracts at the top level; contracts.json nests them under `contracts`
const set = doc.contracts ?? doc;
const want = { dir: set.NodeDirectory?.address, stake: set.NodeStake?.address, gen: String(doc.generation ?? '?') };
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const bad = [];
if (!same(dir, want.dir)) bad.push(`NodeDirectory: baked ${dir}, litnode ${want.dir}`);
if (!same(stake, want.stake)) bad.push(`NodeStake: baked ${stake}, litnode ${want.stake}`);
if (gen !== want.gen) bad.push(`generation: baked ${gen}, litnode ${want.gen}`);
if (bad.length) { console.error(`check-contracts: mesh.ts BAKED lags ${url}\n  ${bad.join('\n  ')}`); process.exit(1); }
console.log(`check-contracts: baked pair is litnode generation ${gen} (${url})`);
