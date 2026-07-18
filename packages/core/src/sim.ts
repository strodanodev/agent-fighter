import {
  Btn, KICK_MASK, PUNCH_MASK, countBits, held, pressedAttacks,
} from './input.js';
import type { InputFrame } from './input.js';
import { clamp, fp, fpToPx } from './fp.js';
import { BUTTON_BITS, BUTTON_PRIORITY, STAGE, TUNING } from './data.js';
import type { HitboxDef, LoadedCharacter, MoveDef, Rect } from './data.js';
import { detectMotion, downTappedRecently, numpadDir } from './motion.js';
import { Action, PROJECTILE_SLOTS, Phase, characters, resetRound } from './state.js';
import type { FighterState, GameState, ProjectileState } from './state.js';

const FLOOR = fp(STAGE.floorYPx);
const WALL_L = fp(STAGE.wallPad);
const WALL_R = fp(STAGE.widthPx - STAGE.wallPad);
const FRICTION = fp(TUNING.friction);
const CORNER = fp(TUNING.cornerThresholdPx);

interface WorldRect {
  l: number; t: number; r: number; b: number; // fixed-point
}

/** Mirror a character-space rect into world space based on facing. */
const worldRect = (x: number, y: number, facing: number, rc: Rect): WorldRect => {
  const rx = fp(rc.x);
  const rw = fp(rc.w);
  const l = facing === 1 ? x + rx : x - rx - rw;
  return { l, t: y + fp(rc.y), r: l + rw, b: y + fp(rc.y) + fp(rc.h) };
};

const overlaps = (a: WorldRect, b: WorldRect): boolean =>
  a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;

const grounded = (f: FighterState): boolean => f.y >= FLOOR;

const setAction = (f: FighterState, a: Action): void => {
  f.action = a;
  f.actionFrame = 0;
};

// ---------------------------------------------------------------------------
// Move-step resolution
// ---------------------------------------------------------------------------

const currentMove = (f: FighterState, ch: LoadedCharacter): MoveDef | null =>
  f.action === Action.Attack && f.moveIdx >= 0 ? ch.b.moves[f.moveIdx]! : null;

/** Step index for a frame counter within a move; -1 past the end. */
const stepIndexAt = (move: MoveDef, frame: number): number => {
  let acc = 0;
  for (let i = 0; i < move.steps.length; i++) {
    acc += move.steps[i]!.frames;
    if (frame < acc) return i;
  }
  return -1;
};

const hurtboxesOf = (f: FighterState, ch: LoadedCharacter): Rect[] => {
  switch (f.action) {
    case Action.KO:
    case Action.Knockdown:
    case Action.Getup:
    case Action.Thrown:
      return []; // invulnerable
    case Action.Attack: {
      const move = currentMove(f, ch)!;
      const si = stepIndexAt(move, f.actionFrame);
      return si >= 0 ? move.steps[si]!.hurtboxes : [ch.b.standHurtbox];
    }
    case Action.Crouch:
    case Action.BlockCrouch:
      return [ch.b.crouchHurtbox];
    case Action.Air:
    case Action.AirDash:
    case Action.AirHitstun:
    case Action.BlockAir:
      return [ch.b.airHurtbox];
    default:
      return [ch.b.standHurtbox];
  }
};

// ---------------------------------------------------------------------------
// Input gathering — runs EVERY tick, including hitstop/super-flash, so
// motions and buttons buffered during freezes come out afterward (MvC feel).
// ---------------------------------------------------------------------------

interface TickIO {
  input: InputFrame;
  edges: number; // attack buttons newly pressed
  upEdge: boolean;
}

const gatherInputs = (f: FighterState, input: InputFrame): TickIO => {
  const prev = f.prevInput;
  const upEdge = held(input, Btn.Up) && !held(prev, Btn.Up);

  // Direction history (numpad, facing-relative).
  f.histIdx = (f.histIdx + 1) % 16;
  f.dirHist[f.histIdx] = numpadDir(input, f.facing);

  // Attack-button buffer with motion detected at press time.
  const edges = pressedAttacks(input, prev);
  if (edges !== 0) {
    f.bufButtons = f.bufLeft > 0 ? f.bufButtons | edges : edges;
    f.bufMotion = detectMotion(f.dirHist, f.histIdx);
    f.bufLeft = TUNING.inputBufferTicks;
  }

  // Dash double-tap: two taps of the same pure horizontal within the window.
  const tapL = held(input, Btn.Left) && !held(prev, Btn.Left);
  const tapR = held(input, Btn.Right) && !held(prev, Btn.Right);
  if (tapL || tapR) {
    const dir = tapR ? 1 : -1;
    if (f.tapDir === dir && f.tapTimer > 0) {
      f.dashBuf = dir;
      f.dashBufLeft = 4;
      f.tapDir = 0;
      f.tapTimer = 0;
    } else {
      f.tapDir = dir;
      f.tapTimer = TUNING.doubleTapWindowTicks;
    }
  }
  if (f.tapTimer > 0) f.tapTimer--;
  if (f.dashBufLeft > 0 && --f.dashBufLeft === 0) f.dashBuf = 0;

  f.prevInput = input;
  return { input, edges, upEdge };
};

// ---------------------------------------------------------------------------
// Attack startup — buffer consumption, move selection, cancels
// ---------------------------------------------------------------------------

const startMove = (s: GameState, f: FighterState, ch: LoadedCharacter, idx: number): void => {
  const move = ch.b.moves[idx]!;
  f.moveIdx = idx;
  f.attackConnected = 0;
  f.hitConsumedStep = -1;
  setAction(f, Action.Attack);
  if (move.stance !== 'air') f.velX = 0;
  const s0 = move.steps[0]!;
  if (s0.velX !== undefined) f.velX = f.facing * fp(s0.velX);
  if (s0.velY !== undefined) f.velY = fp(s0.velY);
  f.meter = clamp(f.meter + move.meterGainWhiff - (move.meterCost ?? 0), 0, TUNING.meterMax);
  if (move.type === 'super') s.superFlashLeft = TUNING.superFlashTicks;
  f.bufButtons = 0;
  f.bufMotion = 0;
  f.bufLeft = 0;
  f.launchJC = 0;
};

/**
 * Try to start a buffered attack. `cancelFromIdx >= 0` restricts targets to
 * the cancel graph of that move given how it connected (1 hit / 2 block).
 */
const tryStartAttack = (
  s: GameState, f: FighterState, ch: LoadedCharacter, io: TickIO,
  cancelFromIdx: number, connected: number,
): boolean => {
  if (f.bufLeft <= 0 || f.bufButtons === 0) return false;
  const isAir = !grounded(f);
  const stance = isAir ? 2 : held(io.input, Btn.Down) ? 1 : 0;
  const n = ch.b.moves.length;
  const canCancel = (to: number): boolean => {
    if (cancelFromIdx < 0) return true;
    const m = connected === 2 ? ch.cancelBlock : ch.cancelHit;
    return m[cancelFromIdx * n + to] === 1;
  };

  // 1. Super: 236 + two punches, ground only, needs a bar.
  if (ch.superIdx >= 0) {
    const sup = ch.b.moves[ch.superIdx]!;
    if (!isAir && f.bufMotion === sup.motion
      && countBits(f.bufButtons & PUNCH_MASK) >= 2
      && f.meter >= (sup.meterCost ?? 0)
      && canCancel(ch.superIdx)) {
      startMove(s, f, ch, ch.superIdx);
      return true;
    }
  }
  // 2. Specials, in data order.
  if (f.bufMotion !== 0) {
    for (const sp of ch.specials) {
      const move = ch.b.moves[sp.idx]!;
      const stanceOk = move.stance === 'air' ? isAir : !isAir;
      const mask = sp.kind === 'P' ? PUNCH_MASK : KICK_MASK;
      if (sp.motion === f.bufMotion && stanceOk && (f.bufButtons & mask) !== 0 && canCancel(sp.idx)) {
        startMove(s, f, ch, sp.idx);
        return true;
      }
    }
  }
  // 3. Normals by button priority for the current stance.
  for (const name of BUTTON_PRIORITY) {
    const bit = BUTTON_BITS[name];
    if ((f.bufButtons & bit) === 0) continue;
    let pos = 0;
    let b = bit;
    while ((b >>= 1) !== 0) pos++;
    const idx = ch.normals[stance]![pos]!;
    if (idx >= 0 && canCancel(idx)) {
      startMove(s, f, ch, idx);
      return true;
    }
  }
  return false;
};

const startJump = (f: FighterState, superJump: boolean): void => {
  setAction(f, Action.JumpSquat);
  f.superJumped = superJump ? 1 : 0;
  f.velX = 0;
};

// ---------------------------------------------------------------------------
// Per-fighter update
// ---------------------------------------------------------------------------

const updateFighter = (
  s: GameState, f: FighterState, other: FighterState, ch: LoadedCharacter, io: TickIO,
): void => {
  // The input buffer expires in sim time (not during hitstop/super flash),
  // so inputs buffered through a freeze still come out afterward.
  if (f.bufLeft > 0 && --f.bufLeft === 0) {
    f.bufButtons = 0;
    f.bufMotion = 0;
  }

  switch (f.action) {
    case Action.KO:
      break; // physics only

    case Action.Knockdown:
      f.actionFrame++;
      if (f.actionFrame >= TUNING.knockdownTicks) setAction(f, Action.Getup);
      break;

    case Action.Getup:
      f.actionFrame++;
      if (f.actionFrame >= TUNING.getupTicks) setAction(f, Action.Idle);
      break;

    case Action.Thrown:
      // Held by the opponent. Tech input: HP press inside the window.
      if (f.techLeft > 0) {
        f.techLeft--;
        if ((io.edges & Btn.HP) !== 0) f.techLeft = -1; // teched — resolved by grab owner
      }
      break;

    case Action.Grab:
      f.actionFrame++; // outcome resolved in resolveGrabs (needs both fighters)
      break;

    case Action.Hitstun:
      f.hitstunLeft--;
      if (f.hitstunLeft <= 0) setAction(f, Action.Idle);
      break;

    case Action.AirHitstun:
      if (f.hitstunLeft > 0) f.hitstunLeft--;
      if (f.hitstunLeft <= 0 && !f.knockdownOnLand) {
        // Air recover: fell out of the combo, can act again.
        setAction(f, Action.Air);
        f.airLocked = 0;
      }
      break;

    case Action.BlockStand:
    case Action.BlockCrouch:
    case Action.BlockAir: {
      f.blockstunLeft--;
      // Pushblock (advancing guard): two punches during blockstun, once per
      // string. Reads the input buffer so presses during hitstop still count.
      const pbButtons = io.edges | (f.bufLeft > 0 ? f.bufButtons : 0);
      if (!f.pushblocked && countBits(pbButtons & PUNCH_MASK) >= 2) {
        f.bufButtons = 0;
        f.bufMotion = 0;
        f.bufLeft = 0;
        f.pushblocked = 1;
        f.velX = -f.facing * fp(TUNING.pushblockSelfVel);
        // Cornered blockers can't slide back — shove the attacker out instead.
        const atWall = f.x <= WALL_L + CORNER || f.x >= WALL_R - CORNER;
        if (atWall && grounded(other)) {
          other.velX = (other.x >= f.x ? 1 : -1) * fp(TUNING.pushblockAttackerVel);
        }
      }
      if (f.blockstunLeft <= 0) {
        setAction(f, f.action === Action.BlockCrouch ? Action.Crouch
          : f.action === Action.BlockAir ? Action.Air : Action.Idle);
      }
      break;
    }

    case Action.JumpSquat:
      f.actionFrame++;
      if (f.actionFrame >= TUNING.jumpSquatTicks) {
        setAction(f, Action.Air);
        f.velY = fp(f.superJumped ? ch.b.superJumpVelY : ch.b.jumpVelY);
        const dir = (held(io.input, Btn.Right) ? 1 : 0) - (held(io.input, Btn.Left) ? 1 : 0);
        f.velX = dir * fp(ch.b.jumpVelX);
        f.jumpsLeft = ch.b.doubleJump ? 1 : 0;
        f.airdashLeft = ch.b.airDash ? 1 : 0;
      }
      break;

    case Action.DashF:
      f.actionFrame++;
      f.velX = f.facing * fp(ch.b.dashFSpeed);
      if (tryStartAttack(s, f, ch, io, -1, 0)) break; // dashes cancel into attacks
      if (f.actionFrame >= ch.b.dashFTicks) {
        f.velX = 0;
        setAction(f, Action.Idle);
      }
      break;

    case Action.DashB:
      f.actionFrame++;
      f.velX = -f.facing * fp(ch.b.dashBSpeed);
      if (f.actionFrame >= ch.b.dashBTicks) {
        f.velX = 0;
        setAction(f, Action.Idle);
      }
      break;

    case Action.AirDash:
      f.actionFrame++;
      if (tryStartAttack(s, f, ch, io, -1, 0)) break;
      if (f.actionFrame >= ch.b.airDashTicks) setAction(f, Action.Air);
      break;

    case Action.Attack: {
      const move = currentMove(f, ch)!;
      const prevStep = stepIndexAt(move, f.actionFrame);
      f.actionFrame++;
      if (f.launchJC > 0) f.launchJC--;
      const total = ch.totalFrames[f.moveIdx]!;

      if (f.actionFrame >= total) {
        // Move over. Airborne specials fall locked until landing.
        f.moveIdx = -1;
        if (grounded(f)) {
          f.velX = 0;
          setAction(f, Action.Idle);
        } else {
          setAction(f, Action.Air);
          if (move.type !== 'normal') f.airLocked = 1;
        }
        break;
      }

      // Step-boundary velocity impulses.
      const si = stepIndexAt(move, f.actionFrame);
      if (si !== prevStep && si >= 0) {
        const st = move.steps[si]!;
        if (st.velX !== undefined) f.velX = f.facing * fp(st.velX);
        if (st.velY !== undefined) f.velY = fp(st.velY);
      }

      // Air moves cancel on landing.
      if (move.stance === 'air' && grounded(f) && f.velY >= 0) {
        f.moveIdx = -1;
        f.velX = 0;
        setAction(f, Action.Idle);
        break;
      }

      // Launcher jump-cancel: super jump after the launcher connects.
      if (f.attackConnected === 1 && f.launchJC > 0 && grounded(f) && held(io.input, Btn.Up)) {
        f.moveIdx = -1;
        startJump(f, true);
        break;
      }

      // Chain / special / super cancels once the move has connected.
      if (f.attackConnected !== 0) {
        tryStartAttack(s, f, ch, io, f.moveIdx, f.attackConnected);
      }
      break;
    }

    case Action.Air: {
      if (f.airLocked) break;
      if (tryStartAttack(s, f, ch, io, -1, 0)) break;
      if (io.upEdge && f.jumpsLeft > 0) {
        f.jumpsLeft--;
        f.velY = fp(ch.b.jumpVelY);
        const dir = (held(io.input, Btn.Right) ? 1 : 0) - (held(io.input, Btn.Left) ? 1 : 0);
        f.velX = dir * fp(ch.b.jumpVelX);
        break;
      }
      if (f.dashBuf !== 0 && f.airdashLeft > 0) {
        f.airdashLeft--;
        f.velX = f.dashBuf * fp(ch.b.airDashSpeed);
        f.velY = 0;
        f.dashBuf = 0;
        setAction(f, Action.AirDash);
      }
      break;
    }

    case Action.Idle:
    case Action.WalkF:
    case Action.WalkB:
    case Action.Crouch: {
      // Throw intent: close + 4/6 + fresh HP. Resolved after both update.
      const holdF = held(io.input, f.facing === 1 ? Btn.Right : Btn.Left);
      const holdB = held(io.input, f.facing === 1 ? Btn.Left : Btn.Right);
      if ((io.edges & Btn.HP) !== 0 && (holdF || holdB) && grounded(f) && !held(io.input, Btn.Down)) {
        const dx = other.x - f.x;
        const dist = dx < 0 ? -dx : dx;
        const throwable = grounded(other) && (
          other.action === Action.Idle || other.action === Action.WalkF
          || other.action === Action.WalkB || other.action === Action.Crouch
          || other.action === Action.Attack || other.action === Action.DashF
          || other.action === Action.DashB
        );
        if (dist <= fp(ch.b.throwRange) && throwable) {
          f.wantThrow = holdB ? 2 : 1;
          f.bufButtons &= ~Btn.HP; // the press is spent on the throw
          break;
        }
      }

      if (tryStartAttack(s, f, ch, io, -1, 0)) break;

      if (f.dashBuf !== 0 && grounded(f)) {
        const fwd = f.dashBuf === f.facing;
        f.dashBuf = 0;
        setAction(f, fwd ? Action.DashF : Action.DashB);
        break;
      }

      if (held(io.input, Btn.Up) && grounded(f)) {
        startJump(f, downTappedRecently(f.dirHist, f.histIdx));
        break;
      }

      if (held(io.input, Btn.Down)) {
        f.velX = 0;
        if (f.action !== Action.Crouch) setAction(f, Action.Crouch);
        else f.actionFrame++;
        break;
      }

      const dir = (held(io.input, Btn.Right) ? 1 : 0) - (held(io.input, Btn.Left) ? 1 : 0);
      const fwd = dir === f.facing;
      f.velX = dir === 0 ? 0 : dir * fp(fwd ? ch.b.walkFSpeed : ch.b.walkBSpeed);
      const next = dir === 0 ? Action.Idle : fwd ? Action.WalkF : Action.WalkB;
      if (f.action !== next) setAction(f, next);
      else f.actionFrame++;
      break;
    }
  }

  // ------------------------------------------------------------- physics
  const skipPhysics = f.action === Action.Thrown || f.action === Action.Grab
    || f.action === Action.AirDash || f.action === Action.JumpSquat;
  if (!skipPhysics) {
    if (!grounded(f) || f.velY < 0) f.velY += fp(ch.b.gravity);
    f.x += f.velX;
    f.y += f.velY;
    if (f.y >= FLOOR && f.velY >= 0) {
      const wasAirborne = f.y - f.velY < FLOOR || f.velY > 0;
      f.y = FLOOR;
      f.velY = 0;
      if (wasAirborne) landFighter(f);
    }
  } else if (f.action === Action.AirDash) {
    f.x += f.velX; // air dash: horizontal only, gravity suspended
  }
  f.x = clamp(f.x, WALL_L, WALL_R);

  // Ground slide friction for passive states.
  if (grounded(f) && (
    f.action === Action.Hitstun || f.action === Action.KO
    || f.action === Action.Knockdown || f.action === Action.Getup
    || f.action === Action.BlockStand || f.action === Action.BlockCrouch
  )) {
    if (f.velX > 0) f.velX = Math.max(0, f.velX - FRICTION);
    else if (f.velX < 0) f.velX = Math.min(0, f.velX + FRICTION);
  }
};

/** Landing transitions (called once when feet touch the floor). */
const landFighter = (f: FighterState): void => {
  switch (f.action) {
    case Action.Air:
    case Action.BlockAir:
      f.velX = 0;
      f.superJumped = 0;
      f.airLocked = 0;
      setAction(f, Action.Idle);
      break;
    case Action.AirHitstun:
      f.velX = 0;
      f.superJumped = 0;
      f.airLocked = 0;
      f.hitstunLeft = 0;
      f.knockdownOnLand = 0;
      setAction(f, Action.Knockdown);
      break;
    case Action.KO:
      f.velY = 0;
      break;
    default:
      break; // Attack landing handled in the attack branch
  }
};

// ---------------------------------------------------------------------------
// Strike resolution (melee + projectiles share this)
// ---------------------------------------------------------------------------

const canBlock = (
  vic: FighterState, threatX: number, guard: HitboxDef['guard'],
): boolean => {
  if (guard === 'unblockable') return false;
  const a = vic.action;
  const blockableState = a === Action.Idle || a === Action.WalkB || a === Action.Crouch
    || a === Action.BlockStand || a === Action.BlockCrouch || a === Action.BlockAir
    || (a === Action.Air && !vic.airLocked);
  if (!blockableState) return false;
  const backBtn = threatX >= vic.x ? Btn.Left : Btn.Right;
  if (!held(vic.prevInput, backBtn)) return false;
  if (!grounded(vic)) return guard !== 'low'; // air block: everything but lows
  const crouching = held(vic.prevInput, Btn.Down);
  if (guard === 'low') return crouching;
  if (guard === 'overhead') return !crouching;
  return true;
};

interface StrikeSource {
  facing: number; // push direction (+1 right)
  x: number; // for corner-transfer + block side
  attacker: FighterState | null; // null for projectiles
  /**
   * Whose item buff (ADR 0007) scales this hit's damage — the attacker for
   * melee, the OWNER for projectiles (attacker stays null there so meter /
   * corner-transfer semantics are untouched).
   */
  buff: FighterState;
  move: MoveDef;
}

/** Item-buff damage pipeline: attacker's OVERCLOCK, then victim's FIREWALL. */
const itemScaled = (dmg: number, src: StrikeSource, vic: FighterState, floor: number): number => {
  let d = dmg;
  if (src.buff.itemBuffLeft > 0 && src.buff.itemDmg > 0) {
    d = Math.trunc((d * (1000 + src.buff.itemDmg)) / 1000);
  }
  if (vic.itemBuffLeft > 0 && vic.itemDef > 0) {
    d = Math.trunc((d * (1000 - vic.itemDef)) / 1000);
  }
  return Math.max(floor, d);
};

/** Apply one hit/block. Returns 0 none, 1 hit, 2 block. */
const strike = (s: GameState, src: StrikeSource, vic: FighterState, hb: HitboxDef): number => {
  if (vic.action === Action.KO || vic.action === Action.Knockdown
    || vic.action === Action.Getup || vic.action === Action.Thrown) return 0;

  const vicAir = !grounded(vic);
  const inCombo = vic.action === Action.Hitstun || vic.action === Action.AirHitstun;

  // Juggle points: an exhausted budget means air hits whiff (bounds infinites).
  if (vicAir && inCombo && hb.juggleCost > vic.juggleBudget) return 0;

  const dir = src.facing;

  if (canBlock(vic, src.x, hb.guard)) {
    vic.health = Math.max(0, vic.health - (hb.chip > 0 ? itemScaled(hb.chip, src, vic, 0) : 0));
    vic.blockstunLeft = hb.blockstun;
    vic.velX = dir * fp(hb.pushbackBlock);
    vic.pushblocked = 0;
    setAction(vic, vicAir ? Action.BlockAir
      : held(vic.prevInput, Btn.Down) ? Action.BlockCrouch : Action.BlockStand);
    cornerTransfer(vic, src, hb.pushbackBlock, dir);
    s.hitstopLeft = Math.max(s.hitstopLeft, hb.hitstopFrames);
    if (src.attacker) {
      src.attacker.meter = clamp(src.attacker.meter + (src.move.meterGainHit >> 1), 0, TUNING.meterMax);
    }
    vic.meter = clamp(vic.meter + TUNING.blockMeterGain, 0, TUNING.meterMax);
    if (vic.health <= 0) koFighter(vic, dir); // chip can KO
    return 2;
  }

  // --- clean hit
  if (!inCombo) {
    vic.comboHits = 0;
    vic.comboScaling = TUNING.scalingStart;
    vic.juggleBudget = TUNING.juggleBudget;
  }
  vic.comboHits++;
  const dmg = itemScaled(Math.max(
    Math.trunc((hb.damage * Math.max(vic.comboScaling, TUNING.scalingFloor)) / 1000), 1), src, vic, 1);
  vic.comboScaling = Math.max(
    Math.trunc((vic.comboScaling * TUNING.scalingMult) / 1000), TUNING.scalingFloor);
  if (vicAir) vic.juggleBudget -= hb.juggleCost;
  vic.health = Math.max(0, vic.health - dmg);

  const stun = Math.max(
    hb.hitstun - (vic.comboHits >> TUNING.hitstunDecayShift), TUNING.minHitstun);

  vic.moveIdx = -1;
  if (hb.launcher) {
    vic.velY = fp(hb.launchVelY ?? -16);
    vic.velX = dir * fp(hb.pushbackHit);
    vic.hitstunLeft = Math.max(stun, 60);
    vic.knockdownOnLand = 1;
    setAction(vic, Action.AirHitstun);
  } else if (vicAir) {
    vic.velY = fp(hb.airPopVelY ?? -7);
    vic.velX = dir * fp(hb.pushbackHit);
    vic.hitstunLeft = stun;
    if (hb.knockdown) vic.knockdownOnLand = 1;
    setAction(vic, Action.AirHitstun);
  } else if (hb.knockdown) {
    vic.velY = fp(-6);
    vic.velX = dir * fp(hb.pushbackHit);
    vic.hitstunLeft = stun;
    vic.knockdownOnLand = 1;
    setAction(vic, Action.AirHitstun);
  } else {
    vic.velX = dir * fp(hb.pushbackHit);
    vic.hitstunLeft = stun;
    setAction(vic, Action.Hitstun);
  }

  cornerTransfer(vic, src, hb.pushbackHit, dir);
  s.hitstopLeft = Math.max(s.hitstopLeft, hb.hitstopFrames);
  if (src.attacker) {
    src.attacker.meter = clamp(src.attacker.meter + src.move.meterGainHit, 0, TUNING.meterMax);
    if (hb.launcher) src.attacker.launchJC = 24;
  }
  vic.meter = clamp(vic.meter + Math.trunc(dmg / TUNING.victimMeterDivisor), 0, TUNING.meterMax);
  if (vic.health <= 0) koFighter(vic, dir);
  return 1;
};

/** Cornered victims transfer pushback to a grounded melee attacker. */
const cornerTransfer = (vic: FighterState, src: StrikeSource, push: number, dir: number): void => {
  const atWall = (dir < 0 && vic.x <= WALL_L + CORNER) || (dir > 0 && vic.x >= WALL_R - CORNER);
  if (atWall && src.attacker && grounded(src.attacker)) {
    src.attacker.velX = -dir * fp(push);
  }
};

const koFighter = (f: FighterState, dir: number): void => {
  f.velY = fp(-8);
  f.velX = dir * fp(4);
  setAction(f, Action.KO);
};

// ---------------------------------------------------------------------------
// Projectiles
// ---------------------------------------------------------------------------

const spawnProjectile = (s: GameState, owner: number, f: FighterState, moveIdx: number): void => {
  const move = characters[owner as 0 | 1].b.moves[moveIdx]!;
  const pd = move.projectile!;
  // One live projectile per player (classic fireball rule).
  for (const p of s.projectiles) if (p.active && p.owner === owner) return;
  for (const p of s.projectiles) {
    if (!p.active) {
      p.active = 1;
      p.owner = owner;
      p.moveIdx = moveIdx;
      p.x = f.x + f.facing * fp(pd.spawnX);
      p.y = f.y + fp(pd.spawnY);
      p.velX = f.facing * fp(pd.velX);
      p.life = pd.lifetime;
      p.hasHit = 0;
      return;
    }
  }
};

const projectileRect = (p: ProjectileState): WorldRect => {
  const pd = characters[p.owner as 0 | 1].b.moves[p.moveIdx]!.projectile!;
  const facing = p.velX >= 0 ? 1 : -1;
  return worldRect(p.x, p.y, facing, pd.rect);
};

const updateProjectiles = (s: GameState): void => {
  for (const p of s.projectiles) {
    if (!p.active) continue;
    p.x += p.velX;
    if (--p.life <= 0 || p.x < WALL_L - fp(60) || p.x > WALL_R + fp(60)) p.active = 0;
  }
  // Opposing projectiles neutralize each other.
  for (let i = 0; i < PROJECTILE_SLOTS; i++) {
    const a = s.projectiles[i]!;
    if (!a.active) continue;
    for (let j = i + 1; j < PROJECTILE_SLOTS; j++) {
      const b = s.projectiles[j]!;
      if (!b.active || a.owner === b.owner) continue;
      if (overlaps(projectileRect(a), projectileRect(b))) {
        a.active = 0;
        b.active = 0;
      }
    }
  }
};

// ---------------------------------------------------------------------------
// Throws
// ---------------------------------------------------------------------------

const resolveThrows = (s: GameState): void => {
  const [f0, f1] = s.fighters;
  const w0 = f0.wantThrow;
  const w1 = f1.wantThrow;
  f0.wantThrow = 0;
  f1.wantThrow = 0;
  if (w0 && w1) {
    // Simultaneous throws: instant tech, push apart.
    f0.velX = -f0.facing * fp(6);
    f1.velX = -f1.facing * fp(6);
    setAction(f0, Action.Idle);
    setAction(f1, Action.Idle);
    return;
  }
  const att = w0 ? f0 : w1 ? f1 : null;
  if (!att) return;
  const vic = att === f0 ? f1 : f0;
  att.throwBack = (w0 || w1) === 2 ? 1 : 0;
  att.velX = 0;
  setAction(att, Action.Grab);
  vic.velX = 0;
  vic.velY = 0;
  vic.moveIdx = -1;
  vic.techLeft = TUNING.throwTechWindow;
  setAction(vic, Action.Thrown);
};

const resolveGrabs = (s: GameState): void => {
  for (const i of [0, 1] as const) {
    const att = s.fighters[i];
    if (att.action !== Action.Grab) continue;
    const vic = s.fighters[1 - i]!;
    const ch = characters[i];
    if (vic.techLeft === -1) {
      // Teched: break apart, no damage.
      vic.techLeft = 0;
      att.velX = -att.facing * fp(7);
      vic.velX = -vic.facing * fp(7);
      setAction(att, Action.Idle);
      setAction(vic, Action.Idle);
      continue;
    }
    if (att.actionFrame >= TUNING.grabTicks) {
      // Throw connects: damage + untechable toss.
      const dir = att.throwBack ? -att.facing : att.facing;
      vic.techLeft = 0;
      vic.comboHits = 1;
      vic.comboScaling = Math.max(
        Math.trunc((TUNING.scalingStart * TUNING.scalingMult) / 1000), TUNING.scalingFloor);
      vic.juggleBudget = TUNING.juggleBudget;
      vic.health = Math.max(0, vic.health - ch.b.throwDamage);
      vic.velX = dir * fp(ch.b.throwTossVelX);
      vic.velY = fp(ch.b.throwTossVelY);
      vic.hitstunLeft = 60;
      vic.knockdownOnLand = 1;
      setAction(vic, vic.health <= 0 ? Action.KO : Action.AirHitstun);
      vic.meter = clamp(vic.meter + Math.trunc(ch.b.throwDamage / TUNING.victimMeterDivisor), 0, TUNING.meterMax);
      setAction(att, Action.Idle);
    }
  }
};

// ---------------------------------------------------------------------------
// The tick
// ---------------------------------------------------------------------------

/**
 * Advance the simulation exactly one tick. Mutates `s` in place.
 * This is the ONLY way state changes. Deterministic by construction.
 */
export const step = (s: GameState, inputs: [InputFrame, InputFrame]): void => {
  s.tick++;
  const [f0, f1] = s.fighters;
  const [c0, c1] = characters;

  // Inputs are gathered every tick — even frozen ones — so buffered motions
  // survive hitstop and super flash.
  const io0 = gatherInputs(f0, inputs[0]);
  const io1 = gatherInputs(f1, inputs[1]);

  if (s.phase === Phase.MatchOver) return;

  if (s.phase === Phase.PreRound) {
    if (--s.phaseTimer <= 0) s.phase = Phase.Fighting;
    autoFace(f0, f1);
    return;
  }

  if (s.phase === Phase.RoundOver) {
    // Bodies settle (KO'd fighters fall) but nobody acts.
    settlePhysics(f0, c0);
    settlePhysics(f1, c1);
    if (--s.phaseTimer <= 0) {
      if (s.roundsWon0 >= TUNING.roundsToWin || s.roundsWon1 >= TUNING.roundsToWin) {
        s.phase = Phase.MatchOver;
        s.winner = s.roundsWon0 >= TUNING.roundsToWin && s.roundsWon1 >= TUNING.roundsToWin ? 2
          : s.roundsWon0 >= TUNING.roundsToWin ? 0 : 1;
      } else {
        resetRound(s);
      }
    }
    return;
  }

  // --- Fighting ---
  if (s.superFlashLeft > 0) {
    s.superFlashLeft--;
    return;
  }
  if (s.hitstopLeft > 0) {
    s.hitstopLeft--;
    return;
  }

  autoFace(f0, f1);

  // Item buffs (ADR 0007) burn only during live fighting — pre-round,
  // round-over, hitstop and super flash all return before this line.
  if (f0.itemBuffLeft > 0) f0.itemBuffLeft--;
  if (f1.itemBuffLeft > 0) f1.itemBuffLeft--;

  updateFighter(s, f0, f1, c0, io0);
  updateFighter(s, f1, f0, c1, io1);

  resolveThrows(s);
  resolveGrabs(s);

  // Body push: fighters cannot fully overlap.
  bodyPush(f0, f1, c0, c1);

  // Projectile spawn (a move entering its first active step) + travel.
  for (const [i, f, ch] of [[0, f0, c0], [1, f1, c1]] as const) {
    const move = currentMove(f, ch);
    if (move?.projectile) {
      const si = stepIndexAt(move, f.actionFrame);
      if (si === ch.firstActiveStep[f.moveIdx] && stepStartFrame(move, si) === f.actionFrame) {
        spawnProjectile(s, i, f, f.moveIdx);
      }
    }
  }
  updateProjectiles(s);

  // Melee hit detection — symmetric, trades allowed. Boxes post-movement.
  const hitPlan: { src: StrikeSource; vic: FighterState; hb: HitboxDef; stepIdx: number }[] = [];
  for (const [f, other, ch, otherCh] of [[f0, f1, c0, c1], [f1, f0, c1, c0]] as const) {
    const move = currentMove(f, ch);
    if (!move) continue;
    const si = stepIndexAt(move, f.actionFrame);
    if (si < 0 || si <= f.hitConsumedStep) continue;
    const st = move.steps[si]!;
    if (!st.hitboxes) continue;
    const vicBoxes = hurtboxesOf(other, otherCh);
    outer:
    for (const hb of st.hitboxes) {
      const hbw = worldRect(f.x, f.y, f.facing, hb.rect);
      for (const vb of vicBoxes) {
        if (overlaps(hbw, worldRect(other.x, other.y, other.facing, vb))) {
          hitPlan.push({ src: { facing: f.facing, x: f.x, attacker: f, buff: f, move }, vic: other, hb, stepIdx: si });
          break outer;
        }
      }
    }
  }
  for (const plan of hitPlan) {
    const result = strike(s, plan.src, plan.vic, plan.hb);
    if (result !== 0) {
      plan.src.attacker!.hitConsumedStep = plan.stepIdx;
      plan.src.attacker!.attackConnected = result;
    }
  }

  // Projectile hits.
  for (const p of s.projectiles) {
    if (!p.active || p.hasHit) continue;
    const vic = s.fighters[(1 - p.owner) as 0 | 1];
    const vicCh = characters[(1 - p.owner) as 0 | 1];
    const move = characters[p.owner as 0 | 1].b.moves[p.moveIdx]!;
    const pd = move.projectile!;
    const rectW = projectileRect(p);
    for (const vb of hurtboxesOf(vic, vicCh)) {
      if (overlaps(rectW, worldRect(vic.x, vic.y, vic.facing, vb))) {
        const owner = s.fighters[p.owner as 0 | 1];
        const result = strike(s, { facing: p.velX >= 0 ? 1 : -1, x: p.x, attacker: null, buff: owner, move }, vic, pd.hit);
        if (result !== 0) {
          p.hasHit = 1;
          p.active = 0;
          owner.meter = clamp(
            owner.meter + (result === 1 ? move.meterGainHit : move.meterGainHit >> 1), 0, TUNING.meterMax);
        }
        break;
      }
    }
  }

  // Round end: KO or timeout.
  s.timerTicks--;
  const dead0 = f0.health <= 0;
  const dead1 = f1.health <= 0;
  if (dead0 || dead1) {
    endRound(s, dead0 && dead1 ? 2 : dead0 ? 1 : 0);
  } else if (s.timerTicks <= 0) {
    endRound(s, f0.health === f1.health ? 2 : f0.health > f1.health ? 0 : 1);
  }
};

const stepStartFrame = (move: MoveDef, stepIdx: number): number => {
  let acc = 0;
  for (let i = 0; i < stepIdx; i++) acc += move.steps[i]!.frames;
  return acc;
};

const autoFace = (f0: FighterState, f1: FighterState): void => {
  for (const [me, other] of [[f0, f1], [f1, f0]] as const) {
    const a = me.action;
    if ((a === Action.Idle || a === Action.WalkF || a === Action.WalkB || a === Action.Crouch)
      && grounded(me)) {
      const newFacing: 1 | -1 = other.x >= me.x ? 1 : -1;
      if (newFacing !== me.facing) {
        me.facing = newFacing;
        // Walk direction semantics flip with facing; recompute next tick.
        if (a === Action.WalkF || a === Action.WalkB) setAction(me, Action.Idle);
      }
    }
  }
};

const bodyPush = (
  f0: FighterState, f1: FighterState,
  c0: LoadedCharacter, c1: LoadedCharacter,
): void => {
  const noBody = (f: FighterState): boolean =>
    f.action === Action.KO || f.action === Action.Knockdown
    || f.action === Action.Getup || f.action === Action.Thrown;
  if (noBody(f0) || noBody(f1)) return;
  const halfBodies = fp((c0.b.bodyWidth + c1.b.bodyWidth) / 2);
  const dx = f1.x - f0.x;
  const absDx = dx < 0 ? -dx : dx;
  if (absDx < halfBodies && Math.abs(fpToPx(f0.y - f1.y)) < 100) {
    const pushAmt = Math.trunc((halfBodies - absDx) / 2);
    const sign = dx === 0 ? (f0.facing as number) : dx > 0 ? 1 : -1;
    f0.x = clamp(f0.x - sign * pushAmt, WALL_L, WALL_R);
    f1.x = clamp(f1.x + sign * pushAmt, WALL_L, WALL_R);
  }
};

/** RoundOver physics: falling bodies land, sliders stop. */
const settlePhysics = (f: FighterState, ch: LoadedCharacter): void => {
  if (!grounded(f) || f.velY < 0) f.velY += fp(ch.b.gravity);
  f.x += f.velX;
  f.y += f.velY;
  if (f.y >= FLOOR && f.velY >= 0) {
    f.y = FLOOR;
    f.velY = 0;
    if (f.action === Action.AirHitstun) setAction(f, Action.Knockdown);
  }
  f.x = clamp(f.x, WALL_L, WALL_R);
  if (grounded(f)) {
    if (f.velX > 0) f.velX = Math.max(0, f.velX - FRICTION);
    else if (f.velX < 0) f.velX = Math.min(0, f.velX + FRICTION);
  }
};

const endRound = (s: GameState, winner: number): void => {
  s.roundWinner = winner;
  if (winner === 0 || winner === 2) s.roundsWon0++;
  if (winner === 1 || winner === 2) s.roundsWon1++;
  s.phase = Phase.RoundOver;
  s.phaseTimer = TUNING.roundOverTicks;
};

// ---------------------------------------------------------------------------
// Debug / render helpers (read-only views; the client owns zero game logic)
// ---------------------------------------------------------------------------

export interface DebugBox { x: number; y: number; w: number; h: number }

export const debugBoxes = (s: GameState): {
  hurtboxes: DebugBox[]; hitboxes: DebugBox[];
}[] => {
  const toPx = (r: WorldRect): DebugBox => ({
    x: fpToPx(r.l), y: fpToPx(r.t), w: fpToPx(r.r - r.l), h: fpToPx(r.b - r.t),
  });
  return s.fighters.map((f, i) => {
    const ch = characters[i as 0 | 1];
    const hurtboxes = hurtboxesOf(f, ch).map((r) => toPx(worldRect(f.x, f.y, f.facing, r)));
    const hitboxes: DebugBox[] = [];
    const move = currentMove(f, ch);
    if (move) {
      const si = stepIndexAt(move, f.actionFrame);
      if (si >= 0 && si > f.hitConsumedStep) {
        for (const hb of move.steps[si]!.hitboxes ?? []) {
          hitboxes.push(toPx(worldRect(f.x, f.y, f.facing, hb.rect)));
        }
      }
    }
    return { hurtboxes, hitboxes };
  });
};

export interface DebugFighterInfo {
  action: number;
  moveId: string;
  moveFrame: number;
  phase: string;
  meter: number;
  comboHitsTaken: number;
  juggleBudget: number;
  lastMotion: number;
}

export const debugInfo = (s: GameState): DebugFighterInfo[] =>
  s.fighters.map((f, i) => {
    const ch = characters[i as 0 | 1];
    const move = currentMove(f, ch);
    const si = move ? stepIndexAt(move, f.actionFrame) : -1;
    return {
      action: f.action,
      moveId: move?.id ?? '',
      moveFrame: f.actionFrame,
      phase: move && si >= 0 ? move.steps[si]!.phase : '',
      meter: f.meter,
      comboHitsTaken: f.comboHits,
      juggleBudget: f.juggleBudget,
      lastMotion: f.bufMotion,
    };
  });
