/**
 * InputFrame: one player's inputs for one tick, packed into a bitfield.
 * Every input source — local keyboard, remote peer, AI policy, replay file —
 * produces exactly this. The sim cannot tell them apart.
 *
 * M1: full 6-button MvC layout (LP/MP/HP, LK/MK/HK) + 4 directions.
 */
export const enum Btn {
  Left = 1 << 0,
  Right = 1 << 1,
  Up = 1 << 2,
  Down = 1 << 3,
  LP = 1 << 4,
  MP = 1 << 5,
  HP = 1 << 6,
  LK = 1 << 7,
  MK = 1 << 8,
  HK = 1 << 9,
  // CONSUMABLES (ADR 0007): "drink my energy can" — one bit PER EQUIPPED
  // SLOT (players carry up to 3 drinks). Free input bits (10..30 were
  // unused) so activation rides the SAME ledger + rollback + re-sim path as
  // every button — the only rollback-correct way to trigger a mid-match
  // effect. The sim acts on each bit's RISING edge and no-ops once that
  // slot is spent, so a held key drinks exactly once.
  Item = 1 << 10, // slot 0
  Item2 = 1 << 11, // slot 1
  Item3 = 1 << 12, // slot 2
}

/** All three drink-slot bits, slot-indexed. */
export const ITEM_BITS = [Btn.Item, Btn.Item2, Btn.Item3] as const;

export type InputFrame = number;

export interface InputSource {
  /** Return this player's InputFrame for the given tick. Must be pure w.r.t. sim state. */
  poll(tick: number): InputFrame;
}

export const PUNCH_MASK = Btn.LP | Btn.MP | Btn.HP;
export const KICK_MASK = Btn.LK | Btn.MK | Btn.HK;
export const ATTACK_MASK = PUNCH_MASK | KICK_MASK;
export const DIR_MASK = Btn.Left | Btn.Right | Btn.Up | Btn.Down;

export const held = (f: InputFrame, b: Btn): boolean => (f & b) !== 0;

/** Rising edge: pressed this frame, not held last frame. */
export const pressed = (now: InputFrame, prev: InputFrame, b: Btn): boolean =>
  (now & b) !== 0 && (prev & b) === 0;

/** All attack buttons newly pressed this frame, as a mask. */
export const pressedAttacks = (now: InputFrame, prev: InputFrame): number =>
  now & ~prev & ATTACK_MASK;

/** Popcount for small masks (attack buttons). Deterministic integer loop. */
export const countBits = (v: number): number => {
  let n = 0;
  while (v !== 0) {
    n += v & 1;
    v >>>= 1;
  }
  return n;
};
