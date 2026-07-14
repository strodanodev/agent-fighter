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
  portrait: HTMLImageElement | null; // _reference.png — used on select screen + HUD
  /** Alpha bounds of the portrait art, so frames crop to the figure, not the cell. */
  portraitBox: { x: number; y: number; w: number; h: number } | null;
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
  const [atlas, sheet, portrait] = await Promise.all([
    fetchJson<AtlasData>(`/characters/${id}/sprites/atlas.json`),
    loadImage(`/characters/${id}/sprites/atlas.png`),
    loadImage(`/characters/${id}/sprites/_reference.png`),
  ]);
  return {
    id, bundle, ch: loadCharacter(bundle), atlas, sheet, portrait,
    portraitBox: portrait ? alphaBounds(portrait) : null,
  };
};

/**
 * Draw a fighter at world position (x, y = feet), mirrored by facing.
 * Falls back to a colored rectangle if the frame is missing, so a
 * half-authored character is still playable.
 */
export const drawFighter = (
  ctx: CanvasRenderingContext2D,
  roster: Roster,
  f: FighterState,
  tick: number,
  x: number,
  y: number,
  fallback: string,
): void => {
  const name = spriteForFighter(f, roster.ch, tick);
  const frame = name && roster.atlas ? roster.atlas.frames[name] : undefined;

  ctx.save();
  ctx.translate(x, y);
  ctx.scale(f.facing, 1);
  if (frame && roster.sheet) {
    const s = roster.atlas?.scale ?? 1;
    ctx.imageSmoothingEnabled = roster.atlas?.smooth ?? false;
    if (ctx.imageSmoothingEnabled) ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(
      roster.sheet,
      frame.x, frame.y, frame.w, frame.h,
      -frame.pivotX * s, -frame.pivotY * s, frame.w * s, frame.h * s,
    );
  } else {
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = fallback;
    ctx.fillRect(-26, -108, 52, 108);
  }
  ctx.restore();
};

/**
 * Draw the reference art as a portrait: a square crop centered on the head and
 * chest of the actual figure (the reference cell is mostly empty space), scaled
 * to fill the frame.
 */
export const drawPortrait = (
  ctx: CanvasRenderingContext2D,
  roster: Roster,
  x: number, y: number, w: number, h: number,
): void => {
  const img = roster.portrait;
  const box = roster.portraitBox;
  if (!img || !box) {
    ctx.fillStyle = '#1b1e30';
    ctx.fillRect(x, y, w, h);
    return;
  }
  // Square crop around the upper body, sized to the figure's width.
  const side = Math.max(box.w * 1.15, box.h * 0.55);
  const cropX = box.x + box.w / 2 - side / 2;
  const cropY = box.y - side * 0.05;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.imageSmoothingEnabled = roster.atlas?.smooth ?? false;
  if (ctx.imageSmoothingEnabled) ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, cropX, cropY, side, side, x, y, w, h);
  ctx.restore();
};
