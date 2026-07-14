import { fp } from './fp.js';
import type { LoadedCharacter } from './data.js';
import { Action } from './state.js';
import type { FighterState } from './state.js';

/**
 * Animation resolution: map ANY fighter state to a sprite frame name from the
 * character bundle. Attack states use their own move's steps; every other
 * action maps to a system move (`type: "system"`, ids below — spec §4:
 * "round intro/KO/win poses are just Moves in the data format").
 *
 * Purely cosmetic: the sim never calls this; hurtboxes stay driven by the
 * engine's stand/crouch/air boxes. Deterministic pure function so client,
 * studio, and future replay viewers all resolve identical frames.
 */

/** Canonical system animation ids. Characters may omit any (renderer falls back). */
export const SYS = {
  idle: 'sys.idle',
  walkF: 'sys.walkF',
  walkB: 'sys.walkB',
  crouch: 'sys.crouch',
  jump: 'sys.jump', // 3 steps: rising / apex / falling (picked by velY)
  dashF: 'sys.dashF',
  dashB: 'sys.dashB',
  block: 'sys.block',
  blockCrouch: 'sys.blockCrouch',
  blockAir: 'sys.blockAir',
  hitstun: 'sys.hitstun',
  airHitstun: 'sys.airHitstun',
  knockdown: 'sys.knockdown',
  getup: 'sys.getup',
  ko: 'sys.ko',
} as const;

const stepSpriteAt = (ch: LoadedCharacter, moveIdx: number, frame: number): string | null => {
  const move = ch.b.moves[moveIdx];
  if (!move) return null;
  let acc = 0;
  for (const s of move.steps) {
    acc += s.frames;
    if (frame < acc) return s.sprite ?? null;
  }
  return move.steps[move.steps.length - 1]?.sprite ?? null;
};

/** Looping animation: counter wraps over the move's total frames. */
const loopSprite = (ch: LoadedCharacter, id: string, counter: number): string | null => {
  const idx = ch.moveIdxById[id];
  if (idx === undefined) return null;
  const total = ch.totalFrames[idx]!;
  return stepSpriteAt(ch, idx, total > 0 ? counter % total : 0);
};

/** One-shot animation: clamps to the last step. */
const onceSprite = (ch: LoadedCharacter, id: string, counter: number): string | null => {
  const idx = ch.moveIdxById[id];
  if (idx === undefined) return null;
  return stepSpriteAt(ch, idx, Math.min(counter, ch.totalFrames[idx]! - 1));
};

/** Fixed step of a multi-step system move (e.g. jump rise/apex/fall). */
const stepOf = (ch: LoadedCharacter, id: string, step: number): string | null => {
  const idx = ch.moveIdxById[id];
  if (idx === undefined) return null;
  const move = ch.b.moves[idx]!;
  const s = move.steps[Math.min(step, move.steps.length - 1)];
  return s?.sprite ?? null;
};

const VEL_EPS = fp(2);

/**
 * Resolve the sprite for a fighter's current state, or null (render fallback).
 * `tick` drives loops for states whose actionFrame does not advance.
 */
export const spriteForFighter = (
  f: FighterState, ch: LoadedCharacter, tick: number,
): string | null => {
  const airFrame = (): string | null =>
    f.velY < -VEL_EPS ? stepOf(ch, SYS.jump, 0)
    : f.velY <= VEL_EPS ? stepOf(ch, SYS.jump, 1)
    : stepOf(ch, SYS.jump, 2);

  switch (f.action) {
    case Action.Attack:
      return f.moveIdx >= 0 ? stepSpriteAt(ch, f.moveIdx, f.actionFrame) : null;
    case Action.Idle:
      return loopSprite(ch, SYS.idle, f.actionFrame);
    case Action.WalkF:
      return loopSprite(ch, SYS.walkF, f.actionFrame);
    case Action.WalkB:
      return loopSprite(ch, SYS.walkB, f.actionFrame);
    case Action.Crouch:
      return loopSprite(ch, SYS.crouch, f.actionFrame);
    case Action.JumpSquat:
      return stepOf(ch, SYS.crouch, 0);
    case Action.Air:
      return airFrame();
    case Action.AirDash:
      return stepOf(ch, SYS.dashF, 0) ?? airFrame();
    case Action.DashF:
      return stepOf(ch, SYS.dashF, 0);
    case Action.DashB:
      return stepOf(ch, SYS.dashB, 0);
    case Action.BlockStand:
      return stepOf(ch, SYS.block, 0);
    case Action.BlockCrouch:
      return stepOf(ch, SYS.blockCrouch, 0);
    case Action.BlockAir:
      return stepOf(ch, SYS.blockAir, 0);
    case Action.Hitstun:
    case Action.Thrown:
      return stepOf(ch, SYS.hitstun, 0);
    case Action.AirHitstun:
      return stepOf(ch, SYS.airHitstun, 0);
    case Action.Knockdown:
      return stepOf(ch, SYS.knockdown, 0);
    case Action.Getup:
      return onceSprite(ch, SYS.getup, f.actionFrame);
    case Action.Grab:
      return stepOf(ch, SYS.idle, 0);
    case Action.KO:
      return f.velY !== 0 ? stepOf(ch, SYS.airHitstun, 0)
        : stepOf(ch, SYS.ko, 0) ?? stepOf(ch, SYS.knockdown, 0);
    default:
      return loopSprite(ch, SYS.idle, tick);
  }
};
