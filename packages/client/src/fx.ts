/**
 * Cosmetic FX layer — particles, glows, animated outlines. Client-only eye
 * candy; NONE of this touches the sim (spec: "cosmetic effects live
 * client-side only, keyed off state changes"), so it may use Math.random and
 * float math freely and is safe under future rollback (it is never simulated,
 * only re-derived from whatever GameState the frame is showing).
 *
 * DEPENDENCY-FREE LEAF. It imports nothing from the client — everything is
 * passed in as plain numbers/colors — so it can sit before ui.ts/main.ts in
 * the bundle with no import cycle. Two families live here:
 *
 *   1. A pooled PARTICLE SYSTEM (emit* → updateFx → drawFx). Particles are
 *      drawn additively as cached soft-dot sprites, so hundreds of them bloom
 *      and stack cheaply without a per-particle gradient allocation.
 *   2. Stateless IMMEDIATE-MODE helpers (auraGlow / glowBar / warningPulse /
 *      marchingOutline / fxPulse) the HUD and world renderer call directly to
 *      wrap bars, frames and characters in glow.
 *
 * WHY NOT three.js / WebGL: the renderer is a single 2D canvas and the bundle
 * is one self-contained file with no CDN. A WebGL layer would mean a second
 * stacked canvas or a full rewrite for effects 2D already does well. See the
 * commit that introduced this file.
 */

export type FxLayer = 'world' | 'screen';

interface FxParticle {
  x: number; y: number; vx: number; vy: number;
  age: number; life: number; // ticks
  size: number; // draw radius at birth (px)
  grow: number; // size delta per tick
  drag: number; // velocity retention per tick (1 = none)
  grav: number; // added to vy per tick
  r: number; g: number; b: number;
  layer: FxLayer;
}

interface FxRing {
  x: number; y: number; age: number; life: number;
  r0: number; r1: number; width: number; color: string; layer: FxLayer;
}

// Hard caps: a runaway emitter can never tank the frame. At the cap, new
// spawns are dropped (the scene is already saturated, so nobody notices).
const FX_MAX_PARTICLES = 600;
const FX_MAX_RINGS = 24;
const fxPool: FxParticle[] = [];
const fxRings: FxRing[] = [];

const fxRnd = (a: number, b: number): number => a + Math.random() * (b - a);

/** #rrggbb (or #rgb) → [r,g,b]. Tolerates a leading '#'. */
const parseHex = (hex: string): [number, number, number] => {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h[0]! + h[0]! + h[1]! + h[1]! + h[2]! + h[2]!;
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

/**
 * Cached soft-dot sprite per quantized color. A radial gradient (opaque
 * center → transparent edge) rendered ONCE per color bucket and reused via
 * drawImage — the whole reason hundreds of additive particles stay cheap
 * (building a gradient per particle per frame is the classic canvas trap).
 * Keyed on the top 4 bits of each channel so the cache can't grow unbounded.
 */
const fxDotCache = new Map<number, HTMLCanvasElement>();
const softDot = (r: number, g: number, b: number): HTMLCanvasElement => {
  const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
  let dot = fxDotCache.get(key);
  if (dot) return dot;
  const S = 64;
  dot = document.createElement('canvas');
  dot.width = S; dot.height = S;
  const c = dot.getContext('2d')!;
  const grd = c.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  grd.addColorStop(0, `rgba(${r},${g},${b},1)`);
  grd.addColorStop(0.4, `rgba(${r},${g},${b},0.55)`);
  grd.addColorStop(1, `rgba(${r},${g},${b},0)`);
  c.fillStyle = grd;
  c.fillRect(0, 0, S, S);
  fxDotCache.set(key, dot);
  return dot;
};

interface SpawnOpts {
  x: number; y: number; vx: number; vy: number;
  life: number; size: number; grow?: number; drag?: number; grav?: number;
  color: [number, number, number]; layer: FxLayer;
}
const spawn = (o: SpawnOpts): void => {
  if (fxPool.length >= FX_MAX_PARTICLES) return;
  fxPool.push({
    x: o.x, y: o.y, vx: o.vx, vy: o.vy, age: 0, life: o.life,
    size: o.size, grow: o.grow ?? 0, drag: o.drag ?? 0.92, grav: o.grav ?? 0,
    r: o.color[0], g: o.color[1], b: o.color[2], layer: o.layer,
  });
};

// ---------------------------------------------------------------- emitters
/**
 * Impact burst — a radial spray of embers for a hit. `power` scales count,
 * speed and size (light jab vs heavy launcher). Gravity pulls them down so
 * they arc like debris rather than floating.
 */
export const emitBurst = (
  x: number, y: number, color: string, power = 1, layer: FxLayer = 'world',
): void => {
  const [r, g, b] = parseHex(color);
  const n = Math.round(8 + 10 * power);
  for (let i = 0; i < n; i++) {
    const ang = fxRnd(0, Math.PI * 2);
    const spd = fxRnd(1.5, 5.5) * power;
    spawn({
      x, y, vx: Math.cos(ang) * spd, vy: Math.sin(ang) * spd - 1,
      life: fxRnd(10, 20), size: fxRnd(3, 7) * Math.sqrt(power), grow: -0.15,
      drag: 0.9, grav: 0.35, color: [r, g, b], layer,
    });
  }
  // A couple of hot white core sparks for punch.
  for (let i = 0; i < Math.round(3 * power); i++) {
    const ang = fxRnd(0, Math.PI * 2);
    spawn({
      x, y, vx: Math.cos(ang) * fxRnd(2, 6), vy: Math.sin(ang) * fxRnd(2, 6),
      life: fxRnd(6, 12), size: fxRnd(2, 4), drag: 0.85, color: [255, 255, 255], layer,
    });
  }
};

/**
 * Aura motes — a trickle of embers drifting UP off a character (charged
 * meter, critical health). Call once per frame; `rate` is the expected motes
 * per frame (fractional rate honored probabilistically so intensity ramps
 * smoothly rather than snapping between whole numbers).
 */
export const emitAura = (
  x: number, y: number, halfW: number, halfH: number, color: string, rate = 1,
): void => {
  const [r, g, b] = parseHex(color);
  let count = Math.floor(rate);
  if (Math.random() < rate - count) count++;
  for (let i = 0; i < count; i++) {
    spawn({
      x: x + fxRnd(-halfW, halfW), y: y + fxRnd(-halfH * 0.3, halfH),
      vx: fxRnd(-0.3, 0.3), vy: fxRnd(-1.8, -0.8),
      life: fxRnd(18, 34), size: fxRnd(2.5, 5), grow: -0.06, drag: 0.98, grav: -0.02,
      color: [r, g, b], layer: 'world',
    });
  }
};

/** Expanding shockwave ring — round announcements, super activation, KO. */
export const emitRing = (
  x: number, y: number, maxR: number, color: string,
  { life = 26, width = 4, layer = 'screen' as FxLayer } = {},
): void => {
  if (fxRings.length >= FX_MAX_RINGS) fxRings.shift();
  fxRings.push({ x, y, age: 0, life, r0: 8, r1: maxR, width, color, layer });
};

// ---------------------------------------------------------------- sim step
/** Advance every particle & ring one frame; cull the dead. Call once/frame. */
export const updateFx = (): void => {
  for (let i = fxPool.length - 1; i >= 0; i--) {
    const p = fxPool[i]!;
    p.x += p.vx; p.y += p.vy;
    p.vx *= p.drag; p.vy = p.vy * p.drag + p.grav;
    p.size += p.grow;
    if (++p.age >= p.life || p.size <= 0.2) {
      fxPool[i] = fxPool[fxPool.length - 1]!;
      fxPool.pop();
    }
  }
  for (let i = fxRings.length - 1; i >= 0; i--) {
    if (++fxRings[i]!.age >= fxRings[i]!.life) {
      fxRings[i] = fxRings[fxRings.length - 1]!;
      fxRings.pop();
    }
  }
};

/** Draw all particles & rings tagged for `layer`. Additive (glowy) blend. */
export const drawFx = (ctx: CanvasRenderingContext2D, layer: FxLayer): void => {
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (const p of fxPool) {
    if (p.layer !== layer) continue;
    // Ease-out fade over life; small tail so particles don't pop out.
    const t = p.age / p.life;
    ctx.globalAlpha = Math.max(0, 1 - t * t);
    const d = p.size * 2;
    ctx.drawImage(softDot(p.r, p.g, p.b), p.x - p.size, p.y - p.size, d, d);
  }
  ctx.globalAlpha = 1;
  for (const r of fxRings) {
    if (r.layer !== layer) continue;
    const t = r.age / r.life;
    const rad = r.r0 + (r.r1 - r.r0) * (1 - (1 - t) * (1 - t)); // ease-out expand
    ctx.globalAlpha = Math.max(0, 1 - t);
    ctx.strokeStyle = r.color;
    ctx.lineWidth = r.width * (1 - t * 0.6);
    ctx.beginPath();
    ctx.arc(r.x, r.y, rad, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
};

/** True when nothing is animating — lets callers skip a layer's draw pass. */
export const fxIdle = (): boolean => fxPool.length === 0 && fxRings.length === 0;

// ------------------------------------------------- immediate-mode glow helpers
/** Sine oscillator 0..1 (remapped to [lo,hi]) — the workhorse pulse clock. */
export const fxPulse = (tick: number, speed = 1, lo = 0, hi = 1): number =>
  lo + (hi - lo) * (0.5 + 0.5 * Math.sin(tick * speed));

/**
 * Soft radial glow centered on a point — a character's aura, a projectile
 * halo, any "energy" bloom. Additive, so it lightens whatever it sits over
 * instead of muddying it. `intensity` 0..1 scales opacity.
 */
export const auraGlow = (
  ctx: CanvasRenderingContext2D, x: number, y: number, radius: number,
  color: string, intensity: number,
): void => {
  if (intensity <= 0) return;
  const [r, g, b] = parseHex(color);
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const grd = ctx.createRadialGradient(x, y, 0, x, y, radius);
  grd.addColorStop(0, `rgba(${r},${g},${b},${0.55 * intensity})`);
  grd.addColorStop(0.5, `rgba(${r},${g},${b},${0.22 * intensity})`);
  grd.addColorStop(1, `rgba(${r},${g},${b},0)`);
  ctx.fillStyle = grd;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
};

/**
 * Blurred halo hugging a rectangle (a health frame, a meter bar) — the "this
 * element is HOT" treatment. `alpha` lets the caller pulse it.
 */
export const glowBar = (
  ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number,
  color: string, blur = 12, alpha = 1,
): void => {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.shadowColor = color;
  ctx.shadowBlur = blur;
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  // Stroke twice: the blur builds up into a real halo without a fill washing
  // out the element it wraps.
  ctx.strokeRect(x, y, w, h);
  ctx.strokeRect(x, y, w, h);
  ctx.restore();
};

/**
 * Danger throb for a rectangle (low health): a red edge whose glow breathes.
 * Encapsulates the pulse so every "urgent" element reads identically.
 */
export const warningPulse = (
  ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number,
  tick: number, color = '#e94560',
): void => {
  glowBar(ctx, x, y, w, h, color, 8 + 10 * fxPulse(tick, 0.22), fxPulse(tick, 0.22, 0.35, 0.9));
};

/**
 * Animated marching-ants outline — the classic "selected / ready" cue. The
 * dash offset scrolls with `tick`, so the outline appears to travel around
 * the rect. Used for the active select frame and a fully-charged meter bar.
 */
export const marchingOutline = (
  ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number,
  tick: number, color = '#ffd166', dash = 10, speed = 0.6,
): void => {
  ctx.save();
  ctx.setLineDash([dash, dash]);
  ctx.lineDashOffset = -tick * speed;
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.shadowColor = color;
  ctx.shadowBlur = 6;
  ctx.strokeRect(x, y, w, h);
  ctx.restore();
};
