#!/usr/bin/env node
/**
 * `npm run ship` — one command to take newly-authored ASSETS (characters AND
 * pets) from the working tree to LIVE prod, doing every check + step we
 * otherwise do by hand.
 *
 * Both asset kinds are read off DISK by BOTH tiers, which is why they ship
 * together and always as a pair:
 *   · the Railway match server reads characters/ to re-simulate ledgers and
 *     pets/ to build its adoption catalog;
 *   · the Vercel client serves both directories as static art + manifests.
 * Updating one tier only means the server rolls a pet the client cannot draw,
 * or verifies a bundle the client does not have.
 *
 * Encodes the lessons from two manual roster deploys and the ADR 0011 pets
 * rollout (see memory/agent-fighter-deployment.md):
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
 *   6. REFERENCED-BUT-MISSING PET ART (2026-08-03, caught one commit before it
 *      shipped). `pet.json.sprites` is a CONTRACT: an unreferenced file that
 *      ships is merely waste, but a REFERENCED file that does not ship is a
 *      404 for that pet's art in prod. Frames left untracked because they
 *      looked like rejects became a real animation a session later. So every
 *      referenced frame must exist on disk AND be tracked/staged, or we abort.
 *   7. "NOTHING TO SHIP" IS A QUESTION FOR PROD, NOT FOR GIT (2026-08-09). This
 *      script used to abort whenever the working tree held no asset edits — but
 *      a clean tree is the NORMAL state right after a hand-commit, and it says
 *      nothing about what prod is serving. Committing your assets and then
 *      running `ship` got you a refusal while prod stayed stale. So when the
 *      tree is clean we ask the live tiers instead: every character's pinned
 *      versionHash off Vercel, the character + pet ids off the Railway health
 *      endpoint. Drift ⇒ redeploy (no commit — there is nothing to commit).
 *      No drift ⇒ exit 0, because "prod is already correct" is success.
 *      Server unreachable ⇒ abort: drift is unknowable, so do not guess.
 *
 * Usage:
 *   npm run ship -- [-m "commit message"] [flags]
 *   node tools/ship-assets.mjs [-m "commit message"] [flags]
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
const PETS = join(ROOT, 'pets');
// Prod endpoints. Overridable so the drift check can be pointed at a staging
// tier — or at a deliberately-wrong host to exercise the drift path itself.
// NOTE: use the project ALIAS, never a deployment-specific *-<hash>.vercel.app
// URL — those sit behind Vercel's deployment-protection wall and answer every
// request with a 200 HTML login page, which reads as "asset missing".
const HEALTH = process.env.AF_HEALTH_URL ?? 'https://match-server-production.up.railway.app/';
const VERCEL_ALIAS = process.env.AF_CLIENT_URL ?? 'https://agent-fighter.vercel.app';

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
  .filter((p) => !p.startsWith('characters/') && !p.startsWith('pets/') && !p.startsWith('packages/client/demo/'));

// ── 2b. pets (ADR 0011) ─────────────────────────────────────────────────────
// A pet is pets/<id>/pet.json + the frames it references. Unlike a character
// there is no atlas to signal completeness: a pet with NO sprites is perfectly
// valid (the client draws a procedural companion from its tint). What is NOT
// valid is a pet.json that names a frame which will not ship.
const petTracked = (id) => spawnSync('git', ['ls-files', '--error-unmatch', `pets/${id}/pet.json`],
  { cwd: ROOT, stdio: 'ignore' }).status === 0;
const petDef = (id) => { try { return JSON.parse(readFileSync(join(PETS, id, 'pet.json'), 'utf8')); } catch { return null; } };
/** Will this path be in the deploy? Tracked already, or staged right now. */
const willShip = (rel) =>
  spawnSync('git', ['ls-files', '--error-unmatch', rel], { cwd: ROOT, stdio: 'ignore' }).status === 0;

const petDirs = existsSync(PETS)
  ? readdirSync(PETS, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(PETS, d.name, 'pet.json'))).map((d) => d.name)
  : [];

const touchedPets = new Set();
for (const line of porcelain) {
  const m = line.slice(3).match(/^pets\/([^/]+)\//);
  if (m) touchedPets.add(m[1]);
}
const newPets = [...touchedPets].filter((id) => !petTracked(id));
const changedPets = [...touchedPets].filter((id) => petTracked(id));

// Validate EVERY pet, not just the touched ones: a manifest broken in an
// earlier session is exactly the kind of thing that ships silently.
const petProblems = [];
const petsMissingArt = new Map(); // id → frames referenced but not shipping
for (const id of petDirs) {
  const def = petDef(id);
  if (!def) { petProblems.push(`${id}: pet.json is unreadable/invalid JSON`); continue; }
  const sprites = Array.isArray(def.sprites) ? def.sprites : [];
  const missing = sprites.filter((f) => !existsSync(join(PETS, id, f)));
  const unshipped = sprites.filter((f) => existsSync(join(PETS, id, f)) && !willShip(`pets/${id}/${f}`));
  if (missing.length) petProblems.push(`${id}: pet.json references ${missing.join(', ')} — not on disk`);
  if (unshipped.length) petsMissingArt.set(id, unshipped);
}
if (petProblems.length) {
  fail(`pet manifest problems:\n    ${petProblems.join('\n    ')}\n` +
    '  Fix the pet.json sprite list in Studio (Pets tab), or restore the files.');
}

// ── 2c. nothing dirty? then ask PROD, not git ───────────────────────────────
// The working tree is only a proxy for "there is something to ship". It is the
// WRONG proxy the moment the assets are already committed — which is the normal
// state after any hand-commit, and which used to abort the ship outright even
// though prod was serving stale art (2026-08-09).
//
// The real question this tool exists to answer is "does prod match disk?", so
// when the tree is clean we go and ASK prod. Both tiers, because either can lag:
//   · Vercel serves each character.json → compare the pinned versionHash;
//   · Railway lists its character + pet ids in /health → compare membership.
// Drift ⇒ redeploy-only run (nothing to commit, so no commit/push).
// No drift ⇒ genuinely nothing to do, and that is a SUCCESS, not a failure.
const fetchJsonOr = async (url) => {
  try {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
};
let redeployOnly = false;
const driftedChars = [];
const driftedPets = [];
if (touchedChars.size === 0 && touchedPets.size === 0) {
  step('No asset edits in the working tree — comparing prod against disk');
  const health = await fetchJsonOr(HEALTH);
  if (!health) {
    fail('no asset edits to ship AND the match server is unreachable, so drift cannot be judged.\n' +
      `  Check ${HEALTH} — if it is genuinely down, that is the thing to fix, not this deploy.`);
  }
  // characters: hash pin is the sim contract, so compare THAT, not just presence
  const liveChars = new Set(health.characters ?? []);
  for (const id of charDirs) {
    if (isDisabled(id)) continue;
    const mine = bundleOf(id)?.versionHash ?? null;
    const theirs = await fetchJsonOr(`${VERCEL_ALIAS}/characters/${id}/character.json`);
    if (!theirs) { driftedChars.push(`${id} (missing on Vercel)`); continue; }
    if (mine && theirs.versionHash !== mine) driftedChars.push(`${id} (hash ${String(theirs.versionHash).slice(0, 8)} → ${String(mine).slice(0, 8)})`);
    else if (!liveChars.has(id)) driftedChars.push(`${id} (missing on Railway)`);
  }
  // pets: no hash to pin, so compare catalog membership + that the art resolves
  const livePets = new Set(Array.isArray(health.pets) ? health.pets : []);
  for (const id of petDirs) {
    if (petDef(id)?.disabled) continue;
    if (!livePets.has(id)) { driftedPets.push(`${id} (missing from the server catalog)`); continue; }
    const first = petDef(id)?.sprites?.[0];
    if (!first) continue;
    const art = await fetch(`${VERCEL_ALIAS}/pets/${id}/${first}`, { cache: 'no-store' }).catch(() => null);
    if (!art?.ok) driftedPets.push(`${id} (art ${first} does not resolve on Vercel)`);
  }
  if (!driftedChars.length && !driftedPets.length) {
    ok(`prod already matches disk — ${charDirs.length} characters, ${petDirs.length} pets, engine ${health.engine}`);
    log(`\n${c.grn}${c.b}✓ nothing to ship.${c.x} ${c.dim}(Author or edit an asset in Studio, and re-run.)${c.x}`);
    process.exit(0);
  }
  redeployOnly = true;
  driftedChars.forEach((d) => warn(`character drift: ${d}`));
  driftedPets.forEach((d) => warn(`pet drift: ${d}`));
  ok('drift found — redeploying (nothing to commit; the tree is already clean)');
}

// ── 3. the plan ─────────────────────────────────────────────────────────────
step('Plan');
if (redeployOnly) {
  log(`  ${c.ylw}redeploy only:${c.x} assets are already committed; prod is behind.`);
  driftedChars.forEach((d) => log(`      character ${d}`));
  driftedPets.forEach((d) => log(`      pet ${d}`));
}
if (newChars.length) log(`  ${c.grn}new characters:${c.x} ${newChars.join(', ')}`);
if (changedChars.length) log(`  ${c.cyn}updated characters:${c.x} ${changedChars.join(', ')}`);
if (newPets.length) log(`  ${c.grn}new pets:${c.x} ${newPets.join(', ')}`);
if (changedPets.length) log(`  ${c.cyn}updated pets:${c.x} ${changedPets.join(', ')}`);
for (const id of petDirs) {
  const def = petDef(id);
  const n = Array.isArray(def?.sprites) ? def.sprites.length : 0;
  if (touchedPets.has(id)) {
    log(`      ${c.dim}${id}: ${n ? `${n} frame(s)` : 'procedural (no art)'}` +
      `${def?.motion === 'ground' ? ' · ground' : ' · float'}${c.x}`);
  }
}
// New art that git does not know about yet. NOT an error — `git add pets/`
// picks it up below — but worth showing, because this is the exact list that
// once got left behind and would have 404'd in prod.
if (petsMissingArt.size) {
  const total = [...petsMissingArt.values()].reduce((a, b) => a + b.length, 0);
  log(`  ${c.ylw}new pet art to commit:${c.x} ${total} frame(s) across ${petsMissingArt.size} pet(s)`);
}
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
if (!message && redeployOnly) {
  message = 'build: refresh ship artifacts for a prod-drift redeploy';
} else if (!message) {
  const parts = [];
  if (commitNew.length) parts.push(`add ${commitNew.join(', ')}`);
  if (changedChars.length) parts.push(`update ${changedChars.join(', ')}`);
  if (newPets.length) parts.push(`add pet ${newPets.join(', ')}`);
  if (changedPets.length) parts.push(`update pet ${changedPets.join(', ')}`);
  const scope = touchedChars.size && touchedPets.size ? 'assets'
    : touchedPets.size ? 'pets' : 'roster';
  message = `feat(${scope}): ${parts.join('; ') || 'ship asset changes'}`;
}
log(`\n  ${c.b}commit:${c.x} ${redeployOnly ? `${message} ${c.dim}(only if the rebuild changes anything)${c.x}` : message}`);
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
exec('git add', 'git', ['add', 'characters/', 'pets/', 'packages/client/demo/']);
// A redeploy-only run has nothing of its own to commit — but the rebuild above
// can still churn the demo bundle, and `deploy.mjs` (correctly) refuses a dirty
// tree because `railway up` uploads the WORKING TREE. So: commit if the rebuild
// moved anything, skip the commit entirely if it did not.
if (redeployOnly) {
  if (flags.all || otherTracked.length) exec('git add (tracked)', 'git', ['add', '-u']);
  if (gitLines('diff --cached --name-only').length) {
    const rb = `${message}\n\nNo asset edits — prod had drifted from committed assets and the\nrebuild refreshed these artifacts. Shipped via \`npm run ship\`.\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n`;
    const rc = spawnSync('git', ['commit', '-q', '-F', '-'], { cwd: ROOT, input: rb, encoding: 'utf8' });
    if (rc.status !== 0) fail(`git commit failed: ${rc.stderr ?? ''}`);
    ok(`committed rebuild artifacts: ${git('log -1 --oneline')}`);
    step('Push to GitHub');
    exec('git push', 'git', ['push', 'origin', branch]);
    ok('pushed');
  } else {
    ok('rebuild produced no changes — nothing to commit, going straight to deploy');
  }
}

// THE PET ART CONTRACT, asserted after staging and before the commit: every
// frame a shipping pet.json names must now be in the index. Staging pets/
// wholesale should guarantee it — but this is the failure that already reached
// a commit once, so it gets checked rather than assumed. It runs on a
// redeploy-only pass too: "already committed" is exactly when a frame that was
// never added stops being obvious.
{
  const staged = new Set(gitLines('diff --cached --name-only'));
  const orphans = [];
  for (const id of petDirs) {
    for (const f of petDef(id)?.sprites ?? []) {
      const rel = `pets/${id}/${f}`;
      if (!staged.has(rel) && !willShip(rel)) orphans.push(rel);
    }
  }
  if (orphans.length) {
    fail(`these pet frames are referenced by a pet.json but are neither committed nor staged:\n    ${orphans.join('\n    ')}\n` +
      '  They would 404 in prod. `git add` them, or remove them from the pet\'s sprite list.');
  }
  ok('pet art contract: every referenced frame is committed or staged');
}
if (!redeployOnly) {
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

  // ── 7. push ───────────────────────────────────────────────────────────────
  step('Push to GitHub');
  exec('git push', 'git', ['push', 'origin', branch]);
  ok('pushed');
}

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
// Pets must land on both tiers too: the client SERVES the art, the server
// CATALOGS it. Checking one proves nothing about the other.
const wantPets = new Set(petDirs.filter((id) => !petDef(id)?.disabled));
// What this run is responsible for proving live. On a redeploy-only pass the
// tree is clean, so `touchedPets` is empty and every check below would pass
// VACUOUSLY — the drifted pets are precisely the ones to re-check.
const verifyPets = new Set([...touchedPets, ...driftedPets.map((d) => d.split(' ')[0])]);
const petsLive = async () => {
  for (const id of verifyPets) {
    const def = petDef(id);
    if (!def) return false;
    const r = await fetch(`${VERCEL_ALIAS}/pets/${id}/pet.json`, { cache: 'no-store' }).catch(() => null);
    if (!r?.ok) return false;
    // …and the first referenced frame, which is what actually 404s.
    const first = def.sprites?.[0];
    if (first) {
      const f = await fetch(`${VERCEL_ALIAS}/pets/${id}/${first}`, { cache: 'no-store' }).catch(() => null);
      if (!f?.ok) return false;
    }
  }
  return true;
};

let serverOk = false, clientOk = false, health = null, clientRoster = null;
for (let i = 1; i <= 16 && !(serverOk && clientOk); i++) {
  if (!serverOk) {
    health = await fetchJson(HEALTH);
    // `pets` is absent on a server older than the ADR 0011 build — treat that
    // as "not updated yet" only when we are actually shipping pets.
    const serverPetsOk = verifyPets.size === 0
      || (Array.isArray(health?.pets) && [...wantPets].every((id) => health.pets.includes(id)));
    serverOk = health && superset(health.characters) && serverPetsOk
      && (!expectedEngine || health.engine === expectedEngine);
  }
  if (!clientOk) {
    clientRoster = await fetchJson(`${VERCEL_ALIAS}/api/characters`);
    clientOk = superset(clientRoster) && await petsLive();
  }
  log(`  ${c.dim}poll ${i}: server=${serverOk ? 'ok' : `${health?.characters?.length ?? '?'} chars / ${health?.pets?.length ?? '?'} pets / ${health?.engine ?? '?'}`}  client=${clientOk ? 'ok' : `${clientRoster?.length ?? '?'} chars`}${c.x}`);
  if (serverOk && clientOk) break;
  if (i < 16) await sleep(20_000);
}

log('');
const petNote = verifyPets.size ? ` + ${verifyPets.size} pet(s) with their art` : '';
if (clientOk) ok(`Vercel client: ${VERCEL_ALIAS} serves all ${want.size} characters${petNote}`); else warn(`Vercel client did not show everything yet — check ${VERCEL_ALIAS}/api/characters and /pets/<id>/pet.json`);
if (serverOk) ok(`Railway server: full roster${verifyPets.size ? `, ${health.pets?.length ?? 0} pets in the catalog` : ''}, engine ${health.engine}`); else warn(`Railway server not updated yet (async build) — expected engine ${expectedEngine}; poll ${HEALTH}`);
if (verifyPets.size && health && !Array.isArray(health.pets)) {
  warn('this server build predates the pets health field — it cannot confirm its catalog. Redeploy the server, or check its logs for "[pets] N in the catalog".');
}
if (health && expectedEngine && health.engine !== expectedEngine) warn(`ENGINE SKEW: server ${health.engine} ≠ client ${expectedEngine} — online play will hello-reject until both match. Redeploy the lagging tier.`);

if (serverOk && clientOk) {
  log(`\n${c.grn}${c.b}✓ shipped. New characters live at ${VERCEL_ALIAS}${c.x}`);
} else {
  log(`\n${c.ylw}${c.b}deploy uploaded; prod not fully confirmed yet. Railway builds async — re-poll ${HEALTH} in a couple minutes.${c.x}`);
  process.exit(2);
}
