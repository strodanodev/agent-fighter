export const held = (f, b) => (f & b) !== 0;
/** Rising edge: pressed this frame, not held last frame. */
export const pressed = (now, prev, b) => (now & b) !== 0 && (prev & b) === 0;
