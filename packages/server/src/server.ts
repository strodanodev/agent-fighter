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
import { createServer as createHttpServer } from 'node:http';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import {
  ENGINE_VERSION, Phase, aiPoll, createAi, createGameState, loadCharacter,
  setCharacters, stateHash, step,
} from '@af/core';
import type { CharacterBundle } from '@af/core';
import {
  DEFAULT_PORT, FORFEIT_GRACE_MS, IDLE_FORFEIT_MS, INPUT_DELAY, PROTOCOL_VERSION,
  SOLO_PACE_MAX, SOLO_PACE_MIN, SOLO_PACE_SLACK_MS,
} from './protocol.js';
import type { ClientMsg, SMatch, SResult, ServerMsg } from './protocol.js';
import { verifyAirToken } from './airjwt.js';
import type { AirIdentity } from './airjwt.js';
import {
  InsufficientCredits, SOLO_FEE, WAGER_FEE, createPersistence, loadDotEnv,
} from './persist.js';
import type { Account, MatchMode, Persistence } from './persist.js';
import { createAirIssuer, loadIssuerConfig } from './air-issuer.js';
import type { AirIssuer } from './air-issuer.js';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(here, '..', '..', '..');

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
  mode: MatchMode;
  fee: number;
  /** Solo (v3): clients[1] is null — the opponent is the pinned AI below. */
  clients: [Client, Client | null];
  seed: number;
  stage: string;
  chars: [string, string];
  /** Local-sim solo: the deterministic house AI the client must simulate. */
  solo: { skill: number; aiSeed: number } | null;
  startedAt: number; // wall clock — solo pace sanity (SOLO_PACE_*)
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

  const clients = new Set<Client>();
  const queue: Client[] = [];
  let nextId = 1;
  let nextMatch = 1;
  let matchSeed = (Date.now() % 100_000) | 0; // server-side is allowed wall clock
  /** Filled once http.listen resolves — house bots dial back to this port. */

  const send = (c: Client, msg: ServerMsg): void => {
    if (c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify(msg));
  };

  const finishMatch = (m: Match, forfeitLoser: 0 | 1 | null): void => {
    if (m.finished) return;
    m.finished = true;
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
    if (persistence) {
      void persistence.recordMatch({
        matchId: m.id, mode: m.mode, fee: m.fee,
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
    c0: Client, c1: Client | null, mode: MatchMode, fee: number, id?: string,
    solo?: { skill: number; aiSeed: number; character: string; level: number },
  ): void => {
    const m: Match = {
      id: id ?? `m${nextMatch++}`,
      mode, fee,
      clients: [c0, c1],
      seed: (matchSeed = (matchSeed * 1103515245 + 12345) & 0x7fffffff),
      stage: stageIds.length > 0 ? stageIds[matchSeed % stageIds.length]! : '',
      chars: [c0.character, c1 ? c1.character : solo!.character],
      solo: solo ? { skill: solo.skill, aiSeed: solo.aiSeed } : null,
      startedAt: Date.now(),
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
        names: [m.clients[0].name, oppName],
        agents: [m.clients[0].agent, c1?.agent ?? true],
        mode, fee,
        solo: m.solo ?? undefined,
      };
      send(c, setup);
    }
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
        const matchId = `m${nextMatch++}`;
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
    const matchId = `m${nextMatch++}`;
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
      skill: Math.max(3, Math.min(100, Math.round((level * 100) / 40))),
      character: characterIds[Math.floor(Math.random() * characterIds.length)]!,
      aiSeed: ((Date.now() % 100000) + nextMatch) | 0,
    };
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
        c.identityReady = (async () => {
          if (auth) {
            c.identity = await verifyAirToken(auth);
            if (c.identity) console.log(`[auth] ${c.name} = ${c.identity.sub}${c.identity.address ? ` (${c.identity.address.slice(0, 10)}…)` : ''}`);
          }
          if (!c.identity && persistence?.dev) {
            // DEV economy only: name-keyed identity so the whole credit loop
            // runs without AIR/Supabase. supabasePersistence never does this.
            c.identity = { sub: `dev:${c.name}` };
          }
          if (c.identity && persistence) {
            try {
              c.account = await persistence.getAccount(c.identity, c.name, c.agent);
              send(c, { t: 'account', ...c.account });
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

        const mode: MatchMode = msg.mode === 'solo' ? 'solo' : 'wager';
        void (async () => {
          await c.identityReady;
          if (c.state !== 'lobby' || c.ws.readyState !== WebSocket.OPEN) return;
          if (persistence && !c.identity) {
            return send(c, { t: 'error', code: 'auth', msg: 'sign in to play ranked/wager matches' });
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
    const m = c.match;
    if (!m || m.finished) return;
    m.gone[c.side] = true;
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
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Dev-Name',
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
        const name = devName || identity.sub.slice(0, 12);
        return json(res, 200, await persistence.getAccount(identity, name, false));
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
