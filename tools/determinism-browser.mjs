/**
 * Browser-vs-Node golden determinism gate (audit 2026-07-17 red flag 3 /
 * 2026-07-18 carried gate — "the single highest-consequence missing test").
 *
 * The whole money path assumes the sim is bit-identical when a match is run in
 * a player's BROWSER and re-simulated by the SERVER in Node. If they ever
 * drift, an honest player is flagged as a deviator and forfeits real credits.
 * That equivalence was only ever verified empirically; this gate makes it a
 * red build.
 *
 * It bundles the SAME golden scenarios the Node golden test runs
 * (packages/core/test/browser/determinism-harness.ts imports the real
 * scenarios.ts — no drift), runs them in headless Chromium AND WebKit (WebKit
 * is the engine iOS Safari uses — the cross-engine case that matters most for a
 * mobile-first game), and asserts every scenario's hashes equal the committed
 * Node golden (packages/core/test/golden/hashes.json).
 *
 * Run: `npm run determinism:browser` (needs `npx playwright install chromium
 * webkit` once). Exits non-zero on any divergence.
 */
import { build } from 'esbuild';
import { chromium, webkit } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const coreDir = join(root, 'packages', 'core');
const harnessEntry = join(coreDir, 'test', 'browser', 'determinism-harness.ts');
const goldenPath = join(coreDir, 'test', 'golden', 'hashes.json');

// 1. Bundle the harness fresh (in-memory) so it can never lag scenarios.ts.
const bundled = await build({ entryPoints: [harnessEntry], bundle: true, format: 'esm', write: false });
const js = bundled.outputFiles[0].text;
const html = `<!doctype html><meta charset="utf-8"><body><script type="module">${js}</script></body>`;

// 2. Serve it on an ephemeral port.
const server = createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(html);
});
await new Promise((r) => server.listen(0, r));
const url = `http://127.0.0.1:${server.address().port}/`;

// 3. The committed Node golden IS the source of truth (the server re-sims to it).
const golden = JSON.parse(readFileSync(goldenPath, 'utf8'));
const names = Object.keys(golden).filter((k) => !k.startsWith('_'));

// 4. Run the corpus in each browser engine and diff against the Node golden.
let failed = false;
for (const [engine, launcher] of Object.entries({ chromium, webkit })) {
  let browser;
  try {
    browser = await launcher.launch();
  } catch (e) {
    console.error(`✗ ${engine}: could not launch — run \`npx playwright install ${engine}\` (${String(e).split('\n')[0]})`);
    failed = true;
    continue;
  }
  const page = await browser.newPage();
  await page.goto(url);
  await page.waitForFunction('window.__afGolden !== undefined', null, { timeout: 30_000 });
  const { results } = await page.evaluate('window.__afGolden');
  await browser.close();

  let ok = 0;
  const diverged = [];
  for (const k of names) {
    const g = golden[k];
    const r = results[k];
    if (r && r.finalHash === g.finalHash && r.traceHash === g.traceHash) ok++;
    else {
      diverged.push(k);
      console.error(`  ✗ ${engine}/${k}: got final=${r?.finalHash} trace=${r?.traceHash}, want final=${g.finalHash} trace=${g.traceHash}`);
    }
  }
  if (diverged.length) {
    failed = true;
    console.error(`✗ ${engine}: ${ok}/${names.length} match — ${diverged.length} DIVERGE from the Node golden (money-path desync risk)`);
  } else {
    console.log(`✓ ${engine}: all ${ok} golden scenarios are bit-identical to Node`);
  }
}

server.close();
if (failed) process.exit(1);
console.log('✓ browser-vs-Node determinism holds across engines.');
