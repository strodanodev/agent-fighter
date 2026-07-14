/**
 * Sprite pipeline — deterministic post-processing (spec §5.1 stages 3-5).
 * The image model is an unreliable artist; everything here is plain code
 * that normalizes and verifies its output:
 *
 *   raw image → background removal → palette lock → nearest-neighbor
 *   downscale into a fixed sprite cell (feet-anchored pivot) → QC score
 *   → auto hurtbox/hitbox drafts.
 *
 * All canvas ops, no AI. Runs in the Studio browser app.
 */
import type { Rect } from '@af/core';

/** Fixed sprite cell: world-px 1:1, pivot = feet center. */
export const CELL_W = 192;
export const CELL_H = 192;
export const PIVOT_X = 96;
export const PIVOT_Y = 176;
/** Standing body height sprites are normalized to (stand hurtbox is 108). */
export const TARGET_BODY_H = 112;

export type RGB = [number, number, number];

const mkCanvas = (w: number, h: number): HTMLCanvasElement => {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
};

export const decodeBase64Image = (b64: string): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image decode failed'));
    img.src = b64.startsWith('data:') ? b64 : `data:image/jpeg;base64,${b64}`;
  });

const dist2 = (r: number, g: number, b: number, c: RGB): number => {
  const dr = r - c[0], dg = g - c[1], db = b - c[2];
  return dr * dr + dg * dg + db * db;
};

/**
 * Background removal: flood-fill transparency from every border pixel whose
 * color is close to the border median. Handles the flat/near-flat backgrounds
 * the prompts ask for; interior holes are left alone (they're usually detail).
 */
export const removeBackground = (img: HTMLImageElement): HTMLCanvasElement => {
  const w = img.naturalWidth, h = img.naturalHeight;
  const c = mkCanvas(w, h);
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0);
  const im = ctx.getImageData(0, 0, w, h);
  const d = im.data;

  // Border median color.
  const rs: number[] = [], gs: number[] = [], bs: number[] = [];
  const sampleAt = (x: number, y: number): void => {
    const i = (y * w + x) * 4;
    rs.push(d[i]!); gs.push(d[i + 1]!); bs.push(d[i + 2]!);
  };
  for (let x = 0; x < w; x += 4) { sampleAt(x, 0); sampleAt(x, h - 1); }
  for (let y = 0; y < h; y += 4) { sampleAt(0, y); sampleAt(w - 1, y); }
  const med = (a: number[]): number => a.sort((p, q) => p - q)[a.length >> 1]!;
  const bg: RGB = [med(rs), med(gs), med(bs)];

  const TOL2 = 62 * 62;
  const visited = new Uint8Array(w * h);
  const queue: number[] = [];
  const tryPush = (x: number, y: number): void => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const p = y * w + x;
    if (visited[p]) return;
    visited[p] = 1;
    const i = p * 4;
    if (dist2(d[i]!, d[i + 1]!, d[i + 2]!, bg) < TOL2) queue.push(p);
  };
  for (let x = 0; x < w; x++) { tryPush(x, 0); tryPush(x, h - 1); }
  for (let y = 0; y < h; y++) { tryPush(0, y); tryPush(w - 1, y); }
  while (queue.length > 0) {
    const p = queue.pop()!;
    d[p * 4 + 3] = 0;
    const x = p % w, y = (p / w) | 0;
    tryPush(x + 1, y); tryPush(x - 1, y); tryPush(x, y + 1); tryPush(x, y - 1);
  }
  ctx.putImageData(im, 0, 0);
  return c;
};

const alphaBBox = (c: HTMLCanvasElement): { l: number; t: number; r: number; b: number } | null => {
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
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

/**
 * Extract a locked palette (spec: palette quantization fixes most visible
 * drift almost for free). Histogram over 5-bit RGB buckets, top N.
 */
export const extractPalette = (c: HTMLCanvasElement, n = 16): RGB[] => {
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  const buckets = new Map<number, { n: number; r: number; g: number; b: number }>();
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3]! < 128) continue;
    const key = ((d[i]! >> 3) << 10) | ((d[i + 1]! >> 3) << 5) | (d[i + 2]! >> 3);
    let bk = buckets.get(key);
    if (!bk) buckets.set(key, bk = { n: 0, r: 0, g: 0, b: 0 });
    bk.n++; bk.r += d[i]!; bk.g += d[i + 1]!; bk.b += d[i + 2]!;
  }
  return [...buckets.values()]
    .sort((a, b) => b.n - a.n)
    .slice(0, n)
    .map((bk) => [Math.round(bk.r / bk.n), Math.round(bk.g / bk.n), Math.round(bk.b / bk.n)] as RGB);
};

/**
 * Snap every opaque pixel to the nearest palette color. Returns the fraction
 * of pixels that were already close to the palette (QC signal: how much the
 * model drifted from the reference colors before we fixed it).
 */
export const quantizeToPalette = (c: HTMLCanvasElement, palette: RGB[]): number => {
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  const im = ctx.getImageData(0, 0, c.width, c.height);
  const d = im.data;
  const CLOSE2 = 42 * 42;
  let opaque = 0, close = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3]! < 128) { d[i + 3] = 0; continue; }
    opaque++;
    let best = 0, bestD = Infinity;
    for (let p = 0; p < palette.length; p++) {
      const dd = dist2(d[i]!, d[i + 1]!, d[i + 2]!, palette[p]!);
      if (dd < bestD) { bestD = dd; best = p; }
    }
    if (bestD < CLOSE2) close++;
    d[i] = palette[best]![0]; d[i + 1] = palette[best]![1]; d[i + 2] = palette[best]![2];
    d[i + 3] = 255;
  }
  ctx.putImageData(im, 0, 0);
  return opaque === 0 ? 0 : close / opaque;
};

export interface NormalizedFrame {
  cell: HTMLCanvasElement; // CELL_W×CELL_H, feet at (PIVOT_X, PIVOT_Y)
  bodyH: number; // body height in cell px after scaling
  bodyW: number;
  paletteMatch: number; // 0..1 pre-quantize conformity
}

/**
 * Full normalize pass: bg removal → crop → scale to the standard body height
 * (nearest-neighbor: the pixelation IS the consistency trick, spec §5.1) →
 * feet-anchor into the fixed cell → optional palette lock.
 */
export const normalizeFrame = (img: HTMLImageElement, palette: RGB[] | null): NormalizedFrame | null => {
  const cut = removeBackground(img);
  const bb = alphaBBox(cut);
  if (!bb) return null;
  const srcW = bb.r - bb.l + 1, srcH = bb.b - bb.t + 1;
  const scale = TARGET_BODY_H / srcH;
  const dw = Math.max(1, Math.round(srcW * scale));
  const dh = Math.max(1, Math.round(srcH * scale));

  const cell = mkCanvas(CELL_W, CELL_H);
  const ctx = cell.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingEnabled = false; // nearest-neighbor
  ctx.drawImage(cut, bb.l, bb.t, srcW, srcH, PIVOT_X - (dw >> 1), PIVOT_Y - dh, dw, dh);

  const paletteMatch = palette ? quantizeToPalette(cell, palette) : 1;
  return { cell, bodyH: dh, bodyW: dw, paletteMatch };
};

export interface QCResult {
  score: number; // 0..100
  paletteMatch: number;
  heightRatio: number; // body height vs reference
  pass: boolean;
}

/** Per-frame QC vs the reference sheet (spec §5.1 stage 4). */
export const qcScore = (frame: NormalizedFrame, refBodyW: number | null): QCResult => {
  const paletteMatch = frame.paletteMatch;
  // Height is normalized by construction; width drift is the real proportion signal.
  const heightRatio = refBodyW ? frame.bodyW / refBodyW : 1;
  const proportionOK = heightRatio > 0.45 && heightRatio < 2.2; // poses legitimately widen
  const score = Math.round(
    paletteMatch * 70 + (proportionOK ? 30 : Math.max(0, 30 - Math.abs(1 - heightRatio) * 30)));
  return { score, paletteMatch, heightRatio, pass: score >= 55 };
};

/**
 * Auto-hurtbox draft: alpha bbox split into head/torso/legs bands, each with
 * its own horizontal bounds (spec §5.1 stage 5). Output in character space
 * (origin = feet center, +x forward, y negative up), matching Rect semantics.
 */
export const autoHurtboxes = (cell: HTMLCanvasElement): Rect[] => {
  const bb = alphaBBox(cell);
  if (!bb) return [];
  const ctx = cell.getContext('2d', { willReadFrequently: true })!;
  const d = ctx.getImageData(0, 0, cell.width, cell.height).data;
  const H = bb.b - bb.t + 1;
  const bands = [
    { from: 0, to: 0.3 }, // head
    { from: 0.3, to: 0.7 }, // torso
    { from: 0.7, to: 1.0 }, // legs
  ];
  const out: Rect[] = [];
  for (const band of bands) {
    const y0 = bb.t + Math.floor(H * band.from);
    const y1 = bb.t + Math.ceil(H * band.to) - 1;
    let l = cell.width, r = -1;
    for (let y = y0; y <= y1; y++) {
      for (let x = bb.l; x <= bb.r; x++) {
        if (d[(y * cell.width + x) * 4 + 3]! > 40) {
          if (x < l) l = x;
          if (x > r) r = x;
        }
      }
    }
    if (r < 0) continue;
    out.push({
      x: l - PIVOT_X,
      y: y0 - PIVOT_Y,
      w: r - l + 1,
      h: y1 - y0 + 1,
    });
  }
  return out;
};

/**
 * Hitbox draft from frame diff: the region that appears in this frame but
 * not the previous one is almost always the attacking limb (spec §5.1).
 */
export const diffHitboxDraft = (prev: HTMLCanvasElement, cur: HTMLCanvasElement): Rect | null => {
  const w = cur.width, h = cur.height;
  const pd = prev.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, w, h).data;
  const cd = cur.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, w, h).data;
  let l = w, t = h, r = -1, b = -1, count = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4 + 3;
      if (cd[i]! > 40 && pd[i]! <= 40) {
        count++;
        if (x < l) l = x;
        if (x > r) r = x;
        if (y < t) t = y;
        if (y > b) b = y;
      }
    }
  }
  if (r < 0 || count < 40) return null; // noise, not a limb
  return { x: l - PIVOT_X, y: t - PIVOT_Y, w: r - l + 1, h: b - t + 1 };
};

export const canvasToPngDataUrl = (c: HTMLCanvasElement): string => c.toDataURL('image/png');
