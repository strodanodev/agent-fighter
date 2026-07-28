/**
 * Persistence + THE CREDITS ECONOMY (ADR 0003 Phase B/C, M5 credits).
 *
 * Two implementations of one interface:
 *  · supabasePersistence — production. Every operation is ONE PostgREST RPC;
 *    all money/XP logic lives in Postgres functions (supabase/migrations/)
 *    that are atomic and IDEMPOTENT (daily by (profile,day), match by the
 *    matches-PK insert, escrow by a unique ledger row). Service-role only;
 *    RLS gives clients read-only access. No client write path exists.
 *  · memoryPersistence — dev/tests. Same semantics, in-process. Marked
 *    `dev: true`, which also unlocks name-keyed dev identities on the server
 *    (play the full economy without AIR/Supabase). NEVER ship this flag on.
 *
 * ECONOMY RULES (mirrored in supabase/migrations/0002_credits.sql — change
 * BOTH or the dev economy lies about production):
 *  · daily login bonus: +DAILY_CREDITS once per UTC day, on first
 *    authenticated contact with the server.
 *  · solo (single match vs house bot): fee 1 → escrowed at match start.
 *    Win: +2 back (net +1) and +60 XP. Loss: fee burned, −15 XP (clamped at
 *    the level floor — no de-leveling). Draw/incomplete: fee refunded.
 *  · arcade (AGENT ARCADE — the RANKED gauntlet MAP, one run = ARCADE_FEE 1,
 *    ADR 0008): the entry is a non-refundable debit taken by POST
 *    /arcade/enter before character select; battles themselves carry fee 0.
 *    Per battle: win +60 XP, loss −15 XP (no de-level), draw/incomplete 0.
 *    **A WIN PAYS NO CREDITS.** Credits come only from board pickups banked
 *    by reaching an exit alive (arcadeExtract) — fighting is the cost, the
 *    board is the earning. Dying forfeits everything not yet extracted.
 *  · wager (ONLINE): fee 10 each → BOTH BURN. There is no pot. The winner
 *    mints one non-transferable TICKET (ADR 0009, 0020_tickets.sql) redeemable
 *    for esports qualification / merch / vouchers. Credits never move between
 *    players, which is what makes wager the economy's largest SINK instead of
 *    a zero-sum transfer — and what kills sharking (the loser's credits went
 *    to nobody). Draw/undecided/incomplete: both refunded, NO ticket. A
 *    hash-flagged DEVIATOR forfeits: its opponent takes the win (and the
 *    ticket) regardless of the sim outcome. Forfeit (rage-quit) already
 *    resolves winner = the non-quitter, and DOES mint — a win is a win.
 *    Agent-class subs never mint: inert is inert.
 *  · XP (wager): win 60 / loss 20 / draw 30 — unchanged from Phase B.
 *  · referral dares (0005): invitee +REFERRAL_CREDITS at first authenticated
 *    contact carrying a ?ref= code (new accounts only, once ever, never
 *    self); inviter +REFERRAL_CREDITS once the invitee finishes a first
 *    decided match (release_referral — capped 10/inviter/rolling week).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AirIdentity } from './airjwt.js';

export const DAILY_CREDITS = 10;
/** Both sides of an accepted dare get this (mirrored in 0005_referrals.sql). */
export const REFERRAL_CREDITS = 25;
/** Max inviter payouts per rolling 7 days (mirrored in release_referral). */
export const REFERRAL_WEEKLY_CAP = 10;
export const SOLO_FEE = 1;
export const WAGER_FEE = 10;
/** AGENT ARCADE: one credit buys one RUN (non-refundable, POST /arcade/enter). */
export const ARCADE_FEE = 1;
/**
 * AGENT ARCADE v2 diminishing returns (ADR 0008, RETUNED after first live
 * play). Index = which EXTRACTION of the UTC day this is, 1-based; past the
 * end the last value repeats.
 *
 * Two things here were wrong in the first cut and cost a real player a real
 * evening (8 entries, 3 extractions including a 10-fight deep clear, net
 * ZERO credits):
 *
 *  1. It counted ENTRIES. The intent was "dying must not reset the ladder",
 *     but the effect was that dying and abandoning BURNED it — you were
 *     taxed for losing. Only a successful bank advances it now; a wipe
 *     already costs you the whole bag, which is deterrent enough.
 *  2. It bottomed out on the 4th run. A run is 6-22 minutes, so one evening
 *     pinned you at the floor forever. Three full-rate extractions before
 *     anything bites is the difference between "playing" and "grinding".
 *
 * And critically, this multiplier now applies to LOOT ONLY — never to the
 * exit bonus (see arcadeExtract). Tapering the bonus punished the
 * achievement rather than the farming. Mirrored in
 * 0018_arcade_extract_loot_only.sql — change BOTH.
 */
export const ARCADE_DR_PCT: readonly number[] = [100, 100, 100, 80, 65, 50];
export const arcadeMultiplierPct = (extractionsToday: number): number =>
  ARCADE_DR_PCT[Math.min(Math.max(extractionsToday, 1), ARCADE_DR_PCT.length) - 1]!;
/**
 * Extracted energy drinks per account per UTC day. A drink is worth
 * ITEM_COST (5) credits, so without its own valve drink extraction would
 * route straight around the credit multiplier above.
 */
export const ARCADE_DRINK_DAY_CAP = 3;
/** Solo winner gets the fee back + this profit. */
export const SOLO_WIN_NET = 1;
/** XP burned by LOSING a ranked solo match (the user-facing "loser loses XP"). */
export const SOLO_LOSS_XP = 15;
export const XP_WIN = 60;
export const XP_LOSS = 20;
export const XP_DRAW = 30;
export const MAX_LEVEL = 40;
const xpForNext = (level: number): number => 80 + level * 45;

// ---------------------------------------------------------------- ELO (ADR 0009)
// The skill spine. Level/XP measure playtime and credits/tickets measure the
// economy; neither is skill. MIRRORS supabase/migrations/0021_elo.sql — every
// constant and branch below has a twin there. Change both or the dev economy
// lies about production.
/** Starting rating, and the floor a season resets to. */
export const ELO_BASE = 1200;
/** Ratings never go below this — a losing run parks you, it never inverts you. */
export const ELO_FLOOR = 100;
/** Rated matches before the provisional (fast-converging) K-factor retires. */
export const ELO_PROVISIONAL = 10;
/**
 * Season 1 opens at this instant; 21 days is the ADR 0009 PLACEHOLDER length
 * (owner sets the real cadence before season 1 closes). Seasons are pure
 * arithmetic over a fixed epoch — no cron, no season table, no ops.
 */
export const SEASON_EPOCH_MS = Date.UTC(2026, 6, 27); // 2026-07-27T00:00:00Z
export const SEASON_DAYS = 21;
export const currentSeason = (now: number = Date.now()): number =>
  1 + Math.floor((now - SEASON_EPOCH_MS) / (SEASON_DAYS * 86_400_000));

/** Standard Elo expectation. Float math is fine — determinism binds @af/core only. */
export const eloShift = (mine: number, theirs: number, score: number, k: number): number =>
  Math.round(k * (score - 1 / (1 + Math.pow(10, (theirs - mine) / 400))));
/** K-factor from the rating and the rated count BEFORE this match. */
export const eloK = (elo: number, rated: number): number =>
  rated < ELO_PROVISIONAL ? 40 : elo >= 2400 ? 10 : 20;

/** Parse `KEY=value` lines from the repo-root .env into process.env (no dep). */
export const loadDotEnv = (root: string): void => {
  const file = join(root, '.env');
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (m && process.env[m[1]!] === undefined) {
      process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, '');
    }
  }
};

export type MatchMode = 'wager' | 'solo' | 'arcade';

export interface Account {
  credits: number;
  level: number;
  xp: number;
  wins: number;
  losses: number;
  /** True when THIS call granted the daily bonus (client shows a toast). */
  dailyGranted: boolean;
  /** Shareable dare code for landing /dare/<code> ('' until assigned). */
  refCode: string;
  /** Credits granted by THIS call redeeming a referral (0 = none). */
  referralGranted: number;
  /** Friends who ever redeemed this player's dare code (inviter side). */
  daresAccepted: number;
  /** Inviter payouts credited in the rolling week (vs REFERRAL_WEEKLY_CAP). */
  daresPaidWeek: number;
  /**
   * Wager tickets (ADR 0009), PHASE A (owner decision 2026-07-27):
   * non-transferable, never spendable, and no redemption catalog TODAY —
   * a collectible. Phase B opens redemption for esports seats and other
   * non-cash prizes using `tickets.redeemed_at`/`redeemed_for`, which
   * already exist; nothing minted now is invalidated then. Displayed on the
   * wallet strip and as a leaderboard column; never part of any ranking sort
   * in EITHER phase (currency is not status).
   */
  tickets: number;
}

export interface MatchRecord {
  matchId: string;
  mode: MatchMode;
  fee: number;
  identities: [AirIdentity | null, AirIdentity | null];
  names: [string, string];
  agents: [boolean, boolean];
  chars: [string, string];
  winner: number;
  reason: 'verified' | 'forfeit' | 'incomplete';
  rounds: [number, number];
  endTick: number;
  hash: number;
  deviator?: 0 | 1;
  engine: string;
  /**
   * AGENT ARCADE only: explicit winner payout in credits (milestone / clear
   * bonus), computed by the server from the run position. Arcade wins never
   * return the fee — the entry credit is consumed by playing the run.
   */
  payout?: number;
}

/**
 * A settled match's input ledger, as stored (ADR 0010, migration 0023).
 *
 * This is what makes a match REPLAYABLE rather than merely reported. Storing
 * inputs instead of frames is why a ~100-second match costs single-digit
 * kilobytes: everything else is re-derived by stepping the deterministic sim,
 * which is exactly what the server already did to decide the result.
 */
export interface MatchLedger {
  matchId: string;
  /** Both tracks, base64url — @af/core `encodeLedger`. */
  ledger: string;
  /**
   * The pinned setup a replayer must install before stepping: seed, bounds,
   * characters + bundle hashes, input delay, drink loadouts, solo AI pin.
   * Deliberately opaque JSON — it is read whole by a replayer, never queried.
   */
  pin: Record<string, unknown>;
  /** The engine build that produced it. A ledger only reproduces on its own. */
  engine: string;
  protocol: number;
  codecVersion: number;
  ticks: number;
  /** Canonical sha256 hex — keeps retroactive on-chain anchoring possible. */
  digest: string;
}

export interface XpAward {
  side: 0 | 1;
  gained: number; // XP delta — can be NEGATIVE (solo loss)
  levelsUp: number;
  level: number;
  xp: number;
  wins: number;
  losses: number;
  creditsDelta: number; // net credits vs BEFORE the match fee
  credits: number; // balance after settlement
  /** This settlement minted a wager ticket for this side (ADR 0009). */
  ticket: boolean;
  /** Unredeemed ticket balance after settlement (only meaningful if minted). */
  tickets: number;
  /** Lifetime rating after settlement (ADR 0009). Never resets. */
  elo: number;
  /** Rating movement from THIS match — 0 for every unrated mode. */
  eloDelta: number;
  /** Rating in the current season's own pool (resets each season). */
  seasonElo: number;
  seasonEloDelta: number;
}

/** Thrown by escrowMatch when a side can't cover the fee. */
export class InsufficientCredits extends Error {
  constructor(public side: 0 | 1) { super(`INSUFFICIENT:${side}`); }
}

/**
 * A trained agent (ADR 0006): STYLE only. The server clamps `personality`
 * to core AI_PERSONALITY_RANGES and validates `character` against the
 * roster before this ever persists; skill/stats are never part of it —
 * skill is re-derived from the owner's level at match time.
 */
export interface AgentConfig {
  character: string;
  personality: Record<string, number>;
  motto?: string;
}

export interface AgentInfo {
  config: AgentConfig | null;
  /** ISO timestamp of the current key's mint — null = no key issued. */
  keyCreatedAt: string | null;
  name: string;
  level: number; xp: number; wins: number; losses: number;
}

/**
 * A LIVE agent-class account (fleet/headless or coached) as an opponent
 * identity — select-screen badge + ranked-solo house pin (0010 `agent_roster`
 * view). `address` is the AIR smart-account wallet; `streak` is the current
 * consecutive-win count.
 */
export interface AgentRosterRow {
  id: string;
  name: string;
  address: string | null;
  level: number; xp: number; wins: number; losses: number;
  streak: number;
}

/** The house agent's live aggregate record (0010 `house_agent_stats`). */
export interface HouseStats {
  wins: number; losses: number; streak: number; battles: number;
}

export interface Persistence {
  /** Dev economy (name-keyed identities allowed, nothing durable). */
  dev: boolean;
  /**
   * Upsert profile, claim the daily bonus if due, return the account.
   * `ref` (a dare code from a shared link) redeems the invitee's referral
   * bonus when eligible — best-effort, never blocks login.
   */
  getAccount: (identity: AirIdentity, name: string, agent: boolean, ref?: string) => Promise<Account>;
  /** Deduct the fee from every AUTHENTICATED side, atomically (all or none). */
  escrowMatch: (matchId: string, subs: [string | null, string | null], fee: number) => Promise<void>;
  /** Settle + award. Idempotent by match id ([] on retry). */
  recordMatch: (r: MatchRecord) => Promise<XpAward[]>;
  /**
   * Store a settled match's input ledger for later replay (ADR 0010).
   *
   * OPTIONAL on the interface by design: it is pure archival, so a
   * persistence implementation that does not support it (a test double, an
   * older deployment) must not be a type error and must not change how a
   * match settles. Callers use `persistence.saveLedger?.(…)`.
   *
   * Idempotent by match id — a retry stores nothing new and never overwrites,
   * because the first write is the one that matched the settled result.
   */
  saveLedger?: (l: MatchLedger) => Promise<void>;
  /**
   * Refund fees whose match NEVER settled — the server died between escrow
   * and record_match, stranding real credits (ADR 0005's known gap). Only
   * fees older than the cutoff are touched (younger ones may belong to a
   * match still in progress; no legitimate match outlives 30 minutes — the
   * idle forfeit caps silence at 30s and the pace guard caps solo at ~3×
   * real time). A swept match is SETTLED as a no-contest (it gets a matches
   * row), so a late record_match finds the id taken and awards nothing —
   * refund-then-payout double-spends are structurally impossible.
   * Returns the number of refunds performed. Run at startup + periodically.
   */
  sweepOrphanedEscrow: (olderThanMinutes?: number) => Promise<number>;
  /**
   * Items twin of sweepOrphanedEscrow: hand back drinks claimed for a match
   * that NEVER settled (server died between claimEquipped and settleItems /
   * releaseItems — the graceful drain covers deploys, this covers crashes).
   * A row is stranded when its claim is older than the cutoff and no
   * matches row exists for its match id; settled matches keep their drunk
   * cans consumed forever. Returns the number of rows released.
   */
  sweepOrphanedItems: (olderThanMinutes?: number) => Promise<number>;
  /**
   * Pay the inviter of _invitee's referral if it just became due (invitee
   * finished a first decided match). Idempotent; returns credits granted.
   * Call AFTER recordMatch settles — the check reads the matches table.
   */
  releaseReferral: (inviteeSub: string) => Promise<number>;
  leaderboard: (limit?: number) => Promise<unknown[]>;
  /**
   * THE season ladder (ADR 0009 step 2) — the `season_board` view. Ranked on
   * season Elo, but only for profiles past the provisional gate; everyone else
   * is listed below with a NULL rank. Kept SEPARATE from `leaderboard`, which
   * measures progression (level/XP) and whose ordering `player_stats.rank`
   * depends on.
   */
  seasonBoard: (limit?: number) => Promise<unknown[]>;
  /** LIVE agents (real trained agents) as opponent-card identities. */
  agentRoster: () => Promise<AgentRosterRow[]>;
  /** The house agent's live aggregate record (grows as players fight it). */
  houseStats: () => Promise<HouseStats>;
  /** Trained agent (ADR 0006). Null = profile does not exist. */
  getAgent: (sub: string) => Promise<AgentInfo | null>;
  /** Caller has ALREADY clamped/validated the config (server.ts is the authority). */
  setAgentConfig: (sub: string, config: AgentConfig) => Promise<boolean>;
  /** Store sha256(key) hex; null revokes. Returns false if no such profile. */
  setAgentKey: (sub: string, keyHash: string | null) => Promise<boolean>;
  /** Resolve a presented key hash to its owner. */
  findByAgentKey: (keyHash: string) => Promise<{ sub: string; name: string } | null>;
  /**
   * Resolve a dare/ref code to its profile (dare-vs-agent, ADR 0006). Ref
   * codes are public by design (they ride share links), so this leaks
   * nothing new — the caller still only gets what GET /agents/roster shows.
   */
  findByRefCode: (code: string) => Promise<{ sub: string; name: string } | null>;
  /**
   * Create an AGENT-CLASS account (sub `agent:<uuid>`) owned by an AIR
   * operator (`ownerSub`). Economically INERT — 0 credits, no daily, no
   * payouts. False = id already existed or owner invalid.
   */
  createAgentAccount: (sub: string, name: string, keyHash: string, ownerSub: string) => Promise<boolean>;
  /** How many agent:<uuid> rows this operator already owns. */
  countOwnedAgents: (ownerSub: string) => Promise<number>;
  /** Case-insensitive display-name collision check (leaderboard uniqueness). */
  nameTaken: (name: string) => Promise<boolean>;
  /**
   * Recent settled matches involving `sub`, newest first (coach food —
   * GET /agent/matches). Raw rows; the endpoint maps them sub-centric.
   */
  recentMatches: (sub: string, limit: number) => Promise<MatchRow[]>;
  /**
   * Vending-machine purchase (ADR 0007): debit `cost` credits and grant the
   * SERVER-rolled item (the gacha roll happens in server.ts — persistence
   * just records it atomically). Idempotent by `nonce`: a replayed purchase
   * returns the already-granted item with `duplicate: true` and charges
   * nothing. Throws InsufficientCredits(0) when the balance can't cover it.
   */
  buyItem: (sub: string, cost: number, itemId: string, tier: number, nonce: string) => Promise<PurchaseResult>;
  /** Unconsumed inventory for `sub`, newest first. */
  listItems: (sub: string, limit?: number) => Promise<OwnedItem[]>;
  /**
   * Current balance, or null if the profile doesn't exist yet. A plain read —
   * no upsert, no daily grant. The shop reports THIS with its catalog so the
   * balance the player sees is the balance of the identity that will be
   * charged (the /me wallet can be a different identity mid-AIR-rehydration).
   */
  getCredits: (sub: string) => Promise<number | null>;
  /**
   * Claim ONE unconsumed drink for a match (escrow-at-pair-time, the fee
   * pattern): atomically stamps consumed_match_id. Returns the item, or null
   * if the row doesn't exist / isn't `sub`'s / was already consumed — except
   * idempotently: already consumed BY THIS match returns the item again
   * (safe retry). No-contest settlement calls releaseItems to hand it back.
   */
  consumeItem: (sub: string, rowId: number, matchId: string) => Promise<OwnedItem | null>;
  /** Un-consume every item claimed by `matchId` (refund path). */
  releaseItems: (matchId: string) => Promise<void>;
  /**
   * Consume-only-what-you-drink settlement (ADR 0007 final shape): of the
   * items claimed by `matchId`, keep the DRUNK rows consumed and release
   * the rest back to the stash (they also stay equipped — an un-drunk can
   * rides into the next match automatically).
   */
  settleItems: (matchId: string, drunkRowIds: number[]) => Promise<void>;
  /**
   * Equip up to 3 unconsumed drinks (vending-machine screen). Replaces the
   * whole loadout: rows in `rowIds` get slots 0..2 in order, everything
   * else unequips. Rows that aren't `sub`'s or are consumed are skipped.
   */
  setEquipped: (sub: string, rowIds: number[]) => Promise<void>;
  /** The equipped, unconsumed loadout in slot order (≤ 3). */
  equippedItems: (sub: string) => Promise<OwnedItem[]>;
  /**
   * Plain NON-REFUNDABLE debit (arcade entry, ADR 0007 credits rework):
   * unlike escrow_match there is NO refund path and NO sweeper interest —
   * the credit is spent the moment this returns. Idempotent by
   * (reason, key): a replayed call charges nothing and returns the current
   * balance with duplicate:true. Throws InsufficientCredits(0) when the
   * balance can't cover it.
   */
  debitCredits: (sub: string, amount: number, reason: string, key: string) =>
    Promise<{ credits: number; duplicate: boolean }>;
  /**
   * AGENT ARCADE v2 extraction (ADR 0008): bank a surviving run's bag.
   * `runToken` is the idempotency key — a retried extract pays once.
   *
   * `loot` and `bonus` are SEPARATE arguments on purpose. The day's
   * diminishing-returns multiplier applies to LOOT ONLY; the exit bonus is
   * the guaranteed reward for surviving the run and is always paid in full.
   * Tapering it taxed the achievement instead of the farming, which is how a
   * 10-fight deep clear ended up paying 8 credits on day one.
   *
   * Also reports how many board drinks may still be granted today (the
   * caller grants them through buyItem at cost 0; see ARCADE_DRINK_DAY_CAP).
   *
   * Deliberately NOT part of recordMatch: an extraction is not a match, has
   * no ledger 'fee' row, and must stay invisible to the escrow sweeper.
   */
  arcadeExtract: (
    sub: string, runToken: string, loot: number, bonus: number,
  ) => Promise<ArcadeExtract>;
}

/** What banking a run bag actually paid (ADR 0008). */
export interface ArcadeExtract {
  /** New balance after the payout. */
  credits: number;
  /** Credits actually paid = tapered LOOT + the untouched exit bonus. */
  granted: number;
  /** The multiplier applied TO THE LOOT ONLY, as a percentage. */
  multiplierPct: number;
  /** How many board drinks the caller may still grant today. */
  drinkBudget: number;
  /** True when this run token had already extracted (nothing moved). */
  duplicate: boolean;
}

/** One granted (not yet consumed) consumable in a player's inventory. */
export interface OwnedItem {
  rowId: number;
  itemId: string;
  tier: number;
  createdAt: string;
  /** 0..2 when equipped in the vending-machine loadout; null in the stash. */
  equippedSlot?: number | null;
}

export interface PurchaseResult extends OwnedItem {
  /** Balance after the purchase (unchanged on a duplicate replay). */
  credits: number;
  /** True = this nonce already bought something; nothing was charged. */
  duplicate: boolean;
}

/** One settled match as stored (subset of the matches table the coach needs). */
export interface MatchRow {
  id: string;
  mode: string;
  p0: string | null; p1: string | null;
  p0_name: string; p1_name: string;
  p0_agent: boolean; p1_agent: boolean;
  p0_char: string; p1_char: string;
  winner: number;
  reason: string;
  rounds0: number; rounds1: number;
  end_tick: number;
  created_at: string;
}

// ---------------------------------------------------------------- shared math
interface ProfileRow {
  credits: number; level: number; xp: number; wins: number; losses: number;
  /** Ratings (ADR 0009). `rated` counts matches that MOVED the rating — it is
   *  not wins+losses, and it is what the provisional K-factor keys on. */
  elo: number; rated: number;
  seasonElo: number; seasonRated: number; season: number;
}

/** Apply an XP delta with level-ups (positive) or a clamped burn (negative). */
const applyXp = (p: ProfileRow, delta: number): number => {
  let ups = 0;
  if (delta >= 0) {
    p.xp += delta;
    while (p.level < MAX_LEVEL && p.xp >= xpForNext(p.level)) {
      p.xp -= xpForNext(p.level);
      p.level++;
      ups++;
    }
  } else {
    p.xp = Math.max(0, p.xp + delta); // never de-level
  }
  return ups;
};

/**
 * Settlement for ONE side. Fees are already escrowed (subtracted), so
 * `creditsDelta` here is the payout — the caller reports fee-inclusive
 * deltas to players (payout − fee).
 */
const settleSide = (
  p: ProfileRow, r: MatchRecord, side: 0 | 1,
): { payout: number; xpDelta: number; ups: number; won: boolean; lost: boolean } => {
  const undecided = r.winner < 0 || r.reason === 'incomplete';
  const opponentDeviated = r.deviator === (1 - side);
  const iDeviated = r.deviator === side;
  // A deviator can never win the settlement, whatever the re-sim says —
  // and its opponent takes the win even on a sim loss/draw.
  const won = !iDeviated && !undecided && (r.winner === side || opponentDeviated);
  const draw = !undecided && !won && r.winner === 2 && !iDeviated;
  const lost = !undecided && !won && !draw;

  let payout = 0;
  let xpDelta = 0;
  if (undecided) {
    payout = r.fee; // refund
  } else if (r.mode === 'wager') {
    // TICKETS (ADR 0009, 0020_tickets.sql): a DECIDED wager returns nothing —
    // both entry fees burn and the winner mints a ticket instead of taking a
    // pot. Only a draw (nothing decided) hands the entry back. The mint itself
    // lives at the recordMatch call site, which knows the sub and can hold
    // agent-class accounts inert.
    payout = draw ? r.fee : 0;
    xpDelta = iDeviated ? 0 : won ? XP_WIN : draw ? XP_DRAW : XP_LOSS;
  } else if (r.mode === 'arcade') {
    // AGENT ARCADE battle (ADR 0008): a win pays XP and NOTHING ELSE — the
    // board pays credits, not the fights, so `payout` is 0 for every normal
    // battle. (The field survives only for the legacy pre-map settlement
    // path and for tests that assert it stays zero.) The entry fee lives
    // outside the match entirely, so `r.fee` is 0 here in practice; a draw
    // still refunds whatever was escrowed by an old-style battle.
    payout = won ? (r.payout ?? 0) : draw ? r.fee : 0;
    xpDelta = iDeviated ? 0 : won ? XP_WIN : draw ? 0 : -SOLO_LOSS_XP;
  } else { // solo — this side is the human; the house side has no account
    payout = won ? r.fee + SOLO_WIN_NET : draw ? r.fee : 0;
    xpDelta = iDeviated ? 0 : won ? XP_WIN : draw ? 0 : -SOLO_LOSS_XP;
  }
  p.credits += payout;
  if (won) p.wins++;
  if (lost) p.losses++;
  const ups = applyXp(p, xpDelta);
  return { payout, xpDelta, ups, won, lost };
};

// ---------------------------------------------------------------- memory impl
export const memoryPersistence = (): Persistence => {
  const profiles = new Map<string, ProfileRow & { lastDaily: string }>();
  const settled = new Set<string>(); // match ids
  /** Subset of `settled` claimed synthetically by sweepOrphanedEscrow. */
  const ghosts = new Set<string>();
  /** matchId → who was charged what, and when (the sweeper's cutoff clock). */
  const escrows = new Map<string, { subs: Set<string>; fee: number; at: number }>();
  const names = new Map<string, { name: string; agent: boolean }>();
  /** invitee sub → inviter sub + whether the inviter payout released. */
  const referrals = new Map<string, { inviter: string; released: boolean }>();
  /** sub → trained agent config + key (ADR 0006). */
  const agents = new Map<string, { config: AgentConfig | null; keyHash: string | null; keyCreatedAt: string | null }>();
  /** agent:<uuid> → AIR/dev owner sub (operator who minted it). */
  const owners = new Map<string, string>();
  /** Granted consumables, newest first (ADR 0007). Nonce = idempotency key. */
  const ownedItems: (OwnedItem & {
    sub: string; nonce: string; consumedMatchId?: string; consumedAt?: number;
    slot?: number | null;
  })[] = [];
  let nextItemRow = 1;
  /** Idempotency keys of non-refundable debits (`sub|reason|key`) — ADR 0007. */
  const debits = new Set<string>();
  /**
   * Wager TICKETS (ADR 0009), mirroring 0020_tickets.sql. Keyed by MATCH id,
   * not by profile: one ticket per match ever, which is the same structural
   * guard the SQL's unique(match_id) provides against a settlement retry
   * minting a second one.
   */
  const tickets = new Map<string, { sub: string; season: number; redeemed: boolean }>();
  const ticketsOf = (sub: string): number => {
    let n = 0;
    for (const t of tickets.values()) if (t.sub === sub && !t.redeemed) n++;
    return n;
  };
  /**
   * AGENT ARCADE v2 valves (ADR 0008), mirroring what the SQL reads back out
   * of credit_ledger: UTC day stamps of every successful EXTRACTION (the
   * diminishing-returns ladder) and of every board drink extracted (the
   * daily drink cap). Note extractions, not entries — see ARCADE_DR_PCT.
   */
  const arcadeBanks = new Map<string, string[]>();
  const extractedDrinks = new Map<string, string[]>();
  const utcDay = (): string => new Date().toISOString().slice(0, 10);
  /** Newest-first ring of settled matches (GET /agent/matches food). */
  const matchRows: MatchRow[] = [];
  /** Dev mirror of match_ledgers (ADR 0010). Insertion-ordered, capped. */
  const ledgerRows = new Map<string, MatchLedger>();
  const agentOf = (sub: string): { config: AgentConfig | null; keyHash: string | null; keyCreatedAt: string | null } => {
    let a = agents.get(sub);
    if (!a) { a = { config: null, keyHash: null, keyCreatedAt: null }; agents.set(sub, a); }
    return a;
  };

  const prof = (sub: string): ProfileRow & { lastDaily: string } => {
    let p = profiles.get(sub);
    if (!p) {
      p = {
        credits: 0, level: 1, xp: 0, wins: 0, losses: 0, lastDaily: '',
        elo: ELO_BASE, rated: 0,
        seasonElo: ELO_BASE, seasonRated: 0, season: currentSeason(),
      };
      profiles.set(sub, p);
    }
    return p;
  };

  /** Dev codes are derived, stable, and never collide within a session. */
  const refCodeOf = (sub: string): string =>
    `${(names.get(sub)?.name ?? 'FIGHTER').replace(/[^A-Za-z0-9]/g, '').slice(0, 10).toUpperCase() || 'FIGHTER'}-${sub.replace(/[^A-Za-z0-9]/g, '').slice(-4).toUpperCase().padStart(4, '0')}`;

  return {
    dev: true,
    getAccount: async (identity, name, agent, ref) => {
      const p = prof(identity.sub);
      const trimmed = name.trim();
      const stub =
        !trimmed ||
        trimmed === identity.sub.slice(0, 12) ||
        /^[0-9a-f]{8}-[0-9a-f]{0,4}$/i.test(trimmed);
      const prev = names.get(identity.sub);
      if (!stub || !prev) {
        names.set(identity.sub, {
          name: stub ? identity.sub.slice(0, 12) : trimmed,
          agent,
        });
      } else {
        names.set(identity.sub, { name: prev.name, agent });
      }
      const today = new Date().toISOString().slice(0, 10);
      const dailyGranted = p.lastDaily !== today;
      if (dailyGranted) {
        p.lastDaily = today;
        p.credits += DAILY_CREDITS;
      }
      // Referral redemption — same rules as 0005_referrals.sql get_account.
      let referralGranted = 0;
      if (ref) {
        const code = ref.trim().toUpperCase();
        const inviter = [...profiles.keys()].find((s) => s !== identity.sub && refCodeOf(s) === code);
        if (inviter && !referrals.has(identity.sub) && p.wins + p.losses === 0) {
          referrals.set(identity.sub, { inviter, released: false });
          p.credits += REFERRAL_CREDITS;
          referralGranted = REFERRAL_CREDITS;
        }
      }
      // Inviter-side stats: the dev economy has no timestamps, so "released
      // ever" stands in for the SQL's rolling-week payout window.
      const mine = [...referrals.values()].filter((r) => r.inviter === identity.sub);
      return {
        credits: p.credits, level: p.level, xp: p.xp, wins: p.wins, losses: p.losses,
        dailyGranted, refCode: refCodeOf(identity.sub), referralGranted,
        daresAccepted: mine.length,
        daresPaidWeek: mine.filter((r) => r.released).length,
        tickets: ticketsOf(identity.sub),
      };
    },
    escrowMatch: async (matchId, subs, fee) => {
      // Mirrors 0012_no_self_match.sql: one profile may never escrow both
      // sides of a match (the SQL's idempotency guard would half-charge it
      // while settlement pays the full pot — a credit mint).
      if (subs[0] !== null && subs[0] === subs[1]) throw new Error('SELF_MATCH');
      const entry = escrows.get(matchId) ?? { subs: new Set<string>(), fee, at: Date.now() };
      escrows.set(matchId, entry);
      const due = ([0, 1] as const).filter((s) => subs[s] && !entry.subs.has(subs[s]!));
      for (const s of due) if (prof(subs[s]!).credits < fee) throw new InsufficientCredits(s);
      for (const s of due) {
        prof(subs[s]!).credits -= fee;
        entry.subs.add(subs[s]!);
      }
    },
    recordMatch: async (r) => {
      if (settled.has(r.matchId)) return [];
      settled.add(r.matchId);
      matchRows.unshift({
        id: r.matchId, mode: r.mode, created_at: new Date().toISOString(),
        p0: r.identities[0]?.sub ?? null, p1: r.identities[1]?.sub ?? null,
        p0_name: r.names[0], p1_name: r.names[1],
        p0_agent: r.agents[0], p1_agent: r.agents[1],
        p0_char: r.chars[0], p1_char: r.chars[1],
        winner: r.winner, reason: r.reason,
        rounds0: r.rounds[0], rounds1: r.rounds[1], end_tick: r.endTick,
      });
      if (matchRows.length > 500) matchRows.pop();

      // RATINGS (ADR 0009), mirroring 0021_elo.sql. Everything here has a twin
      // in that migration's rating pre-pass.
      const subs = [r.identities[0]?.sub, r.identities[1]?.sub] as const;
      const season = currentSeason();
      // Lazy season rollover, BEFORE any rating is read: a new season's first
      // match must never be scored against last season's numbers. Runs for
      // every mode, so an arcade-only player still gets stamped in.
      for (const sub of subs) {
        if (!sub) continue;
        const p = prof(sub);
        if (p.season !== season) {
          p.seasonElo = ELO_BASE; p.seasonRated = 0; p.season = season;
        }
      }
      const undecided = r.winner < 0 || r.reason === 'incomplete';
      // Only a DECIDED WAGER between two human hands is rated. Bots have no
      // rating to play against yet (that arrives with the stable + defend-Elo),
      // and the `agents[]` flag is the load-bearing gate: a coached-owner
      // headless runner plays as its owner's ordinary human profile.
      let isRated = r.mode === 'wager' && !undecided
        && !!subs[0] && !!subs[1]
        && !subs[0]!.startsWith('agent:') && !subs[1]!.startsWith('agent:')
        && !r.agents[0] && !r.agents[1];
      // A deviator can never win a settlement (ADR 0003/0005), so it takes the
      // rating loss and its opponent takes the win — matching `won` below.
      let scores: [number, number] = [0, 0];
      if (isRated) {
        if (r.deviator === 0) scores = [0, 1];
        else if (r.deviator === 1) scores = [1, 0];
        else if (r.winner === 2) scores = [0.5, 0.5];
        else if (r.winner === 0) scores = [1, 0];
        else if (r.winner === 1) scores = [0, 1];
        else isRated = false; // unknown winner code: refuse to guess
      }
      const deltas: [number, number] = [0, 0];
      const seasonDeltas: [number, number] = [0, 0];
      if (isRated) {
        // Read BOTH ratings before writing either — settling side 0 first and
        // then reading side 1 would score the second player against an
        // already-updated opponent, breaking Elo's zero-sum property.
        const a = prof(subs[0]!);
        const b = prof(subs[1]!);
        const before = [
          { elo: a.elo, rated: a.rated, sElo: a.seasonElo, sRated: a.seasonRated },
          { elo: b.elo, rated: b.rated, sElo: b.seasonElo, sRated: b.seasonRated },
        ] as const;
        for (const side of [0, 1] as const) {
          const me = before[side];
          const opp = before[side === 0 ? 1 : 0];
          deltas[side] = eloShift(me.elo, opp.elo, scores[side], eloK(me.elo, me.rated));
          // The season pool is scored against SEASON ratings, not lifetime
          // ones — else a fresh season just re-derives the lifetime ladder.
          seasonDeltas[side] = eloShift(me.sElo, opp.sElo, scores[side], eloK(me.sElo, me.sRated));
        }
      }

      const out: XpAward[] = [];
      for (const side of [0, 1] as const) {
        const sub = r.identities[side]?.sub;
        if (!sub) continue;
        const p = prof(sub);
        const s = settleSide(p, r, side);
        p.elo = Math.max(ELO_FLOOR, p.elo + deltas[side]);
        p.seasonElo = Math.max(ELO_FLOOR, p.seasonElo + seasonDeltas[side]);
        if (isRated) { p.rated++; p.seasonRated++; }
        // THE MINT (ADR 0009). `won` already excludes deviators, draws and
        // no-contests. Two more gates, closing different holes:
        //  · `agent:` sub    — the inert account CLASS (fleet/house bots).
        //  · r.agents[side]  — the CONNECTION declared itself an agent. A
        //    coached-owner headless runner plays as its owner's ordinary
        //    human profile, so only this flag stops an owner farming
        //    tickets in their sleep. "Bots fill wallets; only hands fill
        //    trophy cases."
        let minted = false;
        if (r.mode === 'wager' && s.won && !sub.startsWith('agent:') && !r.agents[side]
          && !tickets.has(r.matchId)) {
          tickets.set(r.matchId, { sub, season: 1, redeemed: false });
          minted = true;
        }
        out.push({
          side, gained: s.xpDelta, levelsUp: s.ups,
          level: p.level, xp: p.xp, wins: p.wins, losses: p.losses,
          creditsDelta: s.payout - r.fee, credits: p.credits,
          ticket: minted, tickets: ticketsOf(sub),
          elo: p.elo, eloDelta: deltas[side],
          seasonElo: p.seasonElo, seasonEloDelta: seasonDeltas[side],
        });
      }
      return out;
    },
    sweepOrphanedEscrow: async (olderThanMinutes = 30) => {
      const cutoff = Date.now() - olderThanMinutes * 60_000;
      let refunded = 0;
      for (const [matchId, e] of escrows) {
        if (settled.has(matchId) || e.at > cutoff) continue;
        // Settle the ghost as a no-contest FIRST — a late recordMatch then
        // finds the id taken and awards nothing (no refund-then-payout).
        settled.add(matchId);
        ghosts.add(matchId); // items of a ghost are still releasable (see sweepOrphanedItems)
        for (const sub of e.subs) {
          prof(sub).credits += e.fee;
          refunded++;
        }
      }
      return refunded;
    },
    sweepOrphanedItems: async (olderThanMinutes = 30) => {
      const cutoff = Date.now() - olderThanMinutes * 60_000;
      let released = 0;
      for (const row of ownedItems) {
        // A ghost claimed by the ESCROW sweeper counts as unsettled here:
        // releaseItems never ran for it (mirrors 0018's engine <> filter).
        if (!row.consumedMatchId) continue;
        if (settled.has(row.consumedMatchId) && !ghosts.has(row.consumedMatchId)) continue;
        if ((row.consumedAt ?? 0) > cutoff) continue;
        row.consumedMatchId = undefined;
        row.consumedAt = undefined;
        released++;
      }
      return released;
    },
    releaseReferral: async (inviteeSub) => {
      const r = referrals.get(inviteeSub);
      const p = profiles.get(inviteeSub);
      // Released only once the invitee has a decided match on record.
      if (!r || r.released || !p || p.wins + p.losses === 0) return 0;
      r.released = true;
      prof(r.inviter).credits += REFERRAL_CREDITS;
      return REFERRAL_CREDITS;
    },
    leaderboard: async (limit = 20) =>
      [...profiles.entries()]
        .filter(([, p]) => p.wins + p.losses > 0)
        .sort((a, b) => b[1].level - a[1].level || b[1].xp - a[1].xp || b[1].wins - a[1].wins)
        .slice(0, limit)
        .map(([id, p], i) => ({
          id, name: names.get(id)?.name ?? 'anon', is_agent: names.get(id)?.agent ?? false,
          level: p.level, xp: p.xp, wins: p.wins, losses: p.losses, rank: i + 1,
          // Cosmetic collectible (0022) — displayed, never part of the sort.
          tickets: ticketsOf(id),
          elo: p.elo, season_elo: p.seasonElo,
          rated: p.rated, season_rated: p.seasonRated,
        })),
    /** Mirrors the `season_board` view in 0022_season_board.sql — keep in sync. */
    seasonBoard: async (limit = 20) => {
      const season = currentSeason();
      const rows = [...profiles.entries()]
        .filter(([, p]) => p.wins + p.losses > 0 && p.season === season)
        .sort((a, b) =>
          Number(b[1].seasonRated >= ELO_PROVISIONAL) - Number(a[1].seasonRated >= ELO_PROVISIONAL)
          || b[1].seasonElo - a[1].seasonElo
          || b[1].level - a[1].level || b[1].xp - a[1].xp || b[1].wins - a[1].wins)
        .slice(0, limit);
      // Rank counts ONLY the qualified block, so a provisional player has no
      // rank rather than a misleading one off an unconverged rating.
      let qualifiedSeen = 0;
      return rows.map(([id, p]) => {
        const qualified = p.seasonRated >= ELO_PROVISIONAL;
        if (qualified) qualifiedSeen++;
        return {
          id, name: names.get(id)?.name ?? 'anon', is_agent: names.get(id)?.agent ?? false,
          season: p.season, elo: p.seasonElo, rated: p.seasonRated,
          lifetime_elo: p.elo, level: p.level, wins: p.wins, losses: p.losses,
          qualified, rank: qualified ? qualifiedSeen : null,
        };
      });
    },
    // Dev economy has no durable match history; the client falls back to a
    // client-simulated house agent when these come back empty/zero.
    agentRoster: async () => [],
    houseStats: async () => ({ wins: 0, losses: 0, streak: 0, battles: 0 }),
    getAgent: async (sub) => {
      if (!profiles.has(sub)) return null;
      const p = prof(sub);
      const a = agentOf(sub);
      return {
        config: a.config, keyCreatedAt: a.keyCreatedAt,
        name: names.get(sub)?.name ?? 'anon',
        level: p.level, xp: p.xp, wins: p.wins, losses: p.losses,
      };
    },
    setAgentConfig: async (sub, config) => {
      if (!profiles.has(sub)) return false;
      agentOf(sub).config = config;
      return true;
    },
    setAgentKey: async (sub, keyHash) => {
      if (!profiles.has(sub)) return false;
      const a = agentOf(sub);
      a.keyHash = keyHash;
      a.keyCreatedAt = keyHash ? new Date().toISOString() : null;
      return true;
    },
    findByAgentKey: async (keyHash) => {
      for (const [sub, a] of agents) {
        if (a.keyHash && a.keyHash === keyHash) {
          return { sub, name: names.get(sub)?.name ?? 'anon' };
        }
      }
      return null;
    },
    findByRefCode: async (code) => {
      const wanted = code.trim().toUpperCase();
      for (const sub of profiles.keys()) {
        if (refCodeOf(sub) === wanted) return { sub, name: names.get(sub)?.name ?? 'anon' };
      }
      return null;
    },
    recentMatches: async (sub, limit) =>
      matchRows.filter((m) => m.p0 === sub || m.p1 === sub).slice(0, limit),
    // Mirrors 0023_match_ledgers.sql. Bounded like matchRows above: the dev
    // economy is a long-lived process and an unbounded ledger map would be a
    // slow memory leak in exchange for data nobody reads after the test ends.
    saveLedger: async (l) => {
      if (ledgerRows.has(l.matchId)) return; // idempotent, first write wins
      ledgerRows.set(l.matchId, l);
      if (ledgerRows.size > 200) {
        const oldest = ledgerRows.keys().next();
        if (!oldest.done) ledgerRows.delete(oldest.value);
      }
    },
    createAgentAccount: async (sub, name, keyHash, ownerSub) => {
      if (profiles.has(sub)) return false;
      const owner = ownerSub.trim();
      if (!owner || owner.startsWith('agent:')) return false;
      // Same shape as prof(), but lastDaily is pre-stamped FOREVER: agent-
      // class accounts never claim the daily grant (economically inert).
      profiles.set(sub, {
        credits: 0, level: 1, xp: 0, wins: 0, losses: 0, lastDaily: '9999-12-31',
        elo: ELO_BASE, rated: 0,
        seasonElo: ELO_BASE, seasonRated: 0, season: currentSeason(),
      });
      names.set(sub, { name, agent: true });
      owners.set(sub, owner);
      const a = agentOf(sub);
      a.keyHash = keyHash;
      a.keyCreatedAt = new Date().toISOString();
      return true;
    },
    countOwnedAgents: async (ownerSub) => {
      const want = ownerSub.trim();
      let n = 0;
      for (const [sub, owner] of owners) if (owner === want && sub.startsWith('agent:')) n++;
      return n;
    },
    nameTaken: async (name) => {
      const want = name.trim().toLowerCase();
      if (!want) return false;
      for (const n of names.values()) if (n.name.toLowerCase() === want) return true;
      return false;
    },
    // Mirrors 0013_items.sql buy_item — keep in sync (money logic lives twice).
    buyItem: async (sub, cost, itemId, tier, nonce) => {
      const replay = ownedItems.find((i) => i.sub === sub && i.nonce === nonce);
      if (replay) {
        return {
          rowId: replay.rowId, itemId: replay.itemId, tier: replay.tier,
          createdAt: replay.createdAt, credits: prof(sub).credits, duplicate: true,
        };
      }
      const p = prof(sub);
      if (p.credits < cost) throw new InsufficientCredits(0);
      p.credits -= cost;
      const row = {
        sub, nonce, rowId: nextItemRow++, itemId, tier,
        createdAt: new Date().toISOString(),
      };
      ownedItems.unshift(row);
      // Board drinks ride the same free-grant path as level-up pulls; the
      // 'xtr:' nonce prefix is how BOTH impls count them against the daily
      // cap (0017 reads the same prefix back out of credit_ledger).
      if (nonce.startsWith('xtr:')) {
        extractedDrinks.set(sub, [...(extractedDrinks.get(sub) ?? []), utcDay()]);
      }
      return {
        rowId: row.rowId, itemId: row.itemId, tier: row.tier,
        createdAt: row.createdAt, credits: p.credits, duplicate: false,
      };
    },
    listItems: async (sub, limit = 50) =>
      ownedItems
        .filter((i) => i.sub === sub && !i.consumedMatchId) // consumed = gone
        .slice(0, limit)
        .map(({ rowId, itemId, tier, createdAt, slot }) =>
          ({ rowId, itemId, tier, createdAt, equippedSlot: slot ?? null })),
    getCredits: async (sub) => (profiles.has(sub) ? prof(sub).credits : null),
    consumeItem: async (sub, rowId, matchId) => {
      const row = ownedItems.find((i) => i.sub === sub && i.rowId === rowId);
      if (!row) return null;
      if (row.consumedMatchId && row.consumedMatchId !== matchId) return null;
      row.consumedMatchId = matchId;
      row.consumedAt = Date.now();
      return { rowId: row.rowId, itemId: row.itemId, tier: row.tier, createdAt: row.createdAt };
    },
    releaseItems: async (matchId) => {
      for (const row of ownedItems) {
        if (row.consumedMatchId === matchId) row.consumedMatchId = undefined;
      }
    },
    settleItems: async (matchId, drunkRowIds) => {
      for (const row of ownedItems) {
        if (row.consumedMatchId === matchId && !drunkRowIds.includes(row.rowId)) {
          row.consumedMatchId = undefined; // un-drunk → back to the stash
        }
      }
    },
    setEquipped: async (sub, rowIds) => {
      for (const row of ownedItems) if (row.sub === sub) row.slot = null;
      rowIds.slice(0, 3).forEach((rowId, slot) => {
        const row = ownedItems.find((i) => i.sub === sub && i.rowId === rowId && !i.consumedMatchId);
        if (row) row.slot = slot;
      });
    },
    equippedItems: async (sub) =>
      ownedItems
        .filter((i) => i.sub === sub && !i.consumedMatchId && i.slot !== null && i.slot !== undefined)
        .sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0))
        .slice(0, 3)
        .map(({ rowId, itemId, tier, createdAt, slot }) =>
          ({ rowId, itemId, tier, createdAt, equippedSlot: slot ?? null })),
    // Mirrors 0015_arcade_entry.sql debit_credits — keep in sync.
    debitCredits: async (sub, amount, reason, key) => {
      const dedup = `${sub}|${reason}|${key}`;
      const p = prof(sub);
      if (debits.has(dedup)) return { credits: p.credits, duplicate: true };
      if (p.credits < amount) throw new InsufficientCredits(0);
      p.credits -= amount;
      debits.add(dedup);
      return { credits: p.credits, duplicate: false };
    },
    // Mirrors 0018_arcade_extract_loot_only.sql arcade_extract — keep in sync.
    arcadeExtract: async (sub, runToken, loot, bonus) => {
      const p = prof(sub);
      const key = `${sub}|arcade_extract|${runToken}`;
      if (debits.has(key)) {
        return {
          credits: p.credits, granted: 0, multiplierPct: 0,
          drinkBudget: 0, duplicate: true,
        };
      }
      const today = utcDay();
      // The ladder counts EXTRACTIONS, not entries: dying already costs the
      // whole bag, so it must not also cost you rate on your next run.
      const priorBanks = (arcadeBanks.get(sub) ?? []).filter((d) => d === today).length;
      const pct = arcadeMultiplierPct(priorBanks + 1);
      // The taper touches LOOT ONLY. The exit bonus is what you earned by
      // surviving and is always paid whole.
      const safeLoot = Math.max(0, loot);
      const safeBonus = Math.max(0, bonus);
      // Floor the tapered loot — the house never rounds a payout up — but a
      // SUCCESSFUL extraction must never come back as literally zero.
      let granted = Math.floor((safeLoot * pct) / 100) + safeBonus;
      if (granted < 1 && safeLoot + safeBonus > 0) granted = 1;
      p.credits += granted;
      debits.add(key);
      arcadeBanks.set(sub, [...(arcadeBanks.get(sub) ?? []), today]);
      const drinksToday = (extractedDrinks.get(sub) ?? []).filter((d) => d === today).length;
      return {
        credits: p.credits, granted, multiplierPct: pct,
        drinkBudget: Math.max(0, ARCADE_DRINK_DAY_CAP - drinksToday),
        duplicate: false,
      };
    },
  };
};

// -------------------------------------------------------------- supabase impl
export const supabasePersistence = (url: string, serviceKey: string): Persistence => {
  const base = url.replace(/\/+$/, '');

  const call = async (path: string, init: RequestInit): Promise<unknown> => {
    const res = await fetch(`${base}${path}`, {
      ...init,
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    });
    const body = await res.text();
    if (!res.ok) {
      // Postgres RAISE 'INSUFFICIENT:<side>' surfaces in the error body.
      const m = /INSUFFICIENT:(0|1)/.exec(body);
      if (m) throw new InsufficientCredits(Number(m[1]) as 0 | 1);
      throw new Error(`supabase ${path} → ${res.status}: ${body.slice(0, 200)}`);
    }
    return body ? JSON.parse(body) : null;
  };

  return {
    dev: false,
    getAccount: async (identity, name, agent, ref) => {
      // Never let an empty / UUID-prefix stub clobber a real fighter name
      // (leaderboard bug — see migration 0009_leaderboard_names.sql).
      let safeName = name.trim();
      const stub =
        !safeName ||
        safeName === identity.sub.slice(0, 12) ||
        /^[0-9a-f]{8}-[0-9a-f]{0,4}$/i.test(safeName);
      if (stub) {
        const existing = (await call(
          `/rest/v1/profiles?id=eq.${encodeURIComponent(identity.sub)}&select=name&limit=1`,
          { method: 'GET' },
        )) as Array<{ name?: string }>;
        const kept = existing[0]?.name?.trim();
        safeName = kept && kept.length > 0 ? kept : identity.sub.slice(0, 12);
      }
      const rows = (await call('/rest/v1/rpc/get_account', {
        method: 'POST',
        body: JSON.stringify({
          _id: identity.sub, _name: safeName, _agent: agent,
          _address: identity.address ?? null,
          _ref: ref ?? null,
        }),
      })) as Array<Record<string, unknown>>;
      const row = rows[0] ?? {};
      // Ticket balance is a SEPARATE rpc on purpose (0020_tickets.sql):
      // get_account is the daily-bonus + referral-redemption path, and
      // recreating it to add one column is real risk on a live money DB for
      // no benefit. Best-effort — a ticket count must never block a login.
      let tickets = 0;
      try {
        tickets = Number(await call('/rest/v1/rpc/ticket_count', {
          method: 'POST', body: JSON.stringify({ _profile: identity.sub }),
        }) ?? 0) | 0;
      } catch (e) {
        console.log(`[tickets] count failed for ${identity.sub}: ${String(e)}`);
      }
      return {
        credits: Number(row.credits ?? 0), level: Number(row.level ?? 1),
        xp: Number(row.xp ?? 0), wins: Number(row.wins ?? 0), losses: Number(row.losses ?? 0),
        dailyGranted: Boolean(row.daily_granted),
        refCode: String(row.ref_code ?? ''),
        referralGranted: Number(row.referral_granted ?? 0),
        daresAccepted: Number(row.dares_accepted ?? 0),
        daresPaidWeek: Number(row.dares_paid_week ?? 0),
        tickets,
      };
    },
    escrowMatch: async (matchId, subs, fee) => {
      await call('/rest/v1/rpc/escrow_match', {
        method: 'POST',
        body: JSON.stringify({ _match: matchId, _p0: subs[0], _p1: subs[1], _fee: fee }),
      });
    },
    recordMatch: async (r) => {
      const rows = (await call('/rest/v1/rpc/record_match', {
        method: 'POST',
        body: JSON.stringify({
          _id: r.matchId, _mode: r.mode, _fee: r.fee,
          _p0: r.identities[0]?.sub ?? null, _p1: r.identities[1]?.sub ?? null,
          _p0_name: r.names[0], _p1_name: r.names[1],
          _p0_agent: r.agents[0], _p1_agent: r.agents[1],
          _p0_char: r.chars[0], _p1_char: r.chars[1],
          _p0_address: r.identities[0]?.address ?? null,
          _p1_address: r.identities[1]?.address ?? null,
          _winner: r.winner, _reason: r.reason,
          _rounds0: r.rounds[0], _rounds1: r.rounds[1],
          _end_tick: r.endTick, _state_hash: r.hash >>> 0,
          _deviator: r.deviator ?? null,
          _engine: r.engine,
          _payout: r.payout ?? 0,
        }),
        // `ticket` is a boolean column, so the row is no longer all-numbers.
      })) as Array<Record<string, number | boolean | null>>;
      const n = (v: number | boolean | null | undefined): number => Number(v ?? 0) | 0;
      return rows.map((row) => ({
        side: n(row.side) as 0 | 1,
        gained: n(row.gained),
        levelsUp: n(row.levels_up),
        level: n(row.level),
        xp: n(row.xp),
        wins: n(row.wins),
        losses: n(row.losses),
        creditsDelta: n(row.credits_delta),
        credits: n(row.credits),
        // A pre-ticket DB returns neither column; false/0 is the correct
        // reading of "this settlement minted nothing".
        ticket: row.ticket === true,
        tickets: n(row.tickets),
        // A pre-0021 DB returns no rating columns. Reading that as ELO_BASE
        // with a 0 delta is the honest "this DB does not rate yet" — never
        // 0, which would read as a real rating of zero.
        elo: row.elo == null ? ELO_BASE : n(row.elo),
        eloDelta: n(row.elo_delta),
        seasonElo: row.season_elo == null ? ELO_BASE : n(row.season_elo),
        seasonEloDelta: n(row.season_elo_delta),
      }));
    },
    sweepOrphanedEscrow: async (olderThanMinutes = 30) => {
      const n = (await call('/rest/v1/rpc/sweep_orphaned_escrow', {
        method: 'POST',
        body: JSON.stringify({ _older_than_minutes: olderThanMinutes | 0 }),
      })) as number;
      return n | 0;
    },
    sweepOrphanedItems: async (olderThanMinutes = 30) => {
      const n = (await call('/rest/v1/rpc/sweep_orphaned_items', {
        method: 'POST',
        body: JSON.stringify({ _older_than_minutes: olderThanMinutes | 0 }),
      })) as number;
      return n | 0;
    },
    releaseReferral: async (inviteeSub) => {
      const n = (await call('/rest/v1/rpc/release_referral', {
        method: 'POST',
        body: JSON.stringify({ _invitee: inviteeSub }),
      })) as number;
      return n | 0;
    },
    leaderboard: async (limit = 20) =>
      (await call(`/rest/v1/leaderboard?select=*&limit=${limit | 0}`, { method: 'GET' })) as unknown[],
    seasonBoard: async (limit = 20) =>
      (await call(`/rest/v1/season_board?select=*&limit=${limit | 0}`, { method: 'GET' })) as unknown[],
    agentRoster: async () =>
      (await call('/rest/v1/agent_roster?select=*&order=level.desc,wins.desc&limit=50', { method: 'GET' })) as AgentRosterRow[],
    houseStats: async () => {
      const rows = (await call('/rest/v1/rpc/house_agent_stats', {
        method: 'POST', body: JSON.stringify({}),
      })) as Array<Record<string, number>>;
      const r = rows?.[0] ?? { wins: 0, losses: 0, streak: 0, battles: 0 };
      return { wins: r.wins! | 0, losses: r.losses! | 0, streak: r.streak! | 0, battles: r.battles! | 0 };
    },
    getAgent: async (sub) => {
      const rows = (await call('/rest/v1/rpc/get_agent', {
        method: 'POST', body: JSON.stringify({ _id: sub }),
      })) as Array<Record<string, unknown>>;
      const row = rows?.[0];
      if (!row) return null;
      return {
        config: (row.config ?? null) as AgentConfig | null,
        keyCreatedAt: row.key_created_at ? String(row.key_created_at) : null,
        name: String(row.name ?? 'anon'),
        level: Number(row.level ?? 1), xp: Number(row.xp ?? 0),
        wins: Number(row.wins ?? 0), losses: Number(row.losses ?? 0),
      };
    },
    setAgentConfig: async (sub, config) =>
      Boolean(await call('/rest/v1/rpc/set_agent_config', {
        method: 'POST', body: JSON.stringify({ _id: sub, _config: config }),
      })),
    setAgentKey: async (sub, keyHash) =>
      Boolean(await call('/rest/v1/rpc/set_agent_key', {
        method: 'POST', body: JSON.stringify({ _id: sub, _hash: keyHash }),
      })),
    findByAgentKey: async (keyHash) => {
      const rows = (await call('/rest/v1/rpc/find_by_agent_key', {
        method: 'POST', body: JSON.stringify({ _hash: keyHash }),
      })) as Array<Record<string, unknown>>;
      const row = rows?.[0];
      return row ? { sub: String(row.id), name: String(row.name ?? 'anon') } : null;
    },
    findByRefCode: async (code) => {
      // Straight PostgREST read on the unique ref_code index (0005). The
      // code is uppercased at generation time; normalize to match.
      const rows = (await call(
        `/rest/v1/profiles?ref_code=eq.${encodeURIComponent(code.trim().toUpperCase())}&select=id,name&limit=1`,
        { method: 'GET' },
      )) as Array<Record<string, unknown>>;
      const row = rows?.[0];
      return row ? { sub: String(row.id), name: String(row.name ?? 'anon') } : null;
    },
    createAgentAccount: async (sub, name, keyHash, ownerSub) =>
      Boolean(await call('/rest/v1/rpc/create_agent_account', {
        method: 'POST',
        body: JSON.stringify({ _id: sub, _name: name, _hash: keyHash, _owner: ownerSub }),
      })),
    countOwnedAgents: async (ownerSub) => {
      const n = (await call('/rest/v1/rpc/count_owned_agents', {
        method: 'POST', body: JSON.stringify({ _owner: ownerSub }),
      })) as number;
      return n | 0;
    },
    nameTaken: async (name) => {
      const want = name.trim();
      if (!want) return false;
      // ilike without wildcards = case-insensitive exact match in PostgREST.
      const rows = (await call(
        `/rest/v1/profiles?select=id&name=ilike.${encodeURIComponent(want)}&limit=1`,
        { method: 'GET' },
      )) as unknown[];
      return Array.isArray(rows) && rows.length > 0;
    },
    recentMatches: async (sub, limit) => {
      // Straight PostgREST read — matches is public-read anyway; the service
      // key just skips the anon path. Indexes matches_p0/p1_idx cover this.
      const cols = 'id,mode,p0,p1,p0_name,p1_name,p0_agent,p1_agent,p0_char,p1_char,winner,reason,rounds0,rounds1,end_tick,created_at';
      const s = encodeURIComponent(sub);
      return (await call(
        `/rest/v1/matches?select=${cols}&or=(p0.eq.${s},p1.eq.${s})&order=created_at.desc&limit=${limit | 0}`,
        { method: 'GET' },
      )) as MatchRow[];
    },
    // 0023_match_ledgers.sql. A plain insert rather than an RPC: no money
    // rule is involved, the table is service-role-only, and the primary key
    // does the whole job of making a retry a no-op.
    saveLedger: async (l) => {
      await call('/rest/v1/match_ledgers', {
        method: 'POST',
        headers: {
          // Idempotent by match_id: a retried settlement (server restart,
          // double callback) must not fail and must not overwrite the row
          // that was written alongside the settled result.
          Prefer: 'resolution=ignore-duplicates,return=minimal',
        },
        body: JSON.stringify({
          match_id: l.matchId,
          ledger: l.ledger,
          pin: l.pin,
          engine: l.engine,
          protocol: l.protocol,
          codec_version: l.codecVersion,
          ticks: l.ticks,
          digest: l.digest,
        }),
      });
    },
    buyItem: async (sub, cost, itemId, tier, nonce) => {
      const rows = (await call('/rest/v1/rpc/buy_item', {
        method: 'POST',
        body: JSON.stringify({
          _profile: sub, _cost: cost | 0, _item: itemId, _tier: tier | 0, _nonce: nonce,
        }),
      })) as Array<Record<string, unknown>>;
      const row = rows?.[0] ?? {};
      return {
        rowId: Number(row.row_id ?? 0),
        itemId: String(row.granted_item ?? itemId),
        tier: Number(row.granted_tier ?? tier),
        createdAt: new Date().toISOString(),
        credits: Number(row.credits ?? 0),
        duplicate: Boolean(row.duplicate),
      };
    },
    listItems: async (sub, limit = 50) => {
      // Items table is RLS default-deny — only this service-role path reads it.
      const rows = (await call(
        `/rest/v1/items?select=id,item_id,tier,created_at,equipped_slot&profile_id=eq.${encodeURIComponent(sub)}&consumed_match_id=is.null&order=created_at.desc&limit=${limit | 0}`,
        { method: 'GET' },
      )) as Array<Record<string, unknown>>;
      return rows.map((r) => ({
        rowId: Number(r.id ?? 0),
        itemId: String(r.item_id ?? ''),
        tier: Number(r.tier ?? 1),
        createdAt: String(r.created_at ?? ''),
        equippedSlot: r.equipped_slot === null || r.equipped_slot === undefined
          ? null : Number(r.equipped_slot),
      }));
    },
    getCredits: async (sub) => {
      const rows = (await call(
        `/rest/v1/profiles?id=eq.${encodeURIComponent(sub)}&select=credits&limit=1`,
        { method: 'GET' },
      )) as Array<Record<string, unknown>>;
      return rows?.[0] ? Number(rows[0].credits ?? 0) : null;
    },
    consumeItem: async (sub, rowId, matchId) => {
      // Atomic claim: the consumed_match_id=is.null filter makes the UPDATE
      // a compare-and-swap — a row already claimed by another match matches
      // zero rows. Retry-idempotent via the second read below.
      const claim = (await call(
        `/rest/v1/items?id=eq.${rowId | 0}&profile_id=eq.${encodeURIComponent(sub)}`
        + `&consumed_match_id=is.null`,
        {
          method: 'PATCH',
          headers: { Prefer: 'return=representation' },
          body: JSON.stringify({ consumed_match_id: matchId, consumed_at: new Date().toISOString() }),
        },
      )) as Array<Record<string, unknown>>;
      let row = claim?.[0];
      if (!row) {
        // Maybe WE already claimed it (retry after a crash) — that's fine.
        const again = (await call(
          `/rest/v1/items?id=eq.${rowId | 0}&profile_id=eq.${encodeURIComponent(sub)}`
          + `&consumed_match_id=eq.${encodeURIComponent(matchId)}&select=*&limit=1`,
          { method: 'GET' },
        )) as Array<Record<string, unknown>>;
        row = again?.[0];
        if (!row) return null;
      }
      return {
        rowId: Number(row.id ?? 0),
        itemId: String(row.item_id ?? ''),
        tier: Number(row.tier ?? 1),
        createdAt: String(row.created_at ?? ''),
      };
    },
    releaseItems: async (matchId) => {
      await call(
        `/rest/v1/items?consumed_match_id=eq.${encodeURIComponent(matchId)}`,
        { method: 'PATCH', body: JSON.stringify({ consumed_match_id: null, consumed_at: null }) },
      );
    },
    debitCredits: async (sub, amount, reason, key) => {
      const rows = (await call('/rest/v1/rpc/debit_credits', {
        method: 'POST',
        body: JSON.stringify({ _profile: sub, _amount: amount | 0, _reason: reason, _key: key }),
      })) as Array<Record<string, unknown>>;
      const row = rows?.[0] ?? {};
      return { credits: Number(row.credits ?? 0), duplicate: Boolean(row.duplicate) };
    },
    // Mirrors 0018_arcade_extract_loot_only.sql arcade_extract — keep in sync.
    // NOTE the four EXPLICIT parameters. This impl once declared only three
    // (sub, runToken, credits) while the interface had grown to four, and
    // TypeScript accepted it silently: a function of fewer parameters is
    // assignable to a signature with more. `credits` bound to `loot`, `bonus`
    // was dropped on the floor, and the posted body still said `_credits` —
    // so every extraction on prod 404'd against the re-signed function. Never
    // shorten this parameter list to "what the body happens to use".
    arcadeExtract: async (sub, runToken, loot, bonus) => {
      const rows = (await call('/rest/v1/rpc/arcade_extract', {
        method: 'POST',
        body: JSON.stringify({
          _profile: sub,
          _key: runToken,
          _loot: Math.max(0, loot | 0),
          _bonus: Math.max(0, bonus | 0),
        }),
      })) as Array<Record<string, unknown>>;
      const row = rows?.[0] ?? {};
      return {
        credits: Number(row.credits ?? 0),
        granted: Number(row.granted ?? 0),
        multiplierPct: Number(row.multiplier_pct ?? 0),
        drinkBudget: Number(row.drink_budget ?? 0),
        duplicate: Boolean(row.duplicate),
      };
    },
    settleItems: async (matchId, drunkRowIds) => {
      // Release everything this match claimed EXCEPT the drunk rows.
      const keep = drunkRowIds.map((r) => r | 0).join(',');
      await call(
        `/rest/v1/items?consumed_match_id=eq.${encodeURIComponent(matchId)}`
        + (keep ? `&id=not.in.(${keep})` : ''),
        { method: 'PATCH', body: JSON.stringify({ consumed_match_id: null, consumed_at: null }) },
      );
    },
    setEquipped: async (sub, rowIds) => {
      // Single-writer service role: clear-then-set is race-free enough.
      await call(
        `/rest/v1/items?profile_id=eq.${encodeURIComponent(sub)}&equipped_slot=not.is.null`,
        { method: 'PATCH', body: JSON.stringify({ equipped_slot: null }) },
      );
      const picks = rowIds.slice(0, 3);
      for (let slot = 0; slot < picks.length; slot++) {
        await call(
          `/rest/v1/items?id=eq.${picks[slot]! | 0}&profile_id=eq.${encodeURIComponent(sub)}`
          + `&consumed_match_id=is.null`,
          { method: 'PATCH', body: JSON.stringify({ equipped_slot: slot }) },
        );
      }
    },
    equippedItems: async (sub) => {
      const rows = (await call(
        `/rest/v1/items?select=id,item_id,tier,created_at,equipped_slot`
        + `&profile_id=eq.${encodeURIComponent(sub)}&equipped_slot=not.is.null`
        + `&consumed_match_id=is.null&order=equipped_slot.asc&limit=3`,
        { method: 'GET' },
      )) as Array<Record<string, unknown>>;
      return rows.map((r) => ({
        rowId: Number(r.id ?? 0),
        itemId: String(r.item_id ?? ''),
        tier: Number(r.tier ?? 1),
        createdAt: String(r.created_at ?? ''),
        equippedSlot: r.equipped_slot === null ? null : Number(r.equipped_slot),
      }));
    },
  };
};

/**
 * Production Supabase when configured; otherwise the dev in-memory economy —
 * but only when asked for BY NAME (AF_ALLOW_DEV_ECONOMY=1).
 *
 * Fail closed: memoryPersistence is `dev: true`, and that flag makes the
 * server mint a name-keyed identity for any client that asks (server.ts
 * `hello`) and lets /me authenticate on a plain X-Dev-Name header. Harmless
 * on a laptop, catastrophic on a public host — anyone could wear anyone's
 * account and mint credits. A missing env var must never be the difference.
 */
export const createPersistence = (): Persistence => {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (url && key) return supabasePersistence(url, key);
  if (process.env.AF_ALLOW_DEV_ECONOMY !== '1') {
    throw new Error(
      'SUPABASE_URL / SUPABASE_SERVICE_KEY are unset, so the only economy '
      + 'available is the in-memory dev one — which accepts any identity a '
      + 'client claims. Refusing to start. Set both vars (production), or set '
      + 'AF_ALLOW_DEV_ECONOMY=1 to opt into a throwaway local economy.',
    );
  }
  console.log('[persist] DEV in-memory economy (AF_ALLOW_DEV_ECONOMY=1) — identities are UNVERIFIED, nothing is durable');
  return memoryPersistence();
};
