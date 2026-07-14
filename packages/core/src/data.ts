import { Btn } from './input.js';

/**
 * Declarative character bundle format (build-spec §3) + engine tuning
 * constants. Characters are DATA, not code: the engine interprets these
 * tables. A bundle is JSON-shaped (plain numbers/strings/arrays only) so it
 * can move to real `moves.json`/`cancels.json` files with zod validation in
 * the M2 Studio without changing shape.
 *
 * Distances are whole pixels; velocities are px/tick (converted to fixed
 * point with fp() at use — trunc is deterministic, so identical bundle
 * numbers produce identical sim integers on every platform).
 */

export interface Rect {
  /** Offsets relative to fighter origin (feet center), +x = facing dir. Pixels. */
  x: number;
  y: number;
  w: number;
  h: number;
}

export type GuardKind = 'mid' | 'low' | 'overhead' | 'unblockable';

export interface HitboxDef {
  rect: Rect;
  damage: number;
  chip: number;
  hitstun: number; // frames
  blockstun: number; // frames
  hitstopFrames: number;
  pushbackHit: number; // px/tick applied to victim
  pushbackBlock: number;
  guard: GuardKind;
  juggleCost: number;
  launcher?: boolean; // pops the victim up for air combos
  launchVelY?: number; // px/tick, negative = up (launcher hits)
  airPopVelY?: number; // re-pop velocity when the victim is juggled mid-air
  knockdown?: boolean; // victim falls into untechable knockdown
}

export type MovePhase = 'startup' | 'active' | 'recovery';
export type MoveStance = 'stand' | 'crouch' | 'air';
export type MoveKind = 'normal' | 'special' | 'super' | 'system';
export type ButtonName = 'LP' | 'MP' | 'HP' | 'LK' | 'MK' | 'HK';

export interface MoveStep {
  frames: number;
  phase: MovePhase;
  hurtboxes: Rect[];
  hitboxes?: HitboxDef[];
  /** Self velocity impulse applied when this step begins. px/tick, x is facing-relative. */
  velX?: number;
  velY?: number;
  /** Sprite frame name (atlas key / sprites/<name>.png). Cosmetic only — never read by the sim. */
  sprite?: string;
}

export interface ProjectileDef {
  spawnX: number; // px from origin, facing-relative
  spawnY: number;
  velX: number; // px/tick, facing-relative
  lifetime: number; // ticks
  rect: Rect; // hit rect around projectile center (+x = travel dir)
  hit: HitboxDef;
}

export interface MoveDef {
  id: string; // numpad notation: "5LP", "2HP", "j.HK", "236P", "236PP"
  type: MoveKind;
  stance: MoveStance;
  button?: ButtonName; // normals: which button triggers it
  motion?: 236 | 214 | 623; // specials/supers: required motion
  buttons?: 'P' | 'K' | 'PP'; // specials: button class; supers: 'PP'
  steps: MoveStep[];
  projectile?: ProjectileDef; // spawned when the first active step begins
  meterGainWhiff: number;
  meterGainHit: number;
  meterCost?: number; // supers
}

export interface CancelEdge {
  from: string;
  to: string[];
  on: ('hit' | 'block' | 'whiff')[];
}

export interface CharacterBundle {
  name: string;
  maxHealth: number;
  walkFSpeed: number; // px/tick
  walkBSpeed: number;
  dashFSpeed: number;
  dashFTicks: number;
  dashBSpeed: number;
  dashBTicks: number;
  jumpVelY: number; // px/tick, negative = up
  superJumpVelY: number;
  jumpVelX: number; // horizontal speed of angled jumps
  gravity: number; // px/tick²
  doubleJump: boolean;
  airDash: boolean;
  airDashSpeed: number;
  airDashTicks: number;
  bodyWidth: number; // px, for push collision
  standHurtbox: Rect;
  crouchHurtbox: Rect;
  airHurtbox: Rect;
  throwRange: number; // px
  throwDamage: number;
  throwTossVelX: number;
  throwTossVelY: number;
  moves: MoveDef[];
  cancels: CancelEdge[];
}

// ---------------------------------------------------------------------------
// Loaded character: bundle + precomputed lookup tables the sim uses per tick.
// Built once at load; all lookups by integer index (deterministic).
// ---------------------------------------------------------------------------

export const BUTTON_BITS: Record<ButtonName, number> = {
  LP: Btn.LP, MP: Btn.MP, HP: Btn.HP, LK: Btn.LK, MK: Btn.MK, HK: Btn.HK,
};

/** Resolution priority when several buttons are pressed the same frame. */
export const BUTTON_PRIORITY: ButtonName[] = ['HP', 'HK', 'MP', 'MK', 'LP', 'LK'];

const STANCE_IDX: Record<MoveStance, number> = { stand: 0, crouch: 1, air: 2 };

export interface LoadedCharacter {
  b: CharacterBundle;
  /** moves[i] resolved by index everywhere in the sim (state stores indices). */
  moveIdxById: Record<string, number>;
  /** [stance 0..2] → (button bit → move index). Missing = -1. */
  normals: Int32Array[]; // 3 × 10-bit lookup by button bit position
  specials: { motion: number; kind: 'P' | 'K'; idx: number }[];
  superIdx: number;
  totalFrames: Int32Array; // per move
  firstActiveStep: Int32Array; // per move, -1 if none
  cancelHit: Uint8Array; // n×n matrix
  cancelBlock: Uint8Array;
}

const bitPos = (bit: number): number => {
  let p = 0;
  while ((bit >>= 1) !== 0) p++;
  return p;
};

/** Validate + index a character bundle. Throws on malformed data. */
export const loadCharacter = (b: CharacterBundle): LoadedCharacter => {
  const n = b.moves.length;
  const moveIdxById: Record<string, number> = {};
  b.moves.forEach((m, i) => {
    if (moveIdxById[m.id] !== undefined) throw new Error(`duplicate move id: ${m.id}`);
    if (m.steps.length === 0) throw new Error(`move ${m.id} has no steps`);
    for (const st of m.steps) {
      if (!Number.isInteger(st.frames) || st.frames <= 0) {
        throw new Error(`move ${m.id}: step frames must be positive integers`);
      }
    }
    moveIdxById[m.id] = i;
  });

  const normals = [new Int32Array(10).fill(-1), new Int32Array(10).fill(-1), new Int32Array(10).fill(-1)];
  const specials: LoadedCharacter['specials'] = [];
  let superIdx = -1;
  const totalFrames = new Int32Array(n);
  const firstActiveStep = new Int32Array(n).fill(-1);

  b.moves.forEach((m, i) => {
    totalFrames[i] = m.steps.reduce((acc, s) => acc + s.frames, 0);
    const act = m.steps.findIndex((s) => s.phase === 'active');
    firstActiveStep[i] = act;
    if (m.type === 'normal') {
      if (!m.button) throw new Error(`normal ${m.id} missing button`);
      normals[STANCE_IDX[m.stance]]![bitPos(BUTTON_BITS[m.button])] = i;
    } else if (m.type === 'special') {
      if (!m.motion || !m.buttons || m.buttons === 'PP') throw new Error(`special ${m.id} needs motion + P/K`);
      specials.push({ motion: m.motion, kind: m.buttons, idx: i });
    } else if (m.type === 'super') {
      if (!m.motion || m.buttons !== 'PP') throw new Error(`super ${m.id} needs motion + PP`);
      if (m.meterCost === undefined) throw new Error(`super ${m.id} missing meterCost`);
      superIdx = i;
    }
  });

  const cancelHit = new Uint8Array(n * n);
  const cancelBlock = new Uint8Array(n * n);
  for (const edge of b.cancels) {
    const from = moveIdxById[edge.from];
    if (from === undefined) throw new Error(`cancel edge from unknown move: ${edge.from}`);
    for (const toId of edge.to) {
      const to = moveIdxById[toId];
      if (to === undefined) throw new Error(`cancel edge to unknown move: ${toId}`);
      if (edge.on.includes('hit')) cancelHit[from * n + to] = 1;
      if (edge.on.includes('block')) cancelBlock[from * n + to] = 1;
    }
  }

  return { b, moveIdxById, normals, specials, superIdx, totalFrames, firstActiveStep, cancelHit, cancelBlock };
};

// ---------------------------------------------------------------------------
// Stage + global tuning. These are the knobs that make it feel like MvC —
// they live here (data), not scattered through sim logic.
// ---------------------------------------------------------------------------

export const STAGE = {
  widthPx: 1600, // ~2.5 viewport-widths of 960 minus margins; camera scrolls
  floorYPx: 460,
  wallPad: 24,
  viewportW: 960,
  viewportH: 540,
} as const;

export const TICKS_PER_SEC = 60;
export const ROUND_SECONDS = 99;

export const TUNING = {
  roundsToWin: 2, // best of 3
  preRoundTicks: 60,
  roundOverTicks: 120,
  meterMax: 3000, // 3 bars
  meterBar: 1000,
  superFlashTicks: 28,
  inputBufferTicks: 8,
  motionWindowTicks: 14,
  doubleTapWindowTicks: 11,
  superJumpDownWindow: 10, // ticks between down-tap and up for super jump
  jumpSquatTicks: 4,
  landingRecovers: true,
  juggleBudget: 8,
  scalingStart: 1000, // per-mille
  scalingMult: 900, // compounding ×0.9 per hit
  scalingFloor: 200, // 20% floor
  minHitstun: 8,
  hitstunDecayShift: 1, // effective stun = base - (comboHits >> shift)
  knockdownTicks: 36,
  getupTicks: 14,
  grabTicks: 18, // throw connects at end unless teched
  throwTechWindow: 10,
  pushblockSelfVel: 12, // px/tick the blocker slides back (must clearly beat heavy pushbackBlock)
  pushblockAttackerVel: 7, // applied to attacker when blocker is cornered
  victimMeterDivisor: 20, // victim gains damage/20 meter
  blockMeterGain: 10,
  friction: 0.5, // px/tick² ground slide decel
  cornerThresholdPx: 26, // "at the wall" for pushback transfer
  throwStartsComboScaling: true,
} as const;
