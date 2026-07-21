#!/usr/bin/env node
/**
 * `npm run ship` — one command to take newly-authored characters from the
 * working tree to LIVE prod, doing every check + step we otherwise do by hand.
 *
 * Encodes the lessons from two manual roster deploys (see
 * memory/agent-fighter-deployment.md):
 *
 *   1. WRONG-DIRECTORY TRAP. The real repo is the `agent-fighter/` folder; the
 *      parent `AGENT FIGHTER/` wrapper contains a STRAY home-dir git repo. This
 *      script refuses to run unless it's in the actual agent-fighter repo.
 *   2. BUNDLE-HASH PIN. Studio writes a canonical sim-only `versionHash`; if it
 *      ever drifts, online play breaks with "bundle hash mismatch". We assert
 *      `rehash --check` is clean before AND after building.
 *   3. PAIRED DEPLOY. The Railway match server reads every `character.json` off
 *      disk to verify matches, and the Vercel client serves the bundles + roster
 *      manifest. New characters must land on BOTH — always deploy the pair.
 *   4. WORKING-TREE UPLOAD. `railway up` / `vercel deploy` ship the WORKING TREE,
 *      not git HEAD. So an untracked, unfinished character (e.g. a Studio WIP)
 *      silently rides along to prod. This script blocks the deploy when an
 *      untracked/incomplete character would ship ENABLED, unless you pass
 *      --include-wip (finish it, mark it meta.disabled, or opt in explicitly).
 *   5. ENGINE SKEW. After deploy, the Railway `engine` must equal the client's
 *      ENGINE_VERSION; a mismatch hello-rejects every online match. We verify.
 *
 * Usage:
 *   npm run ship -- [-m "commit message"] [flags]
 *   node tools/ship-characters.mjs [-m "commit message"] [flags]
 *
 * Flags:
 *   -m <msg>       Commit message. Default: auto-derived from the changed roster.
 *   --skip-verify  Skip `npm run verify` (typecheck + tests). NOT recommended.
 *   --no-deploy    Commit + push only; skip the Railway/Vercel deploy.
 *   --include-wip  Also commit untracked/incomplete characters (default: refuse).
 *   --all          Stage ALL modified tracked files, not just character/demo work.
 *   -y, --yes      Skip the confirmation prompt (for scripted/non-TTY runs).
 *   --dry-run      Print the plan and exit without changing anything.
 */
import { execSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHARACTERS = join(ROOT, 'characters');
const HEALTH = 'https://match-server-production.up.railway.app/';
const VERCEL_ALIAS = 'https://agent-fighter.vercel.app';

// ── tiny log helpers ────────────────────────────────────────────────────────
const c = { dim: '\x1b[2m', red: '\x1b[31m', grn: '\x1b[32m', ylw: '\x1b[33m', cyn: '\x1b[36m', b: '\x1b[1m', x: '\x1b[0m' };
const log = (m) => console.log(m);
const step = (m) => console.log(`\n${c.cyn}${c.b}▸ ${m}${c.x}`);
const ok = (m) => console.log(`  ${c.grn}✓${c.x} ${m}`);
const warn = (m) => console.log(`  ${c.ylw}!${c.x} ${m}`);
const fail = (m) => { console.error(`\n${c.red}✗ ${m}${c.x}`); process.exit(1); };

// ── args ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const take = (flag) => { const i = argv.indexOf(flag); if (i < 0) return null; const v = argv[i + 1]; argv.splice(i, 2); return v; };
const has = (flag) => { const i = argv.indexOf(flag); if (i < 0) return false; argv.splice(i, 1); return true; };
const flags = {
  skipVerify: has('--skip-verify'),
  noDeploy: has('--no-deploy'),
  includeWip: has('--include-wip'),
  all: has('--all'),
  yes: has('--yes') || has('-y'),
  dryRun: has('--dry-run'),
};
let message = take('-m') ?? take('--message');
// any remaining bare token is treated as the message
if (!message) message = argv.find((a) => !a.startsWith('-')) ?? null;

// ── shell helpers ───────────────────────────────────────────────────────────
const git = (args) => execSync(`git ${args}`, { cwd: ROOT, encoding: 'utf8' }).trim();
const gitLines = (args) => git(args).split('\n').map((l) => l.trim()).filter(Boolean);
const exec = (label, cmd, args, { tolerate } = {}) => {
  log(`  ${c.dim}→ ${cmd} ${args.join(' ')}${c.x}`);
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', shell: true, stdio: tolerate ? 'pipe' : 'inherit' });
  if (tolerate) { process.stdout.write(`${r.stdout ?? ''}${r.stderr ?? ''}`); }
  if (r.status !== 0 && !(tolerate && tolerate.test(`${r.stdout ?? ''}${r.stderr ?? ''}`))) {
    fail(`${label} failed (exit ${r.status})`);
  }
  return r;
};
const confirm = async (q) => {
  if (flags.yes) return true;
  if (!process.stdin.isTTY) fail('not an interactive terminal — re-run with --yes to auto-confirm');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ans = await new Promise((res) => rl.question(`\n${c.b}${q}${c.x} [y/N] `, res));
  rl.close();
  return /^y(es)?$/i.test(ans.trim());
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 0. right repo? (the wrong-directory trap) ───────────────────────────────
step('Preflight');
let pkgName;
try { pkgName = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).name; } catch { pkgName = null; }
if (pkgName !== 'agent-fighter' || !existsSync(CHARACTERS)) {
  fail(`not in the agent-fighter repo (package "${pkgName}"). cd into the agent-fighter/ folder — the parent AGENT FIGHTER/ wrapper is a different (stray) repo.`);
}
const branch = git('rev-parse --abbrev-ref HEAD');
if (branch !== 'master') warn(`on branch "${branch}", not master — prod deploys from this tree regardless.`);
ok(`repo agent-fighter @ ${branch}`);

// ── 1. hash pin clean ───────────────────────────────────────────────────────
const rehash = spawnSync('node', ['tools/rehash-characters.mjs', '--check'], { cwd: ROOT, encoding: 'utf8' });
if (rehash.status !== 0) {
  process.stdout.write(rehash.stdout ?? '');
  fail('versionHash drift — run `node tools/rehash-characters.mjs` then re-save in Studio, or commit the rehash. Deploying now would break online play with "bundle hash mismatch".');
}
ok('versionHash canonical (rehash --check clean)');

// ── 2. read the working tree ────────────────────────────────────────────────
// raw porcelain — do NOT trim lines (the XY status is fixed-column: path starts at col 3)
const porcelain = execSync('git status --porcelain', { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
const tracked = (id) => spawnSync('git', ['ls-files', '--error-unmatch', `characters/${id}/character.json`],
  { cwd: ROOT, stdio: 'ignore' }).status === 0;
const hasAtlas = (id) => existsSync(join(CHARACTERS, id, 'sprites', 'atlas.json'));
const bundleOf = (id) => { try { return JSON.parse(readFileSync(join(CHARACTERS, id, 'character.json'), 'utf8')); } catch { return {}; } };
const isDisabled = (id) => !!bundleOf(id)?.meta?.disabled; // canonical flag (server + client both read meta.disabled)

const charDirs = existsSync(CHARACTERS)
  ? readdirSync(CHARACTERS, { withFileTypes: true }).filter((d) => d.isDirectory() && existsSync(join(CHARACTERS, d.name, 'character.json'))).map((d) => d.name)
  : [];

// characters touched in the working tree
const touchedChars = new Set();
for (const line of porcelain) {
  const p = line.slice(3);
  const m = p.match(/^characters\/([^/]+)\//);
  if (m) touchedChars.add(m[1]);
}
const newChars = [...touchedChars].filter((id) => !tracked(id));
const changedChars = [...touchedChars].filter((id) => tracked(id));

// completeness: an atlas.json means the sprite pipeline packed a full set
const incompleteEnabled = newChars.filter((id) => !hasAtlas(id) && !isDisabled(id));
const incompleteDisabled = newChars.filter((id) => !hasAtlas(id) && isDisabled(id));

// other modified TRACKED files outside characters/ and the demo bundle
const otherTracked = porcelain
  .filter((l) => !l.startsWith('??'))
  .map((l) => l.slice(3))
  .filter((p) => !p.startsWith('characters/') && !p.startsWith('packages/client/demo/'));

if (touchedChars.size === 0) fail('no character changes in the working tree — nothing to ship. (Author or edit a character in Studio first.)');

// ── 3. the plan ─────────────────────────────────────────────────────────────
step('Plan');
if (newChars.length) log(`  ${c.grn}new characters:${c.x} ${newChars.join(', ')}`);
if (changedChars.length) log(`  ${c.cyn}updated characters:${c.x} ${changedChars.join(', ')}`);
if (otherTracked.length) {
  log(`  ${c.ylw}other modified files:${c.x} ${otherTracked.length}`);
  otherTracked.slice(0, 12).forEach((p) => log(`      ${p}`));
  if (otherTracked.length > 12) log(`      … +${otherTracked.length - 12} more`);
  if (!flags.all) warn('these are outside characters/ + demo. They are ALSO staged so the tree is clean for deploy — pass nothing to keep them, or commit them separately first if unrelated.');
}

// WIP guard — untracked + incomplete characters ride the working-tree upload to prod
if (incompleteDisabled.length) {
  warn(`WIP (meta.disabled, unselectable) will still UPLOAD to prod infra: ${incompleteDisabled.join(', ')} — safe, but not committed unless --include-wip.`);
}
if (incompleteEnabled.length && !flags.includeWip) {
  fail(`incomplete AND enabled character(s) would ship SELECTABLE + broken: ${incompleteEnabled.join(', ')}\n` +
    `  (no packed atlas.json — the sprite pipeline hasn't finished.)\n` +
    `  Fix one of: finish it in Studio (pack the atlas), set meta.disabled=true, or pass --include-wip to override.`);
}

// what gets committed
// commit only COMPLETE new characters (packed atlas); skip WIP unless opted in.
// (enabled+incomplete already hard-aborted above; this handles disabled+incomplete.)
const commitNew = flags.includeWip ? newChars : newChars.filter((id) => hasAtlas(id));
if (!message) {
  const parts = [];
  if (commitNew.length) parts.push(`add ${commitNew.join(', ')}`);
  if (changedChars.length) parts.push(`update ${changedChars.join(', ')}`);
  message = `feat(roster): ${parts.join('; ') || 'ship character changes'}`;
}
log(`\n  ${c.b}commit:${c.x} ${message}`);
log(`  ${c.b}deploy:${c.x} ${flags.noDeploy ? 'NO (--no-deploy) — commit + push only' : 'Railway (server) + Vercel (client), paired'}`);
log(`  ${c.b}verify:${c.x} ${flags.skipVerify ? 'SKIPPED (--skip-verify)' : 'npm run verify (typecheck + tests)'}`);

if (flags.dryRun) { log(`\n${c.dim}dry run — nothing changed.${c.x}`); process.exit(0); }
if (!(await confirm('Proceed?'))) fail('aborted.');

// ── 4. verify gate ──────────────────────────────────────────────────────────
if (!flags.skipVerify) { step('Verify (typecheck + tests)'); exec('verify', 'npm', ['run', 'verify']); ok('verify green'); }

// ── 5. rebuild ship artifacts ───────────────────────────────────────────────
step('Build client + demo bundle + roster manifest');
exec('build', 'npm', ['run', 'build']);
exec('demo', 'npm', ['run', 'demo']);
exec('vercel-build', 'node', ['tools/vercel-build.mjs']);
// paranoia: hashes must still be canonical after the rebuild
if (spawnSync('node', ['tools/rehash-characters.mjs', '--check'], { cwd: ROOT }).status !== 0) fail('versionHash drift after rebuild — aborting.');
const expectedRoster = JSON.parse(readFileSync(join(ROOT, 'public', 'api', 'characters'), 'utf8'));
ok(`roster manifest: ${expectedRoster.length} characters`);

// ── 6. commit ───────────────────────────────────────────────────────────────
step('Commit');
exec('git add', 'git', ['add', 'characters/', 'packages/client/demo/']);
if (flags.all || otherTracked.length) {
  // stage the already-modified tracked files so the tree is clean for deploy
  exec('git add (tracked)', 'git', ['add', '-u']);
}
// unstage untracked WIP we chose not to ship
for (const id of newChars) {
  if (!commitNew.includes(id)) exec(`unstage wip ${id}`, 'git', ['reset', '-q', '--', `characters/${id}`]);
}
if (!gitLines('diff --cached --name-only').length) fail('nothing staged to commit.');
// message via stdin (-F -), NOT -m: avoids all shell-quoting/newline breakage on Windows.
const body = `${message}\n\nShipped via \`npm run ship\`. rehash --check clean, verify ${flags.skipVerify ? 'SKIPPED' : 'green'}.\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n`;
const commit = spawnSync('git', ['commit', '-q', '-F', '-'], { cwd: ROOT, input: body, encoding: 'utf8' });
if (commit.status !== 0) fail(`git commit failed: ${commit.stderr ?? ''}`);
ok(`committed: ${git('log -1 --oneline')}`);

// ── 7. push ─────────────────────────────────────────────────────────────────
step('Push to GitHub');
exec('git push', 'git', ['push', 'origin', branch]);
ok('pushed');

if (flags.noDeploy) { log(`\n${c.grn}${c.b}✓ committed + pushed. Deploy skipped (--no-deploy).${c.x}`); process.exit(0); }

// ── 8. paired deploy (reuses tools/deploy.mjs: clean-tree gate + Railway log tolerance) ──
step('Deploy — Railway (server) + Vercel (client)');
exec('deploy', 'node', ['tools/deploy.mjs', 'both'], { tolerate: /Build Logs:|Production:/ });

// ── 9. post-deploy verification (engine skew + roster on both tiers) ─────────
step('Verify prod (roster on both tiers + engine skew)');
const data = readFileSync(join(ROOT, 'packages', 'core', 'src', 'data.ts'), 'utf8');
const expectedEngine = data.match(/ENGINE_VERSION\s*=\s*'([^']+)'/)?.[1] ?? null;
const want = new Set(expectedRoster);
const superset = (arr) => arr && want.size <= new Set(arr).size && [...want].every((x) => arr.includes(x));

const fetchJson = async (url) => { try { const r = await fetch(url, { cache: 'no-store' }); return await r.json(); } catch { return null; } };

// Vercel alias updates fast; Railway builds async (~2–4 min). Poll both.
let serverOk = false, clientOk = false, health = null, clientRoster = null;
for (let i = 1; i <= 16 && !(serverOk && clientOk); i++) {
  if (!serverOk) {
    health = await fetchJson(HEALTH);
    serverOk = health && superset(health.characters) && (!expectedEngine || health.engine === expectedEngine);
  }
  if (!clientOk) {
    clientRoster = await fetchJson(`${VERCEL_ALIAS}/api/characters`);
    clientOk = superset(clientRoster);
  }
  log(`  ${c.dim}poll ${i}: server=${serverOk ? 'ok' : `${health?.characters?.length ?? '?'} chars / ${health?.engine ?? '?'}`}  client=${clientOk ? 'ok' : `${clientRoster?.length ?? '?'} chars`}${c.x}`);
  if (serverOk && clientOk) break;
  if (i < 16) await sleep(20_000);
}

log('');
if (clientOk) ok(`Vercel client: ${VERCEL_ALIAS} serves all ${want.size} characters`); else warn(`Vercel client did not show the full roster yet — check ${VERCEL_ALIAS}/api/characters`);
if (serverOk) ok(`Railway server: full roster, engine ${health.engine}`); else warn(`Railway server not updated yet (async build) — expected engine ${expectedEngine}; poll ${HEALTH}`);
if (health && expectedEngine && health.engine !== expectedEngine) warn(`ENGINE SKEW: server ${health.engine} ≠ client ${expectedEngine} — online play will hello-reject until both match. Redeploy the lagging tier.`);

if (serverOk && clientOk) {
  log(`\n${c.grn}${c.b}✓ shipped. New characters live at ${VERCEL_ALIAS}${c.x}`);
} else {
  log(`\n${c.ylw}${c.b}deploy uploaded; prod not fully confirmed yet. Railway builds async — re-poll ${HEALTH} in a couple minutes.${c.x}`);
  process.exit(2);
}
