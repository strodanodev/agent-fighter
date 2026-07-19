/**
 * Deploy gate — `npm run deploy:server` / `npm run deploy:client` / `npm run deploy`.
 *
 * Why this exists (learned live, 2026-07-20): `railway up` uploads the
 * WORKING TREE, not git HEAD — a deploy from one session ships another
 * session's half-finished uncommitted code. And every deploy restarts prod
 * under live players, so two sessions deploying independently doubled the
 * stranded-match rate. Rules enforced here:
 *
 *   1. Clean tree only (untracked files are fine; modified/staged are not).
 *   2. Client (Vercel) deploys run from the REPO ROOT — the real project
 *      (`agent-fighter`) is linked there. `packages/client/.vercel` is a
 *      stray project whose builds always fail on the workspace dep.
 *   3. `deploy` (no target) does the PAIRED deploy: server then client —
 *      required whenever ENGINE_VERSION bumps (skew hello-rejects everyone).
 */
import { execSync, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const target = process.argv[2] ?? 'both';

const dirty = execSync('git status --porcelain', { cwd: root, encoding: 'utf8' })
  .split('\n')
  .filter((l) => l.trim() && !l.startsWith('??'));
if (dirty.length > 0) {
  console.error('✗ refusing to deploy: the tree has uncommitted changes —');
  console.error(dirty.map((l) => `    ${l}`).join('\n'));
  console.error('  `railway up` ships the working tree (not HEAD), so this would');
  console.error('  deploy half-finished work. Commit (or stash) first.');
  process.exit(1);
}

const head = execSync('git log -1 --format="%h %s"', { cwd: root, encoding: 'utf8' }).trim();
const run = (label, cmd, args) => {
  console.log(`→ ${label}: ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', shell: true });
  if (r.status !== 0) {
    console.error(`✗ ${label} deploy failed (exit ${r.status})`);
    process.exit(r.status ?? 1);
  }
};

console.log(`deploying ${target} from ${head}`);
if (target === 'server' || target === 'both') {
  run('server (Railway)', 'railway', ['up', '-s', 'match-server', '--ci']);
}
if (target === 'client' || target === 'both') {
  run('client (Vercel)', 'vercel', ['deploy', '--prod', '--yes']);
}
console.log('✓ deployed. Skew check: GET https://match-server-production.up.railway.app/ engine vs the client bundle.');
