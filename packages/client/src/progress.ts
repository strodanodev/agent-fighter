/**
 * Player progression: XP → level, persisted in localStorage (server profiles
 * arrive with M5/Privy — this is deliberately client-local until then).
 *
 * The CPU's strength follows the player's level, adjusted by a LEVER the
 * player controls (±). One mapping, one knob:
 *
 *   cpuLevel = clamp(playerLevel + lever, 1, MAX_LEVEL)
 *   aiSkill  = cpuLevel · 100 / MAX_LEVEL          (the core AI's 0-100 lever)
 */

export const MAX_LEVEL = 40;

export interface Profile {
  xp: number;
  level: number;
  wins: number;
  losses: number;
}

export interface MatchStats {
  won: boolean;
  damageDealt: number;
  bestCombo: number;
}

const KEY = 'af-profile';
const LEVER_KEY = 'af-cpu-lever';

export const loadProfile = (): Profile => {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const p = JSON.parse(raw) as Profile;
      if (typeof p.xp === 'number' && typeof p.level === 'number') {
        return { xp: p.xp, level: Math.max(1, p.level), wins: p.wins | 0, losses: p.losses | 0 };
      }
    }
  } catch { /* fresh profile */ }
  return { xp: 0, level: 1, wins: 0, losses: 0 };
};

export const saveProfile = (p: Profile): void => {
  try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* private mode */ }
};

/** XP needed to go from `level` to `level+1` — gentle early, steep later. */
export const xpForNext = (level: number): number => 80 + level * 45;

/** Award XP for a finished match. Returns levels gained (for the banner). */
export const awardXp = (p: Profile, s: MatchStats): { gained: number; levelsUp: number } => {
  const gained = (s.won ? 60 : 20)
    + Math.min(60, Math.trunc(s.damageDealt / 250))
    + Math.min(40, s.bestCombo * 4);
  p.xp += gained;
  if (s.won) p.wins++; else p.losses++;
  let levelsUp = 0;
  while (p.level < MAX_LEVEL && p.xp >= xpForNext(p.level)) {
    p.xp -= xpForNext(p.level);
    p.level++;
    levelsUp++;
  }
  saveProfile(p);
  return { gained, levelsUp };
};

// ---- the lever -------------------------------------------------------------
export const loadLever = (): number => {
  const v = Number(localStorage.getItem(LEVER_KEY) ?? '0');
  return Number.isFinite(v) ? Math.max(-10, Math.min(10, v)) : 0;
};

export const saveLever = (v: number): void => {
  try { localStorage.setItem(LEVER_KEY, String(v)); } catch { /* ok */ }
};

export const cpuLevelFor = (p: Profile, lever: number): number =>
  Math.max(1, Math.min(MAX_LEVEL, p.level + lever));

/** Map a CPU level onto the core AI's 0-100 skill lever. */
export const skillForCpuLevel = (cpuLevel: number): number =>
  Math.max(3, Math.min(100, Math.round((cpuLevel * 100) / MAX_LEVEL)));
