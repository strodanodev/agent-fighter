/**
 * Auto Special Attack — tap the logo badge, get a special.
 *
 * THE RULE THAT SHAPES ALL OF THIS: matches are re-simulated by the match
 * server from the input log to verify the result, and a client whose inputs
 * don't reproduce its claimed outcome forfeits (ADR 0003 — see the server's
 * "deviator forfeits the pot" test). So this feature may NOT poke the sim,
 * start a move, or touch meter. It synthesises exactly the buttons a human
 * would press — down, down-forward, forward, punch — and feeds them through
 * the normal InputFrame path. The server then sees an ordinary input stream
 * and agrees with us.
 *
 * That constraint is a gift: this is a pure client feature. @af/core is
 * untouched, and it works under rollback/online for free.
 *
 * The scripts mirror `ai.ts` (qFireball/qDp), which already drives motions
 * this way for CPU opponents — same mechanism, same parser, proven.
 *
 * Randomness here is safe precisely because picking a move is an INPUT
 * decision, not sim state: the sim never sees our RNG, only the buttons.
 */
import { Action, Btn, STAGE, TUNING, fp, fpToPx } from '@af/core';
import type { FighterState, GameState, InputFrame, LoadedCharacter } from '@af/core';

/** One tick-span of a queued micro-script. Directions are facing-relative. */
interface Step { fwd?: 1; back?: 1; up?: 1; down?: 1; buttons?: number; ticks: number }

let queue: Step[] = [];
let ticksLeft = 0;

/** Is a macro mid-execution (its inputs own the pad this frame)? */
export const autoSpecialActive = (): boolean => queue.length > 0;

/** Drop any running macro (round reset, leaving the match, got hit). */
export const cancelAutoSpecial = (): void => { queue = []; ticksLeft = 0; };

/** Enough meter for the super → the badge glows red. One bar of three. */
export const autoSpecialCharged = (f: FighterState): boolean => f.meter >= TUNING.meterBar;

const isGrounded = (f: FighterState): boolean => f.y >= fp(STAGE.floorYPx);
const isActionable = (f: FighterState): boolean =>
  f.action === Action.Idle || f.action === Action.WalkF
  || f.action === Action.WalkB || f.action === Action.Crouch;
const gapPx = (a: FighterState, b: FighterState): number => Math.abs(fpToPx(a.x - b.x));

// ---- motion scripts (facing-relative; mirror ai.ts) ---------------------
// Each is a few ticks of directions then the button, sized so the pattern
// lands inside TUNING.motionWindowTicks (14) when the press is buffered.
const s236 = (buttons: number): Step[] => [
  { down: 1, ticks: 3 },
  { down: 1, fwd: 1, ticks: 2 },
  { fwd: 1, ticks: 2 },
  { fwd: 1, buttons, ticks: 2 },
  { ticks: 1 },
];
const s623 = (buttons: number): Step[] => [
  { fwd: 1, ticks: 2 },
  { down: 1, ticks: 2 },
  { down: 1, fwd: 1, buttons, ticks: 3 },
  { ticks: 1 },
];
const s214 = (buttons: number): Step[] => [
  { down: 1, ticks: 3 },
  { down: 1, back: 1, ticks: 2 },
  { back: 1, ticks: 2 },
  { back: 1, buttons, ticks: 2 },
  { ticks: 1 },
];

const scriptFor = (motion: number, buttons: number): Step[] =>
  (motion === 623 ? s623 : motion === 214 ? s214 : s236)(buttons);

interface Option { motion: number; buttons: number; weight: number; label: string }

/**
 * Score the character's real special list against the current situation, so a
 * tap throws something sensible instead of a full-screen dragon punch that
 * hands the opponent a free punish. Still random among the plausible picks —
 * one tap should feel lucky, not like an aimbot.
 */
const optionsFor = (g: GameState, side: 0 | 1, ch: LoadedCharacter): Option[] => {
  const me = g.fighters[side];
  const op = g.fighters[side === 0 ? 1 : 0];
  const d = gapPx(me, op);
  const oppAir = !isGrounded(op);
  const out: Option[] = [];

  for (const sp of ch.specials) {
    const move = ch.b.moves[sp.idx]!;
    if (move.stance === 'air') continue; // ground-only tap
    const buttons = sp.kind === 'P' ? Btn.LP : Btn.LK;
    let weight = 1;
    if (sp.motion === 623) weight = oppAir && d < 240 ? 10 : d < 90 ? 3 : 1; // anti-air / reversal
    else if (sp.motion === 236) weight = d > 260 ? 8 : d > 140 ? 4 : 2;      // zoning
    else if (sp.motion === 214) weight = d < 200 ? 5 : 1;                    // close range
    out.push({ motion: sp.motion, buttons, weight, label: move.id });
  }

  // The super joins the pool only when it's actually affordable — the same
  // condition that turns the badge red, so the glow never lies.
  if (ch.superIdx >= 0) {
    const sup = ch.b.moves[ch.superIdx]!;
    const cost = sup.meterCost ?? 0;
    if (me.meter >= cost && sup.motion) {
      // Two punches is what the sim requires for a super (countBits >= 2).
      out.push({
        motion: sup.motion,
        buttons: Btn.LP | Btn.MP,
        weight: !oppAir && d < 320 ? 9 : 3,
        label: sup.id,
      });
    }
  }
  return out;
};

/** Can a tap start right now? Ground-only, and only from a neutral state. */
export const canAutoSpecial = (g: GameState, side: 0 | 1, ch: LoadedCharacter): boolean => {
  if (queue.length > 0) return false; // already running — ignore mashing
  const me = g.fighters[side];
  return isGrounded(me) && isActionable(me) && optionsFor(g, side, ch).length > 0;
};

/**
 * Begin a macro. `rand01` is injected (Math.random by default) purely so tests
 * can pin the pick — it never reaches the sim.
 * Returns the chosen move id, or null if the tap was refused.
 */
export const startAutoSpecial = (
  g: GameState, side: 0 | 1, ch: LoadedCharacter, rand01: () => number = Math.random,
): string | null => {
  if (!canAutoSpecial(g, side, ch)) return null;
  const opts = optionsFor(g, side, ch);
  const total = opts.reduce((t, o) => t + o.weight, 0);
  let roll = rand01() * total;
  let pick = opts[opts.length - 1]!;
  for (const o of opts) { roll -= o.weight; if (roll <= 0) { pick = o; break; } }
  queue = scriptFor(pick.motion, pick.buttons);
  ticksLeft = queue[0]!.ticks;
  return pick.label;
};

/**
 * Produce this tick's input and advance the script. Call INSTEAD of the human
 * pad poll while active — the two must never merge, or the player's own stick
 * corrupts the motion mid-macro.
 */
export const pollAutoSpecial = (me: FighterState): InputFrame => {
  // Interrupted (hit, knocked down): abandon the motion rather than finishing
  // it late into something the player never asked for.
  if (me.hitstunLeft > 0 || me.action === Action.Hitstun
    || me.action === Action.AirHitstun || me.action === Action.Knockdown) {
    cancelAutoSpecial();
    return 0;
  }
  const step = queue[0];
  if (!step) return 0;
  let f: InputFrame = 0;
  const fwdBit = me.facing === 1 ? Btn.Right : Btn.Left;
  const backBit = me.facing === 1 ? Btn.Left : Btn.Right;
  if (step.fwd) f |= fwdBit;
  if (step.back) f |= backBit;
  if (step.up) f |= Btn.Up;
  if (step.down) f |= Btn.Down;
  if (step.buttons) f |= step.buttons;
  if (--ticksLeft <= 0) {
    queue.shift();
    ticksLeft = queue[0]?.ticks ?? 0;
  }
  return f;
};
