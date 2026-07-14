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
  CELL_W, PIVOT_X, PIVOT_Y, alphaBounds, autoHurtboxes, canvasToPngDataUrl,
  decodeBase64Image, diffHitboxDraft, enclosedWhitePockets, extractPalette,
  flipCanvasH, maskDiff, meanChroma, mirrorMask16, normalizeFrame, qcScore,
  silhouetteMask16, sliceStrip,
} from './pipeline.js';
import type { NormalizedFrame, QCResult, RGB } from './pipeline.js';

interface StudioMeta {
  desc?: string;
  palette?: RGB[];
  refBodyW?: number;
  refMask?: number[]; // 16×16 silhouette of the reference (facing detection)
  refChroma?: number; // mean chroma of the reference (desaturation QC)
  moveDesc?: Record<string, string>;
}

type TabName = 'character' | 'frames' | 'moves' | 'cancels' | 'test' | 'generate' | 'stage';

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
 * bundle ships a packed atlas, never hand-made). Cells are fixed-size so a
 * simple grid is optimal enough. Returns frame count, or 0 if no sprites.
 */
const packAtlas = async (): Promise<number> => {
  const names = [...new Set(
    stBundle!.moves.flatMap((mv) => mv.steps.map((s) => s.sprite)).filter((s): s is string => !!s))];
  if (names.length === 0) return 0;
  // Ensure every sprite is loaded (accepted-this-session ones are canvases already).
  const cells = await Promise.all(names.map(async (name) => {
    const cached = spriteImgs.get(`${stCharId}/${name}`);
    if (cached instanceof HTMLCanvasElement) return { name, img: cached as CanvasImageSource };
    const img = new Image();
    img.src = `/characters/${stCharId}/sprites/${name}`;
    await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error(`missing sprite ${name}`)); });
    return { name, img: img as CanvasImageSource };
  }));
  const cols = Math.ceil(Math.sqrt(cells.length));
  const rows = Math.ceil(cells.length / cols);
  const atlas = document.createElement('canvas');
  atlas.width = cols * CELL_W;
  atlas.height = rows * CELL_W;
  const ctx = atlas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  const frames: Record<string, { x: number; y: number; w: number; h: number; pivotX: number; pivotY: number }> = {};
  cells.forEach((c, k) => {
    const x = (k % cols) * CELL_W;
    const y = Math.floor(k / cols) * CELL_W;
    ctx.drawImage(c.img, x, y);
    frames[c.name] = { x, y, w: CELL_W, h: CELL_W, pivotX: PIVOT_X, pivotY: PIVOT_Y };
  });
  await apiJson(`/api/characters/${stCharId}/sprites/atlas.png`, {
    method: 'PUT', body: canvasToPngDataUrl(atlas),
  });
  await apiJson(`/api/characters/${stCharId}/sprites/atlas.json`, {
    method: 'PUT',
    body: JSON.stringify({ cellW: CELL_W, cellH: CELL_W, frames }, null, 2),
  });
  return cells.length;
};

/** Server capability: can the active image provider accept a reference image? */
let stImg2Img = false;

/** The locked reference sheet as base64 PNG (for reference-conditioned gen). */
const referenceB64 = (): string | null => {
  const ref = spriteCanvas('_reference.png');
  return ref ? canvasToPngDataUrl(ref) : null;
};

const generateImage = async (
  prompt: string, seed: number, width = 1024, height = 1024, useRef = false,
): Promise<HTMLImageElement> => {
  // With an img2img provider, every frame is conditioned on the reference
  // sheet — that is the ONLY way to truly hold a character's identity across
  // images. NVIDIA's flux cannot do this (see server.mjs).
  const image = useRef && stImg2Img ? referenceB64() : null;
  const body = image
    ? { prompt, width, height, steps: 4, seed, image }
    : { prompt, width, height, steps: 4, seed };
  const r = await apiJson<{ artifacts?: { base64: string }[]; b64_json?: string }>(
    '/api/generate',
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const b64 = r.artifacts?.[0]?.base64;
  if (!b64) throw new Error('no image in response');
  return decodeBase64Image(b64);
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

const getSprite = (name: string, charId = stCharId): HTMLCanvasElement | HTMLImageElement | null => {
  const key = `${charId}/${name}`;
  const hit = spriteImgs.get(key);
  if (hit) return hit;
  const img = new Image();
  img.src = `/characters/${charId}/sprites/${name}`;
  spriteImgs.set(key, img);
  return img.complete ? img : null;
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

const selInput = (value: string, options: string[], onCommit: (v: string) => void): HTMLSelectElement => {
  const s = mkEl('select', {
    onchange: (e: Event) => { onCommit((e.target as HTMLSelectElement).value); stDirty = true; renderAll(); },
  });
  for (const o of options) s.append(mkEl('option', { value: o, selected: o === value ? '' : null }, o || '(none)'));
  return s;
};

// ------------------------------------------------------------------ header
const renderHeader = (): HTMLElement => {
  const tabs: TabName[] = ['character', 'frames', 'moves', 'cancels', 'test', 'generate', 'stage'];
  return mkEl('div', { class: 'header' },
    mkEl('span', { class: 'logo' }, 'AF STUDIO'),
    selInput(stCharId, stCharList, (id) => { void loadChar(id).then(renderAll); }),
    mkEl('button', {
      onclick: () => {
        const id = prompt('new character id (lowercase, dashes):');
        if (!id || !/^[a-z0-9][a-z0-9-]{0,40}$/.test(id)) return;
        // New characters start as a copy of the current bundle (archetype reuse).
        const copy = structuredClone(stBundle!);
        copy.name = id[0]!.toUpperCase() + id.slice(1);
        for (const mv of copy.moves) for (const s of mv.steps) delete s.sprite;
        stBundle = copy;
        stCharId = id;
        stDirty = true;
        void saveChar().then(() => apiJson<string[]>('/api/characters')).then((l) => { stCharList = l; renderAll(); });
      },
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
const renderCharacterTab = (): HTMLElement => {
  const b = stBundle!;
  const field = (label: string, get: () => number, set: (v: number) => void): HTMLElement =>
    mkEl('label', { class: 'field' }, label, numInput(get(), set, 70));
  return mkEl('div', { class: 'pane grid' },
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
  if (stp.sprite) {
    const spr = getSprite(stp.sprite);
    if (spr) {
      const s = frSpriteScale;
      ctx.imageSmoothingEnabled = false;
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
    const bb = frSpriteBBox();
    if (bb && stp.sprite) {
      const hx = (bb.r + 1 - PIVOT_X) * frSpriteScale;
      const hy = (bb.t - PIVOT_Y) * frSpriteScale;
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
        onclick: () => {
          if (confirm(`Flip ALL of ${b.name}'s sprites horizontally? Use when the whole character faces the wrong way.`)) {
            void flipAllSprites();
          }
        },
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
            if (!confirm(`delete ${mv.id}?`)) return;
            b.moves.splice(i, 1);
            const gone = mv.id;
            b.cancels = b.cancels
              .filter((edge) => edge.from !== gone)
              .map((edge) => ({ ...edge, to: edge.to.filter((t) => t !== gone) }))
              .filter((edge) => edge.to.length > 0);
            stMoveIdx = 0; stDirty = true; renderAll();
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
    stGame = createGameState(stSeed++);
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
        ctx.imageSmoothingEnabled = false;
        // Hit flash: brighten the sprite during hitstun.
        if ((f.action === Action.Hitstun || f.action === Action.AirHitstun) && g.tick % 4 < 2) {
          ctx.filter = 'brightness(2.5)';
        }
        ctx.drawImage(spr, -PIVOT_X, -PIVOT_Y);
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
        if (stGame.phase === Phase.MatchOver) stGame = createGameState(stSeed++);
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
const SPRITE_STYLE = 'perfectly flat solid pure white background, no shadows, no floor, '
  + 'no gradient, 2D fighting game sprite, single character only, full body in strict '
  + 'profile view facing right, nose chest and toes all pointing toward the right edge '
  + 'of the image, feet at the bottom, sharp pixel art style, crisp outlines, vibrant '
  + 'colors, centered, no text, no watermark';

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
const promptMax = (): number => (stImg2Img ? PROMPT_MAX_REF : PROMPT_MAX_TEXT);

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
    + `ground line. Flat pure white background, no shadow, no floor, no borders. Pixel art `
    + `fighting game sprite sheet, crisp outlines, vibrant colors, no text.`;
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

/** Normalize → facing-correct → QC a generated (or sliced) frame image. */
const finishFrame = (mv: MoveDef, src: HTMLImageElement | HTMLCanvasElement): GenResult | null => {
  const m = meta();
  const norm = normalizeFrame(src, m.palette ?? null);
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
const genFrame = async (mv: MoveDef, i: number, salt = 0): Promise<GenResult | null> => {
  const desc = meta().desc || stBundle!.name;
  const frameHint = mv.steps.length > 1 && !STEP_POSES[mv.id]
    ? `, animation frame ${i + 1} of ${mv.steps.length}` : '';
  // img2img: instruct an edit of the attached reference instead of describing
  // the character from scratch — identity comes from the pixels.
  const prompt = (stImg2Img
    ? `The attached image is the reference for ONE character. Redraw THAT EXACT character — `
      + `identical outfit, identical colors, identical hair, identical face and build — in a `
      + `single new pose: ${poseForStep(mv, i)}${frameHint}. Do not redesign the character. ${SPRITE_STYLE}`
    : `${desc}, ${poseForStep(mv, i)}${frameHint}, ${SPRITE_STYLE}`).slice(0, promptMax());
  const img = await generateImage(prompt, seedFor(mv.id, i, salt), 1024, 1024, true);
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
      const img = await generateImage(prompt, seedFor(mv.id, start, salt), STRIP_W, STRIP_H, true);
      slices = sliceStrip(img, idxs.length);
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

const runGeneration = async (which: 'reference' | 'move'): Promise<void> => {
  if (stGenBusy || !stBundle) return;
  stGenBusy = true;
  const m = meta();
  const desc = m.desc || stBundle.name;
  try {
    if (which === 'reference') {
      stStatus = 'generating reference…'; renderAll();
      const img = await generateImage(
        `${desc}, standing idle fighting stance, character reference, ${SPRITE_STYLE}`,
        seedFor('_ref', 0, stSeed++));
      const norm = normalizeFrame(img, null);
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
 * Batch: generate every step of every move (spec §5.2 "per-move batch
 * generation"). QC passes auto-accept; failures are listed for per-move
 * regeneration. One retry with a new seed on QC failure.
 */
const runGenerateAll = async (): Promise<void> => {
  if (stGenBusy || !stBundle) return;
  stGenBusy = true;
  const failures: string[] = [];
  stStripsUsed = 0; stStripFallbacks = 0; stStripError = '';
  const want = (mv: MoveDef, i: number): boolean => !stMissingOnly || !mv.steps[i]!.sprite;
  const total = stBundle.moves.reduce(
    (n, mv) => n + mv.steps.filter((_, i) => want(mv, i)).length, 0);
  let done = 0;
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
        let r = frames[i] ?? null;
        // Per-frame reroll only for the frames the strip failed on.
        for (let att = 0; att < 2 && !(r && r.qc.pass); att++) {
          try {
            r = (await genFrame(mv, i, 2 + ((Math.random() * 1e6) | 0))) ?? r;
          } catch { /* transient — next attempt */ }
        }
        if (r && r.qc.pass) {
          await acceptFrame(mv, i, r);
        } else {
          failures.push(`${mv.id}#${i}${r ? ` QC${r.qc.score}` : ' ERR'}`);
        }
        renderAll();
      }
    }
    const strips = `strips ${stStripsUsed} ok / ${stStripFallbacks} fell back to per-frame`
      + (stStripError ? ` (${stStripError})` : '');
    stStatus = failures.length === 0
      ? `batch complete: all ${total} frames accepted · ${strips} — SAVE to persist`
      : `batch done, ${total - failures.length}/${total} accepted · ${strips} · needs review: ${failures.join(' ')}`;
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

  const thumb = (c: HTMLCanvasElement, size = 150): HTMLCanvasElement => {
    const t = mkEl('canvas', { width: size, height: size, class: 'thumb' });
    const tc = t.getContext('2d')!;
    tc.imageSmoothingEnabled = false;
    tc.fillStyle = '#12141f';
    tc.fillRect(0, 0, size, size);
    tc.drawImage(c, 0, 0, size, size);
    return t;
  };

  const refSection = mkEl('div', { class: 'genblock' },
    mkEl('b', {}, '1 · reference sheet (the consistency contract)'),
    mkEl('p', { class: stImg2Img ? 'qc pass' : 'qc fail' },
      stImg2Img
        ? '✅ reference-image conditioning ON — every frame is generated FROM the reference (true identity lock)'
        : '⚠ text-only provider: the reference CANNOT be fed to the model (NVIDIA flux rejects user images). '
          + 'Identity is best-effort via strips + palette lock. For a real fix set IMAGE_PROVIDER=bfl or fal (+ key) in .env.'),
    mkEl('div', { class: 'row' },
      mkEl('label', {}, 'character description ', mkEl('input', {
        value: m.desc ?? '', style: 'width:420px',
        placeholder: 'e.g. cyberpunk karate robot, red chassis, yellow visor',
        onchange: (e: Event) => { m.desc = (e.target as HTMLInputElement).value; stDirty = true; },
      })),
      mkEl('button', { disabled: stGenBusy ? '' : null, onclick: () => void runGeneration('reference') },
        stGenBusy ? '…' : 'generate reference'),
    ),
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
          const pal = extractPalette(stRefPreview!.cell, 16);
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
        onclick: () => {
          void (async () => {
            let ref = spriteCanvas('_reference.png');
            for (let w = 0; w < 30 && !ref; w++) {
              await new Promise((r) => setTimeout(r, 100));
              ref = spriteCanvas('_reference.png');
            }
            if (!ref) { stStatus = 'no saved reference found'; renderAll(); return; }
            m.palette = extractPalette(ref, 16);
            m.refMask = silhouetteMask16(ref);
            m.refChroma = Math.round(meanChroma(ref));
            const bb = alphaBounds(ref);
            if (bb) m.refBodyW = bb.r - bb.l + 1;
            stDirty = true;
            stStatus = `palette refreshed from saved reference (${m.palette.length} colors)`;
            renderAll();
          })();
        },
      }, '⟳ refresh palette'),
    ) : mkEl('p', { class: 'hint' }, 'no reference yet — frames will skip palette lock + QC'),
  );

  const results: HTMLElement[] = [];
  if (mv) {
    for (let i = 0; i < mv.steps.length; i++) {
      const r = stGenResults.get(i);
      results.push(mkEl('div', { class: 'genframe' },
        mkEl('div', { class: 'hint' }, `step ${i} · ${mv.steps[i]!.phase}`),
        r ? thumb(r.norm.cell) : mkEl('div', { class: 'thumb empty' }, '—'),
        r ? mkEl('div', { class: r.qc.pass ? 'qc pass' : 'qc fail' },
          `QC ${r.qc.score} · pal ${(r.qc.paletteMatch * 100).toFixed(0)}%${r.flipped ? ' · ↔auto-flipped' : ''}`) : null,
        r ? mkEl('div', {},
          mkEl('button', {
            disabled: r.accepted ? '' : null,
            onclick: () => {
              void acceptFrame(mv, i, r).then(() => { stStatus = `accepted ${spriteName(mv.id, i)}`; renderAll(); });
            },
          }, r.accepted ? 'accepted ✓' : 'accept'),
          mkEl('button', {
            disabled: stGenBusy ? '' : null,
            onclick: () => {
              void (async () => {
                stGenBusy = true;
                stStatus = `retrying ${mv.id}#${i}…`; renderAll();
                try {
                  const nr = await genFrame(mv, i, (Math.random() * 999) | 0);
                  if (nr) stGenResults.set(i, nr);
                } catch (e) { stStatus = `retry failed: ${(e as Error).message}`; }
                stGenBusy = false;
                renderAll();
              })();
            },
          }, 'retry'),
        ) : null,
      ));
    }
  }

  const moveSection = mkEl('div', { class: 'genblock' },
    mkEl('b', {}, '2 · per-move animation frames'),
    mkEl('div', { class: 'row' },
      mkEl('label', {}, 'move ', selInput(mv?.id ?? '', b.moves.map((x) => x.id), (id) => {
        stMoveIdx = b.moves.findIndex((x) => x.id === id);
        stGenResults = new Map();
      })),
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
      }, stGenBusy ? '…' : `⚡ batch ${stMissingOnly ? 'MISSING' : 'ALL'} (${b.moves.reduce((n, x) => n + x.steps.filter((s) => !stMissingOnly || !s.sprite).length, 0)} frames)`),
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
    mkEl('b', {}, '3 · sprite audit (facing + background bleed on saved frames)'),
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
        mkEl('tr', {}, ...['frame', 'flags', 'fix', ''].map((hh) => mkEl('th', {}, hh))),
        ...stAudit.map((row) => mkEl('tr', {},
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
      )) : mkEl('p', { class: 'hint' }, 'scans every saved sprite against the reference silhouette (mirror match = wrong facing) and for enclosed white pockets (bad keying)'),
  );

  return mkEl('div', { class: 'pane' }, refSection, moveSection, auditSection);
};

// ------------------------------------------------------------------ root
// ------------------------------------------------------------------ stage tab
interface StageMetaEd {
  name: string;
  imageW: number;
  imageH: number;
  floorY: number;
  skyColor: string;
  deckColor: string;
}
let stStageId = 'rooftop';
let stStageList: string[] = [];
let stStageMeta: StageMetaEd | null = null;
let stStageImg: HTMLImageElement | HTMLCanvasElement | null = null;
let stStageBusy = false;
let stStageDirty = false;

const loadStageEd = async (id: string): Promise<void> => {
  stStageId = id;
  stStageMeta = null;
  stStageImg = null;
  try {
    const r = await fetch(`/stages/${id}/stage.json`);
    if (r.ok) stStageMeta = (await r.json()) as StageMetaEd;
    const img = new Image();
    img.src = `/stages/${id}/background.png?v=${Math.random()}`;
    await new Promise<void>((res) => { img.onload = () => res(); img.onerror = () => res(); });
    if (img.naturalWidth > 0) stStageImg = img;
  } catch { /* new stage */ }
  stStageMeta ??= {
    name: id, imageW: 1536, imageH: 640, floorY: 520,
    skyColor: '#2b1b4d', deckColor: '#3a3644',
  };
  stStageDirty = false;
  renderAll();
};

const saveStageEd = async (): Promise<void> => {
  if (!stStageMeta) return;
  if (stStageImg) {
    const c = document.createElement('canvas');
    c.width = stStageImg instanceof HTMLCanvasElement ? stStageImg.width : stStageImg.naturalWidth;
    c.height = stStageImg instanceof HTMLCanvasElement ? stStageImg.height : stStageImg.naturalHeight;
    c.getContext('2d')!.drawImage(stStageImg, 0, 0);
    stStageMeta.imageW = c.width;
    stStageMeta.imageH = c.height;
    await apiJson(`/api/stages/${stStageId}/background.png`, {
      method: 'PUT', body: c.toDataURL('image/png'),
    });
  }
  await apiJson(`/api/stages/${stStageId}/stage.json`, {
    method: 'PUT', body: JSON.stringify(stStageMeta, null, 2),
  });
  stStageDirty = false;
  stStatus = `stage "${stStageId}" saved`;
  if (!stStageList.includes(stStageId)) stStageList.push(stStageId);
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

  // Preview canvas with a draggable floor line.
  const pw = 768;
  const ph = Math.round(pw * (m.imageH / m.imageW));
  const cv = mkEl('canvas', { width: pw, height: ph, class: 'frcanvas', style: 'cursor:row-resize' });
  const paint = (): void => {
    const ctx = cv.getContext('2d')!;
    ctx.fillStyle = m.skyColor;
    ctx.fillRect(0, 0, pw, ph);
    if (stStageImg) {
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(stStageImg, 0, 0, pw, ph);
    } else {
      ctx.fillStyle = '#8a91a8';
      ctx.font = '14px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('no background yet — generate or upload one', pw / 2, ph / 2);
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
    ctx.fillText(`floor y=${m.floorY} (drag)`, 8, fy - 6);
  };
  // setTimeout, NOT rAF — hidden tabs throttle rAF to zero (automation runs headless).
  setTimeout(paint, 0);
  let dragging = false;
  cv.onmousedown = () => { dragging = true; };
  cv.onmousemove = (e) => {
    if (!dragging) return;
    const r = cv.getBoundingClientRect();
    m.floorY = Math.max(0, Math.min(m.imageH, Math.round(((e.clientY - r.top) / ph) * m.imageH)));
    stStageDirty = true;
    paint();
  };
  cv.onmouseup = cv.onmouseleave = () => { dragging = false; };

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
        onclick: () => {
          const id = prompt('new stage id (lowercase, dashes):');
          if (!id || !/^[a-z0-9][a-z0-9-]{0,40}$/.test(id)) return;
          stStageId = id;
          stStageImg = null;
          stStageMeta = { name: id, imageW: 1536, imageH: 640, floorY: 520, skyColor: '#2b1b4d', deckColor: '#3a3644' };
          stStageDirty = true;
          renderAll();
        },
      }, '+ new'),
      mkEl('button', {
        class: stStageDirty ? 'save dirty' : 'save',
        onclick: () => void saveStageEd(),
      }, stStageDirty ? 'save stage *' : 'save stage'),
    ),
    mkEl('div', { class: 'genblock' },
      mkEl('b', {}, 'background · generate or upload (PNG/SVG)'),
      mkEl('div', { class: 'row' },
        mkEl('input', {
          id: 'stageprompt', style: 'width:520px',
          placeholder: 'e.g. pixel art city rooftop at dusk, purple sunset sky, empty concrete floor at the bottom',
        }),
        mkEl('button', {
          disabled: stStageBusy ? '' : null,
          onclick: () => {
            void (async () => {
              const p = (document.getElementById('stageprompt') as HTMLInputElement).value.trim();
              if (!p) { stStatus = 'enter a stage prompt'; renderAll(); return; }
              stStageBusy = true;
              stStatus = 'generating stage…'; renderAll();
              try {
                // Keep it terse: long prompts trip the 800-char cap + filter.
                const img = await generateImage(`${p}, retro 16-bit style, no text`, (Math.random() * 1e6) | 0, 1536, 640);
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
        'floor line = where fighters\' feet sit in the image · sky/deck colors extend the art when the camera sees past it'),
    ),
  );
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
  }
};

// boot
void (async () => {
  try {
    const caps = await apiJson<{ provider: string; img2img: boolean }>('/api/capabilities');
    stImg2Img = caps.img2img;
    stCharList = await apiJson<string[]>('/api/characters');
    if (stCharList.length === 0) throw new Error('no characters found');
    await loadChar(stCharList.includes('analog') ? 'analog' : stCharList[0]!);
  } catch (e) {
    stStatus = `boot failed: ${(e as Error).message}`;
  }
  renderAll();
})();
