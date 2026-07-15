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
 *  · solo (RANKED VS AGENT, house bot): fee 1 → escrowed at match start.
 *    Win: +2 back (net +1) and +60 XP. Loss: fee burned, −15 XP (clamped at
 *    the level floor — no de-leveling). Draw/incomplete: fee refunded.
 *  · wager (ONLINE): fee 10 each → 20 pot. Winner takes the pot (net +10).
 *    Draw/undecided/incomplete: both refunded. A hash-flagged DEVIATOR
 *    forfeits: the pot goes to the opponent regardless of the sim outcome.
 *    Forfeit (rage-quit) already resolves winner = the non-quitter.
 *  · XP (wager): win 60 / loss 20 / draw 30 — unchanged from Phase B.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AirIdentity } from './airjwt.js';

export const DAILY_CREDITS = 10;
export const SOLO_FEE = 1;
export const WAGER_FEE = 10;
/** Solo winner gets the fee back + this profit. */
export const SOLO_WIN_NET = 1;
/** XP burned by LOSING a ranked solo match (the user-facing "loser loses XP"). */
export const SOLO_LOSS_XP = 15;
export const XP_WIN = 60;
export const XP_LOSS = 20;
export const XP_DRAW = 30;
export const MAX_LEVEL = 40;
const xpForNext = (level: number): number => 80 + level * 45;

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

export type MatchMode = 'wager' | 'solo';

export interface Account {
  credits: number;
  level: number;
  xp: number;
  wins: number;
  losses: number;
  /** True when THIS call granted the daily bonus (client shows a toast). */
  dailyGranted: boolean;
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
}

/** Thrown by escrowMatch when a side can't cover the fee. */
export class InsufficientCredits extends Error {
  constructor(public side: 0 | 1) { super(`INSUFFICIENT:${side}`); }
}

export interface Persistence {
  /** Dev economy (name-keyed identities allowed, nothing durable). */
  dev: boolean;
  /** Upsert profile, claim the daily bonus if due, return the account. */
  getAccount: (identity: AirIdentity, name: string, agent: boolean) => Promise<Account>;
  /** Deduct the fee from every AUTHENTICATED side, atomically (all or none). */
  escrowMatch: (matchId: string, subs: [string | null, string | null], fee: number) => Promise<void>;
  /** Settle + award. Idempotent by match id ([] on retry). */
  recordMatch: (r: MatchRecord) => Promise<XpAward[]>;
  leaderboard: (limit?: number) => Promise<unknown[]>;
}

// ---------------------------------------------------------------- shared math
interface ProfileRow {
  credits: number; level: number; xp: number; wins: number; losses: number;
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
    payout = won ? r.fee * 2 : draw ? r.fee : 0;
    xpDelta = iDeviated ? 0 : won ? XP_WIN : draw ? XP_DRAW : XP_LOSS;
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
  const escrows = new Map<string, Set<string>>(); // matchId → subs charged
  const names = new Map<string, { name: string; agent: boolean }>();

  const prof = (sub: string): ProfileRow & { lastDaily: string } => {
    let p = profiles.get(sub);
    if (!p) {
      p = { credits: 0, level: 1, xp: 0, wins: 0, losses: 0, lastDaily: '' };
      profiles.set(sub, p);
    }
    return p;
  };

  return {
    dev: true,
    getAccount: async (identity, name, agent) => {
      const p = prof(identity.sub);
      names.set(identity.sub, { name, agent });
      const today = new Date().toISOString().slice(0, 10);
      const dailyGranted = p.lastDaily !== today;
      if (dailyGranted) {
        p.lastDaily = today;
        p.credits += DAILY_CREDITS;
      }
      return { credits: p.credits, level: p.level, xp: p.xp, wins: p.wins, losses: p.losses, dailyGranted };
    },
    escrowMatch: async (matchId, subs, fee) => {
      const charged = escrows.get(matchId) ?? new Set<string>();
      escrows.set(matchId, charged);
      const due = ([0, 1] as const).filter((s) => subs[s] && !charged.has(subs[s]!));
      for (const s of due) if (prof(subs[s]!).credits < fee) throw new InsufficientCredits(s);
      for (const s of due) {
        prof(subs[s]!).credits -= fee;
        charged.add(subs[s]!);
      }
    },
    recordMatch: async (r) => {
      if (settled.has(r.matchId)) return [];
      settled.add(r.matchId);
      const out: XpAward[] = [];
      for (const side of [0, 1] as const) {
        const sub = r.identities[side]?.sub;
        if (!sub) continue;
        const p = prof(sub);
        const s = settleSide(p, r, side);
        out.push({
          side, gained: s.xpDelta, levelsUp: s.ups,
          level: p.level, xp: p.xp, wins: p.wins, losses: p.losses,
          creditsDelta: s.payout - r.fee, credits: p.credits,
        });
      }
      return out;
    },
    leaderboard: async (limit = 20) =>
      [...profiles.entries()]
        .filter(([, p]) => p.wins + p.losses > 0)
        .sort((a, b) => b[1].level - a[1].level || b[1].xp - a[1].xp || b[1].wins - a[1].wins)
        .slice(0, limit)
        .map(([id, p], i) => ({
          id, name: names.get(id)?.name ?? 'anon', is_agent: names.get(id)?.agent ?? false,
          level: p.level, xp: p.xp, wins: p.wins, losses: p.losses, rank: i + 1,
        })),
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
    getAccount: async (identity, name, agent) => {
      const rows = (await call('/rest/v1/rpc/get_account', {
        method: 'POST',
        body: JSON.stringify({
          _id: identity.sub, _name: name, _agent: agent,
          _address: identity.address ?? null,
        }),
      })) as Array<Record<string, unknown>>;
      const row = rows[0] ?? {};
      return {
        credits: Number(row.credits ?? 0), level: Number(row.level ?? 1),
        xp: Number(row.xp ?? 0), wins: Number(row.wins ?? 0), losses: Number(row.losses ?? 0),
        dailyGranted: Boolean(row.daily_granted),
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
        }),
      })) as Array<Record<string, number>>;
      return rows.map((row) => ({
        side: (row.side! | 0) as 0 | 1,
        gained: row.gained! | 0,
        levelsUp: row.levels_up! | 0,
        level: row.level! | 0,
        xp: row.xp! | 0,
        wins: row.wins! | 0,
        losses: row.losses! | 0,
        creditsDelta: row.credits_delta! | 0,
        credits: row.credits! | 0,
      }));
    },
    leaderboard: async (limit = 20) =>
      (await call(`/rest/v1/leaderboard?select=*&limit=${limit | 0}`, { method: 'GET' })) as unknown[],
  };
};

/**
 * Production Supabase when configured; otherwise the dev in-memory economy
 * (full feature set, nothing durable, name-keyed identities allowed).
 */
export const createPersistence = (): Persistence => {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (url && key) return supabasePersistence(url, key);
  console.log('[persist] SUPABASE_URL/SUPABASE_SERVICE_KEY unset → DEV in-memory economy (not durable)');
  return memoryPersistence();
};
