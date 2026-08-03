/**
 * Agent Fighter Studio — character authoring tool (spec §5.2).
 * Embeds @af/core so the live preview IS the game engine: what you see in
 * the Test tab is exactly what ships. No framework; coarse re-render DOM.
 *
 * Tabs: Character (params) · Frames (timeline + visual boxes) · Moves
 * (frame-data table) · Cancels (graph matrix) · Test (playable vs dummy) ·
 * Generate (AI sprites → normalize → QC → accept).
 */
import {
  Action, Btn, Phase, STAGE, TICKS_PER_SEC, TUNING,
  characters, createGameState, debugBoxes, loadCharacter, setCharacters,
  spriteForFighter, step,
} from '@af/core';
import type {
  CharacterBundle, GameState, HitboxDef, InputFrame, MoveDef, MoveStep, Rect,
} from '@af/core';
import {
  CELL_W, DEFAULT_KEY, PALETTE_N, PIVOT_X, PIVOT_Y, SPRITE_SCALE,
  alphaBounds, autoHurtboxes, canvasToPngDataUrl,
  decodeBase64Image, diffHitboxDraft, enclosedWhitePockets, extractPalette,
  sliceSheet,
  flipCanvasH, maskDiff, meanChroma, mirrorMask16, normalizeFrame, qcScore,
  measureFigureH, removeBackground, silhouetteMask16, sliceStrip,
} from './pipeline.js';
import type { KeySettings, NormalizedFrame, QCResult, RGB } from './pipeline.js';

interface StudioMeta {
  desc?: string;
  /** Select-screen dossier: who this fighter is, and their pre-fight line. */
  bio?: string;
  quote?: string;
  /**
   * Canonical archetype (rushdown / zoner / turtle / jumpy / grappler /
   * all-rounder). The match server builds arcade opponents' personalities from
   * it and the select screen shows it as the FIGHTING STYLE chip; written by
   * tools/apply-char-tuning.mjs alongside the per-fighter feel knobs.
   */
  style?: string;
  palette?: RGB[];
  refBodyW?: number;
  refMask?: number[]; // 16×16 silhouette of the reference (facing detection)
  refChroma?: number; // mean chroma of the reference (desaturation QC)
  moveDesc?: Record<string, string>;
  selectPortrait?: string; // character-select portrait sprite (e.g. _select.png)
  // Portrait framing: zoom/recenter + 90° rotation + horizontal flip.
  selectFraming?: { zoom: number; panX: number; panY: number; rotate?: number; flipH?: boolean };
  /**
   * VS-screen pose (e.g. _vs.png) + its framing. Authored separately from the
   * select portrait because the VS card wants a full-body fighting stance, not
   * a face. When set, the game COVER-fits it into a fixed VS frame, so every
   * character occupies the same box no matter how its source art is
   * proportioned; without it the card falls back to contain-fitting the select
   * portrait (safe, but sizes vary per character).
   */
  vsPortrait?: string;
  vsFraming?: { zoom: number; panX: number; panY: number; rotate?: number; flipH?: boolean };
  disabled?: boolean; // greyed out + unselectable on the character-select screen
}

type TabName = 'character' | 'frames' | 'moves' | 'cancels' | 'test' | 'generate' | 'stage'
  | 'pets';

// ------------------------------------------------------------------ state
let stCharId = 'analog';
let stCharList: string[] = [];
let stBundle: CharacterBundle | null = null;
let stTab: TabName = 'frames';
let stMoveIdx = 0;
let stStepIdx = 0;
let stSel: { list: 'hurt' | 'hit'; i: number } | null = null;
let stOnion = true;
let stStatus = 'loading…';
let stDirty = false;
let stRaf = 0;
let stSeed = 1;
const spriteImgs = new Map<string, HTMLCanvasElement | HTMLImageElement>();

interface GenResult { norm: NormalizedFrame; qc: QCResult; accepted: boolean; flipped?: boolean }
let stGenResults = new Map<number, GenResult>();
let stGenBusy = false;
let stRefPreview: NormalizedFrame | null = null;
let stMissingOnly = true; // batch: only generate steps without a sprite

const meta = (): StudioMeta => {
  const b = stBundle as CharacterBundle & { meta?: StudioMeta };
  if (!b.meta) b.meta = {};
  return b.meta;
};

// ------------------------------------------------------------------ api
const apiJson = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const r = await fetch(path, init);
  const body = await r.json();
  if (!r.ok) throw new Error(body?.error ?? `HTTP ${r.status}`);
  return body as T;
};

/**
 * System animation set (spec §4: non-attack poses are Moves with
 * type:"system"). One template per canonical sys.* id — added to any bundle
 * that lacks them so idle/walk/jump/stun states get sprite tracks. The sim
 * never selects these; they are pure animation data for spriteForFighter().
 */
const SYSTEM_MOVE_SET: { id: string; steps: number; frames: number }[] = [
  { id: 'sys.idle', steps: 4, frames: 8 },
  { id: 'sys.walkF', steps: 4, frames: 7 },
  { id: 'sys.walkB', steps: 4, frames: 7 },
  { id: 'sys.crouch', steps: 1, frames: 8 },
  { id: 'sys.jump', steps: 3, frames: 8 }, // rising / apex / falling
  { id: 'sys.dashF', steps: 1, frames: 6 },
  { id: 'sys.dashB', steps: 1, frames: 6 },
  { id: 'sys.block', steps: 1, frames: 8 },
  { id: 'sys.blockCrouch', steps: 1, frames: 8 },
  { id: 'sys.blockAir', steps: 1, frames: 8 },
  { id: 'sys.hitstun', steps: 1, frames: 8 },
  { id: 'sys.airHitstun', steps: 1, frames: 8 },
  { id: 'sys.knockdown', steps: 1, frames: 8 },
  { id: 'sys.getup', steps: 2, frames: 7 },
  { id: 'sys.ko', steps: 1, frames: 8 },
];

const ensureSystemMoves = (b: CharacterBundle): number => {
  const have = new Set(b.moves.map((m) => m.id));
  let added = 0;
  for (const t of SYSTEM_MOVE_SET) {
    if (have.has(t.id)) continue;
    b.moves.push({
      id: t.id, type: 'system', stance: 'stand',
      steps: Array.from({ length: t.steps }, () => ({
        frames: t.frames, phase: 'active' as const, hurtboxes: [{ ...b.standHurtbox }],
      })),
      meterGainWhiff: 0, meterGainHit: 0,
    });
    added++;
  }
  return added;
};

const loadChar = async (id: string): Promise<void> => {
  stBundle = await apiJson<CharacterBundle>(`/api/characters/${id}`);
  stCharId = id;
  stMoveIdx = 0;
  stStepIdx = 0;
  stSel = null;
  stGenResults = new Map();
  stDirty = false;
  stPortraitPicker = null;
  spriteImgs.clear();
  const added = ensureSystemMoves(stBundle);
  if (added > 0) stDirty = true;
  stStatus = `loaded ${id}${added ? ` · added ${added} system anims (save to persist)` : ''}`;
};

const saveChar = async (): Promise<void> => {
  try {
    loadCharacter(structuredClone(stBundle!)); // validate before persisting
    const r = await apiJson<{ versionHash: string }>(`/api/characters/${stCharId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(stBundle),
    });
    stDirty = false;
    const packed = await packAtlas();
    stStatus = `saved · hash ${r.versionHash}${packed ? ` · atlas ${packed} frames` : ''}`;
  } catch (e) {
    stStatus = `SAVE FAILED: ${(e as Error).message}`;
  }
  renderAll();
};

/**
 * Pack all referenced sprites into atlas.png + atlas.json (spec §3: the
 * bundle ships a packed atlas, never hand-made).
 *
 * TRIMMED packing: a sprite cell is 384² but the figure occupies a fraction of
 * it, so storing whole cells wasted ~4x the pixels (a 98-frame character was a
 * 3840² / 5 MB atlas). Each frame is cropped to its alpha bounds and
 * shelf-packed; the pivot is stored RELATIVE to the crop, which is exactly what
 * the renderer already blits against, so nothing downstream changes.
 * Returns frame count, or 0 if no sprites.
 */
const ATLAS_W = 2048;
const ATLAS_PAD = 2; // guards against bilinear filtering bleeding between frames

const packAtlas = async (): Promise<number> => {
  const names = [...new Set(
    stBundle!.moves.flatMap((mv) => mv.steps.map((s) => s.sprite)).filter((s): s is string => !!s))];
  if (names.length === 0) return 0;

  // Ensure every sprite is loaded as a canvas we can measure + crop.
  const cells = await Promise.all(names.map(async (name) => {
    let cell = spriteCanvas(name);
    for (let w = 0; w < 40 && !cell; w++) {
      await new Promise((r) => setTimeout(r, 50));
      cell = spriteCanvas(name);
    }
    if (!cell) throw new Error(`missing sprite ${name}`);
    return { name, cell, box: alphaBounds(cell) };
  }));

  // Shelf-pack tallest-first: near-optimal for same-ish sprites, ~10 lines.
  interface Placed { name: string; cell: HTMLCanvasElement; sx: number; sy: number; w: number; h: number; px: number; py: number; }
  const sorted = [...cells].sort((a, b) => {
    const ha = a.box ? a.box.b - a.box.t : 0;
    const hb = b.box ? b.box.b - b.box.t : 0;
    return hb - ha;
  });
  const placed: Placed[] = [];
  let penX = ATLAS_PAD, penY = ATLAS_PAD, shelfH = 0;
  for (const c of sorted) {
    // A fully transparent frame still needs a slot; give it 1px.
    const bx = c.box ?? { l: PIVOT_X, t: PIVOT_Y, r: PIVOT_X, b: PIVOT_Y };
    const w = bx.r - bx.l + 1;
    const h = bx.b - bx.t + 1;
    if (penX + w + ATLAS_PAD > ATLAS_W) {
      penX = ATLAS_PAD;
      penY += shelfH + ATLAS_PAD;
      shelfH = 0;
    }
    placed.push({
      name: c.name, cell: c.cell, sx: penX, sy: penY, w, h,
      // Pivot relative to the CROP — the renderer draws at (-pivotX, -pivotY).
      px: PIVOT_X - bx.l, py: PIVOT_Y - bx.t,
    });
    // Remember the source crop origin on the cell for the blit below.
    (placed[placed.length - 1] as Placed & { cx: number; cy: number }).cx = bx.l;
    (placed[placed.length - 1] as Placed & { cx: number; cy: number }).cy = bx.t;
    penX += w + ATLAS_PAD;
    shelfH = Math.max(shelfH, h);
  }
  const atlasH = penY + shelfH + ATLAS_PAD;

  const atlas = document.createElement('canvas');
  atlas.width = ATLAS_W;
  atlas.height = atlasH;
  const ctx = atlas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;

  const frames: Record<string, { x: number; y: number; w: number; h: number; pivotX: number; pivotY: number }> = {};
  for (const p of placed as (Placed & { cx: number; cy: number })[]) {
    ctx.drawImage(p.cell, p.cx, p.cy, p.w, p.h, p.sx, p.sy, p.w, p.h);
    frames[p.name] = { x: p.sx, y: p.sy, w: p.w, h: p.h, pivotX: p.px, pivotY: p.py };
  }

  /**
   * Ship WebP. Trimming cut the atlas PIXELS ~4x (a big VRAM/decode win) but
   * barely touched the FILE, because empty space costs a PNG almost nothing —
   * the megabytes are the art itself. WebP at q0.92 is visually
   * indistinguishable here and roughly a fifth the bytes. PNG stays the
   * fallback for any browser that can't encode it.
   */
  const webp = atlas.toDataURL('image/webp', 0.92);
  const useWebp = webp.startsWith('data:image/webp');
  const imageName = useWebp ? 'atlas.webp' : 'atlas.png';
  await apiJson(`/api/characters/${stCharId}/sprites/${imageName}`, {
    method: 'PUT', body: useWebp ? webp : canvasToPngDataUrl(atlas),
  });
  await apiJson(`/api/characters/${stCharId}/sprites/atlas.json`, {
    method: 'PUT',
    // `scale` = world px per sprite px. Sprites are authored supersampled for
    // detail, so the renderer must shrink them back to world size; `smooth`
    // tells it to filter rather than point-sample (anime art, not pixel art).
    body: JSON.stringify({
      image: imageName,
      cellW: CELL_W, cellH: CELL_W, scale: SPRITE_SCALE, smooth: true, frames,
    }, null, 2),
  });
  return placed.length;
};

/** Which text-to-image providers are configured (have a key in .env). */
let stAvailable: Record<string, boolean> = { nvidia: false, gemini: false, bfl: false, fal: false };
/** Providers that accept a user reference image (true identity lock). NVIDIA
 * cannot — its `image` field only takes gallery example_ids, so it's text-only. */
const IMG2IMG_PROVIDERS = new Set(['gemini', 'bfl', 'fal']);
const isImg2Img = (p: string): boolean => IMG2IMG_PROVIDERS.has(p) && !!stAvailable[p];
/**
 * Per-category generation engines, chosen in the Generate/Stage tabs. Each
 * defaults to the server's configured IMAGE_PROVIDER on capabilities load and
 * is overridable independently (e.g. Gemini reference, fal sprite batch,
 * NVIDIA stage):
 *  - stRefProvider    : character reference (generate reference + stylize upload)
 *  - stSpriteProvider : per-move sprite / frame batches
 *  - stStageProvider  : set-dressing (no identity lock — NVIDIA is fine + cheap)
 */
let stRefProvider = 'nvidia';
let stSpriteProvider = 'nvidia';
let stStageProvider = 'nvidia';
/** img2img capability of the SPRITE engine — most call sites are sprite-context.
 * Recomputed whenever stSpriteProvider changes. */
let stImg2Img = false;

// ---- background key (chroma/luma) settings ---------------------------------
/**
 * Studio-wide keyer tuning, persisted in localStorage. `mode` picks the
 * GENERATION background color too: 'white' is the classic default but
 * collides with white costume parts / eyes / teeth; 'magenta'/'green' are the
 * film-industry answer — characters essentially never contain saturated
 * magenta, so the key can be generous with zero risk to white foreground.
 * Changing the mode only affects NEW generations (the prompt asks for that
 * backdrop and the keyer is told to expect it).
 */
type KeyBgMode = 'white' | 'magenta' | 'green';
interface StudioKeyCfg {
  mode: KeyBgMode;
  strength: number;
  softness: number;
  clearPockets: boolean;
  pocketTightness: number;
  pocketMinFrac: number;
}
const KEY_CFG_DEFAULTS: StudioKeyCfg = {
  mode: 'white',
  strength: DEFAULT_KEY.strength,
  softness: DEFAULT_KEY.softness,
  clearPockets: DEFAULT_KEY.clearPockets,
  pocketTightness: DEFAULT_KEY.pocketTightness,
  pocketMinFrac: DEFAULT_KEY.pocketMinFrac,
};
const KEY_CFG_LS = 'af-studio-key-cfg';
let stKeyCfg: StudioKeyCfg = { ...KEY_CFG_DEFAULTS };
try {
  stKeyCfg = { ...KEY_CFG_DEFAULTS, ...JSON.parse(localStorage.getItem(KEY_CFG_LS) ?? '{}') as Partial<StudioKeyCfg> };
} catch { /* corrupted localStorage — defaults */ }
const saveKeyCfg = (): void => { localStorage.setItem(KEY_CFG_LS, JSON.stringify(stKeyCfg)); };

const KEY_MODE_RGB: Record<KeyBgMode, RGB | null> = {
  white: null, // auto: sample the border median (robust to off-white JPEG)
  magenta: [255, 0, 255],
  green: [0, 255, 0],
};
/** The pipeline-shaped settings object for the CURRENT Studio config. */
const keySettings = (): KeySettings => ({
  strength: stKeyCfg.strength,
  softness: stKeyCfg.softness,
  clearPockets: stKeyCfg.clearPockets,
  pocketTightness: stKeyCfg.pocketTightness,
  pocketMinFrac: stKeyCfg.pocketMinFrac,
  keyColor: KEY_MODE_RGB[stKeyCfg.mode],
});
/** Prompt phrase for the generation background, driven by the key mode. */
const bgPhrase = (): string =>
  stKeyCfg.mode === 'white' ? 'pure white'
    : stKeyCfg.mode === 'magenta' ? 'pure magenta (#FF00FF)' : 'pure green (#00FF00)';

/** Last RAW generated image — the key-preview panel re-keys this live. */
let stLastRaw: HTMLImageElement | null = null;
/** Memoized keyed preview (renderAll runs constantly; keying 1MP isn't free). */
let stKeyPreview: { src: HTMLImageElement; cfg: string; out: HTMLCanvasElement; bleed: number } | null = null;

/** The locked reference sheet as base64 PNG (for reference-conditioned gen). */
/**
 * The reference sprite as base64. Waits for the PNG to decode — it is loaded
 * lazily into the sprite cache, and returning null early would silently
 * downgrade a conditioned generation to a text-only one (i.e. bring costume
 * drift straight back). Callers treat null as a hard error, never a fallback.
 */
const referenceB64 = async (): Promise<string | null> => {
  let ref = spriteCanvas('_reference.png');
  for (let w = 0; w < 40 && !ref; w++) {
    await new Promise((r) => setTimeout(r, 100));
    ref = spriteCanvas('_reference.png');
  }
  return ref ? canvasToPngDataUrl(ref) : null;
};

const generateImage = async (
  prompt: string, seed: number, width = 1024, height = 1024, useRef = false, provider?: string,
  imageOverride?: string, imagesOverride?: string[],
): Promise<HTMLImageElement> => {
  // With an img2img engine, every frame is conditioned on the reference sheet —
  // the ONLY way to truly hold a character's identity across images. NVIDIA's
  // flux cannot (see server.mjs), so useRef is a no-op on it. `provider` names
  // the engine for THIS call (per-category: reference/sprite/stage); useRef +
  // provider now compose — a sprite batch on `fal` sends the reference AND the
  // provider. Whether the reference actually rides along is gated on the
  // engine's img2img capability, so picking NVIDIA silently downgrades to text.
  //
  // `imageOverride` conditions on some OTHER image than the locked reference —
  // used to stylize a user's upload into a reference in the first place.
  let image: string | null = imageOverride ?? null;
  if (!image && useRef && isImg2Img(provider ?? stSpriteProvider)) {
    image = await referenceB64();
    if (!image) {
      throw new Error('reference sprite not available — generate + lock a reference first '
        + '(generating without it would silently drift the costume)');
    }
  }
  const body = {
    prompt, width, height, steps: 4, seed,
    ...(imagesOverride && imagesOverride.length ? { images: imagesOverride }
      : image ? { image } : {}),
    ...(provider ? { provider } : {}),
  };
  const r = await apiJson<{ artifacts?: { base64: string }[]; b64_json?: string }>(
    '/api/generate',
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const b64 = r.artifacts?.[0]?.base64;
  if (!b64) throw new Error('no image in response');
  const img = await decodeBase64Image(b64);
  stLastRaw = img; // feeds the background-key preview panel (Generate tab)
  return img;
};

const saveSprite = async (name: string, cell: HTMLCanvasElement): Promise<void> => {
  await apiJson(`/api/characters/${stCharId}/sprites/${name}`, {
    method: 'PUT', body: canvasToPngDataUrl(cell),
  });
  spriteImgs.set(`${stCharId}/${name}`, cell);
};

/** Sprite as a readable canvas (for pipeline ops) — converts loaded Images. */
const spriteCanvas = (name: string): HTMLCanvasElement | null => {
  const spr = getSprite(name);
  if (spr instanceof HTMLCanvasElement) return spr;
  if (spr instanceof HTMLImageElement && spr.complete && spr.naturalWidth > 0) {
    const c = document.createElement('canvas');
    c.width = spr.naturalWidth;
    c.height = spr.naturalHeight;
    c.getContext('2d')!.drawImage(spr, 0, 0);
    spriteImgs.set(`${stCharId}/${name}`, c);
    return c;
  }
  return null;
};

/**
 * Usable sprite for `name`, or null if it isn't drawable yet/at all.
 *
 * CRITICAL: never return a BROKEN image. A 404 (e.g. a new character with no
 * _reference.png yet) leaves the Image with `complete === true` but
 * `naturalWidth === 0`; drawing it throws "The HTMLImageElement provided is in
 * the 'broken' state." — which, thrown inside a renderAll(), surfaced as a
 * bogus "generation failed". Gate on naturalWidth, and cache a `null` sentinel
 * for a broken load so we neither redraw it nor refetch forever.
 */
const getSprite = (name: string, charId = stCharId): HTMLCanvasElement | HTMLImageElement | null => {
  const key = `${charId}/${name}`;
  const hit = spriteImgs.get(key);
  if (hit instanceof HTMLCanvasElement) return hit;
  if (hit instanceof HTMLImageElement) {
    if (hit.naturalWidth > 0) return hit; // loaded ok
    if (hit.complete) return null; // finished loading but broke (404) — give up
    return null; // still loading
  }
  const img = new Image();
  img.onerror = () => { spriteImgs.set(key, img); }; // keep the broken img so we don't refetch
  img.src = `/characters/${charId}/sprites/${name}`;
  spriteImgs.set(key, img);
  return img.complete && img.naturalWidth > 0 ? img : null;
};

/**
 * A contain-fit canvas thumbnail that paints sprite `name` once it streams in
 * (arbitrary aspect — unlike the sprite-cell thumbs, a portrait isn't square).
 * Repaints on a bounded timer while the PNG loads. Module-level so any tab can
 * use it (the Generate tab has its own local `thumb`/`savedThumb`).
 */
const spriteThumbEl = (name: string, size = 120): HTMLCanvasElement => {
  const t = mkEl('canvas', { width: size, height: size, class: 'thumb' });
  const tc = t.getContext('2d')!;
  let tries = 0;
  const paint = (): void => {
    const spr = getSprite(name);
    tc.imageSmoothingEnabled = true;
    tc.imageSmoothingQuality = 'high';
    tc.fillStyle = '#12141f';
    tc.fillRect(0, 0, size, size);
    if (spr) {
      const iw = spr instanceof HTMLCanvasElement ? spr.width : spr.naturalWidth;
      const ih = spr instanceof HTMLCanvasElement ? spr.height : spr.naturalHeight;
      const s = Math.min(size / iw, size / ih);
      const w = iw * s, h = ih * s;
      tc.drawImage(spr, (size - w) / 2, (size - h) / 2, w, h);
    } else if (tries++ < 60) setTimeout(paint, 120);
  };
  paint();
  return t;
};

// ------------------------------------------------------------------ dom
const mkEl = <K extends keyof HTMLElementTagNameMap>(
  tag: K, attrs: Record<string, unknown> = {}, ...children: (Node | string | null)[]
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === 'class') node.className = String(v);
    else if (k.startsWith('on')) (node as unknown as Record<string, unknown>)[k.toLowerCase()] = v;
    else if (k === 'value') (node as HTMLInputElement).value = String(v);
    else if (k === 'checked') (node as HTMLInputElement).checked = Boolean(v);
    else node.setAttribute(k, String(v));
  }
  for (const c of children) if (c != null) node.append(c);
  return node;
};

const numInput = (value: number, onCommit: (v: number) => void, width = 54): HTMLInputElement =>
  mkEl('input', {
    type: 'number', value, style: `width:${width}px`, step: 'any',
    onchange: (e: Event) => {
      const v = Number((e.target as HTMLInputElement).value);
      if (!Number.isNaN(v)) { onCommit(v); stDirty = true; renderAll(); }
    },
  });

/**
 * Like numInput but does NOT mark the character bundle dirty — for fields
 * belonging to a DIFFERENT asset (a pet, a stage). Sharing numInput made
 * editing a pet light up the character's "save *", inviting a save of a
 * bundle nothing had touched.
 */
const numInputClean = (
  value: number, onCommit: (v: number) => void, width = 54,
): HTMLInputElement =>
  mkEl('input', {
    type: 'number', value, style: `width:${width}px`, step: 'any',
    onchange: (e: Event) => {
      const v = Number((e.target as HTMLInputElement).value);
      if (!Number.isNaN(v)) { onCommit(v); renderAll(); }
    },
  });

const selInput = (value: string, options: string[], onCommit: (v: string) => void): HTMLSelectElement => {
  const s = mkEl('select', {
    onchange: (e: Event) => { onCommit((e.target as HTMLSelectElement).value); stDirty = true; renderAll(); },
  });
  for (const o of options) s.append(mkEl('option', { value: o, selected: o === value ? '' : null }, o || '(none)'));
  return s;
};

/** Like selInput but does NOT mark the bundle dirty — for session-only choices
 * (e.g. which image engine to generate with) that are not part of the bundle. */
const sessionSelect = (value: string, options: string[], onCommit: (v: string) => void): HTMLSelectElement => {
  const s = mkEl('select', {
    onchange: (e: Event) => { onCommit((e.target as HTMLSelectElement).value); renderAll(); },
  });
  for (const o of options) s.append(mkEl('option', { value: o, selected: o === value ? '' : null }, o || '(none)'));
  return s;
};

// ------------------------------------------------- modal dialogs
/**
 * NEVER use window.prompt/confirm here. Embedded browsers (the in-app preview
 * pane, and Chrome in some contexts) suppress them: prompt() returns null and
 * confirm() returns false with no UI, so the action just silently does
 * nothing. That is exactly why "+ new" looked dead — and it had quietly killed
 * "flip ALL sprites", "delete move" and "+ new stage" too.
 */
let stNewChar: { id: string; name: string; desc: string } | null = null;
let stNewStage: { id: string } | null = null;
let stConfirm: { msg: string; onOk: () => void } | null = null;

const askConfirm = (msg: string, onOk: () => void): void => {
  stConfirm = { msg, onOk };
  renderAll();
};

const renderConfirmDialog = (): HTMLElement | null => {
  if (!stConfirm) return null;
  const c = stConfirm;
  return mkEl('div', { class: 'modal' },
    mkEl('div', { class: 'modalbox' },
      mkEl('p', {}, c.msg),
      mkEl('div', { class: 'row' },
        mkEl('button', {
          onclick: () => { stConfirm = null; c.onOk(); renderAll(); },
        }, 'yes, do it'),
        mkEl('button', { onclick: () => { stConfirm = null; renderAll(); } }, 'cancel'),
      ),
    ),
  );
};

const renderNewStageDialog = (): HTMLElement | null => {
  if (!stNewStage) return null;
  const n = stNewStage;
  const ok = /^[a-z0-9][a-z0-9-]{0,40}$/.test(n.id);
  return mkEl('div', { class: 'modal' },
    mkEl('div', { class: 'modalbox' },
      mkEl('b', {}, 'new stage'),
      mkEl('label', { class: 'field' }, 'stage id',
        mkEl('input', {
          value: n.id, placeholder: 'e.g. dojo', style: 'width:220px',
          oninput: (e: Event) => { n.id = (e.target as HTMLInputElement).value.trim(); renderAll(); },
        })),
      n.id && !ok ? mkEl('p', { class: 'qc fail' }, 'lowercase letters, numbers and dashes only') : null,
      mkEl('div', { class: 'row' },
        mkEl('button', {
          disabled: ok ? null : '',
          onclick: () => { const id = n.id; stNewStage = null; newStage(id); },
        }, 'create'),
        mkEl('button', { onclick: () => { stNewStage = null; renderAll(); } }, 'cancel'),
      ),
    ),
  );
};

/**
 * Create a character by cloning the CURRENT bundle's frame data — the whole
 * point of the archetype library is that move timings/boxes are reusable — but
 * stripping everything that makes it *that* character: sprites, and the meta
 * identity block (reference palette, facing mask, chroma, pose overrides).
 * Inheriting those silently would lock the new fighter to the old one's
 * reference image.
 */
const createCharacter = async (id: string, name: string, desc: string): Promise<void> => {
  const copy = structuredClone(stBundle!) as CharacterBundle & { meta?: StudioMeta; versionHash?: string };
  copy.name = name || id;
  for (const mv of copy.moves) for (const s of mv.steps) delete s.sprite;
  delete copy.versionHash;
  copy.meta = desc ? { desc } : {};

  stBundle = copy;
  stCharId = id;
  stMoveIdx = 0;
  stStepIdx = 0;
  stSel = null;
  stGenResults = new Map();
  stRefPreview = null;
  stUpload = [];
  stAudit = null;
  spriteImgs.clear();
  stDirty = true;

  await saveChar();
  stCharList = await apiJson<string[]>('/api/characters');
  stTab = 'generate'; // next step is always: give it a reference
  stStatus = `created "${id}" — now generate or upload a reference image`;
  renderAll();
};

const renderNewCharDialog = (): HTMLElement | null => {
  if (!stNewChar) return null;
  const n = stNewChar;
  const idOk = /^[a-z0-9][a-z0-9-]{0,40}$/.test(n.id);
  const taken = stCharList.includes(n.id);
  const err = n.id === '' ? '' : !idOk ? 'id must be lowercase letters, numbers and dashes'
    : taken ? `"${n.id}" already exists` : '';
  return mkEl('div', { class: 'modal' },
    mkEl('div', { class: 'modalbox' },
      mkEl('b', {}, 'new character'),
      mkEl('p', { class: 'hint' },
        `frame data (moves, timings, hitboxes, cancels) is copied from ${stBundle?.name ?? 'the current character'} `
        + 'as an archetype — sprites and the reference identity are NOT.'),
      mkEl('label', { class: 'field' }, 'id',
        mkEl('input', {
          value: n.id, placeholder: 'e.g. blaze', style: 'width:220px',
          oninput: (e: Event) => { n.id = (e.target as HTMLInputElement).value.trim(); renderAll(); },
        })),
      mkEl('label', { class: 'field' }, 'display name',
        mkEl('input', {
          value: n.name, placeholder: 'e.g. Blaze', style: 'width:220px',
          oninput: (e: Event) => { n.name = (e.target as HTMLInputElement).value; },
        })),
      mkEl('label', { class: 'field' }, 'description',
        mkEl('input', {
          value: n.desc, style: 'width:360px',
          placeholder: 'anime muay thai fighter, blue mohawk, gold arm wraps…',
          oninput: (e: Event) => { n.desc = (e.target as HTMLInputElement).value; },
        })),
      err ? mkEl('p', { class: 'qc fail' }, err) : null,
      mkEl('div', { class: 'row' },
        mkEl('button', {
          disabled: !idOk || taken ? '' : null,
          onclick: () => {
            const { id, name, desc } = n;
            stNewChar = null;
            void createCharacter(id, name || id, desc);
          },
        }, 'create'),
        mkEl('button', { onclick: () => { stNewChar = null; renderAll(); } }, 'cancel'),
      ),
    ),
  );
};

// ------------------------------------------------------------------ header
const renderHeader = (): HTMLElement => {
  const tabs: TabName[] = ['character', 'frames', 'moves', 'cancels', 'test', 'generate',
    'stage', 'pets'];
  return mkEl('div', { class: 'header' },
    mkEl('span', { class: 'logo' }, 'AF STUDIO'),
    selInput(stCharId, stCharList, (id) => { void loadChar(id).then(renderAll); }),
    mkEl('button', {
      title: 'create a character (copies this one\'s frame data as an archetype)',
      onclick: () => { stNewChar = { id: '', name: '', desc: '' }; renderAll(); },
    }, '+ new'),
    ...tabs.map((t) => mkEl('button', {
      class: stTab === t ? 'tab active' : 'tab',
      onclick: () => { stTab = t; stSel = null; renderAll(); },
    }, t)),
    mkEl('button', { class: stDirty ? 'save dirty' : 'save', onclick: () => void saveChar() },
      stDirty ? 'save *' : 'save'),
    mkEl('span', { class: 'status' }, stStatus),
  );
};

// ------------------------------------------------------------------ character tab
/** Fixed filename for the character-select portrait (see meta.selectPortrait). */
const SELECT_PORTRAIT = '_select.png';

/**
 * A portrait SLOT: one authored image + framing pair in meta. Two exist —
 * the square character-select portrait and the VS-screen pose — and they
 * share every control below (upload / from-sprite / from-reference / zoom /
 * rotate / flip / drag-recenter), differing only in filename, meta keys, and
 * the preview's aspect (WYSIWYG: the game draws select square, VS tall).
 */
interface PortraitSlot {
  file: string;
  imgKey: 'selectPortrait' | 'vsPortrait';
  frameKey: 'selectFraming' | 'vsFraming';
  title: string;
  /** Preview box in px — matches the game's aspect for that slot. */
  pw: number;
  ph: number;
  /**
   * How the game fits the art into its frame — the preview mirrors it exactly.
   * 'cover' fills the frame and center-crops the overflow (right for a square
   * portrait); 'contain' keeps the whole pose visible inside a fixed box (right
   * for VS: nothing clipped, and every character ends up the same size).
   */
  fit: 'cover' | 'contain';
  hint: string;
}

const SELECT_SLOT: PortraitSlot = {
  file: SELECT_PORTRAIT,
  imgKey: 'selectPortrait',
  frameKey: 'selectFraming',
  title: 'Character Select portrait',
  pw: 120,
  ph: 120,
  fit: 'cover',
  hint: 'shown on the character-select screen (square). Drag to recenter; zoom, rotate (90°) and flip to '
    + 'frame it — the game applies the same transform. Stored as sprites/_select.png + framing in the '
    + 'bundle; persists on Save. Not a game sprite (never keyed or packed into the atlas).',
};

const VS_SLOT: PortraitSlot = {
  file: '_vs.png',
  imgKey: 'vsPortrait',
  frameKey: 'vsFraming',
  title: 'VS screen pose',
  pw: 105,
  ph: 140,
  fit: 'contain',
  hint: 'shown on the pre-fight VS card (tall). Pick a full-body fighting stance — "select from sprites" '
    + 'is usually best: it crops to the figure, so the pose fills the card. The game fits this inside a '
    + 'FIXED VS frame, so every character comes out the same size no matter how its art is proportioned, '
    + 'and nothing is clipped. Zoom pushes in (and may crop); drag to recenter. Leave it empty and the card '
    + 'falls back to the select portrait — safe, but sizes vary. Stored as sprites/_vs.png + framing.',
};

/** Which slot's "select from sprites" picker is expanded (null = none). */
let stPortraitPicker: PortraitSlot | null = null;

/**
 * Crop a canvas to its opaque alpha bounds plus a padding fraction. Sprite
 * frames sit feet-anchored in a mostly-empty cell, so using one directly as a
 * portrait would show a tiny figure adrift in space — this tightens it to the
 * figure. Returns null if fully transparent.
 */
const cropToAlpha = (c: HTMLCanvasElement, padFrac = 0.12): HTMLCanvasElement | null => {
  const d = c.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, c.width, c.height).data;
  let l = c.width, t = c.height, r = -1, b = -1;
  for (let y = 0; y < c.height; y++) {
    for (let x = 0; x < c.width; x++) {
      if (d[(y * c.width + x) * 4 + 3]! > 40) {
        if (x < l) l = x; if (x > r) r = x; if (y < t) t = y; if (y > b) b = y;
      }
    }
  }
  if (r < 0) return null;
  const w = r - l + 1, h = b - t + 1;
  const pad = Math.round(Math.max(w, h) * padFrac);
  const out = document.createElement('canvas');
  out.width = w + pad * 2;
  out.height = h + pad * 2;
  // Shift the whole source so the bbox top-left lands at (pad, pad); the
  // padding fills with the sprite's own (transparent) surrounding pixels.
  out.getContext('2d')!.drawImage(c, pad - l, pad - t);
  return out;
};

/** Set a slot's portrait from one of this character's existing sprite frames. */
const portraitFromSprite = async (slot: PortraitSlot, name: string): Promise<void> => {
  let c = spriteCanvas(name);
  for (let w = 0; w < 30 && !c; w++) {
    await new Promise((r) => setTimeout(r, 80));
    c = spriteCanvas(name);
  }
  if (!c) { stStatus = `sprite ${name} not loaded yet — try again`; renderAll(); return; }
  await savePortrait(slot, cropToAlpha(c) ?? c);
  stPortraitPicker = null;
  renderAll();
};

/**
 * Save a slot's portrait: capped to 1024px on the long edge (bounds file
 * size), written to sprites/<slot.file>, and recorded in meta so it persists
 * on Save and the game can find it. Unlike sprite frames it is NOT
 * keyed/cropped — a portrait is framed art, not a game sprite, and it never
 * enters the atlas (the packer only touches referenced steps).
 */
const savePortrait = async (slot: PortraitSlot, src: HTMLImageElement | HTMLCanvasElement): Promise<void> => {
  const iw = src instanceof HTMLCanvasElement ? src.width : src.naturalWidth;
  const ih = src instanceof HTMLCanvasElement ? src.height : src.naturalHeight;
  const s = Math.min(1, 1024 / Math.max(iw, ih));
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(iw * s));
  out.height = Math.max(1, Math.round(ih * s));
  const ctx = out.getContext('2d')!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, out.width, out.height);
  await saveSprite(slot.file, out);
  meta()[slot.imgKey] = slot.file;
  stDirty = true;
  stStatus = `${slot.title} saved (${out.width}×${out.height}) — Save to persist`;
  renderAll();
};

const uploadPortrait = async (slot: PortraitSlot, file: File): Promise<void> => {
  try {
    stStatus = `reading ${file.name}…`; renderAll();
    await savePortrait(slot, await fileToImage(file));
  } catch (e) {
    stStatus = `${slot.title} upload failed: ${(e as Error).message}`;
    renderAll();
  }
};

/** Convenience: reuse the locked reference sprite as the portrait. The PNG
 * streams in async (may be uncached if this tab opened straight to Character),
 * so wait for it like the reference-conditioned paths do before giving up. */
const portraitFromReference = async (slot: PortraitSlot): Promise<void> => {
  let ref = spriteCanvas('_reference.png');
  for (let w = 0; w < 30 && !ref; w++) {
    await new Promise((r) => setTimeout(r, 100));
    ref = spriteCanvas('_reference.png');
  }
  if (!ref) { stStatus = 'no reference sprite yet — generate/lock one first'; renderAll(); return; }
  await savePortrait(slot, ref);
};

/** Drop a slot's portrait (leaves the file on disk, just unreferenced). */
const removePortrait = (slot: PortraitSlot): void => {
  delete meta()[slot.imgKey];
  delete meta()[slot.frameKey];
  stDirty = true;
  stStatus = `${slot.title} removed — Save to persist`;
  renderAll();
};

/**
 * One portrait slot's editor (used for BOTH the select portrait and the VS
 * pose). Framing (zoom + recenter + 90° rotation + flip) is a non-destructive
 * transform stored in meta and applied identically by the game (see client
 * atlas.ts drawPortrait) — the preview is WYSIWYG at the slot's own aspect.
 */
const renderPortraitSlot = (slot: PortraitSlot): HTMLElement => {
  const b = stBundle!;
  const portrait = meta()[slot.imgKey];
  const { pw, ph } = slot;

  type Framing = { zoom: number; panX: number; panY: number; rotate: number; flipH: boolean };
  const getFraming = (): Framing => {
    const f = meta()[slot.frameKey];
    return { zoom: f?.zoom ?? 1, panX: f?.panX ?? 0, panY: f?.panY ?? 0, rotate: f?.rotate ?? 0, flipH: f?.flipH ?? false };
  };
  const setFraming = (f: Framing): void => { meta()[slot.frameKey] = f; stDirty = true; };
  const norm90 = (r: number): number => (((r % 360) + 360) % 360);
  const framedPreview = (): { el: HTMLCanvasElement; repaint: () => void } => {
    const cv = mkEl('canvas', { width: pw, height: ph, class: 'thumb', style: 'cursor:grab' });
    const cx = cv.getContext('2d')!;
    const dims = (img: HTMLCanvasElement | HTMLImageElement): [number, number] =>
      img instanceof HTMLCanvasElement ? [img.width, img.height] : [img.naturalWidth, img.naturalHeight];
    // On-screen scaled bbox for the current framing — accounts for a 90°/270°
    // rotation swapping width/height, so cover-fit still fills the frame.
    const bbox = (iw: number, ih: number, f: Framing): { scale: number; sw: number; sh: number } => {
      const swap = norm90(f.rotate) === 90 || norm90(f.rotate) === 270;
      const bw = swap ? ih : iw, bh = swap ? iw : ih;
      const fitScale = slot.fit === 'contain' ? Math.min(pw / bw, ph / bh) : Math.max(pw / bw, ph / bh);
      const scale = fitScale * Math.max(1, f.zoom);
      return { scale, sw: bw * scale, sh: bh * scale };
    };
    let tries = 0;
    const paint = (): void => {
      const img = getSprite(slot.file);
      cx.fillStyle = '#12141f'; cx.fillRect(0, 0, pw, ph);
      if (!img) { if (tries++ < 60) setTimeout(paint, 120); return; }
      const [iw, ih] = dims(img);
      const f = getFraming();
      const { scale, sw, sh } = bbox(iw, ih, f);
      const px = Math.max(-1, Math.min(1, f.panX)), py = Math.max(-1, Math.min(1, f.panY));
      cx.save(); cx.beginPath(); cx.rect(0, 0, pw, ph); cx.clip();
      cx.imageSmoothingEnabled = true; cx.imageSmoothingQuality = 'high';
      cx.translate(pw / 2 + px * (sw - pw) / 2, ph / 2 + py * (sh - ph) / 2);
      cx.rotate(norm90(f.rotate) * Math.PI / 180);
      if (f.flipH) cx.scale(-1, 1);
      cx.drawImage(img, -iw * scale / 2, -ih * scale / 2, iw * scale, ih * scale);
      cx.restore();
    };
    paint();
    // Drag to recenter: repaint in place during the drag (a renderAll would
    // rebuild the DOM and drop the drag), commit with renderAll on release.
    let drag: { x: number; y: number; panX: number; panY: number; availX: number; availY: number } | null = null;
    cv.onmousedown = (e) => {
      const img = getSprite(slot.file); if (!img) return;
      const [iw, ih] = dims(img);
      const { sw, sh } = bbox(iw, ih, getFraming());
      const f = getFraming();
      drag = { x: e.clientX, y: e.clientY, panX: f.panX, panY: f.panY, availX: sw - pw, availY: sh - ph };
      cv.style.cursor = 'grabbing'; e.preventDefault();
    };
    cv.onmousemove = (e) => {
      if (!drag) return;
      const nf = getFraming();
      if (drag.availX > 0) nf.panX = Math.max(-1, Math.min(1, drag.panX + 2 * (e.clientX - drag.x) / drag.availX));
      if (drag.availY > 0) nf.panY = Math.max(-1, Math.min(1, drag.panY + 2 * (e.clientY - drag.y) / drag.availY));
      setFraming(nf); paint();
    };
    cv.onmouseup = cv.onmouseleave = () => { if (drag) { drag = null; cv.style.cursor = 'grab'; renderAll(); } };
    return { el: cv, repaint: paint };
  };
  const previewCtl = portrait ? framedPreview() : null;
  const pickerOpen = stPortraitPicker === slot;

  return mkEl('div', {
    style: 'margin-bottom:14px;padding:10px 12px;background:#141724;border:1px solid #232840;'
      + 'border-radius:6px;max-width:1100px',
  },
    mkEl('b', {}, slot.title),
    mkEl('div', { style: 'display:flex;gap:14px;align-items:center;margin-top:8px' },
      previewCtl
        ? previewCtl.el
        : mkEl('div', { class: 'thumb empty', style: `width:${pw}px;height:${ph}px` }, 'none'),
      mkEl('div', { style: 'display:flex;flex-direction:column;gap:6px' },
        mkEl('label', { class: 'upload', title: `upload a ${slot.title} (photo or art) — saved as-is, not keyed` },
          '⬆ upload image',
          mkEl('input', {
            type: 'file', accept: 'image/*', style: 'display:none',
            onchange: (e: Event) => {
              const f = (e.target as HTMLInputElement).files?.[0];
              if (f) void uploadPortrait(slot, f);
              (e.target as HTMLInputElement).value = '';
            },
          })),
        mkEl('button', {
          title: 'use the locked reference sprite',
          onclick: () => void portraitFromReference(slot),
        }, 'use reference'),
        mkEl('button', {
          title: "pick from this character's already-generated sprites (cropped to the figure)",
          onclick: () => { stPortraitPicker = pickerOpen ? null : slot; renderAll(); },
        }, pickerOpen ? 'close sprite list' : 'select from sprites'),
        previewCtl ? mkEl('label', { style: 'display:flex;align-items:center;gap:6px' },
          'zoom',
          mkEl('input', {
            type: 'range', min: '1', max: '3', step: '0.05', value: String(getFraming().zoom),
            style: 'width:140px',
            oninput: (e: Event) => {
              setFraming({ ...getFraming(), zoom: Number((e.target as HTMLInputElement).value) });
              previewCtl.repaint();
            },
            onchange: () => renderAll(),
          })) : null,
        previewCtl ? mkEl('div', { style: 'display:flex;gap:6px' },
          mkEl('button', {
            title: 'rotate 90°',
            onclick: () => { const f = getFraming(); setFraming({ ...f, rotate: (f.rotate + 90) % 360 }); renderAll(); },
          }, `⟳ ${getFraming().rotate}°`),
          mkEl('button', {
            title: 'mirror horizontally',
            onclick: () => { const f = getFraming(); setFraming({ ...f, flipH: !f.flipH }); renderAll(); },
          }, getFraming().flipH ? '⇋ flip: on' : '⇋ flip'),
        ) : null,
        previewCtl ? mkEl('button', {
          title: 'reset zoom + recenter + rotation + flip',
          onclick: () => { delete meta()[slot.frameKey]; stDirty = true; renderAll(); },
        }, 'reset framing') : null,
        portrait ? mkEl('button', { onclick: () => removePortrait(slot) }, 'remove') : null,
      ),
    ),
    pickerOpen ? (() => {
      const names = [...new Set(
        b.moves.flatMap((mv) => mv.steps.map((s) => s.sprite)).filter((s): s is string => !!s))];
      return mkEl('div', { style: 'margin-top:10px' },
        mkEl('p', { class: 'hint' }, names.length
          ? `pick any of this character's ${names.length} sprites — it's cropped to the figure and set as the ${slot.title}`
          : 'no sprites generated yet — use the Generate tab first'),
        names.length ? mkEl('div', {
          style: 'display:flex;flex-wrap:wrap;gap:6px;max-height:320px;overflow:auto;padding:6px;'
            + 'background:#0e101a;border:1px solid #232840;border-radius:6px',
        },
          ...names.map((name) => mkEl('div', {
            title: `${name} — click to use`,
            style: 'cursor:pointer;display:flex;flex-direction:column;align-items:center;gap:2px',
            onclick: () => void portraitFromSprite(slot, name),
          },
            spriteThumbEl(name, 64),
            mkEl('span', { class: 'hint', style: 'font-size:9px;max-width:64px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' },
              name.replace(/\.png$/, '')),
          )),
        ) : null,
      );
    })() : null,
    mkEl('p', { class: 'hint', style: 'margin-top:8px' }, slot.hint),
  );
};

const renderCharacterTab = (): HTMLElement => {
  const b = stBundle!;
  const field = (label: string, get: () => number, set: (v: number) => void): HTMLElement =>
    mkEl('label', { class: 'field' }, label, numInput(get(), set, 70));

  const portraitSection = mkEl('div', {},
    renderPortraitSlot(SELECT_SLOT),
    renderPortraitSlot(VS_SLOT),
  );

  const grid = mkEl('div', { class: 'grid' },
    mkEl('label', { class: 'field' }, 'name', mkEl('input', {
      value: b.name,
      onchange: (e: Event) => { b.name = (e.target as HTMLInputElement).value; stDirty = true; },
    })),
    field('maxHealth', () => b.maxHealth, (v) => { b.maxHealth = v; }),
    field('walkFSpeed', () => b.walkFSpeed, (v) => { b.walkFSpeed = v; }),
    field('walkBSpeed', () => b.walkBSpeed, (v) => { b.walkBSpeed = v; }),
    field('dashFSpeed', () => b.dashFSpeed, (v) => { b.dashFSpeed = v; }),
    field('dashFTicks', () => b.dashFTicks, (v) => { b.dashFTicks = v; }),
    field('dashBSpeed', () => b.dashBSpeed, (v) => { b.dashBSpeed = v; }),
    field('dashBTicks', () => b.dashBTicks, (v) => { b.dashBTicks = v; }),
    field('jumpVelY', () => b.jumpVelY, (v) => { b.jumpVelY = v; }),
    field('superJumpVelY', () => b.superJumpVelY, (v) => { b.superJumpVelY = v; }),
    field('jumpVelX', () => b.jumpVelX, (v) => { b.jumpVelX = v; }),
    field('gravity', () => b.gravity, (v) => { b.gravity = v; }),
    mkEl('label', { class: 'field' }, 'doubleJump', mkEl('input', {
      type: 'checkbox', checked: b.doubleJump,
      onchange: (e: Event) => { b.doubleJump = (e.target as HTMLInputElement).checked; stDirty = true; },
    })),
    mkEl('label', { class: 'field' }, 'airDash', mkEl('input', {
      type: 'checkbox', checked: b.airDash,
      onchange: (e: Event) => { b.airDash = (e.target as HTMLInputElement).checked; stDirty = true; },
    })),
    field('airDashSpeed', () => b.airDashSpeed, (v) => { b.airDashSpeed = v; }),
    field('airDashTicks', () => b.airDashTicks, (v) => { b.airDashTicks = v; }),
    field('bodyWidth', () => b.bodyWidth, (v) => { b.bodyWidth = v; }),
    field('throwRange', () => b.throwRange, (v) => { b.throwRange = v; }),
    field('throwDamage', () => b.throwDamage, (v) => { b.throwDamage = v; }),
    field('throwTossVelX', () => b.throwTossVelX, (v) => { b.throwTossVelX = v; }),
    field('throwTossVelY', () => b.throwTossVelY, (v) => { b.throwTossVelY = v; }),
  );

  const disabled = !!meta().disabled;
  const disableRow = mkEl('div', {
    style: 'margin-bottom:12px;padding:8px 12px;border-radius:6px;max-width:1100px;display:flex;'
      + `align-items:center;gap:12px;background:${disabled ? '#3a1420' : '#141724'};`
      + `border:1px solid ${disabled ? '#c04a5a' : '#232840'}`,
  },
    mkEl('button', {
      title: 'toggle whether this character can be picked on the character-select screen',
      onclick: () => {
        const m = meta();
        if (m.disabled) delete m.disabled; else m.disabled = true;
        stDirty = true; renderAll();
      },
    }, disabled ? '✓ enable character' : '⛔ disable character'),
    mkEl('span', { class: 'hint' }, disabled
      ? 'DISABLED — greyed out and unselectable on the character-select screen (Save to apply).'
      : 'active — selectable on the character-select screen.'),
  );

  // FIGHTER INFO — the select screen's dossier panel (bio + quote), plus the
  // canonical archetype it reads for the FIGHTING STYLE chip. All of it lives
  // in `meta`, which bundle-hash.mjs strips before the sim pin, so editing it
  // can never bump versionHash or desync a match.
  //
  // `style` is READ-ONLY here on purpose: the match server derives an arcade
  // opponent's whole personality from it AND tools/apply-char-tuning.mjs
  // writes the matching per-fighter feel knobs at the same time. Editing it
  // here alone would change how a character PLAYS without changing how it
  // FEELS — run that tool instead.
  const m = meta();
  const loreRow = mkEl('div', {
    style: 'margin-bottom:14px;padding:10px 12px;background:#141724;border:1px solid #232840;'
      + 'border-radius:6px;max-width:1100px',
  },
    mkEl('h3', { style: 'margin:0 0 8px' }, 'fighter info (character select)'),
    mkEl('label', { class: 'field', style: 'display:block;margin-bottom:8px' }, 'bio',
      mkEl('textarea', {
        value: m.bio ?? '',
        rows: 2,
        placeholder: 'One or two sentences on who this fighter is.',
        style: 'width:760px;display:block',
        onchange: (e: Event) => {
          const v = (e.target as HTMLTextAreaElement).value.trim();
          if (v) meta().bio = v; else delete meta().bio;
          stDirty = true;
        },
      })),
    mkEl('label', { class: 'field', style: 'display:block;margin-bottom:8px' }, 'quote',
      mkEl('input', {
        value: m.quote ?? '',
        placeholder: 'What they say before the bell.',
        style: 'width:760px',
        onchange: (e: Event) => {
          const v = (e.target as HTMLInputElement).value.trim();
          if (v) meta().quote = v; else delete meta().quote;
          stDirty = true;
        },
      })),
    mkEl('span', { class: 'hint' },
      `fighting style: ${m.style ?? '(unset)'} — set by tools/apply-char-tuning.mjs, `
      + 'which writes the AI personality and the matching feel knobs together.'),
  );

  return mkEl('div', { class: 'pane' }, disableRow, portraitSection, loreRow, grid);
};

// ------------------------------------------------------------------ frames tab
const FR_SC = 2.2;
const FR_CX = 260;
const FR_CY = 430;
let frDrag: { mode: 'move' | 'resize'; startX: number; startY: number; orig: Rect } | null = null;
let frSpriteDrag: { startY: number } | null = null;
let frSpriteScale = 1; // live preview scale while dragging the sprite handle

/** Alpha bbox of the current step's sprite, in cell coords (null = none). */
const frSpriteBBox = (): { l: number; t: number; r: number; b: number } | null => {
  const stp = curStep();
  if (!stp?.sprite) return null;
  const c = spriteCanvas(stp.sprite);
  if (!c) return null;
  const d = c.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, c.width, c.height).data;
  let l = c.width, t = c.height, r = -1, b = -1;
  for (let y = 0; y < c.height; y++) {
    for (let x = 0; x < c.width; x++) {
      if (d[(y * c.width + x) * 4 + 3]! > 40) {
        if (x < l) l = x;
        if (x > r) r = x;
        if (y < t) t = y;
        if (y > b) b = y;
      }
    }
  }
  return r < 0 ? null : { l, t, r, b };
};

/** Bake a uniform scale (around the feet pivot) into the sprite PNG. */
const bakeSpriteScale = async (name: string, s: number): Promise<void> => {
  const c = spriteCanvas(name);
  if (!c || s === 1) return;
  const out = document.createElement('canvas');
  out.width = CELL_W;
  out.height = CELL_W;
  const ctx = out.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(c, PIVOT_X * (1 - s), PIVOT_Y * (1 - s), CELL_W * s, CELL_W * s);
  await saveSprite(name, out);
  stDirty = true; // atlas repacks on save
};

/** Flip EVERY sprite of the character (default orientation fix), incl. the
 * reference sheet + its facing mask so future generation stays consistent. */
const flipAllSprites = async (): Promise<void> => {
  if (stGenBusy || !stBundle) return;
  stGenBusy = true;
  const names = [...new Set(
    stBundle.moves.flatMap((mv) => mv.steps.map((sp) => sp.sprite)).filter((sp): sp is string => !!sp))];
  names.push('_reference.png');
  let done = 0;
  try {
    for (const name of names) {
      stStatus = `flipping ${++done}/${names.length}…`; renderAll();
      let c = spriteCanvas(name);
      for (let w = 0; w < 30 && !c; w++) {
        await new Promise((r) => setTimeout(r, 100));
        c = spriteCanvas(name);
      }
      if (!c) continue;
      await saveSprite(name, flipCanvasH(c));
    }
    const m = meta();
    if (m.refMask) m.refMask = mirrorMask16(m.refMask);
    stDirty = true;
    stStatus = `flipped ${done} sprites — default orientation reversed. SAVE to repack the atlas.`;
  } catch (e) {
    stStatus = `flip all failed: ${(e as Error).message}`;
  }
  stGenBusy = false;
  renderAll();
};

const selRect = (): Rect | null => {
  if (!stSel) return null;
  const stp = curStep();
  if (!stp) return null;
  return stSel.list === 'hurt'
    ? stp.hurtboxes[stSel.i] ?? null
    : stp.hitboxes?.[stSel.i]?.rect ?? null;
};

const curMove = (): MoveDef | null => stBundle?.moves[stMoveIdx] ?? null;
const curStep = (): MoveStep | null => curMove()?.steps[stStepIdx] ?? null;

const frToScreen = (r: Rect): { x: number; y: number; w: number; h: number } => ({
  x: FR_CX + r.x * FR_SC, y: FR_CY + r.y * FR_SC, w: r.w * FR_SC, h: r.h * FR_SC,
});

const frPaint = (cv: HTMLCanvasElement): void => {
  const ctx = cv.getContext('2d')!;
  ctx.fillStyle = '#181a28';
  ctx.fillRect(0, 0, cv.width, cv.height);
  // Floor + pivot.
  ctx.strokeStyle = '#3d4260';
  ctx.beginPath(); ctx.moveTo(0, FR_CY + 0.5); ctx.lineTo(cv.width, FR_CY + 0.5); ctx.stroke();
  ctx.strokeStyle = '#6b7280';
  ctx.beginPath(); ctx.moveTo(FR_CX - 8, FR_CY); ctx.lineTo(FR_CX + 8, FR_CY); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(FR_CX, FR_CY - 8); ctx.lineTo(FR_CX, FR_CY + 8); ctx.stroke();

  const stp = curStep();
  if (!stp) return;

  // Sprite (or body silhouette). frSpriteScale previews a pending resize.
  // Boxes are drawn in WORLD px × FR_SC, so the sprite must be scaled from
  // supersampled sprite px into world px too — otherwise the art appears twice
  // the size of the hitboxes it is supposed to describe.
  if (stp.sprite) {
    const spr = getSprite(stp.sprite);
    if (spr) {
      const s = frSpriteScale * SPRITE_SCALE; // sprite px → world px (× pending resize)
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(spr, FR_CX - PIVOT_X * FR_SC * s, FR_CY - PIVOT_Y * FR_SC * s,
        CELL_W * FR_SC * s, CELL_W * FR_SC * s);
      // Sprite bounds + scale handle (top-forward corner). Drag = uniform
      // scale around the feet pivot.
      const bb = frSpriteBBox();
      if (bb) {
        const sx = FR_CX + (bb.l - PIVOT_X) * FR_SC * s;
        const sy = FR_CY + (bb.t - PIVOT_Y) * FR_SC * s;
        const sw = (bb.r - bb.l + 1) * FR_SC * s;
        const sh = (bb.b - bb.t + 1) * FR_SC * s;
        ctx.setLineDash([3, 5]);
        ctx.strokeStyle = '#ffd16655';
        ctx.strokeRect(sx + 0.5, sy + 0.5, sw, sh);
        ctx.setLineDash([]);
        ctx.fillStyle = '#ffd166';
        ctx.fillRect(sx + sw - 5, sy - 5, 11, 11);
        ctx.strokeStyle = '#000';
        ctx.strokeRect(sx + sw - 5 + 0.5, sy - 5 + 0.5, 10, 10);
      }
    }
  } else {
    ctx.fillStyle = '#2c3050';
    const bw = stBundle!.bodyWidth;
    ctx.fillRect(FR_CX - (bw / 2) * FR_SC, FR_CY - 108 * FR_SC, bw * FR_SC, 108 * FR_SC);
  }

  // Onion skin: previous step boxes.
  if (stOnion && stStepIdx > 0) {
    const prev = curMove()!.steps[stStepIdx - 1]!;
    ctx.setLineDash([4, 4]);
    ctx.globalAlpha = 0.35;
    ctx.strokeStyle = '#4ade80';
    for (const r of prev.hurtboxes) { const s = frToScreen(r); ctx.strokeRect(s.x, s.y, s.w, s.h); }
    ctx.strokeStyle = '#f87171';
    for (const hb of prev.hitboxes ?? []) { const s = frToScreen(hb.rect); ctx.strokeRect(s.x, s.y, s.w, s.h); }
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  // Current boxes.
  stp.hurtboxes.forEach((r, i) => {
    const s = frToScreen(r);
    const seld = stSel?.list === 'hurt' && stSel.i === i;
    ctx.lineWidth = seld ? 2.5 : 1;
    ctx.strokeStyle = '#4ade80';
    ctx.strokeRect(s.x + 0.5, s.y + 0.5, s.w, s.h);
  });
  (stp.hitboxes ?? []).forEach((hb, i) => {
    const s = frToScreen(hb.rect);
    const seld = stSel?.list === 'hit' && stSel.i === i;
    ctx.lineWidth = seld ? 2.5 : 1;
    ctx.strokeStyle = '#f87171';
    ctx.strokeRect(s.x + 0.5, s.y + 0.5, s.w, s.h);
    ctx.fillStyle = '#f8717122';
    ctx.fillRect(s.x, s.y, s.w, s.h);
  });
  ctx.lineWidth = 1;
  // Resize handle on selection.
  const sr = selRect();
  if (sr) {
    const s = frToScreen(sr);
    ctx.fillStyle = '#ffd166';
    ctx.fillRect(s.x + s.w - 5, s.y + s.h - 5, 10, 10);
  }
};

const frMouse = (cv: HTMLCanvasElement): void => {
  const toChar = (e: MouseEvent): { x: number; y: number } => {
    const r = cv.getBoundingClientRect();
    return { x: (e.clientX - r.left - FR_CX) / FR_SC, y: (e.clientY - r.top - FR_CY) / FR_SC };
  };
  cv.onmousedown = (e) => {
    const p = toChar(e);
    const stp = curStep();
    if (!stp) return;
    // Sprite scale handle takes priority (top-forward corner of sprite bounds).
    // `p` is in world px, the bbox in sprite px — convert, matching frPaint.
    const bb = frSpriteBBox();
    if (bb && stp.sprite) {
      const hs = frSpriteScale * SPRITE_SCALE;
      const hx = (bb.r + 1 - PIVOT_X) * hs;
      const hy = (bb.t - PIVOT_Y) * hs;
      if (Math.abs(p.x - hx) < 8 && Math.abs(p.y - hy) < 8) {
        const r = cv.getBoundingClientRect();
        frSpriteDrag = { startY: e.clientY - r.top };
        return;
      }
    }
    const sr = selRect();
    // Resize handle?
    if (sr && Math.abs(p.x - (sr.x + sr.w)) < 6 / FR_SC * 3 && Math.abs(p.y - (sr.y + sr.h)) < 6 / FR_SC * 3) {
      frDrag = { mode: 'resize', startX: p.x, startY: p.y, orig: { ...sr } };
      return;
    }
    // Select (hitboxes take priority), else move current.
    const hitAt = (r: Rect): boolean => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
    let found: typeof stSel = null;
    (stp.hitboxes ?? []).forEach((hb, i) => { if (!found && hitAt(hb.rect)) found = { list: 'hit', i }; });
    if (!found) stp.hurtboxes.forEach((r, i) => { if (!found && hitAt(r)) found = { list: 'hurt', i }; });
    stSel = found;
    const nr = selRect();
    if (nr) frDrag = { mode: 'move', startX: p.x, startY: p.y, orig: { ...nr } };
    renderAll();
  };
  cv.onmousemove = (e) => {
    if (frSpriteDrag) {
      // Uniform scale around the pivot: ratio of distances above the feet.
      const rc = cv.getBoundingClientRect();
      const my = e.clientY - rc.top;
      const denom = FR_CY - frSpriteDrag.startY;
      if (denom > 8) {
        frSpriteScale = Math.max(0.3, Math.min(2.5, (FR_CY - my) / denom));
        frPaint(cv);
      }
      return;
    }
    if (!frDrag) return;
    const p = toChar(e);
    const r = selRect();
    if (!r) return;
    const dx = Math.round(p.x - frDrag.startX);
    const dy = Math.round(p.y - frDrag.startY);
    if (frDrag.mode === 'move') {
      r.x = frDrag.orig.x + dx;
      r.y = frDrag.orig.y + dy;
    } else {
      r.w = Math.max(4, frDrag.orig.w + dx);
      r.h = Math.max(4, frDrag.orig.h + dy);
    }
    stDirty = true;
    frPaint(cv);
  };
  cv.onmouseup = () => {
    if (frSpriteDrag) {
      const stp = curStep();
      const s = frSpriteScale;
      frSpriteDrag = null;
      frSpriteScale = 1;
      if (stp?.sprite && Math.abs(s - 1) > 0.02) {
        void bakeSpriteScale(stp.sprite, s).then(() => {
          stStatus = `sprite scaled ×${s.toFixed(2)} (baked)`;
          renderAll();
        });
      } else renderAll();
      return;
    }
    if (frDrag) { frDrag = null; renderAll(); }
  };
  cv.onmouseleave = cv.onmouseup;
};

const hitboxTemplate = (): HitboxDef => ({
  rect: { x: 20, y: -90, w: 50, h: 30 },
  damage: 500, chip: 0, hitstun: 16, blockstun: 12, hitstopFrames: 6,
  pushbackHit: 5, pushbackBlock: 6, guard: 'mid', juggleCost: 1,
});

const renderFramesTab = (): HTMLElement => {
  const b = stBundle!;
  const mv = curMove();
  const stp = curStep();

  // Step timeline strip.
  const timeline = mkEl('div', { class: 'steplist' },
    ...(mv?.steps.map((s, i) => mkEl('button', {
      class: `stepbtn ${s.phase} ${i === stStepIdx ? 'cur' : ''}`,
      onclick: () => { stStepIdx = i; stSel = null; renderAll(); },
    }, `${i}·${s.phase.slice(0, 3)}·${s.frames}f${s.sprite ? '·🖼' : ''}`)) ?? []),
    mkEl('button', {
      class: 'stepbtn add',
      onclick: () => {
        if (!mv) return;
        mv.steps.splice(stStepIdx + 1, 0, structuredClone(mv.steps[stStepIdx] ?? {
          frames: 4, phase: 'startup', hurtboxes: [{ ...b.standHurtbox }],
        }) as MoveStep);
        stStepIdx++;
        stDirty = true;
        renderAll();
      },
    }, '+step'),
  );

  const cv = mkEl('canvas', { width: 520, height: 470, class: 'frcanvas' });
  requestAnimationFrame(() => { frPaint(cv); });
  frMouse(cv);
  // Sprites may stream in async — repaint while tab visible.
  const repaint = (): void => { if (document.body.contains(cv)) { frPaint(cv); setTimeout(repaint, 250); } };
  setTimeout(repaint, 250);

  // Step properties.
  const stepProps = stp ? mkEl('div', { class: 'props' },
    mkEl('b', {}, `step ${stStepIdx}`),
    mkEl('label', { class: 'field' }, 'frames', numInput(stp.frames, (v) => { stp.frames = Math.max(1, Math.round(v)); })),
    mkEl('label', { class: 'field' }, 'phase', selInput(stp.phase, ['startup', 'active', 'recovery'], (v) => { stp.phase = v as MoveStep['phase']; })),
    mkEl('label', { class: 'field' }, 'velX', numInput(stp.velX ?? 0, (v) => { if (v === 0) delete stp.velX; else stp.velX = v; })),
    mkEl('label', { class: 'field' }, 'velY', numInput(stp.velY ?? 0, (v) => { if (v === 0) delete stp.velY; else stp.velY = v; })),
    mkEl('label', { class: 'field' }, 'sprite', mkEl('input', {
      value: stp.sprite ?? '', style: 'width:130px',
      onchange: (e: Event) => {
        const v = (e.target as HTMLInputElement).value.trim();
        if (v) stp.sprite = v; else delete stp.sprite;
        stDirty = true;
      },
    })),
    mkEl('button', {
      onclick: () => {
        stp.hurtboxes.push({ x: -26, y: -108, w: 52, h: 108 });
        stSel = { list: 'hurt', i: stp.hurtboxes.length - 1 };
        stDirty = true; renderAll();
      },
    }, '+hurtbox'),
    mkEl('button', {
      onclick: () => {
        (stp.hitboxes ??= []).push(hitboxTemplate());
        stSel = { list: 'hit', i: stp.hitboxes.length - 1 };
        stDirty = true; renderAll();
      },
    }, '+hitbox'),
    mkEl('button', {
      onclick: () => {
        if (!stSel) return;
        if (stSel.list === 'hurt') stp.hurtboxes.splice(stSel.i, 1);
        else { stp.hitboxes?.splice(stSel.i, 1); if (stp.hitboxes?.length === 0) delete stp.hitboxes; }
        stSel = null; stDirty = true; renderAll();
      },
    }, 'del box'),
    mkEl('button', {
      onclick: () => {
        if (!mv || mv.steps.length <= 1) return;
        mv.steps.splice(stStepIdx, 1);
        stStepIdx = Math.max(0, stStepIdx - 1);
        stSel = null; stDirty = true; renderAll();
      },
    }, 'del step'),
    mkEl('label', { class: 'field' }, 'onion', mkEl('input', {
      type: 'checkbox', checked: stOnion,
      onchange: (e: Event) => { stOnion = (e.target as HTMLInputElement).checked; renderAll(); },
    })),
    mkEl('label', { class: 'field', title: 'uniform scale around the feet pivot, baked into the PNG — or drag the gold corner handle on the canvas' },
      'sprite scale %',
      numInput(100, (v) => {
        if (!stp.sprite || v === 100 || v < 20 || v > 300) return;
        void bakeSpriteScale(stp.sprite, v / 100).then(() => {
          stStatus = `sprite scaled ×${(v / 100).toFixed(2)} (baked)`;
          renderAll();
        });
      })),
    mkEl('button', {
      title: 'mirror the sprite horizontally (fixes wrong facing)',
      onclick: () => {
        if (!stp.sprite) { stStatus = 'no sprite on this step'; renderAll(); return; }
        const c = spriteCanvas(stp.sprite);
        if (!c) { stStatus = 'sprite not loaded yet — try again'; renderAll(); return; }
        const flipped = flipCanvasH(c);
        void saveSprite(stp.sprite, flipped).then(() => {
          stDirty = true; // atlas repacks on save
          stStatus = `flipped ${stp.sprite}`;
          renderAll();
        });
      },
    }, '↔ flip sprite'),
    mkEl('button', {
      title: 'hurtbox draft from sprite alpha (head/torso/legs bands)',
      onclick: () => {
        if (!stp.sprite) { stStatus = 'no sprite on this step'; renderAll(); return; }
        const spr = spriteCanvas(stp.sprite);
        if (!spr) { stStatus = 'sprite not loaded yet — try again in a moment'; renderAll(); return; }
        const boxes = autoHurtboxes(spr);
        if (boxes.length) { stp.hurtboxes = boxes; stDirty = true; stStatus = `drafted ${boxes.length} hurtboxes`; }
        renderAll();
      },
    }, 'auto-hurtbox'),
    mkEl('button', {
      title: 'hitbox draft from diff vs previous step sprite',
      onclick: () => {
        const prev = curMove()?.steps[stStepIdx - 1];
        const a = prev?.sprite ? spriteCanvas(prev.sprite) : null;
        const bSpr = stp.sprite ? spriteCanvas(stp.sprite) : null;
        if (!a || !bSpr) {
          stStatus = 'need loaded sprites on this + previous step'; renderAll(); return;
        }
        const draft = diffHitboxDraft(a, bSpr);
        if (draft) {
          (stp.hitboxes ??= []).push({ ...hitboxTemplate(), rect: draft });
          stSel = { list: 'hit', i: stp.hitboxes.length - 1 };
          stDirty = true; stStatus = 'hitbox drafted from sprite diff';
        } else stStatus = 'no significant diff region found';
        renderAll();
      },
    }, 'auto-hitbox'),
  ) : mkEl('div');

  // Selected hitbox full property editor.
  let hbProps: HTMLElement | null = null;
  if (stSel?.list === 'hit' && stp?.hitboxes?.[stSel.i]) {
    const hb = stp.hitboxes[stSel.i]!;
    const f = (label: string, get: () => number, set: (v: number) => void): HTMLElement =>
      mkEl('label', { class: 'field' }, label, numInput(get(), set));
    hbProps = mkEl('div', { class: 'props hbprops' },
      mkEl('b', {}, 'hitbox'),
      f('damage', () => hb.damage, (v) => { hb.damage = v; }),
      f('chip', () => hb.chip, (v) => { hb.chip = v; }),
      f('hitstun', () => hb.hitstun, (v) => { hb.hitstun = v; }),
      f('blockstun', () => hb.blockstun, (v) => { hb.blockstun = v; }),
      f('hitstop', () => hb.hitstopFrames, (v) => { hb.hitstopFrames = v; }),
      f('pushHit', () => hb.pushbackHit, (v) => { hb.pushbackHit = v; }),
      f('pushBlock', () => hb.pushbackBlock, (v) => { hb.pushbackBlock = v; }),
      f('juggleCost', () => hb.juggleCost, (v) => { hb.juggleCost = v; }),
      mkEl('label', { class: 'field' }, 'guard', selInput(hb.guard, ['mid', 'low', 'overhead', 'unblockable'], (v) => { hb.guard = v as HitboxDef['guard']; })),
      mkEl('label', { class: 'field' }, 'launcher', mkEl('input', {
        type: 'checkbox', checked: !!hb.launcher,
        onchange: (e: Event) => { hb.launcher = (e.target as HTMLInputElement).checked || undefined; stDirty = true; },
      })),
      f('launchVelY', () => hb.launchVelY ?? -16, (v) => { hb.launchVelY = v; }),
      mkEl('label', { class: 'field' }, 'knockdown', mkEl('input', {
        type: 'checkbox', checked: !!hb.knockdown,
        onchange: (e: Event) => { hb.knockdown = (e.target as HTMLInputElement).checked || undefined; stDirty = true; },
      })),
      f('airPopVelY', () => hb.airPopVelY ?? -7, (v) => { hb.airPopVelY = v; }),
    );
  }

  return mkEl('div', { class: 'pane' },
    mkEl('div', { class: 'row' },
      mkEl('label', {}, 'move ',
        selInput(mv?.id ?? '', b.moves.map((m) => m.id), (id) => {
          stMoveIdx = b.moves.findIndex((m) => m.id === id);
          stStepIdx = 0; stSel = null;
        })),
      mkEl('span', { class: 'hint' },
        mv ? `${mv.type} · ${mv.stance} · total ${mv.steps.reduce((n, s) => n + s.frames, 0)}f` : ''),
      mkEl('button', {
        disabled: stGenBusy ? '' : null,
        title: 'mirror EVERY sprite of this character (incl. reference) — fixes wrong default orientation',
        onclick: () => askConfirm(
          `Flip ALL of ${b.name}'s sprites horizontally? Use when the whole character faces the wrong way.`,
          () => { void flipAllSprites(); }),
      }, stGenBusy ? '…' : '↔ flip ALL sprites'),
    ),
    timeline,
    mkEl('div', { class: 'row' }, cv, mkEl('div', {}, stepProps, hbProps)),
  );
};

// ------------------------------------------------------------------ moves tab
const renderMovesTab = (): HTMLElement => {
  const b = stBundle!;
  const rows = b.moves.map((mv, i) => {
    const startup = ((): number => {
      let n = 0;
      for (const s of mv.steps) { if (s.phase === 'active') return n; n += s.frames; }
      return n;
    })();
    const firstHb = mv.steps.find((s) => s.hitboxes?.length)?.hitboxes?.[0];
    return mkEl('tr', {},
      mkEl('td', {}, mkEl('input', {
        value: mv.id, style: 'width:64px',
        onchange: (e: Event) => {
          const nid = (e.target as HTMLInputElement).value.trim();
          if (!nid || b.moves.some((m, k) => k !== i && m.id === nid)) return;
          for (const edge of b.cancels) {
            if (edge.from === mv.id) edge.from = nid;
            edge.to = edge.to.map((t) => (t === mv.id ? nid : t));
          }
          mv.id = nid; stDirty = true; renderAll();
        },
      })),
      mkEl('td', {}, selInput(mv.type, ['normal', 'special', 'super', 'system'], (v) => { mv.type = v as MoveDef['type']; })),
      mkEl('td', {}, selInput(mv.stance, ['stand', 'crouch', 'air'], (v) => { mv.stance = v as MoveDef['stance']; })),
      mkEl('td', {}, selInput(mv.button ?? '', ['', 'LP', 'MP', 'HP', 'LK', 'MK', 'HK'], (v) => { if (v) mv.button = v as MoveDef['button']; else delete mv.button; })),
      mkEl('td', {}, selInput(String(mv.motion ?? ''), ['', '236', '214', '623'], (v) => { if (v) mv.motion = Number(v) as MoveDef['motion']; else delete mv.motion; })),
      mkEl('td', {}, selInput(mv.buttons ?? '', ['', 'P', 'K', 'PP'], (v) => { if (v) mv.buttons = v as MoveDef['buttons']; else delete mv.buttons; })),
      mkEl('td', { class: 'num' }, String(startup)),
      mkEl('td', { class: 'num' }, String(mv.steps.reduce((n, s) => n + s.frames, 0))),
      mkEl('td', {}, firstHb ? numInput(firstHb.damage, (v) => { firstHb.damage = v; }) : '—'),
      mkEl('td', {}, firstHb ? numInput(firstHb.hitstun, (v) => { firstHb.hitstun = v; }, 44) : '—'),
      mkEl('td', {}, firstHb ? numInput(firstHb.blockstun, (v) => { firstHb.blockstun = v; }, 44) : '—'),
      mkEl('td', {}, numInput(mv.meterGainWhiff, (v) => { mv.meterGainWhiff = v; }, 44)),
      mkEl('td', {}, numInput(mv.meterGainHit, (v) => { mv.meterGainHit = v; }, 44)),
      mkEl('td', {}, mv.type === 'super' ? numInput(mv.meterCost ?? 1000, (v) => { mv.meterCost = v; }, 54) : '—'),
      mkEl('td', {},
        mkEl('button', {
          onclick: () => { stMoveIdx = i; stStepIdx = 0; stTab = 'frames'; renderAll(); },
        }, 'frames'),
        mkEl('button', {
          onclick: () => {
            const copy = structuredClone(mv);
            copy.id = `${mv.id}~copy`;
            b.moves.splice(i + 1, 0, copy);
            stDirty = true; renderAll();
          },
        }, 'dup'),
        mkEl('button', {
          onclick: () => {
            askConfirm(`Delete move "${mv.id}"? Its cancel-graph edges go too.`, () => {
              b.moves.splice(i, 1);
              const gone = mv.id;
              b.cancels = b.cancels
                .filter((edge) => edge.from !== gone)
                .map((edge) => ({ ...edge, to: edge.to.filter((t) => t !== gone) }))
                .filter((edge) => edge.to.length > 0);
              stMoveIdx = 0;
              stDirty = true;
            });
          },
        }, 'del'),
      ),
    );
  });
  return mkEl('div', { class: 'pane' },
    mkEl('table', { class: 'movetable' },
      mkEl('tr', {}, ...['id', 'type', 'stance', 'btn', 'motion', 'btns', 'startup', 'total', 'dmg', 'hitstun', 'blkstun', 'mWhiff', 'mHit', 'cost', ''].map((h) => mkEl('th', {}, h))),
      ...rows),
    mkEl('button', {
      onclick: () => {
        stBundle!.moves.push({
          id: `new${stBundle!.moves.length}`, type: 'normal', stance: 'stand', button: 'LP',
          steps: [
            { frames: 4, phase: 'startup', hurtboxes: [{ ...stBundle!.standHurtbox }] },
            { frames: 3, phase: 'active', hurtboxes: [{ ...stBundle!.standHurtbox }], hitboxes: [hitboxTemplate()] },
            { frames: 8, phase: 'recovery', hurtboxes: [{ ...stBundle!.standHurtbox }] },
          ],
          meterGainWhiff: 5, meterGainHit: 40,
        });
        stDirty = true; renderAll();
      },
    }, '+ move'),
  );
};

// ------------------------------------------------------------------ cancels tab
type CancelState = '' | 'H' | 'HB' | 'B';

const cancelStateOf = (from: string, to: string): CancelState => {
  let hit = false, block = false;
  for (const e of stBundle!.cancels) {
    if (e.from === from && e.to.includes(to)) {
      if (e.on.includes('hit')) hit = true;
      if (e.on.includes('block')) block = true;
    }
  }
  return hit && block ? 'HB' : hit ? 'H' : block ? 'B' : '';
};

const setCancelState = (from: string, to: string, cs: CancelState): void => {
  const b = stBundle!;
  // Remove `to` from all edges with this `from`, dropping empty edges.
  b.cancels = b.cancels
    .map((e) => (e.from === from ? { ...e, to: e.to.filter((t) => t !== to) } : e))
    .filter((e) => e.to.length > 0);
  if (cs === '') return;
  const on: ('hit' | 'block')[] = cs === 'H' ? ['hit'] : cs === 'B' ? ['block'] : ['hit', 'block'];
  // Merge into an existing edge with identical `on`, else append.
  const home = b.cancels.find((e) => e.from === from
    && e.on.length === on.length && on.every((o) => e.on.includes(o)));
  if (home) home.to.push(to);
  else b.cancels.push({ from, to: [to], on });
};

const renderCancelsTab = (): HTMLElement => {
  const b = stBundle!;
  const ids = b.moves.map((m) => m.id);
  const cycle: Record<CancelState, CancelState> = { '': 'H', H: 'HB', HB: 'B', B: '' };
  return mkEl('div', { class: 'pane scrollx' },
    mkEl('p', { class: 'hint' }, 'rows cancel INTO columns · click cycles: — → hit → hit+block → block'),
    mkEl('table', { class: 'canceltable' },
      mkEl('tr', {}, mkEl('th', {}, 'from \\ to'), ...ids.map((id) => mkEl('th', { class: 'rot' }, id))),
      ...ids.map((from) => mkEl('tr', {},
        mkEl('th', {}, from),
        ...ids.map((to) => {
          const cs = cancelStateOf(from, to);
          return mkEl('td', {
            class: `cc ${cs}`,
            onclick: () => { setCancelState(from, to, cycle[cs]); stDirty = true; renderAll(); },
          }, cs || '·');
        }),
      )),
    ),
  );
};

// ------------------------------------------------------------------ test tab
const keysDown = new Set<string>();
addEventListener('keydown', (e) => {
  keysDown.add(e.code);
  if (stTab === 'test' && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space'].includes(e.code)) e.preventDefault();
});
addEventListener('keyup', (e) => keysDown.delete(e.code));

const P1_KEYMAP: [string, number][] = [
  ['KeyA', Btn.Left], ['KeyD', Btn.Right], ['KeyW', Btn.Up], ['KeyS', Btn.Down],
  ['KeyT', Btn.LP], ['KeyY', Btn.MP], ['KeyU', Btn.HP],
  ['KeyG', Btn.LK], ['KeyH', Btn.MK], ['KeyJ', Btn.HK],
];

type DummyMode = 'idle' | 'block' | 'crouch' | 'jump' | 'mash';
let stDummy: DummyMode = 'idle';
let stGame: GameState | null = null;
let stShowBoxes = true;
let stP2Id = ''; // '' = mirror match vs the edited character
let stP2Bundle: CharacterBundle | null = null;

const selectP2 = async (id: string): Promise<void> => {
  stP2Id = id;
  stP2Bundle = id ? await apiJson<CharacterBundle>(`/api/characters/${id}`) : null;
  renderAll();
};

const dummyInput = (g: GameState): InputFrame => {
  const me = g.fighters[1], op = g.fighters[0];
  const away = op.x > me.x ? Btn.Left : Btn.Right;
  switch (stDummy) {
    case 'idle': return 0;
    case 'block': return away | Btn.Down;
    case 'crouch': return Btn.Down;
    case 'jump': return g.tick % 90 < 40 ? Btn.Up : 0;
    case 'mash': return (g.tick % 14 < 2 ? Btn.LP : 0) | (g.tick % 120 < 40 ? (op.x > me.x ? Btn.Right : Btn.Left) : 0);
  }
};

const applyBundleToSim = (): string | null => {
  try {
    const lc = loadCharacter(structuredClone(stBundle!));
    const lc2 = stP2Bundle ? loadCharacter(structuredClone(stP2Bundle)) : lc;
    setCharacters(lc, lc2);
    // Reflect the edited stage's view lock so fighters stop at the new walls.
    stGame = createGameState(stSeed++, stStageMeta?.bounds);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
};

const testPaint = (cv: HTMLCanvasElement): void => {
  const g = stGame;
  const ctx = cv.getContext('2d')!;
  ctx.fillStyle = '#141625';
  ctx.fillRect(0, 0, cv.width, cv.height);
  if (!g) return;
  const camL = Math.max(0, Math.min(STAGE.widthPx - cv.width,
    (Math.trunc(g.fighters[0].x / 256) + Math.trunc(g.fighters[1].x / 256)) / 2 - cv.width / 2));
  const wx = (v: number): number => v - camL;
  ctx.fillStyle = '#2b2f45';
  ctx.fillRect(0, STAGE.floorYPx, cv.width, cv.height - STAGE.floorYPx);

  for (const i of [0, 1] as const) {
    const f = g.fighters[i];
    const x = wx(Math.trunc(f.x / 256));
    const y = Math.trunc(f.y / 256);
    // Every state resolves through the animation table; rect is the fallback.
    let drew = false;
    const sprName = spriteForFighter(f, characters[i], g.tick);
    if (sprName) {
      const spr = getSprite(sprName, i === 1 && stP2Id ? stP2Id : stCharId);
      if (spr) {
        ctx.save();
        ctx.translate(x, y);
        ctx.scale(f.facing, 1);
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        // Hit flash: brighten the sprite during hitstun.
        if ((f.action === Action.Hitstun || f.action === Action.AirHitstun) && g.tick % 4 < 2) {
          ctx.filter = 'brightness(2.5)';
        }
        // Sprites are supersampled; the sim is in WORLD px. Scale down to
        // world size or the fighter renders bigger than its own hitboxes.
        ctx.drawImage(spr,
          -PIVOT_X * SPRITE_SCALE, -PIVOT_Y * SPRITE_SCALE,
          CELL_W * SPRITE_SCALE, CELL_W * SPRITE_SCALE);
        ctx.restore();
        drew = true;
      }
    }
    if (!drew) {
      const crouched = f.action === Action.Crouch || f.action === Action.BlockCrouch;
      const lying = f.action === Action.Knockdown || f.action === Action.Getup || f.action === Action.KO;
      const h = lying ? 30 : crouched ? 80 : 108;
      ctx.fillStyle = i === 0 ? '#e94560' : '#4ea8de';
      if (f.action === Action.Hitstun || f.action === Action.AirHitstun) ctx.fillStyle = '#fff';
      ctx.fillRect(x - 26, y - h, 52, h);
    }
  }
  for (const p of g.projectiles) {
    if (!p.active) continue;
    ctx.fillStyle = '#ffd166';
    ctx.beginPath();
    ctx.arc(wx(Math.trunc(p.x / 256)), Math.trunc(p.y / 256), 12, 0, Math.PI * 2);
    ctx.fill();
  }
  if (stShowBoxes) {
    for (const bx of debugBoxes(g)) {
      ctx.strokeStyle = '#4ade80';
      for (const r of bx.hurtboxes) ctx.strokeRect(wx(r.x) + 0.5, r.y + 0.5, r.w, r.h);
      ctx.strokeStyle = '#f87171';
      for (const r of bx.hitboxes) ctx.strokeRect(wx(r.x) + 0.5, r.y + 0.5, r.w, r.h);
    }
  }
  // Mini HUD.
  ctx.fillStyle = '#fff';
  ctx.font = '12px monospace';
  ctx.textAlign = 'left';
  const f0 = g.fighters[0], f1 = g.fighters[1];
  ctx.fillText(`P1 hp ${f0.health} meter ${f0.meter}`, 10, 16);
  ctx.textAlign = 'right';
  ctx.fillText(`dummy hp ${f1.health} combo ${f1.comboHits}`, cv.width - 10, 16);
  if (g.phase !== Phase.Fighting) {
    ctx.textAlign = 'center';
    ctx.font = 'bold 26px monospace';
    ctx.fillText(['READY', '', 'ROUND OVER', 'MATCH OVER'][g.phase] ?? '', cv.width / 2, 80);
  }
};

const renderTestTab = (): HTMLElement => {
  const err = applyBundleToSim();
  const cv = mkEl('canvas', { width: 960, height: 540, class: 'testcanvas' });
  const info = mkEl('span', { class: 'hint' },
    err ? `BUNDLE INVALID: ${err}` : 'P1: WASD + TYU/GHJ · edits apply on tab entry');

  let last = performance.now();
  let acc = 0;
  const loop = (now: number): void => {
    if (!document.body.contains(cv)) return; // tab switched — stop
    acc = Math.min(acc + now - last, 200);
    last = now;
    while (acc >= 1000 / TICKS_PER_SEC) {
      if (stGame && !err) {
        let p1 = 0;
        for (const [code, bit] of P1_KEYMAP) if (keysDown.has(code)) p1 |= bit;
        step(stGame, [p1, dummyInput(stGame)]);
        if (stGame.phase === Phase.MatchOver) stGame = createGameState(stSeed++, stStageMeta?.bounds);
      }
      acc -= 1000 / TICKS_PER_SEC;
    }
    testPaint(cv);
    stRaf = requestAnimationFrame(loop);
  };
  cancelAnimationFrame(stRaf);
  stRaf = requestAnimationFrame(loop);

  return mkEl('div', { class: 'pane' },
    mkEl('div', { class: 'row' },
      mkEl('button', { onclick: () => renderAll() }, 'apply + restart'),
      mkEl('label', {}, ' P2 ', selInput(stP2Id, ['', ...stCharList], (v) => { void selectP2(v); })),
      mkEl('label', {}, ' dummy ', selInput(stDummy, ['idle', 'block', 'crouch', 'jump', 'mash'], (v) => { stDummy = v as DummyMode; })),
      mkEl('label', {}, ' boxes ', mkEl('input', {
        type: 'checkbox', checked: stShowBoxes,
        onchange: (e: Event) => { stShowBoxes = (e.target as HTMLInputElement).checked; },
      })),
      info,
    ),
    cv,
  );
};

// ------------------------------------------------------------------ generate tab
/**
 * ART DIRECTION — hand-drawn anime, in the tradition of 2D arcade fighters
 * (KOF / Guilty Gear / Arc System Works), NOT retro pixel art. The old
 * "sharp pixel art" wording plus palette snapping and nearest-neighbour
 * downscaling is what produced the chunky 8-bit look; see pipeline.ts.
 */
const spriteStyle = (): string => 'high-resolution anime fighting game character art, hand-drawn cel-shaded '
  + 'illustration, clean bold ink outlines, dynamic shading with crisp highlights, '
  + 'detailed rendering, 2D arcade fighter style like King of Fighters or Guilty Gear. '
  + 'Single character only, full body in strict profile view facing right, nose chest and '
  + 'toes all pointing toward the right edge of the image, feet at the bottom, centered. '
  + `Perfectly flat solid ${bgPhrase()} background, no shadows, no floor, no gradient, `
  + 'no text, no watermark. Not pixel art, not 8-bit, not blocky.';

/**
 * HARD LIMIT: the endpoint rejects prompts over 800 chars (422
 * string_too_long). Everything below budgets against this — a prompt that
 * overflows fails the whole request, so strips must be built to fit.
 */
/**
 * NVIDIA's flux endpoints hard-reject prompts over 800 chars (422
 * string_too_long). img2img providers (Gemini/Kontext) have no such cap, and
 * their prompts need room to be explicit edit instructions.
 */
const PROMPT_MAX_TEXT = 800;
const PROMPT_MAX_REF = 2000;
const promptMax = (provider: string = stSpriteProvider): number =>
  (isImg2Img(provider) ? PROMPT_MAX_REF : PROMPT_MAX_TEXT);

/**
 * Build a strip prompt that fits the budget, trimming pose text if needed.
 *
 * FAILED EXPERIMENT (do not retry without img2img): prepending a fixed
 * "anchor" idle pose to every strip AND using one seed for the whole
 * character collapsed the model onto a single image — a jab, a sweep and a
 * DP all came back pixel-identical. Costume consistency is worthless if the
 * poses die with it. Poses must vary per move (distinct seed + distinct
 * pose text); identity across moves is carried by the costume text + palette
 * lock, and can only be *guaranteed* by an img2img endpoint (see server.mjs
 * IMAGE_PROVIDER).
 */
const buildStripPrompt = (desc: string, poses: string[]): string => {
  // img2img: the reference image is attached, so the prompt becomes an EDIT
  // instruction — "this exact character, these poses". Identity comes from the
  // pixels, not from the description, which is what finally kills costume drift.
  const head = stImg2Img
    ? `The attached image is the reference for ONE character. Redraw THAT EXACT character — `
      + `identical outfit, identical colors, identical hair, identical face and build — as a `
      + `sprite sheet of ${poses.length} DIFFERENT action poses in one horizontal row, evenly `
      + `spaced, not touching. Do not redesign the character. Poses: `
    : `${desc}. Sprite sheet: ${poses.length} DIFFERENT action poses of ONE `
      + `character wearing the identical outfit and colors, one horizontal row, evenly `
      + `spaced, not touching. Each pose is distinct: `;
  const tail = `. Each pose: same full-body character, profile facing right, feet on one `
    + `ground line. Flat ${bgPhrase()} background, no shadow, no floor, no borders. `
    + `Hand-drawn cel-shaded anime fighting game art, bold ink outlines, vibrant colors, `
    + `no text. Not pixel art.`;
  const max = promptMax();
  const budget = max - head.length - tail.length;
  let body = poses.map((p, k) => `${k + 1}) ${p}`).join('; ');
  if (body.length > budget) {
    const per = Math.max(14, Math.floor(budget / poses.length) - 5);
    body = poses.map((p, k) => `${k + 1}) ${p.slice(0, per).trim()}`).join('; ');
  }
  return (head + body + tail).slice(0, max);
};

/**
 * Archetype pose library (spec §5.1: "archetype pose libraries are the big
 * cost saver" — built once per archetype, reused across the roster). Keyed by
 * canonical move id; characters override via meta.moveDesc.
 */
const SHOTO_POSES: Record<string, string> = {
  '5LP': 'throwing a quick standing left jab punch at head height',
  '5MP': 'throwing a standing straight right cross punch',
  '5HP': 'throwing a powerful standing heavy straight punch at full extension',
  '5LK': 'throwing a quick standing front snap kick',
  '5MK': 'throwing a standing roundhouse kick to the midsection',
  '5HK': 'throwing a heavy standing high roundhouse kick',
  '2LP': 'crouching low and throwing a quick jab punch',
  '2MP': 'crouching low and throwing a straight punch',
  '2HP': 'crouching then launching a rising uppercut punch aimed straight up',
  '2LK': 'crouching low and throwing a quick ankle-height kick',
  '2MK': 'crouching low and throwing an extended low kick along the ground',
  '2HK': 'crouching low sweep kick, leg fully extended along the ground',
  'j.LP': 'airborne mid-jump, throwing a quick downward jab punch',
  'j.MP': 'airborne mid-jump, throwing a straight punch',
  'j.HP': 'airborne mid-jump, throwing a heavy downward-angled punch',
  'j.LK': 'airborne mid-jump, striking with a quick knee',
  'j.MK': 'airborne mid-jump, throwing a side kick',
  'j.HK': 'airborne mid-jump, throwing a heavy roundhouse kick',
  '236P': 'thrusting both palms forward launching a glowing energy fireball projectile',
  '623P': 'leaping upward in a rising dragon uppercut, fist extended toward the sky',
  '214K': 'spinning hurricane kick with one leg extended horizontally',
  '236PP': 'dramatic super attack rush, punching forward surrounded by a blazing energy aura',
  // ---- system animations (idle/movement/reaction states)
  'sys.idle': 'standing idle in a relaxed fighting stance, fists up, subtle breathing motion',
  'sys.walkF': 'walking forward in a fighting stance, mid stride, guard up',
  'sys.walkB': 'stepping backward cautiously in a fighting stance, guard up',
  'sys.crouch': 'crouching low in a compact defensive fighting stance',
  'sys.jump': 'jumping vertically', // per-step poses below refine this
  'sys.dashF': 'dashing forward explosively, body leaning hard into the run',
  'sys.dashB': 'hopping backward quickly, weight on the back foot',
  'sys.block': 'standing guard block, both arms raised shielding the face and body',
  'sys.blockCrouch': 'crouching guard block, arms crossed shielding low',
  'sys.blockAir': 'guarding in midair, knees tucked, arms shielding, airborne',
  'sys.hitstun': 'recoiling backward from taking a punch, head snapped back, grimacing',
  'sys.airHitstun': 'launched into the air by a hit, body reeling backward, airborne',
  'sys.knockdown': 'lying flat on the back on the ground, knocked down',
  'sys.getup': 'pushing off the ground, rising back up into fighting stance',
  'sys.ko': 'utterly defeated, collapsed unconscious on the ground',
};

/** Per-step pose overrides for multi-step system anims (id → step → pose). */
const STEP_POSES: Record<string, string[]> = {
  'sys.jump': [
    'leaping upward off the ground, body rising, legs extending down, airborne',
    'at the apex of a high jump, knees tucked, airborne',
    'falling downward from a jump, legs preparing to land, airborne',
  ],
  'sys.getup': [
    'kneeling on one knee, pushing off the ground to stand',
    'almost fully risen, returning to fighting stance',
  ],
};

const PHASE_HINTS: Record<string, string> = {
  startup: 'wind-up anticipation motion before the strike',
  active: 'the moment of impact, limb at full extension',
  recovery: 'follow-through, returning to fighting stance',
};

const poseFor = (mv: MoveDef): string =>
  meta().moveDesc?.[mv.id] || SHOTO_POSES[mv.id] || mv.id;

/** Stable per-frame seed: same character/move/step regenerates identically. */
const seedFor = (moveId: string, stepIdx: number, salt: number): number => {
  let h = 0x9e3779b9 ^ salt;
  for (const ch of `${stCharId}/${moveId}/${stepIdx}`) {
    h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193);
  }
  return (h >>> 0) % 1_000_000;
};

const spriteName = (moveId: string, stepIdx: number): string =>
  `${moveId.replace(/[^a-zA-Z0-9_-]/g, '_')}_s${stepIdx}.png`;

/** Pose text for one step of a move (archetype library + per-step overrides). */
const poseForStep = (mv: MoveDef, i: number): string => {
  const stp = mv.steps[i]!;
  const pose = STEP_POSES[mv.id]?.[i] ?? poseFor(mv);
  const phaseHint = mv.type === 'system' || STEP_POSES[mv.id] ? '' : `, ${PHASE_HINTS[stp.phase] ?? ''}`;
  return `${pose}${phaseHint}`;
};

/**
 * Normalize → facing-correct → QC a generated (or sliced) frame image.
 * `refFigureH` is the character's true drawn height in the SOURCE image's px
 * (median across a sheet). Pass it so every pose shares one character scale —
 * without it each frame is sized by its own extent and the fighter grows when
 * it crouches and shrinks when it kicks.
 */
const finishFrame = (
  mv: MoveDef, src: HTMLImageElement | HTMLCanvasElement, refFigureH?: number,
): GenResult | null => {
  const m = meta();
  const norm = normalizeFrame(src, m.palette ?? null, refFigureH, keySettings());
  if (!norm) return null;
  // Facing check: if the MIRRORED reference silhouette matches decisively
  // better, the model drew the character facing left — flip (lossless).
  let flipped = false;
  if (m.refMask && mv.id !== 'sys.knockdown' && mv.id !== 'sys.ko') {
    const mask = silhouetteMask16(norm.cell);
    const dRef = maskDiff(mask, m.refMask);
    const dMir = maskDiff(mask, mirrorMask16(m.refMask));
    if (dMir < dRef * 0.8) {
      norm.cell = flipCanvasH(norm.cell);
      flipped = true;
    }
  }
  // Horizontal poses (knockdown/KO) legitimately violate the standing-width
  // proportion check — QC them on palette only.
  const refW = mv.id === 'sys.knockdown' || mv.id === 'sys.ko' ? null : m.refBodyW ?? null;
  // Specials/supers carry energy VFX that legitimately drift from the body
  // palette — lower bar; the palette lock still normalizes the colors.
  const passAt = mv.type === 'special' || mv.type === 'super' ? 45 : 55;
  return { norm, qc: qcScore(norm, refW, passAt, m.refChroma ?? null), accepted: false, flipped };
};

/** Generate + normalize + QC ONE frame as its own image (fallback path). */
// ---- uploaded artwork (bring your own character) ---------------------------
/**
 * The RAW uploaded image (no background removal, no cropping). Uploads are
 * kept verbatim because the two things they feed want opposite treatment:
 *   - "stylize" sends the FULL image to Gemini, which needs the face, the
 *     background context and every detail to redraw the character — pre-keying
 *     a photo destroys exactly that (the reported bug: features cut, subject
 *     eaten by an over-eager flood fill tuned for flat-white AI sprites).
 *   - "use verbatim" only makes sense for already-clean sprite art, and does
 *     its normalize at click time.
 */
let stUpload: HTMLCanvasElement[] = [];

const fileToImage = (file: File): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = () => reject(new Error('could not read file'));
    fr.onload = () => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('not a readable image'));
      img.src = String(fr.result);
    };
    fr.readAsDataURL(file);
  });

/** Draw an image onto its own canvas so we hold pixels, not a decode-once <img>. */
const imageToCanvas = (img: HTMLImageElement): HTMLCanvasElement => {
  const c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  c.getContext('2d')!.drawImage(img, 0, 0);
  return c;
};

/**
 * Keep uploaded images RAW (see stUpload) — no keying, no crop. Multiple
 * photos (front / side / detail) are APPENDED: the stylize step feeds them all
 * to Gemini so the locked reference is corroborated from several views, which
 * every generated sprite then inherits. Frame generation is unaffected.
 */
const loadUploadedReference = async (files: File[]): Promise<void> => {
  try {
    for (const file of files) {
      stStatus = `reading ${file.name}…`; renderAll();
      const img = await fileToImage(file);
      stUpload.push(imageToCanvas(img));
    }
    stRefPreview = null;
    stStatus = `${stUpload.length} photo${stUpload.length === 1 ? '' : 's'} uploaded — stylize`
      + `${stUpload.length > 1 ? ' (all fed as references)' : ' it, or use as-is'}`;
  } catch (e) {
    stStatus = `upload failed: ${(e as Error).message}`;
  }
  renderAll();
};

/**
 * Redraw the RAW uploaded image in the game's art style. Gemini gets the whole
 * photo (face + all) and returns the character on a flat-white sprite bg, which
 * is what normalizeFrame is built for — so keying happens AFTER the redraw, not
 * before it. This is the right path for a photo or off-style art.
 */
const stylizeUpload = async (): Promise<void> => {
  if (!stUpload.length || stGenBusy) return;
  stGenBusy = true;
  stStatus = 'stylizing upload into a reference…'; renderAll();
  try {
    const multi = stUpload.length > 1;
    const prompt = (multi
      ? `The attached ${stUpload.length} images all show the SAME ONE character from different `
        + `views/details (they may be photos or off-style art). Synthesize ONE character `
        + `consistent with ALL of them and redraw it as a game sprite — keep the same face, `
        + `hairstyle, outfit, colours and build — standing in a neutral idle fighting stance, full body.`
      : `The attached image shows ONE character (it may be a photo or off-style art). `
        + `Redraw THAT character as a game sprite — keep the same face, hairstyle, outfit, colours `
        + `and build — standing in a neutral idle fighting stance, full body.`) + ` ${spriteStyle()}`;
    const refs = stUpload.map(canvasToPngDataUrl);
    const img = await generateImage(prompt.slice(0, promptMax(stRefProvider)), seedFor('_stylize', 0, stSeed++),
      1024, 1024, false, stRefProvider, refs[0], refs);
    const norm = normalizeFrame(img, null, undefined, keySettings());
    if (!norm) throw new Error('normalize failed');
    stRefPreview = norm;
    stUpload = [];
    stStatus = 'stylized — review, then "use as reference"';
  } catch (e) {
    stStatus = `stylize failed: ${(e as Error).message}`;
  }
  stGenBusy = false;
  renderAll();
};

/** Use a raw upload verbatim: normalize NOW (best for clean-bg sprite art). */
const useUploadVerbatim = (): void => {
  if (!stUpload.length) return;
  const norm = normalizeFrame(stUpload[0]!, null, undefined, keySettings());
  if (!norm) {
    stStatus = 'could not isolate a subject — this looks like a photo; use "stylize" instead';
    renderAll();
    return;
  }
  stRefPreview = norm;
  stUpload = [];
  stStatus = 'staged — review, then "use as reference"';
  renderAll();
};

/** Re-lock palette / facing mask / chroma / body size from the SAVED reference. */
const refreshPaletteFromSaved = async (): Promise<void> => {
  const m = meta();
  let ref = spriteCanvas('_reference.png');
  for (let w = 0; w < 30 && !ref; w++) {
    await new Promise((r) => setTimeout(r, 100));
    ref = spriteCanvas('_reference.png');
  }
  if (!ref) { stStatus = 'no saved reference found'; renderAll(); return; }
  m.palette = extractPalette(ref, PALETTE_N);
  m.refMask = silhouetteMask16(ref);
  m.refChroma = Math.round(meanChroma(ref));
  const bb = alphaBounds(ref);
  if (bb) m.refBodyW = bb.r - bb.l + 1;
  stDirty = true;
  stStatus = `palette refreshed from saved reference (${m.palette.length} colors)`;
  renderAll();
};

const ANCHOR_POSE = 'standing upright in a neutral idle fighting stance';

const genFrame = async (mv: MoveDef, i: number, salt = 0): Promise<GenResult | null> => {
  const desc = meta().desc || stBundle!.name;
  const frameHint = mv.steps.length > 1 && !STEP_POSES[mv.id]
    ? `, animation frame ${i + 1} of ${mv.steps.length}` : '';
  const pose = `${poseForStep(mv, i)}${frameHint}`;

  /**
   * img2img: draw the wanted pose NEXT TO a neutral standing anchor of the
   * same character, in one image (same cost — output billing is per image).
   * The anchor gives the character's true standing height in that image's own
   * pixels, so a lone regenerated frame is scaled exactly like the sheet
   * frames around it instead of being sized by its own pose extent.
   */
  if (stImg2Img) {
    const prompt = buildSheetPrompt([ANCHOR_POSE, pose]);
    const img = await generateImage(prompt, seedFor(mv.id, i, salt), 1024, 1024, true, stSpriteProvider);
    const slices = sliceSheet(img, 2, keySettings());
    if (slices) {
      const anchorH = measureFigureH(slices[0]!, keySettings());
      return finishFrame(mv, slices[1]!, anchorH ?? undefined);
    }
    // Anchor couldn't be separated — fall back to a lone pose (own-extent scale).
    const solo = `The attached image is the reference for ONE character. Redraw THAT EXACT `
      + `character — identical outfit, identical colors, identical hair, identical face and `
      + `build — in a single new pose: ${pose}. Do not redesign the character. ${spriteStyle()}`;
    const img2 = await generateImage(solo.slice(0, promptMax()),
      seedFor(mv.id, i, salt + 1), 1024, 1024, true, stSpriteProvider);
    return finishFrame(mv, img2);
  }

  const prompt = `${desc}, ${pose}, ${spriteStyle()}`.slice(0, promptMax());
  const img = await generateImage(prompt, seedFor(mv.id, i, salt), 1024, 1024, true, stSpriteProvider);
  return finishFrame(mv, img);
};

/**
 * STRIP GENERATION — the fix for costume drift (spec §5.1 stage 2:
 * "animation generation per move, not per frame").
 *
 * Generating each frame as its own image makes the model re-invent the
 * character's outfit on every call — the animation looks like the fighter is
 * changing clothes mid-punch. Inside ONE image the model draws ONE character
 * wearing ONE costume, so we ask for all the poses of a move side by side and
 * cut them apart. The whole character also shares a single seed across every
 * strip, which keeps costumes consistent between moves too.
 */
/**
 * SHEET GENERATION (img2img providers only) — the cost lever.
 *
 * A Gemini image response is billed as a flat ~1290 output tokens whether it
 * contains one figure or nine, so poses-per-call divides the bill directly:
 * a 98-frame character costs 98 calls per-frame vs 11 at 9-up (~9x cheaper).
 * Identity is safe because the reference image rides along with every call —
 * unlike the NVIDIA path, the sheet is a cost trick, not a consistency trick.
 *
 * 9 is the sweet spot: a 3x3 grid on a 1024² canvas gives each figure ~340px,
 * still ~3x the 112px body height we downsample to, and the model reliably
 * keeps figures separated. Denser grids start overlapping (unsliceable).
 */
const SHEET_MAX = 9;

const buildSheetPrompt = (poses: string[]): string => {
  const cols = Math.min(3, poses.length);
  const rows = Math.ceil(poses.length / cols);
  const layout = poses.length <= 3
    ? `ONE horizontal row of ${poses.length} figures, left to right`
    : `a ${cols}x${rows} grid of ${poses.length} figures, read left to right, top to bottom`;
  return (
    `The attached image is the reference for ONE character. Every figure you draw must be `
    + `THAT EXACT character: identical outfit, identical colors, identical hair, face and build. `
    + `Do not redesign the character. Draw a sprite sheet: ${layout}. `
    + `Each figure is a DIFFERENT pose: ${poses.map((p, k) => `${k + 1}) ${p}`).join('; ')}. `
    + `Every figure: full body, strict side profile facing right, feet on its own ground line. `
    + `Flat ${bgPhrase()} background, no shadows, no floor, no grid lines, no borders, no text. `
    + `Figures evenly spaced and clearly separated — never touching or overlapping. `
    + `Hand-drawn cel-shaded anime fighting game art, bold ink outlines, detailed shading, `
    + `vibrant colors. Not pixel art, not 8-bit.`
  ).slice(0, promptMax());
};

const STRIP_W = 1536; // ~1MP is the endpoint's cap; wider is rejected
const STRIP_H = 640;
const STRIP_MAX = 4; // poses per image — beyond this each figure gets too few px

/** Strip telemetry: a silent fallback to per-frame means costume drift. */
let stStripsUsed = 0;
let stStripFallbacks = 0;
let stStripError = '';

/** One seed per character: every strip inherits the same design lottery ticket. */
const charSeed = (salt: number): number => seedFor('_character', 0, salt);

/**
 * Generate every frame of a move as STRIPS: one image per animation, all its
 * poses side by side, sliced apart. Within an image the model draws one
 * character in one costume, so a move never changes clothes mid-swing.
 *
 * The seed varies PER MOVE (not per character) — a single shared seed makes
 * the model redraw the same picture for every move, killing pose variety
 * (see buildStripPrompt's failed-experiment note).
 */
const genMoveFrames = async (mv: MoveDef, salt = 0): Promise<(GenResult | null)[]> => {
  const n = mv.steps.length;
  const out: (GenResult | null)[] = new Array(n).fill(null);
  const desc = meta().desc || stBundle!.name;

  // With an img2img provider the reference image locks identity directly, so
  // strips lose their purpose — and a full 1024² image per pose beats a
  // ~380px-wide slice of a strip. Generate frame by frame instead.
  if (stImg2Img) {
    for (let i = 0; i < n; i++) out[i] = await genFrame(mv, i, salt);
    return out;
  }

  for (let start = 0; start < n; start += STRIP_MAX) {
    const idxs: number[] = [];
    for (let i = start; i < Math.min(start + STRIP_MAX, n); i++) idxs.push(i);
    if (idxs.length === 1) {
      out[idxs[0]!] = await genFrame(mv, idxs[0]!, salt);
      continue;
    }
    const prompt = buildStripPrompt(desc, idxs.map((i) => poseForStep(mv, i)));
    let slices: HTMLCanvasElement[] | null = null;
    try {
      const img = await generateImage(prompt, seedFor(mv.id, start, salt), STRIP_W, STRIP_H, true, stSpriteProvider);
      slices = sliceStrip(img, idxs.length, keySettings());
      if (!slices) stStripFallbacks++; // figures merged/overlapped — unsliceable
    } catch (e) {
      stStripFallbacks++;
      stStripError = (e as Error).message;
    }
    if (slices) {
      stStripsUsed++;
      idxs.forEach((i, k) => { out[i] = finishFrame(mv, slices![k]!); });
    } else {
      for (const i of idxs) out[i] = await genFrame(mv, i, salt);
    }
  }
  return out;
};

const acceptFrame = async (mv: MoveDef, i: number, r: GenResult): Promise<void> => {
  const name = spriteName(mv.id, i);
  await saveSprite(name, r.norm.cell);
  mv.steps[i]!.sprite = name;
  r.accepted = true;
  stDirty = true;
};

/**
 * Regenerate ONE frame with a fresh random seed and stage it as a pending
 * result (does NOT overwrite the saved sprite until "accept"). Shared by the
 * per-frame "retry" (on a fresh result) and "⟳ regenerate" (on the saved
 * "in use" thumbnail) buttons, so any frame can be re-rolled in place.
 */
const regenSingleFrame = (mv: MoveDef, i: number): void => {
  if (stGenBusy) return;
  void (async () => {
    stGenBusy = true;
    stStatus = `regenerating ${mv.id}#${i} via ${stSpriteProvider}…`; renderAll();
    try {
      const nr = await genFrame(mv, i, (Math.random() * 1e6) | 0);
      if (nr) {
        stGenResults.set(i, nr);
        stStatus = `regenerated ${mv.id}#${i} · QC ${nr.qc.score} — review, then accept to replace`;
      } else stStatus = `regenerate ${mv.id}#${i}: no subject found`;
    } catch (e) { stStatus = `regenerate failed: ${(e as Error).message}`; }
    stGenBusy = false;
    renderAll();
  })();
};

const runGeneration = async (which: 'reference' | 'move'): Promise<void> => {
  if (stGenBusy || !stBundle) return;
  stGenBusy = true;
  const m = meta();
  const desc = m.desc || stBundle.name;
  try {
    if (which === 'reference') {
      stStatus = `generating reference via ${stRefProvider}…`; renderAll();
      const img = await generateImage(
        `${desc}, standing idle fighting stance, character reference, ${spriteStyle()}`
          .slice(0, promptMax(stRefProvider)),
        seedFor('_ref', 0, stSeed++), 1024, 1024, false, stRefProvider);
      const norm = normalizeFrame(img, null, undefined, keySettings());
      if (!norm) throw new Error('normalize failed (no subject found)');
      stRefPreview = norm;
      stStatus = 'reference generated — review and click "use as reference"';
    } else {
      const mv = curMove();
      if (!mv) throw new Error('no move selected');
      const n = mv.steps.length;
      stStripsUsed = 0; stStripFallbacks = 0; stStripError = '';
      stStatus = `generating ${mv.id} as a ${n}-pose strip…`; renderAll();
      const frames = await genMoveFrames(mv);
      frames.forEach((r, i) => { if (r) stGenResults.set(i, r); });
      const how = stStripFallbacks > 0
        ? `⚠ per-frame fallback (${stStripError || 'strip could not be sliced'}) — costume may drift`
        : 'strip mode (one costume)';
      stStatus = `generated ${stGenResults.size}/${n} frames · ${how} — review QC + accept`;
    }
  } catch (e) {
    stStatus = `generation failed: ${(e as Error).message}`;
  }
  stGenBusy = false;
  renderAll();
};

/**
 * Pick the higher-QC of two results (either may be null). Retries must keep the
 * BEST attempt, not the latest — a reroll can come back worse, and every call
 * was billed, so the best image earned so far should never be clobbered.
 */
const betterResult = (a: GenResult | null, b: GenResult | null): GenResult | null =>
  !a ? b : !b ? a : b.qc.score > a.qc.score ? b : a;

/**
 * Batch status line. Frames whose best attempt cleared QC are "clean"; frames
 * that produced a real figure but stayed below QC are SAVED anyway (a paid
 * generation is never thrown away — the best image beats a blank frame) and
 * flagged in `review`; only frames where nothing usable came back are hard
 * `failures`.
 */
const batchSummary = (
  total: number, failures: string[], review: string[], tail: string,
): string => {
  if (failures.length === 0 && review.length === 0) {
    return `batch complete: all ${total} frames accepted · ${tail} — SAVE to persist`;
  }
  const clean = total - failures.length - review.length;
  const bits = [`${clean}/${total} clean`];
  if (review.length) bits.push(`${review.length} saved below-QC (review: ${review.join(' ')})`);
  if (failures.length) bits.push(`${failures.length} no image (${failures.join(' ')})`);
  return `batch done: ${bits.join(' · ')} · ${tail} — SAVE to persist`;
};

/**
 * Batch: generate every step of every move (spec §5.2 "per-move batch
 * generation"). QC passes auto-accept; sub-QC frames save their best attempt
 * and are flagged for review; only frames that yield no figure at all are
 * listed as failures. Up to two rerolls per frame on QC failure.
 */
const runGenerateAll = async (): Promise<void> => {
  if (stGenBusy || !stBundle) return;
  stGenBusy = true;
  const failures: string[] = []; // nothing usable came back at all
  const review: string[] = [];   // saved the best attempt, but it's below QC
  stStripsUsed = 0; stStripFallbacks = 0; stStripError = '';
  const want = (mv: MoveDef, i: number): boolean => !stMissingOnly || !mv.steps[i]!.sprite;
  const total = stBundle.moves.reduce(
    (n, mv) => n + mv.steps.filter((_, i) => want(mv, i)).length, 0);
  let done = 0;

  // ---- img2img: SHEET batching. Every output image costs the same no matter
  // how many figures it holds, so pack SHEET_MAX poses per call — spanning
  // moves, since the reference (not the image) is what holds identity now.
  // ~9x fewer API calls than one image per frame.
  if (stImg2Img) {
    try {
      const todo: { mv: MoveDef; i: number }[] = [];
      for (const mv of stBundle.moves) {
        for (let i = 0; i < mv.steps.length; i++) if (want(mv, i)) todo.push({ mv, i });
      }
      const calls = Math.ceil(todo.length / SHEET_MAX);
      let call = 0;
      for (let s = 0; s < todo.length; s += SHEET_MAX) {
        const chunk = todo.slice(s, s + SHEET_MAX);
        call++;
        stStatus = `sheet ${call}/${calls} · ${chunk.length} poses (${done}/${total} frames)…`;
        renderAll();

        let slices: HTMLCanvasElement[] | null = null;
        let sheetFigureH: number | undefined;
        if (chunk.length > 1) {
          try {
            const img = await generateImage(
              buildSheetPrompt(chunk.map((c) => poseForStep(c.mv, c.i))),
              seedFor('_sheet', s, 0), 1024, 1024, true, stSpriteProvider);
            slices = sliceSheet(img, chunk.length, keySettings());
            if (slices) {
              stStripsUsed++;
              // ONE character scale for the whole sheet: the median figure
              // height. Inside an image the model draws the character at a
              // single size, so height differences are POSE, not scale.
              const hs = slices.map((s) => measureFigureH(s, keySettings())).filter((h): h is number => h !== null)
                .sort((a, b) => a - b);
              if (hs.length > 0) sheetFigureH = hs[hs.length >> 1];
            } else stStripFallbacks++;
          } catch (e) {
            stStripFallbacks++;
            stStripError = (e as Error).message;
          }
        }

        for (let k = 0; k < chunk.length; k++) {
          const { mv, i } = chunk[k]!;
          done++;
          let best = slices ? finishFrame(mv, slices[k]!, sheetFigureH) : null;
          // Anything the sheet failed on gets its own single-pose call — keep
          // the best of every (paid) attempt, not just the last.
          for (let att = 0; att < 2 && !(best && best.qc.pass); att++) {
            try {
              best = betterResult(best,
                await genFrame(mv, i, att === 0 ? 0 : 2 + ((Math.random() * 1e6) | 0)));
            } catch { /* transient — next attempt */ }
          }
          if (best) {
            // Never discard a paid generation: save the best image. If it
            // didn't clear QC it still beats a blank frame — flag for review.
            await acceptFrame(mv, i, best);
            if (!best.qc.pass) review.push(`${mv.id}#${i} QC${best.qc.score}`);
          } else {
            failures.push(`${mv.id}#${i} ERR`); // no figure at all
          }
          renderAll();
        }
      }
      const summary = `${stStripsUsed} sheets ok, ${stStripFallbacks} fell back`
        + (stStripError ? ` (${stStripError})` : '');
      stStatus = batchSummary(total, failures, review, summary);
    } catch (e) {
      stStatus = `batch aborted: ${(e as Error).message}`;
    }
    stGenBusy = false;
    renderAll();
    return;
  }

  try {
    for (const mv of stBundle.moves) {
      const wanted = mv.steps.map((_, i) => i).filter((i) => want(mv, i));
      if (wanted.length === 0) continue;
      done += wanted.length;
      stStatus = `batch ${done}/${total} · ${mv.id} (${mv.steps.length}-pose strip)…`; renderAll();

      // Whole-move strip first: one image, one costume (see genMoveFrames).
      let frames: (GenResult | null)[] = [];
      try {
        frames = await genMoveFrames(mv);
      } catch { frames = new Array(mv.steps.length).fill(null); }

      for (const i of wanted) {
        let best = frames[i] ?? null;
        // Reroll only until we get a QC pass, but KEEP THE BEST attempt —
        // a reroll can come back worse, and each one was billed.
        for (let att = 0; att < 2 && !(best && best.qc.pass); att++) {
          try {
            best = betterResult(best, await genFrame(mv, i, 2 + ((Math.random() * 1e6) | 0)));
          } catch { /* transient — next attempt */ }
        }
        if (best) {
          // Never discard a paid generation: save the best image we got. If it
          // didn't clear QC it still beats a blank frame — flag it for review.
          await acceptFrame(mv, i, best);
          if (!best.qc.pass) review.push(`${mv.id}#${i} QC${best.qc.score}`);
        } else {
          failures.push(`${mv.id}#${i} ERR`); // no figure at all
        }
        renderAll();
      }
    }
    const strips = `strips ${stStripsUsed} ok / ${stStripFallbacks} fell back to per-frame`
      + (stStripError ? ` (${stStripError})` : '');
    stStatus = batchSummary(total, failures, review, strips);
  } catch (e) {
    stStatus = `batch aborted: ${(e as Error).message}`;
  }
  stGenBusy = false;
  renderAll();
};

// ---- sprite audit: rescan SAVED sprites for facing / background-bleed suspects
interface AuditRow {
  moveIdx: number;
  step: number;
  name: string;
  facingSus: boolean;
  facingStrong: boolean;
  pockets: number;
  gray: boolean; // desaturated vs a colorful reference
  dupe: boolean; // pixel-identical to another move's frame (dead animation)
  fixed?: string;
}
let stAudit: AuditRow[] | null = null;
let stAuditBusy = false;

/** Cheap content signature of a sprite (FNV over subsampled RGBA). */
const contentSig = (c: HTMLCanvasElement): number => {
  const d = c.getContext('2d', { willReadFrequently: true })!
    .getImageData(0, 0, c.width, c.height).data;
  let h = 0x811c9dc5;
  for (let i = 0; i < d.length; i += 4 * 7) { // stride: fast + still discriminating
    h = Math.imul(h ^ d[i]!, 0x01000193);
    h = Math.imul(h ^ d[i + 1]!, 0x01000193);
    h = Math.imul(h ^ d[i + 3]!, 0x01000193);
  }
  return h >>> 0;
};

const runAudit = async (): Promise<void> => {
  if (stAuditBusy || !stBundle) return;
  stAuditBusy = true;
  stAudit = [];
  const sigOwner = new Map<number, number>(); // content sig → move index
  const m = meta();
  // Ensure a facing mask exists (older bundles: derive from saved reference).
  // The reference Image loads async — wait for it like any other sprite.
  if (!m.refMask) {
    let ref = spriteCanvas('_reference.png');
    for (let w = 0; w < 30 && !ref; w++) {
      await new Promise((r) => setTimeout(r, 100));
      ref = spriteCanvas('_reference.png');
    }
    if (ref) { m.refMask = silhouetteMask16(ref); stDirty = true; }
    else { stStatus = 'audit warning: no reference sprite — facing checks skipped'; }
  }
  const mir = m.refMask ? mirrorMask16(m.refMask) : null;
  try {
    for (let mi = 0; mi < stBundle.moves.length; mi++) {
      const mv = stBundle.moves[mi]!;
      const lying = mv.id === 'sys.knockdown' || mv.id === 'sys.ko';
      for (let i = 0; i < mv.steps.length; i++) {
        const name = mv.steps[i]!.sprite;
        if (!name) continue;
        stStatus = `auditing ${name}…`;
        // Force-load as canvas (may need a beat for the Image to arrive).
        let cell = spriteCanvas(name);
        for (let w = 0; w < 20 && !cell; w++) {
          await new Promise((r) => setTimeout(r, 100));
          cell = spriteCanvas(name);
        }
        if (!cell) continue;
        let facingSus = false, facingStrong = false;
        if (m.refMask && mir && !lying) {
          const mask = silhouetteMask16(cell);
          const dRef = maskDiff(mask, m.refMask);
          const dMir = maskDiff(mask, mir);
          facingStrong = dMir < dRef * 0.8;
          facingSus = !facingStrong && dMir < dRef * 0.95;
        }
        const pockets = enclosedWhitePockets(cell);
        const gray = (m.refChroma ?? 0) >= 40 && meanChroma(cell) < (m.refChroma ?? 0) * 0.4;
        // Duplicate detection: identical pixels in two different MOVES means
        // the model redrew one picture instead of animating (see the failed
        // anchor experiment). Same-move duplicates are legitimate (held poses).
        const sig = contentSig(cell);
        const seenIn = sigOwner.get(sig);
        const dupe = seenIn !== undefined && seenIn !== mi;
        if (seenIn === undefined) sigOwner.set(sig, mi);
        if (facingStrong || facingSus || pockets > 0 || gray || dupe) {
          stAudit.push({ moveIdx: mi, step: i, name, facingSus, facingStrong, pockets, gray, dupe });
        }
      }
    }
    stStatus = `audit: ${stAudit.length} suspect frame(s) of ${stBundle.moves.reduce((n, mv) => n + mv.steps.filter((s) => s.sprite).length, 0)} sprited`;
  } catch (e) {
    stStatus = `audit failed: ${(e as Error).message}`;
  }
  stAuditBusy = false;
  renderAll();
};

const auditFlip = async (row: AuditRow): Promise<void> => {
  const c = spriteCanvas(row.name);
  if (!c) return;
  await saveSprite(row.name, flipCanvasH(c));
  row.fixed = 'flipped';
  stDirty = true;
  renderAll();
};

const auditRegen = async (row: AuditRow): Promise<void> => {
  const mv = stBundle!.moves[row.moveIdx]!;
  stAuditBusy = true;
  stStatus = `regenerating ${row.name}…`; renderAll();
  try {
    let r: GenResult | null = null;
    for (let att = 0; att < 3 && !(r && r.qc.pass); att++) {
      try {
        r = (await genFrame(mv, row.step, att === 0 ? 7 : 2 + ((Math.random() * 1e6) | 0))) ?? r;
      } catch { /* retry */ }
    }
    if (r && r.qc.pass) {
      await acceptFrame(mv, row.step, r);
      row.fixed = `regen QC${r.qc.score}`;
    } else {
      row.fixed = `regen failed${r ? ` QC${r.qc.score}` : ''}`;
    }
  } catch (e) {
    row.fixed = 'regen error';
  }
  stAuditBusy = false;
  renderAll();
};

const auditFixAll = async (): Promise<void> => {
  if (!stAudit) return;
  for (const row of stAudit) {
    if (row.fixed) continue;
    if (row.facingStrong) await auditFlip(row);
    else if (row.pockets > 0 || row.gray || row.dupe) await auditRegen(row);
  }
  stStatus = 'audit auto-fix complete — SAVE to persist sprite refs + atlas';
  renderAll();
};

const renderGenerateTab = (): HTMLElement => {
  const b = stBundle!;
  const m = meta();
  const mv = curMove();

  const thumb = (c: CanvasImageSource, size = 150): HTMLCanvasElement => {
    const t = mkEl('canvas', { width: size, height: size, class: 'thumb' });
    const tc = t.getContext('2d')!;
    tc.imageSmoothingEnabled = true;
    tc.imageSmoothingQuality = 'high';
    tc.fillStyle = '#12141f';
    tc.fillRect(0, 0, size, size);
    tc.drawImage(c, 0, 0, size, size);
    return t;
  };

  /**
   * Thumbnail of the sprite CURRENTLY saved on a step (what the game ships),
   * or null when that step has no sprite yet. Images stream in async, so this
   * repaints itself once the PNG lands rather than showing a blank forever.
   */
  const savedThumb = (name: string | undefined, size = 150): HTMLElement | null => {
    if (!name) return null;
    const t = mkEl('canvas', { width: size, height: size, class: 'thumb' });
    const tc = t.getContext('2d')!;
    // The PNG streams in async. Retry on a bounded timer — NOT gated on the
    // canvas already being in the DOM, since the first paint happens while the
    // element is still being built (that check left every thumb blank).
    let tries = 0;
    const paint = (): void => {
      const spr = getSprite(name);
      tc.imageSmoothingEnabled = true;
      tc.imageSmoothingQuality = 'high';
      tc.fillStyle = '#12141f';
      tc.fillRect(0, 0, size, size);
      if (spr) tc.drawImage(spr, 0, 0, size, size);
      else if (tries++ < 60) setTimeout(paint, 120);
    };
    paint();
    return t;
  };

  const refSection = mkEl('div', { class: 'genblock' },
    mkEl('b', {}, '1 · reference sheet (the consistency contract)'),
    mkEl('p', { class: isImg2Img(stRefProvider) ? 'qc pass' : 'qc fail' },
      isImg2Img(stRefProvider)
        ? `✅ ${stRefProvider} accepts a reference image — you can stylize an uploaded photo, and sprites `
          + `generated from the locked reference get true identity lock`
        : `⚠ ${stRefProvider} is text-only (cannot accept a reference image). "Generate reference" works, `
          + `but stylizing an uploaded photo needs an img2img engine (gemini / bfl / fal).`),
    mkEl('div', { class: 'row' },
      mkEl('label', {}, 'character description ', mkEl('input', {
        value: m.desc ?? '', style: 'width:420px',
        placeholder: 'e.g. cyberpunk karate robot, red chassis, yellow visor',
        onchange: (e: Event) => { m.desc = (e.target as HTMLInputElement).value; stDirty = true; },
      })),
      mkEl('label', {}, ' engine ', sessionSelect(
        stRefProvider,
        Object.entries(stAvailable).filter(([, ok]) => ok).map(([p]) => p),
        (v) => { stRefProvider = v; },
      )),
      // The generation backdrop, choosable right where the reference is made
      // (same setting as the background-key panel below — one source of truth).
      mkEl('label', { title: 'backdrop color the model is asked to draw on, and that the keyer removes. '
        + 'Use magenta/green (chroma key) for characters with white clothing/details — white backdrops '
        + 'can collide with white foreground.' },
      ' bg color ', sessionSelect(
        stKeyCfg.mode, ['white', 'magenta', 'green'],
        (v) => { stKeyCfg.mode = v as KeyBgMode; saveKeyCfg(); stKeyPreview = null; },
      )),
      mkEl('button', { disabled: stGenBusy ? '' : null, onclick: () => void runGeneration('reference') },
        stGenBusy ? '…' : 'generate reference'),
      // Bring your own art: use a real image as the character's contract.
      mkEl('label', { class: 'upload', title: 'use your own artwork as the reference — add several photos (front / side / detail) to emphasize features' },
        stGenBusy ? '…' : '⬆ upload image(s)',
        mkEl('input', {
          type: 'file', accept: 'image/*', multiple: '', style: 'display:none',
          onchange: (e: Event) => {
            const files = Array.from((e.target as HTMLInputElement).files ?? []);
            if (files.length) void loadUploadedReference(files);
            (e.target as HTMLInputElement).value = '';
          },
        })),
    ),
    // The locked reference, shown by default — it IS the character contract,
    // so it should never be invisible just because you haven't regenerated it.
    !stRefPreview && stUpload.length === 0 ? mkEl('div', { class: 'row' },
      savedThumb('_reference.png') ?? mkEl('div', { class: 'thumb empty' }, 'no reference'),
      mkEl('p', { class: 'hint' }, m.palette
        ? `locked reference in use · every frame is generated from this image`
        : 'no reference locked yet — generate or upload one, then "use as reference"'),
    ) : null,
    // An uploaded image (shown RAW). Recommended path: stylize — the model
    // redraws the character as a game sprite, handling the background itself.
    // "use as-is" only suits already-clean sprite art.
    stUpload.length ? mkEl('div', { class: 'row' },
      ...stUpload.map((c) => thumb(c)),
      mkEl('div', {},
        mkEl('p', { class: 'hint' },
          `${stUpload.length} uploaded image${stUpload.length === 1 ? '' : 's'} (raw). For a photo or any `
          + 'real background, use ✨ stylize — it keeps the face/outfit and redraws on a clean sprite '
          + 'background. Add more photos (front / side / detail) to emphasize features; "use as-is" '
          + '(first image only) is for art that is already a clean sprite on white.'),
        mkEl('button', {
          disabled: stGenBusy || !isImg2Img(stRefProvider) ? '' : null,
          title: isImg2Img(stRefProvider)
            ? `redraw the uploaded character as a game sprite via ${stRefProvider} (recommended for photos)`
            : `the reference engine "${stRefProvider}" is text-only — switch it to gemini / bfl / fal to stylize`,
          onclick: () => { void stylizeUpload(); },
        }, stGenBusy ? '…' : '✨ stylize into reference'),
        mkEl('button', {
          title: 'use the uploaded image directly (best for a clean sprite on a white background)',
          onclick: () => useUploadVerbatim(),
        }, 'use as-is'),
        mkEl('button', { onclick: () => { stUpload = []; renderAll(); } }, 'discard'),
      ),
    ) : null,
    stRefPreview ? mkEl('div', { class: 'row' },
      thumb(stRefPreview.cell),
      mkEl('button', {
        title: 'mirror the reference BEFORE locking — everything generated after inherits this orientation',
        onclick: () => {
          stRefPreview!.cell = flipCanvasH(stRefPreview!.cell);
          stStatus = 'reference preview flipped';
          renderAll();
        },
      }, '↔ flip'),
      mkEl('button', {
        onclick: () => {
          const pal = extractPalette(stRefPreview!.cell, PALETTE_N);
          m.palette = pal;
          m.refBodyW = stRefPreview!.bodyW;
          m.refMask = silhouetteMask16(stRefPreview!.cell);
          m.refChroma = Math.round(meanChroma(stRefPreview!.cell));
          void saveSprite('_reference.png', stRefPreview!.cell);
          stDirty = true;
          stStatus = `reference locked: ${pal.length}-color palette, body ${stRefPreview!.bodyW}×${stRefPreview!.bodyH}, facing mask stored`;
          renderAll();
        },
      }, 'use as reference'),
    ) : null,
    m.palette ? mkEl('div', { class: 'row' },
      mkEl('span', { class: 'hint' }, `locked palette (${m.palette.length}):`),
      ...m.palette.map((c) => mkEl('span', {
        class: 'swatch', style: `background:rgb(${c[0]},${c[1]},${c[2]})`,
      })),
      mkEl('button', {
        title: 're-extract palette + facing mask + body size from the SAVED reference sprite (use after a palette-extraction fix)',
        onclick: () => { void refreshPaletteFromSaved(); },
      }, '⟳ refresh palette'),
    ) : mkEl('p', { class: 'hint' }, 'no reference yet — frames will skip palette lock + QC'),
  );

  const results: HTMLElement[] = [];
  if (mv) {
    for (let i = 0; i < mv.steps.length; i++) {
      const r = stGenResults.get(i);
      // With no fresh generation, show the sprite this step CURRENTLY uses —
      // the panel should reflect the character as it actually ships, not an
      // empty box until you regenerate.
      const saved = mv.steps[i]!.sprite;
      results.push(mkEl('div', { class: 'genframe' },
        mkEl('div', { class: 'hint' }, `step ${i} · ${mv.steps[i]!.phase}`),
        r ? thumb(r.norm.cell)
          : savedThumb(saved) ?? mkEl('div', { class: 'thumb empty' }, 'no sprite'),
        r ? mkEl('div', { class: r.qc.pass ? 'qc pass' : 'qc fail' },
          `QC ${r.qc.score} · pal ${(r.qc.paletteMatch * 100).toFixed(0)}%${r.flipped ? ' · ↔auto-flipped' : ''}`)
          : saved ? mkEl('div', { class: 'hint' }, 'in use') : null,
        r ? mkEl('div', {},
          mkEl('button', {
            disabled: r.accepted ? '' : null,
            onclick: () => {
              void acceptFrame(mv, i, r).then(() => { stStatus = `accepted ${spriteName(mv.id, i)}`; renderAll(); });
            },
          }, r.accepted ? 'accepted ✓' : 'accept'),
          mkEl('button', {
            disabled: stGenBusy ? '' : null,
            title: `re-roll this frame with a new seed via ${stSpriteProvider}`,
            onclick: () => regenSingleFrame(mv, i),
          }, 'retry'),
        // No fresh result: let the saved "in use" (or empty) frame be
        // regenerated directly, without a full-move generate first.
        ) : mkEl('div', {},
          mkEl('button', {
            disabled: stGenBusy ? '' : null,
            title: saved
              ? `regenerate just this frame with a new seed via ${stSpriteProvider} (review + accept to replace)`
              : `generate this single frame via ${stSpriteProvider}`,
            onclick: () => regenSingleFrame(mv, i),
          }, stGenBusy ? '…' : (saved ? '⟳ regenerate' : 'generate')),
        ),
      ));
    }
  }

  // ---- background key panel -------------------------------------------------
  // Every generated image passes through removeBackground; these knobs are the
  // difference between "the white gi survived" and "the keyer ate the eyes".
  const keySlider = (
    lab: string, min: number, max: number, step: number,
    get: () => number, set: (v: number) => void, fmt: (v: number) => string, tip: string,
  ): HTMLElement =>
    mkEl('label', { title: tip }, `${lab} `, mkEl('input', {
      type: 'range', min: String(min), max: String(max), step: String(step),
      value: String(get()), style: 'width:130px;vertical-align:middle',
      onchange: (e: Event) => {
        set(Number((e.target as HTMLInputElement).value));
        saveKeyCfg();
        stKeyPreview = null;
        renderAll();
      },
    }), mkEl('span', { class: 'hint' }, ` ${fmt(get())}`));

  /** Contain-fit thumbnail on a checkerboard, so keyed alpha is VISIBLE. */
  const alphaThumb = (src: HTMLImageElement | HTMLCanvasElement, tw = 224, th = 120): HTMLCanvasElement => {
    const sw = src instanceof HTMLCanvasElement ? src.width : src.naturalWidth;
    const sh = src instanceof HTMLCanvasElement ? src.height : src.naturalHeight;
    const t = mkEl('canvas', { width: tw, height: th, class: 'thumb' });
    const tc = t.getContext('2d')!;
    for (let y = 0; y < th; y += 8) {
      for (let x = 0; x < tw; x += 8) {
        tc.fillStyle = ((x + y) / 8) % 2 === 0 ? '#3a3d4d' : '#23252f';
        tc.fillRect(x, y, 8, 8);
      }
    }
    if (sw > 0 && sh > 0) {
      const s = Math.min(tw / sw, th / sh);
      const dw = sw * s, dh = sh * s;
      tc.imageSmoothingEnabled = true;
      tc.imageSmoothingQuality = 'high';
      tc.drawImage(src, (tw - dw) / 2, (th - dh) / 2, dw, dh);
    }
    return t;
  };

  const keyedPreview = (): { out: HTMLCanvasElement; bleed: number } | null => {
    if (!stLastRaw) return null;
    const cfg = JSON.stringify(stKeyCfg);
    if (!stKeyPreview || stKeyPreview.src !== stLastRaw || stKeyPreview.cfg !== cfg) {
      const { canvas, bleed } = removeBackground(stLastRaw, keySettings());
      stKeyPreview = { src: stLastRaw, cfg, out: canvas, bleed };
    }
    return { out: stKeyPreview.out, bleed: stKeyPreview.bleed };
  };

  const kp = keyedPreview();
  const keySection = mkEl('div', { class: 'genblock' },
    mkEl('b', {}, '2 · background key (how sprites get their transparency)'),
    mkEl('div', { class: 'row' },
      mkEl('label', {}, 'key background ', sessionSelect(
        stKeyCfg.mode, ['white', 'magenta', 'green'],
        (v) => { stKeyCfg.mode = v as KeyBgMode; saveKeyCfg(); stKeyPreview = null; },
      )),
      keySlider('strength', 0.4, 1.6, 0.05,
        () => stKeyCfg.strength, (v) => { stKeyCfg.strength = v; },
        (v) => `${Math.round(v * 100)}%`,
        'how far from the background color still counts as background — lower protects near-bg foreground'),
      keySlider('softness', 0, 1, 0.05,
        () => stKeyCfg.softness, (v) => { stKeyCfg.softness = v; },
        (v) => `${Math.round(v * 100)}%`,
        'edge feather width — 0 is a hard cut (no semi-transparent fringe)'),
      mkEl('label', { title: 'clear background windows fully enclosed by the figure (between legs, under arms)' },
        ' pockets ', mkEl('input', {
          type: 'checkbox', checked: stKeyCfg.clearPockets,
          onchange: (e: Event) => {
            stKeyCfg.clearPockets = (e.target as HTMLInputElement).checked;
            saveKeyCfg(); stKeyPreview = null; renderAll();
          },
        })),
      keySlider('pocket match', 0.15, 1, 0.05,
        () => stKeyCfg.pocketTightness, (v) => { stKeyCfg.pocketTightness = v; },
        (v) => `${Math.round(v * 100)}%`,
        'how exactly an enclosed region must match the background to be cleared — keep LOW so white '
        + 'eyes/teeth/clothing (shaded, off-key) survive while true background windows (flat, exact) go'),
      keySlider('pocket min', 0.00005, 0.002, 0.00005,
        () => stKeyCfg.pocketMinFrac, (v) => { stKeyCfg.pocketMinFrac = v; },
        (v) => `${(v * 100).toFixed(3)}% px`,
        'smallest enclosed region that can be cleared — raises the floor above eye/mouth size'),
      mkEl('button', {
        title: 'back to the shipped defaults',
        onclick: () => { stKeyCfg = { ...KEY_CFG_DEFAULTS }; saveKeyCfg(); stKeyPreview = null; renderAll(); },
      }, 'reset'),
    ),
    mkEl('p', { class: 'hint' },
      stKeyCfg.mode === 'white'
        ? 'white backgrounds can collide with white costume parts — if a character wears white, switch the '
          + 'key background to magenta/green (chroma key): new generations use that backdrop and white '
          + 'foreground can never be keyed out'
        : `new generations are prompted on a flat ${stKeyCfg.mode} backdrop and keyed against it — white `
          + 'foreground is safe by construction. Regenerate existing frames to benefit.'),
    kp ? mkEl('div', { class: 'row' },
      mkEl('div', {}, alphaThumb(stLastRaw!), mkEl('div', { class: 'hint' }, 'last raw generation')),
      mkEl('div', {}, alphaThumb(kp.out), mkEl('div', { class: 'hint' },
        `keyed with current settings · bleed ${(kp.bleed * 100).toFixed(1)}%`)),
    ) : mkEl('p', { class: 'hint' },
      'no raw image yet this session — generate a reference or some frames and the last raw '
      + 'result appears here for live key tuning'),
  );

  const moveSection = mkEl('div', { class: 'genblock' },
    mkEl('b', {}, '3 · per-move animation frames'),
    mkEl('div', { class: 'row' },
      mkEl('label', {}, 'move ', selInput(mv?.id ?? '', b.moves.map((x) => x.id), (id) => {
        stMoveIdx = b.moves.findIndex((x) => x.id === id);
        stGenResults = new Map();
      })),
      mkEl('label', {}, ' engine ', sessionSelect(
        stSpriteProvider,
        Object.entries(stAvailable).filter(([, ok]) => ok).map(([p]) => p),
        (v) => { stSpriteProvider = v; stImg2Img = isImg2Img(v); },
      )),
      mv ? mkEl('label', {}, ' pose description ', mkEl('input', {
        value: m.moveDesc?.[mv.id] ?? '', style: 'width:340px',
        placeholder: SHOTO_POSES[mv.id] ?? 'e.g. throwing a heavy straight right punch',
        onchange: (e: Event) => {
          (m.moveDesc ??= {})[mv.id] = (e.target as HTMLInputElement).value;
          stDirty = true;
        },
      })) : null,
      mkEl('button', { disabled: stGenBusy || !mv ? '' : null, onclick: () => void runGeneration('move') },
        stGenBusy ? 'generating…' : `generate ${mv?.steps.length ?? 0} frames`),
      mkEl('button', {
        disabled: stGenBusy ? '' : null,
        title: 'every step of every move · QC passes auto-accept, one retry on failure',
        onclick: () => void runGenerateAll(),
      }, stGenBusy ? '…' : (() => {
        const frames = b.moves.reduce(
          (n, x) => n + x.steps.filter((s) => !stMissingOnly || !s.sprite).length, 0);
        // Show API CALLS, not frames — calls are what you're billed for.
        const calls = stImg2Img ? Math.ceil(frames / SHEET_MAX) : frames;
        return `⚡ batch ${stMissingOnly ? 'MISSING' : 'ALL'} (${frames} frames · ${calls} API call${calls === 1 ? '' : 's'})`;
      })()),
      mkEl('label', {}, ' missing only ', mkEl('input', {
        type: 'checkbox', checked: stMissingOnly,
        onchange: (e: Event) => { stMissingOnly = (e.target as HTMLInputElement).checked; renderAll(); },
      })),
    ),
    mkEl('p', { class: 'hint' },
      'pose defaults come from the shoto archetype library — blank input = archetype pose; type to override'),
    mkEl('div', { class: 'genrow' }, ...results),
    mkEl('p', { class: 'hint' },
      'accept a frame → it becomes the step sprite; then Frames tab → auto-hurtbox / auto-hitbox drafts. Save when done.'),
  );

  const auditSection = mkEl('div', { class: 'genblock' },
    mkEl('b', {}, '4 · sprite audit (facing + background bleed on saved frames)'),
    mkEl('div', { class: 'row' },
      mkEl('button', { disabled: stAuditBusy ? '' : null, onclick: () => void runAudit() },
        stAuditBusy ? 'auditing…' : 'audit sprites'),
      stAudit && stAudit.length > 0 ? mkEl('button', {
        disabled: stAuditBusy ? '' : null,
        title: 'strong wrong-facing → flip · bleed pockets → regenerate',
        onclick: () => void auditFixAll(),
      }, 'auto-fix all') : null,
    ),
    stAudit ? (stAudit.length === 0
      ? mkEl('p', { class: 'hint' }, 'no suspects found ✓')
      : mkEl('table', { class: 'movetable' },
        mkEl('tr', {}, ...['', 'frame', 'flags', 'fix', ''].map((hh) => mkEl('th', {}, hh))),
        ...stAudit.map((row) => mkEl('tr', {},
          // The frame itself — judging a flag without seeing the art is guesswork.
          mkEl('td', {}, savedThumb(row.name, 72) ?? mkEl('span', {}, '—')),
          mkEl('td', {}, row.name),
          mkEl('td', {},
            [row.facingStrong ? 'FACING' : row.facingSus ? 'facing?' : '',
              row.pockets > 0 ? `bleed×${row.pockets}` : '',
              row.gray ? 'GRAY' : '',
              row.dupe ? 'DUPE' : ''].filter(Boolean).join(' · ')),
          mkEl('td', {}, row.fixed ?? '—'),
          mkEl('td', {},
            mkEl('button', { disabled: stAuditBusy ? '' : null, onclick: () => void auditFlip(row) }, '↔ flip'),
            mkEl('button', { disabled: stAuditBusy ? '' : null, onclick: () => void auditRegen(row) }, 'regen'),
          ),
        )),
      )) : null,
    // Contact sheet of every sprite the character currently ships — visible by
    // default, so you can eyeball the whole roster of frames without running
    // anything. Click a frame to jump to it in the Frames editor.
    !stAudit ? (() => {
      const all = b.moves.flatMap((m2) => m2.steps.map((s2, si) => ({ m2, s2, si })))
        .filter((x) => !!x.s2.sprite);
      if (all.length === 0) {
        return mkEl('p', { class: 'hint' }, 'no sprites yet — generate some frames first');
      }
      return mkEl('div', {},
        mkEl('p', { class: 'hint' },
          `${all.length} sprites in use · click one to edit its boxes · "audit sprites" scans them for `
          + 'wrong facing (mirror-matches the reference), background bleed, greyscale and duplicates'),
        mkEl('div', { class: 'genrow' }, ...all.map(({ m2, s2, si }) => mkEl('div', {
          class: 'genframe', style: 'cursor:pointer',
          title: `${m2.id} step ${si} — click to edit`,
          onclick: () => {
            stMoveIdx = b.moves.indexOf(m2);
            stStepIdx = si;
            stSel = null;
            stTab = 'frames';
            renderAll();
          },
        },
        savedThumb(s2.sprite, 96)!,
        mkEl('div', { class: 'hint' }, `${m2.id}#${si}`)))),
      );
    })() : null,
  );

  return mkEl('div', { class: 'pane' }, refSection, keySection, moveSection, auditSection);
};

// ------------------------------------------------------------------ root
// ------------------------------------------------------------------ stage tab
interface StageLayerMetaEd {
  file: string; depth: number; stretch?: boolean;
  scale?: number; offsetX?: number; offsetY?: number;
}
interface StageMetaEd {
  name: string;
  imageW: number;
  imageH: number;
  floorY: number;
  skyColor: string;
  deckColor: string;
  /** VIEW LOCK: playable region in world px (0..STAGE.widthPx). The camera and
   *  the sim walls lock to it in-game. Absent → full stage width. Edited via the
   *  draggable handles / number inputs in the Stage tab preview. */
  bounds?: { left: number; right: number };
  layers?: StageLayerMetaEd[];
}

/**
 * One parallax plane in the Studio's editor. `file`/`depth`/`label` are
 * fixed per slot; `img` is null until generated or uploaded. Depths mirror
 * chrome.ts's convention: 1 = gameplay plane (today's flat-background
 * behavior), 0 = infinitely far. See drawStageLayers for the derivation.
 */
interface StageLayerEd {
  file: string;
  label: string;
  hint: string;
  defaultDepth: number;
  depth: number;
  img: HTMLImageElement | HTMLCanvasElement | null;
  keyBg: boolean; // strip the flat generation background so lower planes show through
  /**
   * MANUAL positioning (object planes only — the backdrop plane always
   * stretches to the shared frame). Auto-detecting these from the image's
   * opaque content was tried and abandoned: one stray shape in a generation
   * (an unrelated ledge alongside a requested fence, say) silently wrecks
   * the whole layer's scale/anchor with no way to correct it. These are set
   * by dragging in the preview (or typing values) and persisted as-is —
   * auto-detect only ever SUGGESTS a starting point, never decides alone.
   */
  scale: number; // world px per source px
  offsetX: number; // world px, added on top of the parallax depth offset
  offsetY: number; // world px, source image's TOP edge relative to the floor line
}

const freshLayerSlots = (): StageLayerEd[] => [
  {
    file: 'layer-bg.png', label: 'Background (far)',
    hint: 'e.g. distant city skyline silhouette against a purple sunset sky, no foreground objects',
    defaultDepth: 0.15, depth: 0.15, img: null, keyBg: false,
    scale: 1, offsetX: 0, offsetY: 0, // stretched — position fields unused
  },
  {
    file: 'layer-mid.png', label: 'Midground',
    hint: 'e.g. row of mid-distance rooftop buildings and water towers, isolated so the sky shows through',
    defaultDepth: 0.45, depth: 0.45, img: null, keyBg: true,
    scale: 0.35, offsetX: 0, offsetY: -240,
  },
  {
    file: 'layer-fg.png', label: 'Foreground (near)',
    hint: 'e.g. close chain-link fence and pipe silhouettes, isolated so everything behind shows through',
    defaultDepth: 0.75, depth: 0.75, img: null, keyBg: true,
    scale: 0.22, offsetX: 0, offsetY: -150,
  },
];

let stStageId = 'rooftop';
let stStageList: string[] = [];
let stStageMeta: StageMetaEd | null = null;
let stStageImg: HTMLImageElement | HTMLCanvasElement | null = null;
let stStageLayers: StageLayerEd[] = freshLayerSlots();
let stStageLayerBusy: boolean[] = [false, false, false];
/** Which layer the preview canvas drag currently targets. -1 = floor line. */
let stStageSelLayer = -1;
let stStageBusy = false;
let stStageDirty = false;

/** Start a blank stage (called by the new-stage dialog). */
const newStage = (id: string): void => {
  stStageId = id;
  stStageImg = null;
  stStageLayers = freshLayerSlots();
  stStageMeta = { name: id, imageW: 1536, imageH: 640, floorY: 520, skyColor: '#2b1b4d', deckColor: '#3a3644' };
  stStageDirty = true;
  renderAll();
};

const loadStageEd = async (id: string): Promise<void> => {
  stStageId = id;
  stStageMeta = null;
  stStageImg = null;
  stStageLayers = freshLayerSlots();
  try {
    const r = await fetch(`/stages/${id}/stage.json`);
    if (r.ok) stStageMeta = (await r.json()) as StageMetaEd;
    const img = new Image();
    img.src = `/stages/${id}/background.png?v=${Math.random()}`;
    await new Promise<void>((res) => { img.onload = () => res(); img.onerror = () => res(); });
    if (img.naturalWidth > 0) stStageImg = img;
    // Hydrate any parallax planes this stage already has.
    if (stStageMeta?.layers?.length) {
      await Promise.all(stStageMeta.layers.map(async (lm) => {
        const slot = stStageLayers.find((s) => s.file === lm.file);
        if (!slot) return;
        slot.depth = lm.depth;
        if (lm.scale !== undefined) slot.scale = lm.scale;
        if (lm.offsetX !== undefined) slot.offsetX = lm.offsetX;
        if (lm.offsetY !== undefined) slot.offsetY = lm.offsetY;
        const limg = new Image();
        limg.src = `/stages/${id}/${lm.file}?v=${Math.random()}`;
        await new Promise<void>((res) => { limg.onload = () => res(); limg.onerror = () => res(); });
        if (limg.naturalWidth > 0) slot.img = limg;
      }));
    }
  } catch { /* new stage */ }
  stStageMeta ??= {
    name: id, imageW: 1536, imageH: 640, floorY: 520,
    skyColor: '#2b1b4d', deckColor: '#3a3644',
  };
  stStageDirty = false;
  renderAll();
};

const canvasOf = (img: HTMLImageElement | HTMLCanvasElement): HTMLCanvasElement => {
  if (img instanceof HTMLCanvasElement) return img;
  const c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  c.getContext('2d')!.drawImage(img, 0, 0);
  return c;
};

const saveStageEd = async (): Promise<void> => {
  if (!stStageMeta) return;
  const filled = stStageLayers.filter((l) => l.img);
  if (stStageImg) {
    const c = canvasOf(stStageImg);
    stStageMeta.imageW = c.width;
    stStageMeta.imageH = c.height;
    await apiJson(`/api/stages/${stStageId}/background.png`, {
      method: 'PUT', body: c.toDataURL('image/png'),
    });
  }
  if (filled.length > 0) {
    // A layer stack sets the reference framing once no plain background was
    // ever provided (a layers-only stage still needs imageW/imageH/floorY
    // scale reference — use the bg plane, or whichever plane exists first).
    if (!stStageImg) {
      const ref = canvasOf(filled[0]!.img!);
      stStageMeta.imageW = ref.width;
      stStageMeta.imageH = ref.height;
    }
    await Promise.all(filled.map(async (l) => {
      await apiJson(`/api/stages/${stStageId}/${l.file}`, {
        method: 'PUT', body: canvasOf(l.img!).toDataURL('image/png'),
      });
    }));
    // stretch: true only for the opaque backdrop plane (keyBg:false) — object
    // planes (keyBg:true) use the MANUALLY-set scale/offsetX/offsetY instead
    // of stretching into a wall (see chrome.ts drawStageLayers).
    stStageMeta.layers = filled.map((l) => ({
      file: l.file, depth: l.depth, stretch: !l.keyBg,
      ...(l.keyBg ? { scale: l.scale, offsetX: l.offsetX, offsetY: l.offsetY } : {}),
    }));
  } else {
    delete stStageMeta.layers;
  }
  // A view lock that spans the whole stage is the default — drop it so unbounded
  // stages stay clean (and byte-identical to before this feature).
  if (stStageMeta.bounds
    && stStageMeta.bounds.left <= 0 && stStageMeta.bounds.right >= STAGE.widthPx) {
    delete stStageMeta.bounds;
  }
  await apiJson(`/api/stages/${stStageId}/stage.json`, {
    method: 'PUT', body: JSON.stringify(stStageMeta, null, 2),
  });
  stStageDirty = false;
  stStatus = `stage "${stStageId}" saved${filled.length > 0 ? ` · ${filled.length} parallax plane(s)` : ''}`;
  if (!stStageList.includes(stStageId)) stStageList.push(stStageId);
  renderAll();
};

/**
 * Suggest scale/offsetY from the layer's actual opaque content bounds — a
 * STARTING POINT only, never the final word (see StageLayerEd.scale doc:
 * one stray shape in a generation throws this off, which is exactly why
 * positioning is manual/draggable and this is just a convenience button).
 * `targetWorldH` compares against a fighter's ~112 world-px body height.
 */
const autoDetectLayer = (idx: number, targetWorldH: number): void => {
  const layer = stStageLayers[idx]!;
  if (!layer.img) return;
  const c = canvasOf(layer.img);
  const bb = alphaBounds(c);
  if (!bb) { stStatus = `${layer.label}: no opaque content found to detect`; renderAll(); return; }
  const contentH = bb.b - bb.t + 1;
  layer.scale = targetWorldH / contentH;
  layer.offsetX = 0;
  layer.offsetY = -Math.round((bb.b + 1) * layer.scale);
  stStageDirty = true;
  stStatus = `${layer.label}: auto-detected (content ${contentH}px → ${targetWorldH} world px) — drag to fine-tune`;
  renderAll();
};

/** Generate one parallax plane: text-to-image, then key out the flat
 * generation background so lower planes show through (skip for bg — it
 * IS the backdrop, so it should stay opaque). */
const generateStageLayer = async (idx: number): Promise<void> => {
  const layer = stStageLayers[idx]!;
  const promptEl = document.getElementById(`stagelayer-${idx}`) as HTMLInputElement;
  const p = promptEl.value.trim();
  if (!p) { stStatus = `enter a prompt for ${layer.label}`; renderAll(); return; }
  stStageLayerBusy[idx] = true;
  stStatus = `generating ${layer.label} via ${stStageProvider}…`; renderAll();
  try {
    const img = await generateImage(
      layer.keyBg
        ? `${p}. Isolated on a perfectly flat solid ${bgPhrase()} background, no shadows, no gradient — `
          + `only the described objects, nothing else. Anime background art, no text.`
        : `${p}, anime background art, no text`,
      (Math.random() * 1e6) | 0, 1536, 640, false, stStageProvider);
    layer.img = layer.keyBg ? removeBackground(img, keySettings()).canvas : img;
    stStageDirty = true;
    stStatus = `${layer.label} generated`;
    if (layer.keyBg) autoDetectLayer(idx, idx === 1 ? 240 : 150); // suggest a starting position
  } catch (e) {
    stStatus = `${layer.label} generation failed: ${(e as Error).message}`;
  }
  stStageLayerBusy[idx] = false;
  renderAll();
};

const renderStageTab = (): HTMLElement => {
  void (async () => {
    if (stStageList.length === 0) {
      try { stStageList = await apiJson<string[]>('/api/stages'); } catch { /* none */ }
      if (!stStageMeta) await loadStageEd(stStageList[0] ?? 'rooftop');
    }
  })();

  const m = stStageMeta;
  if (!m) return mkEl('div', { class: 'pane' }, 'loading stage…');

  // Preview canvas: composites every plane at its REAL configured world
  // position (not just stretched to fill the box) — this is what makes the
  // preview trustworthy for manual positioning. World px <-> preview px
  // conversion: the backdrop plane always fills the whole `pw`-wide canvas
  // and by definition spans the FULL stage width (STAGE.widthPx), so
  // 1 world px = pw/STAGE.widthPx preview px, uniformly for X and Y (the
  // engine never scales the two axes independently).
  const pw = 768;
  const ph = Math.round(pw * (m.imageH / m.imageW));
  const worldToPx = pw / STAGE.widthPx;
  const cv = mkEl('canvas', { width: pw, height: ph, class: 'frcanvas', style: 'cursor:crosshair' });

  // VIEW LOCK region (world px). Absent meta.bounds reads as the full stage;
  // `ensureBounds` materializes it on first edit so the drag/inputs can mutate.
  const MIN_REGION = 240; // world px — keep the playfield from collapsing
  const viewBounds = (): { left: number; right: number } => m.bounds ?? { left: 0, right: STAGE.widthPx };
  const ensureBounds = (): { left: number; right: number } =>
    (m.bounds ??= { left: 0, right: STAGE.widthPx });

  /** Selected layer's on-screen draw rect (preview px), or null (backdrop/none). */
  const selRect = (): { x: number; y: number; w: number; h: number } | null => {
    if (stStageSelLayer < 0) return null;
    const l = stStageLayers[stStageSelLayer]!;
    if (!l.img || l.keyBg === false) return null;
    const iw = l.img instanceof HTMLCanvasElement ? l.img.width : l.img.naturalWidth;
    const ih = l.img instanceof HTMLCanvasElement ? l.img.height : l.img.naturalHeight;
    const fy = (m.floorY / m.imageH) * ph;
    return {
      x: l.offsetX * worldToPx,
      y: fy + l.offsetY * worldToPx,
      w: iw * l.scale * worldToPx,
      h: ih * l.scale * worldToPx,
    };
  };

  const paint = (): void => {
    const ctx = cv.getContext('2d')!;
    ctx.fillStyle = m.skyColor;
    ctx.fillRect(0, 0, pw, ph);
    const anyArt = stStageImg || stStageLayers.some((l) => l.img);
    ctx.imageSmoothingEnabled = false;
    if (anyArt) {
      if (stStageImg) ctx.drawImage(stStageImg, 0, 0, pw, ph);
      for (const l of stStageLayers) {
        if (!l.img) continue;
        if (!l.keyBg) { ctx.drawImage(l.img, 0, 0, pw, ph); continue; } // backdrop: stretch to frame
        const iw = l.img instanceof HTMLCanvasElement ? l.img.width : l.img.naturalWidth;
        const ih = l.img instanceof HTMLCanvasElement ? l.img.height : l.img.naturalHeight;
        const fy = (m.floorY / m.imageH) * ph;
        const x = l.offsetX * worldToPx;
        const y = fy + l.offsetY * worldToPx;
        const tileW = iw * l.scale * worldToPx;
        const h = ih * l.scale * worldToPx;
        if (tileW < 1) continue;
        // Ping-pong tile across the whole preview, matching the runtime's
        // in-game tiling (chrome.ts drawStageLayers) — a single un-tiled
        // instance made narrow layers (a fence) look broken/cut off here
        // even though the real game repeats them seamlessly.
        const startK = Math.floor(-x / tileW) - 1;
        const endK = Math.ceil((pw - x) / tileW) + 1;
        for (let k = startK; k <= endK; k++) {
          const tx = x + k * tileW;
          const mirrored = (((k % 2) + 2) % 2) === 1;
          ctx.save();
          if (mirrored) {
            ctx.translate(tx + tileW, y);
            ctx.scale(-1, 1);
            ctx.drawImage(l.img, 0, 0, tileW, h);
          } else {
            ctx.drawImage(l.img, tx, y, tileW, h);
          }
          ctx.restore();
        }
      }
    } else {
      ctx.fillStyle = '#8a91a8';
      ctx.font = '14px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('no background yet — generate or upload one below', pw / 2, ph / 2);
    }
    // Floor line: where the fighters' feet sit.
    const fy = (m.floorY / m.imageH) * ph;
    ctx.strokeStyle = '#ffd166';
    ctx.setLineDash([8, 6]);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, fy);
    ctx.lineTo(pw, fy);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#ffd166';
    ctx.font = 'bold 12px monospace';
    ctx.textAlign = 'left';
    ctx.fillText(`floor y=${m.floorY}${stStageSelLayer < 0 ? ' (drag)' : ''}`, 8, fy - 6);
    // VIEW LOCK: shade the region the camera/walls exclude, and draw draggable
    // left/right handles. Editable in the same "no layer selected" mode as the
    // floor line, so it never fights with layer positioning.
    {
      const bx = viewBounds();
      const lx = bx.left * worldToPx;
      const rx = bx.right * worldToPx;
      ctx.fillStyle = 'rgba(8,10,20,0.62)';
      if (lx > 0) ctx.fillRect(0, 0, lx, ph);
      if (rx < pw) ctx.fillRect(rx, 0, pw - rx, ph);
      ctx.strokeStyle = '#39d3c8';
      ctx.setLineDash([6, 5]);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(lx, 0); ctx.lineTo(lx, ph);
      ctx.moveTo(rx, 0); ctx.lineTo(rx, ph);
      ctx.stroke();
      ctx.setLineDash([]);
      // Grab tabs so the thin lines are easy to hit.
      ctx.fillStyle = '#39d3c8';
      ctx.fillRect(lx - 3, ph / 2 - 16, 6, 32);
      ctx.fillRect(rx - 3, ph / 2 - 16, 6, 32);
      ctx.fillStyle = '#39d3c8';
      ctx.font = 'bold 12px monospace';
      const editing = stStageSelLayer < 0;
      ctx.textAlign = 'left';
      ctx.fillText(`L ${bx.left}${editing ? ' (drag)' : ''}`, Math.min(lx + 4, pw - 60), 16);
      ctx.textAlign = 'right';
      ctx.fillText(`R ${bx.right}`, Math.max(rx - 4, 60), 16);
      ctx.textAlign = 'left';
    }
    // Selection box + resize handle for the layer being positioned.
    const sr = selRect();
    if (sr) {
      ctx.strokeStyle = '#e94560';
      ctx.lineWidth = 2;
      ctx.strokeRect(sr.x + 1, sr.y + 1, sr.w - 2, sr.h - 2);
      ctx.fillStyle = '#e94560';
      ctx.fillRect(sr.x + sr.w - 6, sr.y + sr.h - 6, 12, 12);
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 11px monospace';
      ctx.textAlign = 'left';
      ctx.fillText(`${stStageLayers[stStageSelLayer]!.label} — drag to move, corner to resize`, sr.x + 2, sr.y - 4);
    }
  };
  // setTimeout, NOT rAF — hidden tabs throttle rAF to zero (automation runs headless).
  setTimeout(paint, 0);

  type DragMode = 'floor' | 'move' | 'scale' | 'boundL' | 'boundR' | null;
  let dragMode: DragMode = null;
  let dragStart = { x: 0, y: 0, offsetX: 0, offsetY: 0, scale: 0 };
  cv.onmousedown = (e) => {
    const r = cv.getBoundingClientRect();
    const px_ = e.clientX - r.left, py_ = e.clientY - r.top;
    const sr = selRect();
    const bx = viewBounds();
    const nearL = Math.abs(px_ - bx.left * worldToPx) <= 6;
    const nearR = Math.abs(px_ - bx.right * worldToPx) <= 6;
    if (sr && px_ >= sr.x + sr.w - 10 && px_ <= sr.x + sr.w + 4 && py_ >= sr.y + sr.h - 10 && py_ <= sr.y + sr.h + 4) {
      dragMode = 'scale';
    } else if (sr) {
      dragMode = 'move';
    } else if (nearL) {
      dragMode = 'boundL';
    } else if (nearR) {
      dragMode = 'boundR';
    } else {
      dragMode = 'floor';
    }
    const l = stStageSelLayer >= 0 ? stStageLayers[stStageSelLayer]! : null;
    dragStart = { x: px_, y: py_, offsetX: l?.offsetX ?? 0, offsetY: l?.offsetY ?? 0, scale: l?.scale ?? 1 };
  };
  cv.onmousemove = (e) => {
    if (!dragMode) return;
    const r = cv.getBoundingClientRect();
    const px_ = e.clientX - r.left, py_ = e.clientY - r.top;
    if (dragMode === 'boundL' || dragMode === 'boundR') {
      const b = ensureBounds();
      const wx = Math.max(0, Math.min(STAGE.widthPx, Math.round(px_ / worldToPx)));
      if (dragMode === 'boundL') b.left = Math.min(wx, b.right - MIN_REGION);
      else b.right = Math.max(wx, b.left + MIN_REGION);
      b.left = Math.max(0, b.left);
      b.right = Math.min(STAGE.widthPx, b.right);
      stStageDirty = true;
      paint();
      return;
    }
    if (dragMode === 'floor') {
      m.floorY = Math.max(0, Math.min(m.imageH, Math.round((py_ / ph) * m.imageH)));
      stStageDirty = true;
      paint();
      return;
    }
    const l = stStageLayers[stStageSelLayer]!;
    if (dragMode === 'move') {
      l.offsetX = Math.round(dragStart.offsetX + (px_ - dragStart.x) / worldToPx);
      l.offsetY = Math.round(dragStart.offsetY + (py_ - dragStart.y) / worldToPx);
    } else if (dragMode === 'scale') {
      const dy = (py_ - dragStart.y) / worldToPx;
      const iw = l.img instanceof HTMLCanvasElement ? l.img.height : (l.img?.naturalHeight ?? 1);
      l.scale = Math.max(0.02, dragStart.scale + dy / Math.max(1, iw));
    }
    stStageDirty = true;
    paint();
  };
  cv.onmouseup = cv.onmouseleave = () => { dragMode = null; };

  const upload = mkEl('input', {
    type: 'file', accept: 'image/png,image/svg+xml,image/jpeg',
    onchange: (e: Event) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      const img = new Image();
      img.onload = () => {
        stStageImg = img;
        stStageMeta!.imageW = img.naturalWidth;
        stStageMeta!.imageH = img.naturalHeight;
        stStageDirty = true;
        stStatus = `loaded ${file.name} (${img.naturalWidth}×${img.naturalHeight})`;
        renderAll();
      };
      img.src = URL.createObjectURL(file);
    },
  });

  return mkEl('div', { class: 'pane' },
    mkEl('div', { class: 'row' },
      mkEl('label', {}, 'stage ', selInput(stStageId, [...new Set([...stStageList, stStageId])], (id) => { void loadStageEd(id); })),
      mkEl('button', {
        onclick: () => { stNewStage = { id: '' }; renderAll(); },
      }, '+ new'),
      mkEl('button', {
        class: stStageDirty ? 'save dirty' : 'save',
        onclick: () => void saveStageEd(),
      }, stStageDirty ? 'save stage *' : 'save stage'),
    ),
    mkEl('div', { class: 'genblock' },
      mkEl('b', {}, 'flat background (legacy single plane) · generate or upload (PNG/SVG)'),
      mkEl('p', { class: 'hint' },
        'a simple one-image stage, exactly like before. For a layered/parallax look, use the 3 planes below instead — '
        + 'they combine with this one if you keep it, or replace it entirely if you leave it empty.'),
      mkEl('div', { class: 'row' },
        mkEl('input', {
          id: 'stageprompt', style: 'width:460px',
          placeholder: 'e.g. anime city rooftop at dusk, purple sunset sky, empty concrete floor at the bottom',
        }),
        mkEl('label', {}, ' engine ', sessionSelect(
          stStageProvider,
          Object.entries(stAvailable).filter(([, ok]) => ok).map(([p]) => p),
          (v) => { stStageProvider = v; },
        )),
        mkEl('button', {
          disabled: stStageBusy ? '' : null,
          onclick: () => {
            void (async () => {
              const p = (document.getElementById('stageprompt') as HTMLInputElement).value.trim();
              if (!p) { stStatus = 'enter a stage prompt'; renderAll(); return; }
              stStageBusy = true;
              stStatus = `generating stage via ${stStageProvider}…`; renderAll();
              try {
                // No reference to condition on — set dressing has no identity
                // to hold, so this is a plain text-to-image call on whichever
                // engine is picked (NVIDIA is fine and cheap for this).
                const img = await generateImage(
                  `${p}, anime background art, no text`, (Math.random() * 1e6) | 0,
                  1536, 640, false, stStageProvider);
                stStageImg = img;
                stStageMeta!.imageW = img.naturalWidth;
                stStageMeta!.imageH = img.naturalHeight;
                stStageDirty = true;
                stStatus = 'stage generated — set the floor line, then save';
              } catch (e) {
                stStatus = `stage generation failed: ${(e as Error).message}`;
              }
              stStageBusy = false;
              renderAll();
            })();
          },
        }, stStageBusy ? 'generating…' : 'generate'),
        mkEl('label', {}, ' or upload ', upload),
        stStageImg ? mkEl('button', {
          title: 'clear this plane (keep the layer planes below, if any)',
          onclick: () => { stStageImg = null; stStageDirty = true; renderAll(); },
        }, 'clear') : null,
      ),
    ),
    cv,
    mkEl('div', { class: 'row' },
      mkEl('label', { class: 'field' }, 'sky color ', mkEl('input', {
        type: 'color', value: m.skyColor,
        onchange: (e: Event) => { m.skyColor = (e.target as HTMLInputElement).value; stStageDirty = true; renderAll(); },
      })),
      mkEl('label', { class: 'field' }, 'deck color ', mkEl('input', {
        type: 'color', value: m.deckColor,
        onchange: (e: Event) => { m.deckColor = (e.target as HTMLInputElement).value; stStageDirty = true; renderAll(); },
      })),
      mkEl('span', { class: 'hint' },
        'floor line = where fighters\' feet sit in the image · sky/deck colors extend every plane when the camera sees past it'),
    ),
    mkEl('div', { class: 'row' },
      mkEl('label', { class: 'field', title: 'left edge of the playfield in world px (0..' + STAGE.widthPx + ') — camera + walls lock here. Drag the cyan handle in the preview too.' },
        'view-lock left ', mkEl('input', {
          type: 'number', min: '0', max: String(STAGE.widthPx), step: '10', value: String(viewBounds().left),
          onchange: (e: Event) => {
            const b = ensureBounds();
            const v = Math.round(Number((e.target as HTMLInputElement).value) || 0);
            b.left = Math.max(0, Math.min(v, b.right - MIN_REGION));
            stStageDirty = true; renderAll();
          },
        })),
      mkEl('label', { class: 'field', title: 'right edge of the playfield in world px' },
        'right ', mkEl('input', {
          type: 'number', min: '0', max: String(STAGE.widthPx), step: '10', value: String(viewBounds().right),
          onchange: (e: Event) => {
            const b = ensureBounds();
            const v = Math.round(Number((e.target as HTMLInputElement).value) || STAGE.widthPx);
            b.right = Math.min(STAGE.widthPx, Math.max(v, b.left + MIN_REGION));
            stStageDirty = true; renderAll();
          },
        })),
      m.bounds ? mkEl('button', {
        title: 'remove the view lock — camera + walls use the full stage width again',
        onclick: () => { delete m.bounds; stStageDirty = true; renderAll(); },
      }, 'full width') : null,
      mkEl('span', { class: 'hint' },
        `view lock: the region the camera pans within and fighters are walled to (world px, 0..${STAGE.widthPx}). Absent = full width.`),
    ),
    mkEl('div', { class: 'genblock' },
      mkEl('b', {}, 'parallax planes — depth-scrolling background, midground, foreground'),
      mkEl('p', { class: 'hint' },
        'each plane is its own image, drawn at a different scroll speed as the camera moves (far = slower, near = faster). '
        + 'Background stays opaque; midground/foreground are auto-keyed transparent so the planes behind them show through. '
        + 'Depth: 1.0 = moves with the fighters, 0 = never moves (infinitely far).'),
      stStageImg ? mkEl('div', { class: 'row' },
        mkEl('button', {
          title: 'copy the flat background above into the Background plane, then clear it — a quick way to turn an existing single-image stage into a layered one',
          onclick: () => {
            stStageLayers[0]!.img = canvasOf(stStageImg!);
            stStageImg = null;
            stStageDirty = true;
            stStatus = 'promoted flat background → Background plane';
            renderAll();
          },
        }, '↑ promote flat background to Background plane'),
      ) : null,
      ...stStageLayers.map((layer, idx) => {
        const thumbSize = 140;
        const thumb = mkEl('canvas', { width: thumbSize, height: thumbSize, class: 'thumb' });
        const tctx = thumb.getContext('2d')!;
        tctx.fillStyle = '#12141f';
        tctx.fillRect(0, 0, thumbSize, thumbSize);
        if (layer.img) {
          tctx.imageSmoothingEnabled = false;
          const iw = layer.img instanceof HTMLCanvasElement ? layer.img.width : layer.img.naturalWidth;
          const ih = layer.img instanceof HTMLCanvasElement ? layer.img.height : layer.img.naturalHeight;
          const s = Math.min(thumbSize / iw, thumbSize / ih);
          tctx.drawImage(layer.img, (thumbSize - iw * s) / 2, (thumbSize - ih * s) / 2, iw * s, ih * s);
        }
        const layerUpload = mkEl('input', {
          type: 'file', accept: 'image/png',
          onchange: (e: Event) => {
            const file = (e.target as HTMLInputElement).files?.[0];
            if (!file) return;
            const img = new Image();
            img.onload = () => {
              layer.img = layer.keyBg ? removeBackground(img, keySettings()).canvas : img;
              stStageDirty = true;
              if (layer.keyBg) autoDetectLayer(idx, idx === 1 ? 240 : 150);
              renderAll();
            };
            img.src = URL.createObjectURL(file);
          },
        });
        return mkEl('div', { class: 'genblock', style: 'margin-top:10px' },
          mkEl('div', { class: 'row' },
            thumb,
            mkEl('div', {},
              mkEl('b', {}, layer.label),
              mkEl('div', { class: 'row' },
                mkEl('input', { id: `stagelayer-${idx}`, style: 'width:360px', placeholder: layer.hint }),
                mkEl('button', {
                  disabled: stStageLayerBusy[idx] ? '' : null,
                  onclick: () => void generateStageLayer(idx),
                }, stStageLayerBusy[idx] ? '…' : 'generate'),
                mkEl('label', {}, ' or upload ', layerUpload),
              ),
              mkEl('div', { class: 'row' },
                mkEl('label', { class: 'field' }, 'depth', numInput(layer.depth, (v) => { layer.depth = v; stStageDirty = true; }, 54)),
                layer.img ? mkEl('button', {
                  onclick: () => { layer.img = null; stStageDirty = true; renderAll(); },
                }, 'clear') : null,
              ),
              layer.keyBg ? mkEl('div', { class: 'row' },
                mkEl('button', {
                  class: stStageSelLayer === idx ? 'tab active' : 'tab',
                  disabled: layer.img ? null : '',
                  title: 'select this plane, then drag it in the preview above to move — drag its corner to resize',
                  onclick: () => { stStageSelLayer = stStageSelLayer === idx ? -1 : idx; renderAll(); },
                }, stStageSelLayer === idx ? '● positioning (click to stop)' : '◌ position in preview'),
                mkEl('button', {
                  disabled: layer.img ? null : '',
                  title: 'suggest scale/position from this image\'s actual opaque content — a starting point, not the final word',
                  onclick: () => autoDetectLayer(idx, idx === 1 ? 240 : 150),
                }, 'auto-detect'),
              ) : null,
              layer.keyBg ? mkEl('div', { class: 'row' },
                mkEl('label', { class: 'field', title: 'world px per source px' }, 'scale',
                  numInput(layer.scale, (v) => { layer.scale = Math.max(0.01, v); stStageDirty = true; }, 54)),
                mkEl('label', { class: 'field', title: 'world-px horizontal position' }, 'x',
                  numInput(layer.offsetX, (v) => { layer.offsetX = v; stStageDirty = true; }, 54)),
                mkEl('label', { class: 'field', title: 'world-px position of the image\'s top edge, relative to the floor line' }, 'y',
                  numInput(layer.offsetY, (v) => { layer.offsetY = v; stStageDirty = true; }, 54)),
              ) : null,
            ),
          ),
        );
      }),
    ),
  );
};

// ============================================================ PETS (ADR 0011)
/**
 * The Pets tab. A pet is the simplest asset in the repo — `pets/<id>/pet.json`
 * (a PetDef) plus its frames — so this tab is deliberately small: generate or
 * upload an image, key out its background, trim it, save.
 *
 * WHAT THIS TAB DOES NOT DO: auras. Every line is rolled per-adoption by the
 * match server (ADR 0011), so two players owning the same pet own different
 * auras. There is nothing here to balance and nothing here to cheat.
 */
interface PetEd {
  id: string;
  name: string;
  desc: string;
  flavor: string;
  tint: string;
  sizePx: number;
  fps: number;
  motion: 'float' | 'ground';
  sprites: string[];
  disabled?: boolean;
}

let stPetList: { id: string; def: PetEd }[] = [];
let stPetEd: PetEd | null = null;
/** Decoded frames for the preview, index-aligned with the saved sprite list. */
let stPetFrames: (HTMLCanvasElement | null)[] = [];
let stPetPrompt = 'a tiny cute robotic companion creature, floating drone pet, '
  + 'glowing accents, chunky readable silhouette, side view, full body';
let stNewPet: { id: string } | null = null;
/**
 * Background keying policy for incoming frames.
 * 'auto'   — key only art that arrives with an opaque background (the default);
 * 'always' — force the pass (a flat-colour render the detector misreads);
 * 'never'  — trust the file exactly as uploaded.
 */
let stPetKey: 'auto' | 'always' | 'never' = 'auto';

const petDefaults = (id: string): PetEd => ({
  id,
  name: id.toUpperCase(),
  desc: '',
  flavor: '',
  tint: '#6fd3ff',
  sizePx: 44,
  fps: 8,
  motion: 'float',
  sprites: [],
});

const loadPetEd = async (id: string): Promise<void> => {
  const hit = stPetList.find((p) => p.id === id);
  stPetEd = { ...petDefaults(id), ...(hit?.def ?? {}), id };
  stPetFrames = [];
  for (const name of stPetEd.sprites) {
    // Cache-bust: the Studio rewrites these constantly and a stale frame
    // would quietly misrepresent what is on disk.
    const img = await new Promise<HTMLImageElement | null>((resolve) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => resolve(null);
      i.src = `/pets/${id}/${name}?v=${Date.now()}`;
    });
    if (!img) { stPetFrames.push(null); continue; }
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    c.getContext('2d')!.drawImage(img, 0, 0);
    stPetFrames.push(c);
  }
  renderAll();
};

/** Write pet.json + every frame. Writing the FOLDER is the whole publish. */
const savePet = async (): Promise<void> => {
  const p = stPetEd;
  if (!p) return;
  try {
    for (let i = 0; i < stPetFrames.length; i++) {
      const c = stPetFrames[i];
      if (!c) continue;
      await apiJson(`/api/pets/${p.id}/frame${i}.png`, {
        method: 'PUT', body: canvasToPngDataUrl(c),
      });
    }
    const def = {
      id: p.id,
      name: p.name,
      desc: p.desc,
      flavor: p.flavor,
      tint: p.tint,
      sizePx: p.sizePx,
      fps: p.fps,
      motion: p.motion,
      sprites: stPetFrames
        .map((c, i) => (c ? `frame${i}.png` : null))
        .filter((n): n is string => n !== null),
      ...(p.disabled ? { disabled: true } : {}),
    };
    await apiJson(`/api/pets/${p.id}/pet.json`, {
      method: 'PUT', body: JSON.stringify(def, null, 2),
    });
    stPetList = await apiJson<{ id: string; def: PetEd }[]>('/api/pets');
    stStatus = `saved pet "${p.id}" (${def.sprites.length} frame(s)) — restart the `
      + 'match server to put it in the adoption pool';
  } catch (e) {
    stStatus = `PET SAVE FAILED: ${(e as Error).message}`;
  }
  renderAll();
};

/** Key out the background, trim to the creature, add it as a frame. */
/**
 * Does this image ALREADY have a cut-out background?
 *
 * Samples the border ring rather than the whole bitmap: a keyed sprite is
 * transparent at its edges, an un-keyed one (a flat-colour render, a photo)
 * is opaque there. Cheap, and it cannot be fooled by interior transparency
 * (a donut shape) the way a whole-image alpha count can.
 */
const alreadyCutOut = (img: HTMLImageElement | HTMLCanvasElement): boolean => {
  const w = img instanceof HTMLCanvasElement ? img.width : img.naturalWidth;
  const h = img instanceof HTMLCanvasElement ? img.height : img.naturalHeight;
  if (w < 2 || h < 2) return false;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.getContext('2d')!.drawImage(img, 0, 0);
  const d = c.getContext('2d', { willReadFrequently: true })!
    .getImageData(0, 0, w, h).data;
  let clear = 0;
  let seen = 0;
  const at = (x: number, y: number): void => {
    seen++;
    if (d[(y * w + x) * 4 + 3]! < 16) clear++;
  };
  for (let x = 0; x < w; x++) { at(x, 0); at(x, h - 1); }
  for (let y = 0; y < h; y++) { at(0, y); at(w - 1, y); }
  return seen > 0 && clear / seen > 0.6;
};

/**
 * Add one frame to the strip.
 *
 * KEYING IS NOT UNCONDITIONAL. Running background removal over art that is
 * already cut out is worse than useless: the border sample lands on
 * transparent pixels, so the key colour is meaningless and the pass eats
 * holes straight through the sprite's dark pixels (it did exactly that to a
 * pixel-art upload). An image that arrives with its background already gone
 * is passed through untouched; `stPetKey` forces the old behaviour when a
 * flat-background render genuinely needs it.
 */
const toCanvas = (img: HTMLImageElement | HTMLCanvasElement): HTMLCanvasElement => {
  if (img instanceof HTMLCanvasElement) return img;
  const c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  c.getContext('2d')!.drawImage(img, 0, 0);
  return c;
};

const addPetFrame = (img: HTMLImageElement | HTMLCanvasElement): void => {
  const key = stPetKey === 'auto' ? !alreadyCutOut(img) : stPetKey === 'always';
  const base = key ? removeBackground(img, keySettings()).canvas : toCanvas(img);
  // A fully transparent result means the pass destroyed the art — keep the
  // ORIGINAL rather than pushing an empty frame.
  stPetFrames.push(cropToAlpha(base, 0.04) ?? toCanvas(img));
  stStatus = `frame ${stPetFrames.length} added — `
    + (key ? 'background keyed out' : 'kept its own transparency (not keyed)')
    + ' — save the pet to publish it';
  renderAll();
};

const renderPetsTab = (): HTMLElement => {
  void (async () => {
    if (stPetList.length === 0) {
      try {
        stPetList = await apiJson<{ id: string; def: PetEd }[]>('/api/pets');
      } catch { /* none published yet */ }
      if (!stPetEd && stPetList[0]) await loadPetEd(stPetList[0].id);
      else renderAll();
    }
  })();

  const pane = mkEl('div', { class: 'pane' });
  pane.append(mkEl('div', { class: 'row' },
    mkEl('b', {}, 'PET'),
    sessionSelect(stPetEd?.id ?? '', stPetList.map((p) => p.id), (id) => { void loadPetEd(id); }),
    mkEl('button', { onclick: () => { stNewPet = { id: '' }; renderAll(); } }, '+ new pet')));

  const p = stPetEd;
  if (!p) {
    pane.append(mkEl('p', { class: 'hint' },
      'No pets yet. "+ new pet" writes pets/<id>/ — the match server reads that '
      + 'directory to build its adoption pool, so a new folder IS a new pet.'));
    return pane;
  }

  // ---- animated preview, on a dark plate (a pet is seen mid-fight)
  const cv = mkEl('canvas', { width: 320, height: 220, class: 'frcanvas' });
  const paint = (): void => {
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    const g = ctx.createLinearGradient(0, 0, 0, 220);
    g.addColorStop(0, '#141a24');
    g.addColorStop(1, '#080b11');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 320, 220);
    const t = Math.floor(performance.now() / 16.67);
    const cx = 160;
    const cy = 105 + Math.sin(t * 0.06) * 5;
    // The same aura glow the game draws behind the companion.
    const glow = ctx.createRadialGradient(cx, cy, 1, cx, cy, p.sizePx);
    glow.addColorStop(0, `${p.tint}66`);
    glow.addColorStop(1, `${p.tint}00`);
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(cx, cy, p.sizePx, 0, Math.PI * 2);
    ctx.fill();
    const live = stPetFrames.filter((c): c is HTMLCanvasElement => c !== null);
    if (live.length > 0) {
      const fps = Math.max(1, Math.min(30, p.fps));
      const img = live[Math.floor((t * fps) / 60) % live.length]!;
      const h = p.sizePx * 2; // 2× so pixel work is actually judgeable here
      const w = (img.width / img.height) * h;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(img, cx - w / 2, cy - h / 2, w, h);
    } else {
      ctx.fillStyle = '#8a91a8';
      ctx.font = '13px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('no art yet — the game draws a', cx, cy - 6);
      ctx.fillText('procedural companion in this tint', cx, cy + 12);
    }
    ctx.fillStyle = '#8a91a8';
    ctx.font = '11px monospace';
    ctx.textAlign = 'left';
    ctx.fillText(`${p.sizePx}px in world · ${p.fps} fps · ${live.length} frame(s)`, 8, 210);
  };
  paint();
  // rAF is throttled to 0 in a hidden pane — setInterval keeps this alive.
  const timer = window.setInterval(() => {
    if (!cv.isConnected) { window.clearInterval(timer); return; }
    paint();
  }, 50);

  const txt = (
    label: string, value: string, onCommit: (v: string) => void, width = 240,
  ): HTMLElement =>
    mkEl('label', { class: 'row' }, `${label} `,
      mkEl('input', {
        value,
        style: `width:${width}px`,
        onchange: (e: Event) => { onCommit((e.target as HTMLInputElement).value); renderAll(); },
      }));

  const meta = mkEl('div', {},
    txt('name', p.name, (v) => { p.name = v.toUpperCase().slice(0, 32); }),
    txt('desc', p.desc, (v) => { p.desc = v.toUpperCase().slice(0, 60); }, 340),
    txt('flavor', p.flavor, (v) => { p.flavor = v.slice(0, 90); }, 340),
    mkEl('div', { class: 'row' },
      'tint ',
      mkEl('input', {
        type: 'color', value: p.tint,
        onchange: (e: Event) => { p.tint = (e.target as HTMLInputElement).value; renderAll(); },
      }),
      ' size ', numInputClean(p.sizePx, (v) => { p.sizePx = Math.max(16, Math.min(120, Math.round(v))); }),
      ' fps ', numInputClean(p.fps, (v) => { p.fps = Math.max(1, Math.min(30, Math.round(v))); })),
    mkEl('div', { class: 'row' },
      'moves ',
      sessionSelect(p.motion, ['float', 'ground'], (v) => {
        p.motion = v === 'ground' ? 'ground' : 'float';
      }),
      mkEl('span', { class: 'hint' },
        p.motion === 'ground'
          ? 'walks the stage floor — stays down when the fighter jumps'
          : 'hovers at shoulder height — rises with the fighter'),
    ),
    mkEl('label', { class: 'row' },
      mkEl('input', {
        type: 'checkbox', checked: !!p.disabled,
        onchange: (e: Event) => {
          p.disabled = (e.target as HTMLInputElement).checked;
          renderAll();
        },
      }),
      ' disabled — stays owned by whoever adopted it, stops dropping'),
  );

  pane.append(mkEl('div', { class: 'row', style: 'align-items:flex-start;gap:18px' }, cv, meta));

  // ---- frame strip
  if (stPetFrames.some((c) => c !== null)) {
    const strip = mkEl('div', { class: 'row', style: 'flex-wrap:wrap;gap:8px' });
    stPetFrames.forEach((c, i) => {
      if (!c) return;
      const thumb = mkEl('canvas', { width: 72, height: 72, class: 'frcanvas' });
      const tctx = thumb.getContext('2d')!;
      tctx.fillStyle = '#0d1117';
      tctx.fillRect(0, 0, 72, 72);
      const s = Math.min(64 / c.width, 64 / c.height);
      tctx.imageSmoothingEnabled = false;
      tctx.drawImage(c, 36 - (c.width * s) / 2, 36 - (c.height * s) / 2, c.width * s, c.height * s);
      strip.append(mkEl('div', {}, thumb,
        mkEl('div', { class: 'row' },
          mkEl('button', { onclick: () => { stPetFrames.splice(i, 1); renderAll(); } }, '✕'),
          mkEl('button', { onclick: () => { stPetFrames[i] = flipCanvasH(c); renderAll(); } }, '↔'))));
    });
    pane.append(mkEl('h4', {}, `frames (played in order at ${p.fps} fps)`), strip);
  }

  // ---- generate / upload
  const promptBox = mkEl('textarea', {
    style: 'width:100%;height:56px',
    onchange: (e: Event) => { stPetPrompt = (e.target as HTMLTextAreaElement).value; },
  }, stPetPrompt);

  const genBtn = mkEl('button', {
    onclick: () => {
      void (async () => {
        stStatus = 'generating pet…';
        renderAll();
        try {
          const img = await generateImage(
            `${stPetPrompt}, on a ${bgPhrase()} background, no shadows, no floor`,
            (Math.random() * 1e9) | 0, 1024, 1024, false, stSpriteProvider);
          addPetFrame(img);
        } catch (e) {
          stStatus = `generate failed: ${(e as Error).message}`;
          renderAll();
        }
      })();
    },
  }, '✨ generate a frame');

  const upload = mkEl('input', {
    type: 'file', accept: 'image/png,image/jpeg,image/webp',
    onchange: (e: Event) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => addPetFrame(img);
        img.src = String(reader.result);
      };
      reader.readAsDataURL(file);
    },
  });

  pane.append(
    mkEl('h4', {}, 'art'),
    mkEl('p', { class: 'hint' },
      'Art that ALREADY has a transparent background is kept exactly as uploaded '
      + '— keying it again eats holes through the sprite. Anything with an opaque '
      + 'background is keyed (Generate tab key settings) and trimmed. A pet with '
      + 'NO frames is still publishable — the game draws a procedural companion '
      + 'in its tint.'),
    mkEl('div', { class: 'row' },
      'background ',
      sessionSelect(stPetKey, ['auto', 'always', 'never'], (v) => {
        stPetKey = v === 'always' ? 'always' : v === 'never' ? 'never' : 'auto';
      }),
      mkEl('span', { class: 'hint' },
        stPetKey === 'auto'
          ? 'key only art that arrives with an opaque background (recommended)'
          : stPetKey === 'always'
            ? 'force the key — for a flat-colour render auto misreads'
            : 'never key — trust the file exactly as uploaded'),
    ),
    promptBox,
    mkEl('div', { class: 'row' }, genBtn, mkEl('span', {}, ' or upload '), upload),
    mkEl('div', { class: 'row' },
      mkEl('button', { class: 'primary', onclick: () => { void savePet(); } }, '💾 save pet')),
    mkEl('p', { class: 'hint' },
      'AURAS ARE NOT SET HERE. The match server rolls every aura line at adoption '
      + 'time (ADR 0011) — rarity decides how MANY lines a pet rolls, never how '
      + 'strong they are.'),
  );

  return pane;
};

/** "+ new pet" — same modal pattern as new character / new stage. */
const renderNewPetDialog = (): HTMLElement | null => {
  if (!stNewPet) return null;
  const idIn = mkEl('input', {
    value: stNewPet.id,
    placeholder: 'lowercase-id',
    oninput: (e: Event) => { stNewPet!.id = (e.target as HTMLInputElement).value; },
  });
  return mkEl('div', { class: 'modal' },
    mkEl('div', { class: 'modalbox' },
      mkEl('h3', {}, 'new pet'),
      mkEl('div', { class: 'row' }, 'id ', idIn),
      mkEl('p', { class: 'hint' }, 'The folder name IS the id — pets/<id>/pet.json.'),
      mkEl('div', { class: 'row' },
        mkEl('button', {
          class: 'primary',
          onclick: () => {
            const id = stNewPet!.id.trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
            if (!id) return;
            stNewPet = null;
            stPetEd = petDefaults(id);
            stPetFrames = [];
            stStatus = `new pet "${id}" — generate or upload art, then save`;
            renderAll();
          },
        }, 'create'),
        mkEl('button', { onclick: () => { stNewPet = null; renderAll(); } }, 'cancel'))));
};


const renderAll = (): void => {
  const app = document.getElementById('app')!;
  cancelAnimationFrame(stRaf);
  app.replaceChildren();
  if (!stBundle) {
    app.append(mkEl('div', { class: 'pane' }, stStatus));
    return;
  }
  app.append(renderHeader());
  switch (stTab) {
    case 'character': app.append(renderCharacterTab()); break;
    case 'frames': app.append(renderFramesTab()); break;
    case 'moves': app.append(renderMovesTab()); break;
    case 'cancels': app.append(renderCancelsTab()); break;
    case 'test': app.append(renderTestTab()); break;
    case 'generate': app.append(renderGenerateTab()); break;
    case 'stage': app.append(renderStageTab()); break;
    case 'pets': app.append(renderPetsTab()); break;
  }
  for (const dlg of [renderNewCharDialog(), renderNewStageDialog(), renderNewPetDialog(),
    renderConfirmDialog()]) {
    if (dlg) app.append(dlg);
  }
};

// boot
void (async () => {
  try {
    const caps = await apiJson<{ provider: string; img2img: boolean; available: Record<string, boolean> }>('/api/capabilities');
    stAvailable = caps.available;
    // Character reference + sprite engines default to the server's configured
    // IMAGE_PROVIDER (the one with a proven key); each is overridable per
    // category in the Generate tab.
    stRefProvider = caps.provider;
    stSpriteProvider = caps.provider;
    stImg2Img = isImg2Img(stSpriteProvider);
    // Stage set-dressing needs no identity lock — prefer cheap NVIDIA if keyed,
    // else the configured provider.
    stStageProvider = stAvailable.nvidia ? 'nvidia' : caps.provider;
    stCharList = await apiJson<string[]>('/api/characters');
    if (stCharList.length === 0) throw new Error('no characters found');
    await loadChar(stCharList.includes('analog') ? 'analog' : stCharList[0]!);
  } catch (e) {
    stStatus = `boot failed: ${(e as Error).message}`;
  }
  renderAll();
})();

// Dev hooks: exercise the keyer from the console (and automated checks)
// without going through a paid generation call.
Object.assign(globalThis, {
  afRemoveBackground: removeBackground,
  afKeySettings: keySettings,
  afSetLastRaw: (img: HTMLImageElement): void => { stLastRaw = img; stKeyPreview = null; renderAll(); },
});
