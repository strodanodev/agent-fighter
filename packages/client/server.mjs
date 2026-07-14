/**
 * Game server (dev): serves the built client + the character bundles.
 * Zero deps. This is a static file server only — the authoritative match
 * server (spec §7.2) is a separate package, later.
 */
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..', '..');
const CHARACTERS = join(ROOT, 'characters');
const STAGES = join(ROOT, 'stages');
const ASSETS = join(here, 'assets');
const PORT = Number(process.env.PORT || 8475);

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json',
  '.png': 'image/png', '.webp': 'image/webp', '.css': 'text/css', '.svg': 'image/svg+xml',
};

const send = (res, code, type, body) => {
  // Dev server: never cache — SVG/PNG assets change constantly during authoring.
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
};

createServer((req, res) => {
  const path = new URL(req.url, `http://localhost:${PORT}`).pathname;

  // Dev-only: the page POSTs a canvas dataURL here so automated visual checks
  // can inspect real rendered frames (hidden tabs throttle rAF to zero, so a
  // normal screenshot of a background pane captures nothing).
  if (req.method === 'POST' && path === '/api/shot') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const b64 = Buffer.concat(chunks).toString('utf8').replace(/^data:image\/png;base64,/, '');
      const dir = join(here, 'shots');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'frame.png'), Buffer.from(b64, 'base64'));
      send(res, 200, 'application/json', JSON.stringify({ ok: true }));
    });
    return;
  }

  if (path === '/api/characters') {
    const list = existsSync(CHARACTERS)
      ? readdirSync(CHARACTERS, { withFileTypes: true })
        .filter((d) => d.isDirectory() && existsSync(join(CHARACTERS, d.name, 'character.json')))
        .map((d) => d.name)
      : [];
    return send(res, 200, 'application/json', JSON.stringify(list));
  }
  if (path === '/api/stages') {
    const list = existsSync(STAGES)
      ? readdirSync(STAGES, { withFileTypes: true })
        .filter((d) => d.isDirectory() && existsSync(join(STAGES, d.name, 'stage.json')))
        .map((d) => d.name)
      : [];
    return send(res, 200, 'application/json', JSON.stringify(list));
  }

  const under = (base, prefix) => {
    const rel = normalize(path.slice(prefix.length)).replace(/^([.][.][/\\])+/, '');
    const candidate = join(base, rel);
    return candidate.startsWith(base) ? candidate : null;
  };

  let file = null;
  if (path === '/' || path === '/index.html') {
    file = join(here, 'demo', 'agent-fighter.html');
  } else if (path.startsWith('/characters/')) {
    file = under(CHARACTERS, '/characters/');
  } else if (path.startsWith('/stages/')) {
    file = under(STAGES, '/stages/');
  } else if (path.startsWith('/assets/')) {
    file = under(ASSETS, '/assets/');
  }

  if (file && existsSync(file)) {
    const ext = file.slice(file.lastIndexOf('.'));
    return send(res, 200, MIME[ext] ?? 'application/octet-stream', readFileSync(file));
  }
  send(res, 404, 'application/json', JSON.stringify({ error: 'not found' }));
}).listen(PORT, () => {
  console.log(`Agent Fighter → http://localhost:${PORT}`);
});
