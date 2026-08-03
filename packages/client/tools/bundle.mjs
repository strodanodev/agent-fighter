/**
 * Minimal offline bundler for the M0 demo (no esbuild/vite in this env).
 * Compiles the TS program with tsc, then concatenates the emitted ES modules
 * in dependency order, stripping import/export statements. Works because the
 * codebase uses unique top-level names and no cyclic imports (enforced by
 * convention; a name collision fails loudly below).
 */
import { execSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, '..');
const tmp = join(pkg, '.bundle-tmp');

// Regenerate the branded PWA icons (assets/icons/*.png) before bundling so a
// fresh checkout / Vercel build always ships them.
execSync(`node ${JSON.stringify(join(here, 'make-icons.mjs'))}`, { cwd: pkg, stdio: 'inherit' });

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
  'core/src/items.js',
  // PETS (ADR 0011): pure data + clamps, imported by BOTH state.js and sim.js,
  // so it has to precede them.
  'core/src/pets.js',
  'core/src/characters/analog.js',
  'core/src/motion.js',
  'core/src/state.js',
  'core/src/sim.js',
  'core/src/anim.js',
  'core/src/ai.js',
  // AGENT ARCADE v2 (ADR 0008). arcade-board depends on arcade-map + items,
  // so it must follow both. The sim reads neither.
  'core/src/arcade-map.js',
  'core/src/arcade-board.js',
  'client/src/atlas.js',
  'client/src/chrome.js',
  'client/src/progress.js',
  'client/src/auth.js',
  'client/src/net.js',
  'client/src/fx.js',
  'client/src/flags.js',
  'client/src/audio.js',
  'client/src/ui.js',
  'client/src/autospecial.js',
  'client/src/pwa.js',
  'client/src/touch.js',
  // The companion renderer — cosmetic, reads FighterState only, so anywhere
  // before main.js works.
  'client/src/pets.js',
  'client/src/main.js',
];

const seen = new Map();
const chunks = [];
// Every INTERNAL value import across the bundled set, collected before imports
// are stripped and validated against `seen` once concatenation is done. This
// turns the bundler's original failure mode — a module left out of ORDER whose
// symbols are referenced but never defined — into a loud BUILD error instead of
// a `ReferenceError: X is not defined` that only fires on a rare runtime path.
// (Regression: `itemById` from core/src/items.ts was used on the results screen
// but items.js was absent from ORDER, freezing the client mid-match, 2026-07-21.)
const valueImports = [];

// tsc has already elided type-only imports from the emitted JS, so every
// `import … from` left here is a real runtime binding. `@af/core` is a path
// alias emitted verbatim (never rewritten by tsc) and relative paths point at
// sibling bundled modules — both are INTERNAL and must resolve inside the
// bundle. Bare packages (node:*, @mocanetwork/*, …) are external and skipped.
const collectImports = (src, rel) => {
  for (const m of src.matchAll(/^import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]\s*;/gm)) {
    const spec = m[2];
    const internal = spec.startsWith('.') || spec === '@af/core' || spec.startsWith('@af/');
    if (!internal) continue;
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
  // Loud collision guard.
  for (const m of src.matchAll(/^(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm)) {
    const name = m[1];
    if (seen.has(name)) throw new Error(`Top-level name collision: ${name} in ${rel} and ${seen.get(name)}`);
    seen.set(name, rel);
  }
  chunks.push(`// ---- ${rel} ----\n${src.trim()}`);
}
rmSync(tmp, { recursive: true, force: true });

// Completeness guard: an internal import with no matching definition means its
// defining module is missing from ORDER above. Fail the build with the exact
// symbols and offending files rather than shipping a bundle that throws only
// when that code path finally runs in production.
const unresolved = valueImports.filter(({ name }) => !seen.has(name));
if (unresolved.length > 0) {
  const lines = unresolved.map(
    ({ rel, name, spec }) => `    - '${name}' (from '${spec}') imported by ${rel}`,
  );
  throw new Error(
    `Bundler: ${unresolved.length} imported symbol(s) have no definition in the bundle. Their ` +
      `defining module is missing from ORDER in packages/client/tools/bundle.mjs — add it:\n` +
      lines.join('\n'),
  );
}

const js = chunks.join('\n\n');
const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
<title>Agent Fighter</title>
<!-- PWA: installable, full-screen, offline-capable (see pwa.ts + /sw.js). -->
<link rel="manifest" href="/manifest.webmanifest">
<meta name="theme-color" content="#0a0616">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Agent Fighter">
<link rel="apple-touch-icon" href="/assets/icons/apple-touch-icon.png">
<link rel="icon" type="image/png" sizes="192x192" href="/assets/icons/icon-192.png">
<style>
  /* AgentDisplay (Anton, SIL OFL) is loaded at runtime from /assets/fonts/ —
     see main.ts loadDisplayFont(). The client already depends on the local
     dev server for characters/stages/UI-kit assets, so this follows the same
     pattern rather than bloating every bundle with a base64 font blob. */
  html,body{margin:0;height:100%;background:#07050d;display:flex;align-items:center;justify-content:center;font-family:"Courier New",monospace;color:#666;overflow:hidden}
  /* Lock the mobile viewport: no rubber-band scroll / pinch-zoom fighting the
     on-screen controls (touch.ts). Harmless on desktop. */
  html,body{position:fixed;inset:0;width:100%;overscroll-behavior:none;touch-action:none}
  canvas{image-rendering:pixelated;box-shadow:0 0 0 3px #14121f,0 10px 60px #000c;
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

// PWA root files (served at / by the dev server and copied to public/ by the
// Vercel build): the web-app manifest + the service worker.
for (const f of ['manifest.webmanifest', 'sw.js']) {
  copyFileSync(join(pkg, 'pwa', f), join(pkg, 'demo', f));
  console.log(`pwa → demo/${f}`);
}

// Vendor the AIR Kit UMD build next to the bundle (auth.ts lazy-loads it as
// vendor/airkit.umd.js on the first sign-in — offline play never fetches it).
// Copied at bundle time, so Vercel's buildCommand produces it too; the copy
// itself is gitignored.
const airkitSrc = join(pkg, '..', '..', 'node_modules', '@mocanetwork', 'airkit', 'dist', 'airkit.umd.js');
const vendorDir = join(pkg, 'demo', 'vendor');
try {
  mkdirSync(vendorDir, { recursive: true });
  copyFileSync(airkitSrc, join(vendorDir, 'airkit.umd.js'));
  console.log('vendored → demo/vendor/airkit.umd.js');
} catch {
  console.log('WARNING: @mocanetwork/airkit not installed — online sign-in disabled in this bundle');
}

// Public partner JWKS (tools/air-keygen.mjs → air/jwks.json, committed) —
// published at /.well-known/jwks.json so the Vercel domain can be registered
// as the JWKS URL in the AIR dashboard. Public-key material only.
const jwksSrc = join(pkg, '..', '..', 'air', 'jwks.json');
try {
  const wellKnown = join(pkg, 'demo', '.well-known');
  mkdirSync(wellKnown, { recursive: true });
  copyFileSync(jwksSrc, join(wellKnown, 'jwks.json'));
  console.log('jwks → demo/.well-known/jwks.json');
} catch {
  console.log('note: air/jwks.json absent (run node tools/air-keygen.mjs) — AIR write-back JWKS not published');
}
