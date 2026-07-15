/**
 * Zero-dependency PWA icon generator. Rasterizes a branded "AF" monogram
 * (Agent Fighter gold on the dark title-screen backdrop) straight to PNG via
 * Node's built-in zlib — no canvas/sharp/imagemagick needed, so it runs in any
 * environment and Vercel's build box.
 *
 * Letters are drawn as anti-aliased capsule strokes (per-pixel distance to line
 * segments), so every output size is crisp rather than a resampled blur. All
 * content sits within the central ~62% of the square, keeping it safe for
 * Android "maskable" cropping while still filling Apple's opaque tile.
 *
 * Run:  node tools/make-icons.mjs   (invoked automatically by bundle.mjs)
 * Out:  assets/icons/*.png  (served at /assets/icons/* on dev + Vercel)
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, '..', 'assets', 'icons');

// ---- palette (matches ui.ts brand) ---------------------------------------
const BG_TOP = [0x1a, 0x0f, 0x2e]; // deep violet
const BG_BOT = [0x07, 0x05, 0x0d]; // near-black
const GOLD = [0xff, 0xd1, 0x66];
const GOLD_DK = [0xd9, 0xa4, 0x41];

const lerp = (a, b, t) => a + (b - a) * t;
const mix = (c0, c1, t) => [lerp(c0[0], c1[0], t), lerp(c0[1], c1[1], t), lerp(c0[2], c1[2], t)];
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (e0, e1, x) => { const t = clamp01((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };

/** Shortest distance from point p to segment ab. */
const distSeg = (px, py, ax, ay, bx, by) => {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy || 1;
  let t = ((px - ax) * dx + (py - ay) * dy) / l2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = ax + t * dx, qy = ay + t * dy;
  return Math.hypot(px - qx, py - qy);
};

/**
 * Build the strokes (in 0..1 unit space) that spell "AF". Cross-height letters,
 * apex-topped A on the left, bar-topped F on the right.
 */
const glyphStrokes = () => {
  const top = 0.30, bot = 0.70, h = bot - top;
  // A occupies x 0.24..0.485, F occupies 0.515..0.71
  const aL = 0.24, aR = 0.485, aC = (aL + aR) / 2;
  const fL = 0.545, fR = 0.72;
  const bar = top + h * 0.60; // A crossbar / F midbar height
  const aBarL = lerp(aC, aL, (bar - top) / h);
  const aBarR = lerp(aC, aR, (bar - top) / h);
  return [
    [aC, top, aL, bot],        // A: left leg
    [aC, top, aR, bot],        // A: right leg
    [aBarL, bar, aBarR, bar],  // A: crossbar
    [fL, top, fL, bot],        // F: stem
    [fL, top, fR, top],        // F: top bar
    [fL, bar, fL + (fR - fL) * 0.78, bar], // F: mid bar
  ];
};

const STROKES = glyphStrokes();

const encodePng = (w, h, rgba) => {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const idat = deflateSync(raw, { level: 9 });
  const crcTable = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
    return t;
  })();
  const crc32 = (buf) => { let c = ~0; for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return ~c >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td), 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0)),
  ]);
};

/** Render one icon. `opaque` fills alpha=255 everywhere (Apple tiles want no transparency). */
const renderIcon = (size, opaque) => {
  const buf = Buffer.alloc(size * size * 4);
  const stroke = 0.052;             // half-width of a letter stroke, in unit space
  const glow = stroke * 2.4;        // soft gold aura radius
  const r = size * 0.5, cx = r, cy = r;
  const corner = size * 0.235;      // rounded-square mask radius
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size, v = (y + 0.5) / size;
      // background vertical gradient
      let col = mix(BG_TOP, BG_BOT, v);
      // subtle radial vignette toward corners
      const rad = Math.hypot(u - 0.5, v - 0.5) / 0.707;
      col = mix(col, BG_BOT, smooth(0.55, 1.0, rad) * 0.6);

      // nearest distance to any glyph stroke
      let d = Infinity;
      for (const [ax, ay, bx, by] of STROKES) { const dd = distSeg(u, v, ax, ay, bx, by); if (dd < d) d = dd; }
      // soft outer glow, then crisp letter body
      const aura = (1 - smooth(stroke, glow, d)) * 0.35;
      col = mix(col, GOLD_DK, aura);
      const ink = 1 - smooth(stroke - 1.4 / size, stroke + 1.4 / size, d);
      if (ink > 0) {
        // top-lit letter face: brighter gold up top, deeper toward the base
        const face = mix(GOLD, GOLD_DK, smooth(0.30, 0.72, v));
        col = mix(col, face, ink);
      }

      // rounded-square alpha mask (soft 1px edge)
      let a = 255;
      if (!opaque) {
        const qx = Math.abs(x + 0.5 - cx) - (r - corner);
        const qy = Math.abs(y + 0.5 - cy) - (r - corner);
        const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - corner;
        a = Math.round(255 * (1 - smooth(-1.0, 1.0, outside)));
      }
      const i = (y * size + x) * 4;
      buf[i] = Math.round(col[0]); buf[i + 1] = Math.round(col[1]); buf[i + 2] = Math.round(col[2]); buf[i + 3] = a;
    }
  }
  return encodePng(size, size, buf);
};

mkdirSync(OUT, { recursive: true });
const jobs = [
  ['icon-192.png', 192, false],
  ['icon-512.png', 512, false],
  ['icon-maskable-512.png', 512, false],
  ['apple-touch-icon.png', 180, true], // opaque tile for iOS home screen
];
for (const [name, size, opaque] of jobs) {
  writeFileSync(join(OUT, name), renderIcon(size, opaque));
  console.log(`icon → assets/icons/${name} (${size}px)`);
}
