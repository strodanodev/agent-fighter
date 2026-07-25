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
  AI_PERSONALITY_RANGES, ENGINE_VERSION, EXIT_BONUS, EXIT_FIGHT_FLOOR, ITEMS,
  ITEM_COST, ITEM_TIER_ODDS, Phase, REGION_NAME, aiPoll, createAi,
  createGameState, exitNodes, generateBoard, isFightNode, isLegalMove, itemById,
  loadCharacter, minFights, nodeById, setCharacters, setMatchItems,
  stateHash, step, successors, validateAllTemplates,
} from '@af/core';
import type {
  Board, BoardNode, CharacterBundle, GameState, ItemDef, ItemEffect,
} from '@af/core';
import {
  ARCADE_NEXT_GRACE_MS, DEFAULT_PORT, FORFEIT_GRACE_MS, IDLE_FORFEIT_MS, INPUT_DELAY,
  INPUT_DELAY_MAX, INPUT_DELAY_MIN, PING_INTERVAL_MS, PROTOCOL_VERSION,
  SOLO_PACE_MAX, SOLO_PACE_MIN, SOLO_PACE_SLACK_MS, TICK_MS,
} from './protocol.js';
import type { ClientMsg, ItemPin, SMatch, SResult, ServerMsg } from './protocol.js';
import { verifyAirToken } from './airjwt.js';
import type { AirIdentity } from './airjwt.js';
import {
  ARCADE_FEE,
  InsufficientCredits, SOLO_FEE, WAGER_FEE, createPersistence, loadDotEnv,
} from './persist.js';
import type { Account, ArcadeExtract, MatchMode, Persistence } from './persist.js';
import { createAirIssuer, loadIssuerConfig } from './air-issuer.js';
import type { AirIssuer } from './air-issuer.js';
import { connectPageHtml } from './connect-page.js';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(here, '..', '..', '..');

/** Durable agent keys (ADR 0006): only the sha256 of a key is ever stored. */
const sha256Hex = (s: string): string => createHash('sha256').update(s).digest('hex');

/**
 * AGENT-CLASS accounts (operator-owned via POST /agent/signup): sub `agent:<uuid>`.
 * Economically inert — fee 0, payout 0, no daily grant, wager unreachable
 * (it needs credits they can never hold). XP/rank only. This prefix check
 * is the single switch the whole policy hangs on.
 */
const isAgentClassSub = (sub: string | undefined | null): boolean => !!sub && sub.startsWith('agent:');

/**
 * Vending-machine gacha roll (ADR 0007). The randomness lives HERE, at
 * purchase time, server-side — never in the sim: by the time an item can
 * matter in a match it is a fixed, known effect. Tier odds + registry are
 * data in @af/core items.ts.
 */
const rollItem = (): ItemDef => {
  let r = Math.random() * 100;
  let tier: ItemDef['tier'] = 1;
  for (const t of ITEM_TIER_ODDS) {
    if (r < t.pct) { tier = t.tier; break; }
    r -= t.pct;
  }
  const pool = ITEMS.filter((i) => i.tier === tier);
  return pool[Math.floor(Math.random() * pool.length)]!;
};

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
/** Max agent-class fighters one AIR operator may mint (matches AF_FLEET cap). */
const AGENTS_PER_OWNER = 12;
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
  /**
   * Measured round-trip to this client in ms (EMA; -1 = unknown). Fed by
   * the lobby ping loop's pong echoes; read once at pair time to size the
   * adaptive input delay. Client-supplied timing, so it is only ever used
   * to pick a delay inside [INPUT_DELAY_MIN, INPUT_DELAY_MAX] — lying
   * about it just gives the liar the same worse delay as their opponent.
   */
  rtt: number;
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
  /** The chosen stage's playfield bounds (world px), read from its stage.json
   *  at pair time. Server-authoritative; shipped in SMatch/SResumed and passed
   *  to createGameState so the verifier's walls match the clients'. Undefined =
   *  full-width stage. */
  bounds?: { left: number; right: number };
  chars: [string, string];
  names: [string, string];
  /** Local-sim solo: the deterministic house AI the client must simulate.
   *  `personality` present = a TRAINED agent opponent (dare-vs-agent /
   *  sparring, ADR 0006) — verification re-derives the AI with it. */
  solo: { skill: number; aiSeed: number; personality?: Record<string, number> } | null;
  /** AGENT ARCADE: the run this battle belongs to (null = not an arcade battle). */
  arcadeRun: ArcadeRun | null;
  /** CONSUMABLES (ADR 0007): pinned per-side drink loadouts (≤3 each).
   *  Reserved (consumed) at pair time; settlement keeps only the cans the
   *  verified re-sim shows were DRUNK and releases the rest. */
  items: MatchItems;
  /** The items-table rowIds behind each pin, same order — server-side only
   *  (never shipped to clients; settlement maps spent slots → rows). */
  itemRows: [number[], number[]];
  startedAt: number; // wall clock — solo pace sanity (SOLO_PACE_*)
  /** Per-side bearer secrets for CResume — only their owners ever see them. */
  resumeTokens: [string, string];
  /** Sides whose socket has dropped — both gone = no-contest, not a forfeit. */
  gone: [boolean, boolean];
  /** Input delay (ticks) pinned at pair time — resume must resend the SAME value. */
  delay: number;
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
  /**
   * Graceful drain (deploy/SIGTERM): refuse new queues, settle every live
   * match through the normal ladder (a finished ledger still pays the
   * winner; an undecided one is a no-contest that refunds fees and
   * releases items), give the fire-and-forget persistence writes a moment
   * to land, then close. Every deploy used to strand live matches at
   * "VERIFYING WITH SERVER…" — this is the root fix.
   */
  shutdown: () => Promise<void>;
}

/**
 * A pinned solo opponent: the house AI (level ramp, random character), a
 * LIVE headless/fleet agent from the public roster (real display name +
 * optional coached style — the 24/7 arena-queue illusion), or a TRAINED
 * agent via dare code ("<OWNER>'S AGENT" — ADR 0006 sparring).
 */
interface SoloPin {
  skill: number;
  aiSeed: number;
  character: string;
  level: number;
  personality?: Record<string, number>;
  agentName?: string;
}

/**
 * AGENT ARCADE v2 run state (v7, ADR 0008). Server-authoritative in every
 * respect that costs money: the BOARD, where the player is STANDING, and
 * what is in the BAG all live here. A hacked client can propose a move; it
 * can never assert a position or a pickup.
 *
 * The token is a bearer secret minted at POST /arcade/enter, re-armed after
 * every verified win, and additionally pinned to the account that paid.
 */
interface ArcadeRun {
  token: string;
  /** Owner identity sub ('' when persistence is off — tests). */
  sub: string;
  /** The fighter locked for the whole run. '' = paid via /arcade/enter but
   *  not yet through character select — locked by POST /arcade/run. */
  charId: string;
  /**
   * The generated board. Null until the fighter locks: the roster a board is
   * populated from excludes the player's own character, which is not known
   * until select. Minted exactly once per run.
   */
  board: Board | null;
  /** Node the player is STANDING on (board.start until the first win). */
  at: number;
  /** The node currently being fought, or -1. Set at queue, cleared at result. */
  pending: number;
  /** UNBANKED pickups. Evaporates on any loss — that is the whole mode. */
  bag: { credits: number; drinks: { itemId: string; tier: number }[] };
  /** Every node entered, in order (forensics + the run summary). */
  path: number[];
  /** Fights WON this run. */
  fights: number;
  /** True between a verified win and the next move's queue. */
  awaitingNext: boolean;
  /** Set once the bag has been banked — the run is over, token spent. */
  extracted: boolean;
  /**
   * Entry PRE-PAID via POST /arcade/enter (ADR 0007 credits rework): a
   * consented, NON-refundable debit taken BEFORE character select. Paid
   * runs never escrow per battle. Free agent-class runs also arrive here.
   */
  paid: boolean;
  lastActive: number;
}

/**
 * Fights on the cheapest line to the deep exit — the "7" the HUD counts
 * against. A structural constant of every board (validateBoard asserts it),
 * not a tuning knob.
 */
const ARCADE_TOTAL = EXIT_FIGHT_FLOOR[3];

/**
 * Arcade opponents all share ONE moveset (the roster is a single archetype), so
 * PERSONALITY is the only lever that makes a gauntlet feel varied. Each fighter's
 * style is its CANONICAL identity — the same `meta.style` that drives its feel
 * (tools/apply-char-tuning.mjs writes both), so a character both PLAYS and FEELS
 * like its archetype. Values stay inside AI_PERSONALITY_RANGES (createAi clamps).
 * The chosen personality ships in the match pin (SMatch.solo), so the client sim
 * and the server re-sim build the identical AI — no desync.
 */
const STYLE_ORDER = ['rushdown', 'zoner', 'turtle', 'jumpy', 'grappler', 'all-rounder'] as const;
type StyleName = typeof STYLE_ORDER[number];
const ARCADE_PERSONALITY: Record<StyleName, Record<string, number>> = {
  // rushdown — in your face, low patience, hates to zone
  rushdown: { aggression: 210, jumpiness: 120, zoner: 45, throwHappy: 110, pushblocker: 90, patience: 70 },
  // zoner — keep-away, fireballs, patient
  zoner: { aggression: 110, jumpiness: 55, zoner: 205, throwHappy: 40, pushblocker: 120, patience: 190 },
  // turtle — block-heavy, defensive, punishes
  turtle: { aggression: 100, jumpiness: 45, zoner: 120, throwHappy: 60, pushblocker: 210, patience: 195 },
  // jumpy — air-heavy pressure
  jumpy: { aggression: 175, jumpiness: 185, zoner: 70, throwHappy: 70, pushblocker: 80, patience: 90 },
  // grappler — walks in, throws a lot
  grappler: { aggression: 200, jumpiness: 50, zoner: 45, throwHappy: 150, pushblocker: 140, patience: 120 },
  // all-rounder — balanced
  'all-rounder': { aggression: 150, jumpiness: 110, zoner: 120, throwHappy: 90, pushblocker: 140, patience: 130 },
};
/** Stable style fallback for a character with no declared meta.style. */
const styleFallback = (charId: string): StyleName => {
  let h = 0;
  for (let i = 0; i < charId.length; i++) h = (h * 31 + charId.charCodeAt(i)) | 0;
  return STYLE_ORDER[Math.abs(h) % STYLE_ORDER.length]!;
};

// ---------------------------------------------------------------- verify
/** The pinned per-side drink loadouts, as stored on a Match / sent in SMatch. */
type MatchItems = [ItemPin[], ItemPin[]];
const NO_ITEMS: MatchItems = [[], []];

/**
 * Install a match's pinned drink loadouts into the core module slot (the
 * setCharacters pattern). EVERY re-sim path must run this — including the
 * item-less default, which CLEARS the slot so one verification can never
 * leak drinks into the next.
 */
const installItems = (items: MatchItems): void => {
  // The pin's effect shape is validated at queue time (it comes from the
  // core ITEMS registry) and core re-clamps values — the cast is safe.
  setMatchItems(
    items[0].map((p) => p.effect as ItemEffect),
    items[1].map((p) => p.effect as ItemEffect),
  );
};

/**
 * Which pinned slots the re-simmed GameState shows as DRUNK: a pinned slot
 * whose carried kind ended at 0 was consumed in-fight. The basis of
 * consume-only-what-you-drink settlement — partial ledgers (forfeits)
 * still count everything drunk BEFORE the drop.
 */
const spentSlots = (g: GameState, items: MatchItems): [boolean[], boolean[]] => {
  const side = (i: 0 | 1): boolean[] => {
    const f = g.fighters[i];
    const kinds = [f.itemKind0, f.itemKind1, f.itemKind2];
    return items[i].map((_pin, s) => kinds[s] === 0);
  };
  return [side(0), side(1)];
};

interface VerifyOutcome {
  winner: number;
  rounds: [number, number];
  endTick: number;
  hash: number;
  reachedEnd: boolean;
  /** Per side, per pinned slot: was the can drunk by the verified ledger? */
  spent: [boolean[], boolean[]];
}

/**
 * Re-simulate the ledger, derive the result, AND scan the client-reported
 * hashes for the deviator — in ONE forward pass (v1.02_scale).
 *
 * Synchronous on purpose: verification is the trust anchor and Node's single
 * thread makes the global character slots race-free without locks.
 *
 * This used to be TWO full re-sims per settled match: `verifyLedger` (derive
 * the outcome) followed by `findDeviator` (walk the ledger again checking
 * reported hashes). They stepped the identical deterministic simulation from
 * tick 0 with the identical inputs/AI, so one pass produces both — halving the
 * event-loop time every match settlement blocks for. Behaviour is unchanged:
 * the outcome is the full re-sim result, and the deviator is still the EARLIEST
 * diverging reported tick (checkpoints are visited in ascending tick order, and
 * once a side is convicted no later tick can overrule it).
 *
 * Solo (protocol v3): the client streamed only ITS inputs; the opponent is
 * re-derived from the pinned deterministic AI (same skill/aiSeed/personality,
 * same aiPoll-before-step ordering as the client), so the house cannot be
 * puppeteered and a coached agent (ADR 0006) can't be either.
 */
const verifyAndScan = (
  bundles: [CharacterBundle, CharacterBundle],
  seed: number,
  inputs: [number[], number[]],
  hashes: [Map<number, number>, Map<number, number>],
  solo: { skill: number; aiSeed: number; personality?: Record<string, number> } | null,
  items: MatchItems = NO_ITEMS,
  bounds?: { left: number; right: number },
  matchId = '',
): { outcome: VerifyOutcome; deviator: 0 | 1 | undefined } => {
  setCharacters(loadCharacter(bundles[0]), loadCharacter(bundles[1]));
  installItems(items);
  const g = createGameState(seed, bounds);
  const ai = solo ? createAi(1, solo.skill, solo.aiSeed, solo.personality) : null;
  const n = solo ? inputs[0].length : Math.min(inputs[0].length, inputs[1].length);

  // Reported-hash checkpoints, keyed by tick. Sides added [0,1] (solo: [0]) so
  // a tick both sides report checks side 0 first — identical to the old
  // findDeviator ordering, which returned the first diverging side at a tick.
  const checks = new Map<number, [0 | 1, number][]>();
  for (const side of (solo ? [0] : [0, 1]) as (0 | 1)[]) {
    for (const [tick, h] of hashes[side]) {
      if (tick < 0) continue;
      let at = checks.get(tick);
      if (!at) checks.set(tick, at = []);
      at.push([side, h]);
    }
  }

  let deviator: 0 | 1 | undefined = undefined;
  let t = 0;
  const checkNow = (): void => {
    if (deviator !== undefined) return;
    const at = checks.get(t);
    if (!at) return;
    const truth = stateHash(g);
    for (const [side, h] of at) {
      if (truth !== h) {
        console.log(`[match ${matchId}] hash mismatch side=${side} tick=${t} reported=${h} truth=${truth}`);
        deviator = side;
        return;
      }
    }
  };

  checkNow(); // tick 0 (initial state), if any hash was reported for it
  while (g.phase !== Phase.MatchOver && t < n) {
    const p1 = ai ? aiPoll(ai, g) : inputs[1][t]! | 0;
    step(g, [inputs[0][t]! | 0, p1]);
    t++;
    checkNow();
  }

  const outcome: VerifyOutcome = {
    winner: g.phase === Phase.MatchOver ? g.winner : -1,
    rounds: [g.roundsWon0, g.roundsWon1],
    endTick: t,
    hash: stateHash(g),
    reachedEnd: g.phase === Phase.MatchOver,
    spent: spentSlots(g, items),
  };
  return { outcome, deviator };
};

// ---------------------------------------------------------------- server
export const createMatchServer = (opts: {
  port?: number;
  root?: string;
  /** Test hook: overrides the Supabase-backed persistence (null = off). */
  persistence?: Persistence | null;
  /** Test hook: skip the wall-clock pace sanities — the solo settlement
   *  check AND the per-input tick plausibility cap (tests sim >>realtime). */
  noPaceCheck?: boolean;
  /** Test hook: overrides the env-configured AIR issuer (null = off). */
  airIssuer?: AirIssuer | null;
  /**
   * Test hook: overrides the arcade difficulty. Called with (fights won so
   * far, ARCADE_TOTAL). Unset = the BOARD decides — every fight node carries
   * the skill of its region, so difficulty tracks depth rather than how many
   * optional detours the player took.
   */
  arcadeSkill?: (battle: number, total: number) => number;
  /** Test hook: shorten the input-silence forfeit window (default 30s). */
  idleForfeitMs?: number;
  /** Connection caps (v1.02_scale). Default from AF_MAX_CONNS[_PER_IP] env. */
  maxConns?: number;
  maxConnsPerIp?: number;
} = {}): Promise<MatchServer> => {
  const root = opts.root ?? REPO_ROOT;
  // Input-silence forfeit window. The idle sweep is a REALTIME liveness
  // assumption: a real client streams inputs every tick, so 30s of silence
  // means the tab is gone → settle the solo match as a no-contest.
  //
  // Offline-sim tests (noPaceCheck) violate that assumption BY DESIGN: they
  // compute a whole match locally and submit the ledger in one burst, so the
  // socket is silent for the entire (blocking, machine-speed-dependent)
  // winning-line search. On a slow/loaded box that search outlasts the 30s
  // window and the sweep settles a legitimately-WON match as 'incomplete' the
  // instant the loop frees — the "flaky arcade" no-contest. noPaceCheck already
  // opts out of the sibling realtime heuristics (settlement pace check + the
  // per-input maxTick cap); the idle sweep is the same class, so it relaxes
  // here too. A test that specifically EXERCISES idle-forfeit still opts in by
  // passing an explicit idleForfeitMs, which always wins over this default.
  const idleMs = opts.idleForfeitMs
    ?? (opts.noPaceCheck ? Number.MAX_SAFE_INTEGER : IDLE_FORFEIT_MS);
  const charactersDir = join(root, 'characters');
  const stagesDir = join(root, 'stages');
  loadDotEnv(root); // SUPABASE_URL / SUPABASE_SERVICE_KEY / AIR_* config
  const persistence = opts.persistence !== undefined ? opts.persistence : createPersistence();
  // The pace check is the only thing between local-sim ranked play and
  // tool-assisted slow-motion — disabling it on a REAL economy must be
  // impossible no matter which env flags are set (an env-flag-only guard
  // once let AF_NO_PACE_CHECK ride alongside live Supabase keys).
  if (opts.noPaceCheck && persistence && !persistence.dev) {
    throw new Error('noPaceCheck is dev/test-only: refusing with a non-dev persistence');
  }
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
  /** A character's canonical style (its bundle meta.style), else a stable hash
   *  fallback for an unstyled character. Drives its arcade AI personality —
   *  the same style that drives its feel (tuning). */
  const styleOfChar = (id: string): StyleName => {
    const s = (bundleOf(id) as { meta?: { style?: string } }).meta?.style;
    return s && (STYLE_ORDER as readonly string[]).includes(s) ? s as StyleName : styleFallback(id);
  };
  /** A stage's playfield bounds (world px) from its stage.json, or undefined
   *  (full-width). Best-effort: a missing/garbled stage never blocks a match. */
  const stageBoundsOf = (id: string): { left: number; right: number } | undefined => {
    if (!id) return undefined;
    try {
      const file = join(stagesDir, id, 'stage.json');
      const meta = JSON.parse(readFileSync(file, 'utf8')) as { bounds?: { left: number; right: number } };
      const b = meta.bounds;
      return b && Number.isFinite(b.left) && Number.isFinite(b.right) && b.right > b.left
        ? { left: b.left, right: b.right }
        : undefined;
    } catch {
      return undefined;
    }
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
  const arcadeSkillOverride = opts.arcadeSkill ?? null;

  // A template that has drifted out of contract must stop the server, not
  // quietly mis-price runs. Eight small graphs — cheap enough to check at boot.
  {
    const problems = validateAllTemplates(enabledCharacterIds.slice(0, 12));
    for (const [id, list] of Object.entries(problems)) {
      console.error(`[arcade] template "${id}" is INVALID:\n  ${list.join('\n  ')}`);
    }
    if (Object.keys(problems).length > 0) {
      throw new Error('arcade board templates failed validation — refusing to start');
    }
  }

  const clients = new Set<Client>();
  // CONNECTION CAPS (v1.02_scale). The clients set was previously unbounded: a
  // connection flood — each socket individually cheap but pinged/swept on every
  // sweep — had no ceiling and no per-IP limit. A global cap protects the shared
  // event loop; a per-IP cap stops one host from eating it while staying
  // generous for shared-NAT / multi-tab. Both env-tunable for ops headroom.
  const MAX_CONNS = opts.maxConns ?? (Number(process.env.AF_MAX_CONNS) || 5000);
  const MAX_CONNS_PER_IP = opts.maxConnsPerIp ?? (Number(process.env.AF_MAX_CONNS_PER_IP) || 64);
  const connsByIp = new Map<string, number>();
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
  /** True once shutdown() starts — new queues/entries are refused. */
  let draining = false;
  /** AGENT ARCADE runs by token (v7 — each holds a whole board). */
  const arcadeRuns = new Map<string, ArcadeRun>();

  /**
   * Board seed. `generateBoard` deliberately REFUSES to invent one (core has
   * no ambient randomness), so the choice is made here — and logged with the
   * template id, which is what makes any run a player reports reproducible.
   */
  const newBoardSeed = (): number => (Math.random() * 0x7fffffff) | 0;

  /**
   * Step a run onto `to` and sweep up anything it lands on (ADR 0008).
   *
   * AUTO-COLLECT is the reason moving is not its own endpoint: a guarded
   * pickup's fighter has the pickup as its ONLY successor, so after winning
   * that fight there is no decision left to make — walking it manually would
   * be a round trip that can only fail (a dropped request between the win
   * and the pickup would silently rob the player). So: after a win we walk
   * forward through any single-successor loot node, banking it into the bag,
   * and stop the moment a real choice appears.
   *
   * Everything here is server-side arithmetic over the server's own board.
   * The client is told what it got; it never says what it took.
   */
  const advanceRun = (run: ArcadeRun, to: number): void => {
    const board = run.board;
    if (!board || to < 0) return;
    run.at = to;
    run.path.push(to);
    for (;;) {
      const outs = successors(board, run.at);
      if (outs.length !== 1) break;
      const next = nodeById(board, outs[0]!);
      if (!next || next.kind !== 'loot' || !next.loot) break;
      if (next.loot.kind === 'credits') run.bag.credits += next.loot.amount;
      else run.bag.drinks.push({ itemId: next.loot.itemId, tier: next.loot.tier });
      run.at = next.id;
      run.path.push(next.id);
    }
  };

  /**
   * The whole client-facing picture of a run: the board (so the map screen
   * can draw it and do its own route arithmetic) plus the authoritative
   * position and bag. Returned by POST /arcade/run on both the locking call
   * and every later resume.
   */
  const arcadeRunState = (run: ArcadeRun): Record<string, unknown> => ({
    token: run.token,
    character: run.charId,
    board: run.board,
    at: run.at,
    pending: run.pending,
    fights: run.fights,
    total: ARCADE_TOTAL,
    bag: run.bag,
    awaitingNext: run.awaitingNext,
    extracted: run.extracted,
  });

  /**
   * AUTOPILOT (headless agents): the next fight node on the cheapest line to
   * the deep exit. Human clients always name their own node — this exists so
   * `npm run agent` / `npm run fleet` keep working without teaching them to
   * read a map. They are agent-class and economically inert, so the loot
   * they walk past is nobody's money.
   */
  const autopilotNode = (run: ArcadeRun): number => {
    const board = run.board;
    if (!board) return -1;
    const deep = exitNodes(board).find((e) => e.exitTier === 3);
    const options = successors(board, run.at)
      .map((id) => nodeById(board, id))
      .filter((n): n is BoardNode => !!n && isFightNode(n));
    if (options.length === 0) return -1;
    if (!deep) return options[0]!.id;
    let best = options[0]!;
    let bestCost = Infinity;
    for (const n of options) {
      const cost = minFights(board, n.id, deep.id);
      if (cost >= 0 && cost < bestCost) { bestCost = cost; best = n; }
    }
    return best.id;
  };
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
    // ONE forward re-sim derives the outcome AND names the deviator (v1.02_scale;
    // was two full passes). Solo has one human side; the opponent is the
    // server's own re-derived AI.
    const { outcome: v, deviator } = verifyAndScan(
      bundles, m.seed, m.inputs, m.hashes, m.solo ?? null, m.items, m.bounds, m.id);

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

    // AGENT ARCADE v2 run bookkeeping (ADR 0008) — decided BEFORE the async
    // persistence. A win pays NO credits: it moves you on the board, and the
    // board is where credits live.
    const arcadePayout = 0;
    const run = m.arcadeRun;
    if (run) {
      const wonBattle = result.reason === 'verified' && result.winner === 0
        && result.deviator !== 0;
      if (wonBattle) {
        run.fights++;
        advanceRun(run, run.pending);
        run.pending = -1;
        run.awaitingNext = true; // token re-armed for the next MOVE
        run.lastActive = Date.now();
      } else if (result.reason === 'incomplete') {
        // No-contest (network/pace): nothing was decided, so the run keeps
        // its position and may RETRY the same node until it expires. A blip
        // must never cost a player a loaded bag.
        run.pending = -1;
        run.awaitingNext = true;
        run.lastActive = Date.now();
      } else {
        // Loss, draw, or forfeit: GAME OVER, and the bag evaporates. This is
        // the deterrent the whole extraction loop rests on — nothing banks
        // until the player reaches an exit alive.
        const lost = run.bag.credits + run.bag.drinks.length;
        if (lost > 0) {
          console.log(`[arcade] ${m.clients[0].name} WIPED at node ${run.pending} — lost ${run.bag.credits} CR + ${run.bag.drinks.length} drink(s)`);
        }
        arcadeRuns.delete(run.token);
      }
    }

    for (const c of m.clients) {
      if (!c) continue;
      send(c, result);
      c.state = 'lobby';
      c.match = null;
    }
    console.log(`[match ${m.id}] ${result.reason}: winner=${result.winner} ticks=${result.endTick}`);
    // CONSUME ONLY WHAT YOU DRINK (ADR 0007 final shape): the verified
    // re-sim knows which pinned slots were spent, so settlement keeps the
    // DRUNK cans consumed and hands the rest back (still equipped). A
    // NO-CONTEST releases everything — the reserved cans were never truly
    // in play. Forfeits keep whatever was drunk BEFORE the drop.
    if (persistence && (m.items[0].length > 0 || m.items[1].length > 0)) {
      if (result.winner === -1) {
        void persistence.releaseItems(m.id).catch((e) =>
          console.log(`[items] release failed for ${m.id}: ${String(e)}`));
      } else {
        const drunk: number[] = [];
        for (const side of [0, 1] as const) {
          v.spent[side].forEach((was, s) => {
            const row = m.itemRows[side][s];
            if (was && row) drunk.push(row);
          });
        }
        void persistence.settleItems(m.id, drunk).catch((e) =>
          console.log(`[items] settle failed for ${m.id}: ${String(e)}`));
      }
    }
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
        // Solo/arcade side-1 has no account: persist the nameplate the match
        // already used (live roster agent, trained-agent label, HOUSE LV…,
        // or arcade "CHAR · n/total"). house_agent_stats reads the mode
        // column, not this label, so the aggregate house record is unaffected.
        names: [m.clients[0].name, m.clients[1]?.name ?? m.names[1]],
        agents: [m.clients[0].agent, m.clients[1]?.agent ?? true],
        chars: m.chars,
        winner: result.winner, reason: result.reason,
        rounds: result.rounds, endTick: result.endTick, hash: result.hash,
        deviator: result.deviator,
        engine: ENGINE_VERSION,
      }).then(async (awards) => {
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
          // LEVEL-UP REWARD: one free vending pull per level gained (the
          // "levelling matters" hook). Server-rolled + persisted via the
          // normal idempotent buyItem path at cost 0 — no credit movement,
          // and a DETERMINISTIC nonce means a settlement retry re-reveals the
          // same drop instead of minting a second. Agent-class accounts are
          // economically inert (bot-farm valve), so they never earn pulls.
          // Best-effort, exactly like the AIR/referral write-backs below: a
          // crash between record_match committing and this grant loses the
          // pull rather than blocking or double-awarding the verdict.
          const sub = cl.identity?.sub;
          const freePulls: { itemId: string; tier: number }[] = [];
          if (sub && !isAgentClassSub(sub) && a.levelsUp > 0) {
            for (let lp = 0; lp < a.levelsUp; lp++) {
              try {
                const rolled = rollItem();
                const r = await persistence.buyItem(
                  sub, 0, rolled.id, rolled.tier, `lvlup:${m.id}:${a.side}:${lp}`,
                );
                const def = ITEMS.find((i) => i.id === r.itemId) ?? rolled;
                freePulls.push({ itemId: def.id, tier: def.tier });
                if (!r.duplicate) console.log(`[shop] ${sub} FREE pull ${def.id} (T${def.tier}) — level ${a.level}`);
              } catch { /* a lost free pull never blocks settlement */ }
            }
          }
          send(cl, {
            t: 'xp', gained: a.gained, levelsUp: a.levelsUp,
            level: a.level, xp: a.xp, wins: a.wins, losses: a.losses,
            creditsDelta: a.creditsDelta, credits: a.credits,
            ...(freePulls.length ? { freePulls } : {}),
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

  // Defensive wrapper for TIMER-invoked finishMatch (audit 2026-07-20 CT-4):
  // finishMatch re-sims the ledger and reads character bundles, which can throw
  // (e.g. a bundle file that vanished mid-deploy). Inside a setTimeout/interval
  // callback that throw is an uncaughtException that would take down the whole
  // process and freeze every OTHER live match. Catch it so one match dies alone.
  // (The ws-message callsites are already under the message-handler try/catch.)
  const safeFinish = (m: Match, side: 0 | 1 | null): void => {
    try { if (!m.finished) finishMatch(m, side); }
    catch (err) { console.error(`[finishMatch] failed for match ${m.id}:`, err); }
  };

  /**
   * Adaptive input delay (2026-07-18): size the symmetric delay from both
   * clients' measured RTT to THIS relay. One-way A→B = A→server + server→B
   * ≈ (rttA + rttB) / 2; half of it is hidden by delay, the rest by
   * rollback prediction. Unknown RTT (old client, unanswered pings) falls
   * back to the fixed INPUT_DELAY — exactly the pre-adaptive behavior.
   */
  const adaptiveDelay = (a: Client, b: Client): number => {
    if (a.rtt < 0 || b.rtt < 0) return INPUT_DELAY;
    const oneWayMs = (a.rtt + b.rtt) / 2;
    return Math.max(INPUT_DELAY_MIN, Math.min(INPUT_DELAY_MAX, Math.round(oneWayMs / TICK_MS / 2)));
  };

  const startMatch = (
    c0: Client, c1: Client | null, mode: MatchMode | 'friendly', fee: number, id?: string,
    solo?: SoloPin,
    arcadeRun?: ArcadeRun,
    items: MatchItems = [[], []],
    itemRows: [number[], number[]] = [[], []],
  ): void => {
    // Arcade battles bill as the character, not "HOUSE": the run IS the mode.
    // The suffix is the ZONE rather than a battle counter — with a branching
    // board there is no "n of N" any more, and where you are matters more
    // than how far you've come.
    // Trained-agent opponents (dare/spar) bill as their owner's agent.
    const arcadeZone = arcadeRun?.board
      ? REGION_NAME[nodeById(arcadeRun.board, arcadeRun.pending)?.region ?? 1]
      : '';
    const houseName = arcadeRun
      ? `${(bundleOf(solo!.character) as { name?: string }).name ?? solo!.character} · ${arcadeZone}`.toUpperCase()
      : solo?.agentName ?? `HOUSE LV${solo?.level ?? 1}`;
    const m: Match = {
      id: id ?? newMatchId(),
      mode, fee,
      clients: [c0, c1],
      seed: (matchSeed = (matchSeed * 1103515245 + 12345) & 0x7fffffff),
      stage: stageIds.length > 0 ? stageIds[matchSeed % stageIds.length]! : '',
      chars: [c0.character, c1 ? c1.character : solo!.character],
      names: [c0.name, c1?.name ?? houseName],
      solo: solo ? { skill: solo.skill, aiSeed: solo.aiSeed, personality: solo.personality } : null,
      arcadeRun: arcadeRun ?? null,
      items,
      itemRows,
      // Local-sim solo has NO input scheduling at all — zero added latency.
      // PvP sizes the delay from both sides' measured RTT (fallback: fixed).
      delay: solo ? 0 : c1 ? adaptiveDelay(c0, c1) : INPUT_DELAY,
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
    // Resolve the chosen stage's playfield bounds once (part of the pinned,
    // deterministic setup — shipped to clients and used by the verifier).
    m.bounds = stageBoundsOf(m.stage);
    c0.match = m; c0.side = 0; c0.state = 'playing';
    if (c1) { c1.match = m; c1.side = 1; c1.state = 'playing'; }

    const oppName = c1?.name ?? houseName;
    for (const c of m.clients) {
      if (!c) continue;
      const setup: SMatch = {
        t: 'match', matchId: m.id, side: c.side, seed: m.seed, stage: m.stage,
        bounds: m.bounds,
        delay: m.delay,
        chars: [
          { id: m.chars[0], hash: bundleOf(m.chars[0]).versionHash },
          { id: m.chars[1], hash: bundleOf(m.chars[1]).versionHash },
        ],
        names: m.names,
        agents: [m.clients[0].agent, c1?.agent ?? true],
        mode, fee,
        solo: m.solo ?? undefined,
        arcade: arcadeRun
          ? {
            token: arcadeRun.token, node: arcadeRun.pending,
            fights: arcadeRun.fights, total: ARCADE_TOTAL,
          }
          : undefined,
        items: m.items[0].length > 0 || m.items[1].length > 0 ? m.items : undefined,
        resume: m.resumeTokens[c.side],
      };
      send(c, setup);
    }
    liveMatches.set(m.id, m);
    console.log(`[match ${m.id}] ${mode}·fee ${fee} · ${c0.name}${c0.agent ? ' (agent)' : ''} vs ${oppName}${c1?.agent ? ' (agent)' : ''} · seed ${m.seed} · stage ${m.stage}${c1 ? ` · delay ${m.delay} (rtt ${c0.rtt}/${c1.rtt}ms)` : ''}`);
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
        // Never pair an identity against itself: two sockets on one account
        // would escrow ONE fee (the ledger's per-profile idempotency guard
        // swallows the second row) while settlement pays the winner fee*2 —
        // a net credit mint. Kick the later joiner; each pass shrinks the
        // queue by one client, so the while loop still terminates.
        if (c0.identity?.sub && c0.identity.sub === c1.identity?.sub) {
          c1.state = 'lobby';
          send(c1, { t: 'error', msg: 'this account is already queued for a wager match' });
          queue.unshift(c0);
          continue;
        }

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
        // CONSUMABLES (ADR 0007): open carry — each side's EQUIPPED loadout
        // rides in. Reserve both after escrow (a failed claim runs that
        // side dry); only the cans actually drunk stay consumed at settle.
        const e0 = await claimEquipped(c0, matchId);
        const e1 = await claimEquipped(c1, matchId);
        startMatch(c0, c1, 'wager', fee, matchId, undefined, undefined,
          [e0.pins, e1.pins], [e0.rows, e1.rows]);
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
   *
   * DARE-VS-AGENT / SPARRING (ADR 0006): `pin` overrides the house AI with a
   * TRAINED agent (character + clamped personality from its owner's saved
   * config, skill from the OWNER's level). Everything else — fee, escrow,
   * pace check, ledger re-sim, settlement — is exactly ranked solo: the
   * agent's owner is not a party to the match and earns nothing.
   */
  /**
   * CONSUMABLES (ADR 0007 final shape): read this client's EQUIPPED loadout
   * (up to 3 drinks, chosen in the vending-machine screen) and RESERVE each
   * can for this match (consumeItem — the same row can't ride two concurrent
   * matches). Settlement later keeps only the cans actually drunk. A failed
   * reserve NEVER kills the match — it simply runs without that can and the
   * client learns from the SMatch.items echo.
   */
  const claimEquipped = async (c: Client, matchId: string):
    Promise<{ pins: ItemPin[]; rows: number[] }> => {
    const none = { pins: [] as ItemPin[], rows: [] as number[] };
    if (!persistence || !c.identity?.sub || isAgentClassSub(c.identity.sub)) return none;
    try {
      const equipped = await persistence.equippedItems(c.identity.sub);
      const pins: ItemPin[] = [];
      const rows: number[] = [];
      for (const it of equipped.slice(0, 3)) {
        const claimed = await persistence.consumeItem(c.identity.sub, it.rowId, matchId);
        const def = claimed ? itemById(claimed.itemId) : undefined;
        if (claimed && def) {
          pins.push({ id: def.id, name: def.name, tier: def.tier, effect: def.effect });
          rows.push(claimed.rowId);
        }
      }
      if (pins.length > 0) {
        console.log(`[items] ${c.name} carries ${pins.map((p) => p.id).join('+')} into ${matchId}`);
      }
      return { pins, rows };
    } catch (e) {
      console.log(`[items] equip claim failed in ${matchId}: ${String(e)}`);
      return none;
    }
  };

  const startSolo = async (c: Client, pin?: SoloPin): Promise<void> => {
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
    // Resolve AFTER escrow so a slow roster lookup can't race fee refunds,
    // and so dare-vs-agent pins (already resolved) skip another round-trip.
    const resolved = pin ?? await soloOpts(c);
    const claimed = await claimEquipped(c, matchId);
    const items: MatchItems = [claimed.pins, []];
    const itemRows: [number[], number[]] = [claimed.rows, []];
    if (c.ws.readyState !== WebSocket.OPEN) {
      // Vanished after escrow → settle as incomplete so the fee refunds.
      startMatch(c, null, 'solo', fee, matchId, resolved, undefined, items, itemRows);
      return finishMatch(c.match!, null);
    }
    startMatch(c, null, 'solo', fee, matchId, resolved, undefined, items, itemRows);
  };

  /**
   * The one level→skill ramp (house AI AND trained agents — ADR 0006 pins
   * agent strength to its OWNER's level; only style is coachable).
   *
   * Floored at 40 instead of 3: meter decisions in ai.ts are (deliberately)
   * skill-gated, because a novice agent that cashes out bars flattens the
   * difficulty lever the whole CPU system rides on. The side effect was
   * that LV1 faced skill 3, and a skill-3 agent measurably finishes a
   * match sitting on 2857/3000 meter having thrown 2 supers — it hoards
   * three bars and dies with them. 40 is the cheapest skill that actually
   * spends meter (~20 supers / 14 matches, ~2269 leftover) and it only
   * moves the bot's win rate against a weak opponent from 47% to ~57%.
   *
   * Only the FLOOR changed: level 17+ keeps exactly its old skill, so
   * mid/high-level difficulty is untouched. Levels 1-16 now share skill 40
   * (they were 3..40 — all "harmless" tiers, so little progression is lost
   * and every one of them now uses its meter).
   *
   * Server-side only: skill rides in the `solo` setup message and the
   * client obeys it, so this needs no ENGINE_VERSION bump.
   */
  const skillForLevel = (level: number): number =>
    Math.max(40, Math.min(100, Math.round((level * 100) / 40)));

  /**
   * RANKED-SOLO COMFORT BAND (server-only, out-of-sim — no engine bump).
   *
   * `skillForLevel` pins the house AI to your account level, which only ever
   * ratchets UP (losses still pay XP). Two felt problems fall out: difficulty
   * rises exactly while a player is tilting, and you never get to feel
   * stronger than the house — it always tracks you toward a coin-flip.
   *
   * This EASES the house a few points when the player is on a losing run and
   * shaves a small flat offset so improvement reads as ~55% wins, not 50/50.
   * It only ever LOWERS skill (never stiffens above the level calibration),
   * it's floored at 40 like skillForLevel (so low levels are unaffected — the
   * offset can't push below the floor), and it touches RANKED SOLO ONLY:
   * wager is PvP, arcade keeps its own gauntlet ramp, and dare-vs-agent fights
   * keep their pinned owner-level skill (they never reach soloOpts).
   *
   * No abuse vector: deliberately losing to soften the AI costs the fee + XP
   * each time and only eases you toward winning back the +1 you already paid.
   */
  const MASTERY_OFFSET = 4;        // aim ~55% player win-rate vs the flat coin-flip
  const STREAK_EASE_PER_LOSS = 5;  // skill shed per consecutive ranked-solo loss
  const STREAK_EASE_MAX = 12;      // ...capped so a rough run never trivialises it

  /** Trailing consecutive losses across the player's recent RANKED-SOLO games
   *  (other modes are skipped, not counted; a win/draw/incomplete ends the run).
   *  Derived from recentMatches — no new storage, survives reconnects. */
  const soloLossStreak = async (sub: string | undefined): Promise<number> => {
    if (!sub || !persistence) return 0;
    try {
      const recent = await persistence.recentMatches(sub, 6);
      let streak = 0;
      for (const m of recent) {
        if (m.mode !== 'solo') continue; // house-agent context only
        const side = m.p0 === sub ? 0 : m.p1 === sub ? 1 : -1;
        if (side < 0) continue;
        const lost = m.reason !== 'incomplete' && m.winner === (1 - side);
        if (!lost) break; // most recent decided solo wasn't a loss → not tilting
        streak++;
      }
      return streak;
    } catch {
      return 0; // progression signal is best-effort; never block the match
    }
  };

  const easedSoloSkill = (level: number, lossStreak: number): number => {
    const ease = MASTERY_OFFSET + Math.min(STREAK_EASE_MAX, lossStreak * STREAK_EASE_PER_LOSS);
    return Math.max(40, Math.min(100, skillForLevel(level) - ease));
  };

  /**
   * Default ranked-solo opponent: prefer a LIVE agent-class account from the
   * public roster (fleet / headless grinders) nearest the player's level so
   * the select badge, queue copy, nameplate, and match history all share one
   * real identity. Still local-sim — no second socket — but branded as that
   * agent. Falls back to the generic HOUSE LV{n} pin when the roster is empty.
   */
  const soloOpts = async (c: Client): Promise<SoloPin> => {
    const level = c.account?.level ?? 1;
    // Ease the house AI for a player on a losing run (ranked solo only) — one
    // extra read, computed ONCE here so the fallback and the roster pick agree.
    const lossStreak = await soloLossStreak(c.identity?.sub);
    const skill = easedSoloSkill(level, lossStreak);
    if (lossStreak > 0 && skill < skillForLevel(level)) {
      console.log(`[solo] ${c.name} on a ${lossStreak}-loss run → house skill eased ${skillForLevel(level)}→${skill}`);
    }
    const fallback: SoloPin = {
      level,
      skill,
      character: characterIds[Math.floor(Math.random() * characterIds.length)]!,
      aiSeed: ((Date.now() % 100000) + nextMatch) | 0,
    };
    if (!persistence) return fallback;
    try {
      const roster = await persistence.agentRoster();
      const candidates = roster.filter((a) => a.id !== c.identity?.sub);
      if (candidates.length === 0) return fallback;
      // Same nearest-level pick the client uses for the select badge (stable
      // ties: more wins, then name) so "who you're fighting" matches in-match.
      const pick = [...candidates].sort((p, q) =>
        Math.abs(p.level - level) - Math.abs(q.level - level)
        || q.wins - p.wins
        || p.name.localeCompare(q.name),
      )[0]!;
      const info = await persistence.getAgent(pick.id);
      const char = info?.config?.character && characterIds.includes(info.config.character)
        ? info.config.character
        : fallback.character;
      return {
        // Skill stays on the PLAYER's level (fair calibrated fight), eased when
        // they're on a losing run; the nameplate/badge carry the live agent's
        // identity + their W-L.
        level: pick.level,
        skill,
        character: char,
        aiSeed: fallback.aiSeed,
        agentName: pick.name.toUpperCase(),
        personality: info?.config?.personality
          ? clampPersonality(info.config.personality)
          : undefined,
      };
    } catch {
      return fallback;
    }
  };

  /**
   * Resolve a dare/ref code to a pinned TRAINED-agent opponent (ADR 0006).
   * Your own code works too — that's VS MY AGENT sparring. Returns a string
   * error for the client when the code doesn't lead to a coached agent.
   */
  const trainedAgentPin = async (code: string): Promise<SoloPin | string> => {
    if (!persistence) return 'trained agents need the online economy';
    try {
      const owner = await persistence.findByRefCode(code);
      if (!owner) return 'no fighter behind that code';
      const info = await persistence.getAgent(owner.sub);
      if (!info?.config) return `${owner.name} has not trained an agent yet`;
      // Validated at PUT time, but the roster can shrink between then and now.
      if (!characterIds.includes(info.config.character)) {
        return `${owner.name}'s agent mains a retired fighter — they need to re-coach`;
      }
      return {
        level: info.level,
        skill: skillForLevel(info.level),
        character: info.config.character,
        // Style-only by construction: the knobs were clamped at PUT /agent
        // time; clamp again here so a hand-edited DB row still can't smuggle
        // out-of-range values into the pinned setup.
        personality: clampPersonality(info.config.personality),
        agentName: `${owner.name.toUpperCase()}'S AGENT · LV${info.level}`,
        aiSeed: ((Date.now() % 100000) + nextMatch) | 0,
      };
    } catch (err) {
      // A Supabase blip here would otherwise reject up into the queue IIFE
      // (audit 2026-07-20 CT-4). Return a clean, retryable client message
      // instead — no fee has been charged at this point.
      console.error(`[trainedAgentPin] ${code} failed:`, err);
      return 'could not resolve that agent right now — please try again';
    }
  };

  /**
   * AGENT ARCADE v2 (v7, ADR 0008): fight the node the player moved to.
   * Battles never escrow — the non-refundable entry was debited at
   * /arcade/enter, before character select — so a battle costs nothing and
   * a no-contest refunds nothing. Mechanically each one is a local-sim solo
   * match (pinned AI, ledger re-sim); only the opponent sourcing differs.
   */
  const startArcadeBattle = async (c: Client, run: ArcadeRun, node: BoardNode): Promise<void> => {
    const matchId = newMatchId();
    run.awaitingNext = false;
    run.pending = node.id;
    run.lastActive = Date.now();
    const oppChar = node.charId || run.charId;
    const opts = {
      level: c.account?.level ?? 1,
      // The BOARD sets the difficulty (region band); the test hook can force it.
      skill: arcadeSkillOverride
        ? arcadeSkillOverride(run.fights, ARCADE_TOTAL)
        : node.skill ?? 50,
      character: oppChar,
      aiSeed: ((Date.now() % 100000) + nextMatch) | 0,
      // Personality from the character's CANONICAL style (its meta.style — the
      // same style that drives its feel), so a bot plays it like its archetype.
      personality: ARCADE_PERSONALITY[styleOfChar(oppChar)],
    };
    const claimed = await claimEquipped(c, matchId);
    const items: MatchItems = [claimed.pins, []];
    const itemRows: [number[], number[]] = [claimed.rows, []];
    if (c.ws.readyState !== WebSocket.OPEN) {
      // Vanished before the setup landed → settle as incomplete; the run
      // keeps its position and its bag and stays retryable until it expires.
      startMatch(c, null, 'arcade', 0, matchId, opts, run, items, itemRows);
      return finishMatch(c.match!, null);
    }
    startMatch(c, null, 'arcade', 0, matchId, opts, run, items, itemRows);
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
              // Sticky display name from the profile — hello.name must never
              // rename an account (stale fleet-agents.json was minting a
              // second "IRONCLAD" onto the leaderboard via record_match).
              c.name = owner.name;
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
        })().catch((err) => {
          // findByAgentKey / verifyAirToken rejecting (a Supabase or JWKS blip)
          // must not become an unhandled rejection (audit 2026-07-20 CT-4).
          // Leave c.identity unset → the client is treated as unauthenticated,
          // exactly the graceful path the queue handler already guards for.
          console.error(`[auth] identity resolution failed for ${c.name}:`, err);
        });
        return send(c, { t: 'welcome', id: c.id, engine: ENGINE_VERSION });
      }
      case 'queue': {
        if (c.state !== 'lobby') return;
        if (draining) {
          return send(c, { t: 'error', msg: 'server is restarting for an update — back in under a minute, nothing was charged' });
        }
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
        // CONSUMABLES (ADR 0007 final shape): the server reads each
        // profile's EQUIPPED loadout itself (claimEquipped) for solo,
        // arcade AND wager — CQueue.item is deprecated and ignored.
        // Friendly stays dry (unranked, anti-collusion).
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
            // AGENT ARCADE v2 (ADR 0008): THE MOVE IS THE QUEUE. Choosing a
            // route and starting the match are one action, so this handler
            // is also the move validator — and it validates against the
            // SERVER's board, never the client's copy.
            let run = runToken ? arcadeRuns.get(runToken) : undefined;
            if (runToken && !run) {
              return send(c, { t: 'error', msg: 'arcade run is over — enter again from the title' });
            }
            if (!run) {
              // NO TOKEN = open a run right here. Reserved for players who
              // cannot pay and therefore cannot be farming: agent-class
              // accounts (0 credits forever, XP/rank only) and the
              // persistence-off dev/test economy. Everyone else pre-pays at
              // POST /arcade/enter, which is where the consented,
              // non-refundable debit lives.
              const agentClass = isAgentClassSub(c.identity?.sub);
              if (persistence && !agentClass) {
                return send(c, { t: 'error', msg: 'start AGENT ARCADE from the title (entry is paid up front)' });
              }
              // (the per-day battle cap is bumped once, below — this path
              // falls through to the same check every battle takes)
              const roster = enabledCharacterIds.filter((id) => id !== c.character);
              const board = generateBoard({ roster: roster.length > 0 ? roster : [c.character], seed: newBoardSeed() });
              run = {
                token: randomUUID(),
                sub: c.identity?.sub ?? '',
                charId: c.character,
                board,
                at: board.start,
                pending: -1,
                bag: { credits: 0, drinks: [] },
                path: [board.start],
                fights: 0,
                awaitingNext: true,
                extracted: false,
                paid: false,
                lastActive: Date.now(),
              };
              arcadeRuns.set(run.token, run);
            }
            if (run.sub !== (c.identity?.sub ?? '')) {
              return send(c, { t: 'error', code: 'auth', msg: 'not your arcade run' });
            }
            if (run.extracted) {
              return send(c, { t: 'error', msg: 'this run already extracted — enter again from the title' });
            }
            if (!run.board || run.charId === '') {
              return send(c, { t: 'error', msg: 'lock a fighter first (POST /arcade/run)' });
            }
            if (run.charId !== c.character) {
              return send(c, { t: 'error', msg: 'your fighter is locked for the whole arcade run' });
            }
            if (!run.awaitingNext) {
              return send(c, { t: 'error', msg: 'arcade run is not awaiting a battle' });
            }
            if (isAgentClassSub(c.identity?.sub)
              && !agentBattleCap.bump(c.identity!.sub, AGENT_BATTLES_PER_DAY)) {
              return send(c, { t: 'error', msg: `agent accounts get ${AGENT_BATTLES_PER_DAY} arcade battles/day — the run resumes tomorrow` });
            }
            // Headless agents don't read maps — autopilot them down the
            // cheapest line to the deep exit (see autopilotNode).
            const target = typeof msg.arcadeNode === 'number'
              ? msg.arcadeNode | 0
              : autopilotNode(run);
            if (!isLegalMove(run.board, run.at, target)) {
              return send(c, { t: 'error', msg: 'that route does not lead anywhere from where you are standing' });
            }
            const node = nodeById(run.board, target);
            if (!node || !isFightNode(node)) {
              // Exits are reached through POST /arcade/extract, and loot is
              // auto-collected — the only thing you can QUEUE is a fight.
              return send(c, { t: 'error', msg: 'that is not a fight — pick an opponent or extract' });
            }
            c.state = 'queued';
            send(c, { t: 'queued' });
            return startArcadeBattle(c, run, node);
          }
          // Fast pre-check for a friendly error; escrow re-checks atomically.
          const fee = mode === 'solo' ? SOLO_FEE : WAGER_FEE;
          if (persistence && (c.account?.credits ?? 0) < fee) {
            return send(c, { t: 'error', code: 'credits', msg: `${mode === 'solo' ? 'ranked' : 'wager'} match needs ${fee} credit${fee > 1 ? 's' : ''}` });
          }
          // DARE-VS-AGENT / SPARRING (ADR 0006): solo, but the opponent is a
          // TRAINED agent resolved from a dare code. Resolve BEFORE queueing
          // so a bad code is a clean error, not a consumed fee.
          if (mode === 'solo' && typeof msg.agentOf === 'string' && msg.agentOf.trim()) {
            const pin = await trainedAgentPin(msg.agentOf.trim().slice(0, 40));
            if (typeof pin === 'string') return send(c, { t: 'error', msg: pin });
            c.state = 'queued';
            send(c, { t: 'queued' });
            return startSolo(c, pin);
          }
          c.state = 'queued';
          send(c, { t: 'queued' });
          if (mode === 'solo') await startSolo(c);
          else { queue.push(c); void tryPair(); }
        })().catch((err) => {
          // Any throw in the queue path (a Supabase blip in trainedAgentPin, a
          // missing bundle in startMatch) must not crash the process and freeze
          // every other match (audit 2026-07-20 CT-4). Log, free the client from
          // a half-queued state so they can retry, and tell them plainly.
          console.error(`[queue] handler failed for ${c.name}:`, err);
          if (c.state === 'queued') c.state = 'lobby';
          try { send(c, { t: 'error', msg: 'could not start the match — please try again' }); }
          catch { /* socket already gone */ }
        });
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
          m.forfeitTimer = setTimeout(() => safeFinish(m, otherGone), FORFEIT_GRACE_MS);
        }
        const toNullable = (a: number[]): (number | null)[] =>
          Array.from(a, (v) => (v === undefined ? null : v));
        send(c, {
          t: 'resumed', matchId: m.id, side, seed: m.seed, stage: m.stage,
          bounds: m.bounds,
          delay: m.delay, // the PINNED pair-time delay — the ledger was scheduled with it
          chars: [
            { id: m.chars[0], hash: bundleOf(m.chars[0]).versionHash },
            { id: m.chars[1], hash: bundleOf(m.chars[1]).versionHash },
          ],
          names: m.names,
          agents: [m.clients[0].agent, m.clients[1]?.agent ?? true],
          mode: m.mode, fee: m.fee,
          solo: m.solo ?? undefined,
          items: m.items[0].length > 0 || m.items[1].length > 0 ? m.items : undefined,
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
        // WALL-CLOCK PLAUSIBILITY (DoS guard): verification cost is O(ledger
        // length), so high ticks must be EARNED with real elapsed time —
        // without this, one connection ledgers 108,000 ticks in a second and
        // buys a maximal synchronous re-sim per match. Solo mirrors the
        // settlement pace check (a ledger past SOLO_PACE_MIN pace settles
        // 'incomplete' anyway, so nothing legitimate is lost); PvP is
        // lockstep-paced but agent-vs-agent runs faster than realtime, so it
        // gets a generous 20× bound instead.
        const elapsed = Date.now() - m.startedAt;
        const maxTick = opts.noPaceCheck ? Infinity : Math.ceil(
          (m.solo
            ? (elapsed + SOLO_PACE_SLACK_MS) / SOLO_PACE_MIN
            : elapsed * 20 + SOLO_PACE_SLACK_MS) * 60 / 1000,
        );
        if (k < 0 || k > 60 * 60 * 30 || k > maxTick || m.inputs[c.side][k] !== undefined) return;
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
      case 'ping': {
        // Client-initiated RTT probe (connection-quality overlay): echo the
        // client's clock back verbatim — we never interpret it.
        return send(c, { t: 'pong', ts: Number(msg.ts) || 0 });
      }
      case 'pong': {
        // Echo of OUR lobby ping — `ts` is our own Date.now() at send time.
        // Bound the sample so a garbage/replayed ts can't poison the EMA.
        const sample = Date.now() - Number(msg.ts);
        if (!Number.isFinite(sample) || sample < 0 || sample > 60_000) return;
        c.rtt = c.rtt < 0 ? sample : Math.round(c.rtt * 0.7 + sample * 0.3);
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
        else setTimeout(() => safeFinish(m, null), 3000);
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
      safeFinish(m, bothGone ? null : c.side);
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
    void persistence.sweepOrphanedItems()
      .then((n) => { if (n > 0) console.log(`[sweep] released ${n} item(s) stranded by a crash`); })
      .catch((e) => console.log(`[sweep] items failed: ${String((e as Error).message ?? e)}`));
  };
  sweepEscrow();
  const escrowSweep = setInterval(sweepEscrow, 60 * 60 * 1000);
  escrowSweep.unref?.();

  /**
   * Lobby RTT probe: ping every connected HUMAN who isn't mid-match, so
   * that by pair time both sides carry a live RTT estimate for the
   * adaptive input delay. Agents are skipped (headless, latency-blind,
   * and third-party skills may not echo); playing clients are skipped
   * (the delay is pinned at pair time — mid-match probing buys nothing).
   * Old clients simply never answer → INPUT_DELAY fallback at pair time.
   */
  const pingSweep = setInterval(() => {
    for (const c of clients) {
      if (c.agent || c.state === 'playing') continue;
      send(c, { t: 'ping', ts: Date.now() });
    }
  }, PING_INTERVAL_MS);
  pingSweep.unref?.();

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
        m.clients[s] && now - m.lastInputAt[s] > idleMs);
      if (silent.length === 0) continue;
      // Solo/arcade has no human opponent to grief, so a silent player is a
      // NO-CONTEST (fee refunded), never a forfeit loss — a backgrounded tab
      // (rAF throttled, socket still open) must not cost a credit + a loss on
      // a match you were winning. This matches the disconnect path, which
      // already refunds solo via the bothGone short-circuit above. PvP still
      // forfeits the lone silent side (griefing / lag-switch protection).
      const loser = m.solo || silent.length !== 1 ? null : silent[0]!;
      console.log(`[match ${m.id}] idle ${idleMs}ms → ${loser === null ? 'no contest' : `forfeit side ${loser}`}`);
      safeFinish(m, loser);
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

  // Read a POST body with a hard size cap (audit 2026-07-20 H1). The handlers
  // accumulated chunks with NO limit — a multi-GB body (or many concurrent big
  // ones) could OOM the container, a hard kill no try/catch or process handler
  // can catch. On overflow: answer 413, destroy the socket, return null (the
  // caller returns immediately). The ws side already caps at maxPayload 16 KB.
  const MAX_HTTP_BODY = 64 * 1024;
  const readCappedBody = async (
    req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse,
  ): Promise<string | null> => {
    let body = '';
    let size = 0;
    let over = false;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      // Stop BUFFERING past the cap but keep draining the stream to its end,
      // rather than breaking/destroying the socket mid-flush — that would race
      // the 413 write and reset the connection before the client reads it. The
      // point of the cap is bounded MEMORY (no unbounded `body +=`), which this
      // preserves; the discarded chunks are GC'd each turn of the loop.
      if (over || size > MAX_HTTP_BODY) { over = true; continue; }
      body += chunk;
    }
    if (over) { json(res, 413, { error: 'request body too large' }); return null; }
    return body;
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
    // Opponent identity for the AGENT ARCADE / VS-AGENT select-screen badge
    // AND the ranked-solo house pin: live agent-class roster (fleet/headless
    // with W-L) + the house aggregate. Client + server pick the same nearest
    // agent; empty roster falls back to the generic house agent.
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
    // ---- ARCADE ENTRY (ADR 0007 credits rework). Owner auth only. The
    // consented, NON-refundable 1-credit entry is debited HERE — before
    // character select — via debit_credits (idempotent by the client nonce;
    // a network retry never double-charges, it just mints a fresh run
    // token). The run is created UNLOCKED (charId '') and the fighter locks
    // at the first battle's queue. Losing, disconnecting, or abandoning the
    // run never refunds the entry: the reason is 'arcade', which the escrow
    // sweeper's ghost query (reason 'fee') deliberately does not match.
    // Agent-class accounts enter FREE (their battle cap applies at queue).
    if (path === '/arcade/enter') {
      if (req.method !== 'POST') return json(res, 405, { error: 'POST {nonce} to enter' });
      if (draining) return json(res, 503, { error: 'server is restarting for an update — try again in a minute' });
      const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1];
      const devName = persistence?.dev ? String(req.headers['x-dev-name'] ?? '') : '';
      void (async () => {
        const identity = bearer ? await verifyAirToken(bearer)
          : devName ? { sub: `dev:${devName.slice(0, 24)}` }
          : null;
        if (!identity) return json(res, 401, { error: 'sign in required' });
        const body = await readCappedBody(req, res);
        if (body === null) return;
        let nonce = '';
        try { nonce = String((JSON.parse(body || '{}') as Record<string, unknown>).nonce ?? ''); }
        catch { return json(res, 400, { error: 'bad json' }); }
        nonce = nonce.trim();
        if (nonce.length < 8 || nonce.length > 64) {
          return json(res, 400, { error: 'nonce: 8-64 characters (client entry id)' });
        }
        let credits: number | null = null;
        if (persistence && !isAgentClassSub(identity.sub)) {
          try {
            const r = await persistence.debitCredits(identity.sub, ARCADE_FEE, 'arcade', nonce);
            credits = r.credits;
          } catch (e) {
            if (e instanceof InsufficientCredits) {
              return json(res, 402, { error: `AGENT ARCADE needs ${ARCADE_FEE} credit`, code: 'credits' });
            }
            throw e;
          }
        }
        const run: ArcadeRun = {
          token: randomUUID(),
          sub: identity.sub,
          charId: '', // locks at POST /arcade/run, which also mints the board
          board: null,
          at: -1,
          pending: -1,
          bag: { credits: 0, drinks: [] },
          path: [],
          fights: 0,
          awaitingNext: true,
          extracted: false,
          paid: true,
          lastActive: Date.now(),
        };
        arcadeRuns.set(run.token, run);
        console.log(`[arcade] ${identity.sub} paid entry (nonce ${nonce.slice(0, 12)}…) → run ${run.token.slice(0, 8)}`);
        return json(res, 200, { token: run.token, fee: ARCADE_FEE, credits });
      })().catch((e) => json(res, 502, { error: String(e) }));
      return;
    }
    // ---- ARCADE RUN STATE (ADR 0008). One endpoint does two jobs, because
    // they are the same job: given a run token, tell me everything about
    // this run. Passing `character` on the first call LOCKS the fighter and
    // MINTS the board (which needs the roster minus the player's own
    // fighter, and so cannot be generated at /arcade/enter — that happens
    // before character select). Every later call is a plain read, which is
    // also the RESUME path: the board lives here, not in the client, so an
    // iOS jetsam kill mid-run comes back standing exactly where it fell.
    if (path === '/arcade/run') {
      if (req.method !== 'POST') return json(res, 405, { error: 'POST {token, character?}' });
      const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1];
      const devName = persistence?.dev ? String(req.headers['x-dev-name'] ?? '') : '';
      void (async () => {
        const identity = bearer ? await verifyAirToken(bearer)
          : devName ? { sub: `dev:${devName.slice(0, 24)}` }
          : null;
        if (!identity) return json(res, 401, { error: 'sign in required' });
        const body = await readCappedBody(req, res);
        if (body === null) return;
        let payload: { token?: unknown; character?: unknown };
        try { payload = JSON.parse(body || '{}') as typeof payload; }
        catch { return json(res, 400, { error: 'bad json' }); }
        const token = String(payload.token ?? '');
        const run = arcadeRuns.get(token);
        if (!run) return json(res, 404, { error: 'arcade run is over — enter again from the title' });
        if (run.sub !== identity.sub) return json(res, 403, { error: 'not your arcade run' });

        const character = String(payload.character ?? '');
        if (run.charId === '') {
          if (!character) return json(res, 400, { error: 'character required to start the run' });
          if (!enabledCharacterIds.includes(character)) {
            return json(res, 400, { error: `unknown or disabled character "${character}"` });
          }
          run.charId = character;
          // Roster minus the player. A one-character roster falls back to a
          // mirror match rather than an empty board.
          const roster = enabledCharacterIds.filter((id) => id !== character);
          run.board = generateBoard({ roster: roster.length > 0 ? roster : [character], seed: newBoardSeed() });
          run.at = run.board.start;
          run.path = [run.board.start];
          console.log(`[arcade] run ${token.slice(0, 8)} board "${run.board.templateId}" seed ${run.board.seed} as ${character}`);
        } else if (character && character !== run.charId) {
          return json(res, 409, { error: 'your fighter is locked for the whole arcade run' });
        }
        run.lastActive = Date.now();
        return json(res, 200, arcadeRunState(run));
      })().catch((e) => json(res, 502, { error: String(e) }));
      return;
    }
    // ---- ARCADE EXTRACTION (ADR 0008): bank the bag and end the run. This
    // is the ONLY way credits ever leave the board — dying, quitting, or
    // letting the run expire all forfeit everything carried.
    if (path === '/arcade/extract') {
      if (req.method !== 'POST') return json(res, 405, { error: 'POST {token, node}' });
      const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1];
      const devName = persistence?.dev ? String(req.headers['x-dev-name'] ?? '') : '';
      void (async () => {
        const identity = bearer ? await verifyAirToken(bearer)
          : devName ? { sub: `dev:${devName.slice(0, 24)}` }
          : null;
        if (!identity) return json(res, 401, { error: 'sign in required' });
        const body = await readCappedBody(req, res);
        if (body === null) return;
        let payload: { token?: unknown; node?: unknown };
        try { payload = JSON.parse(body || '{}') as typeof payload; }
        catch { return json(res, 400, { error: 'bad json' }); }
        const token = String(payload.token ?? '');
        const run = arcadeRuns.get(token);
        if (!run) return json(res, 404, { error: 'arcade run is over — enter again from the title' });
        if (run.sub !== identity.sub) return json(res, 403, { error: 'not your arcade run' });
        if (run.extracted) return json(res, 409, { error: 'this run already extracted' });
        if (!run.board) return json(res, 409, { error: 'this run has not started' });
        if (!run.awaitingNext || run.pending >= 0) {
          return json(res, 409, { error: 'finish the fight you are in first' });
        }
        // The exit must be one step from where the run is STANDING. This is
        // the whole anti-cheat surface for extraction: a client can ask to
        // walk out of any door it can actually reach, and no other.
        const target = Number(payload.node ?? -1) | 0;
        if (!isLegalMove(run.board, run.at, target)) {
          return json(res, 400, { error: 'no exit from where you are standing' });
        }
        const node = nodeById(run.board, target);
        if (!node || node.kind !== 'exit' || !node.exitTier) {
          return json(res, 400, { error: 'that is not an extraction point' });
        }

        run.at = target;
        run.path.push(target);
        // Mark first, DELETE LAST. `extracted` is what stops a concurrent or
        // double-tapped second extract (both the queue handler and the check
        // above refuse it), while keeping the run addressable until the money
        // has actually moved. Forgetting the run before the payout lands
        // would strand a bag the ledger never paid for — the mirror of the
        // orphaned-escrow gap ADR 0005 had to go back and sweep.
        run.extracted = true;
        run.lastActive = Date.now();

        const bonus = EXIT_BONUS[node.exitTier];
        const bagCredits = run.bag.credits + bonus;
        // Agent-class accounts are economically inert by construction: they
        // run the board for XP and rank only, and bank nothing.
        if (!persistence || isAgentClassSub(run.sub)) {
          arcadeRuns.delete(token);
          return json(res, 200, {
            exitTier: node.exitTier, bonus, bag: run.bag.credits,
            granted: 0, multiplierPct: 0, credits: null, drinks: [],
            drinksLeftBehind: 0, fights: run.fights,
          });
        }
        let paid: ArcadeExtract;
        try {
          paid = await persistence.arcadeExtract(run.sub, token, bagCredits);
        } catch (err) {
          // The bank blipped. Re-arm the run so the player can extract again
          // rather than losing a bag they earned — arcade_extract is
          // idempotent by run token, so a retry can never double-pay.
          run.extracted = false;
          throw err;
        }
        // Board drinks ride the level-up free-pull path: cost 0, deterministic
        // nonce, so a retried extraction re-reveals rather than re-grants.
        const drinks: { itemId: string; tier: number }[] = [];
        for (let i = 0; i < Math.min(run.bag.drinks.length, paid.drinkBudget); i++) {
          const d = run.bag.drinks[i]!;
          try {
            const r = await persistence.buyItem(run.sub, 0, d.itemId, d.tier, `xtr:${token}:${i}`);
            drinks.push({ itemId: r.itemId, tier: r.tier });
          } catch (err) {
            console.log(`[arcade] drink grant failed for ${run.sub}: ${String(err)}`);
          }
        }
        arcadeRuns.delete(token); // paid and banked — now it is safe to forget
        console.log(`[arcade] ${run.sub} EXTRACTED at tier ${node.exitTier} after ${run.fights} fights — ${bagCredits} CR × ${paid.multiplierPct}% = ${paid.granted}, ${drinks.length}/${run.bag.drinks.length} drink(s)`);
        return json(res, 200, {
          exitTier: node.exitTier,
          bonus,
          bag: run.bag.credits,
          granted: paid.granted,
          multiplierPct: paid.multiplierPct,
          credits: paid.credits,
          drinks,
          drinksLeftBehind: Math.max(0, run.bag.drinks.length - drinks.length),
          fights: run.fights,
        });
      })().catch((e) => json(res, 502, { error: String(e) }));
      return;
    }
    // ---- VENDING MACHINE (ADR 0007 Phase 1). Owner auth ONLY (AIR JWT /
    // dev header) — agent keys are deliberately refused so a leaked coach
    // key can never drain the owner's credits into gacha pulls. Agent-class
    // accounts are refused outright (they hold 0 credits by construction;
    // this is belt-and-braces).
    //   GET  /items       → { cost, catalog, items: [inventory w/ equippedSlot] }
    //   POST /items/buy   → body { nonce } → server-side roll + atomic debit;
    //                       idempotent by nonce (a retry replays the grant).
    //   POST /items/equip → body { rowIds: number[] } (≤3, slot order) —
    //                       replaces the whole equipped loadout; [] unequips
    //                       all. These cans ride into every ranked match.
    if (path === '/items' || path === '/items/buy' || path === '/items/equip') {
      if (!persistence) return json(res, 503, { error: 'persistence not configured' });
      const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1];
      const devName = persistence.dev ? String(req.headers['x-dev-name'] ?? '') : '';
      void (async () => {
        const identity = bearer ? await verifyAirToken(bearer)
          : devName ? { sub: `dev:${devName.slice(0, 24)}` }
          : null;
        if (!identity) return json(res, 401, { error: 'sign in required' });
        if (isAgentClassSub(identity.sub)) {
          return json(res, 403, { error: 'agent-class accounts have no credits to spend' });
        }

        if (path === '/items/equip') {
          if (req.method !== 'POST') return json(res, 405, { error: 'POST {rowIds} to equip' });
          const body = await readCappedBody(req, res);
          if (body === null) return;
          let rowIds: number[] = [];
          try {
            const raw = (JSON.parse(body || '{}') as Record<string, unknown>).rowIds;
            if (!Array.isArray(raw)) return json(res, 400, { error: 'rowIds: number[] required' });
            rowIds = raw.filter((r): r is number => typeof r === 'number' && Number.isInteger(r) && r > 0);
          } catch { return json(res, 400, { error: 'bad json' }); }
          if (rowIds.length > 3) return json(res, 400, { error: 'equip at most 3 drinks' });
          await persistence.setEquipped(identity.sub, rowIds);
          const equipped = await persistence.equippedItems(identity.sub);
          return json(res, 200, {
            equipped: equipped.map((it) => ({
              ...it, def: ITEMS.find((d) => d.id === it.itemId) ?? null,
            })),
          });
        }

        if (path === '/items/buy') {
          if (req.method !== 'POST') return json(res, 405, { error: 'POST {nonce} to buy' });
          const body = await readCappedBody(req, res);
          if (body === null) return;
          let nonce = '';
          try { nonce = String((JSON.parse(body || '{}') as Record<string, unknown>).nonce ?? ''); }
          catch { return json(res, 400, { error: 'bad json' }); }
          nonce = nonce.trim();
          if (nonce.length < 8 || nonce.length > 64) {
            return json(res, 400, { error: 'nonce: 8-64 characters (client purchase id)' });
          }
          const rolled = rollItem();
          try {
            const r = await persistence.buyItem(identity.sub, ITEM_COST, rolled.id, rolled.tier, nonce);
            // On a duplicate replay the ROLL above is discarded — the stored
            // grant wins, so a retry can never re-roll a better can.
            const def = ITEMS.find((i) => i.id === r.itemId) ?? rolled;
            if (!r.duplicate) console.log(`[shop] ${identity.sub} pulled ${def.id} (T${def.tier}) for ${ITEM_COST}`);
            return json(res, 200, {
              item: def, rowId: r.rowId, credits: r.credits,
              duplicate: r.duplicate, cost: r.duplicate ? 0 : ITEM_COST,
            });
          } catch (e) {
            if (e instanceof InsufficientCredits) {
              return json(res, 402, { error: `insufficient credits — a pull costs ${ITEM_COST}`, code: 'credits' });
            }
            throw e;
          }
        }

        const items = await persistence.listItems(identity.sub, 50);
        return json(res, 200, {
          cost: ITEM_COST,
          catalog: ITEMS,
          // The SHOP identity's balance (plain read, may be null for a
          // never-seen profile) — the client shows THIS in the shop, not the
          // /me wallet, so the number on screen is the wallet being charged.
          credits: await persistence.getCredits(identity.sub),
          items: items.map((it) => ({
            ...it, def: ITEMS.find((d) => d.id === it.itemId) ?? null,
          })),
        });
      })().catch((e) => json(res, 502, { error: String(e) }));
      return;
    }
    // ---- Self-serve key mint (Minds MVP): a tiny standalone page — AIR
    // sign-in → POST /agent/key → key shown once + Minds hand-off steps.
    if (path === '/connect') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...CORS });
      return res.end(connectPageHtml());
    }
    // ---- AGENT-CLASS CREATE (unified with in-game mint): AIR owner required.
    // Creates an inert agent:<uuid> fighter owned by the signed-in operator.
    // Same key shape (afk_…) as POST /agent/key, but a SEPARATE profile —
    // coach keys stay on the human row; fleet/headless keys are agent-class.
    if (path === '/agent/signup') {
      if (req.method !== 'POST') return json(res, 405, { error: 'POST {name?} to create an agent fighter' });
      if (!persistence) return json(res, 503, { error: 'persistence not configured' });
      const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1];
      const devName = persistence.dev ? String(req.headers['x-dev-name'] ?? '') : '';
      const ip = (String(req.headers['x-forwarded-for'] ?? '').split(',')[0] ?? '').trim()
        || req.socket.remoteAddress || 'unknown';
      void (async () => {
        let ownerSub: string | null = null;
        if (bearer) {
          const id = await verifyAirToken(bearer);
          if (id) ownerSub = id.sub;
        } else if (devName) {
          ownerSub = `dev:${devName.slice(0, 24)}`;
        }
        if (!ownerSub) {
          return json(res, 401, { error: 'sign in to create an agent fighter (in-game MY AGENT or /connect)' });
        }
        if (isAgentClassSub(ownerSub)) {
          return json(res, 403, { error: 'agent-class keys cannot mint more agents' });
        }
        if (!signupCap.bump(`ip:${ip}`, SIGNUPS_PER_IP_PER_DAY)) {
          return json(res, 429, { error: `signup limit: ${SIGNUPS_PER_IP_PER_DAY}/day per IP` });
        }
        if ((await persistence.countOwnedAgents(ownerSub)) >= AGENTS_PER_OWNER) {
          return json(res, 429, { error: `agent limit: ${AGENTS_PER_OWNER} fighters per account` });
        }
        // Ensure the operator profile exists (same prerequisite as /agent/key).
        // Empty name → get_account keeps any existing display name (0009).
        await persistence.getAccount({ sub: ownerSub }, '', false);
        const ownerInfo = await persistence.getAgent(ownerSub);
        const body = await readCappedBody(req, res);
        if (body === null) return;
        let name = '';
        try { name = String((JSON.parse(body || '{}') as Record<string, unknown>).name ?? ''); }
        catch { return json(res, 400, { error: 'bad json' }); }
        name = name.trim().slice(0, 24);
        if (name.length < 3) {
          // Canvas UI has no text field → derive from the owner + short tag.
          const tag = randomBytes(2).toString('hex').toUpperCase();
          const stem = (ownerInfo?.name || devName || 'AGENT')
            .replace(/[^A-Za-z0-9]/g, '').slice(0, 10).toUpperCase() || 'AGENT';
          name = `${stem}${tag}`.slice(0, 24);
        }
        for (let i = 0; i < 8 && await persistence.nameTaken(name); i++) {
          const tag = randomBytes(2).toString('hex').toUpperCase();
          name = `${name.replace(/[0-9A-F]{2,4}$/i, '').slice(0, 20)}${tag}`.slice(0, 24);
        }
        if (await persistence.nameTaken(name)) {
          return json(res, 409, { error: 'name already taken — pick another' });
        }
        const sub = `agent:${randomUUID()}`;
        const key = `afk_${randomBytes(24).toString('hex')}`;
        if (!(await persistence.createAgentAccount(sub, name, sha256Hex(key), ownerSub))) {
          return json(res, 500, { error: 'could not create account — try again' });
        }
        console.log(`[signup] agent account ${name} = ${sub} owner=${ownerSub} (${ip})`);
        return json(res, 200, {
          sub, name, key, owner: ownerSub,
          note: 'store the key now — it is never shown again',
          account: 'agent-class: free arcade/rank play, no credits, wager unavailable',
          play: 'ws hello { agentKey } → queue { mode: "arcade" } · or AF_AGENT_KEY=… npm run agent',
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
          const body = await readCappedBody(req, res);
          if (body === null) return;
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
    let agentsOnline = 0;
    for (const c of clients) if (c.agent) agentsOnline++;
    return json(res, 200, {
      game: 'agent-fighter', engine: ENGINE_VERSION, protocol: PROTOCOL_VERSION,
      characters: characterIds, stages: stageIds,
      online: clients.size, agents: agentsOnline, queued: queue.length,
      persistence: !!persistence,
    });
  });
  // maxPayload: the ws default is 100 MiB PER FRAME, fully buffered then
  // JSON.parsed. The largest legitimate client message is a hello carrying
  // an AIR JWT (~2 KB); 16 KiB leaves generous headroom and turns a
  // memory-pressure frame into an immediate 1009 close.
  const wss = new WebSocketServer({ server: http, maxPayload: 16 * 1024 });

  wss.on('connection', (ws, req) => {
    const ip = (String(req.headers['x-forwarded-for'] ?? '').split(',')[0] ?? '').trim()
      || req.socket.remoteAddress || 'unknown';
    const perIp = connsByIp.get(ip) ?? 0;
    if (clients.size >= MAX_CONNS || perIp >= MAX_CONNS_PER_IP) {
      // 1013 = Try Again Later. Refuse BEFORE allocating a Client or joining
      // the sweeps — a flood must never grow the live set (v1.02_scale).
      try { ws.close(1013, 'server busy'); } catch { /* already closing */ }
      return;
    }
    connsByIp.set(ip, perIp + 1);
    const c: Client = {
      ws, id: `c${nextId++}`, name: 'anon', agent: false,
      state: 'lobby', character: '', match: null, side: 0, identity: null,
      identityReady: Promise.resolve(),
      account: null,
      email: '',
      rtt: -1,
    };
    clients.add(c);
    // BLAST-RADIUS GUARD: onMessage runs finishMatch (verification, item
    // settlement) SYNCHRONOUSLY — an uncaught throw here would take down the
    // whole process and strand every live match mid-"VERIFYING WITH SERVER"
    // (seen live 2026-07-20 when a deploy restarted the container). A bad
    // message/settle must cost ONE client an error, never the server.
    ws.on('message', (data) => {
      try {
        onMessage(c, String(data));
      } catch (e) {
        console.error(`[ws] handler error (client ${c.id} ${c.name}):`, e);
        send(c, { t: 'error', msg: 'internal error — the match settles by the disconnect ladder' });
      }
    });
    ws.on('close', () => {
      const n = (connsByIp.get(ip) ?? 1) - 1;
      if (n <= 0) connsByIp.delete(ip); else connsByIp.set(ip, n);
      onClose(c);
    });
    ws.on('error', () => { /* close follows */ });
  });

  const close = (): void => {
    clearInterval(idleSweep); clearInterval(escrowSweep); clearInterval(pingSweep);
    wss.close(); http.close();
  };

  const shutdown = async (): Promise<void> => {
    if (draining) return;
    draining = true;
    const live = [...liveMatches.values()];
    console.log(`[shutdown] draining — settling ${live.length} live match(es) by the ladder`);
    for (const m of live) {
      // finishMatch verifies the ledger: a fight the player already won
      // settles VERIFIED (payout lands); anything undecided is a no-contest
      // refund. Clients get the result before their socket dies, so nobody
      // is left staring at "VERIFYING WITH SERVER…".
      try { finishMatch(m, null); } catch (e) { console.error(`[shutdown] settle failed for ${m.id}:`, e); }
    }
    // Settlement persistence is fire-and-forget — give it a moment to land.
    if (live.length > 0) await new Promise((r) => setTimeout(r, 2500));
    console.log('[shutdown] drained, closing');
    close();
  };

  return new Promise((resolve) => {
    http.listen(opts.port ?? DEFAULT_PORT, () => {
      const address = http.address();
      const port = typeof address === 'object' && address ? address.port : DEFAULT_PORT;
      resolve({ port, close, shutdown });
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

  // Deploys send SIGTERM (Railway waits RAILWAY_DEPLOYMENT_DRAINING_SECONDS
  // before SIGKILL) — drain instead of dying mid-verification. The fallback
  // exit covers a drain that itself hangs; unref'd so it never holds the
  // process open after a clean drain.
  const bail = (sig: string): void => {
    console.log(`[shutdown] ${sig} received`);
    void server.shutdown().then(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on('SIGTERM', () => bail('SIGTERM'));
  process.on('SIGINT', () => bail('SIGINT'));

  // Last-resort safety net (audit 2026-07-20 CT-4). Several async paths — the
  // identityReady IIFE, the queue handler, timer-invoked finishMatch — can
  // reject/throw outside the ws message guard; Node's default is to KILL the
  // process, freezing EVERY live match at "VERIFYING WITH SERVER…". Logging and
  // staying up keeps one bad match (a Supabase blip, a missing bundle) from
  // taking down everyone else. This is a stopgap; the durable fix is targeted
  // try/catch at each site. Registered only here (isMain), never in
  // createMatchServer, so tests that spin up many servers don't stack listeners.
  process.on('unhandledRejection', (reason) => {
    console.error(`[fatal] unhandledRejection (kept alive):`, reason);
  });
  process.on('uncaughtException', (err) => {
    console.error(`[fatal] uncaughtException (kept alive):`, err);
  });
}
