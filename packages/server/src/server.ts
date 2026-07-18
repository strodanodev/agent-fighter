/**
 * Agent Fighter match server (ADR 0003, Phase A).
 *
 * Matchmaking + WebSocket relay + input ledger + result verification.
 * The server never trusts a client's account of the match: it re-simulates
 * the input ledger with @af/core (synchronously — a full match verifies in
 * well under a second, and sync execution also serializes the global
 * character slots safely) and derives the result itself.
 *
 * Run: npm run server   (or: tsx src/server.ts from packages/server)
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import {
  AI_PERSONALITY_RANGES, ENGINE_VERSION, Phase, aiPoll, createAi, createGameState,
  loadCharacter, setCharacters, stateHash, step,
} from '@af/core';
import type { CharacterBundle } from '@af/core';
import {
  ARCADE_NEXT_GRACE_MS, DEFAULT_PORT, FORFEIT_GRACE_MS, IDLE_FORFEIT_MS, INPUT_DELAY,
  PROTOCOL_VERSION, SOLO_PACE_MAX, SOLO_PACE_MIN, SOLO_PACE_SLACK_MS,
} from './protocol.js';
import type { ClientMsg, SMatch, SResult, ServerMsg } from './protocol.js';
import { verifyAirToken } from './airjwt.js';
import type { AirIdentity } from './airjwt.js';
import {
  ARCADE_CLEAR_CREDITS, ARCADE_FEE, ARCADE_MILESTONE_CREDITS,
  InsufficientCredits, SOLO_FEE, WAGER_FEE, createPersistence, loadDotEnv,
} from './persist.js';
import type { Account, MatchMode, Persistence } from './persist.js';
import { createAirIssuer, loadIssuerConfig } from './air-issuer.js';
import type { AirIssuer } from './air-issuer.js';
import { connectPageHtml } from './connect-page.js';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(here, '..', '..', '..');

/** Durable agent keys (ADR 0006): only the sha256 of a key is ever stored. */
const sha256Hex = (s: string): string => createHash('sha256').update(s).digest('hex');

/**
 * AGENT-CLASS accounts (self-signup, Minds obj. 1): sub `agent:<uuid>`.
 * Economically inert — fee 0, payout 0, no daily grant, wager unreachable
 * (it needs credits they can never hold). XP/rank only. This prefix check
 * is the single switch the whole policy hangs on.
 */
const isAgentClassSub = (sub: string | undefined | null): boolean => !!sub && sub.startsWith('agent:');

/** Abuse valves for the free agent class — plain in-memory day counters.
 *  (Reset on restart: acceptable — they bound COMPUTE, not money.) */
const dayCounter = (): { bump: (key: string, max: number) => boolean } => {
  const m = new Map<string, { day: string; n: number }>();
  return {
    /** True = under the cap (and counted); false = cap hit. */
    bump: (key, max) => {
      const day = new Date().toISOString().slice(0, 10);
      const e = m.get(key);
      if (!e || e.day !== day) { m.set(key, { day, n: 1 }); return true; }
      if (e.n >= max) return false;
      e.n++;
      return true;
    },
  };
};
const SIGNUPS_PER_IP_PER_DAY = 5;
const AGENT_BATTLES_PER_DAY = 20;

/**
 * Clamp a coached personality to the exact bounds random sampling uses
 * (core AI_PERSONALITY_RANGES) and drop unknown knobs. STYLE only, by
 * construction — there is no path from this object to skill or stats.
 */
const clampPersonality = (raw: unknown): Record<string, number> => {
  const out: Record<string, number> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, [lo, hi]] of Object.entries(AI_PERSONALITY_RANGES)) {
    const v = (raw as Record<string, unknown>)[k];
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    out[k] = Math.max(lo, Math.min(hi, v | 0));
  }
  return out;
};

// ---------------------------------------------------------------- types
interface Client {
  ws: WebSocket;
  id: string;
  name: string;
  agent: boolean;
  state: 'lobby' | 'queued' | 'playing';
  character: string;
  match: Match | null;
  side: 0 | 1;
  /** Verified AIR identity (null = anonymous). Set async after hello. */
  identity: AirIdentity | null;
  /** Settles when the hello token has been verified (or wasn't sent). */
  identityReady: Promise<void>;
  /** Account snapshot from persistence (null = anonymous / persistence off). */
  account: Account | null;
  /** AIR-account email — only the reputation write-back target (ADR 0004). */
  email: string;
}

interface Match {
  id: string;
  /**
   * 'friendly' (v5) lives OUTSIDE MatchMode on purpose: persistence never
   * sees it — settlement skips recordMatch entirely (no fee, no XP, no W-L,
   * no referral release), so the SQL layer needs no new mode. Everything
   * else (relay, ledger, verify, forfeit ladder, resume) is mode-agnostic.
   */
  mode: MatchMode | 'friendly';
  fee: number;
  /** Solo (v3): clients[1] is null — the opponent is the pinned AI below. */
  clients: [Client, Client | null];
  seed: number;
  stage: string;
  chars: [string, string];
  names: [string, string];
  /** Local-sim solo: the deterministic house AI the client must simulate. */
  solo: { skill: number; aiSeed: number } | null;
  /** AGENT ARCADE: the run this battle belongs to (null = not an arcade battle). */
  arcadeRun: ArcadeRun | null;
  startedAt: number; // wall clock — solo pace sanity (SOLO_PACE_*)
  /** Per-side bearer secrets for CResume — only their owners ever see them. */
  resumeTokens: [string, string];
  /** Sides whose socket has dropped — both gone = no-contest, not a forfeit. */
  gone: [boolean, boolean];
  /** Wall clock of each side's last input — silence forfeits (IDLE_FORFEIT_MS). */
  lastInputAt: [number, number];
  /** The ledger: per side, inputs by tick. TCP keeps them in order. */
  inputs: [number[], number[]];
  /** Client-reported state hashes by tick (forensics). */
  hashes: [Map<number, number>, Map<number, number>];
  overAt: [number, number]; // -1 until a side reports MatchOver
  finished: boolean;
  forfeitTimer: NodeJS.Timeout | null;
}

export interface MatchServer {
  port: number;
  close: () => void;
}

/**
 * AGENT ARCADE run state (v4). Server-authoritative: the opponent order, the
 * skill ramp, and the milestone payouts all live HERE — a hacked client can't
 * pick easy opponents, replay a battle, or claim a deeper position. The token
 * is a bearer secret issued in the battle-1 setup and re-armed per win; it is
 * additionally pinned to the account that started the run.
 */
interface ArcadeRun {
  token: string;
  /** Owner identity sub ('' when persistence is off — tests). */
  sub: string;
  /** The fighter locked for the whole run (no switching, server-enforced). */
  charId: string;
  /** Shuffled opponent character ids — the whole gauntlet, in order. */
  opponents: string[];
  /** 0-based index of the battle currently being played (or up next). */
  battle: number;
  /** True between a verified win and the next battle's queue. */
  awaitingNext: boolean;
  lastActive: number;
}

/** Battles cleared → credits due AT that clear (milestones + full-clear). */
export const arcadeMilestonePayout = (cleared: number, total: number): number => {
  const m1 = Math.ceil(total / 3);
  const m2 = Math.ceil((2 * total) / 3);
  let pay = 0;
  if (cleared === m1 && m1 < total) pay += ARCADE_MILESTONE_CREDITS;
  if (cleared === m2 && m2 < total && m2 !== m1) pay += ARCADE_MILESTONE_CREDITS;
  if (cleared === total) pay += ARCADE_CLEAR_CREDITS;
  return pay;
};

/**
 * The gauntlet difficulty ramp: battle 1 is winnable by a newcomer, the last
 * battle plays near the AI's ceiling. Deliberately NOT level-scaled — every
 * player faces the same ramp, so ranked arcade records are comparable.
 */
const ARCADE_SKILL_MIN = 35;
const ARCADE_SKILL_MAX = 95;
export const defaultArcadeSkill = (battle: number, total: number): number =>
  Math.round(ARCADE_SKILL_MIN
    + (ARCADE_SKILL_MAX - ARCADE_SKILL_MIN) * (total <= 1 ? 1 : battle / (total - 1)));

// ---------------------------------------------------------------- verify
interface VerifyOutcome {
  winner: number;
  rounds: [number, number];
  endTick: number;
  hash: number;
  reachedEnd: boolean;
}

/**
 * Re-simulate the ledger and derive the result. Synchronous on purpose:
 * verification is the trust anchor and Node's single thread makes the
 * global character slots race-free without locks.
 */
const verifyLedger = (
  bundles: [CharacterBundle, CharacterBundle],
  seed: number,
  inputs: [number[], number[]],
): VerifyOutcome => {
  setCharacters(loadCharacter(bundles[0]), loadCharacter(bundles[1]));
  const g = createGameState(seed);
  const n = Math.min(inputs[0].length, inputs[1].length);
  let t = 0;
  while (g.phase !== Phase.MatchOver && t < n) {
    step(g, [inputs[0][t]! | 0, inputs[1][t]! | 0]);
    t++;
  }
  return {
    winner: g.phase === Phase.MatchOver ? g.winner : -1,
    rounds: [g.roundsWon0, g.roundsWon1],
    endTick: t,
    hash: stateHash(g),
    reachedEnd: g.phase === Phase.MatchOver,
  };
};

/**
 * LOCAL-SIM SOLO verification (protocol v3): the client streamed only ITS
 * inputs; the opponent is re-derived here from the pinned deterministic AI —
 * same (skill, aiSeed), same aiPoll-before-step ordering as the client. A
 * client that simulated any other opponent produces different hashes and a
 * different outcome, so the house cannot be puppeteered.
 */
const verifySoloLedger = (
  bundles: [CharacterBundle, CharacterBundle],
  seed: number,
  playerInputs: number[],
  solo: { skill: number; aiSeed: number },
  stopAtTick = Number.MAX_SAFE_INTEGER,
): VerifyOutcome => {
  setCharacters(loadCharacter(bundles[0]), loadCharacter(bundles[1]));
  const g = createGameState(seed);
  const ai = createAi(1, solo.skill, solo.aiSeed);
  let t = 0;
  while (g.phase !== Phase.MatchOver && t < playerInputs.length && t < stopAtTick) {
    const opp = aiPoll(ai, g);
    step(g, [playerInputs[t]! | 0, opp]);
    t++;
  }
  return {
    winner: g.phase === Phase.MatchOver ? g.winner : -1,
    rounds: [g.roundsWon0, g.roundsWon1],
    endTick: t,
    hash: stateHash(g),
    reachedEnd: g.phase === Phase.MatchOver,
  };
};

// ---------------------------------------------------------------- server
export const createMatchServer = (opts: {
  port?: number;
  root?: string;
  /** Test hook: overrides the Supabase-backed persistence (null = off). */
  persistence?: Persistence | null;
  /** Test hook: skip the solo wall-clock pace sanity (tests sim >>realtime). */
  noPaceCheck?: boolean;
  /** Test hook: overrides the env-configured AIR issuer (null = off). */
  airIssuer?: AirIssuer | null;
  /** Test hook: overrides the arcade difficulty ramp (battle, total) → skill. */
  arcadeSkill?: (battle: number, total: number) => number;
} = {}): Promise<MatchServer> => {
  const root = opts.root ?? REPO_ROOT;
  const charactersDir = join(root, 'characters');
  const stagesDir = join(root, 'stages');
  loadDotEnv(root); // SUPABASE_URL / SUPABASE_SERVICE_KEY / AIR_* config
  const persistence = opts.persistence !== undefined ? opts.persistence : createPersistence();
  // AIR reputation write-back (ADR 0004) — on only when fully configured.
  const airCfg = opts.airIssuer === undefined ? loadIssuerConfig(root) : null;
  const airIssuer: AirIssuer | null = opts.airIssuer !== undefined
    ? opts.airIssuer
    : airCfg ? createAirIssuer(airCfg) : null;
  console.log(`[air] reputation write-back ${airIssuer ? `ON → ${airCfg?.apiUrl ?? 'custom'}` : 'off (set AIR_ISSUER_DID + AIR_CREDENTIAL_ID + key)'}`);

  const bundleOf = (id: string): CharacterBundle => {
    const file = join(charactersDir, id, 'character.json');
    return JSON.parse(readFileSync(file, 'utf8')) as CharacterBundle;
  };
  const listIds = (dir: string, marker: string): string[] =>
    existsSync(dir)
      ? readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, marker)))
        .map((d) => d.name)
      : [];
  const characterIds = listIds(charactersDir, 'character.json');
  const stageIds = listIds(stagesDir, 'stage.json');
  /** The playable roster (meta.disabled mirrors the client's select screen). */
  const enabledCharacterIds = characterIds.filter((id) => {
    const meta = (bundleOf(id) as { meta?: { disabled?: boolean } }).meta;
    return !meta?.disabled;
  });
  const arcadeSkill = opts.arcadeSkill ?? defaultArcadeSkill;

  const clients = new Set<Client>();
  const queue: Client[] = [];
  /**
   * Friendly rendezvous (v5): room code → the player parked in it, waiting.
   * Symmetric by design — the server pairs ANY two sockets presenting the
   * same code and never cares whose ref_code it happens to be. No fee is
   * escrowed, so a waiter who never gets a challenger strands nothing.
   */
  const rooms = new Map<string, Client>();
  /** In-flight matches by id — the CResume lookup. */
  const liveMatches = new Map<string, Match>();
  /** AGENT ARCADE runs by token (v4). */
  const arcadeRuns = new Map<string, ArcadeRun>();
  // Free-tier abuse valves (agent class): per-sub battles, per-IP signups.
  const agentBattleCap = dayCounter();
  const signupCap = dayCounter();
  // Coach-write throttle: keys carry the hour, so the day-counter acts hourly.
  const putCap = dayCounter();
  const PUTS_PER_HOUR = 30;
  let nextId = 1;
  let nextMatch = 1;
  let matchSeed = (Date.now() % 100_000) | 0; // server-side is allowed wall clock
  /**
   * Match ids must be unique ACROSS server lifetimes, not just within one:
   * the DB's record_match/escrow_match are idempotent BY MATCH ID, so a
   * plain per-process counter (`m1, m2, …`) collides with rows from before
   * a restart and every colliding settlement silently no-ops — XP/W-L and
   * credit payouts vanish with no error anywhere. (Found live: prod had
   * m1/m11/m13 from three different days.) The epoch prefix makes each
   * process's sequence disjoint; the counter keeps ids readable in logs.
   */
  const matchEpoch = `${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
  const newMatchId = (): string => `m${matchEpoch}-${nextMatch++}`;
  /** Filled once http.listen resolves — house bots dial back to this port. */

  const send = (c: Client, msg: ServerMsg): void => {
    if (c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify(msg));
  };

  const finishMatch = (m: Match, forfeitLoser: 0 | 1 | null): void => {
    if (m.finished) return;
    m.finished = true;
    liveMatches.delete(m.id);
    if (m.forfeitTimer) clearTimeout(m.forfeitTimer);

    const bundles: [CharacterBundle, CharacterBundle] = [bundleOf(m.chars[0]), bundleOf(m.chars[1])];
    const verify = (): VerifyOutcome => (m.solo
      ? verifySoloLedger(bundles, m.seed, m.inputs[0], m.solo)
      : verifyLedger(bundles, m.seed, m.inputs));

    const v = verify();
    // Desync forensics: whose reported hashes diverge from the re-sim?
    // Solo has one human side; the opponent is the server's own AI.
    let deviator: 0 | 1 | undefined;
    outer:
    for (const side of (m.solo ? [0] : [0, 1]) as (0 | 1)[]) {
      for (const [tick, h] of m.hashes[side]) {
        if (tick > v.endTick) continue;
        const truth = replayHashAt(m, tick);
        if (truth !== null && truth !== h) {
          console.log(`[match ${m.id}] hash mismatch side=${side} tick=${tick} reported=${h} truth=${truth}`);
          deviator = side;
          break outer;
        }
      }
    }

    // THE SETTLEMENT LADDER (ADR 0003/0005). The input ledger is the truth;
    // a dropped socket never overrules it:
    //  1. Ledger reached MatchOver → VERIFIED, whatever happened to the
    //     connections. Winning and then losing your wifi still wins; ragequit
    //     after the final KO still loses. This closes the "pull the cable the
    //     instant you lose" hole AND protects an honest winner from a blip.
    //  2. Undecided + exactly one side gone/silent → FORFEIT, that side loses.
    //  3. Undecided + nobody to blame (both gone, server shutdown) →
    //     INCOMPLETE, a no-contest that refunds both entry fees.
    let result: SResult;
    if (v.reachedEnd) {
      result = {
        t: 'result', winner: v.winner, reason: 'verified',
        rounds: v.rounds, endTick: v.endTick, hash: v.hash, deviator,
      };
    } else if (forfeitLoser !== null) {
      result = {
        t: 'result', winner: 1 - forfeitLoser, reason: 'forfeit',
        rounds: v.rounds, endTick: v.endTick, hash: v.hash, deviator,
      };
    } else {
      result = {
        t: 'result', winner: -1, reason: 'incomplete',
        rounds: v.rounds, endTick: v.endTick, hash: v.hash, deviator,
      };
    }

    // Solo pace sanity: the client sims locally, so wall time is the only
    // pacing signal. Scripted fast-forward or tool-assisted slow-motion
    // settles as incomplete — fees refund, nothing progresses.
    if (m.solo && result.reason === 'verified' && !opts.noPaceCheck) {
      const simMs = result.endTick * (1000 / 60);
      const wallMs = Date.now() - m.startedAt;
      if (wallMs < simMs * SOLO_PACE_MIN || wallMs > simMs * SOLO_PACE_MAX + SOLO_PACE_SLACK_MS) {
        console.log(`[match ${m.id}] pace anomaly: wall ${Math.round(wallMs)}ms vs sim ${Math.round(simMs)}ms → incomplete`);
        result = { ...result, winner: -1, reason: 'incomplete' };
      }
    }

    // AGENT ARCADE run bookkeeping — decided BEFORE the async persistence so
    // the milestone payout rides the same record_match settlement.
    let arcadePayout = 0;
    const run = m.arcadeRun;
    if (run) {
      const wonBattle = result.reason === 'verified' && result.winner === 0
        && result.deviator !== 0;
      if (wonBattle) {
        run.battle++;
        // Agent-class runs never pay credits — the rank IS the prize.
        arcadePayout = isAgentClassSub(run.sub) ? 0
          : arcadeMilestonePayout(run.battle, run.opponents.length);
        if (run.battle >= run.opponents.length) {
          arcadeRuns.delete(run.token); // FULL CLEAR — the run is complete
          console.log(`[arcade] ${m.clients[0].name} CLEARED the gauntlet (${run.opponents.length} battles)`);
        } else {
          run.awaitingNext = true; // token re-armed for the next battle
          run.lastActive = Date.now();
        }
      } else if (result.reason === 'incomplete') {
        // No-contest (network/pace): fee refunded by settlement; the run may
        // RETRY the same battle until it expires — a blip never burns a run.
        run.awaitingNext = true;
        run.lastActive = Date.now();
      } else {
        arcadeRuns.delete(run.token); // loss, draw, or forfeit — GAME OVER
      }
    }

    for (const c of m.clients) {
      if (!c) continue;
      send(c, result);
      c.state = 'lobby';
      c.match = null;
    }
    console.log(`[match ${m.id}] ${result.reason}: winner=${result.winner} ticks=${result.endTick}`);
    // Persist + award XP AFTER the result is out — progression is async and
    // must never delay or gate the verdict. record_match is idempotent by
    // match id, so a crash-retry can't double-award.
    //
    // FRIENDLY matches skip this block ENTIRELY (the anti-collusion stance):
    // nothing was escrowed, so nothing settles — no XP, no W-L, no credit
    // movement, no referral release. The verified result above is the whole
    // payout (bragging rights). Persistence never learns the match happened.
    if (persistence && m.mode !== 'friendly') {
      void persistence.recordMatch({
        matchId: m.id, mode: m.mode, fee: m.fee, payout: arcadePayout,
        identities: [m.clients[0].identity, m.clients[1]?.identity ?? null],
        names: [m.clients[0].name, m.clients[1]?.name ?? `HOUSE AI`],
        agents: [m.clients[0].agent, m.clients[1]?.agent ?? true],
        chars: m.chars,
        winner: result.winner, reason: result.reason,
        rounds: result.rounds, endTick: result.endTick, hash: result.hash,
        deviator: result.deviator,
        engine: ENGINE_VERSION,
      }).then((awards) => {
        for (const a of awards) {
          const cl = m.clients[a.side];
          if (!cl) continue; // the house side never has an account
          // Keep the connection's snapshot fresh — the pre-queue credit
          // check reads it (escrow re-checks authoritatively anyway).
          if (cl.account) {
            cl.account = {
              ...cl.account, credits: a.credits, level: a.level,
              xp: a.xp, wins: a.wins, losses: a.losses,
            };
          }
          send(cl, {
            t: 'xp', gained: a.gained, levelsUp: a.levelsUp,
            level: a.level, xp: a.xp, wins: a.wins, losses: a.losses,
            creditsDelta: a.creditsDelta, credits: a.credits,
          });
          // AIR reputation write-back (ADR 0004): best-effort, post-award,
          // real identities only (dev accounts have no AIR side), addressed
          // to the player's own AIR email.
          const rid = cl.identity?.sub;
          if (airIssuer && rid && !rid.startsWith('dev:') && cl.email) {
            airIssuer.queueReputation(rid, cl.email, {
              level: a.level, xp: a.xp, wins: a.wins, losses: a.losses,
              credits: a.credits, is_agent: cl.agent, engine: ENGINE_VERSION,
            });
          }
        }
        // Referral dares: a settled match may make an invitee's inviter
        // payout due (their first decided match). AFTER record_match on
        // purpose — release_referral reads the matches table. Best-effort;
        // idempotent in Postgres, so a crash-retry can't double-pay.
        for (const cl of m.clients) {
          const sub = cl?.identity?.sub;
          if (!sub) continue;
          void persistence.releaseReferral(sub).then((paid) => {
            if (paid > 0) console.log(`[referral] inviter of ${sub} paid +${paid}`);
          }).catch((e) => console.log(`[referral] release for ${sub} failed: ${String(e)}`));
        }
      }).catch((e) => console.log(`[match ${m.id}] persist failed: ${String(e)}`));
    }
    if (process.env.AF_DEBUG_LEDGER) {
      // Forensics: dump the canonical ledger for offline diffing (sync — the
      // fs import at module top; async here raced process lifetime).
      try {
        writeFileSync(
          join(process.env.AF_DEBUG_LEDGER, `ledger-${m.id}.json`),
          JSON.stringify({ seed: m.seed, chars: m.chars, inputs: m.inputs, result }),
        );
      } catch (e) {
        console.log(`ledger dump failed: ${String(e)}`);
      }
    }
  };

  /** Ground-truth hash at a tick (re-sim prefix) — only used on suspicion. */
  const replayHashAt = (m: Match, tick: number): number | null => {
    if (m.solo) {
      if (tick > m.inputs[0].length) return null;
      return verifySoloLedger(
        [bundleOf(m.chars[0]), bundleOf(m.chars[1])], m.seed, m.inputs[0], m.solo, tick,
      ).hash;
    }
    const n = Math.min(m.inputs[0].length, m.inputs[1].length);
    if (tick > n) return null;
    setCharacters(loadCharacter(bundleOf(m.chars[0])), loadCharacter(bundleOf(m.chars[1])));
    const g = createGameState(m.seed);
    for (let t = 0; t < tick && g.phase !== Phase.MatchOver; t++) {
      step(g, [m.inputs[0][t]! | 0, m.inputs[1][t]! | 0]);
    }
    return stateHash(g);
  };

  const startMatch = (
    c0: Client, c1: Client | null, mode: MatchMode | 'friendly', fee: number, id?: string,
    solo?: { skill: number; aiSeed: number; character: string; level: number },
    arcadeRun?: ArcadeRun,
  ): void => {
    // Arcade battles bill as the character, not "HOUSE": the run IS the mode.
    const houseName = arcadeRun
      ? `${(bundleOf(solo!.character) as { name?: string }).name ?? solo!.character} · ${arcadeRun.battle + 1}/${arcadeRun.opponents.length}`.toUpperCase()
      : `HOUSE LV${solo?.level ?? 1}`;
    const m: Match = {
      id: id ?? newMatchId(),
      mode, fee,
      clients: [c0, c1],
      seed: (matchSeed = (matchSeed * 1103515245 + 12345) & 0x7fffffff),
      stage: stageIds.length > 0 ? stageIds[matchSeed % stageIds.length]! : '',
      chars: [c0.character, c1 ? c1.character : solo!.character],
      names: [c0.name, c1?.name ?? houseName],
      solo: solo ? { skill: solo.skill, aiSeed: solo.aiSeed } : null,
      arcadeRun: arcadeRun ?? null,
      startedAt: Date.now(),
      resumeTokens: [randomUUID(), randomUUID()],
      gone: [false, false],
      lastInputAt: [Date.now(), Date.now()],
      inputs: [[], []],
      hashes: [new Map(), new Map()],
      overAt: [-1, -1],
      finished: false,
      forfeitTimer: null,
    };
    c0.match = m; c0.side = 0; c0.state = 'playing';
    if (c1) { c1.match = m; c1.side = 1; c1.state = 'playing'; }

    const oppName = c1?.name ?? `HOUSE LV${solo!.level}`;
    for (const c of m.clients) {
      if (!c) continue;
      const setup: SMatch = {
        t: 'match', matchId: m.id, side: c.side, seed: m.seed, stage: m.stage,
        // Local-sim solo has NO input scheduling at all — zero added latency.
        delay: m.solo ? 0 : INPUT_DELAY,
        chars: [
          { id: m.chars[0], hash: bundleOf(m.chars[0]).versionHash },
          { id: m.chars[1], hash: bundleOf(m.chars[1]).versionHash },
        ],
        names: m.names,
        agents: [m.clients[0].agent, c1?.agent ?? true],
        mode, fee,
        solo: m.solo ?? undefined,
        arcade: arcadeRun
          ? { battle: arcadeRun.battle, total: arcadeRun.opponents.length, token: arcadeRun.token }
          : undefined,
        resume: m.resumeTokens[c.side],
      };
      send(c, setup);
    }
    liveMatches.set(m.id, m);
    console.log(`[match ${m.id}] ${mode}·fee ${fee} · ${c0.name}${c0.agent ? ' (agent)' : ''} vs ${oppName}${c1?.agent ? ' (agent)' : ''} · seed ${m.seed} · stage ${m.stage}`);
  };

  /**
   * ESCROW at pair time (M5): both entrance fees are charged atomically
   * before the match setup goes out. Refunds happen in record_match for
   * draws/incompletes. When persistence is off (tests), play is free.
   */
  let pairing = false;
  const tryPair = async (): Promise<void> => {
    if (pairing) return; // escrow awaits — re-entered via the tail call below
    pairing = true;
    try {
      while (queue.length >= 2) {
        const c0 = queue.shift()!;
        const c1 = queue.shift()!;
        if (c0.ws.readyState !== WebSocket.OPEN) { queue.unshift(c1); continue; }
        if (c1.ws.readyState !== WebSocket.OPEN) { queue.unshift(c0); continue; }

        const fee = persistence ? WAGER_FEE : 0;
        // Allocate the id BEFORE the escrow await — a concurrent solo match
        // starting mid-await must not steal it (the escrow rows key on it).
        const matchId = newMatchId();
        if (fee > 0) {
          try {
            await persistence!.escrowMatch(matchId, [c0.identity!.sub, c1.identity!.sub], fee);
          } catch (e) {
            const poor = e instanceof InsufficientCredits ? e.side : 0;
            const [broke, ok] = poor === 0 ? [c0, c1] : [c1, c0];
            broke.state = 'lobby';
            send(broke, { t: 'error', code: 'credits', msg: `wager needs ${fee} credits` });
            queue.unshift(ok);
            continue;
          }
          // Client vanished between escrow and setup → record as incomplete
          // immediately so the fees refund (the match id is already charged).
          if (c0.ws.readyState !== WebSocket.OPEN || c1.ws.readyState !== WebSocket.OPEN) {
            startMatch(c0, c1, 'wager', fee, matchId);
            finishMatch(c0.match!, null);
            continue;
          }
        }
        startMatch(c0, c1, 'wager', fee, matchId);
      }
    } finally {
      pairing = false;
    }
    if (queue.length >= 2) void tryPair();
  };

  /**
   * Ranked solo (v3): no house-bot process, no relay. Escrow the fee, pin a
   * deterministic house AI (skill from the player's level), and hand the
   * whole sim to the client — verification re-derives the same AI.
   */
  const startSolo = async (c: Client): Promise<void> => {
    const fee = persistence ? SOLO_FEE : 0;
    const matchId = newMatchId();
    if (fee > 0) {
      try {
        await persistence!.escrowMatch(matchId, [c.identity?.sub ?? null, null], fee);
      } catch {
        c.state = 'lobby';
        return send(c, { t: 'error', code: 'credits', msg: `ranked match needs ${fee} credit` });
      }
    }
    if (c.ws.readyState !== WebSocket.OPEN) {
      // Vanished after escrow → settle as incomplete so the fee refunds.
      startMatch(c, null, 'solo', fee, matchId, soloOpts(c));
      return finishMatch(c.match!, null);
    }
    startMatch(c, null, 'solo', fee, matchId, soloOpts(c));
  };

  const soloOpts = (c: Client): { skill: number; aiSeed: number; character: string; level: number } => {
    const level = c.account?.level ?? 1;
    return {
      level,
      // Same level→skill ramp as before, but floored at 40 instead of 3.
      //
      // Why the floor moved: meter decisions in ai.ts are (deliberately)
      // skill-gated, because a novice agent that cashes out bars flattens the
      // difficulty lever the whole CPU system rides on. The side effect was
      // that LV1 faced skill 3, and a skill-3 agent measurably finishes a
      // match sitting on 2857/3000 meter having thrown 2 supers — it hoards
      // three bars and dies with them. 40 is the cheapest skill that actually
      // spends meter (~20 supers / 14 matches, ~2269 leftover) and it only
      // moves the bot's win rate against a weak opponent from 47% to ~57%.
      //
      // Only the FLOOR changed: level 17+ keeps exactly its old skill, so
      // mid/high-level difficulty is untouched. Levels 1-16 now share skill 40
      // (they were 3..40 — all "harmless" tiers, so little progression is lost
      // and every one of them now uses its meter).
      //
      // Server-side only: skill rides in the `solo` setup message and the
      // client obeys it, so this needs no ENGINE_VERSION bump.
      skill: Math.max(40, Math.min(100, Math.round((level * 100) / 40))),
      character: characterIds[Math.floor(Math.random() * characterIds.length)]!,
      aiSeed: ((Date.now() % 100000) + nextMatch) | 0,
    };
  };

  /**
   * AGENT ARCADE (v4): start the run's CURRENT battle. Battle 1 escrows the
   * run's single entry fee; battles 2+ are already paid for. Each battle is
   * mechanically a local-sim solo match (pinned AI, ledger re-sim) — only
   * the fee, the opponent sequencing, and the payouts differ.
   */
  const startArcadeBattle = async (c: Client, run: ArcadeRun): Promise<void> => {
    // Agent-class runs are FREE (inert economy — XP/rank only).
    const fee = run.battle === 0 && persistence && !isAgentClassSub(run.sub) ? ARCADE_FEE : 0;
    const matchId = newMatchId();
    if (fee > 0) {
      try {
        await persistence!.escrowMatch(matchId, [c.identity?.sub ?? null, null], fee);
      } catch {
        arcadeRuns.delete(run.token);
        c.state = 'lobby';
        return send(c, { t: 'error', code: 'credits', msg: `AGENT ARCADE needs ${fee} credit` });
      }
    }
    run.awaitingNext = false;
    run.lastActive = Date.now();
    const opts = {
      level: c.account?.level ?? 1,
      skill: arcadeSkill(run.battle, run.opponents.length),
      character: run.opponents[run.battle]!,
      aiSeed: ((Date.now() % 100000) + nextMatch) | 0,
    };
    if (c.ws.readyState !== WebSocket.OPEN) {
      // Vanished after escrow → settle as incomplete so the fee refunds
      // (the run stays retryable until it expires).
      startMatch(c, null, 'arcade', fee, matchId, opts, run);
      return finishMatch(c.match!, null);
    }
    startMatch(c, null, 'arcade', fee, matchId, opts, run);
  };

  const onMessage = (c: Client, raw: string): void => {
    let msg: ClientMsg;
    try {
      msg = JSON.parse(raw) as ClientMsg;
    } catch {
      return send(c, { t: 'error', msg: 'bad json' });
    }

    switch (msg.t) {
      case 'hello': {
        if (msg.v !== PROTOCOL_VERSION) return send(c, { t: 'error', msg: `protocol ${PROTOCOL_VERSION} required` });
        if (msg.engine !== ENGINE_VERSION) return send(c, { t: 'error', msg: `engine ${ENGINE_VERSION} required (got ${msg.engine})` });
        c.name = String(msg.name ?? 'anon').slice(0, 24) || 'anon';
        c.agent = !!msg.agent;
        // Attestation target only — progression keys on the VERIFIED sub.
        const email = String(msg.email ?? '').slice(0, 120);
        c.email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '';
        // Identity + account resolve async — the welcome goes out immediately
        // and queueing AWAITS identityReady (fees need a verified account).
        const auth = typeof msg.auth === 'string' && msg.auth ? msg.auth : null;
        const agentKey = typeof msg.agentKey === 'string' && msg.agentKey ? msg.agentKey : null;
        c.identityReady = (async () => {
          if (auth) {
            c.identity = await verifyAirToken(auth);
            if (c.identity) console.log(`[auth] ${c.name} = ${c.identity.sub}${c.identity.address ? ` (${c.identity.address.slice(0, 10)}…)` : ''}`);
          }
          if (!c.identity && agentKey && persistence) {
            // Durable agent key (ADR 0006): plays as the OWNER's profile,
            // always as a DECLARED agent — a key can never masquerade as its
            // owner's human hands.
            const owner = await persistence.findByAgentKey(sha256Hex(agentKey));
            if (owner) {
              c.identity = { sub: owner.sub };
              c.agent = true;
              console.log(`[auth] ${c.name} = ${owner.sub} (agent key)`);
            }
          }
          if (!c.identity && persistence?.dev) {
            // DEV economy only: name-keyed identity so the whole credit loop
            // runs without AIR/Supabase. supabasePersistence never does this.
            c.identity = { sub: `dev:${c.name}` };
          }
          if (c.identity && persistence) {
            try {
              if (isAgentClassSub(c.identity.sub)) {
                // Inert agent class: NEVER route through getAccount (it
                // grants the daily). Snapshot from the profile, credits 0.
                const info = await persistence.getAgent(c.identity.sub);
                c.account = {
                  credits: 0, level: info?.level ?? 1, xp: info?.xp ?? 0,
                  wins: info?.wins ?? 0, losses: info?.losses ?? 0,
                  dailyGranted: false, refCode: '', referralGranted: 0,
                  daresAccepted: 0, daresPaidWeek: 0,
                };
                if (info) c.name = info.name; // signup name wins over hello
                send(c, { t: 'account', ...c.account });
              } else {
                // Referral dare code (?ref= link) — redeemed once, best-effort.
                const ref = typeof msg.ref === 'string' ? msg.ref.slice(0, 40) : undefined;
                c.account = await persistence.getAccount(c.identity, c.name, c.agent, ref);
                send(c, { t: 'account', ...c.account });
              }
            } catch (e) {
              console.log(`[account] ${c.name}: ${String(e)}`);
            }
          }
        })();
        return send(c, { t: 'welcome', id: c.id, engine: ENGINE_VERSION });
      }
      case 'queue': {
        if (c.state !== 'lobby') return;
        if (!characterIds.includes(msg.character)) {
          return send(c, { t: 'error', msg: `unknown character "${msg.character}"` });
        }
        // Bundle pinning: the client must be playing the same data we verify with.
        const serverHash = bundleOf(msg.character).versionHash;
        if (msg.bundleHash && serverHash && msg.bundleHash !== serverHash) {
          return send(c, { t: 'error', msg: `bundle hash mismatch for ${msg.character}` });
        }
        c.character = msg.character;

        const mode: MatchMode | 'friendly' = msg.mode === 'solo' ? 'solo'
          : msg.mode === 'arcade' ? 'arcade'
          : msg.mode === 'friendly' ? 'friendly'
          : 'wager';
        const runToken = typeof msg.runToken === 'string' ? msg.runToken : '';
        void (async () => {
          await c.identityReady;
          if (c.state !== 'lobby' || c.ws.readyState !== WebSocket.OPEN) return;
          if (persistence && !c.identity) {
            return send(c, { t: 'error', code: 'auth', msg: 'sign in to play online matches' });
          }
          if (mode === 'friendly') {
            // Private challenge (v5): symmetric rendezvous by room code —
            // first arrival parks, second pairs. FREE and UNRANKED (see
            // protocol.ts CQueue); no escrow, no credit pre-check. Same
            // room string, same shape rules as dare codes.
            const room = String(msg.room ?? '').trim().toUpperCase();
            if (!/^[A-Z0-9-]{3,40}$/.test(room)) {
              return send(c, { t: 'error', msg: 'friendly challenge needs a room code' });
            }
            const waiter = rooms.get(room);
            if (waiter && waiter !== c && waiter.ws.readyState === WebSocket.OPEN && waiter.state === 'queued') {
              rooms.delete(room);
              c.state = 'queued';
              send(c, { t: 'queued' });
              return startMatch(waiter, c, 'friendly', 0);
            }
            // Empty room (or a stale/dead waiter) → this client becomes the
            // waiter. Overwriting a dead entry is the cleanup path.
            rooms.set(room, c);
            c.state = 'queued';
            return send(c, { t: 'queued' });
          }
          if (mode === 'arcade') {
            // AGENT ARCADE continuation: a valid run token re-enters the run
            // (fee already consumed). Everything about the token is
            // validated — owner, phase, and the locked fighter.
            const run = runToken ? arcadeRuns.get(runToken) : undefined;
            if (runToken && !run) {
              return send(c, { t: 'error', msg: 'arcade run is over — enter again from the title' });
            }
            if (run) {
              if (run.sub !== (c.identity?.sub ?? '')) {
                return send(c, { t: 'error', code: 'auth', msg: 'not your arcade run' });
              }
              if (!run.awaitingNext) {
                return send(c, { t: 'error', msg: 'arcade run is not awaiting a battle' });
              }
              if (run.charId !== c.character) {
                return send(c, { t: 'error', msg: 'your fighter is locked for the whole arcade run' });
              }
              if (isAgentClassSub(c.identity?.sub)
                && !agentBattleCap.bump(c.identity!.sub, AGENT_BATTLES_PER_DAY)) {
                return send(c, { t: 'error', msg: `agent accounts get ${AGENT_BATTLES_PER_DAY} arcade battles/day — the run resumes tomorrow` });
              }
              c.state = 'queued';
              send(c, { t: 'queued' });
              return startArcadeBattle(c, run);
            }
            // New run: 1 credit buys the whole gauntlet — except for the
            // inert AGENT CLASS, which plays FREE (XP/rank only) under a
            // per-day battle cap (compute is the resource being protected).
            const agentClass = isAgentClassSub(c.identity?.sub);
            if (agentClass && !agentBattleCap.bump(c.identity!.sub, AGENT_BATTLES_PER_DAY)) {
              return send(c, { t: 'error', msg: `agent accounts get ${AGENT_BATTLES_PER_DAY} arcade battles/day — come back tomorrow` });
            }
            if (!agentClass && persistence && (c.account?.credits ?? 0) < ARCADE_FEE) {
              return send(c, { t: 'error', code: 'credits', msg: `AGENT ARCADE needs ${ARCADE_FEE} credit` });
            }
            const opponents = enabledCharacterIds.filter((id) => id !== c.character);
            for (let i = opponents.length - 1; i > 0; i--) {
              const j = Math.floor(Math.random() * (i + 1));
              [opponents[i], opponents[j]] = [opponents[j]!, opponents[i]!];
            }
            if (opponents.length === 0) opponents.push(c.character); // roster of 1 → mirror
            const fresh: ArcadeRun = {
              token: randomUUID(),
              sub: c.identity?.sub ?? '',
              charId: c.character,
              opponents,
              battle: 0,
              awaitingNext: false,
              lastActive: Date.now(),
            };
            arcadeRuns.set(fresh.token, fresh);
            c.state = 'queued';
            send(c, { t: 'queued' });
            return startArcadeBattle(c, fresh);
          }
          // Fast pre-check for a friendly error; escrow re-checks atomically.
          const fee = mode === 'solo' ? SOLO_FEE : WAGER_FEE;
          if (persistence && (c.account?.credits ?? 0) < fee) {
            return send(c, { t: 'error', code: 'credits', msg: `${mode === 'solo' ? 'ranked' : 'wager'} match needs ${fee} credit${fee > 1 ? 's' : ''}` });
          }
          c.state = 'queued';
          send(c, { t: 'queued' });
          if (mode === 'solo') await startSolo(c);
          else { queue.push(c); void tryPair(); }
        })();
        return;
      }
      case 'resume': {
        // Rejoin a live match after a drop (ADR 0005): possession of the
        // per-side bearer token IS the authorization — only its owner ever
        // received it. The whole ledger goes back so the client can rebuild
        // its sim by replay and continue exactly where the match really is.
        if (c.state !== 'lobby') return send(c, { t: 'error', msg: 'already in a match' });
        const m = liveMatches.get(String(msg.matchId));
        const side = m && !m.finished
          ? ([0, 1] as const).find((s) => m.resumeTokens[s] === msg.token && m.clients[s] !== null)
          : undefined;
        if (!m || side === undefined) {
          return send(c, { t: 'error', msg: 'match is gone or already settled' });
        }
        const prev = m.clients[side]!;
        if (prev.ws.readyState === WebSocket.OPEN && prev !== c) {
          try { prev.ws.close(); } catch { /* stale socket */ }
        }
        // Adopt the seat, keeping the ORIGINAL identity/name — settlement and
        // the opponent's HUD must not change because a socket did.
        c.name = prev.name;
        c.agent = prev.agent;
        c.identity = prev.identity;
        c.account = prev.account;
        c.email = prev.email;
        c.character = prev.character;
        c.match = m;
        c.side = side;
        c.state = 'playing';
        m.clients[side] = c;
        m.gone[side] = false;
        m.lastInputAt[side] = Date.now();
        if (m.forfeitTimer) { clearTimeout(m.forfeitTimer); m.forfeitTimer = null; }
        // If the OTHER side is still gone, its clock restarts now — it keeps
        // its own full grace window rather than inheriting a half-spent one.
        const otherGone = ([0, 1] as const).find((s) => m.gone[s] && m.clients[s]);
        if (otherGone !== undefined) {
          m.forfeitTimer = setTimeout(() => {
            if (!m.finished) finishMatch(m, otherGone);
          }, FORFEIT_GRACE_MS);
        }
        const toNullable = (a: number[]): (number | null)[] =>
          Array.from(a, (v) => (v === undefined ? null : v));
        send(c, {
          t: 'resumed', matchId: m.id, side, seed: m.seed, stage: m.stage,
          delay: m.solo ? 0 : INPUT_DELAY,
          chars: [
            { id: m.chars[0], hash: bundleOf(m.chars[0]).versionHash },
            { id: m.chars[1], hash: bundleOf(m.chars[1]).versionHash },
          ],
          names: m.names,
          agents: [m.clients[0].agent, m.clients[1]?.agent ?? true],
          mode: m.mode, fee: m.fee,
          solo: m.solo ?? undefined,
          resume: m.resumeTokens[side],
          inputs: [toNullable(m.inputs[0]), toNullable(m.inputs[1])],
        });
        // Clear the survivor's "opponent disconnected" notice (v6) — their
        // peer is back and inputs will resume flowing.
        const peer = m.clients[1 - side];
        if (peer && peer !== c && peer.ws.readyState === WebSocket.OPEN) {
          send(peer, { t: 'oppback' });
        }
        console.log(`[match ${m.id}] side ${side} (${c.name}) resumed`);
        return;
      }
      case 'i': {
        const m = c.match;
        if (!m || m.finished) return;
        const k = msg.k | 0;
        // Sanity caps: no negative ticks, no absurd future, first write wins.
        if (k < 0 || k > 60 * 60 * 30 || m.inputs[c.side][k] !== undefined) return;
        m.inputs[c.side][k] = msg.v | 0;
        m.lastInputAt[c.side] = Date.now(); // proof of life (anti lag-switch)
        // Solo: nothing to relay — the opponent lives in the verifier.
        const opp = m.clients[1 - c.side];
        if (opp) send(opp, { t: 'i', k, v: msg.v | 0 });
        return;
      }
      case 'h': {
        const m = c.match;
        if (!m || m.finished) return;
        if (m.hashes[c.side].size < 400) m.hashes[c.side].set(msg.k | 0, msg.x >>> 0);
        return;
      }
      case 'over': {
        const m = c.match;
        if (!m || m.finished) return;
        m.overAt[c.side] = msg.k | 0;
        // Solo: the single human report settles it. PvP: verify once both
        // sides agree (deterministic sims agree on the tick; a lone report
        // gets a short grace then verifies).
        if (m.solo || (m.overAt[0] >= 0 && m.overAt[1] >= 0)) finishMatch(m, null);
        else setTimeout(() => { if (!m.finished) finishMatch(m, null); }, 3000);
        return;
      }
    }
  };

  const onClose = (c: Client): void => {
    clients.delete(c);
    const qi = queue.indexOf(c);
    if (qi >= 0) queue.splice(qi, 1);
    // A friendly waiter leaving empties their room (nothing was escrowed).
    for (const [code, waiter] of rooms) if (waiter === c) rooms.delete(code);
    const m = c.match;
    if (!m || m.finished) return;
    m.gone[c.side] = true;
    // Tell the SURVIVOR their opponent vanished (v6) — the instant it happens,
    // so their client explains the freeze + counts down the grace instead of
    // sitting on a dead-looking frame. PvP only: a solo/arcade opponent has no
    // socket, so clients[1-side] is null and nothing is sent.
    const survivor = m.clients[1 - c.side];
    if (survivor && survivor.ws.readyState === WebSocket.OPEN) {
      send(survivor, { t: 'oppgone', graceMs: FORFEIT_GRACE_MS });
    }
    // Grace, then settle (ADR 0003 disconnect policy). Whoever is still here
    // when it fires is the survivor; if NOBODY is, it's a no-contest, not an
    // arbitrary loss for whichever socket happened to close first.
    if (m.forfeitTimer) clearTimeout(m.forfeitTimer);
    m.forfeitTimer = setTimeout(() => {
      if (m.finished) return;
      const bothGone = m.gone[0] && (m.gone[1] || !!m.solo);
      finishMatch(m, bothGone ? null : c.side);
    }, FORFEIT_GRACE_MS);
  };

  /**
   * Idle sweep: a socket that stays open but stops sending inputs stalls the
   * match forever — in wager mode that freezes the opponent's escrowed
   * credits, which is griefing (or a lag switch). Silence past
   * IDLE_FORFEIT_MS settles the match exactly like a disconnect.
   */
  // Orphaned-escrow sweep (ADR 0005): refund fees stranded by a crash between
  // escrow and settlement. Once at startup — deploys ARE restarts, so every
  // deploy mid-match would otherwise strand a pot — then hourly for belt and
  // braces. Failures only log; the next pass retries.
  const sweepEscrow = (): void => {
    if (!persistence) return;
    void persistence.sweepOrphanedEscrow()
      .then((n) => { if (n > 0) console.log(`[sweep] refunded ${n} orphaned escrow fee(s)`); })
      .catch((e) => console.log(`[sweep] failed: ${String((e as Error).message ?? e)}`));
  };
  sweepEscrow();
  const escrowSweep = setInterval(sweepEscrow, 60 * 60 * 1000);
  escrowSweep.unref?.();

  const idleSweep = setInterval(() => {
    const now = Date.now();
    // AGENT ARCADE runs parked on the interstitial expire quietly — nothing
    // is escrowed between battles, so expiry only forces a fresh (paid) run.
    // The 60-min belt-and-braces bound also drops runs whose battle died
    // without ever settling (should be unreachable — matches always settle).
    for (const [token, r] of arcadeRuns) {
      const limit = r.awaitingNext ? ARCADE_NEXT_GRACE_MS : 60 * 60 * 1000;
      if (now - r.lastActive > limit) arcadeRuns.delete(token);
    }
    for (const c of clients) {
      const m = c.match;
      if (!m || m.finished) continue;
      // Only sides with a real client can be silent — solo's side 1 is the
      // server's own AI and never sends anything.
      const silent = ([0, 1] as const).filter((s) =>
        m.clients[s] && now - m.lastInputAt[s] > IDLE_FORFEIT_MS);
      if (silent.length === 0) continue;
      const loser = silent.length === 1 ? silent[0]! : null;
      console.log(`[match ${m.id}] idle ${IDLE_FORFEIT_MS}ms → ${loser === null ? 'no contest' : `forfeit side ${loser}`}`);
      finishMatch(m, loser);
    }
  }, 5_000);
  idleSweep.unref?.();

  // Browser clients call /me and /leaderboard cross-origin (the game is
  // served from a different port/host than the match server).
  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Dev-Name, X-Agent-Key',
  };
  const json = (res: import('node:http').ServerResponse, code: number, body: unknown): void => {
    res.writeHead(code, { 'Content-Type': 'application/json', ...CORS });
    res.end(JSON.stringify(body));
  };

  const http = createHttpServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS);
      return res.end();
    }
    // Public partner JWKS (tools/air-keygen.mjs) — AIR validates our Partner
    // JWTs against this. Long cache is safe: the key basically never rotates.
    if (path === '/.well-known/jwks.json') {
      const f = join(root, 'air', 'jwks.json');
      if (!existsSync(f)) return json(res, 404, { error: 'no JWKS — run: node tools/air-keygen.mjs' });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600', ...CORS });
      return res.end(readFileSync(f));
    }
    if (path === '/leaderboard') {
      if (!persistence) return json(res, 503, { error: 'persistence not configured' });
      const limit = Math.min(100, Math.max(1, Number(new URL(req.url ?? '/', 'http://x').searchParams.get('limit')) || 20));
      void persistence.leaderboard(limit)
        .then((rows) => json(res, 200, rows))
        .catch((e) => json(res, 502, { error: String(e) }));
      return;
    }
    // Opponent identity for the AGENT ARCADE / VS-AGENT select-screen badge:
    // the live agent roster (real trained agents) + the house agent's aggregate
    // record. The client picks a live agent near its level, else the house.
    if (path === '/agents/roster') {
      if (!persistence) return json(res, 503, { error: 'persistence not configured' });
      void Promise.all([persistence.agentRoster(), persistence.houseStats()])
        .then(([agents, house]) => json(res, 200, { agents, house }))
        .catch((e) => json(res, 502, { error: String(e) }));
      return;
    }
    // Account snapshot for the title screen (also claims the daily bonus —
    // "logging in" = first authenticated contact of the day, whichever
    // surface it lands on). Auth: AIR session JWT; in the DEV economy an
    // X-Dev-Name header stands in so the loop is testable without AIR.
    if (path === '/me') {
      if (!persistence) return json(res, 503, { error: 'persistence not configured' });
      const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1];
      const devName = persistence.dev ? String(req.headers['x-dev-name'] ?? '') : '';
      void (async () => {
        const identity = bearer ? await verifyAirToken(bearer)
          : devName ? { sub: `dev:${devName.slice(0, 24)}` }
          : null;
        if (!identity) return json(res, 401, { error: 'sign in required' });
        const q = new URL(req.url ?? '/', 'http://x').searchParams;
        // ?name= — client display name. Empty string lets get_account KEEP the
        // existing profile name (never clobber with a UUID-prefix stub).
        const name = (devName || (q.get('name') ?? '')).slice(0, 24);
        // ?ref=<dare code> — the title screen redeems a stashed referral here.
        const ref = q.get('ref')?.slice(0, 40) ?? undefined;
        return json(res, 200, await persistence.getAccount(identity, name, false, ref));
      })().catch((e) => json(res, 502, { error: String(e) }));
      return;
    }
    // ---- Self-serve key mint (Minds MVP): a tiny standalone page — AIR
    // sign-in → POST /agent/key → key shown once + Minds hand-off steps.
    if (path === '/connect') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...CORS });
      return res.end(connectPageHtml());
    }
    // ---- AGENT SELF-SIGNUP (Minds obj. 1): no auth — the whole point is
    // that an agent can onboard itself. Safe because the account class it
    // creates is economically inert (fee 0 / payout 0 / no daily), so the
    // only thing being rationed is compute: per-IP signups + per-sub battles.
    if (path === '/agent/signup') {
      if (req.method !== 'POST') return json(res, 405, { error: 'POST {name} to sign up' });
      if (!persistence) return json(res, 503, { error: 'persistence not configured' });
      const ip = (String(req.headers['x-forwarded-for'] ?? '').split(',')[0] ?? '').trim()
        || req.socket.remoteAddress || 'unknown';
      if (!signupCap.bump(`ip:${ip}`, SIGNUPS_PER_IP_PER_DAY)) {
        return json(res, 429, { error: `signup limit: ${SIGNUPS_PER_IP_PER_DAY}/day per IP` });
      }
      void (async () => {
        let body = '';
        for await (const chunk of req) body += chunk;
        let name = '';
        try { name = String((JSON.parse(body || '{}') as Record<string, unknown>).name ?? ''); }
        catch { return json(res, 400, { error: 'bad json' }); }
        name = name.trim().slice(0, 24);
        if (name.length < 3) return json(res, 400, { error: 'name: 3-24 characters' });
        const sub = `agent:${randomUUID()}`;
        const key = `afk_${randomBytes(24).toString('hex')}`;
        if (!(await persistence.createAgentAccount(sub, name, sha256Hex(key)))) {
          return json(res, 500, { error: 'could not create account — try again' });
        }
        console.log(`[signup] agent account ${name} = ${sub} (${ip})`);
        // The key is shown ONCE. Rank-only account: no credits, ever.
        return json(res, 200, {
          sub, name, key,
          note: 'store the key now — it is never shown again',
          account: 'agent-class: free arcade/rank play, no credits, wager unavailable',
          play: 'ws hello { agentKey } → queue { mode: "arcade" }',
        });
      })().catch((e) => json(res, 502, { error: String(e) }));
      return;
    }
    // ---- TRAIN MY AGENT (ADR 0006). Auth for all /agent routes:
    //   · Bearer AIR JWT (the owner, e.g. from the game UI), or
    //   · X-Agent-Key (the durable key — how a Minds coach connects), or
    //   · X-Dev-Name (dev economy only).
    // Key mint is OWNER-ONLY: a leaked key must not be able to rotate itself
    // into a fresh one and hide the leak.
    if (path === '/agent/key' || path === '/agent' || path === '/agent/matches') {
      if (!persistence) return json(res, 503, { error: 'persistence not configured' });
      const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1];
      const devName = persistence.dev ? String(req.headers['x-dev-name'] ?? '') : '';
      const presentedKey = String(req.headers['x-agent-key'] ?? '');
      void (async () => {
        let sub: string | null = null;
        let ownerAuth = false; // true = AIR/dev session (may mint keys)
        if (bearer) {
          const id = await verifyAirToken(bearer);
          if (id) { sub = id.sub; ownerAuth = true; }
        } else if (devName) {
          sub = `dev:${devName.slice(0, 24)}`;
          ownerAuth = true;
        } else if (presentedKey) {
          sub = (await persistence.findByAgentKey(sha256Hex(presentedKey)))?.sub ?? null;
        }
        if (!sub) return json(res, 401, { error: 'sign in or present an agent key' });

        if (path === '/agent/key') {
          if (req.method !== 'POST') return json(res, 405, { error: 'POST to mint/rotate' });
          if (!ownerAuth) return json(res, 403, { error: 'only the signed-in owner can mint a key' });
          const key = `afk_${randomBytes(24).toString('hex')}`;
          if (!(await persistence.setAgentKey(sub, sha256Hex(key)))) {
            return json(res, 404, { error: 'no profile — connect to the game signed in first' });
          }
          // Shown ONCE; only the hash survives server-side.
          return json(res, 200, { key, note: 'store this now — it is never shown again' });
        }

        if (path === '/agent' && req.method === 'PUT') {
          // Hourly write throttle — a chatty coach can nudge, not thrash.
          const hour = new Date().toISOString().slice(0, 13);
          if (!putCap.bump(`put:${sub}:${hour}`, PUTS_PER_HOUR)) {
            return json(res, 429, { error: `coaching limit: ${PUTS_PER_HOUR} changes/hour` });
          }
          let body = '';
          for await (const chunk of req) body += chunk;
          let parsed: Record<string, unknown>;
          try { parsed = JSON.parse(body || '{}') as Record<string, unknown>; }
          catch { return json(res, 400, { error: 'bad json' }); }
          const prev = (await persistence.getAgent(sub))?.config;
          const character = typeof parsed.character === 'string' && characterIds.includes(parsed.character)
            ? parsed.character
            : prev?.character;
          if (!character) return json(res, 400, { error: `character required (one of: ${characterIds.join(', ')})` });
          const config = {
            character,
            // Merge over the previous coaching so a Mind can nudge one knob.
            personality: { ...prev?.personality, ...clampPersonality(parsed.personality) },
            motto: typeof parsed.motto === 'string' ? parsed.motto.slice(0, 90) : prev?.motto,
          };
          if (!(await persistence.setAgentConfig(sub, config))) {
            return json(res, 404, { error: 'no profile — connect to the game signed in first' });
          }
          return json(res, 200, { config, ranges: AI_PERSONALITY_RANGES });
        }

        if (path === '/agent') {
          const info = await persistence.getAgent(sub);
          if (!info) return json(res, 404, { error: 'no profile — connect to the game signed in first' });
          return json(res, 200, {
            // Stats are read-only context for the coach; skill derives from
            // level server-side and is not part of the config on purpose.
            name: info.name, level: info.level, xp: info.xp,
            wins: info.wins, losses: info.losses,
            config: info.config, keyCreatedAt: info.keyCreatedAt,
            ranges: AI_PERSONALITY_RANGES, characters: characterIds,
          });
        }

        // GET /agent/matches — recent settled matches, sub-centric ("did I
        // win", "who was it") so the coach never has to reason about sides.
        const limit = Math.min(50, Math.max(1, Number(new URL(req.url ?? '/', 'http://x').searchParams.get('limit')) || 20));
        const rows = await persistence.recentMatches(sub, limit);
        return json(res, 200, {
          matches: rows.map((r) => {
            const mySide = r.p0 === sub ? 0 : 1;
            return {
              id: r.id, when: r.created_at, mode: r.mode,
              character: mySide === 0 ? r.p0_char : r.p1_char,
              opponent: mySide === 0 ? r.p1_name : r.p0_name,
              opponentCharacter: mySide === 0 ? r.p1_char : r.p0_char,
              opponentIsAgent: mySide === 0 ? r.p1_agent : r.p0_agent,
              won: r.winner === mySide ? true : r.winner === 1 - mySide ? false : null,
              draw: r.winner === 2,
              reason: r.reason,
              rounds: mySide === 0 ? [r.rounds0, r.rounds1] : [r.rounds1, r.rounds0],
              seconds: Math.round(r.end_tick / 60),
            };
          }),
        });
      })().catch((e) => json(res, 502, { error: String(e) }));
      return;
    }
    return json(res, 200, {
      game: 'agent-fighter', engine: ENGINE_VERSION, protocol: PROTOCOL_VERSION,
      characters: characterIds, stages: stageIds,
      online: clients.size, queued: queue.length,
      persistence: !!persistence,
    });
  });
  const wss = new WebSocketServer({ server: http });

  wss.on('connection', (ws, req) => {
    const c: Client = {
      ws, id: `c${nextId++}`, name: 'anon', agent: false,
      state: 'lobby', character: '', match: null, side: 0, identity: null,
      identityReady: Promise.resolve(),
      account: null,
      email: '',
    };
    clients.add(c);
    ws.on('message', (data) => onMessage(c, String(data)));
    ws.on('close', () => onClose(c));
    ws.on('error', () => { /* close follows */ });
  });

  return new Promise((resolve) => {
    http.listen(opts.port ?? DEFAULT_PORT, () => {
      const address = http.address();
      const port = typeof address === 'object' && address ? address.port : DEFAULT_PORT;
      resolve({
        port,
        close: () => { clearInterval(idleSweep); clearInterval(escrowSweep); wss.close(); http.close(); },
      });
    });
  });
};

// ---------------------------------------------------------------- CLI
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  // Solo pace sanity is the only thing standing between a local-sim ranked
  // match and tool-assisted slow-motion, so the escape hatch that disables it
  // may only be pulled alongside the throwaway dev economy. Tests don't come
  // through here — they pass noPaceCheck directly to createMatchServer.
  if (process.env.AF_NO_PACE_CHECK && process.env.AF_ALLOW_DEV_ECONOMY !== '1') {
    throw new Error(
      'AF_NO_PACE_CHECK disables the solo pace check that stops tool-assisted '
      + 'slow-motion. It is a dev-only hatch: it may only be set together with '
      + 'AF_ALLOW_DEV_ECONOMY=1. Refusing to start on a real economy.',
    );
  }
  const server = await createMatchServer({
    port: Number(process.env.PORT || DEFAULT_PORT),
    noPaceCheck: !!process.env.AF_NO_PACE_CHECK,
  });
  console.log(`Agent Fighter match server → ws://localhost:${server.port}`);
  console.log(`engine ${ENGINE_VERSION} · protocol v${PROTOCOL_VERSION} · humans and agents welcome`);
}
