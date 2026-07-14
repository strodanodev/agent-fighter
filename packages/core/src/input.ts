/**
 * InputFrame: one player's inputs for one tick, packed into a bitfield.
 * Every input source — local keyboard, remote peer, AI policy, replay file —
 * produces exactly this. The sim cannot tell them apart.
 */
export const enum Btn {
  Left = 1 << 0,
  Right = 1 << 1,
  Up = 1 << 2,
  Down = 1 << 3,
  Attack = 1 << 4, // M0: single attack button; expands to 6 buttons later
}

export type InputFrame = number;

export interface InputSource {
  /** Return this player's InputFrame for the given tick. Must be pure w.r.t. sim state. */
  poll(tick: number): InputFrame;
}

export const held = (f: InputFrame, b: Btn): boolean => (f & b) !== 0;

/** Rising edge: pressed this frame, not held last frame. */
export const pressed = (now: InputFrame, prev: InputFrame, b: Btn): boolean =>
  (now & b) !== 0 && (prev & b) === 0;
