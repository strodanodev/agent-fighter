import { STAGE } from '@af/core';
import type { Cam } from './ui.js';

/**
 * Asset-based presentation: SVG UI chrome + image stage backgrounds.
 * All art is FILES (assets/ui/*.svg, stages/<id>/background.png) so the look
 * is customizable by swapping files — no code changes. Every draw call here
 * has a graceful path when an asset is missing: the caller keeps its
 * procedural fallback, so a bare checkout still runs.
 */

// ---------------------------------------------------------------- ui kit
export interface UiKit {
  healthframe: HTMLImageElement | null;
  timer: HTMLImageElement | null;
  nameplate: HTMLImageElement | null;
  portrait: HTMLImageElement | null;
  pipOn: HTMLImageElement | null;
  pipOff: HTMLImageElement | null;
  meterseg: HTMLImageElement | null;
}

/**
 * Geometry contracts with the SVG files (window polygons the fills clip to).
 * If you restyle the SVGs, keep these in sync — they are documented in each
 * SVG's header comment.
 */
export const HUD_GEO = {
  healthframe: { w: 400, h: 46 },
  healthWindow: [[16, 10], [358, 10], [381, 23], [358, 36], [16, 36], [11, 31], [11, 15]] as const,
  timer: { w: 110, h: 110 },
  nameplate: { w: 260, h: 30 },
  portrait: { w: 92, h: 92 },
  portraitWindow: { x: 7, y: 7, w: 78, h: 78 },
  pip: { w: 22, h: 16 },
  meterseg: { w: 112, h: 16 },
  meterWindow: [[7, 3], [108, 3], [105, 13], [4, 13]] as const,
} as const;

const loadImg = (src: string): Promise<HTMLImageElement | null> =>
  new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });

export const loadUiKit = async (): Promise<UiKit> => {
  // Cache-buster: UI art changes during authoring, and browsers serve stale
  // heuristically-cached images even past a server no-store (dev-only cost).
  const v = `?v=${Date.now()}`;
  const [healthframe, timer, nameplate, portrait, pipOn, pipOff, meterseg] = await Promise.all([
    loadImg(`/assets/ui/healthframe.svg${v}`),
    loadImg(`/assets/ui/timer.svg${v}`),
    loadImg(`/assets/ui/nameplate.svg${v}`),
    loadImg(`/assets/ui/portrait.svg${v}`),
    loadImg(`/assets/ui/pip_on.svg${v}`),
    loadImg(`/assets/ui/pip_off.svg${v}`),
    loadImg(`/assets/ui/meterseg.svg${v}`),
  ]);
  return { healthframe, timer, nameplate, portrait, pipOn, pipOff, meterseg };
};

/** Draw an element, optionally mirrored around its own vertical axis. */
export const drawChrome = (
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  x: number, y: number, w: number, h: number,
  mirror = false,
): void => {
  ctx.save();
  if (mirror) {
    ctx.translate(x + w, y);
    ctx.scale(-1, 1);
    ctx.drawImage(img, 0, 0, w, h);
  } else {
    ctx.drawImage(img, x, y, w, h);
  }
  ctx.restore();
};

/** Clip to a polygon (element-local points scaled to the draw rect). */
export const clipPoly = (
  ctx: CanvasRenderingContext2D,
  poly: readonly (readonly [number, number])[],
  srcW: number, srcH: number,
  x: number, y: number, w: number, h: number,
  mirror = false,
): void => {
  ctx.beginPath();
  poly.forEach(([pxp, pyp], k) => {
    const lx = mirror ? srcW - pxp : pxp;
    const sx = x + (lx / srcW) * w;
    const sy = y + (pyp / srcH) * h;
    if (k === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy);
  });
  ctx.closePath();
  ctx.clip();
};

// ---------------------------------------------------------------- stages
export interface StageMeta {
  name: string;
  imageW: number;
  imageH: number;
  /** y-pixel in the image that corresponds to the world floor line. */
  floorY: number;
  skyColor: string;
  deckColor: string;
}

export interface StageAsset {
  id: string;
  meta: StageMeta;
  image: HTMLImageElement | null;
}

export const listStages = async (): Promise<string[]> => {
  try {
    const r = await fetch('/api/stages');
    return r.ok ? ((await r.json()) as string[]) : [];
  } catch {
    return [];
  }
};

export const loadStage = async (id: string): Promise<StageAsset | null> => {
  try {
    const r = await fetch(`/stages/${id}/stage.json`);
    if (!r.ok) return null;
    const meta = (await r.json()) as StageMeta;
    const image = await loadImg(`/stages/${id}/background.png`);
    return { id, meta, image };
  } catch {
    return null;
  }
};

/**
 * Draw an image stage in WORLD coordinates (call under worldTransform).
 * The image spans the full stage width; its floorY row is pinned to the world
 * floor. Sky/deck colors extend the art beyond the image's edges when the
 * camera pulls back further than the art covers.
 */
export const drawStageImage = (
  ctx: CanvasRenderingContext2D,
  stage: StageAsset,
  cam: Cam,
  vw: number, vh: number,
): void => {
  const viewW = vw / cam.zoom;
  const viewH = vh / cam.zoom;
  const L = cam.x, T = cam.y;
  const img = stage.image!;
  const m = stage.meta;

  const scale = STAGE.widthPx / m.imageW;
  const drawW = STAGE.widthPx;
  const drawH = m.imageH * scale;
  const topY = STAGE.floorYPx - m.floorY * scale;

  // Extend above/below the art if the camera sees past it.
  if (topY > T - 10) {
    ctx.fillStyle = m.skyColor;
    ctx.fillRect(L - 10, T - 10, viewW + 20, topY - (T - 10) + 1);
  }
  if (topY + drawH < T + viewH + 10) {
    ctx.fillStyle = m.deckColor;
    ctx.fillRect(L - 10, topY + drawH - 1, viewW + 20, T + viewH + 10 - (topY + drawH) + 1);
  }
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, 0, topY, drawW, drawH);
};
