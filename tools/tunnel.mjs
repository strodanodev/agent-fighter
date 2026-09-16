/**
 * Zero-cost match server: run it on this machine and expose it through a
 * Cloudflare Tunnel instead of Railway.
 *
 *   npm run tunnel                       # quick tunnel: random *.trycloudflare.com, no account
 *   AF_TUNNEL_NAME=af-match npm run tunnel   # named tunnel: stable hostname (needs `cloudflared tunnel login` once)
 *
 * What it does: loads .env, starts `npm run server` on PORT (8477), waits for
 * GET / to answer, then starts cloudflared pointed at it and prints the
 * wss:// origin. Cloudflare terminates TLS, so the server stays plain ws —
 * exactly the Railway arrangement, minus the bill.
 *
 * Play against it from ANY deployed client with the `?ws=` override:
 *   https://<your-client>/?ws=wss://<printed host>
 * For a named tunnel, put the stable host into PROD_MATCH_WS
 * (packages/client/src/main.ts) once and redeploy the client.
 *
 * Nothing here relaxes the server's own guards: without SUPABASE_URL and
 * SUPABASE_SERVICE_KEY it refuses to start unless AF_ALLOW_DEV_ECONOMY=1,
 * which is for laptops and never for a public host.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = { ...process.env };
const envFile = join(root, '.env');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trim().startsWith('#') && env[m[1]] === undefined) env[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
  }
}
const port = Number(env.PORT || 8477);
const origin = `http://127.0.0.1:${port}`;
const tunnelName = env.AF_TUNNEL_NAME;

if (!env.SUPABASE_URL && env.AF_ALLOW_DEV_ECONOMY !== '1') {
  console.error('tunnel: SUPABASE_URL / SUPABASE_SERVICE_KEY missing in .env (or set AF_ALLOW_DEV_ECONOMY=1 for a throwaway laptop economy).');
  process.exit(1);
}

const children = [];
const start = (cmd, args, tag, opts = {}) => {
  const child = spawn(cmd, args, { cwd: root, env, shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
  child.stdout.on('data', (d) => process.stdout.write(`[${tag}] ${d}`));
  child.stderr.on('data', (d) => { process.stderr.write(`[${tag}] ${d}`); opts.onStderr?.(String(d)); });
  child.on('exit', (code) => { console.log(`[${tag}] exited ${code}`); shutdown(code ?? 1); });
  children.push(child);
  return child;
};
let closing = false;
const shutdown = (code = 0) => {
  if (closing) return;
  closing = true;
  for (const c of children) { try { c.kill('SIGTERM'); } catch {} }
  setTimeout(() => process.exit(code), 1500).unref();
};
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

const waitForServer = async (ms = 60_000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { const r = await fetch(origin + '/'); if (r.ok) return await r.json().catch(() => ({})); } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`match server did not answer on ${origin} within ${ms / 1000}s`);
};

start('npm', ['run', 'server'], 'server');
const health = await waitForServer();
console.log(`\n[tunnel] match server up on ${origin} · engine ${health.engine ?? '?'} · persistence ${health.persistence ?? health.db ?? '?'}`);

const args = tunnelName
  ? ['tunnel', 'run', '--url', origin, tunnelName]
  : ['tunnel', '--url', origin];
let announced = false;
start('cloudflared', args, 'cloudflared', {
  onStderr(text) {
    const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(text);
    if (m && !announced) {
      announced = true;
      const wss = m[0].replace(/^https/, 'wss');
      console.log(`\n[tunnel] PUBLIC MATCH SERVER  ${wss}`);
      console.log(`[tunnel] play: <your client origin>/?ws=${wss}`);
      console.log(`[tunnel] quick tunnels change hostname every run; set AF_TUNNEL_NAME for a stable one.\n`);
    }
  },
});
if (tunnelName) console.log(`[tunnel] named tunnel "${tunnelName}" — its hostname is whatever you routed with \`cloudflared tunnel route dns ${tunnelName} <host>\`; use wss://<host>.`);
