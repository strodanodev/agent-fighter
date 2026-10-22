/**
 * MATCH STATS (settlement v4) — the per-match competitive line a litnode
 * witness recomputes by replaying the signed input log.
 *
 * The counters live in FighterState (stKos … stTouched, af-core-9), so they
 * are in serialize() and every replay reproduces them bit-exactly. This file
 * only NAMES them: the litnode adapter's `stats(state, participants)` is
 * `matchStats(state)` keyed by participant, and its manifest's
 * `services.stats.schema` is STATS_SCHEMA. Keeping the names, the ops and the
 * field mapping here, beside the engine, means a stat cannot drift from its
 * counter — and any change to either is a new engine bundle, hence a new
 * buildHash (docs/SETTLEMENT-STANDARD.md §13).
 *
 * Rules the node enforces (protocol/stats.js): names match
 * /^[a-zA-Z][a-zA-Z0-9]{0,31}$/, never `matches` / `wins` / `ticks`, values
 * are non-negative safe integers, and a missing value is skipped by `min`.
 */
import type { GameState } from './state.js';

export type StatOp = 'sum' | 'max' | 'min' | 'last';

/** How a player's season folds each per-match stat. */
export const STATS_SCHEMA = {
  kos: 'sum', // rounds won by KO
  roundsWon: 'sum', // rounds won (a drawn round counts for both, as in scoring)
  perfectRounds: 'sum', // rounds won outright without taking damage
  damageDealt: 'sum', // health removed from the opponent: hits, chip, throws
  maxCombo: 'max', // longest combo landed, in hits
  supersLanded: 'sum', // supers that landed a clean hit
  throwTechs: 'sum', // throws escaped with a tech
  fastestKo: 'min', // fewest round-clock ticks (60/s) to a KO; absent if none
} as const satisfies Record<string, StatOp>;

export type StatName = keyof typeof STATS_SCHEMA;
export type StatLine = Partial<Record<StatName, number>>;

/**
 * Both sides' stat lines, in side order, from any state (normally the final
 * one). Integers only, straight off serialized fields; `fastestKo` is left
 * out for a side that never KO'd, so a season `min` skips the match.
 */
export const matchStats = (s: GameState): [StatLine, StatLine] => {
  const line = (i: 0 | 1): StatLine => {
    const f = s.fighters[i];
    const out: StatLine = {
      kos: f.stKos,
      roundsWon: i === 0 ? s.roundsWon0 : s.roundsWon1,
      perfectRounds: f.stPerfects,
      damageDealt: f.stDamage,
      maxCombo: f.stMaxCombo,
      supersLanded: f.stSupers,
      throwTechs: f.stTechs,
    };
    if (f.stFastestKo > 0) out.fastestKo = f.stFastestKo;
    return out;
  };
  return [line(0), line(1)];
};
