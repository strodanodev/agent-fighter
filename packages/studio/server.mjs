/**
 * Agent Fighter Studio server. Zero-dep Node.
 *
 *  - Serves the built Studio SPA (studio.html) + character bundles.
 *  - /api/generate proxies the image model (NVIDIA build API) so the API key
 *    stays server-side in .env — never shipped to the browser, never committed.
 *  - /api/characters CRUD: bundles live in characters/<id>/character.json with
 *    sprites alongside. Every save recomputes the bundle content hash
 *    (spec §3: the hash is part of match setup once money is on the line).
 */
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..', '..');
const CHARACTERS = join(ROOT, 'characters');
const PORT = Number(process.env.PORT || 8474);

// ---- .env (zero-dep parse) -------------------------------------------------
const env = {};
const envPath = join(ROOT, '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
}
const NVAPI_KEY = env.NVAPI_KEY || process.env.NVAPI_KEY || '';
const NV_MODEL = env.NV_MODEL || process.env.NV_MODEL || 'black-forest-labs/flux.2-klein-4b';
const NV_URL = `https://ai.api.nvidia.com/v1/genai/${NV_MODEL}`;

// ---- helpers ---------------------------------------------------------------
const json = (res, code, body) => {
  const data = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) });
  res.end(data);
};

const readBody = (req) => new Promise((resolve, reject) => {
  const chunks = [];
  let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size > 64 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', () => resolve(Buffer.concat(chunks)));
  req.on('error', reject);
});

const safeId = (id) => /^[a-z0-9][a-z0-9-]{0,40}$/.test(id);
const safeSprite = (name) => /^[a-zA-Z0-9._-]{1,80}\.(png|json)$/.test(name);

/** Canonical content hash: bundle JSON minus the hash field itself. */
const bundleHash = (bundle) => {
  const { versionHash, ...rest } = bundle;
  return createHash('sha256').update(JSON.stringify(rest)).digest('hex').slice(0, 16);
};

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json',
  '.png': 'image/png', '.css': 'text/css',
};

// ---- server ----------------------------------------------------------------
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const path = url.pathname;

    // ------------------------------------------------ generation proxy
    if (req.method === 'POST' && path === '/api/generate') {
      if (!NVAPI_KEY) return json(res, 500, { error: 'NVAPI_KEY missing from .env' });
      const body = await readBody(req);
      const upstream = await fetch(NV_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${NVAPI_KEY}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body,
      });
      const text = await upstream.text();
      res.writeHead(upstream.status, { 'Content-Type': 'application/json' });
      return res.end(text);
    }

    // ------------------------------------------------ character bundles
    if (path === '/api/characters' && req.method === 'GET') {
      const list = existsSync(CHARACTERS)
        ? readdirSync(CHARACTERS, { withFileTypes: true })
          .filter((d) => d.isDirectory() && existsSync(join(CHARACTERS, d.name, 'character.json')))
          .map((d) => d.name)
        : [];
      return json(res, 200, list);
    }

    const charMatch = path.match(/^\/api\/characters\/([^/]+)$/);
    if (charMatch) {
      const id = charMatch[1];
      if (!safeId(id)) return json(res, 400, { error: 'bad character id' });
      const file = join(CHARACTERS, id, 'character.json');
      if (req.method === 'GET') {
        if (!existsSync(file)) return json(res, 404, { error: 'not found' });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(readFileSync(file));
      }
      if (req.method === 'PUT') {
        const bundle = JSON.parse((await readBody(req)).toString('utf8'));
        if (typeof bundle?.name !== 'string' || !Array.isArray(bundle?.moves)) {
          return json(res, 400, { error: 'not a character bundle' });
        }
        bundle.versionHash = bundleHash(bundle);
        mkdirSync(join(CHARACTERS, id), { recursive: true });
        writeFileSync(file, JSON.stringify(bundle, null, 2) + '\n');
        return json(res, 200, { ok: true, versionHash: bundle.versionHash });
      }
    }

    // sprites: GET /characters/<id>/sprites/<name>.png · PUT /api/.../sprites/<name>
    const spriteApi = path.match(/^\/api\/characters\/([^/]+)\/sprites\/([^/]+)$/);
    if (spriteApi && req.method === 'PUT') {
      const [, id, name] = spriteApi;
      if (!safeId(id) || !safeSprite(name)) return json(res, 400, { error: 'bad sprite path' });
      const dir = join(CHARACTERS, id, 'sprites');
      mkdirSync(dir, { recursive: true });
      const raw = await readBody(req);
      if (name.endsWith('.json')) {
        writeFileSync(join(dir, name), raw); // atlas.json etc — stored verbatim
      } else {
        // Body is a base64 data URL or raw base64.
        const b64 = raw.toString('utf8').replace(/^data:image\/png;base64,/, '');
        writeFileSync(join(dir, name), Buffer.from(b64, 'base64'));
      }
      return json(res, 200, { ok: true });
    }

    // ------------------------------------------------ static
    let filePath = null;
    if (path === '/' || path === '/index.html') {
      filePath = join(here, 'dist', 'studio.html');
    } else if (path.startsWith('/characters/')) {
      const rel = normalize(path.slice('/characters/'.length)).replace(/^([.][.][/\\])+/, '');
      filePath = join(CHARACTERS, rel);
      if (!filePath.startsWith(CHARACTERS)) filePath = null;
    }
    if (filePath && existsSync(filePath)) {
      const ext = filePath.slice(filePath.lastIndexOf('.'));
      res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream' });
      return res.end(readFileSync(filePath));
    }

    json(res, 404, { error: 'not found' });
  } catch (err) {
    json(res, 500, { error: String(err?.message ?? err) });
  }
});

server.listen(PORT, () => {
  console.log(`Agent Fighter Studio → http://localhost:${PORT}`);
  console.log(`model: ${NV_MODEL} · key: ${NVAPI_KEY ? 'loaded from .env' : 'MISSING'}`);
});
