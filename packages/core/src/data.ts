import { fp } from './fp.js';

/**
 * M0 "character data". This is a deliberately tiny preview of the declarative
 * character bundle format from the build spec (§3): moves are data the engine
 * interprets, never per-character code. Real characters will load this from
 * moves.json; M0 hardcodes one rectangle fighter archetype.
 */

export interface Rect {
  /** Offsets relative to fighter origin (feet center), +x = facing dir. Pixels. */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface HitboxDef {
  rect: Rect;
  damage: number;
  hitstun: number; // frames
  hitstopFrames: number;
  pushbackHit: number; // fixed-point vel applied to victim
  knockdown: boolean;
}

export interface MoveStep {
  frames: number;
  phase: 'startup' | 'active' | 'recovery';
  hurtbox: Rect;
  hitbox?: HitboxDef;
}

export interface MoveDef {
  id: string;
  steps: MoveStep[];
}

export interface CharacterDef {
  name: string;
  maxHealth: number;
  walkSpeed: number; // fixed-point px/tick
  jumpVelY: number; // fixed-point, negative = up
  gravity: number; // fixed-point per tick
  bodyWidth: number; // pixels, for push collision
  standHurtbox: Rect;
  attack: MoveDef;
}

export const STAGE = {
  widthPx: 960,
  floorYPx: 460,
  wallPad: 24,
} as const;

export const TICKS_PER_SEC = 60;
export const ROUND_SECONDS = 99;

/** M0 archetype: the rectangle fighter. */
export const RECT_FIGHTER: CharacterDef = {
  name: 'Rect Fighter',
  maxHealth: 1000,
  walkSpeed: fp(3),
  jumpVelY: fp(-13),
  gravity: fp(0.75),
  bodyWidth: 56,
  standHurtbox: { x: -28, y: -110, w: 56, h: 110 },
  attack: {
    id: '5P',
    steps: [
      { frames: 4, phase: 'startup', hurtbox: { x: -28, y: -110, w: 56, h: 110 } },
      {
        frames: 3,
        phase: 'active',
        hurtbox: { x: -28, y: -110, w: 60, h: 110 },
        hitbox: {
          rect: { x: 20, y: -95, w: 55, h: 30 },
          damage: 90,
          hitstun: 14,
          hitstopFrames: 6,
          pushbackHit: fp(5),
          knockdown: false,
        },
      },
      { frames: 9, phase: 'recovery', hurtbox: { x: -28, y: -110, w: 56, h: 110 } },
    ],
  },
};
