/**
 * Studio bundler — same offline concat approach as the client demo:
 * tsc-compile, concatenate ES modules in dependency order stripping
 * imports/exports, inject into a single HTML file with the Studio shell CSS.
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

// Dependency order (leaf → root). core index.ts is re-exports only — skipped.
const ORDER = [
  'core/src/fp.js',
  'core/src/input.js',
  'core/src/data.js',
  // PETS (ADR 0011): state.js reads NO_AURA/clampAura at MODULE level, so
  // leaving this out does not fail to compile — it produces a bundle that
  // throws on load and renders a blank Studio.
  'core/src/pets.js',
  'core/src/characters/analog.js',
  'core/src/motion.js',
  'core/src/state.js',
  'core/src/sim.js',
  'core/src/anim.js',
  'studio/src/pipeline.js',
  'studio/src/main.js',
];

const seen = new Map();
const chunks = [];
// Every INTERNAL value import across the bundled set, collected before imports
// are stripped and checked against `seen` once concatenation is done. This is
// the same completeness guard the client bundler carries, ported here after a
// module left out of ORDER (core/src/pets.js) shipped a Studio that threw
// `ReferenceError: NO_AURA is not defined` on load and rendered a blank page
// — with a clean build and a clean typecheck (2026-08-03).
const valueImports = [];

// tsc has already elided type-only imports, so every surviving `import … from`
// is a real runtime binding. Relative paths and `@af/*` are INTERNAL and must
// resolve inside the bundle; bare packages are external and skipped.
const collectImports = (src, rel) => {
  for (const m of src.matchAll(/^import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]\s*;/gm)) {
    const spec = m[2];
    if (!(spec.startsWith('.') || spec.startsWith('@af/'))) continue;
    const named = m[1].trim().match(/^\{([\s\S]*)\}$/);
    if (!named) continue; // default / namespace imports: none in the bundled set
    for (const part of named[1].split(',')) {
      // Validate the ORIGINAL exported name (`x` in `x as y`) — that is the
      // binding a concatenation bundle must actually define.
      const name = part.trim().split(/\s+as\s+/)[0].trim();
      if (name) valueImports.push({ rel, name, spec });
    }
  }
};

for (const rel of ORDER) {
  let src = readFileSync(join(tmp, rel), 'utf8');
  collectImports(src, rel);
  src = src
    .replace(/^import\s[^;]*;\s*$/gm, '')
    .replace(/^export\s*\{[^}]*\}\s*(from\s*[^;]*)?;\s*$/gm, '')
    .replace(/^export\s+/gm, '');
  for (const m of src.matchAll(/^(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm)) {
    const name = m[1];
    if (seen.has(name)) throw new Error(`Top-level name collision: ${name} in ${rel} and ${seen.get(name)}`);
    seen.set(name, rel);
  }
  chunks.push(`// ---- ${rel} ----\n${src.trim()}`);
}
rmSync(tmp, { recursive: true, force: true });

// Completeness guard: an internal import with no matching definition means its
// defining module is missing from ORDER above. Fail the BUILD with the exact
// symbols rather than shipping a bundle that only throws in the browser.
const unresolved = valueImports.filter(({ name }) => !seen.has(name));
if (unresolved.length > 0) {
  const lines = unresolved.map(
    ({ rel, name, spec }) => `    - '${name}' (from '${spec}') imported by ${rel}`,
  );
  throw new Error(
    `Bundler: ${unresolved.length} imported symbol(s) have no definition in the bundle. `
      + 'Their defining module is missing from ORDER in '
      + `packages/studio/tools/bundle.mjs — add it:\n${lines.join('\n')}`,
  );
}

const js = chunks.join('\n\n');
const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Agent Fighter Studio</title>
<style>
  :root { color-scheme: dark; }
  html,body{margin:0;min-height:100%;background:#0b0c14;color:#cdd3e0;font-family:ui-monospace,Consolas,monospace;font-size:13px}
  button{background:#222738;color:#cdd3e0;border:1px solid #3d4260;border-radius:4px;padding:4px 10px;cursor:pointer;font:inherit}
  button:hover{background:#2c3350}
  button:disabled{opacity:.45;cursor:default}
  input,select{background:#161927;color:#cdd3e0;border:1px solid #3d4260;border-radius:4px;padding:3px 6px;font:inherit}
  .header{display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid #262b40;flex-wrap:wrap;position:sticky;top:0;background:#0b0c14ee;z-index:5}
  .logo{color:#e94560;font-weight:700;letter-spacing:1px;margin-right:6px}
  .tab.active{background:#e94560;border-color:#e94560;color:#fff}
  .save.dirty{background:#ffd166;color:#111;border-color:#ffd166}
  .status{color:#8a91a8;margin-left:auto;max-width:46ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .pane{padding:14px}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:10px;max-width:1100px}
  .field{display:flex;justify-content:space-between;align-items:center;gap:6px;background:#141724;border:1px solid #232840;border-radius:6px;padding:6px 10px}
  .row{display:flex;align-items:flex-start;gap:12px;margin:10px 0;flex-wrap:wrap}
  .hint{color:#8a91a8}
  .steplist{display:flex;gap:4px;flex-wrap:wrap;margin:8px 0}
  .stepbtn{padding:6px 8px}
  .stepbtn.cur{outline:2px solid #ffd166}
  .stepbtn.startup{border-color:#4f80c0}
  .stepbtn.active{border-color:#f87171}
  .stepbtn.recovery{border-color:#8a91a8}
  .frcanvas,.testcanvas{background:#181a28;border:1px solid #262b40;border-radius:6px}
  .props{display:flex;flex-direction:column;gap:6px;min-width:250px}
  .hbprops{margin-top:10px;border-top:1px solid #262b40;padding-top:10px}
  .movetable,.canceltable{border-collapse:collapse}
  .movetable th,.movetable td{border:1px solid #262b40;padding:3px 6px;text-align:left}
  .movetable .num{text-align:right;color:#8a91a8}
  .canceltable th,.canceltable td{border:1px solid #262b40;padding:2px 4px;font-size:11px}
  .canceltable .rot{writing-mode:vertical-rl;transform:rotate(180deg);max-height:64px}
  .cc{cursor:pointer;text-align:center;min-width:26px;color:#555}
  .cc.H{background:#284034;color:#4ade80}
  .cc.HB{background:#3d3550;color:#ffd166}
  .cc.B{background:#33283d;color:#c084fc}
  .scrollx{overflow-x:auto}
  .genblock{border:1px solid #262b40;border-radius:8px;padding:12px;margin-bottom:14px}
  .genrow{display:flex;gap:10px;flex-wrap:wrap}
  .genframe{display:flex;flex-direction:column;gap:4px;align-items:center}
  .thumb{border:1px solid #262b40;border-radius:4px;image-rendering:pixelated}
  .thumb.empty{width:150px;height:150px;display:flex;align-items:center;justify-content:center;color:#3d4260}
  .modal{position:fixed;inset:0;background:#000a;display:flex;align-items:center;justify-content:center;z-index:50}
  .modalbox{background:#141724;border:1px solid #3d4260;border-radius:10px;padding:20px 24px;display:flex;flex-direction:column;gap:10px;min-width:440px;box-shadow:0 20px 60px #000c}
  .upload{background:#222738;border:1px solid #3d4260;border-radius:4px;padding:4px 10px;cursor:pointer;display:inline-block}
  .upload:hover{background:#2c3350}
  .genframe .thumb{transition:outline .1s}
  .genframe[style*="cursor:pointer"]:hover .thumb{outline:2px solid #ffd166}
  .qc{font-size:11px;padding:1px 6px;border-radius:3px}
  .qc.pass{background:#284034;color:#4ade80}
  .qc.fail{background:#452531;color:#f87171}
  .swatch{width:18px;height:18px;border-radius:3px;display:inline-block;border:1px solid #0006}
</style>
</head>
<body>
<div id="app"></div>
<script>
${js}
</script>
</body>
</html>
`;

mkdirSync(join(pkg, 'dist'), { recursive: true });
const out = join(pkg, 'dist', 'studio.html');
writeFileSync(out, html);
console.log(`bundled → ${out} (${(html.length / 1024).toFixed(1)} KB)`);
