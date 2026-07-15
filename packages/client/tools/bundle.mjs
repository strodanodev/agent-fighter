/**
 * Minimal offline bundler for the M0 demo (no esbuild/vite in this env).
 * Compiles the TS program with tsc, then concatenates the emitted ES modules
 * in dependency order, stripping import/export statements. Works because the
 * codebase uses unique top-level names and no cyclic imports (enforced by
 * convention; a name collision fails loudly below).
 */
import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, '..');
const tmp = join(pkg, '.bundle-tmp');

rmSync(tmp, { recursive: true, force: true });
execSync(
  `tsc -p tsconfig.json --outDir ${JSON.stringify(tmp)} --declaration false --sourceMap false`,
  { cwd: pkg, stdio: 'inherit' },
);

// Dependency order (leaf → root). index.ts is types/re-exports only — skipped.
const ORDER = [
  'core/src/fp.js',
  'core/src/input.js',
  'core/src/data.js',
  'core/src/characters/analog.js',
  'core/src/motion.js',
  'core/src/state.js',
  'core/src/sim.js',
  'core/src/anim.js',
  'core/src/ai.js',
  'client/src/atlas.js',
  'client/src/chrome.js',
  'client/src/progress.js',
  'client/src/ui.js',
  'client/src/main.js',
];

const seen = new Map();
const chunks = [];
for (const rel of ORDER) {
  let src = readFileSync(join(tmp, rel), 'utf8');
  src = src
    .replace(/^import\s[^;]*;\s*$/gm, '')
    .replace(/^export\s*\{[^}]*\}\s*(from\s*[^;]*)?;\s*$/gm, '')
    .replace(/^export\s+/gm, '');
  // Loud collision guard.
  for (const m of src.matchAll(/^(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm)) {
    const name = m[1];
    if (seen.has(name)) throw new Error(`Top-level name collision: ${name} in ${rel} and ${seen.get(name)}`);
    seen.set(name, rel);
  }
  chunks.push(`// ---- ${rel} ----\n${src.trim()}`);
}
rmSync(tmp, { recursive: true, force: true });

const js = chunks.join('\n\n');
const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Agent Fighter</title>
<style>
  html,body{margin:0;height:100%;background:#07050d;display:flex;align-items:center;justify-content:center;font-family:"Courier New",monospace;color:#666;overflow:hidden}
  canvas{image-rendering:pixelated;box-shadow:0 0 0 3px #d9a441,0 0 0 6px #14121f,0 10px 60px #000c;
         width:min(96vw, calc(96vh * 16 / 9));height:auto;aspect-ratio:16/9}
</style>
</head>
<body>
<canvas id="game" width="960" height="540"></canvas>
<script>
${js}
</script>
</body>
</html>
`;

mkdirSync(join(pkg, 'demo'), { recursive: true });
const out = join(pkg, 'demo', 'agent-fighter.html');
writeFileSync(out, html);
console.log(`bundled → ${out} (${(html.length / 1024).toFixed(1)} KB)`);
