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
for (const rel of ORDER) {
  let src = readFileSync(join(tmp, rel), 'utf8');
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
