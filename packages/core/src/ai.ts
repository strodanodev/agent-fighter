import { Btn } from './input.js';
import type { InputFrame } from './input.js';
import { fp, fpToPx, nextRand } from './fp.js';
import { TUNING } from './data.js';
import type { LoadedCharacter } from './data.js';
import { Action, Phase, characters } from './state.js';
import type { FighterState, GameState } from './state.js';

/**
 * Single-player AI (spec §8): an InputSource policy — it reads GameState and
 * emits InputFrames; the sim cannot tell it from a human, and no engine path
 * is special-cased for it.
 *
 * DESIGN GOAL: "feels like a real person", driven by ONE lever (skill 0-100).
 * Humans don't decide per frame — they commit to INTENTIONS for a beat, react
 * late (with jitter), flub inputs, have habits, and adapt when something keeps
 * working on them. So this AI is built from:
 *
 *   · intents held for 12-90 ticks (walk in / back off / pressure / zone…)
 *   · a reaction model: events are only visible reactionDelay+jitter ticks
 *     after they happen
 *   · an execution layer: inputs are queued micro-scripts (motions, chains)
 *     that can be flubbed — dropped links, late presses, sloppy motions
 *   · a per-match PERSONALITY sampled from the seed (aggression, jumpiness,
 *     zoning, throw habit…) so every opponent plays differently
 *   · adaptation counters (kept eating jump-ins → starts anti-airing)
 *   · a combo book DERIVED from the character's own cancel graph — no
 *     per-character AI code, ever (characters are data)
 *
 * Fully deterministic: its own nextRand stream, integer math only. That makes
 * bot-vs-bot balance tests reproducible and keeps replays exact (AI inputs are
 * recorded like any other inputs).
 */

// ---------------------------------------------------------------- intents
export const enum Intent {
  Observe = 0,
  Approach = 1,
  Retreat = 2,
  Pressure = 3,
  Zone = 4,
  JumpIn = 5,
  Punish = 6,
  Defend = 7,
  Oki = 8,
}

/** One step of a queued micro-script. Directions are facing-relative. */
interface QStep {
  fwd?: number;
  back?: number;
  up?: number;
  down?: number;
  buttons?: number;
  ticks: number;
}

export interface AiPersonality {
  aggression: number; // 0..255
  jumpiness: number;
  zoner: number;
  throwHappy: number;
  pushblocker: number;
  patience: number;
}

export interface AiState {
  side: 0 | 1;
  skill: number; // 0..100 — THE lever
  rng: number;
  p: AiPersonality;

  intent: Intent;
  intentUntil: number;

  queue: QStep[];
  qTicks: number; // ticks remaining on queue[0]

  // Reaction model: what the AI has "seen" and when.
  oppAction: number;
  oppActionAt: number;
  reacted: number; // 0/1 — already responded to this opponent action

  // Habits / movement.
  moveDir: number; // -1 back, 0 hold, 1 fwd
  moveTicks: number;
  guardHigh: number; // 0 = crouch guard default, 1 = standing

  // Adaptation memory.
  eatJump: number;
  eatLow: number;
  eatOverhead: number;
  eatThrow: number;
  eatProj: number;

  // Bookkeeping for damage classification.
  lastHealth: number;
  airAttackDone: number; // pressed my air button this jump

  // Cached combo book (move indices into my character's move table).
  bookGround: number[];
  bookLauncher: number;
  bookAir: number[];
  idxFireball: number;
  idxDp: number;
  idxSweep: number;
  idxLow: number;
  idxSpecialK: number; // 214K — the third special
  idxSuper: number;
  /** Earliest tick a RAW (non-combo) super may fire again — stops per-tick spam. */
  nextSuperAt: number;
  bookBuilt: number;
}

// ---------------------------------------------------------------- helpers
const rnd = (ai: AiState, n: number): number => {
  ai.rng = nextRand(ai.rng);
  return ai.rng % n;
};

/** True with probability p/255. */
const chance = (ai: AiState, p: number): boolean => rnd(ai, 255) < p;

/** Linear interpolation on the skill lever: value at skill 0 → value at 100. */
const lerp = (ai: AiState, at0: number, at100: number): number =>
  at0 + Math.trunc(((at100 - at0) * ai.skill) / 100);

/**
 * Same, but on a SQUARED skill curve — most of the value arrives at the top.
 * Integer-safe: skill ≤ 100, so skill² ≤ 10000.
 */
const lerpSq = (ai: AiState, at0: number, at100: number): number =>
  at0 + Math.trunc(((at100 - at0) * ai.skill * ai.skill) / 10000);

/**
 * Skill on a FLOORED, squared curve: 0 at/below `floor`, 100 at skill 100.
 *
 * For decisions worth so much damage that sharing them with weak agents
 * flattens the difficulty lever. This is measured, not guessed: giving skill-25
 * agents even a ~10% super rate dropped `skill 85 vs skill 25` from 91% to 74%
 * over 80 seeds — the lever the entire CPU-difficulty system rides on. A novice
 * who cashes out supers is not a novice.
 */
const skillRamp = (ai: AiState, floor: number): number => {
  if (ai.skill <= floor) return 0;
  const t = Math.trunc(((ai.skill - floor) * 100) / (100 - floor)); // 0..100
  return Math.trunc((t * t) / 100); // squared
};

const pxDist = (a: FighterState, b: FighterState): number =>
  Math.abs(fpToPx(a.x - b.x));

const aiGrounded = (f: FighterState): boolean => f.y >= fp(460);

const actionable = (f: FighterState): boolean =>
  f.action === Action.Idle || f.action === Action.WalkF
  || f.action === Action.WalkB || f.action === Action.Crouch;

// ---------------------------------------------------------------- meter
/**
 * Below this skill an agent never cashes a bar out of a CONFIRMED chain or a
 * whiff punish. Tuned against the bot-vs-bot balance suite: skilled super
 * usage is worth more than everything else a novice does combined, and
 * sharing it flattens the difficulty lever the whole CPU system rides on.
 *
 * Note this floor deliberately does NOT apply to raw supers — see superOdds.
 */
const SUPER_SKILL_FLOOR = 30;

/** Can the agent afford its super right now? */
const canSuper = (ai: AiState, ch: LoadedCharacter, me: FighterState): boolean =>
  ai.idxSuper >= 0 && me.meter >= (ch.b.moves[ai.idxSuper]?.meterCost ?? 9999);

/**
 * How much does the agent want to spend a bar, 0..255.
 *
 * Meter is a resource, not a trophy. The old gate was a flat `skill >= 65`,
 * which meant every house bot below player level ~26 (skill = level×100/40)
 * banked three bars and never spent one — free damage left on the table all
 * match.
 *
 * Appetite scales with skill and reads the situation instead.
 *
 * EVERY term below — including the situational bonuses — runs through the same
 * skill ramp. Leaving those bonuses flat looks harmless and is not: it hands
 * skill-3 agents a ~7% super rate through the back door and drags the
 * `skill 85 beats skill 25` lever from 91% down to 76% over 80 seeds. Measured
 * both ways; do not "simplify" the scaling out.
 */
const superOdds = (
  ai: AiState, me: FighterState, op: FighterState, dist: number, comboEnder: boolean,
): number => {
  const r = skillRamp(ai, SUPER_SKILL_FLOOR);
  if (r === 0) return 0; // a novice has no presence of mind for meter
  // Cashing a bar out of a confirmed chain is worth far more than a raw one.
  let odds = Math.trunc(((comboEnder ? 195 : 105) * r) / 100);
  // Close out the round: the opponent is one good hit from dead.
  const oppMax = characters[ai.side === 0 ? 1 : 0]?.b.maxHealth ?? 10000;
  if (op.health <= Math.trunc(oppMax / 4)) odds += Math.trunc((115 * r) / 100);
  // Capped meter means every further gain is being thrown away — spend it.
  if (me.meter >= TUNING.meterMax) odds += Math.trunc((60 * r) / 100);
  // Don't burn a bar into thin air.
  if (dist > 300) odds -= 70;
  return Math.max(0, Math.min(255, odds));
};

/**
 * The exact bounds personality sampling draws from (min = base, max = base +
 * range in createAi). Coached personalities (ADR 0006) are clamped to these
 * same bounds server-side AND here — a trained agent can play differently,
 * never outside what a randomly-rolled opponent could be. Keeping the clamp
 * in core means every consumer (server verify, client solo sim, headless
 * agents) agrees bit-for-bit on the effective values.
 */
export const AI_PERSONALITY_RANGES: Record<keyof AiPersonality, [number, number]> = {
  aggression: [90, 220],
  jumpiness: [40, 190],
  zoner: [40, 210],
  throwHappy: [30, 150],
  pushblocker: [60, 220],
  patience: [60, 200],
};

// ---------------------------------------------------------------- create
export const createAi = (
  side: 0 | 1, skill: number, seed: number,
  personality?: Partial<AiPersonality>,
): AiState => {
  const ai: AiState = {
    side,
    skill: Math.max(0, Math.min(100, skill)),
    rng: (seed | 0) ^ 0x51ed1e5,
    p: { aggression: 0, jumpiness: 0, zoner: 0, throwHappy: 0, pushblocker: 0, patience: 0 },
    intent: Intent.Observe,
    intentUntil: 0,
    queue: [],
    qTicks: 0,
    oppAction: -1,
    oppActionAt: 0,
    reacted: 1,
    moveDir: 0,
    moveTicks: 0,
    guardHigh: 0,
    eatJump: 0, eatLow: 0, eatOverhead: 0, eatThrow: 0, eatProj: 0,
    lastHealth: -1,
    airAttackDone: 0,
    bookGround: [], bookLauncher: -1, bookAir: [],
    idxFireball: -1, idxDp: -1, idxSweep: -1, idxLow: -1, idxSpecialK: -1, idxSuper: -1,
    nextSuperAt: 0,
    bookBuilt: 0,
  };
  // Personality: sampled once — this "person" for this match. ALWAYS sampled
  // (even when overridden) so the rng stream downstream of creation is
  // identical with and without a coached personality.
  ai.p.aggression = 90 + rnd(ai, 130);
  ai.p.jumpiness = 40 + rnd(ai, 150);
  ai.p.zoner = 40 + rnd(ai, 170);
  ai.p.throwHappy = 30 + rnd(ai, 120);
  ai.p.pushblocker = 60 + rnd(ai, 160);
  ai.p.patience = 60 + rnd(ai, 140);
  if (personality) {
    for (const k of Object.keys(AI_PERSONALITY_RANGES) as (keyof AiPersonality)[]) {
      const v = personality[k];
      if (typeof v !== 'number' || !Number.isFinite(v)) continue;
      const [lo, hi] = AI_PERSONALITY_RANGES[k];
      ai.p[k] = Math.max(lo, Math.min(hi, v | 0));
    }
  }
  return ai;
};

/** Combo routes come from the character's own data — cancel graph included. */
const buildBook = (ai: AiState, ch: LoadedCharacter): void => {
  const id = (s: string): number => ch.moveIdxById[s] ?? -1;
  ai.bookGround = ['5LP', '5MP', '5HP'].map(id).filter((i) => i >= 0);
  ai.bookLauncher = id('2HP');
  ai.bookAir = ['j.LP', 'j.MP', 'j.HP'].map(id).filter((i) => i >= 0);
  ai.idxFireball = id('236P');
  ai.idxDp = id('623P');
  ai.idxSweep = id('2HK');
  ai.idxLow = id('2LK');
  ai.idxSpecialK = id('214K');
  ai.idxSuper = ch.superIdx;
  ai.bookBuilt = 1;
};

const BUTTON_OF: Record<string, number> = {
  LP: Btn.LP, MP: Btn.MP, HP: Btn.HP, LK: Btn.LK, MK: Btn.MK, HK: Btn.HK,
};

const buttonOfMove = (ch: LoadedCharacter, idx: number): number => {
  const b = ch.b.moves[idx]?.button;
  return b ? BUTTON_OF[b]! : Btn.LP;
};

// ---------------------------------------------------------------- queueing
const q = (ai: AiState, step: QStep): void => { ai.queue.push(step); };

const qTapButton = (ai: AiState, buttons: number, down = 0): void => {
  q(ai, { buttons, down, ticks: 2 });
  q(ai, { down, ticks: 1 });
};

/** Queue a QCF motion + punch — sloppy at low skill (sometimes fails, human). */
const qFireball = (ai: AiState, buttons: number): void => {
  const sloppy = !chance(ai, lerp(ai, 140, 250)); // execution success odds
  q(ai, { down: 1, ticks: 3 });
  q(ai, { down: 1, fwd: 1, ticks: 2 });
  if (sloppy) {
    // Rushed the motion: skip the forward — parser may drop it. Human whiff.
    q(ai, { buttons, ticks: 2 });
  } else {
    q(ai, { fwd: 1, ticks: 2 });
    q(ai, { fwd: 1, buttons, ticks: 2 });
  }
  q(ai, { ticks: 2 });
};

/** QCB + K (214K). Mirror of qFireball — same sloppiness model. */
const q214 = (ai: AiState, buttons: number): void => {
  const sloppy = !chance(ai, lerp(ai, 140, 250));
  q(ai, { down: 1, ticks: 3 });
  q(ai, { down: 1, back: 1, ticks: 2 });
  if (sloppy) {
    q(ai, { buttons, ticks: 2 });
  } else {
    q(ai, { back: 1, ticks: 2 });
    q(ai, { back: 1, buttons, ticks: 2 });
  }
  q(ai, { ticks: 2 });
};

/** DP: f, d, df + P. */
const qDp = (ai: AiState, buttons: number): void => {
  q(ai, { fwd: 1, ticks: 2 });
  q(ai, { down: 1, ticks: 2 });
  q(ai, { down: 1, fwd: 1, buttons, ticks: 3 });
  q(ai, { ticks: 2 });
};

const qDash = (ai: AiState, dir: 'fwd' | 'back'): void => {
  const d = dir === 'fwd' ? { fwd: 1 } : { back: 1 };
  q(ai, { ...d, ticks: 2 });
  q(ai, { ticks: 2 });
  q(ai, { ...d, ticks: 3 });
};

// ---------------------------------------------------------------- emission
/** Translate a facing-relative step into an InputFrame for this tick. */
const emit = (me: FighterState, step: QStep | null, moveDir: number, crouch: boolean): InputFrame => {
  let f: InputFrame = 0;
  const fwdBit = me.facing === 1 ? Btn.Right : Btn.Left;
  const backBit = me.facing === 1 ? Btn.Left : Btn.Right;
  if (step) {
    if (step.fwd) f |= fwdBit;
    if (step.back) f |= backBit;
    if (step.up) f |= Btn.Up;
    if (step.down) f |= Btn.Down;
    if (step.buttons) f |= step.buttons;
    return f;
  }
  if (moveDir === 1) f |= fwdBit;
  else if (moveDir === -1) f |= backBit;
  if (crouch) f |= Btn.Down;
  return f;
};

// ---------------------------------------------------------------- the brain
export const aiPoll = (ai: AiState, g: GameState): InputFrame => {
  const me = g.fighters[ai.side];
  const op = g.fighters[1 - ai.side]!;
  const ch = characters[ai.side];

  if (!ai.bookBuilt) buildBook(ai, ch);
  if (ai.lastHealth < 0) ai.lastHealth = me.health;

  if (g.phase !== Phase.Fighting) {
    ai.queue = [];
    ai.qTicks = 0;
    ai.intent = Intent.Observe;
    ai.lastHealth = me.health;
    return 0;
  }

  const dist = pxDist(me, op);
  const reaction = lerp(ai, 22, 7) + rnd(ai, lerp(ai, 8, 3)); // frames + jitter
  const seen = (sinceTick: number): boolean => g.tick - sinceTick >= reaction;

  // ---- perception bookkeeping
  if (op.action !== ai.oppAction) {
    ai.oppAction = op.action;
    ai.oppActionAt = g.tick;
    ai.reacted = 0;
  }

  // ---- adaptation: classify how I just got hit
  if (me.health < ai.lastHealth) {
    if (!aiGrounded(op)) ai.eatJump = Math.min(9, ai.eatJump + 1);
    else if (op.action === Action.Grab || me.action === Action.Thrown) ai.eatThrow = Math.min(9, ai.eatThrow + 1);
    else if (op.action === Action.Crouch || op.action === Action.Attack) {
      // crude read: low pokes come from crouch-stance moves
      const opCh = characters[(1 - ai.side) as 0 | 1];
      const mv = op.moveIdx >= 0 ? opCh.b.moves[op.moveIdx] : null;
      if (mv?.stance === 'crouch') ai.eatLow = Math.min(9, ai.eatLow + 1);
    }
    ai.lastHealth = me.health;
  } else if (me.health > ai.lastHealth) {
    ai.lastHealth = me.health;
  }

  // ---- committed execution: drain the queue first (humans finish inputs)
  if (ai.queue.length > 0) {
    const step = ai.queue[0]!;
    const frame = emit(me, step, 0, false);
    if (++ai.qTicks >= step.ticks) {
      ai.queue.shift();
      ai.qTicks = 0;
    }
    return frame;
  }

  // ---- non-actionable states: reactions that don't need the intent system
  switch (me.action) {
    case Action.Thrown: {
      // Throw tech after human delay; success scales with skill.
      if (g.tick - ai.oppActionAt >= Math.max(3, reaction - 4)
        && chance(ai, lerp(ai, 40, 215))) {
        qTapButton(ai, Btn.HP);
      }
      return emit(me, null, 0, false);
    }
    case Action.BlockStand:
    case Action.BlockCrouch: {
      // Pushblock habit (advancing guard) — more at higher skill.
      if (chance(ai, Math.trunc((ai.p.pushblocker * lerp(ai, 20, 110)) / 255))) {
        qTapButton(ai, Btn.LP | Btn.MP, me.action === Action.BlockCrouch ? 1 : 0);
      }
      return emit(me, null, -1, me.action === Action.BlockCrouch);
    }
    case Action.Hitstun:
    case Action.AirHitstun:
      ai.intent = Intent.Defend; // when I come out, expect pressure
      ai.intentUntil = g.tick + 30;
      return 0;
    case Action.Knockdown:
    case Action.Getup:
      // Wake up guarding (down-back) — the most human default there is.
      return emit(me, null, -1, true);
    case Action.Air: {
      // Jump-in: time the air button by proximity, once per airtime.
      if (!ai.airAttackDone && ai.bookAir.length > 0) {
        const closing = dist < lerp(ai, 150, 190) && me.velY > fp(-6);
        if (closing) {
          ai.airAttackDone = 1;
          const pick = ai.bookAir[rnd(ai, ai.bookAir.length)]!;
          qTapButton(ai, buttonOfMove(ch, pick));
        }
      }
      // drift toward the opponent while airborne
      return emit(me, null, 1, false);
    }
    case Action.Attack: {
      // Hit-confirm: continue the combo book. Blocked → usually stop (safe).
      if (me.attackConnected === 1) {
        const next = comboNext(ai, ch, me, op, dist);
        if (next) return emit(me, null, 0, false); // queued; emitted next tick
      } else if (me.attackConnected === 2 && chance(ai, lerp(ai, 90, 30))) {
        // Low skill mashes one more into block sometimes — very human.
        const gi = ai.bookGround.indexOf(me.moveIdx);
        if (gi >= 0 && gi + 1 < ai.bookGround.length) {
          qTapButton(ai, buttonOfMove(ch, ai.bookGround[gi + 1]!));
        }
      }
      return emit(me, null, 0, false);
    }
    default:
      break;
  }

  if (aiGrounded(me)) ai.airAttackDone = 0;
  if (!actionable(me)) return emit(me, null, 0, false);

  // ---- reactive triggers (only after the reaction delay — humans are late)
  if (!ai.reacted && seen(ai.oppActionAt)) {
    // Opponent jumped at me → anti-air.
    const oppAirborne = ai.oppAction === Action.Air || ai.oppAction === Action.AirDash;
    if (oppAirborne && !aiGrounded(op) && dist < 240) {
      const aaOdds = Math.min(240, lerp(ai, 30, 190) + ai.eatJump * 12);
      if (chance(ai, aaOdds)) {
        ai.reacted = 1;
        if (ai.idxDp >= 0 && chance(ai, 170)) qDp(ai, Btn.HP);
        else if (ai.bookLauncher >= 0) qTapButton(ai, Btn.HP, 1); // 2HP
        return emit(me, null, 0, false);
      }
    }
    // Opponent started an attack in my face → guard.
    if (ai.oppAction === Action.Attack && dist < 200) {
      ai.reacted = 1;
      if (chance(ai, lerp(ai, 120, 235))) {
        ai.intent = Intent.Defend;
        ai.intentUntil = g.tick + 26 + rnd(ai, 30);
      }
    }
    // Opponent is getting up next to me → okizeme.
    if ((ai.oppAction === Action.Knockdown) && dist < 320 && chance(ai, ai.p.aggression)) {
      ai.reacted = 1;
      ai.intent = Intent.Oki;
      ai.intentUntil = g.tick + 70;
    }
  }

  // Projectile incoming → jump it or brace (personality decides).
  for (const pr of g.projectiles) {
    if (!pr.active || pr.owner === ai.side) continue;
    const towardMe = (pr.velX > 0) === (me.x > pr.x);
    const pdist = Math.abs(fpToPx(pr.x - me.x));
    if (towardMe && pdist < lerp(ai, 120, 260) && pdist > 40) {
      if (chance(ai, Math.min(220, ai.p.jumpiness + ai.eatProj * 20))) {
        q(ai, { up: 1, fwd: 1, ticks: 3 });
        ai.eatProj = Math.max(0, ai.eatProj - 1);
      } else {
        ai.intent = Intent.Defend;
        ai.intentUntil = g.tick + 24;
        if (me.health > 0 && chance(ai, 30)) ai.eatProj = Math.min(9, ai.eatProj + 1);
      }
      break;
    }
  }

  // Whiff punish: opponent stuck in recovery within reach.
  if (op.action === Action.Attack && op.attackConnected === 0
    && seen(ai.oppActionAt) && dist < 170 && chance(ai, lerp(ai, 40, 200))) {
    // A whiffed move is the cleanest super punish in the game — take it before
    // settling for a normal string.
    if (canSuper(ai, ch, me) && ai.queue.length === 0 && g.tick >= ai.nextSuperAt
      && chance(ai, superOdds(ai, me, op, dist, true))) {
      qFireball(ai, Btn.LP | Btn.MP);
      ai.nextSuperAt = g.tick + 90;
      return emit(me, null, 0, false);
    }
    ai.intent = Intent.Punish;
    ai.intentUntil = g.tick + 40;
  }

  // Raw super: no combo needed. Without this the bar is only ever spent out of
  // a confirmed chain, so an agent that never opens one dies at three bars.
  // Rate-limited, in-range, and only when it actually means something —
  // finishing the round, or meter that would otherwise overflow.
  if (canSuper(ai, ch, me) && ai.queue.length === 0 && g.tick >= ai.nextSuperAt
    && dist < 260 && aiGrounded(op)) {
    const oppMax = characters[ai.side === 0 ? 1 : 0]?.b.maxHealth ?? 10000;
    const finisher = op.health <= Math.trunc(oppMax / 4);
    const overflowing = me.meter >= TUNING.meterMax;
    if ((finisher || overflowing) && chance(ai, superOdds(ai, me, op, dist, false))) {
      qFireball(ai, Btn.LP | Btn.MP);
      ai.nextSuperAt = g.tick + 150;
      return emit(me, null, 0, false);
    }
  }

  // ---- intent lifecycle
  if (g.tick >= ai.intentUntil) pickIntent(ai, g, me, op, dist);

  return actIntent(ai, g, me, op, ch, dist);
};

// ---------------------------------------------------------------- intents
const pickIntent = (ai: AiState, g: GameState, me: FighterState, op: FighterState, dist: number): void => {
  // Utility-ish weighted pick, shaped by distance band + personality + memory.
  const w: [Intent, number][] = [];
  const losing = me.health < op.health - 1500;

  if (dist < 110) {
    w.push([Intent.Pressure, ai.p.aggression + (losing ? 40 : 0)]);
    w.push([Intent.Observe, 60]);
    w.push([Intent.Retreat, 70 - Math.trunc(ai.p.aggression / 4)]);
    w.push([Intent.Defend, 50 + ai.eatThrow * 10]);
  } else if (dist < 260) {
    w.push([Intent.Approach, ai.p.aggression]);
    w.push([Intent.Observe, ai.p.patience]);
    w.push([Intent.JumpIn, Math.trunc(ai.p.jumpiness / 2)]);
    w.push([Intent.Retreat, 45]);
    if (ai.idxFireball >= 0) w.push([Intent.Zone, Math.trunc(ai.p.zoner / 3)]);
  } else {
    w.push([Intent.Approach, ai.p.aggression]);
    if (ai.idxFireball >= 0) w.push([Intent.Zone, ai.p.zoner + (losing ? -30 : 20)]);
    w.push([Intent.JumpIn, ai.p.jumpiness]);
    w.push([Intent.Observe, Math.trunc(ai.p.patience / 2)]);
  }

  let total = 0;
  for (const [, wt] of w) total += Math.max(1, wt);
  let roll = rnd(ai, total);
  let picked = w[0]![0];
  for (const [intent, wt] of w) {
    roll -= Math.max(1, wt);
    if (roll < 0) { picked = intent; break; }
  }
  ai.intent = picked;
  // Humans hold a plan for a beat — duration scales with patience.
  ai.intentUntil = g.tick + 14 + rnd(ai, 30 + Math.trunc(ai.p.patience / 4));
  ai.moveTicks = 0;
};

const actIntent = (
  ai: AiState, g: GameState, me: FighterState, op: FighterState,
  ch: LoadedCharacter, dist: number,
): InputFrame => {
  switch (ai.intent) {
    case Intent.Observe: {
      // Shimmy: small walk holds back and forth, occasional crouch flicker.
      if (--ai.moveTicks <= 0) {
        ai.moveDir = [1, 0, -1, 0][rnd(ai, 4)]!;
        ai.moveTicks = 8 + rnd(ai, 18);
      }
      return emit(me, null, ai.moveDir, chance(ai, 6));
    }
    case Intent.Approach: {
      if (chance(ai, lerp(ai, 2, 14))) qDash(ai, 'fwd'); // dashes at higher skill
      if (dist < 100) { // arrived → strike or throw
        ai.intent = Intent.Pressure;
        ai.intentUntil = g.tick + 40;
      }
      return emit(me, null, 1, false);
    }
    case Intent.Retreat:
      return emit(me, null, -1, chance(ai, 30));
    case Intent.Zone: {
      if (ai.queue.length === 0 && dist > 180) qFireball(ai, Btn.LP);
      ai.intent = Intent.Observe;
      ai.intentUntil = g.tick + 20 + rnd(ai, 26);
      return emit(me, null, 0, false);
    }
    case Intent.JumpIn: {
      q(ai, { up: 1, fwd: 1, ticks: 4 });
      ai.intent = Intent.Approach;
      ai.intentUntil = g.tick + 50;
      return emit(me, null, 1, false);
    }
    case Intent.Punish:
    case Intent.Pressure: {
      if (dist > 140) { // not in range yet — close in
        return emit(me, null, 1, false);
      }
      openString(ai, ch, dist);
      ai.intent = Intent.Observe;
      ai.intentUntil = g.tick + 16 + rnd(ai, 20);
      return emit(me, null, 0, false);
    }
    case Intent.Defend: {
      // Hold guard. Default crouch-block; stand vs remembered overheads/jumpers.
      const standGuard = ai.eatOverhead >= 2 || (!aiGrounded(op) && chance(ai, 200));
      return emit(me, null, -1, !standGuard);
    }
    case Intent.Oki: {
      if (dist > 90) return emit(me, null, 1, false);
      if (op.action !== Action.Knockdown && op.action !== Action.Getup) {
        ai.intent = Intent.Pressure;
        ai.intentUntil = g.tick + 30;
        return emit(me, null, 0, false);
      }
      // Time a meaty as they rise: low / throw mixup.
      if (op.action === Action.Getup && ch.b.moves && ai.queue.length === 0) {
        if (chance(ai, ai.p.throwHappy)) q(ai, { fwd: 1, buttons: Btn.HP, ticks: 2 });
        else if (ai.idxLow >= 0) qTapButton(ai, Btn.LK, 1);
      }
      return emit(me, null, 0, chance(ai, 128));
    }
    default:
      return emit(me, null, 0, false);
  }
};

/** Pick a string opener at close range: jab chain / low / sweep / throw. */
const openString = (ai: AiState, ch: LoadedCharacter, dist: number): void => {
  const roll = rnd(ai, 255);
  if (dist < 70 && roll < ai.p.throwHappy) {
    q(ai, { fwd: 1, buttons: Btn.HP, ticks: 2 }); // throw attempt
    return;
  }
  if (roll < 100 && ai.idxLow >= 0) {
    qTapButton(ai, Btn.LK, 1); // 2LK — low opener
    return;
  }
  if (roll < 140 && ai.idxSweep >= 0 && chance(ai, 90)) {
    qTapButton(ai, Btn.HK, 1); // sweep
    return;
  }
  qTapButton(ai, Btn.LP); // jab — chain continues via hit-confirm
};

/**
 * Continue the combo book after a confirmed hit. Skill gates route depth:
 * low skill stops at chains, high skill goes launcher → air combo → enders.
 * Every link can be flubbed (dropped/late) — that's the human hand.
 */
const comboNext = (
  ai: AiState, ch: LoadedCharacter, me: FighterState, op: FighterState, dist: number,
): boolean => {
  // Flubbed link: hesitate — the buffer may still save it, sometimes not.
  const flub = !chance(ai, lerp(ai, 150, 246));
  const delay = flub ? 3 + rnd(ai, 5) : 0;

  const gi = ai.bookGround.indexOf(me.moveIdx);
  if (gi >= 0) {
    if (gi + 1 < ai.bookGround.length) {
      if (delay) q(ai, { ticks: delay });
      qTapButton(ai, buttonOfMove(ch, ai.bookGround[gi + 1]!));
      return true;
    }
    // End of ground chain: super / launcher / special, by skill + situation.
    // Cashing a bar out of a confirmed chain is the single best thing the
    // agent can do with meter, so it gets first refusal.
    if (canSuper(ai, ch, me) && chance(ai, superOdds(ai, me, op, dist, true))) {
      qFireball(ai, Btn.LP | Btn.MP); // 236 + two punches = super
      return true;
    }
    if (ai.bookLauncher >= 0 && ai.skill >= 40 && chance(ai, lerp(ai, 60, 210))) {
      if (delay) q(ai, { ticks: delay });
      qTapButton(ai, Btn.HP, 1); // 2HP launcher
      return true;
    }
    if (ai.idxFireball >= 0 && chance(ai, ai.p.zoner)) {
      qFireball(ai, Btn.LP);
      return true;
    }
    // 214K: the third special, right there in every character's data and
    // never once pressed before this. It's a close-range ender.
    if (ai.idxSpecialK >= 0 && dist < 150 && chance(ai, lerpSq(ai, 20, 150))) {
      q214(ai, Btn.LK);
      return true;
    }
    return false;
  }

  // Launcher connected → super jump after it (engine's launch jump-cancel).
  if (me.moveIdx === ai.bookLauncher && ai.skill >= 45) {
    q(ai, { up: 1, fwd: 1, ticks: 6 });
    // Rising air chain, timed like fingers, each link flubbable.
    let t = 4 + rnd(ai, 3);
    for (const idx of ai.bookAir) {
      if (!chance(ai, lerp(ai, 130, 240))) break; // dropped the string here
      q(ai, { ticks: t });
      qTapButton(ai, buttonOfMove(ch, idx));
      t = 4 + rnd(ai, 4);
    }
    return true;
  }
  return false;
};
