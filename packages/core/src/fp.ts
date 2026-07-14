/**
 * Fixed-point math. All sim positions/velocities are integers in 1/256 px
 * ("subpixels", 24.8 fixed point). Determinism rule: the sim NEVER stores or
 * computes with floats. JS doubles represent integers exactly up to 2^53,
 * and all our products stay far below that, so integer math here is
 * bit-identical across engines/platforms.
 */
export const FP = 256;

/** Convert whole pixels to fixed-point. */
export const fp = (px: number): number => Math.trunc(px * FP);

/** Fixed-point multiply: (a * b) / FP, truncated toward zero. */
export const fpMul = (a: number, b: number): number => Math.trunc((a * b) / FP);

/** Truncate toward zero to pixels (for rendering / hitbox rects only). */
export const fpToPx = (v: number): number => Math.trunc(v / FP);

/** Clamp integer value. */
export const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

/**
 * Deterministic PRNG (mulberry32-style, integer-only variant).
 * Lives inside GameState; never use Math.random in the sim.
 */
export const nextRand = (seed: number): number => {
  let t = (seed + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t = (t + Math.imul(t ^ (t >>> 7), t | 61)) | 0;
  return (t ^ (t >>> 14)) >>> 0;
};
