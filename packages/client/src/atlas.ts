import { loadCharacter, spriteForFighter } from '@af/core';
import type { CharacterBundle, FighterState, LoadedCharacter } from '@af/core';

/**
 * Character bundle loading for the game client (spec §3: characters ship as
 * `characters/<id>/character.json` + a packed atlas, referenced by hash).
 * The client is a pure consumer: it never interprets frame data, it only asks
 * `spriteForFighter()` which frame to draw and blits it from the atlas.
 */

export interface AtlasFrame {
  x: number; y: number; w: number; h: number; pivotX: number; pivotY: number;
}

export interface AtlasData {
  /** Packed sheet filename (atlas.webp). Absent in legacy atlases → atlas.png. */
  image?: string;
  cellW: number;
  cellH: number;
  /**
   * World px per sprite px. Sprites are authored supersampled (anime art keeps
   * its line work and shading that way), so they must be shrunk back to world
   * size at draw time. Absent in legacy 1:1 atlases → 1.
   */
  scale?: number;
  /** Filter when scaling (anime art). Legacy pixel-art atlases point-sample. */
  smooth?: boolean;
  frames: Record<string, AtlasFrame>;
}

export interface Roster {
  id: string;
  bundle: CharacterBundle;
  ch: LoadedCharacter;
  atlas: AtlasData | null;
  sheet: HTMLImageElement | null; // packed atlas.png
  portrait: HTMLImageElement | null; // select-screen + HUD portrait
  /**
   * True when `portrait` is a DEDICATED character-select portrait
   * (meta.selectPortrait → _select.png): composed art that fills its frame, so
   * it's drawn cover-fit. False when it's the sprite `_reference.png` fallback,
   * which sits in a mostly-empty cell and must be alpha-cropped to the figure.
   */
  portraitDedicated: boolean;
  /**
   * Framing transform for a dedicated portrait, authored in Studio
   * (meta.selectFraming): zoom ≥ 1 and pan ∈ [-1,1] on each axis, applied on top
   * of the cover-fit. null → plain centered cover-fit. Ignored for the fallback.
   */
  portraitFraming: { zoom: number; panX: number; panY: number; rotate?: number; flipH?: boolean } | null;
  /** Alpha bounds of the portrait art, so frames crop to the figure, not the cell. */
  portraitBox: { x: number; y: number; w: number; h: number } | null;
  /** Disabled in Studio (meta.disabled): greyed out and unselectable on the select screen. */
  disabled: boolean;
}

/** Tight alpha bounds of an image (computed once at load). */
const alphaBounds = (img: HTMLImageElement): Roster['portraitBox'] => {
  const c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const cx = c.getContext('2d', { willReadFrequently: true });
  if (!cx) return null;
  cx.drawImage(img, 0, 0);
  const d = cx.getImageData(0, 0, c.width, c.height).data;
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
  return r < 0 ? null : { x: l, y: t, w: r - l + 1, h: b - t + 1 };
};

const loadImage = (src: string): Promise<HTMLImageElement | null> =>
  new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null); // missing art is survivable — we fall back to a rect
    img.src = src;
  });

const fetchJson = async <T>(url: string): Promise<T | null> => {
  try {
    const r = await fetch(url);
    return r.ok ? ((await r.json()) as T) : null;
  } catch {
    return null;
  }
};

export const listCharacters = async (): Promise<string[]> =>
  (await fetchJson<string[]>('/api/characters')) ?? [];

export const loadRoster = async (id: string): Promise<Roster> => {
  const bundle = await fetchJson<CharacterBundle>(`/characters/${id}/character.json`);
  if (!bundle) throw new Error(`character "${id}" not found`);
  const atlas = await fetchJson<AtlasData>(`/characters/${id}/sprites/atlas.json`);
  // Atlases ship as WebP (a fraction of the bytes); `image` names the file.
  // Older atlases predate the field and are always atlas.png.
  const sheetFile = atlas?.image ?? 'atlas.png';
  // Dedicated character-select portrait, authored in Studio (meta.selectPortrait
  // → _select.png). Only honored when the bundle still references it — "remove"
  // in Studio clears the field but leaves the file, and we must respect that.
  const meta = (bundle as CharacterBundle & {
    meta?: {
      selectPortrait?: string;
      selectFraming?: { zoom: number; panX: number; panY: number; rotate?: number; flipH?: boolean };
      disabled?: boolean;
    };
  }).meta;
  const portraitFile = meta?.selectPortrait;
  const safePortrait = portraitFile && /^[\w.-]+\.(png|webp|jpe?g)$/.test(portraitFile)
    ? portraitFile : null;
  const [sheet, refPortrait, selectPortrait] = await Promise.all([
    loadImage(`/characters/${id}/sprites/${sheetFile}`),
    loadImage(`/characters/${id}/sprites/_reference.png`),
    safePortrait ? loadImage(`/characters/${id}/sprites/${safePortrait}`) : Promise.resolve(null),
  ]);
  const dedicated = !!selectPortrait;
  const portrait = selectPortrait ?? refPortrait;
  return {
    id, bundle, ch: loadCharacter(bundle), atlas, sheet, portrait,
    portraitDedicated: dedicated,
    portraitFraming: dedicated ? (meta?.selectFraming ?? null) : null,
    // A composed portrait fills its frame (cover-fit); only the sprite fallback
    // needs alpha bounds to crop away the empty cell.
    portraitBox: !dedicated && portrait ? alphaBounds(portrait) : null,
    disabled: !!meta?.disabled,
  };
};

/** Blit one resolved atlas frame at (x, y = feet), mirrored by facing. */
const blitFrame = (
  ctx: CanvasRenderingContext2D, roster: Roster, name: string,
  x: number, y: number, facing: 1 | -1, alpha: number,
): boolean => {
  const atlas = roster.atlas;
  const frame = atlas?.frames[name];
  if (!atlas || !frame || !roster.sheet) return false;
  const s = atlas.scale ?? 1;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(x, y);
  ctx.scale(facing, 1);
  ctx.imageSmoothingEnabled = atlas.smooth ?? false;
  if (ctx.imageSmoothingEnabled) ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(
    roster.sheet,
    frame.x, frame.y, frame.w, frame.h,
    -frame.pivotX * s, -frame.pivotY * s, frame.w * s, frame.h * s,
  );
  ctx.restore();
  return true;
};

/**
 * MOTION AFTERIMAGE (spec: cosmetic, client-only). Characters animate on just
 * 3-5 keyframes per action, so fast movement reads as a choppy pose-snap. A
 * short trail of faded copies of the recent frames — the classic 2D-fighter
 * "smear" — fills the visual gap between keyframes and sells speed. It fires
 * ONLY above a velocity threshold (dashes, jumps, knockback, air), so ordinary
 * standing/walking never gets ghosted (which would read as lag).
 */
interface EchoSample { name: string; x: number; y: number; facing: 1 | -1 }
const ECHO_LEN = 5;
const echoHist: EchoSample[][] = [[], []];
/** Clear trails between rounds/matches so stale echoes don't flash on reset. */
export const resetFighterTrails = (): void => { echoHist[0] = []; echoHist[1] = []; };

/**
 * Draw a fighter at world position (x, y = feet), mirrored by facing.
 * Falls back to a colored rectangle if the frame is missing, so a
 * half-authored character is still playable.
 *
 * `opts.slot` (0/1) enables the per-fighter motion afterimage; `opts.motion`
 * is a 0..1 speed intensity (caller derives it from velocity) that scales how
 * many echoes show and how opaque they are.
 */
export const drawFighter = (
  ctx: CanvasRenderingContext2D,
  roster: Roster,
  f: FighterState,
  tick: number,
  x: number,
  y: number,
  fallback: string,
  opts?: { slot?: 0 | 1; motion?: number },
): void => {
  const name = spriteForFighter(f, roster.ch, tick);

  // Afterimage trail: draw the recent samples oldest→newest, ramping alpha,
  // BEFORE the crisp current frame lands on top.
  const slot = opts?.slot;
  const motion = Math.max(0, Math.min(1, opts?.motion ?? 0));
  if (slot !== undefined && name) {
    const hist = echoHist[slot]!;
    if (motion > 0.05 && roster.sheet) {
      hist.forEach((s, k) => {
        const depth = (k + 1) / (hist.length + 1); // 0 oldest → ~1 newest
        blitFrame(ctx, roster, s.name, s.x, s.y, s.facing, motion * 0.45 * depth);
      });
    }
    hist.push({ name, x, y, facing: f.facing });
    if (hist.length > ECHO_LEN) hist.shift();
  }

  // Crisp current frame on top; fall back to a rect if the art is missing.
  if (name && blitFrame(ctx, roster, name, x, y, f.facing, 1)) return;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(f.facing, 1);
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = fallback;
  ctx.fillRect(-26, -108, 52, 108);
  ctx.restore();
};

/**
 * Draw a character portrait into (x, y, w, h).
 *  - Dedicated portrait (_select.png): composed art → cover-fit (fill the frame,
 *    center-crop the overflow), no alpha cropping.
 *  - Reference-sprite fallback: a square crop centered on the head and chest of
 *    the figure (the reference cell is mostly empty space), scaled to fill.
 */
export const drawPortrait = (
  ctx: CanvasRenderingContext2D,
  roster: Roster,
  x: number, y: number, w: number, h: number,
): void => {
  const img = roster.portrait;
  if (!img || (!roster.portraitDedicated && !roster.portraitBox)) {
    ctx.fillStyle = '#1b1e30';
    ctx.fillRect(x, y, w, h);
    return;
  }
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.imageSmoothingEnabled = roster.portraitDedicated ? true : (roster.atlas?.smooth ?? false);
  if (ctx.imageSmoothingEnabled) ctx.imageSmoothingQuality = 'high';
  if (roster.portraitDedicated) {
    // Cover-fit scaled by zoom, then rotated (90° steps), flipped, and panned.
    // Must match the Studio preview math (studio main.ts framedPreview).
    const fr = roster.portraitFraming;
    const iw = img.naturalWidth, ih = img.naturalHeight;
    const zoom = Math.max(1, fr?.zoom ?? 1);
    const rot = ((((fr?.rotate ?? 0) % 360) + 360) % 360);
    const swap = rot === 90 || rot === 270;
    const bw = swap ? ih : iw, bh = swap ? iw : ih;
    const scale = Math.max(w / bw, h / bh) * zoom;
    const sw = bw * scale, sh = bh * scale;
    const panX = Math.max(-1, Math.min(1, fr?.panX ?? 0));
    const panY = Math.max(-1, Math.min(1, fr?.panY ?? 0));
    ctx.translate(x + w / 2 + panX * (sw - w) / 2, y + h / 2 + panY * (sh - h) / 2);
    ctx.rotate(rot * Math.PI / 180);
    if (fr?.flipH) ctx.scale(-1, 1);
    ctx.drawImage(img, -iw * scale / 2, -ih * scale / 2, iw * scale, ih * scale);
  } else {
    const box = roster.portraitBox!;
    const side = Math.max(box.w * 1.15, box.h * 0.55);
    const cropX = box.x + box.w / 2 - side / 2;
    const cropY = box.y - side * 0.05;
    ctx.drawImage(img, cropX, cropY, side, side, x, y, w, h);
  }
  ctx.restore();
};
