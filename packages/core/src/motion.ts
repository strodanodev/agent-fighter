import { Btn, held } from './input.js';
import type { InputFrame } from './input.js';
import { TUNING } from './data.js';

/**
 * Motion input parsing. Each fighter keeps a ring buffer of numpad-notation
 * directions (facing-relative, 6 = toward opponent) in GameState. On every
 * attack-button press the parser scans the recent window for 623 / 236 / 214
 * — lenient, MvC style: the motion matches as a subsequence, diagonals
 * optional. All integer math over serialized state; fully deterministic.
 */

export const HIST_LEN = 16; // ring buffer length (> motionWindowTicks)

/** Current direction as numpad notation, relative to facing (6 = forward). */
export const numpadDir = (input: InputFrame, facing: 1 | -1): number => {
  const rawX = (held(input, Btn.Right) ? 1 : 0) - (held(input, Btn.Left) ? 1 : 0);
  const fx = rawX * facing; // +1 = toward opponent
  const base = held(input, Btn.Up) ? 8 : held(input, Btn.Down) ? 2 : 5;
  return base + fx;
};

/**
 * Does the last `window` entries of the ring buffer contain `pattern` as a
 * subsequence (oldest → newest)? Diagonal-tolerant variants are expressed by
 * passing alternate accepted dirs per slot (bitmask of numpad dirs 1-9).
 */
const matchesPattern = (
  hist: number[], histIdx: number, window: number, pattern: number[],
): boolean => {
  let p = 0;
  for (let k = window - 1; k >= 0 && p < pattern.length; k--) {
    const dir = hist[(histIdx - k + HIST_LEN * 2) % HIST_LEN]!;
    if ((pattern[p]! & (1 << dir)) !== 0) p++;
  }
  return p === pattern.length;
};

const D = (...dirs: number[]): number => dirs.reduce((m, d) => m | (1 << d), 0);

// Lenient patterns (each slot is a set of accepted dirs):
// 623 (DP): forward, down(-ish), down-forward — classic f, d, df.
const PAT_623 = [D(6), D(2, 1), D(3)];
// 236 (QCF): down, forward — diagonal optional (2,3,6 or sloppy 2,6).
const PAT_236 = [D(2), D(3, 6)];
const PAT_236_STRICT_END = [D(2), D(6)];
// 214 (QCB): mirrored.
const PAT_214 = [D(2), D(1, 4)];
const PAT_214_STRICT_END = [D(2), D(4)];

/**
 * Detect the strongest motion ending at the current history position.
 * Priority: 623 > 236 > 214 (DP wins ambiguous overlaps, as in the genre).
 * Returns 623 | 236 | 214 | 0.
 */
export const detectMotion = (hist: number[], histIdx: number): number => {
  const w = TUNING.motionWindowTicks;
  if (matchesPattern(hist, histIdx, w, PAT_623)) return 623;
  if (matchesPattern(hist, histIdx, w, PAT_236) || matchesPattern(hist, histIdx, w, PAT_236_STRICT_END)) return 236;
  if (matchesPattern(hist, histIdx, w, PAT_214) || matchesPattern(hist, histIdx, w, PAT_214_STRICT_END)) return 214;
  return 0;
};

/** Was a down input seen recently (tap-down → up = super jump)? */
export const downTappedRecently = (hist: number[], histIdx: number): boolean => {
  for (let k = 1; k <= TUNING.superJumpDownWindow; k++) {
    const dir = hist[(histIdx - k + HIST_LEN * 2) % HIST_LEN]!;
    if (dir >= 1 && dir <= 3) return true;
  }
  return false;
};
