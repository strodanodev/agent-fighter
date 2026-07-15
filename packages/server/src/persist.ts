/**
 * Supabase persistence for the match server (ADR 0003, Phase B).
 *
 * Deliberately thin: ONE PostgREST RPC per finished match. All award logic
 * (XP, W-L, level-ups) lives in the `record_match` Postgres function
 * (supabase/migrations/0001_online_profiles.sql) so it is atomic and
 * idempotent by match id — a server restart or double callback can never
 * double-award. The service-role key stays server-side only; clients have
 * no write path at all (RLS is read-only for them).
 *
 * Everything degrades to null/no-op when SUPABASE_URL / SUPABASE_SERVICE_KEY
 * are unset — offline dev and CI run the exact same code path minus the fetch.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AirIdentity } from './airjwt.js';

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

export interface MatchRecord {
  matchId: string;
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
  gained: number;
  levelsUp: number;
  level: number;
  xp: number;
  wins: number;
  losses: number;
}

export interface Persistence {
  /** Record + award. Resolves to per-authenticated-side awards ([] on retry). */
  recordMatch: (r: MatchRecord) => Promise<XpAward[]>;
  /** Top of the public leaderboard view (for the HTTP endpoint). */
  leaderboard: (limit?: number) => Promise<unknown[]>;
}

export const createPersistence = (
  env: { url?: string; serviceKey?: string } = {
    url: process.env.SUPABASE_URL,
    serviceKey: process.env.SUPABASE_SERVICE_KEY,
  },
): Persistence | null => {
  const url = env.url?.replace(/\/+$/, '');
  const key = env.serviceKey;
  if (!url || !key) return null;

  const call = async (path: string, init: RequestInit): Promise<unknown> => {
    const res = await fetch(`${url}${path}`, {
      ...init,
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    });
    if (!res.ok) throw new Error(`supabase ${path} → ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.json();
  };

  return {
    recordMatch: async (r) => {
      const rows = (await call('/rest/v1/rpc/record_match', {
        method: 'POST',
        body: JSON.stringify({
          _id: r.matchId,
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
      }));
    },
    leaderboard: async (limit = 20) =>
      (await call(`/rest/v1/leaderboard?select=*&limit=${limit | 0}`, { method: 'GET' })) as unknown[],
  };
};
