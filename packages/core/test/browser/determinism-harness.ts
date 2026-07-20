/**
 * Browser-side golden determinism harness (audit 2026-07-17 red flag 3 /
 * 2026-07-18 carried gate). Runs the SAME golden scenarios the Node golden
 * test runs, in a real browser JS engine, and publishes the resulting hashes.
 * The CI runner (tools/determinism-browser.mjs) loads this in headless
 * Chromium + WebKit and asserts every hash equals the committed Node golden
 * (test/golden/hashes.json). A mismatch = the sim does NOT reproduce
 * bit-identically across engines — the exact failure that would flag an honest
 * player as a deviator and forfeit real credits.
 *
 * Imports the real scenarios.ts so it can never drift from the Node corpus.
 */
import { SCENARIOS, runScenario } from '../golden/scenarios.js';

const results: Record<string, ReturnType<typeof runScenario>> = {};
for (const sc of SCENARIOS) results[sc.name] = runScenario(sc);

// Publish for the driver: a global for JS extraction, and a DOM node as a
// no-eval fallback. `engine` lets the report say which JS engine produced it.
const payload = { engine: navigator.userAgent, results };
(globalThis as unknown as { __afGolden: unknown }).__afGolden = payload;
if (typeof document !== 'undefined') {
  const el = document.createElement('pre');
  el.id = 'af-golden';
  el.textContent = JSON.stringify(payload);
  document.body.appendChild(el);
}
