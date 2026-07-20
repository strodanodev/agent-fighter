import { fp, fpToPx } from './fp.js';
import { ROUND_SECONDS, STAGE, TICKS_PER_SEC, TUNING, loadCharacter } from './data.js';
import type { LoadedCharacter } from './data.js';
import type { ItemEffect } from './items.js';
import { HIST_LEN } from './motion.js';
import { ANALOG } from './characters/analog.js';

export const enum Action {
  Idle = 0,
  WalkF = 1,
  WalkB = 2,
  Crouch = 3,
  JumpSquat = 4,
  Air = 5,
  DashF = 6,
  DashB = 7,
  AirDash = 8,
  Attack = 9,
  Hitstun = 10,
  AirHitstun = 11,
  BlockStand = 12,
  BlockCrouch = 13,
  BlockAir = 14,
  Knockdown = 15,
  Getup = 16,
  Grab = 17, // throw attacker, holding the victim
  Thrown = 18, // throw victim, tech window running
  KO = 19,
}

export const enum Phase {
  PreRound = 0,
  Fighting = 1,
  RoundOver = 2,
  MatchOver = 3,
}

export interface FighterState {
  x: number; // fixed-point world px (feet center)
  y: number; // fixed-point world px (feet); floor = fp(STAGE.floorYPx)
  velX: number;
  velY: number;
  facing: 1 | -1;
  health: number;
  meter: number;
  action: Action;
  actionFrame: number;
  moveIdx: number; // current move index into character move table, -1 none
  attackConnected: number; // 0 none, 1 hit, 2 block (latest contact)
  hitConsumedStep: number; // step index whose hitboxes already landed (-1)
  hitstunLeft: number;
  blockstunLeft: number;
  knockdownOnLand: number; // 0/1 — falling into untechable knockdown
  jumpsLeft: number; // double jumps remaining
  airdashLeft: number;
  superJumped: number; // 0/1 — current airtime came from a super jump
  airLocked: number; // 0/1 — no air actions until landing (post-special)
  juggleBudget: number; // defender-side juggle points left in current combo
  comboHits: number; // hits received in current combo (defender-side)
  comboScaling: number; // per-mille damage scale for the NEXT hit received
  bufMotion: number; // buffered motion at last button press (0/236/214/623)
  bufButtons: number; // buffered attack-button mask
  bufLeft: number; // ticks the buffer stays alive
  tapDir: number; // last pure L/R tap dir for dash double-tap (-1/0/1)
  tapTimer: number;
  dashBuf: number; // pending dash dir from double-tap (-1/0/1)
  dashBufLeft: number;
  pushblocked: number; // 0/1 — already pushblocked during this blockstun
  techLeft: number; // Thrown: ticks left to tech (-1 = teched)
  throwBack: number; // Grab: 0 forward throw, 1 back throw
  launchJC: number; // ticks left in launcher jump-cancel window (attacker)
  wantThrow: number; // within-tick throw intent: 0/1 fwd/2 back (cleared each tick)
  histIdx: number;
  prevInput: number;
  // CONSUMABLES (ADR 0007) — up to THREE energy drinks are CARRIED into the
  // match and DRUNK on demand (Btn.Item/Item2/Item3, one bit per slot).
  // Carried slots are match-scoped (survive round resets, like meter);
  // pressing a slot's bit spends it (kind → 0) and either heals / grants
  // meter instantly or arms a timed buff. Damage and defense buffs have
  // INDEPENDENT timers so an OVERCLOCK and a FIREWALL can run together;
  // re-drinking the same kind refreshes (never stacks). All zero when no
  // drink is carried, so an item-less match is bit-identical to pre-item
  // builds. (Flat scalars, not arrays — serialize()/FIGHTER_FIELDS is a
  // flat-number protocol.)
  itemKind0: number; // slot 0: 0 none/spent, 1 heal, 2 dmg, 3 def, 4 meter
  itemAmount0: number;
  itemDur0: number;
  itemKind1: number; // slot 1
  itemAmount1: number;
  itemDur1: number;
  itemKind2: number; // slot 2
  itemAmount2: number;
  itemDur2: number;
  itemDmg: number; // ACTIVE: per-mille damage bonus while itemDmgLeft > 0
  itemDmgLeft: number;
  itemDef: number; // ACTIVE: per-mille damage-taken reduction while itemDefLeft > 0
  itemDefLeft: number;
  dirHist: number[]; // ring buffer of numpad dirs, length HIST_LEN
}

export interface ProjectileState {
  active: number;
  owner: number; // fighter index
  moveIdx: number; // owner's move that spawned it (for hit data lookup)
  x: number; // fixed-point center
  y: number;
  velX: number; // fixed-point
  life: number;
  hasHit: number;
}

export const PROJECTILE_SLOTS = 4;

export interface GameState {
  tick: number;
  rngSeed: number;
  phase: Phase;
  winner: number; // match: -1 none, 0/1 player, 2 draw
  roundWinner: number; // last round: -1/0/1/2
  roundsWon0: number;
  roundsWon1: number;
  roundNum: number;
  timerTicks: number;
  phaseTimer: number; // PreRound / RoundOver countdown
  hitstopLeft: number; // global freeze frames (the crunch)
  superFlashLeft: number; // super cinematic freeze
  // Per-match playfield walls (fixed-point world px), set once at match start
  // from the stage's bounds (server-authoritative). Constant for the match, but
  // they live in state — and in serialize() — because the sim clamps fighters to
  // them, so rollback/verification must agree on them. Default (no stage bounds)
  // is fp(wallPad)..fp(widthPx-wallPad), identical to the old module constants.
  wallL: number;
  wallR: number;
  fighters: [FighterState, FighterState];
  projectiles: ProjectileState[]; // fixed PROJECTILE_SLOTS length
}

/** M1: both players run the Analog bundle. Later: per-match selection. */
export const characters: [LoadedCharacter, LoadedCharacter] = [
  loadCharacter(ANALOG),
  loadCharacter(ANALOG),
];

/**
 * Swap the active character bundles (Studio live preview; later, match
 * setup). Must be called between matches, never mid-sim — the loaded
 * character is part of the deterministic contract, so both netplay peers
 * must install identical bundles (hash-checked at match setup, spec §3.1).
 */
export const setCharacters = (c0: LoadedCharacter, c1: LoadedCharacter): void => {
  characters[0] = c0;
  characters[1] = c1;
};

/**
 * CONSUMABLES (ADR 0007): the per-side drink LOADOUT (up to 3) carried into
 * the next match. Same contract as setCharacters — install between matches,
 * never mid-sim, identical on every simulating peer (client, server
 * verifier, rollback re-sim). The pinned effects come from SMatch and are
 * loaded into each fighter's carried slots at spawn, drunk on the matching
 * Btn.Item/Item2/Item3 press. `[[], []]` (the default) is the pre-item
 * behavior.
 *
 * Values are CLAMPED here (audit lesson: bound data at the boundary) — a
 * hostile pin can't mint a 10× damage drink, an hour-long buff, or a
 * 4-slot loadout.
 */
export const ITEM_SLOTS = 3;

const matchItems: [ItemEffect[], ItemEffect[]] = [[], []];

export const setMatchItems = (i0: ItemEffect[] | null, i1: ItemEffect[] | null): void => {
  const clampSide = (side: ItemEffect[] | null): ItemEffect[] =>
    (side ?? []).slice(0, ITEM_SLOTS).map((e) => ({
      kind: e.kind,
      amount: Math.max(0, Math.min(500, Math.trunc(e.amount))),
      durationTicks: Math.max(0, Math.min(7200, Math.trunc(e.durationTicks))),
    }));
  matchItems[0] = clampSide(i0);
  matchItems[1] = clampSide(i1);
};

/** Effect kind → the small integer stored in FighterState.itemKindN (serialized). */
const ITEM_KIND_CODE: Record<ItemEffect['kind'], number> = {
  heal: 1, damageMult: 2, defenseMult: 3, meterGain: 4,
};

/** The carried trio for side `i`, slot `s` from the pinned loadout (0s = empty). */
const carriedItem = (i: 0 | 1, s: number): { kind: number; amount: number; dur: number } => {
  const e = matchItems[i][s];
  return e
    ? { kind: ITEM_KIND_CODE[e.kind], amount: e.amount, dur: e.durationTicks }
    : { kind: 0, amount: 0, dur: 0 };
};

const SPAWN_OFFSET = 180;

const spawnFighter = (
  x: number, facing: 1 | -1, ch: LoadedCharacter, _side: 0 | 1,
): FighterState => ({
  x: fp(x),
  y: fp(STAGE.floorYPx),
  velX: 0,
  velY: 0,
  facing,
  health: ch.b.maxHealth, // drinks are drunk mid-match now (Phase 3), not at spawn
  meter: 0,
  action: Action.Idle,
  actionFrame: 0,
  moveIdx: -1,
  attackConnected: 0,
  hitConsumedStep: -1,
  hitstunLeft: 0,
  blockstunLeft: 0,
  knockdownOnLand: 0,
  jumpsLeft: 0,
  airdashLeft: 0,
  superJumped: 0,
  airLocked: 0,
  juggleBudget: 0,
  comboHits: 0,
  comboScaling: TUNING.scalingStart,
  bufMotion: 0,
  bufButtons: 0,
  bufLeft: 0,
  tapDir: 0,
  tapTimer: 0,
  dashBuf: 0,
  dashBufLeft: 0,
  pushblocked: 0,
  techLeft: 0,
  throwBack: 0,
  launchJC: 0,
  wantThrow: 0,
  histIdx: 0,
  prevInput: 0,
  // Carried drinks + active buffs are set by the callers (match start loads
  // from the pinned loadout; round reset carries the slots over like meter).
  // Defaulting to empty here keeps spawnFighter side-effect-free.
  itemKind0: 0,
  itemAmount0: 0,
  itemDur0: 0,
  itemKind1: 0,
  itemAmount1: 0,
  itemDur1: 0,
  itemKind2: 0,
  itemAmount2: 0,
  itemDur2: 0,
  itemDmg: 0,
  itemDmgLeft: 0,
  itemDef: 0,
  itemDefLeft: 0,
  dirHist: new Array(HIST_LEN).fill(5),
});

const emptyProjectile = (): ProjectileState => ({
  active: 0, owner: 0, moveIdx: -1, x: 0, y: 0, velX: 0, life: 0, hasHit: 0,
});

/** Playfield bounds in world px (the region the camera + walls are locked to). */
export interface StageBounds { left: number; right: number }

/** Default bounds = the full stage width — bit-identical to the old constants. */
const DEFAULT_BOUNDS: StageBounds = { left: 0, right: STAGE.widthPx };

/** Fixed-point walls for a region, inset by wallPad (as the old WALL_L/R were). */
const wallLFp = (b: StageBounds): number => fp(b.left + STAGE.wallPad);
const wallRFp = (b: StageBounds): number => fp(b.right - STAGE.wallPad);

/** World-px spawn center of a region (both fighters spawn ±spawnOffset of it). */
const centerPx = (wallL: number, wallR: number): number =>
  fpToPx(Math.trunc((wallL + wallR) / 2));

/** Spawn ±offset, shrunk so a NARROW view-locked region can't spawn a fighter
 *  outside its own walls. Full-width stages keep the full SPAWN_OFFSET (the
 *  gap dwarfs it), so default play is unchanged. */
const spawnOffsetFor = (wallL: number, wallR: number): number => {
  const halfGap = fpToPx((wallR - wallL) / 2);
  return Math.max(0, Math.min(SPAWN_OFFSET, halfGap - 20));
};

export const createGameState = (
  seed: number,
  bounds: StageBounds = DEFAULT_BOUNDS,
): GameState => {
  const wallL = wallLFp(bounds);
  const wallR = wallRFp(bounds);
  const cx = centerPx(wallL, wallR);
  const off = spawnOffsetFor(wallL, wallR);
  return {
    tick: 0,
    rngSeed: seed | 0,
    phase: Phase.PreRound,
    winner: -1,
    roundWinner: -1,
    roundsWon0: 0,
    roundsWon1: 0,
    roundNum: 0,
    timerTicks: ROUND_SECONDS * TICKS_PER_SEC,
    phaseTimer: TUNING.preRoundTicks,
    hitstopLeft: 0,
    superFlashLeft: 0,
    wallL,
    wallR,
    fighters: [
      spawnItemFighter(0, cx, off),
      spawnItemFighter(1, cx, off),
    ],
    projectiles: Array.from({ length: PROJECTILE_SLOTS }, emptyProjectile),
  };
};

/** Spawn side `i` at match start, loading its carried drinks from the pin. */
const spawnItemFighter = (i: 0 | 1, cx: number, off: number): FighterState => {
  const f = spawnFighter(
    cx + (i === 0 ? -off : off),
    i === 0 ? 1 : -1,
    characters[i],
    i,
  );
  loadCarriedSlots(f, i);
  return f;
};

/** Fill a fresh fighter's carried slots from the pinned loadout. */
const loadCarriedSlots = (f: FighterState, i: 0 | 1): void => {
  const s0 = carriedItem(i, 0);
  const s1 = carriedItem(i, 1);
  const s2 = carriedItem(i, 2);
  f.itemKind0 = s0.kind; f.itemAmount0 = s0.amount; f.itemDur0 = s0.dur;
  f.itemKind1 = s1.kind; f.itemAmount1 = s1.amount; f.itemDur1 = s1.dur;
  f.itemKind2 = s2.kind; f.itemAmount2 = s2.amount; f.itemDur2 = s2.dur;
};

/** Between rounds: reset positions/health/actions; meter and score persist. */
export const resetRound = (s: GameState): void => {
  const cx = centerPx(s.wallL, s.wallR);
  const off = spawnOffsetFor(s.wallL, s.wallR);
  for (const i of [0, 1] as const) {
    const prev = s.fighters[i];
    const fresh = spawnFighter(
      cx + (i === 0 ? -off : off),
      i === 0 ? 1 : -1,
      characters[i],
      i,
    );
    fresh.meter = prev.meter; // meter persists across rounds
    // Carried drinks persist too — each can is per-MATCH, drink it any
    // round; a spent slot stays spent. The ACTIVE buffs do NOT carry
    // (a fresh round, fresh health/positions).
    fresh.itemKind0 = prev.itemKind0; fresh.itemAmount0 = prev.itemAmount0; fresh.itemDur0 = prev.itemDur0;
    fresh.itemKind1 = prev.itemKind1; fresh.itemAmount1 = prev.itemAmount1; fresh.itemDur1 = prev.itemDur1;
    fresh.itemKind2 = prev.itemKind2; fresh.itemAmount2 = prev.itemAmount2; fresh.itemDur2 = prev.itemDur2;
    s.fighters[i] = fresh as GameState['fighters'][0];
  }
  for (let i = 0; i < PROJECTILE_SLOTS; i++) s.projectiles[i] = emptyProjectile();
  s.timerTicks = ROUND_SECONDS * TICKS_PER_SEC;
  s.phase = Phase.PreRound;
  s.phaseTimer = TUNING.preRoundTicks;
  s.hitstopLeft = 0;
  s.superFlashLeft = 0;
  s.roundNum++;
};

/** Cheap deep copy — the whole state is flat numbers. Required for rollback. */
export const snapshot = (s: GameState): GameState => ({
  ...s,
  fighters: [
    { ...s.fighters[0], dirHist: s.fighters[0].dirHist.slice() },
    { ...s.fighters[1], dirHist: s.fighters[1].dirHist.slice() },
  ],
  projectiles: s.projectiles.map((p) => ({ ...p })),
});

export const restore = (dst: GameState, snap: GameState): void => {
  Object.assign(dst, snap, { fighters: dst.fighters, projectiles: dst.projectiles });
  for (const i of [0, 1] as const) {
    const keepHist = dst.fighters[i].dirHist;
    Object.assign(dst.fighters[i], snap.fighters[i], { dirHist: keepHist });
    for (let k = 0; k < HIST_LEN; k++) keepHist[k] = snap.fighters[i].dirHist[k]!;
  }
  for (let i = 0; i < PROJECTILE_SLOTS; i++) {
    Object.assign(dst.projectiles[i]!, snap.projectiles[i]!);
  }
};

const FIGHTER_FIELDS = [
  'x', 'y', 'velX', 'velY', 'facing', 'health', 'meter',
  'action', 'actionFrame', 'moveIdx', 'attackConnected', 'hitConsumedStep',
  'hitstunLeft', 'blockstunLeft', 'knockdownOnLand',
  'jumpsLeft', 'airdashLeft', 'superJumped', 'airLocked',
  'juggleBudget', 'comboHits', 'comboScaling',
  'bufMotion', 'bufButtons', 'bufLeft',
  'tapDir', 'tapTimer', 'dashBuf', 'dashBufLeft',
  'pushblocked', 'techLeft', 'throwBack', 'launchJC', 'wantThrow',
  'histIdx', 'prevInput',
  'itemKind0', 'itemAmount0', 'itemDur0',
  'itemKind1', 'itemAmount1', 'itemDur1',
  'itemKind2', 'itemAmount2', 'itemDur2',
  'itemDmg', 'itemDmgLeft', 'itemDef', 'itemDefLeft',
] as const;

const PROJECTILE_FIELDS = [
  'active', 'owner', 'moveIdx', 'x', 'y', 'velX', 'life', 'hasHit',
] as const;

const GLOBAL_FIELDS = [
  'tick', 'rngSeed', 'phase', 'winner', 'roundWinner',
  'roundsWon0', 'roundsWon1', 'roundNum',
  'timerTicks', 'phaseTimer', 'hitstopLeft', 'superFlashLeft',
  // Appended (protocol = field order): per-match walls. Constant during a match,
  // but serialized so a bounds mismatch surfaces as a desync hash divergence.
  'wallL', 'wallR',
] as const;

/** Deterministic flat serialization — field order is part of the protocol. */
export const serialize = (s: GameState): Int32Array => {
  const size = GLOBAL_FIELDS.length
    + (FIGHTER_FIELDS.length + HIST_LEN) * 2
    + PROJECTILE_FIELDS.length * PROJECTILE_SLOTS;
  const out = new Int32Array(size);
  let i = 0;
  for (const k of GLOBAL_FIELDS) out[i++] = s[k];
  for (const f of s.fighters) {
    for (const k of FIGHTER_FIELDS) out[i++] = f[k];
    for (let h = 0; h < HIST_LEN; h++) out[i++] = f.dirHist[h]!;
  }
  for (const p of s.projectiles) {
    for (const k of PROJECTILE_FIELDS) out[i++] = p[k];
  }
  return out;
};

/** FNV-1a over the serialized state. Used for desync detection + CI replay tests. */
export const stateHash = (s: GameState): number => {
  const data = serialize(s);
  let h = 0x811c9dc5;
  for (let i = 0; i < data.length; i++) {
    const v = data[i]!;
    h ^= v & 0xff;
    h = Math.imul(h, 0x01000193);
    h ^= (v >>> 8) & 0xff;
    h = Math.imul(h, 0x01000193);
    h ^= (v >>> 16) & 0xff;
    h = Math.imul(h, 0x01000193);
    h ^= (v >>> 24) & 0xff;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
};
