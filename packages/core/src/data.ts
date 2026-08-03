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

/**
 * Per-character overrides for the handful of genuinely PER-FIGHTER feel knobs
 * (the rest of TUNING is match-global — round flow, scaling, meter cap). These
 * ship IN the bundle, so they are pinned + content-hashed like the moveset:
 * both clients and the server re-sim load identical values → deterministic, no
 * desync. Absent (or a missing key) → the global TUNING default.
 *
 * This is how archetypes get distinct FEEL on the shared engine — a nimble
 * rushdown jumps and wakes up faster; a heavy grappler has a quick command
 * grab. (Most other feel already lives in per-move hitboxes and the per-
 * character bundle fields above, so this set is deliberately small.)
 */
export interface CharTuning {
  jumpSquatTicks?: number; // prejump frames — low = nimble, high = committal
  knockdownTicks?: number; // time spent knocked down before getup
  getupTicks?: number;     // wakeup duration
  grabTicks?: number;      // throw / command-grab startup — low = fast grappler
}
/** The knobs a bundle may override (the CharTuning keys), for validation. */
export const CHAR_TUNING_KEYS: (keyof CharTuning)[] = [
  'jumpSquatTicks', 'knockdownTicks', 'getupTicks', 'grabTicks',
];

export interface CharacterBundle {
  name: string;
  /**
   * sha256 content hash (first 16 hex chars), written by the Studio on save
   * and pinned in every online match handshake (spec §3.1, ADR 0003). The
   * sim never reads it.
   */
  versionHash?: string;
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
  /** Optional per-fighter feel overrides (archetype flavor). See CharTuning. */
  tuning?: CharTuning;
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

  // Value bounds (audit 2026-07-18 validation holes + 2026-07-20 CT-3-adjacent
  // soft-lock). The structure is validated above; these reject NUMERIC data
  // that would silently SOFT-LOCK a match (deterministic on both peers, so it
  // never desyncs — it just freezes) or hand a cheating bundle free resources:
  //  · gravity <= 0 → an airborne fighter never falls;
  //  · throwTossVelY / launchVelY >= 0 → the victim never leaves the ground, so
  //    AirHitstun (which exits only on landing) runs until the round timer;
  //  · negative chip heals, negative juggleCost = infinite combo, negative
  //    meterCost mints meter (health has no upper clamp).
  // Bounds are loose enough that all 12 shipped bundles pass unchanged
  // (verified: gravity 0.8, toss -8, launchVelY -17..-12, chip/juggle/meter >=0).
  const num = (v: number, what: string): number => {
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${b.name}: ${what} must be a finite number (got ${v})`);
    return v;
  };
  if (num(b.maxHealth, 'maxHealth') <= 0) throw new Error(`${b.name}: maxHealth must be > 0 (got ${b.maxHealth})`);
  if (num(b.gravity, 'gravity') <= 0) throw new Error(`${b.name}: gravity must be > 0 or fighters never fall (got ${b.gravity})`);
  if (num(b.throwTossVelY, 'throwTossVelY') >= 0) throw new Error(`${b.name}: throwTossVelY must be < 0 (upward); a non-upward toss strands the victim in AirHitstun (got ${b.throwTossVelY})`);
  const checkHit = (h: HitboxDef, where: string): void => {
    num(h.damage, `${where} damage`);
    if (num(h.chip, `${where} chip`) < 0) throw new Error(`${b.name}: ${where} chip must be >= 0; negative chip heals (got ${h.chip})`);
    if (num(h.juggleCost, `${where} juggleCost`) < 0) throw new Error(`${b.name}: ${where} juggleCost must be >= 0; negative enables infinite combos (got ${h.juggleCost})`);
    if (h.launchVelY !== undefined && num(h.launchVelY, `${where} launchVelY`) >= 0) throw new Error(`${b.name}: ${where} launchVelY must be < 0 (upward); a non-upward launch strands the victim in AirHitstun (got ${h.launchVelY})`);
    if (h.airPopVelY !== undefined) num(h.airPopVelY, `${where} airPopVelY`);
  };
  b.moves.forEach((m) => {
    if (m.meterCost !== undefined && num(m.meterCost, `${m.id} meterCost`) < 0) throw new Error(`${b.name}: ${m.id} meterCost must be >= 0; negative mints meter (got ${m.meterCost})`);
    for (const st of m.steps) for (const h of st.hitboxes ?? []) checkHit(h, m.id);
    if (m.projectile) checkHit(m.projectile.hit, `${m.id} projectile`);
  });

  // Per-character tuning overrides: allowlisted keys only, positive integer
  // durations (a 0/negative/NaN duration would soft-lock the state it gates).
  if (b.tuning) {
    for (const k of Object.keys(b.tuning)) {
      if (!(CHAR_TUNING_KEYS as string[]).includes(k)) {
        throw new Error(`${b.name}: unknown tuning override "${k}" (allowed: ${CHAR_TUNING_KEYS.join(', ')})`);
      }
      const v = (b.tuning as Record<string, number>)[k]!;
      if (!Number.isInteger(v) || v < 1) throw new Error(`${b.name}: tuning.${k} must be an integer >= 1 (got ${v})`);
    }
  }

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

/**
 * Engine compatibility version, pinned in every online match handshake
 * (ADR 0003). Bump on ANY sim-behavior change — the golden replay tests
 * going red is the reminder; bless goldens and bump this in the same commit.
 */
/**
 * Bump this on ANY change that alters simulated behaviour — including ai.ts.
 * Ranked solo (protocol v3) is a zero-latency LOCAL simulation: the client runs
 * the house AI itself from a pinned seed and streams only its own inputs, and
 * the server re-derives that same AI to verify the result. So a client running
 * a different ai.ts than the server desyncs and gets flagged as a deviator —
 * i.e. the player forfeits the match AND the credit fee through no fault of
 * their own. The version is checked at the `hello` handshake (server.ts), so
 * bumping turns that silent, costly desync into a clean "reload required".
 *
 * af-core-2: AI meter/special usage (supers no longer gated to skill ≥ 65;
 *            214K wired up) — changes house-bot inputs, hence a new version.
 * af-core-3: consumable items (ADR 0007 Phase 2) — three new FighterState
 *            fields (itemDmg/itemDef/itemBuffLeft) change the serialize
 *            layout (all state hashes shift even for item-less matches:
 *            goldens re-blessed), and pinned drinks scale strike() damage.
 * af-core-4: consumables become IN-MATCH activated (ADR 0007 Phase 3) — the
 *            Btn.Item input bit drinks the can on demand; three more
 *            FighterState fields (itemKind/itemAmount/itemDur) carry the
 *            un-drunk drink. Serialize layout shifts again (goldens
 *            re-blessed); no drink pressed = still bit-identical to pre-item.
 * af-core-5: THREE equipped drink slots per fighter (ADR 0007 final shape):
 *            Btn.Item/Item2/Item3 each drink their slot; carried state is
 *            9 scalars (kind/amount/dur ×3) and the damage/defense buffs run
 *            independent timers (itemDmgLeft/itemDefLeft) so OVERCLOCK and
 *            FIREWALL coexist; re-drinking a kind refreshes, never stacks.
 *            Serialize layout shifts (goldens re-blessed).
 * af-core-6: per-stage playfield bounds (ADR: view lock). wallL/wallR are now
 *            per-match state (2 appended global scalars) instead of module
 *            constants; the sim clamps fighters to them and the server sends the
 *            stage's bounds in the match handshake. Default (no stage bounds) is
 *            the old full-width walls, so behavior is unchanged — but the
 *            serialize layout grew by 2 int32, so goldens were re-blessed.
 * af-core-7: Grab (throw startup) is strike-invulnerable (audit 2026-07-20
 *            CT-3). Fixes the "throw the fireballer" soft-lock: the victim's
 *            lingering projectile could knock the grabber to Hitstun, stranding
 *            the victim in Thrown with no resolver until the round timer (~99s,
 *            read as a freeze). No serialize-layout change and NO golden hash
 *            moved (no golden replay lands a projectile on a grabbing fighter),
 *            but the SIM behavior changed in that scenario, so client and server
 *            must pin the same engine — hence the version bump + paired deploy.
 * af-core-8: PETS (ADR 0011). Eight new FighterState fields (the five aura
 *            lines, two regen accumulators, the crit flash) shift the
 *            serialize layout, so the goldens are re-blessed — but the
 *            BEHAVIOUR of a pet-less match is unchanged: every aura path is
 *            gated on a non-zero line, and `rngSeed` (live for the first time,
 *            as the crit roll) only advances when a fighter with a crit aura
 *            lands a clean hit. The 61 behavioural tests must not move.
 */
export const ENGINE_VERSION = 'af-core-8';

const TUNING_INIT = {
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
};

/**
 * The feel knobs. **Mutable by design** — CLAUDE.md: "tuning values will be
 * tuned constantly." The sim reads this object live, so `applyTuning` lets the
 * local Feel Lab (tools/feel-lab) retune the game in real time.
 *
 * SAFETY: only the Feel Lab ever calls `applyTuning`/`resetTuning`. The shipped
 * client and the server verifier BOTH run `TUNING_DEFAULTS` untouched, so no
 * online/verified match is ever affected. Same TUNING → same sim, so
 * determinism is unchanged; only the values would differ if someone tuned.
 */
export const TUNING: typeof TUNING_INIT = { ...TUNING_INIT };
/** The shipped defaults — frozen. `resetTuning()` restores these. */
export const TUNING_DEFAULTS: Readonly<typeof TUNING_INIT> = Object.freeze({ ...TUNING_INIT });
/** Feel Lab only: overwrite named knobs in place (the sim reads TUNING live). */
export const applyTuning = (patch: Partial<typeof TUNING_INIT>): void => {
  Object.assign(TUNING, patch);
};
/** Feel Lab only: restore every knob to its shipped default. */
export const resetTuning = (): void => {
  Object.assign(TUNING, TUNING_DEFAULTS);
};
