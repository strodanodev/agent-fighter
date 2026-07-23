/**
 * Build + serve the FEEL LAB (tools/feel-lab/lab.ts).
 *
 * Bundles the lab against @af/core SOURCE (so esbuild inlines the const enums
 * and there is no stale-dist risk), embeds every character bundle as a global,
 * inlines it all into one self-contained HTML, and serves it. Local dev tool.
 *
 *   npm run lab   →   http://localhost:8475
 */
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const charactersDir = join(root, 'characters');
const PORT = Number(process.env.LAB_PORT) || 8475;

// @af/core source imports use ESM ".js" specifiers that resolve to sibling
// ".ts" files (NodeNext style). esbuild does not rewrite extensions, so map
// relative ".js" → ".ts" when the .ts exists.
const jsToTs = {
  name: 'js-to-ts',
  setup(b) {
    b.onResolve({ filter: /\.js$/ }, (args) => {
      if (!args.importer) return;
      const cand = resolve(dirname(args.importer), args.path.replace(/\.js$/, '.ts'));
      return existsSync(cand) ? { path: cand } : undefined;
    });
  },
};

// Embed every character bundle (the sim reads moves/cancels; sprites ignored).
const bundles = {};
for (const id of readdirSync(charactersDir)) {
  const f = join(charactersDir, id, 'character.json');
  if (existsSync(f)) bundles[id] = JSON.parse(readFileSync(f, 'utf8'));
}
console.log(`[lab] embedded ${Object.keys(bundles).length} character bundles`);

const out = await build({
  entryPoints: [join(here, 'lab.ts')],
  bundle: true, format: 'iife', platform: 'browser', target: 'es2020',
  write: false, plugins: [jsToTs], logLevel: 'warning',
});
const js = out.outputFiles[0].text;

const html = `<!doctype html><html><head><meta charset="utf-8"><title>Feel Lab · Agent Fighter</title>
<style>
  :root{color-scheme:dark}
  *{box-sizing:border-box}
  body{margin:0;background:#0b0e13;color:#dfe6f0;font:13px/1.4 ui-monospace,Menlo,Consolas,monospace}
  .wrap{display:flex;gap:14px;padding:14px;align-items:flex-start;flex-wrap:wrap}
  .left{flex:0 0 auto}
  canvas{background:#11151c;border:1px solid #2a3446;border-radius:6px;display:block}
  .right{flex:1 1 360px;min-width:340px;display:flex;flex-direction:column;gap:12px}
  h2{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:#8fa2bd;margin:0 0 6px}
  .panel{background:#121722;border:1px solid #232c3c;border-radius:6px;padding:10px}
  .crow{display:flex;align-items:center;gap:8px;margin:5px 0}
  .crow label{flex:0 0 74px;color:#9fb0c8}
  select,input[type=number],button{background:#1a2130;color:#dfe6f0;border:1px solid #2f3a4e;border-radius:4px;padding:3px 6px;font:inherit}
  button{cursor:pointer}button:hover{background:#232c3e}
  input[type=range]{flex:1 1 auto}
  #diag .fi{border-top:1px solid #232c3c;padding-top:6px;margin-top:6px}
  #diag .fh{font-weight:bold;margin-bottom:3px}
  #diag .k{color:#9fb0c8;font-size:12px}
  #diag .k b{color:#dfe6f0}
  #diag .big{margin:4px 0}
  .bar{height:7px;background:#1a2130;border-radius:3px;overflow:hidden;margin:2px 0}
  .bar span{display:block;height:100%}
  .crunch{display:inline-block;padding:2px 8px;border-radius:4px;background:#1a2130;color:#5a6478;font-weight:bold;letter-spacing:.1em}
  .crunch.on{background:#3a2f12;color:#ffd24a}
  .hist{margin-top:6px;display:flex;flex-wrap:wrap;gap:1px;font-size:11px;color:#7fd1a0}
  .hist span{min-width:11px;text-align:center;background:#141a26;border-radius:2px;padding:0 1px}
  #tuning{max-height:340px;overflow:auto}
  .trow{display:flex;align-items:center;gap:8px;margin:3px 0}
  .trow label{flex:0 0 150px;color:#9fb0c8;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .trow .num{flex:0 0 74px}
  .tbtns{display:flex;gap:8px;margin-bottom:8px}
  #exportOut{display:none;width:100%;height:120px;margin-top:8px;background:#0b0e13;color:#9fb0c8;border:1px solid #2f3a4e;border-radius:4px}
  #chartun{display:flex;gap:12px}
  .ctcol{flex:1 1 0}
  .cth{font-weight:bold;font-size:12px;margin-bottom:5px}
  .ctrow{display:flex;align-items:center;gap:6px;margin:3px 0}
  .ctrow label{flex:1 1 auto;color:#9fb0c8;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .ctrow input{flex:0 0 60px}
  .keys{color:#6b7688;font-size:11px;margin-top:6px}
</style></head>
<body>
  <div class="wrap">
    <div class="left">
      <canvas id="cv" width="960" height="400"></canvas>
      <div class="panel" style="margin-top:12px"><h2>diagnostics</h2><div id="diag"></div>
        <div class="keys">P0: move <b>WASD</b> · punches <b>U I O</b> · kicks <b>J K L</b> · reset <b>R</b>. P1 human: arrows + numpad.</div>
      </div>
    </div>
    <div class="right">
      <div class="panel"><h2>match</h2><div id="controls"></div></div>
      <div class="panel"><h2>per-character tuning (archetype feel)</h2>
        <div id="chartun"></div>
        <div class="keys">blank = the character's own value / global default. Try P0 jumpSquatTicks 14 (heavy) vs P1 4 (nimble), or grabTicks 8 (fast grappler).</div>
      </div>
      <div class="panel"><h2>global tuning (live)</h2>
        <div class="tbtns"><button id="btnResetTuning">reset defaults</button><button id="btnExport">export TUNING</button></div>
        <div id="tuning"></div>
        <textarea id="exportOut" readonly></textarea>
      </div>
    </div>
  </div>
  <script>window.__LAB_BUNDLES__ = ${JSON.stringify(bundles)};</script>
  <script>${js}</script>
</body></html>`;

const outFile = join(here, 'feel-lab.html');
writeFileSync(outFile, html);
console.log(`[lab] wrote ${outFile} (${(html.length / 1024 / 1024).toFixed(2)} MB)`);

createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
}).listen(PORT, () => console.log(`[lab] serving → http://localhost:${PORT}`));
