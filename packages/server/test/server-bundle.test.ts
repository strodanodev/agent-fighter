import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { builtinModules } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { playOneMatch } from '../src/agent-session.js';

/**
 * THE GAUNTLET SERVER SHIPS AS A LITNODE SERVER BUNDLE (ADR 0014).
 *
 * litnode packs this repo's per-match server into a hashed artifact
 * (litnode tools/bundle-server.mjs + gauntlets/agent-fighter.server.json):
 * esbuild inlines @af/core and ws into ONE module at the entry's own path, a
 * one-line run.mjs imports it, and the character / stage / pet JSON ride
 * beside it. No node_modules, no install step on an operator's machine.
 *
 * This test builds exactly that layout with exactly those esbuild options,
 * runs it from a bare temp directory with a scrubbed environment, and plays
 * a placed, signed match through it to a fake node. If a change makes the
 * server read a file the bundle does not carry, import something esbuild
 * cannot inline, or depend on the checkout, it fails here rather than on the
 * first operator who opts in.
 */
const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, '..', '..', '..');
const ENTRY = 'packages/server/src/gauntlet-server.ts';
const hex = (n: number): string => randomBytes(n).toString('hex');

/** litnode tools/bundle-server.mjs, the esbuild call, option for option. */
const bundleOnce = async (): Promise<Buffer> => {
  const r = await build({
    entryPoints: [join(REPO, ENTRY)], bundle: true, write: false, format: 'esm', platform: 'node', target: 'node20',
    external: [...builtinModules, ...builtinModules.map((m) => `node:${m}`), 'bufferutil', 'utf-8-validate'],
    banner: { js: '// agent-fighter.v1 match server · built by litnode tools/bundle-server.mjs\nimport { createRequire as __litnodeRequire } from \'node:module\'; const require = __litnodeRequire(import.meta.url);' },
    legalComments: 'none', logLevel: 'silent', absWorkingDir: REPO,
  });
  assert.equal(r.errors.length, 0, r.errors.map((e) => e.text).join('\n'));
  return Buffer.from(r.outputFiles[0]!.contents);
};

const mintTicket = (claims: object, secret: string): string => {
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${payload}.${createHmac('sha256', secret).update(payload).digest('base64url')}`;
};

let dir = '';
let child: ChildProcess | null = null;
let node: Server | null = null;
after(() => {
  child?.kill();
  node?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('the gauntlet server as a litnode server bundle', () => {
  it('bundles to one self-contained module, byte-identical on every build', async () => {
    const [a, b] = [await bundleOnce(), await bundleOnce()];
    assert.ok(a.equals(b), 'two builds of the same checkout differ: the serverHash would not be reproducible');
    const code = a.toString('utf8');
    // Every static import left in the module must be a Node builtin: the rest is inlined.
    const imports = [...code.matchAll(/^import\s.*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]!);
    const foreign = imports.filter((s) => !s.startsWith('node:') && !builtinModules.includes(s));
    assert.deepEqual(foreign, [], `imports esbuild did not inline: ${foreign.join(', ')}`);
    assert.ok(!code.includes('/node_modules/@af/'), 'no workspace path baked in');
  });

  it('runs from a bare directory with a scrubbed environment and settles a signed ranked match', async () => {
    dir = mkdtempSync(join(tmpdir(), 'af-server-bundle-'));
    mkdirSync(join(dir, 'packages', 'server', 'src'), { recursive: true });
    writeFileSync(join(dir, 'packages', 'server', 'src', 'gauntlet-server.mjs'), await bundleOnce());
    writeFileSync(join(dir, 'run.mjs'), "import './packages/server/src/gauntlet-server.mjs';\n");
    // The spec's include list: characters/*/character.json, stages/*/stage.json, pets/*/pet.json — nothing else.
    for (const [sub, file] of [['characters', 'character.json'], ['stages', 'stage.json'], ['pets', 'pet.json']] as const) {
      for (const id of readdirSync(join(REPO, sub))) {
        const src = join(REPO, sub, id, file);
        if (!existsSync(src)) continue;
        mkdirSync(join(dir, sub, id), { recursive: true });
        cpSync(src, join(dir, sub, id, file));
      }
    }
    assert.ok(!existsSync(join(dir, 'node_modules')));

    const posted: { mode: string; participants: string[]; signatures?: Record<string, string>; hydration: { pin: { intake?: string } } }[] = [];
    node = createServer((req, res) => {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => { posted.push(JSON.parse(body)); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ attestation: 'players' })); });
    });
    await new Promise<void>((r) => node!.listen(0, '127.0.0.1', r));

    const matchId = hex(32);
    const room = `LIT-${matchId.slice(0, 32).toUpperCase()}`;
    const secret = hex(32);
    const keys = [hex(32), hex(32)] as const;
    const port = 30000 + (randomBytes(2).readUInt16BE() % 20000);
    // Only what litnode's node/gauntlet.js sets, plus what Windows needs to start a process. No AIR, no Supabase.
    const env: NodeJS.ProcessEnv = {
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      PATH: process.env.PATH ?? '',
      GAUNTLET_MATCH_ID: matchId, GAUNTLET_ROOM: room, GAUNTLET_PORT: String(port), GAUNTLET_SECRET: secret,
      GAUNTLET_SEATS: JSON.stringify([{ sub: keys[0], team: 0, slot: 0 }, { sub: keys[1], team: 1, slot: 0 }]),
      GAUNTLET_NODE_URL: `http://127.0.0.1:${(node.address() as { port: number }).port}`,
      GAUNTLET_PLACED_MODE: 'ranked', GAUNTLET_SEED: hex(32), GAUNTLET_RULESET: 'agent-fighter.v1',
      AF_NO_PACE_CHECK: '1',
    };
    child = spawn(process.execPath, ['run.mjs'], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout!.on('data', (d) => { out += String(d); });
    child.stderr!.on('data', (d) => { out += String(d); });
    const exited = new Promise<number | null>((r) => child!.on('exit', (code) => r(code)));
    for (let i = 0; i < 150 && !out.includes('[gauntlet] agent-fighter match'); i++) await new Promise((r) => setTimeout(r, 100));
    assert.match(out, /\[gauntlet\] agent-fighter match .* \(ranked\)/, `the bundle did not come up:\n${out}`);
    assert.match(out, /reputation write-back off/, 'no AIR in a gauntlet');

    const tk = (i: 0 | 1): string => mintTicket({ sub: keys[i], matchId, team: i, slot: 0, mode: 'singles', exp: Date.now() + 60_000 }, secret);
    const charactersDir = join(REPO, 'characters');
    const sign = (): string => 'ab'.repeat(64);
    await Promise.all([
      playOneMatch({ url: `ws://127.0.0.1:${port}`, name: 'A', character: 'analog', skill: 70, charactersDir, aiSeed: 1, paceMs: 1, mode: 'friendly', room, ticket: tk(0), signLedger: sign }),
      playOneMatch({ url: `ws://127.0.0.1:${port}`, name: 'B', character: 'vector', skill: 55, charactersDir, aiSeed: 2, paceMs: 1, mode: 'friendly', room, ticket: tk(1), signLedger: sign }),
    ]);
    const code = await Promise.race([exited, new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 40_000))]);
    assert.equal(code, 0, `the bundled server should exit 0 once the node settled it:\n${out}`);
    assert.equal(posted.length, 1, 'one submission reached the node');
    assert.equal(posted[0]!.mode, 'ranked');
    assert.deepEqual(posted[0]!.participants, [keys[0], keys[1]]);
    assert.deepEqual(Object.keys(posted[0]!.signatures ?? {}).sort(), [...keys].sort());
    assert.equal(posted[0]!.hydration.pin.intake, 'gauntlet');
  });
});
