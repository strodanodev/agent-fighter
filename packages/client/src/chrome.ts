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
/**
 * One parallax plane. `depth` is relative to the gameplay plane fighters
 * stand on, which is depth 1 (moves 1:1 with the camera — this is exactly
 * today's single-background behavior). 0 = infinitely far, screen-fixed;
 * values > 1 drift FASTER than the camera (a railing between camera and
 * subject). All layers share the stage's imageW/imageH/floorY framing.
 */
export interface StageLayerMeta {
  file: string; // e.g. "layer-bg.png", relative to stages/<id>/
  depth: number;
}

export interface StageMeta {
  name: string;
  imageW: number;
  imageH: number;
  /** y-pixel in the image that corresponds to the world floor line. */
  floorY: number;
  skyColor: string;
  deckColor: string;
  /** Multi-plane parallax art. Absent/empty → legacy single `background.png`. */
  layers?: StageLayerMeta[];
}

export interface StageLayer {
  img: HTMLImageElement;
  depth: number;
}

export interface StageAsset {
  id: string;
  meta: StageMeta;
  /** Legacy single flat background (depth-1, today's behavior). */
  image: HTMLImageElement | null;
  /** Multi-plane parallax art, back (low depth) to front (high depth). */
  layers: StageLayer[];
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
    let layers: StageLayer[] = [];
    if (meta.layers?.length) {
      const loaded = await Promise.all(
        meta.layers.map(async (lm) => ({ img: await loadImg(`/stages/${id}/${lm.file}`), depth: lm.depth })));
      layers = loaded
        .filter((l): l is { img: HTMLImageElement; depth: number } => !!l.img)
        .sort((a, b) => a.depth - b.depth); // back (far) to front (near)
    }
    return { id, meta, image, layers };
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

/**
 * Draw a multi-plane parallax stage in WORLD coordinates. Falls back to the
 * single-image `drawStageImage` when the stage has no layers, so legacy
 * stages (and stages with only a plain `background.png`) render identically
 * to before this existed.
 *
 * PARALLAX MATH: everything is drawn once, under one `worldTransform` that
 * subtracts `cam.x` uniformly. A layer at depth 1 (the gameplay plane) needs
 * zero extra offset to reproduce today's pinned-to-world behavior. A layer
 * is drawn `(1 - depth) * cam.x` world px further along than its nominal
 * position: at depth 0 that fully cancels the camera's own subtraction
 * (screen-fixed — "infinitely far"); at depth < 1 it partially cancels
 * (drifts slower — distant); at depth > 1 the term goes negative and ADDS to
 * the camera's shift (drifts faster — nearer than the subject).
 *
 * TILING: rather than author oversized art or estimate exact camera travel,
 * each layer is tiled edge-to-edge using PING-PONG (mirror) tiling — every
 * other copy is horizontally flipped, so the touching edges are always the
 * same pixel column reflected onto itself. That makes the seam invisible
 * for ANY source image, with no special authoring and no visible repeat
 * pattern, so a handful of tiles safely cover the whole camera range.
 */
export const drawStageLayers = (
  ctx: CanvasRenderingContext2D,
  stage: StageAsset,
  cam: Cam,
  vw: number, vh: number,
): void => {
  if (stage.layers.length === 0) {
    if (stage.image) drawStageImage(ctx, stage, cam, vw, vh);
    return;
  }

  const viewW = vw / cam.zoom;
  const viewH = vh / cam.zoom;
  const L = cam.x, R = cam.x + viewW, T = cam.y, B = T + viewH;
  const m = stage.meta;
  const scale = STAGE.widthPx / m.imageW;
  const topY = STAGE.floorYPx - m.floorY * scale;
  const drawH = m.imageH * scale;

  // Sky/deck fill ONCE behind every layer — cheaper than per-layer, and
  // guards the same vertical-excursion edges the legacy path guarded.
  if (topY > T - 10) {
    ctx.fillStyle = m.skyColor;
    ctx.fillRect(L - 10, T - 10, viewW + 20, topY - (T - 10) + 1);
  }
  if (topY + drawH < B + 10) {
    ctx.fillStyle = m.deckColor;
    ctx.fillRect(L - 10, topY + drawH - 1, viewW + 20, B + 10 - (topY + drawH) + 1);
  }

  ctx.imageSmoothingEnabled = false;
  for (const layer of stage.layers) {
    const tileW = layer.img.naturalWidth * scale;
    if (tileW < 1) continue;
    const offsetX = (1 - layer.depth) * cam.x;
    const originX = -offsetX; // world-x where the k=0 tile's left edge sits
    const startK = Math.floor((L - originX) / tileW) - 1;
    const endK = Math.ceil((R - originX) / tileW) + 1;
    for (let k = startK; k <= endK; k++) {
      const x = originX + k * tileW;
      const mirrored = (((k % 2) + 2) % 2) === 1; // non-negative mod
      ctx.save();
      if (mirrored) {
        ctx.translate(x + tileW, topY);
        ctx.scale(-1, 1);
        ctx.drawImage(layer.img, 0, 0, tileW, drawH);
      } else {
        ctx.drawImage(layer.img, x, topY, tileW, drawH);
      }
      ctx.restore();
    }
  }
};
