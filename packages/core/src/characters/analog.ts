import type { CancelEdge, CharacterBundle, GuardKind, HitboxDef, MoveDef, MoveStance, Rect } from '../data.js';

/**
 * ANALOG — launch character #1, shoto archetype. 100% declarative data
 * (build-spec §3): the engine interprets this table; there is no Analog code.
 * This module is the in-repo stand-in for a character bundle's moves.json +
 * cancels.json until the M2 Studio exports real files.
 *
 * Frame data tuned for MvC pacing: lights 3-4f startup and chainable,
 * launcher (2HP) → super jump → air chain → j.HP/j.HK finisher.
 */

const STAND: Rect = { x: -26, y: -108, w: 52, h: 108 };
const CROUCH: Rect = { x: -26, y: -80, w: 52, h: 80 };
const AIR: Rect = { x: -26, y: -98, w: 52, h: 88 };

interface StrikeSpec {
  startup: number;
  active: number;
  recovery: number;
  rect: Rect;
  damage: number;
  hitstun: number;
  blockstun: number;
  hitstop: number;
  pushHit: number;
  pushBlock: number;
  guard?: GuardKind;
  chip?: number;
  juggleCost?: number;
  launcher?: boolean;
  launchVelY?: number;
  knockdown?: boolean;
  meterWhiff?: number;
  meterHit?: number;
  extendHurt?: number; // extra hurtbox reach during active frames (limb is vulnerable)
}

/** Standard single-hit strike: startup / active / recovery with one hitbox. */
const mkStrike = (id: string, stance: MoveStance, button: MoveDef['button'], sp: StrikeSpec): MoveDef => {
  const base = stance === 'crouch' ? CROUCH : stance === 'air' ? AIR : STAND;
  const activeHurt: Rect[] = sp.extendHurt
    ? [base, { x: sp.rect.x, y: sp.rect.y, w: sp.rect.w, h: sp.rect.h }]
    : [base];
  const hit: HitboxDef = {
    rect: sp.rect,
    damage: sp.damage,
    chip: sp.chip ?? 0,
    hitstun: sp.hitstun,
    blockstun: sp.blockstun,
    hitstopFrames: sp.hitstop,
    pushbackHit: sp.pushHit,
    pushbackBlock: sp.pushBlock,
    guard: sp.guard ?? 'mid',
    juggleCost: sp.juggleCost ?? 1,
    launcher: sp.launcher,
    launchVelY: sp.launchVelY,
    knockdown: sp.knockdown,
  };
  return {
    id, type: 'normal', stance, button,
    steps: [
      { frames: sp.startup, phase: 'startup', hurtboxes: [base] },
      { frames: sp.active, phase: 'active', hurtboxes: activeHurt, hitboxes: [hit] },
      { frames: sp.recovery, phase: 'recovery', hurtboxes: [base] },
    ],
    meterGainWhiff: sp.meterWhiff ?? 5,
    meterGainHit: sp.meterHit ?? 40,
  };
};

const MOVES: MoveDef[] = [
  // -------------------------------------------------- standing normals
  mkStrike('5LP', 'stand', 'LP', {
    startup: 3, active: 3, recovery: 6,
    rect: { x: 22, y: -96, w: 44, h: 22 },
    damage: 300, hitstun: 14, blockstun: 10, hitstop: 5, pushHit: 4.5, pushBlock: 5,
    meterWhiff: 5, meterHit: 40, extendHurt: 1,
  }),
  mkStrike('5MP', 'stand', 'MP', {
    startup: 6, active: 4, recovery: 10,
    rect: { x: 24, y: -100, w: 52, h: 28 },
    damage: 550, hitstun: 17, blockstun: 13, hitstop: 6, pushHit: 5.5, pushBlock: 6.5,
    meterWhiff: 8, meterHit: 70, extendHurt: 1,
  }),
  mkStrike('5HP', 'stand', 'HP', {
    startup: 9, active: 4, recovery: 16,
    rect: { x: 26, y: -104, w: 60, h: 34 },
    damage: 800, hitstun: 21, blockstun: 16, hitstop: 8, pushHit: 6.5, pushBlock: 8,
    meterWhiff: 12, meterHit: 100, extendHurt: 1,
  }),
  mkStrike('5LK', 'stand', 'LK', {
    startup: 4, active: 3, recovery: 8,
    rect: { x: 20, y: -60, w: 46, h: 24 },
    damage: 320, hitstun: 14, blockstun: 10, hitstop: 5, pushHit: 4.5, pushBlock: 5,
    meterWhiff: 5, meterHit: 40, extendHurt: 1,
  }),
  mkStrike('5MK', 'stand', 'MK', {
    startup: 7, active: 4, recovery: 12,
    rect: { x: 24, y: -74, w: 54, h: 26 },
    damage: 570, hitstun: 17, blockstun: 13, hitstop: 6, pushHit: 5.5, pushBlock: 6.5,
    meterWhiff: 8, meterHit: 70, extendHurt: 1,
  }),
  mkStrike('5HK', 'stand', 'HK', {
    startup: 10, active: 5, recovery: 18,
    rect: { x: 26, y: -92, w: 62, h: 40 },
    damage: 830, hitstun: 22, blockstun: 17, hitstop: 8, pushHit: 7, pushBlock: 8.5,
    meterWhiff: 12, meterHit: 100, extendHurt: 1,
  }),

  // -------------------------------------------------- crouching normals
  mkStrike('2LP', 'crouch', 'LP', {
    startup: 3, active: 3, recovery: 6,
    rect: { x: 20, y: -66, w: 42, h: 20 },
    damage: 280, hitstun: 14, blockstun: 10, hitstop: 5, pushHit: 4.5, pushBlock: 5,
    meterWhiff: 5, meterHit: 40, extendHurt: 1,
  }),
  mkStrike('2MP', 'crouch', 'MP', {
    startup: 6, active: 4, recovery: 11,
    rect: { x: 20, y: -84, w: 48, h: 30 },
    damage: 520, hitstun: 17, blockstun: 13, hitstop: 6, pushHit: 5.5, pushBlock: 6.5,
    meterWhiff: 8, meterHit: 70, extendHurt: 1,
  }),
  // THE launcher. Pops up for super-jump air combos (magic series apex).
  mkStrike('2HP', 'crouch', 'HP', {
    startup: 10, active: 4, recovery: 20,
    rect: { x: 14, y: -120, w: 44, h: 70 },
    damage: 750, hitstun: 90, blockstun: 16, hitstop: 9, pushHit: 2, pushBlock: 8,
    launcher: true, launchVelY: -17, knockdown: true, juggleCost: 1,
    meterWhiff: 12, meterHit: 100, extendHurt: 1,
  }),
  mkStrike('2LK', 'crouch', 'LK', {
    startup: 4, active: 3, recovery: 7,
    rect: { x: 18, y: -26, w: 44, h: 22 },
    damage: 260, hitstun: 13, blockstun: 10, hitstop: 5, pushHit: 4, pushBlock: 4.5,
    guard: 'low', meterWhiff: 5, meterHit: 40, extendHurt: 1,
  }),
  mkStrike('2MK', 'crouch', 'MK', {
    startup: 7, active: 4, recovery: 13,
    rect: { x: 22, y: -28, w: 56, h: 24 },
    damage: 500, hitstun: 16, blockstun: 13, hitstop: 6, pushHit: 5.5, pushBlock: 6.5,
    guard: 'low', meterWhiff: 8, meterHit: 70, extendHurt: 1,
  }),
  // Sweep: low + knockdown.
  mkStrike('2HK', 'crouch', 'HK', {
    startup: 11, active: 5, recovery: 22,
    rect: { x: 20, y: -24, w: 66, h: 22 },
    damage: 780, hitstun: 30, blockstun: 17, hitstop: 8, pushHit: 5, pushBlock: 8,
    guard: 'low', knockdown: true, meterWhiff: 12, meterHit: 100, extendHurt: 1,
  }),

  // -------------------------------------------------- air normals (overheads)
  mkStrike('j.LP', 'air', 'LP', {
    startup: 3, active: 8, recovery: 4,
    rect: { x: 16, y: -86, w: 42, h: 26 },
    damage: 300, hitstun: 15, blockstun: 11, hitstop: 5, pushHit: 4, pushBlock: 4.5,
    guard: 'overhead', meterWhiff: 5, meterHit: 40,
  }),
  mkStrike('j.MP', 'air', 'MP', {
    startup: 5, active: 6, recovery: 6,
    rect: { x: 18, y: -92, w: 50, h: 30 },
    damage: 540, hitstun: 18, blockstun: 13, hitstop: 6, pushHit: 5, pushBlock: 5.5,
    guard: 'overhead', meterWhiff: 8, meterHit: 70,
  }),
  // Air finisher: knocks down out of air combos.
  mkStrike('j.HP', 'air', 'HP', {
    startup: 7, active: 6, recovery: 8,
    rect: { x: 18, y: -96, w: 56, h: 38 },
    damage: 820, hitstun: 24, blockstun: 16, hitstop: 8, pushHit: 6.5, pushBlock: 7,
    guard: 'overhead', knockdown: true, juggleCost: 2, meterWhiff: 12, meterHit: 100,
  }),
  mkStrike('j.LK', 'air', 'LK', {
    startup: 4, active: 8, recovery: 4,
    rect: { x: 14, y: -60, w: 44, h: 26 },
    damage: 310, hitstun: 15, blockstun: 11, hitstop: 5, pushHit: 4, pushBlock: 4.5,
    guard: 'overhead', meterWhiff: 5, meterHit: 40,
  }),
  mkStrike('j.MK', 'air', 'MK', {
    startup: 6, active: 7, recovery: 6,
    rect: { x: 16, y: -66, w: 52, h: 30 },
    damage: 560, hitstun: 18, blockstun: 13, hitstop: 6, pushHit: 5, pushBlock: 5.5,
    guard: 'overhead', meterWhiff: 8, meterHit: 70,
  }),
  mkStrike('j.HK', 'air', 'HK', {
    startup: 8, active: 6, recovery: 8,
    rect: { x: 20, y: -80, w: 60, h: 42 },
    damage: 850, hitstun: 24, blockstun: 16, hitstop: 8, pushHit: 6.5, pushBlock: 7,
    guard: 'overhead', knockdown: true, juggleCost: 2, meterWhiff: 12, meterHit: 100,
  }),

  // -------------------------------------------------- specials
  // 236P — Analog Wave (fireball). Projectile spawns at first active frame.
  {
    id: '236P', type: 'special', stance: 'stand', motion: 236, buttons: 'P',
    steps: [
      { frames: 12, phase: 'startup', hurtboxes: [STAND] },
      { frames: 2, phase: 'active', hurtboxes: [STAND] },
      { frames: 18, phase: 'recovery', hurtboxes: [STAND] },
    ],
    projectile: {
      spawnX: 50, spawnY: -78, velX: 8, lifetime: 90,
      rect: { x: -18, y: -14, w: 36, h: 28 },
      hit: {
        rect: { x: -18, y: -14, w: 36, h: 28 },
        damage: 700, chip: 90, hitstun: 20, blockstun: 15, hitstopFrames: 6,
        pushbackHit: 6, pushbackBlock: 7, guard: 'mid', juggleCost: 2,
        airPopVelY: -6,
      },
    },
    meterGainWhiff: 20, meterGainHit: 120,
  },
  // 623P — Rising Glitch (dragon punch). Self-launches, knocks down.
  {
    id: '623P', type: 'special', stance: 'stand', motion: 623, buttons: 'P',
    steps: [
      { frames: 4, phase: 'startup', hurtboxes: [STAND] },
      {
        frames: 10, phase: 'active', velX: 3.5, velY: -13,
        hurtboxes: [STAND],
        hitboxes: [{
          rect: { x: 6, y: -128, w: 46, h: 92 },
          damage: 900, chip: 110, hitstun: 40, blockstun: 18, hitstopFrames: 9,
          pushbackHit: 3, pushbackBlock: 8, guard: 'mid', juggleCost: 3,
          launcher: true, launchVelY: -14, knockdown: true,
        }],
      },
      { frames: 14, phase: 'recovery', hurtboxes: [STAND] },
    ],
    meterGainWhiff: 20, meterGainHit: 140,
  },
  // 214K — Scanline Sweep (advancing two-hit kick).
  {
    id: '214K', type: 'special', stance: 'stand', motion: 214, buttons: 'K',
    steps: [
      { frames: 8, phase: 'startup', hurtboxes: [STAND] },
      {
        frames: 8, phase: 'active', velX: 6,
        hurtboxes: [STAND],
        hitboxes: [{
          rect: { x: 16, y: -84, w: 52, h: 40 },
          damage: 400, chip: 50, hitstun: 18, blockstun: 13, hitstopFrames: 6,
          pushbackHit: 3, pushbackBlock: 5, guard: 'mid', juggleCost: 2, airPopVelY: -7,
        }],
      },
      {
        frames: 8, phase: 'active', velX: 6,
        hurtboxes: [STAND],
        hitboxes: [{
          rect: { x: 16, y: -84, w: 52, h: 40 },
          damage: 420, chip: 50, hitstun: 24, blockstun: 14, hitstopFrames: 7,
          pushbackHit: 6, pushbackBlock: 7, guard: 'mid', juggleCost: 2,
          knockdown: true, airPopVelY: -6,
        }],
      },
      { frames: 16, phase: 'recovery', velX: 0, hurtboxes: [STAND] },
    ],
    meterGainWhiff: 20, meterGainHit: 130,
  },

  // -------------------------------------------------- super
  // 236PP — SYSTEM CRASH. 5-hit rushing super, 1 bar, super-flash freeze.
  {
    id: '236PP', type: 'super', stance: 'stand', motion: 236, buttons: 'PP', meterCost: 1000,
    steps: [
      { frames: 6, phase: 'startup', hurtboxes: [STAND] },
      ...Array.from({ length: 4 }, (_, k) => ({
        frames: 4,
        phase: 'active' as const,
        velX: 7,
        hurtboxes: [STAND],
        hitboxes: [{
          rect: { x: 14, y: -104, w: 62, h: 74 },
          damage: 500, chip: 70, hitstun: 22, blockstun: 14, hitstopFrames: 5,
          pushbackHit: 1.5, pushbackBlock: 4, guard: 'mid' as const, juggleCost: 0,
          airPopVelY: -6,
        }],
      })),
      {
        frames: 5, phase: 'active', velX: 4,
        hurtboxes: [STAND],
        hitboxes: [{
          rect: { x: 14, y: -110, w: 70, h: 84 },
          damage: 1000, chip: 120, hitstun: 30, blockstun: 18, hitstopFrames: 10,
          pushbackHit: 9, pushbackBlock: 10, guard: 'mid', juggleCost: 0,
          launcher: true, launchVelY: -12, knockdown: true,
        }],
      },
      { frames: 24, phase: 'recovery', velX: 0, hurtboxes: [STAND] },
    ],
    meterGainWhiff: 0, meterGainHit: 0,
  },
];

// ---------------------------------------------------------------------------
// Cancel graph — MvC magic series (any L → any M → any H → launcher) plus
// special cancels on hit/block and super cancels from anything.
// ---------------------------------------------------------------------------

const L = ['5LP', '5LK', '2LP', '2LK'];
const M = ['5MP', '5MK', '2MP', '2MK'];
const H = ['5HP', '5HK', '2HK'];
const LAUNCHER = ['2HP'];
const SPECIALS = ['236P', '623P', '214K'];
const SUPER = ['236PP'];
const AIR_L = ['j.LP', 'j.LK'];
const AIR_M = ['j.MP', 'j.MK'];
const AIR_H = ['j.HP', 'j.HK'];

const edges = (from: string[], to: string[], on: CancelEdge['on']): CancelEdge[] =>
  from.map((f) => ({ from: f, to, on }));

const CANCELS: CancelEdge[] = [
  // Ground magic series: L → (other Ls) → M → H → launcher, on hit or block.
  ...edges(L, [...L, ...M, ...H, ...LAUNCHER], ['hit', 'block']),
  ...edges(M, [...H, ...LAUNCHER], ['hit', 'block']),
  ...edges(H, LAUNCHER, ['hit', 'block']),
  // Any ground normal cancels into specials and super.
  ...edges([...L, ...M, ...H, ...LAUNCHER], [...SPECIALS, ...SUPER], ['hit', 'block']),
  // Specials cancel into super.
  ...edges(SPECIALS, SUPER, ['hit', 'block']),
  // Air series: L → M → H (finisher ends the combo).
  ...edges(AIR_L, [...AIR_M, ...AIR_H], ['hit', 'block']),
  ...edges(AIR_M, AIR_H, ['hit', 'block']),
];

export const ANALOG: CharacterBundle = {
  name: 'Analog',
  maxHealth: 10000,
  walkFSpeed: 4.2,
  walkBSpeed: 3.2,
  dashFSpeed: 9,
  dashFTicks: 14,
  dashBSpeed: 7.5,
  dashBTicks: 12,
  jumpVelY: -14,
  superJumpVelY: -19.5,
  jumpVelX: 5,
  gravity: 0.8,
  doubleJump: true,
  airDash: true,
  airDashSpeed: 8.5,
  airDashTicks: 12,
  bodyWidth: 52,
  standHurtbox: STAND,
  crouchHurtbox: CROUCH,
  airHurtbox: AIR,
  throwRange: 72,
  throwDamage: 1000,
  throwTossVelX: 9,
  throwTossVelY: -8,
  moves: MOVES,
  cancels: CANCELS,
};
