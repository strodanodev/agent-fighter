import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * DETERMINISM INVARIANT GUARD.
 *
 * The determinism rules (@af/core must be bit-identical across browsers, Node,
 * and re-simulation) live in prose in CLAUDE.md / AGENTS.md — but prose is a
 * suggestion a fresh model may never read. This test makes the load-bearing
 * rules MECHANICAL: it scans every source file in @af/core and fails the build
 * if forbidden non-deterministic constructs appear in real code.
 *
 * What's banned and why:
 *  - Math.random           → non-deterministic; the sim's PRNG lives in GameState
 *  - Date / Date.now       → wall-clock is non-deterministic + breaks replay
 *  - performance.*         → same
 *  - transcendental Math.* → sqrt/trig/pow/log/exp can differ bit-wise across
 *                            platform libms; diverges rollback + server verify
 *  - DOM / timers / IO     → @af/core is pure: no window/document/fetch/timers
 *  - process.*             → node env is non-portable + non-deterministic
 *
 * Allowed integer-exact Math: abs, min, max, trunc, floor, ceil, round, sign,
 * imul. If you genuinely need a banned construct, it does NOT belong in the
 * sim — put it in the client/studio, keyed off state, never inside @af/core.
 */

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

const tsFiles = (dir: string): string[] => {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...tsFiles(p));
    else if (entry.endsWith('.ts')) out.push(p);
  }
  return out;
};

/** Strip block + line comments so rules named in comments don't false-trip. */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

interface Rule { name: string; re: RegExp }
const FORBIDDEN: Rule[] = [
  { name: 'Math.random', re: /\bMath\.random\b/ },
  {
    name: 'transcendental Math (sqrt/trig/pow/log/exp — platform-divergent)',
    re: /\bMath\.(sqrt|cbrt|hypot|pow|exp|expm1|log|log2|log10|sin|cos|tan|asin|acos|atan|atan2|sinh|cosh|tanh)\b/,
  },
  { name: 'Date', re: /\bnew\s+Date\b|\bDate\s*\.\s*now\b|\bDate\s*\(/ },
  { name: 'performance', re: /\bperformance\s*\./ },
  { name: 'window.', re: /\bwindow\s*\./ },
  { name: 'document.', re: /\bdocument\s*\./ },
  { name: 'globalThis', re: /\bglobalThis\b/ },
  { name: 'requestAnimationFrame', re: /\brequestAnimationFrame\s*\(/ },
  { name: 'timers (setTimeout/setInterval/setImmediate)', re: /\b(setTimeout|setInterval|setImmediate)\s*\(/ },
  { name: 'fetch', re: /\bfetch\s*\(/ },
  { name: 'storage (localStorage/sessionStorage)', re: /\b(localStorage|sessionStorage)\b/ },
  { name: 'process.', re: /\bprocess\s*\./ },
];

describe('@af/core determinism invariants (mechanical guard)', () => {
  const files = tsFiles(SRC);

  it('has source files to scan', () => {
    assert.ok(files.length >= 6, `expected the core src tree, found ${files.length} files`);
  });

  for (const rule of FORBIDDEN) {
    it(`forbids ${rule.name} anywhere in @af/core`, () => {
      const hits: string[] = [];
      for (const file of files) {
        const code = stripComments(readFileSync(file, 'utf8'));
        code.split('\n').forEach((line, i) => {
          if (rule.re.test(line)) hits.push(`${file.replace(SRC, 'core/src')}:${i + 1}  ${line.trim()}`);
        });
      }
      assert.equal(hits.length, 0,
        `forbidden construct "${rule.name}" in @af/core (determinism rule):\n  ${hits.join('\n  ')}`);
    });
  }
});
