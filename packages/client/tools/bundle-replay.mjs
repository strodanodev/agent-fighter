/**
 * Bundle the REPLAY PLAYER to a standalone ESM (ADR 0010).
 *
 * Output: packages/client/demo/replay-player.js, which `tools/vercel-build.mjs`
 * copies wholesale into `public/` — so the game origin serves it at
 * `/replay-player.js`, with the `Access-Control-Allow-Origin: *` that Vercel
 * already puts on static assets.
 *
 * WHY A SEPARATE BUNDLE, AND WHY HERE
 * The marketing site is a different repo on a different origin, and it needs to
 * play replays. The three ways to do that are: copy `@af/core` into it (drift,
 * and the sim would exist twice — unacceptable for the thing that decides
 * money), copy 148 MB of character art into it (absurd), or serve one small
 * module from the origin that already hosts the art. This is the third.
 *
 * It also means the player is built from the SAME sources `npm run verify`
 * covers, so a replay can never quietly disagree with the game about how a
 * match looks or how the sim steps.
 *
 * ESM, not IIFE: the consumer reaches it with a dynamic `import()`, so the
 * player is only downloaded when someone actually clicks "watch".
 */
import { build } from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { statSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, '..');
const out = join(pkg, 'demo', 'replay-player.js');

await build({
  entryPoints: [join(pkg, 'src', 'replay-player.ts')],
  outfile: out,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2022'],
  minify: true,
  sourcemap: false,
  legalComments: 'none',
  // @af/core is a workspace package resolved through node_modules symlinks;
  // bundling it in is the point — the consumer must not need a package manager.
  alias: { '@af/core': join(pkg, '..', 'core', 'src', 'index.ts') },
});

const kb = (statSync(out).size / 1024).toFixed(1);
console.log(`replay player → demo/replay-player.js (${kb} kB)`);
