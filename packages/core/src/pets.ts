/**
 * PETS — companions with rolled AURAS (ADR 0011). Pure DATA, exactly like
 * characters (ADR 0002) and drinks (ADR 0007): a small effect vocabulary the
 * engine interprets, never per-pet code.
 *
 * What lives here: the aura vocabulary, its legal ranges, the rarity table
 * and the pure helpers that read an aura. What does NOT live here:
 *
 *   · the pet CATALOG — pets are asset folders on disk (`pets/<id>/pet.json`,
 *     authored by the Studio, read by the match server), not a registry in
 *     this file. Adding a pet must never require a core change;
 *   · the ROLL — the server rolls which pet and which aura values at PURCHASE
 *     time, so by the time a match starts an aura is a fixed, known set of
 *     integers. This file must stay free of randomness (guards.test.ts bans
 *     Math.random in core) and free of sim imports.
 *
 * Everything is per-mille integers. No floats go anywhere near the sim.
 */

/** The five aura lines. Order is protocol: it indexes AURA_LINES. */
export type PetAuraKind = 'atk' | 'def' | 'hpRegen' | 'crit' | 'energyRegen';

/**
 * A rolled aura. Every line is per-mille and every line may be 0 (this pet
 * did not roll it). A whole-zero aura is legal and means "cosmetic only".
 */
export interface PetAura {
  /** Bonus damage DEALT, per-mille (80 = +8%). */
  atk: number;
  /** Damage TAKEN reduction, per-mille. */
  def: number;
  /** Health restored per PET_REGEN_PERIOD_TICKS, per-mille of maxHealth. */
  hpRegen: number;
  /** Chance a clean hit crits, per-mille (80 = 8%). */
  crit: number;
  /** Meter gained per PET_REGEN_PERIOD_TICKS, per-mille of TUNING.meterMax. */
  energyRegen: number;
}

export type PetRarity = 1 | 2 | 3;

/** How a pet moves with its fighter. Render-time only; see PetDef.motion. */
export type PetMotion = 'float' | 'ground';

export const PET_MOTIONS: readonly PetMotion[] = ['float', 'ground'];

/** A pet as the Studio authors it into `pets/<id>/pet.json`. */
export interface PetDef {
  id: string;
  name: string;
  /** UI copy, ALL CAPS by convention. */
  desc: string;
  flavor: string;
  /**
   * Render size in world px (height); the sprite keeps its own aspect.
   * Cosmetic only — the sim never reads it.
   */
  sizePx?: number;
  /**
   * Accent colour (#rrggbb). Drives the aura glow, and IS the pet when
   * `sprites` is empty — the client draws a procedural companion in this
   * colour rather than nothing, so a pet.json authored ahead of its art is
   * still playable. Cosmetic only.
   */
  tint?: string;
  /**
   * How the companion carries itself. Cosmetic — it changes where the
   * renderer puts the pet, never anything the sim reads.
   *
   * 'float'  — hovers at shoulder height behind the fighter, bobbing, and
   *            rises with them on a jump (a drone, a moth, a wisp).
   * 'ground' — walks the stage floor behind the fighter and STAYS there when
   *            they jump, with a trot bounce while they move (a pup, a crab,
   *            anything with feet).
   *
   * Default 'float' — the pre-existing behaviour, so an unauthored pet is
   * unchanged.
   */
  motion?: PetMotion;
  /**
   * Sprite file names inside `pets/<id>/`, played as a loop at `fps`.
   * Written by the Studio. Empty/absent = procedural.
   */
  sprites?: string[];
  fps?: number;
  /** Authored by the Studio; excluded from the aura roll when true. */
  disabled?: boolean;
}

// --------------------------------------------------------------------------
// Aura ranges and rarity
// --------------------------------------------------------------------------

/** Aura line order — protocol for anything that serializes an aura compactly. */
export const AURA_LINES: readonly PetAuraKind[] = [
  'atk', 'def', 'hpRegen', 'crit', 'energyRegen',
];

/** Human labels + a one-liner, for the profile page and the VS card. */
export const AURA_LABELS: Readonly<Record<PetAuraKind, string>> = {
  atk: 'ATK DAMAGE',
  def: 'DEFENSE',
  hpRegen: 'HP REGEN',
  crit: 'CRITICAL',
  energyRegen: 'ENERGY REGEN',
};

/**
 * The ADR 0011 "subtle" band: one line rolls in [10, 80] per-mille — 1% to
 * 8%. The floor exists so a rolled line is never a disappointment; the cap is
 * what keeps a pet a nudge instead of a build.
 */
export const AURA_MIN = 10;
export const AURA_MAX = 80;

/**
 * Rarity decides HOW MANY lines a pet rolls, not how big they are — a common
 * pet can out-roll a legendary on its single line. Odds mirror the drink
 * gacha (ADR 0007).
 */
export const PET_RARITY_ODDS: readonly { rarity: PetRarity; pct: number }[] = [
  { rarity: 1, pct: 70 },
  { rarity: 2, pct: 25 },
  { rarity: 3, pct: 5 },
];

/** Lines rolled per rarity (index by rarity; 0 unused). */
export const AURA_LINES_BY_RARITY = [0, 1, 2, 3] as const;

/** UI accent per rarity (index by rarity; 0 unused). Matches ITEM_TIER_COLORS. */
export const PET_RARITY_COLORS = ['', '#cfd8e3', '#6fd3ff', '#ffd166'] as const;
export const PET_RARITY_LABELS = ['', 'COMMON', 'RARE', 'LEGENDARY'] as const;

/** Price of one adoption, in credits (mirrored in the pets migration docs). */
export const PET_COST = 25;

// --------------------------------------------------------------------------
// Sim-facing constants
// --------------------------------------------------------------------------

/**
 * Regen period, in ticks. Both regen lines pay out `amount` per-mille of the
 * relevant maximum ONCE per period, spread evenly across it (the sim keeps an
 * integer accumulator rather than dividing, so nothing rounds away).
 *
 * 3600 ticks = 60 seconds. At the 8% cap that is 8% of a health bar per
 * minute — about 13% across a full 99-second round.
 */
export const PET_REGEN_PERIOD_TICKS = 3600;

/**
 * Extra damage on a critical hit, per-mille (+50%). Fixed, not rolled: the
 * aura rolls how OFTEN you crit, never how hard.
 */
export const PET_CRIT_BONUS = 500;

/** Ticks the renderer is told to flash a crit for (cosmetic; state-driven). */
export const PET_CRIT_FLASH_TICKS = 24;

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

export const NO_AURA: Readonly<PetAura> = Object.freeze({
  atk: 0, def: 0, hpRegen: 0, crit: 0, energyRegen: 0,
});

const clampLine = (v: unknown): number => {
  const n = Math.trunc(Number(v) || 0);
  return n <= 0 ? 0 : n > AURA_MAX ? AURA_MAX : n;
};

/**
 * Bound an aura at the boundary (the 2026-07-18 audit lesson). Anything that
 * arrives from the network, the database or a JSON file goes through this
 * before it can reach a fighter: a hostile pin cannot mint a 10× aura, and a
 * missing line reads as 0 rather than NaN.
 */
export const clampAura = (a: Partial<PetAura> | null | undefined): PetAura => ({
  atk: clampLine(a?.atk),
  def: clampLine(a?.def),
  hpRegen: clampLine(a?.hpRegen),
  crit: clampLine(a?.crit),
  energyRegen: clampLine(a?.energyRegen),
});

/** True when an aura would do nothing at all (all five lines zero). */
export const auraIsEmpty = (a: PetAura): boolean =>
  a.atk === 0 && a.def === 0 && a.hpRegen === 0
  && a.crit === 0 && a.energyRegen === 0;

/** The non-zero lines, in AURA_LINES order — what the UI actually lists. */
export const auraLines = (a: PetAura): { kind: PetAuraKind; amount: number }[] =>
  AURA_LINES
    .map((kind) => ({ kind, amount: a[kind] }))
    .filter((l) => l.amount > 0);

/** "+4.5% ATK DAMAGE" — one line as display copy. */
export const auraLineText = (kind: PetAuraKind, amount: number): string =>
  `+${(amount / 10).toFixed(1).replace(/\.0$/, '')}% ${AURA_LABELS[kind]}`;
