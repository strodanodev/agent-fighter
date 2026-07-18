/**
 * CONSUMABLE ITEMS — "energy drinks" (ADR 0007). Pure DATA, exactly like
 * characters: a small effect vocabulary the engine interprets, never
 * per-item code.
 *
 * Phase 1 (shop/gacha/inventory) ships without the sim reading this module
 * at all — so no ENGINE_VERSION bump and the golden replays stay green.
 * Phase 2 will interpret `effect` inside step() via a loadout pinned into
 * match setup (the ADR 0006 `solo.personality` pattern).
 *
 * Determinism contract: the GACHA ROLL IS SERVER-SIDE, at purchase time —
 * by the time a match starts an item is a fixed, known effect. This file
 * must stay free of randomness (guards.test.ts bans Math.random in core)
 * and of sim imports.
 */

export type ItemEffectKind = 'heal' | 'damageMult' | 'defenseMult' | 'meterGain';
export type ItemTier = 1 | 2 | 3;

export interface ItemEffect {
  kind: ItemEffectKind;
  /**
   * heal: per-mille of maxHealth restored (instant).
   * damageMult / defenseMult: per-mille bonus (dealt / damage-taken
   * reduction) while the buff runs.
   * meterGain: raw meter units (TUNING.meterMax 3000 = 3 bars), instant.
   */
  amount: number;
  /** Buff lifetime in ticks (60/sec). 0 = instant effect. */
  durationTicks: number;
}

export interface ItemDef {
  id: string;
  name: string;
  tier: ItemTier;
  effect: ItemEffect;
  /** One-line shop/inventory description (UI copy, ALL CAPS by convention). */
  desc: string;
  flavor: string;
}

/** Price of one vending-machine pull, in credits (mirrored in 0013_items.sql docs). */
export const ITEM_COST = 5;

/** Gacha tier odds, percent — consumed by the SERVER's roll, never the sim. */
export const ITEM_TIER_ODDS: readonly { tier: ItemTier; pct: number }[] = [
  { tier: 1, pct: 70 },
  { tier: 2, pct: 25 },
  { tier: 3, pct: 5 },
];

/** UI accent per tier (index by tier; 0 unused). */
export const ITEM_TIER_COLORS = ['', '#cfd8e3', '#6fd3ff', '#ffd166'] as const;
export const ITEM_TIER_LABELS = ['', 'LV 1', 'LV 2', 'LV 3'] as const;

/**
 * The drink registry: 4 effect lines × 3 tiers. Amounts are data, not
 * balance gospel — they will be tuned like TUNING once Phase 2 makes them
 * matter in a match.
 */
export const ITEMS: readonly ItemDef[] = [
  // PATCH — instant heal.
  { id: 'patch1', name: 'PATCH COLA', tier: 1,
    effect: { kind: 'heal', amount: 100, durationTicks: 0 },
    desc: 'RESTORE 10% HEALTH', flavor: 'Tastes like battery acid. Works.' },
  { id: 'patch2', name: 'PATCH COLA ZERO', tier: 2,
    effect: { kind: 'heal', amount: 200, durationTicks: 0 },
    desc: 'RESTORE 20% HEALTH', flavor: 'Now with 0% downtime.' },
  { id: 'patch3', name: 'PATCH OMEGA', tier: 3,
    effect: { kind: 'heal', amount: 350, durationTicks: 0 },
    desc: 'RESTORE 35% HEALTH', flavor: 'Factory-reset for your ribs.' },
  // OVERCLOCK — damage up ("crit" reframed as a flat bonus; ADR 0007).
  { id: 'over1', name: 'OVERCLOCK LITE', tier: 1,
    effect: { kind: 'damageMult', amount: 100, durationTicks: 600 },
    desc: '+10% DAMAGE · 10s', flavor: 'Warranty void where prohibited.' },
  { id: 'over2', name: 'OVERCLOCK', tier: 2,
    effect: { kind: 'damageMult', amount: 150, durationTicks: 900 },
    desc: '+15% DAMAGE · 15s', flavor: 'Fan noise sold separately.' },
  { id: 'over3', name: 'OVERCLOCK REDLINE', tier: 3,
    effect: { kind: 'damageMult', amount: 250, durationTicks: 900 },
    desc: '+25% DAMAGE · 15s', flavor: 'Thermal limits are a mindset.' },
  // FIREWALL — defense up (damage-taken reduction).
  { id: 'wall1', name: 'FIREWALL FIZZ', tier: 1,
    effect: { kind: 'defenseMult', amount: 100, durationTicks: 600 },
    desc: '-10% DAMAGE TAKEN · 10s', flavor: 'Blocks most packets. And fists.' },
  { id: 'wall2', name: 'FIREWALL PRO', tier: 2,
    effect: { kind: 'defenseMult', amount: 150, durationTicks: 900 },
    desc: '-15% DAMAGE TAKEN · 15s', flavor: 'Enterprise-grade shins.' },
  { id: 'wall3', name: 'FIREWALL TITANIUM', tier: 3,
    effect: { kind: 'defenseMult', amount: 250, durationTicks: 900 },
    desc: '-25% DAMAGE TAKEN · 15s', flavor: 'Deny all. Feel nothing.' },
  // VOLT — instant meter.
  { id: 'volt1', name: 'VOLT SODA', tier: 1,
    effect: { kind: 'meterGain', amount: 500, durationTicks: 0 },
    desc: '+½ SUPER BAR', flavor: 'Lightly carbonated lightning.' },
  { id: 'volt2', name: 'VOLT SURGE', tier: 2,
    effect: { kind: 'meterGain', amount: 1000, durationTicks: 0 },
    desc: '+1 SUPER BAR', flavor: 'Grid-certified. Mostly.' },
  { id: 'volt3', name: 'VOLT MAXIMUM', tier: 3,
    effect: { kind: 'meterGain', amount: 1500, durationTicks: 0 },
    desc: '+1½ SUPER BARS', flavor: 'Do not drink near capacitors.' },
];

export const itemById = (id: string): ItemDef | undefined =>
  ITEMS.find((i) => i.id === id);
