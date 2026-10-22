/**
 * Deploy gate — `npm run deploy` (client + relay, paired) / `npm run deploy:client` / `npm run deploy:relay`.
 * Add `-- --dry-run` to run every gate and print what would happen, changing nothing.
 *
 * How Agent Fighter ships since the move onto litnode (Oct 2026 — no Railway any more):
 *
 *   · CLIENT. The Vercel project `contactstrodano-8632s-projects/agent-fighter` is connected to GitHub: every
 *     push to master is a production deploy (www.agentfighter.wtf, agent-fighter.vercel.app). Deploying the
 *     client IS pushing master; this waits for Vercel's GitHub deployment of HEAD and reads the live bundle's
 *     ENGINE_VERSION back. Never `vercel deploy` from here: this repo's `.vercel` link points at a different,
 *     empty project, and the CLI login on the publisher's desktop cannot see the real one.
 *   · RELAY. The match server runs on the publisher's litnode node, from that node's AF_ROOT checkout, as the
 *     Windows scheduled task `litnode-relay` (LITNODE-DESKTOP/run-af-relay.cmd: a loop that frees the port and
 *     runs `npm run server`). Deploying it is restarting that task. The task runs elevated, so its process
 *     cannot be stopped from an ordinary shell — `schtasks /End` + `/Run` can, and the loop clears any orphan on
 *     the port when it starts. Other operators' relays (the m16 standby) restart on their own machines.
 *   · PLACED MATCHES run on gauntlet servers the nodes spawn per match (ADR 0013/0014) from litnode's server
 *     bundle — a litnode release step, not this script.
 *
 * Rules enforced:
 *   1. Clean tree (untracked files are fine). The relay runs whatever is ON DISK in AF_ROOT, and its restart
 *      loop reloads it on any crash: uncommitted edits in that checkout reach players without ever reaching git
 *      or Vercel. (On 22 Oct 2026 it picked up a session's half-finished engine bump that way.)
 *   2. On master and not behind origin/master: the push must fast-forward what is live.
 *   3. `deploy` (no target) is the PAIRED deploy: push → Vercel production of HEAD → relay restart → skew check.
 *      Required whenever ENGINE_VERSION bumps — a skewed pair hello-rejects every player.
 *
 * Environment:
 *   AF_CLIENT_URL   live client to read the engine from (default https://www.agentfighter.wtf/)
 *   AF_RELAY_TASK   scheduled task name (default litnode-relay)
 *   AF_RELAY_PORT   relay port on this machine (default 8477, or RELAY_PORT from node.env)
 *   LITNODE_DIR     the litnode node folder (holds node.env). When its AF_ROOT is ANOTHER checkout — the
 *                   recommended setup, so dev edits never reach the relay — that checkout is fast-forwarded to
 *                   origin/master before the restart. Unset: the relay is assumed to run this checkout.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const named = args.find((a) => !a.startsWith('--'));
const target = { server: 'relay' }[named] ?? named ?? 'both';
if (!['client', 'relay', 'both'].includes(target)) {
  console.error('usage: node tools/deploy.mjs [client|relay|both] [--dry-run]');
  process.exit(2);
}
const CLIENT_URL = process.env.AF_CLIENT_URL ?? 'https://www.agentfighter.wtf/';
const TASK = process.env.AF_RELAY_TASK ?? 'litnode-relay';

const fail = (msg) => { console.error(`✗ ${msg}`); process.exit(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Run a command (no shell): { ok, out }. */
const run = (cmd, args, cwd = root) => {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', windowsHide: true });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
};
const git = (args, cwd = root) => run('git', args, cwd);
const engineOf = (text) => text.match(/ENGINE_VERSION\s*=\s*['"]([^'"]+)['"]/)?.[1] ?? null;
const ENGINE = engineOf(readFileSync(join(root, 'packages', 'core', 'src', 'data.ts'), 'utf8'));

// ── gates ─────────────────────────────────────────────────────────────────────
const dirty = git(['status', '--porcelain']).out.split('\n').filter((l) => l.trim() && !l.startsWith('??'));
if (dirty.length) {
  fail(`refusing to deploy: the tree has uncommitted changes —\n${dirty.map((l) => `    ${l}`).join('\n')}\n` +
    '  The relay runs what is on disk and the client what is pushed; commit first so both run the same thing.');
}
const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).out;
if (branch !== 'master') fail(`refusing to deploy from "${branch}": production deploys from master`);
if (!git(['fetch', '--quiet', 'origin', 'master']).ok) fail('git fetch origin master failed');
const behind = Number(git(['rev-list', '--count', 'HEAD..origin/master']).out);
if (behind > 0) fail(`master is ${behind} commit(s) behind origin/master — pull first`);
const head = git(['rev-parse', 'HEAD']).out;
console.log(`${DRY ? 'DRY RUN — ' : ''}deploying ${target} from ${git(['log', '-1', '--format=%h %s']).out} · engine ${ENGINE}`);

// ── client: push master, wait for Vercel's production deployment of HEAD ──────
const repoSlug = (() => {
  const m = git(['remote', 'get-url', 'origin']).out.match(/github\.com[:/]([^/]+\/[^/.]+)/);
  return m ? m[1] : null;
})();
const ghJson = (path) => {
  const r = run('gh', ['api', path]);
  if (!r.ok) return null;
  try { return JSON.parse(r.out); } catch { return null; }
};
const liveEngine = async () => {
  try {
    const r = await fetch(`${CLIENT_URL}${CLIENT_URL.includes('?') ? '&' : '?'}deploy-check=${Date.now()}`, { cache: 'no-store' });
    return r.ok ? engineOf(await r.text()) : null;
  } catch { return null; }
};

const deployClient = async () => {
  const ahead = Number(git(['rev-list', '--count', 'origin/master..HEAD']).out);
  if (DRY) {
    const live = git(['rev-parse', 'origin/master']).out;
    const deps = repoSlug ? ghJson(`repos/${repoSlug}/deployments?sha=${live}&per_page=5`) ?? [] : [];
    const st = deps[0] ? (ghJson(`repos/${repoSlug}/deployments/${deps[0].id}/statuses?per_page=1`) ?? [])[0]?.state : null;
    console.log(`→ client: would push ${ahead} commit(s) to origin/master; Vercel on origin/master ${live.slice(0, 7)}: ${st ?? 'no deployment found'}; ${CLIENT_URL} serves ${await liveEngine() ?? '?'}`);
    return null;
  }
  if (ahead > 0) {
    console.log(`→ client: git push origin master (${ahead} commit(s)) — Vercel deploys production from the push`);
    const p = git(['push', 'origin', 'master']);
    console.log(p.out);
    if (!p.ok) fail('git push failed (does this GitHub account have write access to the repo?)');
  } else {
    console.log('→ client: origin/master is already HEAD — checking that Vercel deployed it');
  }
  if (!repoSlug || !run('gh', ['--version']).ok) {
    console.log('  (no GitHub CLI: cannot read the deployment status — falling back to the live bundle)');
  } else {
    let state = null, url = null;
    for (let i = 0; i < 60; i++) {
      const deps = ghJson(`repos/${repoSlug}/deployments?sha=${head}&per_page=5`) ?? [];
      const prod = deps.find((d) => /production/i.test(d.environment ?? '')) ?? deps[0];
      if (prod) {
        const st = (ghJson(`repos/${repoSlug}/deployments/${prod.id}/statuses?per_page=1`) ?? [])[0];
        state = st?.state ?? 'pending';
        url = st?.environment_url ?? st?.target_url ?? null;
        if (['success', 'failure', 'error', 'inactive'].includes(state)) break;
      }
      if (i === 0) console.log('  waiting for Vercel (production builds take a minute or two)…');
      await sleep(10_000);
    }
    if (state !== 'success') fail(`Vercel production deployment of ${head.slice(0, 7)} ended "${state ?? 'never started'}"${url ? ` — ${url}` : ''}`);
    console.log(`  ✓ Vercel deployed ${head.slice(0, 7)}${url ? ` (${url})` : ''}`);
  }
  let live = null;
  for (let i = 0; i < 12 && live !== ENGINE; i++) { live = await liveEngine(); if (live !== ENGINE) await sleep(5_000); }
  if (live !== ENGINE) fail(`${CLIENT_URL} serves engine ${live ?? '?'}, expected ${ENGINE}`);
  console.log(`  ✓ ${CLIENT_URL} serves ${live}`);
  return live;
};

// ── relay: restart the litnode-relay scheduled task ───────────────────────────
const nodeEnv = (() => {
  const dir = process.env.LITNODE_DIR;
  if (!dir) return {};
  const f = join(dir, 'node.env');
  if (!existsSync(f)) fail(`LITNODE_DIR=${dir} has no node.env`);
  const out = {};
  // Only the two settings this script needs; node.env also holds keys, which are never read here.
  for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^(AF_ROOT|RELAY_PORT)=(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
})();
const RELAY_PORT = Number(process.env.AF_RELAY_PORT ?? nodeEnv.RELAY_PORT ?? 8477);
const listenerPid = () => {
  const r = run('powershell', ['-NoProfile', '-Command',
    `(Get-NetTCPConnection -LocalPort ${RELAY_PORT} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess`]);
  return r.out.trim() || null;
};
const relayHealth = async () => {
  try {
    const r = await fetch(`http://127.0.0.1:${RELAY_PORT}/health`, { cache: 'no-store', signal: AbortSignal.timeout(4000) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
};

const deployRelay = async () => {
  if (process.platform !== 'win32') fail(`the relay is the Windows scheduled task "${TASK}" on the publisher's litnode node; run this there`);
  // A dedicated relay checkout moves only here: fast-forward it to what was just pushed.
  const afRoot = nodeEnv.AF_ROOT ? resolve(nodeEnv.AF_ROOT) : null;
  const separate = !!afRoot && afRoot.toLowerCase() !== resolve(root).toLowerCase();
  const q = run('schtasks', ['/Query', '/TN', TASK]);
  if (!q.ok) fail(`no scheduled task "${TASK}" on this machine — install it with the litnode node's install-task.cmd`);
  if (DRY) {
    const h = await relayHealth();
    const where = separate ? `${afRoot} (would fast-forward ${git(['rev-parse', '--short', 'HEAD'], afRoot).out} → origin/master)` : afRoot ? 'this checkout (node.env AF_ROOT)' : 'this checkout (assumed; set LITNODE_DIR to check)';
    console.log(`→ relay: would restart "${TASK}" (${/Running/.test(q.out) ? 'running' : 'not running'}) from ${where}; port ${RELAY_PORT} pid ${listenerPid() ?? 'none'}; engine ${h?.engine ?? '?'}, ${h?.online ?? '?'} online, ${h?.queued ?? '?'} queued`);
    return null;
  }
  if (separate) {
    console.log(`→ relay checkout ${afRoot}: fast-forward to origin/master`);
    const d = git(['status', '--porcelain'], afRoot).out.split('\n').filter((l) => l.trim() && !l.startsWith('??'));
    if (d.length) fail(`${afRoot} has uncommitted changes — the relay would run them; clean it first`);
    const before = git(['rev-parse', 'HEAD'], afRoot).out;
    if (!git(['fetch', '--quiet', 'origin', 'master'], afRoot).ok) fail(`git fetch failed in ${afRoot}`);
    const ff = git(['merge', '--ff-only', 'origin/master'], afRoot);
    if (!ff.ok) fail(`${afRoot} cannot fast-forward to origin/master:\n${ff.out}`);
    if (git(['diff', '--quiet', before, 'HEAD', '--', 'package-lock.json'], afRoot).ok === false) {
      console.log(`  ! package-lock.json changed: run \`npm ci\` in ${afRoot} before players arrive`);
    }
    console.log(`  ✓ ${afRoot} at ${git(['log', '-1', '--format=%h %s'], afRoot).out}`);
  } else if (!afRoot) {
    console.log(`→ relay: assuming the "${TASK}" task runs this checkout (set LITNODE_DIR to check node.env's AF_ROOT)`);
  }
  const before = listenerPid();
  const h0 = await relayHealth();
  if (h0 && (h0.online || h0.queued)) console.log(`  ! ${h0.online} online / ${h0.queued} queued — they are dropped by the restart (live matches settle by the disconnect ladder)`);
  console.log(`→ relay: restarting the "${TASK}" task (port ${RELAY_PORT}${before ? `, pid ${before}` : ''})`);
  run('schtasks', ['/End', '/TN', TASK]); // fine if it was not running
  const go = run('schtasks', ['/Run', '/TN', TASK]);
  if (!go.ok) fail(`schtasks /Run failed: ${go.out}`);
  let health = null, pid = null;
  for (let i = 0; i < 60; i++) {
    await sleep(2000);
    pid = listenerPid();
    if (pid && pid !== before) { health = await relayHealth(); if (health) break; }
  }
  if (!health) fail(`the relay did not come back on :${RELAY_PORT} within 2 min — check the task and litnode-relay.log`);
  if (health.engine !== ENGINE) fail(`the relay came back on engine ${health.engine}, expected ${ENGINE} — is AF_ROOT this checkout?`);
  console.log(`  ✓ relay pid ${pid}: engine ${health.engine}, protocol ${health.protocol}, persistence ${health.persistence ? 'on' : 'OFF'}`);
  return health.engine;
};

// ── go ────────────────────────────────────────────────────────────────────────
const client = target === 'relay' ? null : await deployClient();
const relay = target === 'client' ? null : await deployRelay();
if (DRY) { console.log('dry run — nothing pushed, nothing restarted.'); process.exit(0); }
if (target === 'client') {
  const h = await relayHealth();
  if (h && h.engine !== client) console.log(`! ENGINE SKEW: client ${client}, local relay ${h.engine} — run \`npm run deploy:relay\` now`);
}
if (target === 'relay') {
  const live = await liveEngine();
  if (live && live !== relay) console.log(`! ENGINE SKEW: relay ${relay}, live client ${live} — run \`npm run deploy:client\` now`);
}
console.log(`✓ deployed ${target}. Other relay operators (the m16 standby) pull master and restart their own "${TASK}" task.`);
