/**
 * Sprite pipeline — deterministic post-processing (spec §5.1 stages 3-5).
 * The image model is an unreliable artist; everything here is plain code
 * that normalizes and verifies its output:
 *
 *   raw image → background removal → (palette conformity check) → smooth
 *   downscale into a fixed sprite cell (feet-anchored pivot) → QC score
 *   → auto hurtbox/hitbox drafts.
 *
 * ART STYLE — anime, not 8-bit. The old chunky look came from three
 * deliberate choices made when the model could NOT see a reference:
 *   1. "pixel art" in the prompt,
 *   2. snapping every pixel to a locked 16-colour palette,
 *   3. nearest-neighbour downscale to a 112px body.
 * (2) and (3) existed to HIDE frame-to-frame drift — pixelation makes small
 * inconsistencies invisible. Reference conditioning (see server.mjs) removes
 * the drift at the source, so the crutches go: sprites are now supersampled
 * 2x, downscaled smoothly, and keep their full shading. The palette is still
 * extracted, but only to SCORE colour conformity — it never repaints pixels.
 *
 * All canvas ops, no AI. Runs in the Studio browser app.
 */
import type { Rect } from '@af/core';

/**
 * Sprite cell. Sprites are authored at SUPERSAMPLE× the world size and the
 * renderer scales them back down (atlas.json carries `scale`), so a fighter
 * still occupies WORLD_BODY_H world px while carrying 2x the pixel detail.
 */
export const SUPERSAMPLE = 2;
export const WORLD_BODY_H = 112; // world px — must match the client's FIGHTER_H
export const CELL_W = 192 * SUPERSAMPLE;
export const CELL_H = 192 * SUPERSAMPLE;
export const PIVOT_X = 96 * SUPERSAMPLE;
export const PIVOT_Y = 176 * SUPERSAMPLE;
/** Body height in SPRITE px (world height × supersample). */
export const TARGET_BODY_H = WORLD_BODY_H * SUPERSAMPLE;
/** World px per sprite px — written into atlas.json for the renderer. */
export const SPRITE_SCALE = 1 / SUPERSAMPLE;
/** Palette size: generous, since it only scores conformity now (no snapping). */
export const PALETTE_N = 48;

export type RGB = [number, number, number];

const mkCanvas = (w: number, h: number): HTMLCanvasElement => {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
};

/**
 * Sniff the image format from base64 magic bytes so the data URL carries the
 * RIGHT mime. Providers differ (flux → JPEG, Gemini → PNG, and Gemini now
 * embeds C2PA metadata), and a wrong mime label makes the browser refuse the
 * image ("broken state" → drawImage throws). PNG `iVBORw0`, JPEG `/9j/`,
 * WebP `UklGR`, GIF `R0lGOD`.
 */
const sniffMime = (b64: string): string => {
  if (b64.startsWith('iVBORw0')) return 'image/png';
  if (b64.startsWith('/9j/')) return 'image/jpeg';
  if (b64.startsWith('UklGR')) return 'image/webp';
  if (b64.startsWith('R0lGOD')) return 'image/gif';
  return 'image/png'; // safest default for the current provider
};

export const decodeBase64Image = (b64: string): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image decode failed'));
    img.src = b64.startsWith('data:') ? b64 : `data:${sniffMime(b64)};base64,${b64}`;
  });

const dist2 = (r: number, g: number, b: number, c: RGB): number => {
  const dr = r - c[0], dg = g - c[1], db = b - c[2];
  return dr * dr + dg * dg + db * db;
};

const clampByte = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

/**
 * Background removal: flood-fill transparency from every border pixel whose
 * color is close to the border median, THEN clear enclosed background
 * pockets — bg-colored regions the flood can't reach (between legs, under
 * arms). A pocket is safe to clear precisely because it never touches
 * transparency; character details that reach the silhouette edge do.
 * Returns the canvas plus a bleed fraction (bg-colored pixels that survived)
 * as a QC signal.
 */
export const removeBackground = (
  img: HTMLImageElement | HTMLCanvasElement,
): { canvas: HTMLCanvasElement; bleed: number } => {
  const w = img instanceof HTMLCanvasElement ? img.width : img.naturalWidth;
  const h = img instanceof HTMLCanvasElement ? img.height : img.naturalHeight;
  const c = mkCanvas(w, h);
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0);
  const im = ctx.getImageData(0, 0, w, h);
  const d = im.data;

  // Border median color + spread (adaptive tolerance for non-flat backgrounds).
  const rs: number[] = [], gs: number[] = [], bs: number[] = [];
  const sampleAt = (x: number, y: number): void => {
    const i = (y * w + x) * 4;
    rs.push(d[i]!); gs.push(d[i + 1]!); bs.push(d[i + 2]!);
  };
  for (let x = 0; x < w; x += 4) { sampleAt(x, 0); sampleAt(x, h - 1); }
  for (let y = 0; y < h; y += 4) { sampleAt(0, y); sampleAt(w - 1, y); }
  const med = (a: number[]): number => a.sort((p, q) => p - q)[a.length >> 1]!;
  const spread = (a: number[]): number => a[Math.floor(a.length * 0.9)]! - a[Math.floor(a.length * 0.1)]!;
  const bg: RGB = [med(rs), med(gs), med(bs)];
  const tol = Math.min(96, 62 + Math.max(spread(rs), spread(gs), spread(bs)));
  const TOL2 = tol * tol;

  const isBg = (p: number): boolean => {
    const i = p * 4;
    return dist2(d[i]!, d[i + 1]!, d[i + 2]!, bg) < TOL2;
  };

  // Pass 1: border flood fill.
  const visited = new Uint8Array(w * h);
  const queue: number[] = [];
  const tryPush = (x: number, y: number): void => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const p = y * w + x;
    if (visited[p]) return;
    visited[p] = 1;
    if (isBg(p)) queue.push(p);
  };
  for (let x = 0; x < w; x++) { tryPush(x, 0); tryPush(x, h - 1); }
  for (let y = 0; y < h; y++) { tryPush(0, y); tryPush(w - 1, y); }
  while (queue.length > 0) {
    const p = queue.pop()!;
    d[p * 4 + 3] = 0;
    const x = p % w, y = (p / w) | 0;
    tryPush(x + 1, y); tryPush(x - 1, y); tryPush(x, y + 1); tryPush(x, y - 1);
  }

  // Pass 2: enclosed pockets. Components of surviving bg-colored pixels that
  // never touch transparency are keyed out (min size guards small highlights).
  const seen = new Uint8Array(w * h);
  const stack: number[] = [];
  let bleedPx = 0, opaquePx = 0;
  for (let p = 0; p < w * h; p++) if (d[p * 4 + 3]! > 40) opaquePx++;
  for (let start = 0; start < w * h; start++) {
    if (seen[start] || d[start * 4 + 3]! <= 40 || !isBg(start)) continue;
    const comp: number[] = [];
    let touchesAlpha = false;
    stack.push(start);
    seen[start] = 1;
    while (stack.length > 0) {
      const p = stack.pop()!;
      comp.push(p);
      const x = p % w;
      for (const q of [p - 1, p + 1, p - w, p + w]) {
        if (q < 0 || q >= w * h || Math.abs((q % w) - x) > 1) continue;
        if (d[q * 4 + 3]! <= 40) { touchesAlpha = true; continue; }
        if (!seen[q] && isBg(q)) { seen[q] = 1; stack.push(q); }
      }
    }
    if (!touchesAlpha && comp.length >= 24) {
      for (const p of comp) d[p * 4 + 3] = 0;
    } else if (comp.length >= 24) {
      bleedPx += comp.length; // survived bg-colored area → QC signal
    }
  }

  // Pass 3: soft-edge feathering + colour decontamination. Passes 1-2 are a
  // BINARY classification (fully opaque or fully transparent), which is
  // correct for the bulk of the image but produces a hard, staircased edge
  // on fine detail (a fence's diagonal wires, a mesh pattern) and leaves a
  // faint white halo on partially-blended boundary pixels — this is the
  // "janky" look. Only pixels touching that hard boundary get a smooth
  // alpha ramp based on colour distance, and have the background's
  // remaining tint subtracted back out (standard matting decontamination),
  // rather than reprocessing the whole image and risking legitimate
  // near-white foreground content elsewhere.
  const innerR = Math.max(8, tol * 0.35);
  const src = new Uint8ClampedArray(d); // read neighbours from the PRE-feather state
  for (let p = 0; p < w * h; p++) {
    if (src[p * 4 + 3] === 0) continue; // already transparent
    const x = p % w, y = (p / w) | 0;
    let nearBoundary = false;
    for (const [qx, qy] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]] as const) {
      if (qx < 0 || qy < 0 || qx >= w || qy >= h) continue;
      if (src[(qy * w + qx) * 4 + 3] === 0) { nearBoundary = true; break; }
    }
    if (!nearBoundary) continue;
    const i = p * 4;
    const dist = Math.sqrt(dist2(src[i]!, src[i + 1]!, src[i + 2]!, bg));
    if (dist >= tol) continue; // clearly foreground colour — leave fully opaque
    const alphaFrac = Math.max(0.15, Math.min(1, (dist - innerR) / Math.max(1, tol - innerR)));
    d[i] = clampByte(bg[0] + (src[i]! - bg[0]) / alphaFrac);
    d[i + 1] = clampByte(bg[1] + (src[i + 1]! - bg[1]) / alphaFrac);
    d[i + 2] = clampByte(bg[2] + (src[i + 2]! - bg[2]) / alphaFrac);
    d[i + 3] = Math.round(alphaFrac * 255);
  }

  ctx.putImageData(im, 0, 0);
  return { canvas: c, bleed: opaquePx > 0 ? bleedPx / opaquePx : 0 };
};

/** Horizontal mirror (facing fix — sprites are right-facing by convention). */
export const flipCanvasH = (c: HTMLCanvasElement): HTMLCanvasElement => {
  const out = mkCanvas(c.width, c.height);
  const ctx = out.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingEnabled = false;
  ctx.translate(c.width, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(c, 0, 0);
  return out;
};

/** 16×16 binary silhouette over the alpha bbox — cheap pose/facing signature. */
export const silhouetteMask16 = (c: HTMLCanvasElement): number[] => {
  const bb = alphaBBox(c);
  const out = new Array(256).fill(0);
  if (!bb) return out;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  const bw = bb.r - bb.l + 1, bh = bb.b - bb.t + 1;
  for (let gy = 0; gy < 16; gy++) {
    for (let gx = 0; gx < 16; gx++) {
      // Sample the center of each grid cell.
      const x = bb.l + Math.floor(((gx + 0.5) / 16) * bw);
      const y = bb.t + Math.floor(((gy + 0.5) / 16) * bh);
      if (d[(y * c.width + x) * 4 + 3]! > 40) out[gy * 16 + gx] = 1;
    }
  }
  return out;
};

export const mirrorMask16 = (m: number[]): number[] => {
  const out = new Array(256).fill(0);
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) out[y * 16 + x] = m[y * 16 + (15 - x)]!;
  return out;
};

/** Fraction of differing cells between two masks (0 = identical). */
export const maskDiff = (a: number[], b: number[]): number => {
  let n = 0;
  for (let i = 0; i < 256; i++) if (a[i] !== b[i]) n++;
  return n / 256;
};

/**
 * Audit helper for SAVED cells (raw image long gone): count enclosed
 * bright/white pockets — the signature of legacy background bleed.
 */
export const enclosedWhitePockets = (c: HTMLCanvasElement): number => {
  const w = c.width, h = c.height;
  const d = c.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, w, h).data;
  const isWhite = (p: number): boolean => {
    const i = p * 4;
    return d[i + 3]! > 40 && d[i]! > 205 && d[i + 1]! > 205 && d[i + 2]! > 205;
  };
  const seen = new Uint8Array(w * h);
  const stack: number[] = [];
  let pockets = 0;
  for (let start = 0; start < w * h; start++) {
    if (seen[start] || !isWhite(start)) continue;
    const comp: number[] = [];
    let touchesAlpha = false;
    stack.push(start);
    seen[start] = 1;
    while (stack.length > 0) {
      const p = stack.pop()!;
      comp.push(p);
      const x = p % w;
      for (const q of [p - 1, p + 1, p - w, p + w]) {
        if (q < 0 || q >= w * h || Math.abs((q % w) - x) > 1) continue;
        if (d[q * 4 + 3]! <= 40) { touchesAlpha = true; continue; }
        if (!seen[q] && isWhite(q)) { seen[q] = 1; stack.push(q); }
      }
    }
    if (!touchesAlpha && comp.length >= 12) pockets++;
  }
  return pockets;
};

/**
 * Connected-component filter: keep only alpha blobs at least `keepRatio` the
 * size of the largest one. Kills detached drop shadows, watermark chunks, and
 * stray artifacts so the bbox/feet-anchor lock onto the actual character.
 * Returns the number of MAJOR blobs kept (>1 usually means the model drew
 * two figures — a QC failure).
 */
export const filterComponents = (c: HTMLCanvasElement, keepRatio = 0.3): number => {
  const w = c.width, h = c.height;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  const im = ctx.getImageData(0, 0, w, h);
  const d = im.data;
  const label = new Int32Array(w * h); // 0 = unvisited, else component id
  const sizes: number[] = [0];
  let nextId = 1;
  const stack: number[] = [];
  for (let start = 0; start < w * h; start++) {
    if (label[start] !== 0 || d[start * 4 + 3]! <= 40) continue;
    const id = nextId++;
    let size = 0;
    stack.push(start);
    label[start] = id;
    while (stack.length > 0) {
      const p = stack.pop()!;
      size++;
      const x = p % w, y = (p / w) | 0;
      for (const q of [p - 1, p + 1, p - w, p + w]) {
        if (q < 0 || q >= w * h) continue;
        const qx = q % w;
        if (Math.abs(qx - x) > 1) continue; // row wrap guard
        if (label[q] === 0 && d[q * 4 + 3]! > 40) { label[q] = id; stack.push(q); }
      }
    }
    sizes[id] = size;
  }
  if (nextId === 1) return 0;
  const largest = Math.max(...sizes);
  const keep = new Uint8Array(nextId);
  let majors = 0;
  for (let id = 1; id < nextId; id++) {
    if (sizes[id]! >= largest * keepRatio) { keep[id] = 1; majors++; }
  }
  for (let p = 0; p < w * h; p++) {
    if (label[p] !== 0 && !keep[label[p]!]) d[p * 4 + 3] = 0;
  }
  ctx.putImageData(im, 0, 0);
  return majors;
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
 * drift almost for free) via MEDIAN CUT. A top-buckets histogram is wrong
 * here: it rewards big uniform regions (black outlines, dark cloth) and
 * starves a character's signature colors (a red gi spread across many shaded
 * buckets never ranks). Median cut partitions the occupied color space, so
 * every distinct color family gets representation.
 */
export const extractPalette = (c: HTMLCanvasElement, n = 16): RGB[] => {
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  const px: [number, number, number][] = [];
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3]! >= 128) px.push([d[i]!, d[i + 1]!, d[i + 2]!]);
  }
  if (px.length === 0) return [];

  interface Box { pixels: [number, number, number][] }
  const range = (box: Box): { ch: number; span: number } => {
    const lo = [255, 255, 255], hi = [0, 0, 0];
    for (const p of box.pixels) {
      for (let ch = 0; ch < 3; ch++) {
        if (p[ch]! < lo[ch]!) lo[ch] = p[ch]!;
        if (p[ch]! > hi[ch]!) hi[ch] = p[ch]!;
      }
    }
    let ch = 0, span = -1;
    for (let k = 0; k < 3; k++) {
      if (hi[k]! - lo[k]! > span) { span = hi[k]! - lo[k]!; ch = k; }
    }
    return { ch, span };
  };

  const boxes: Box[] = [{ pixels: px }];
  while (boxes.length < n) {
    // Split the box with the widest channel span (deterministic tie-break by index).
    let best = -1, bestSpan = 0, bestCh = 0;
    for (let i = 0; i < boxes.length; i++) {
      if (boxes[i]!.pixels.length < 2) continue;
      const { ch, span } = range(boxes[i]!);
      if (span > bestSpan) { bestSpan = span; best = i; bestCh = ch; }
    }
    if (best < 0 || bestSpan === 0) break;
    const box = boxes[best]!;
    // Deterministic ordering: sort by split channel, then full RGB.
    box.pixels.sort((a, b) => a[bestCh]! - b[bestCh]!
      || a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]!);
    const mid = box.pixels.length >> 1;
    boxes.splice(best, 1,
      { pixels: box.pixels.slice(0, mid) },
      { pixels: box.pixels.slice(mid) });
  }

  return boxes.map((box) => {
    let r = 0, g = 0, b = 0;
    for (const p of box.pixels) { r += p[0]!; g += p[1]!; b += p[2]!; }
    const m = box.pixels.length;
    return [Math.round(r / m), Math.round(g / m), Math.round(b / m)] as RGB;
  });
};

/** Alpha bounding box (exported for Studio: reference body measurements). */
export const alphaBounds = (c: HTMLCanvasElement): { l: number; t: number; r: number; b: number } | null =>
  alphaBBox(c);

/**
 * Slice a generated animation STRIP (one image, N poses of the same character
 * side by side) into N single-pose canvases.
 *
 * This is the spec's §5.1 stage-2 answer to costume drift: generating each
 * frame as its own image makes the model re-invent the outfit every call.
 * Inside ONE image it draws ONE character, so the costume is consistent by
 * construction — we just have to cut it apart.
 *
 * Cutting is done on the background-removed image: columns with no opaque
 * pixels are gaps. Runs of occupied columns are figure candidates; we merge
 * across the narrowest gaps (detached limbs) or split at the deepest interior
 * minima until exactly `n` slices remain.
 */
/**
 * SHEET SLICER — cut a multi-row grid of figures into individual frames.
 *
 * Column projection (sliceStrip) only works for a single row. A grid needs
 * connected components: label every figure, drop specks, merge parts that
 * clearly belong to one body (a detached fist), then order them reading-wise
 * (rows top→bottom, left→right) so panel k maps to pose k.
 *
 * Returns exactly `n` canvases, or null if the figure count doesn't match —
 * the caller then falls back to per-frame generation rather than saving
 * mis-sliced junk.
 */
export const sliceSheet = (img: HTMLImageElement, n: number): HTMLCanvasElement[] | null => {
  const { canvas: cut } = removeBackground(img);
  const w = cut.width, h = cut.height;
  const d = cut.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, w, h).data;

  // --- label connected components (4-connectivity, iterative flood).
  interface Box { l: number; t: number; r: number; b: number; n: number }
  const seen = new Uint8Array(w * h);
  const stack: number[] = [];
  let boxes: Box[] = [];
  for (let start = 0; start < w * h; start++) {
    if (seen[start] || d[start * 4 + 3]! <= 40) continue;
    const box: Box = { l: w, t: h, r: -1, b: -1, n: 0 };
    stack.push(start);
    seen[start] = 1;
    while (stack.length > 0) {
      const p = stack.pop()!;
      const x = p % w, y = (p / w) | 0;
      box.n++;
      if (x < box.l) box.l = x;
      if (x > box.r) box.r = x;
      if (y < box.t) box.t = y;
      if (y > box.b) box.b = y;
      for (const q of [p - 1, p + 1, p - w, p + w]) {
        if (q < 0 || q >= w * h) continue;
        if (Math.abs((q % w) - x) > 1) continue; // row-wrap guard
        if (!seen[q] && d[q * 4 + 3]! > 40) { seen[q] = 1; stack.push(q); }
      }
    }
    boxes.push(box);
  }
  if (boxes.length === 0) return null;

  // --- drop specks (JPEG noise, stray pixels).
  const biggest = Math.max(...boxes.map((b) => b.n));
  boxes = boxes.filter((b) => b.n >= biggest * 0.08);

  // --- merge overlapping/adjacent boxes (a fist or foot detached from a body).
  const near = (a: Box, b: Box): boolean => {
    const gapX = Math.max(0, Math.max(a.l, b.l) - Math.min(a.r, b.r));
    const gapY = Math.max(0, Math.max(a.t, b.t) - Math.min(a.b, b.b));
    const tol = Math.round(Math.min(w, h) * 0.03);
    return gapX <= tol && gapY <= tol;
  };
  let merged = true;
  while (merged && boxes.length > n) {
    merged = false;
    outer:
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        if (!near(boxes[i]!, boxes[j]!)) continue;
        const a = boxes[i]!, b = boxes[j]!;
        boxes[i] = {
          l: Math.min(a.l, b.l), t: Math.min(a.t, b.t),
          r: Math.max(a.r, b.r), b: Math.max(a.b, b.b), n: a.n + b.n,
        };
        boxes.splice(j, 1);
        merged = true;
        break outer;
      }
    }
  }
  // Still too many? keep the n largest (the rest are debris).
  if (boxes.length > n) {
    boxes = [...boxes].sort((a, b) => b.n - a.n).slice(0, n);
  }
  if (boxes.length !== n) return null; // too few figures — model didn't comply

  // --- reading order: cluster into rows by vertical center, then sort by x.
  const cy = (b: Box): number => (b.t + b.b) / 2;
  const medH = [...boxes].map((b) => b.b - b.t).sort((a, b) => a - b)[boxes.length >> 1]!;
  const byY = [...boxes].sort((a, b) => cy(a) - cy(b));
  const rows: Box[][] = [];
  for (const b of byY) {
    const row = rows[rows.length - 1];
    if (row && Math.abs(cy(b) - cy(row[0]!)) < medH * 0.6) row.push(b);
    else rows.push([b]);
  }
  const ordered = rows.flatMap((row) => row.sort((a, b) => a.l - b.l));

  // --- emit each figure padded on white (the keyer downstream expects white).
  return ordered.map((b) => {
    const bw = b.r - b.l + 1;
    const bh = b.b - b.t + 1;
    const pad = Math.round(Math.max(bw, bh) * 0.12);
    const cw = bw + pad * 2;
    const ch = bh + pad * 2;
    const out = mkCanvas(cw, ch);
    const octx = out.getContext('2d', { willReadFrequently: true })!;
    octx.fillStyle = '#ffffff';
    octx.fillRect(0, 0, cw, ch);
    octx.drawImage(cut, b.l, b.t, bw, bh, pad, pad, bw, bh);
    return out;
  });
};

export const sliceStrip = (img: HTMLImageElement, n: number): HTMLCanvasElement[] | null => {
  const { canvas: cut } = removeBackground(img);
  const w = cut.width, h = cut.height;
  const d = cut.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, w, h).data;

  const colCount = new Int32Array(w);
  for (let x = 0; x < w; x++) {
    let k = 0;
    for (let y = 0; y < h; y++) if (d[(y * w + x) * 4 + 3]! > 40) k++;
    colCount[x] = k;
  }
  const MIN_COL = Math.max(2, Math.round(h * 0.01)); // ignore speck rows
  const occupied = (x: number): boolean => colCount[x]! >= MIN_COL;

  // Runs of occupied columns.
  interface Run { l: number; r: number }
  const runs: Run[] = [];
  for (let x = 0; x < w; x++) {
    if (!occupied(x)) continue;
    if (runs.length > 0 && x - runs[runs.length - 1]!.r <= 1) runs[runs.length - 1]!.r = x;
    else runs.push({ l: x, r: x });
  }
  if (runs.length === 0) return null;

  // Too many runs → merge across the narrowest gaps (a detached fist/leg).
  while (runs.length > n) {
    let best = -1, bestGap = Infinity;
    for (let i = 0; i + 1 < runs.length; i++) {
      const gap = runs[i + 1]!.l - runs[i]!.r;
      if (gap < bestGap) { bestGap = gap; best = i; }
    }
    if (best < 0) break;
    runs[best]!.r = runs[best + 1]!.r;
    runs.splice(best + 1, 1);
  }
  // Too few runs → figures touch. Split the widest run at its emptiest column.
  while (runs.length < n) {
    let best = -1, bestW = 0;
    for (let i = 0; i < runs.length; i++) {
      const rw = runs[i]!.r - runs[i]!.l;
      if (rw > bestW) { bestW = rw; best = i; }
    }
    if (best < 0 || bestW < 16) return null; // cannot split further
    const run = runs[best]!;
    // Deepest interior minimum, avoiding the outer 25% (that's the bodies).
    const lo = run.l + Math.floor(bestW * 0.25);
    const hi = run.r - Math.floor(bestW * 0.25);
    let cut2 = -1, cutVal = Infinity;
    for (let x = lo; x <= hi; x++) {
      if (colCount[x]! < cutVal) { cutVal = colCount[x]!; cut2 = x; }
    }
    if (cut2 < 0) return null;
    const right: Run = { l: cut2 + 1, r: run.r };
    run.r = cut2;
    runs.splice(best + 1, 0, right);
  }
  if (runs.length !== n) return null;

  // Emit each run as its own canvas (padded so normalize sees a clean subject).
  return runs.map((run) => {
    const rw = run.r - run.l + 1;
    const pad = Math.round(rw * 0.15);
    const cw = rw + pad * 2;
    const out = mkCanvas(cw, h);
    const octx = out.getContext('2d', { willReadFrequently: true })!;
    // White background so the downstream keyer behaves identically to a
    // freshly generated image.
    octx.fillStyle = '#ffffff';
    octx.fillRect(0, 0, cw, h);
    octx.drawImage(cut, run.l, 0, rw, h, pad, 0, rw, h);
    return out;
  });
};

/** Mean chroma (max-min channel) of opaque pixels — 0 for grayscale art. */
export const meanChroma = (c: HTMLCanvasElement): number => {
  const d = c.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, c.width, c.height).data;
  let sum = 0, n = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3]! <= 40) continue;
    const mx = Math.max(d[i]!, d[i + 1]!, d[i + 2]!);
    const mn = Math.min(d[i]!, d[i + 1]!, d[i + 2]!);
    sum += mx - mn;
    n++;
  }
  return n === 0 ? 0 : sum / n;
};

/**
 * Colour conformity against the locked palette: the fraction of opaque pixels
 * that sit close to SOME palette entry. Purely a QC score.
 *
 * `snap` repaints every pixel to its nearest palette colour. That is what
 * produced the flat 8-bit look, and it only ever existed to mask drift from
 * an unconditioned model. With reference conditioning it destroys the anime
 * shading for no benefit, so it defaults OFF. (Kept switchable — a future
 * genuinely-retro character can turn it back on.)
 */
export const quantizeToPalette = (
  c: HTMLCanvasElement, palette: RGB[], snap = false,
): number => {
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  const im = ctx.getImageData(0, 0, c.width, c.height);
  const d = im.data;
  const CLOSE2 = 60 * 60; // roomier: shading ramps sit between palette entries
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
    if (snap) {
      d[i] = palette[best]![0]; d[i + 1] = palette[best]![1]; d[i + 2] = palette[best]![2];
      d[i + 3] = 255;
    }
  }
  if (snap) ctx.putImageData(im, 0, 0);
  return opaque === 0 ? 0 : close / opaque;
};

export interface NormalizedFrame {
  cell: HTMLCanvasElement; // CELL_W×CELL_H, feet at (PIVOT_X, PIVOT_Y)
  bodyH: number; // body height in cell px after scaling
  bodyW: number;
  paletteMatch: number; // 0..1 pre-quantize conformity
  majorBlobs: number; // major connected components (>1 = probably two figures)
  bleed: number; // 0..1 fraction of surviving bg-colored pixels (key failure)
}

/**
 * Full normalize pass: bg removal → crop → scale to the standard body height
 * → feet-anchor into the fixed cell → colour conformity score.
 *
 * The downscale is SMOOTH (high-quality bilinear), not nearest-neighbour:
 * we are shrinking a ~700px anime figure into a 224px cell, and nearest
 * sampling throws away exactly the shading and line work that make it read as
 * anime rather than as a mosaic.
 */
export const normalizeFrame = (
  img: HTMLImageElement | HTMLCanvasElement, palette: RGB[] | null,
  refFigureH?: number,
): NormalizedFrame | null => {
  const { canvas: cut, bleed } = removeBackground(img);
  const majorBlobs = filterComponents(cut);
  const bb = alphaBBox(cut);
  if (!bb) return null;
  const srcW = bb.r - bb.l + 1, srcH = bb.b - bb.t + 1;

  /**
   * Scale reference. Using THIS frame's own bbox height forces every pose to
   * the same total extent — a crouch gets inflated to full height and a high
   * kick gets shrunk, so the fighter visibly changes size as it moves. When
   * the caller knows the character's true on-image height (the median across
   * a sheet, where the model drew one character at one scale), pass it as
   * `refFigureH`: all poses then share one scale and only the POSE differs.
   */
  let scale = TARGET_BODY_H / (refFigureH ?? srcH);
  // Guard: an extreme pose (a full sweep) must still fit its cell.
  const maxUp = PIVOT_Y; // headroom above the feet pivot
  scale = Math.min(scale, maxUp / srcH, CELL_W / srcW);

  const dw = Math.max(1, Math.round(srcW * scale));
  const dh = Math.max(1, Math.round(srcH * scale));

  const cell = mkCanvas(CELL_W, CELL_H);
  const ctx = cell.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(cut, bb.l, bb.t, srcW, srcH, PIVOT_X - (dw >> 1), PIVOT_Y - dh, dw, dh);

  // Score colour conformity; never repaint (see quantizeToPalette).
  const paletteMatch = palette ? quantizeToPalette(cell, palette, false) : 1;
  return { cell, bodyH: dh, bodyW: dw, paletteMatch, majorBlobs, bleed };
};

/**
 * Height of the figure in a raw (un-normalized) image, in that image's own px.
 * The batch takes the MEDIAN of these across a sheet's panels to get the
 * character's true drawn size, independent of how far any one pose reaches.
 */
export const measureFigureH = (img: HTMLImageElement | HTMLCanvasElement): number | null => {
  const { canvas: cut } = removeBackground(img);
  filterComponents(cut);
  const bb = alphaBBox(cut);
  return bb ? bb.b - bb.t + 1 : null;
};

export interface QCResult {
  score: number; // 0..100
  paletteMatch: number;
  heightRatio: number; // body height vs reference
  pass: boolean;
}

/** Per-frame QC vs the reference sheet (spec §5.1 stage 4). */
export const qcScore = (
  frame: NormalizedFrame, refBodyW: number | null, passAt = 55, refChroma: number | null = null,
): QCResult => {
  const paletteMatch = frame.paletteMatch;
  // Height is normalized by construction; width drift is the real proportion signal.
  const heightRatio = refBodyW ? frame.bodyW / refBodyW : 1;
  const proportionOK = heightRatio > 0.45 && heightRatio < 2.2; // poses legitimately widen
  let score = Math.round(
    paletteMatch * 70 + (proportionOK ? 30 : Math.max(0, 30 - Math.abs(1 - heightRatio) * 30)));
  // Two comparable figures in frame = the model drew a second character.
  if (frame.majorBlobs > 1) score = Math.min(score, 35);
  // Surviving background-colored area = key failure (bleed).
  if (frame.bleed > 0.06) score = Math.min(score, Math.round(50 - frame.bleed * 100));
  // Desaturation vs a colorful reference: the model drew the character in
  // grayscale — quantization cannot restore color, so reject and reroll.
  if (refChroma !== null && refChroma >= 40 && meanChroma(frame.cell) < refChroma * 0.4) {
    score = Math.min(score, 40);
  }
  return { score, paletteMatch, heightRatio, pass: score >= passAt };
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
    // Boxes live in WORLD px; the cell is supersampled sprite px. Convert.
    out.push({
      x: Math.round((l - PIVOT_X) * SPRITE_SCALE),
      y: Math.round((y0 - PIVOT_Y) * SPRITE_SCALE),
      w: Math.max(1, Math.round((r - l + 1) * SPRITE_SCALE)),
      h: Math.max(1, Math.round((y1 - y0 + 1) * SPRITE_SCALE)),
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
  // World px, not sprite px (the cell is supersampled).
  return {
    x: Math.round((l - PIVOT_X) * SPRITE_SCALE),
    y: Math.round((t - PIVOT_Y) * SPRITE_SCALE),
    w: Math.max(1, Math.round((r - l + 1) * SPRITE_SCALE)),
    h: Math.max(1, Math.round((b - t + 1) * SPRITE_SCALE)),
  };
};

export const canvasToPngDataUrl = (c: HTMLCanvasElement): string => c.toDataURL('image/png');
