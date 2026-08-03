/**
 * Vercel static build: assembles everything the dev server (packages/client/
 * server.mjs) serves at runtime into a single static `public/` directory that
 * Vercel can host without a Node process.
 *
 *   /                  -> demo/agent-fighter.html   (as index.html)
 *   /characters/*      -> repo characters/  (minus frames-raw)
 *   /stages/*          -> repo stages/
 *   /pets/*            -> repo pets/       (ADR 0011)
 *   /assets/*          -> packages/client/assets/  (audio, bg video, logos)
 *   /api/characters    -> static JSON list (fetch().json() ignores mime type)
 *   /api/stages        -> static JSON list
 *
 * Run AFTER `npm run demo` has produced packages/client/demo/agent-fighter.html.
 */
import {
  cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');
const OUT = join(ROOT, 'public');
const CHARACTERS = join(ROOT, 'characters');
const STAGES = join(ROOT, 'stages');
const PETS = join(ROOT, 'pets');
const ASSETS = join(ROOT, 'packages', 'client', 'assets');
const DEMO = join(ROOT, 'packages', 'client', 'demo');

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

// EVERYTHING bundle.mjs emitted, tree and all: the demo html, vendor/
// airkit.umd.js, sw.js + manifest.webmanifest (the worker must sit at the
// site root so its scope covers the app), .well-known/jwks.json.
//
// Copy the tree rather than naming files. A hardcoded list silently drifts
// from what the bundler emits and 404s in production — that is exactly how
// vendor/airkit.umd.js went missing and took AIR sign-in down with it.
cpSync(DEMO, OUT, { recursive: true });

// The demo is the landing page; keep /m1 as a short alias for the M1 build.
cpSync(join(DEMO, 'agent-fighter.html'), join(OUT, 'index.html'));
if (existsSync(join(DEMO, 'agent-fighter-m1.html'))) {
  cpSync(join(DEMO, 'agent-fighter-m1.html'), join(OUT, 'm1.html'));
}

// Static trees. frames-raw is authoring scratch — never ship it.
if (existsSync(CHARACTERS)) {
  cpSync(CHARACTERS, join(OUT, 'characters'), {
    recursive: true,
    filter: (src) => !src.includes('frames-raw'),
  });
}
if (existsSync(STAGES)) cpSync(STAGES, join(OUT, 'stages'), { recursive: true });
if (existsSync(PETS)) cpSync(PETS, join(OUT, 'pets'), { recursive: true });
if (existsSync(ASSETS)) cpSync(ASSETS, join(OUT, 'assets'), { recursive: true });

// The two dynamic endpoints, frozen to static files at build time.
const listDirs = (base, marker) => (existsSync(base)
  ? readdirSync(base, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(base, d.name, marker)))
    .map((d) => d.name)
  : []);

mkdirSync(join(OUT, 'api'), { recursive: true });
const chars = listDirs(CHARACTERS, 'character.json');
const stages = listDirs(STAGES, 'stage.json');
writeFileSync(join(OUT, 'api', 'characters'), JSON.stringify(chars));
writeFileSync(join(OUT, 'api', 'stages'), JSON.stringify(stages));

const pets = existsSync(PETS) ? listDirs(PETS, 'pet.json') : [];
console.log(`vercel-build: public/ ready — ${chars.length} characters, ${stages.length} stages, ${pets.length} pets`);
