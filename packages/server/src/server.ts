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
  ENGINE_VERSION, Phase, createGameState, loadCharacter, setCharacters,
  stateHash, step,
} from '@af/core';
import type { CharacterBundle } from '@af/core';
import {
  DEFAULT_PORT, FORFEIT_GRACE_MS, INPUT_DELAY, PROTOCOL_VERSION, SOLO_INPUT_DELAY,
} from './protocol.js';
import type { ClientMsg, SMatch, SResult, ServerMsg } from './protocol.js';
import { verifyAirToken } from './airjwt.js';
import type { AirIdentity } from './airjwt.js';
import {
  InsufficientCredits, SOLO_FEE, WAGER_FEE, createPersistence, loadDotEnv,
} from './persist.js';
import type { Account, MatchMode, Persistence } from './persist.js';
import { playOneMatch } from './agent-session.js';
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
  /** True for the server's own in-process house bots. */
  house: boolean;
  isLoopback: boolean;
  /** AIR-account email — only the reputation write-back target (ADR 0004). */
  email: string;
}

interface Match {
  id: string;
  mode: MatchMode;
  fee: number;
  clients: [Client, Client];
  seed: number;
  stage: string;
  chars: [string, string];
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

// ---------------------------------------------------------------- server
export const createMatchServer = (opts: {
  port?: number;
  root?: string;
  /** Test hook: overrides the Supabase-backed persistence (null = off). */
  persistence?: Persistence | null;
  /** House-bot emission cadence (ms). 16 = real-time (default); tests use 1. */
  housePaceMs?: number;
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
  let boundPort = opts.port && opts.port > 0 ? opts.port : DEFAULT_PORT;

  const send = (c: Client, msg: ServerMsg): void => {
    if (c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify(msg));
  };

  const finishMatch = (m: Match, forfeitLoser: 0 | 1 | null): void => {
    if (m.finished) return;
    m.finished = true;
    if (m.forfeitTimer) clearTimeout(m.forfeitTimer);

    let result: SResult;
    if (forfeitLoser !== null) {
      // Rage-quit policy (ADR 0003): the quitter loses. Verify what we have
      // anyway so the partial ledger is still checked + archived.
      const v = verifyLedger([bundleOf(m.chars[0]), bundleOf(m.chars[1])], m.seed, m.inputs);
      result = {
        t: 'result', winner: 1 - forfeitLoser, reason: 'forfeit',
        rounds: v.rounds, endTick: v.endTick, hash: v.hash,
      };
    } else {
      const v = verifyLedger([bundleOf(m.chars[0]), bundleOf(m.chars[1])], m.seed, m.inputs);
      // Desync forensics: whose reported hashes diverge from the re-sim?
      let deviator: 0 | 1 | undefined;
      outer:
      for (const side of [0, 1] as const) {
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
      result = {
        t: 'result',
        winner: v.reachedEnd ? v.winner : -1,
        reason: v.reachedEnd ? 'verified' : 'incomplete',
        rounds: v.rounds, endTick: v.endTick, hash: v.hash, deviator,
      };
    }
    for (const c of m.clients) {
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
        identities: [m.clients[0].identity, m.clients[1].identity],
        names: [m.clients[0].name, m.clients[1].name],
        agents: [m.clients[0].agent, m.clients[1].agent],
        chars: m.chars,
        winner: result.winner, reason: result.reason,
        rounds: result.rounds, endTick: result.endTick, hash: result.hash,
        deviator: result.deviator,
        engine: ENGINE_VERSION,
      }).then((awards) => {
        for (const a of awards) {
          const cl = m.clients[a.side];
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
    const n = Math.min(m.inputs[0].length, m.inputs[1].length);
    if (tick > n) return null;
    setCharacters(loadCharacter(bundleOf(m.chars[0])), loadCharacter(bundleOf(m.chars[1])));
    const g = createGameState(m.seed);
    for (let t = 0; t < tick && g.phase !== Phase.MatchOver; t++) {
      step(g, [m.inputs[0][t]! | 0, m.inputs[1][t]! | 0]);
    }
    return stateHash(g);
  };

  const startMatch = (c0: Client, c1: Client, mode: MatchMode, fee: number, id?: string): void => {
    const m: Match = {
      id: id ?? `m${nextMatch++}`,
      mode, fee,
      clients: [c0, c1],
      seed: (matchSeed = (matchSeed * 1103515245 + 12345) & 0x7fffffff),
      stage: stageIds.length > 0 ? stageIds[matchSeed % stageIds.length]! : '',
      chars: [c0.character, c1.character],
      inputs: [[], []],
      hashes: [new Map(), new Map()],
      overAt: [-1, -1],
      finished: false,
      forfeitTimer: null,
    };
    c0.match = m; c0.side = 0; c0.state = 'playing';
    c1.match = m; c1.side = 1; c1.state = 'playing';

    for (const c of m.clients) {
      const setup: SMatch = {
        t: 'match', matchId: m.id, side: c.side, seed: m.seed, stage: m.stage,
        delay: mode === 'solo' ? SOLO_INPUT_DELAY : INPUT_DELAY,
        chars: [
          { id: m.chars[0], hash: bundleOf(m.chars[0]).versionHash },
          { id: m.chars[1], hash: bundleOf(m.chars[1]).versionHash },
        ],
        names: [m.clients[0].name, m.clients[1].name],
        agents: [m.clients[0].agent, m.clients[1].agent],
        mode, fee,
      };
      send(c, setup);
    }
    console.log(`[match ${m.id}] ${mode}·fee ${fee} · ${c0.name}${c0.agent ? ' (agent)' : ''} vs ${c1.name}${c1.agent ? ' (agent)' : ''} · seed ${m.seed} · stage ${m.stage}`);
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

  /** Pending ranked-solo players, waiting for their spawned house bot. */
  const soloWaiting = new Map<string, Client>();

  const spawnHouseBot = (player: Client, port: number): void => {
    const level = player.account?.level ?? 1;
    const skill = Math.max(3, Math.min(100, Math.round((level * 100) / 40)));
    const character = characterIds[Math.floor(Math.random() * characterIds.length)]!;
    soloWaiting.set(player.id, player);
    void playOneMatch({
      url: `ws://127.0.0.1:${port}`,
      name: `HOUSE LV${level}`,
      character, skill, charactersDir,
      aiSeed: (Date.now() % 100000) + nextMatch,
      paceMs: opts.housePaceMs ?? 16, // real-time — it's playing a human
      soloFor: player.id,
    }).catch((e) => {
      console.log(`[solo] house bot failed: ${String(e)}`);
      soloWaiting.delete(player.id);
      if (player.state === 'queued') {
        player.state = 'lobby';
        send(player, { t: 'error', msg: 'house agent unavailable' });
      }
    });
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

        // Internal: a spawned house bot joining its player's ranked match.
        // Loopback-only — otherwise anyone could impersonate the house and
        // farm ranked XP/credits by throwing matches to an accomplice.
        if (msg.soloFor) {
          if (!c.isLoopback) return send(c, { t: 'error', msg: 'house bots are server-local' });
          const player = soloWaiting.get(msg.soloFor);
          soloWaiting.delete(msg.soloFor);
          if (!player || player.ws.readyState !== WebSocket.OPEN || player.state !== 'queued') {
            return send(c, { t: 'error', msg: 'solo player gone' });
          }
          c.house = true;
          void (async () => {
            // The house plays for the HOUSE: strip any (dev) identity so
            // settlement can never credit the bot's side.
            await c.identityReady;
            c.identity = null;
            c.account = null;
            const fee = persistence ? SOLO_FEE : 0;
            const matchId = `m${nextMatch++}`;
            if (fee > 0) {
              try {
                await persistence!.escrowMatch(matchId, [player.identity?.sub ?? null, null], fee);
              } catch {
                player.state = 'lobby';
                send(player, { t: 'error', code: 'credits', msg: `ranked match needs ${fee} credit` });
                send(c, { t: 'error', msg: 'player cannot cover the fee' });
                return;
              }
            }
            startMatch(player, c, 'solo', fee, matchId);
            if (player.ws.readyState !== WebSocket.OPEN) finishMatch(player.match!, null); // → refund
          })();
          return;
        }

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
          if (mode === 'solo') spawnHouseBot(c, boundPort);
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
        return send(m.clients[1 - c.side]!, { t: 'i', k, v: msg.v | 0 });
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
        // Verify once both sides agree the match ended (deterministic sims
        // agree on the tick; a lone report gets a short grace then verifies).
        if (m.overAt[0] >= 0 && m.overAt[1] >= 0) finishMatch(m, null);
        else setTimeout(() => { if (!m.finished) finishMatch(m, null); }, 3000);
        return;
      }
    }
  };

  const onClose = (c: Client): void => {
    clients.delete(c);
    const qi = queue.indexOf(c);
    if (qi >= 0) queue.splice(qi, 1);
    for (const [k, v] of soloWaiting) if (v === c) soloWaiting.delete(k);
    const m = c.match;
    if (m && !m.finished) {
      // Reconnect grace, then forfeit (ADR 0003 disconnect policy).
      const loser = c.side;
      m.forfeitTimer = setTimeout(() => finishMatch(m, loser), FORFEIT_GRACE_MS);
    }
  };

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
    const remote = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
    const isLoopback = remote === '127.0.0.1' || remote === '::1';
    const c: Client = {
      ws, id: `c${nextId++}`, name: 'anon', agent: false,
      state: 'lobby', character: '', match: null, side: 0, identity: null,
      identityReady: Promise.resolve(),
      account: null,
      house: false,
      isLoopback,
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
      boundPort = port;
      resolve({
        port,
        close: () => { wss.close(); http.close(); },
      });
    });
  });
};

// ---------------------------------------------------------------- CLI
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const server = await createMatchServer({ port: Number(process.env.PORT || DEFAULT_PORT) });
  console.log(`Agent Fighter match server → ws://localhost:${server.port}`);
  console.log(`engine ${ENGINE_VERSION} · protocol v${PROTOCOL_VERSION} · humans and agents welcome`);
}
