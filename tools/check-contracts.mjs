#!/usr/bin/env node
/** No litVM contract address is hard-coded anywhere in this repo's source.
 *
 *  The client READS the current contract set at runtime — the cabinet's cabinet:init.chain, else
 *  https://arcade.litvm.games/contracts.json (both litnode's own contracts/deployed.testnet.json, regenerated on
 *  every deploy) — and has no fallback pair. A hand-copied set is exactly what took the client down: a baked
 *  generation-2 pair resolved a dead relay hostname and showed SERVER OFFLINE for a day after the
 *  generation-3 deploy (22 Sep 2026), and the "CI check" that was meant to catch a lagging pair was never wired
 *  into CI. So this is not a freshness check on a copy; it forbids the copy. Part of `npm run verify`.
 *
 *    node tools/check-contracts.mjs            fail on any 0x…40-hex literal in packages/<pkg>/src, packages/<pkg>/tools, tools/
 *    node tools/check-contracts.mjs --arcade   also fetch the arcade's contracts.json and check it names what the client reads */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = new Set(['node_modules', 'dist', 'demo', 'vendor', '.git']);
const EXT = /\.(m?[jt]s|tsx?|cjs)$/;
const ADDR = /0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g;

const walk = (dir, out = []) => {
  let names;
  try { names = readdirSync(dir); } catch { return out; }
  for (const n of names) {
    if (SKIP.has(n)) continue;
    const p = join(dir, n);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, out);
    else if (EXT.test(n)) out.push(p);
  }
  return out;
};

const roots = [join(root, 'tools')];
for (const pkg of readdirSync(join(root, 'packages'))) for (const sub of ['src', 'tools']) roots.push(join(root, 'packages', pkg, sub));
const hits = [];
for (const file of roots.flatMap((r) => walk(r))) {
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => { for (const m of line.matchAll(ADDR)) hits.push(`${relative(root, file).replace(/\\/g, '/')}:${i + 1}  ${m[0]}`); });
}
if (hits.length) {
  console.error(`check-contracts: ${hits.length} hard-coded contract address${hits.length === 1 ? '' : 'es'} — read them from the arcade's contracts.json (packages/client/src/mesh.ts contractSet) instead:\n  ${hits.join('\n  ')}`);
  process.exit(1);
}
console.log('check-contracts: no hard-coded litVM contract addresses in source');

if (process.argv.includes('--arcade')) {
  const url = 'https://arcade.litvm.games/contracts.json';
  const r = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!r.ok) { console.error(`check-contracts: ${url} → HTTP ${r.status}`); process.exit(1); }
  const doc = await r.json();
  const isAddr = (v) => typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v);
  const need = ['NodeDirectory', 'NodeStake', 'MatchBook', 'EpochAnchor'];
  const missing = need.filter((k) => !isAddr(doc?.contracts?.[k]?.address));
  if (missing.length) { console.error(`check-contracts: ${url} lacks ${missing.join(', ')}`); process.exit(1); }
  if (!doc.explorer) console.warn("check-contracts: the arcade's contracts.json names no `explorer` (litnode < 0.12.0): EpochAnchor links stay off until it does");
  console.log(`check-contracts: the arcade serves generation ${doc.generation ?? '?'} (chain ${doc.chainId ?? '?'}) with ${need.join(', ')}${doc.explorer ? ` and explorer ${doc.explorer}` : ''}`);
}
