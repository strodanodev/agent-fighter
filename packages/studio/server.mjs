/**
 * Agent Fighter Studio server. Zero-dep Node.
 *
 *  - Serves the built Studio SPA (studio.html) + character bundles.
 *  - /api/generate proxies the image model (NVIDIA build API) so the API key
 *    stays server-side in .env — never shipped to the browser, never committed.
 *  - /api/pets CRUD: pets/<id>/pet.json + frames (ADR 0011). The match server
 *    reads the same directory to build its adoption catalog.
 *  - /api/characters CRUD: bundles live in characters/<id>/character.json with
 *    sprites alongside. Every save recomputes the bundle content hash
 *    (spec §3: the hash is part of match setup once money is on the line).
 */
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleHash } from './bundle-hash.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..', '..');
const CHARACTERS = join(ROOT, 'characters');
const STAGES = join(ROOT, 'stages');
const PETS = join(ROOT, 'pets');
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

/**
 * IMAGE PROVIDER — text-to-image is available on any of these; only the
 * img2img ones can truly hold a character's identity across frames.
 *
 * NVIDIA's hosted flux (default) REFUSES user reference images: its `image`
 * field only accepts gallery `example_id`s — verified against flux.2-klein
 * AND flux.1-kontext-dev, with base64, data-URI, and uploaded NVCF asset ids
 * all rejected. So on `nvidia` we can only do text prompts, and character
 * consistency is best-effort (strips + palette lock + QC).
 *
 * To get REAL reference conditioning ("keep this character, change the pose"),
 * put one of these in .env and the Studio uses it automatically for every
 * frame once a reference is locked:
 *
 *   IMAGE_PROVIDER=gemini  GEMINI_API_KEY=...  (Google — nano-banana image models)
 *   IMAGE_PROVIDER=bfl     BFL_API_KEY=...     (api.bfl.ai — FLUX Kontext)
 *   IMAGE_PROVIDER=fal     FAL_KEY=...         (fal.run — FLUX Pro Kontext)
 *
 * NOTE on Gemini: image models have NO free-tier quota — a free-tier key
 * returns 429 (RESOURCE_EXHAUSTED, quotaId "...FreeTier") on every image
 * request even though text works. Enable billing on the key's Google Cloud
 * project (paid tier) and the same key starts generating.
 */
const PROVIDER = (env.IMAGE_PROVIDER || process.env.IMAGE_PROVIDER || 'nvidia').toLowerCase();
const BFL_API_KEY = env.BFL_API_KEY || process.env.BFL_API_KEY || '';
const FAL_KEY = env.FAL_KEY || process.env.FAL_KEY || '';
const GEMINI_API_KEY = env.GEMINI_API_KEY || process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = env.GEMINI_MODEL || process.env.GEMINI_MODEL || 'gemini-2.5-flash-image';
/** Does the active provider accept a user-supplied reference image? */
const SUPPORTS_IMG2IMG = (PROVIDER === 'bfl' && !!BFL_API_KEY)
  || (PROVIDER === 'fal' && !!FAL_KEY)
  || (PROVIDER === 'gemini' && !!GEMINI_API_KEY);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** BFL: submit → poll → fetch result. `image` = raw base64 (no data: prefix). */
const generateBfl = async ({ prompt, image, seed, width, height }) => {
  const model = image ? 'flux-kontext-pro' : 'flux-pro-1.1';
  const body = image
    ? { prompt, input_image: image, seed, output_format: 'png' }
    : { prompt, width, height, seed, output_format: 'png' };
  const submit = await fetch(`https://api.bfl.ai/v1/${model}`, {
    method: 'POST',
    headers: { 'x-key': BFL_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const job = await submit.json();
  if (!submit.ok) throw new Error(`BFL submit ${submit.status}: ${JSON.stringify(job).slice(0, 200)}`);
  const pollUrl = job.polling_url ?? `https://api.bfl.ai/v1/get_result?id=${job.id}`;
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    const res = await (await fetch(pollUrl, { headers: { 'x-key': BFL_API_KEY } })).json();
    if (res.status === 'Ready') {
      const url = res.result?.sample;
      const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
      return buf.toString('base64');
    }
    if (res.status && !['Pending', 'Queued', 'Processing', 'Request Moderated'].includes(res.status)) {
      throw new Error(`BFL job ${res.status}`);
    }
  }
  throw new Error('BFL timed out');
};

/**
 * NVIDIA build API (flux.2-klein-4b by default). Text-to-image only — every
 * flux model hosted here refuses user reference images (see the big comment
 * above), so this path can never carry a character's identity. It stays
 * available as an explicit per-request choice for one-off, no-identity art
 * (stage backgrounds, set dressing) where that limitation doesn't matter and
 * it's the cheaper/faster engine.
 */
const generateNvidia = async ({ prompt, seed, width = 1024, height = 1024 }) => {
  if (!NVAPI_KEY) throw new Error('NVAPI_KEY missing from .env');
  const r = await fetch(NV_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${NVAPI_KEY}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ prompt: prompt.slice(0, 800), width, height, steps: 4, seed }),
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`NVIDIA ${r.status}: ${t.slice(0, 200)}`);
  const b64 = JSON.parse(t).artifacts?.[0]?.base64;
  if (!b64) throw new Error('NVIDIA returned no image');
  return b64;
};

/**
 * Google Gemini image models (nano-banana family). Native multimodal edit:
 * the reference image is just another part in the request, so "keep this
 * character, change the pose" works directly — no asset upload dance.
 * `image` = raw base64 PNG. Returns base64 PNG.
 */
const generateGemini = async ({ prompt, image, images, seed }) => {
  const parts = [{ text: prompt }];
  // Multi-reference: the stylize step can corroborate ONE character across
  // several photos (front / side / detail). `images` (array) is that path;
  // single `image` is the untouched frame-generation path.
  const refs = Array.isArray(images) && images.length ? images : (image ? [image] : []);
  for (const ref of refs) parts.push({ inline_data: { mime_type: 'image/png', data: ref } });
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: {
          responseModalities: ['IMAGE'],
          ...(seed === undefined ? {} : { seed: Math.trunc(seed) }),
        },
      }),
    });
  const t = await r.text();
  if (!r.ok) {
    let detail = t.slice(0, 200);
    try {
      const e = JSON.parse(t).error ?? {};
      detail = `${e.status ?? r.status}: ${e.message ?? ''}`.slice(0, 300);
      if (e.status === 'RESOURCE_EXHAUSTED') {
        detail += ' — Gemini image models have no free-tier quota; enable billing on this key\'s Google Cloud project.';
      }
    } catch { /* keep raw */ }
    throw new Error(`Gemini ${detail}`);
  }
  const cand = JSON.parse(t).candidates?.[0];
  const part = cand?.content?.parts?.find((p) => p.inlineData?.data ?? p.inline_data?.data);
  const data = part?.inlineData?.data ?? part?.inline_data?.data;
  if (!data) {
    const why = cand?.finishReason ? ` (finishReason: ${cand.finishReason})` : '';
    throw new Error(`Gemini returned no image${why}`);
  }
  return data;
};

/**
 * fal.ai reference-conditioning model. nano-banana (Google's Gemini-image
 * family, hosted on fal) via its /edit endpoint takes image_urls as an ARRAY —
 * so multi-photo references (front/side/detail) work here, unlike flux Kontext
 * which only accepts a single image_url. Same identity-lock quality as the
 * direct Gemini path but billed through fal. Override to fall back to the old
 * single-image path with FAL_IMG2IMG_MODEL=fal-ai/flux-pro/kontext.
 */
const FAL_IMG2IMG_MODEL = env.FAL_IMG2IMG_MODEL || process.env.FAL_IMG2IMG_MODEL || 'fal-ai/nano-banana/edit';
/** fal text-to-image (no reference) — unchanged default. */
const FAL_TXT2IMG_MODEL = env.FAL_TXT2IMG_MODEL || process.env.FAL_TXT2IMG_MODEL || 'fal-ai/flux-pro/v1.1';

/** Map pixel dims to the closest aspect_ratio nano-banana accepts (it has no
 * width/height params). Wide sheets (1536×640) → 21:9 so poses pack in a row. */
const falAspect = (w, h) => {
  if (!w || !h) return '1:1';
  const r = w / h;
  if (r >= 2) return '21:9';
  if (r >= 1.3) return '16:9';
  if (r <= 0.5) return '9:16';
  if (r <= 0.77) return '3:4';
  return '1:1';
};

/**
 * fal.ai synchronous run endpoint. `image` = one raw base64 reference
 * (frame-gen); `images` = base64 array (multi-photo stylize). Any reference →
 * the /edit (img2img) model; none → the text-to-image model.
 */
const generateFal = async ({ prompt, image, images, seed, width, height }) => {
  const refs = (Array.isArray(images) && images.length ? images : (image ? [image] : []))
    .map((b) => (String(b).startsWith('data:') ? String(b) : `data:image/png;base64,${b}`));
  const model = refs.length ? FAL_IMG2IMG_MODEL : FAL_TXT2IMG_MODEL;
  const isNano = model.includes('nano-banana');
  let body;
  if (refs.length && isNano) {
    body = { prompt, image_urls: refs, num_images: 1, output_format: 'png', aspect_ratio: falAspect(width, height) };
  } else if (refs.length) {
    // flux Kontext fallback — single image_url only.
    body = { prompt, image_url: refs[0], seed, output_format: 'png' };
  } else if (isNano) {
    body = { prompt, num_images: 1, output_format: 'png', aspect_ratio: falAspect(width, height) };
  } else {
    body = { prompt, seed, output_format: 'png' };
  }
  const r = await fetch(`https://fal.run/${model}`, {
    method: 'POST',
    headers: { Authorization: `Key ${FAL_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`fal ${r.status} (${model}): ${JSON.stringify(j).slice(0, 200)}`);
  const url = j.images?.[0]?.url;
  if (!url) throw new Error('fal: no image in response');
  if (url.startsWith('data:')) return url.split(',')[1];
  return Buffer.from(await (await fetch(url)).arrayBuffer()).toString('base64');
};

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
const safeSprite = (name) => /^[a-zA-Z0-9._-]{1,80}\.(png|webp|json)$/.test(name);

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json',
  '.png': 'image/png', '.webp': 'image/webp', '.css': 'text/css', '.svg': 'image/svg+xml',
};

// ---- server ----------------------------------------------------------------
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const path = url.pathname;

    // ------------------------------------------------ capabilities
    if (req.method === 'GET' && path === '/api/capabilities') {
      return json(res, 200, {
        provider: PROVIDER,
        img2img: SUPPORTS_IMG2IMG,
        // Every provider usable for TEXT-to-image right now (nvidia needs
        // only NVAPI_KEY; it's the fallback default so it's "available" iff
        // the key is set — same bar as the others).
        available: {
          nvidia: !!NVAPI_KEY,
          gemini: !!GEMINI_API_KEY,
          bfl: !!BFL_API_KEY,
          fal: !!FAL_KEY,
        },
      });
    }

    // ------------------------------------------------ generation proxy
    if (req.method === 'POST' && path === '/api/generate') {
      const raw = await readBody(req);
      const req0 = JSON.parse(raw.toString('utf8'));
      // Per-request override (e.g. Stage tab explicitly picking NVIDIA for
      // one-off set-dressing art). Falls back to the configured default.
      const provider = (req0.provider || PROVIDER).toLowerCase();
      const canImg2Img = (p) => (p === 'bfl' && !!BFL_API_KEY)
        || (p === 'fal' && !!FAL_KEY) || (p === 'gemini' && !!GEMINI_API_KEY);

      // Reference-conditioned path (only providers that accept our image).
      // `image` = single reference (frame-gen). `images` = multi-reference
      // array (stylize step). Gemini and fal (nano-banana/edit) both consume
      // the whole array; bfl (single image_url) takes the first.
      const stripPrefix = (s) => String(s).replace(/^data:image\/\w+;base64,/, '');
      const imagesIn = Array.isArray(req0.images) && req0.images.length
        ? req0.images.map(stripPrefix) : null;
      if (req0.image || imagesIn) {
        if (!canImg2Img(provider)) {
          return json(res, 400, {
            error: `provider "${provider}" cannot accept a reference image `
              + `(NVIDIA's flux endpoints only take gallery example_ids — that is true for `
              + `EVERY nvidia model, not fixable per-request). `
              + `Use gemini, bfl, or fal (+ key) in .env for true reference conditioning.`,
          });
        }
        const image = req0.image ? stripPrefix(req0.image) : imagesIn?.[0];
        const images = (provider === 'gemini' || provider === 'fal') ? (imagesIn ?? undefined) : undefined;
        try {
          const b64 = provider === 'bfl' ? await generateBfl({ ...req0, image })
            : provider === 'gemini' ? await generateGemini({ ...req0, image, images })
            : await generateFal({ ...req0, image, images });
          return json(res, 200, { artifacts: [{ base64: b64 }] });
        } catch (err) {
          return json(res, 502, { error: String(err?.message ?? err) });
        }
      }

      // Text-to-image — any configured provider can do this.
      try {
        const b64 = provider === 'bfl' ? await generateBfl(req0)
          : provider === 'fal' ? await generateFal(req0)
          : provider === 'gemini' ? await generateGemini(req0)
          : await generateNvidia(req0);
        return json(res, 200, { artifacts: [{ base64: b64 }] });
      } catch (err) {
        return json(res, 502, { error: String(err?.message ?? err) });
      }
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
        // Body is a base64 data URL (png or webp) or raw base64.
        const b64 = raw.toString('utf8').replace(/^data:image\/\w+;base64,/, '');
        writeFileSync(join(dir, name), Buffer.from(b64, 'base64'));
      }
      return json(res, 200, { ok: true });
    }

    // ------------------------------------------------ stages
    // Stage backgrounds are plain files: stages/<id>/background.png (or .svg)
    // + stage.json (floor anchor, extend colors). The game client consumes
    // them; the Studio Stage tab generates/uploads them.
    if (path === '/api/stages' && req.method === 'GET') {
      const list = existsSync(STAGES)
        ? readdirSync(STAGES, { withFileTypes: true })
          .filter((d) => d.isDirectory() && existsSync(join(STAGES, d.name, 'stage.json')))
          .map((d) => d.name)
        : [];
      return json(res, 200, list);
    }
    const stageApi = path.match(/^\/api\/stages\/([^/]+)\/([^/]+)$/);
    if (stageApi && req.method === 'PUT') {
      const [, id, name] = stageApi;
      // background.(png|svg) = legacy single flat plane. layer-*.png = one
      // parallax plane (Studio writes layer-bg/layer-mid/layer-fg by
      // convention; the id after "layer-" is free-form so custom plane
      // counts/names work too).
      if (!safeId(id) || !/^(background\.(png|svg)|layer-[a-z0-9-]{1,40}\.png|stage\.json)$/.test(name)) {
        return json(res, 400, { error: 'bad stage path' });
      }
      const dir = join(STAGES, id);
      mkdirSync(dir, { recursive: true });
      const raw = await readBody(req);
      if (name.endsWith('.json') || name.endsWith('.svg')) {
        writeFileSync(join(dir, name), raw);
      } else {
        const b64 = raw.toString('utf8').replace(/^data:image\/\w+;base64,/, '');
        writeFileSync(join(dir, name), Buffer.from(b64, 'base64'));
      }
      return json(res, 200, { ok: true });
    }

    // ------------------------------------------------ pets (ADR 0011)
    // A pet is the simplest asset in the repo: pets/<id>/pet.json (a PetDef)
    // plus its frames. The match server reads this directory to build the
    // adoption catalog, so publishing a pet IS writing the folder.
    //
    // AURAS ARE NOT AUTHORED HERE. Every line is rolled per-adoption by the
    // match server; the Studio only makes the creature.
    if (path === '/api/pets' && req.method === 'GET') {
      const list = existsSync(PETS)
        ? readdirSync(PETS, { withFileTypes: true })
          .filter((d) => d.isDirectory() && existsSync(join(PETS, d.name, 'pet.json')))
          .map((d) => ({
            id: d.name,
            def: JSON.parse(readFileSync(join(PETS, d.name, 'pet.json'), 'utf8')),
          }))
        : [];
      return json(res, 200, list);
    }
    const petApi = path.match(/^\/api\/pets\/([^/]+)\/([^/]+)$/);
    if (petApi && req.method === 'PUT') {
      const [, id, name] = petApi;
      if (!safeId(id) || !/^(pet\.json|frame[0-9]{1,2}\.png)$/.test(name)) {
        return json(res, 400, { error: 'bad pet path' });
      }
      const dir = join(PETS, id);
      mkdirSync(dir, { recursive: true });
      const raw = await readBody(req);
      if (name.endsWith('.json')) {
        writeFileSync(join(dir, name), raw);
      } else {
        const b64 = raw.toString('utf8').replace(/^data:image\/\w+;base64,/, '');
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
    } else if (path.startsWith('/stages/')) {
      const rel = normalize(path.slice('/stages/'.length)).replace(/^([.][.][/\\])+/, '');
      filePath = join(STAGES, rel);
      if (!filePath.startsWith(STAGES)) filePath = null;
    } else if (path.startsWith('/pets/')) {
      // PETS (ADR 0011). Without this the Pets tab can WRITE frames but never
      // read them back: pet.json lists them, every load 404s, and the editor
      // reports "0 frame(s)" for a pet that has art on disk.
      const rel = normalize(path.slice('/pets/'.length)).replace(/^([.][.][/\\])+/, '');
      filePath = join(PETS, rel);
      if (!filePath.startsWith(PETS)) filePath = null;
    }
    if (filePath && existsSync(filePath)) {
      const ext = filePath.slice(filePath.lastIndexOf('.'));
      res.writeHead(200, {
        'Content-Type': MIME[ext] ?? 'application/octet-stream',
        // Never cache: this is a dev tool whose SPA and sprites are rewritten
        // constantly. A cached studio.html silently runs yesterday's code
        // (and a cached sprite hides the frame you just regenerated).
        'Cache-Control': 'no-store, must-revalidate',
      });
      return res.end(readFileSync(filePath));
    }

    json(res, 404, { error: 'not found' });
  } catch (err) {
    json(res, 500, { error: String(err?.message ?? err) });
  }
});

server.listen(PORT, () => {
  const modelOf = { nvidia: NV_MODEL, gemini: GEMINI_MODEL };
  console.log(`Agent Fighter Studio → http://localhost:${PORT}`);
  console.log(`provider: ${PROVIDER}${modelOf[PROVIDER] ? ` (${modelOf[PROVIDER]})` : ''}`);
  console.log(SUPPORTS_IMG2IMG
    ? '✅ reference-image conditioning ENABLED — every frame is generated FROM the locked reference'
    : '⚠ text-only: this provider cannot use a reference image — character identity '
      + 'is best-effort. Set IMAGE_PROVIDER=gemini|bfl|fal + key in .env to enable it.');
});
