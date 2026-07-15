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
  DEFAULT_PORT, FORFEIT_GRACE_MS, INPUT_DELAY, PROTOCOL_VERSION,
} from './protocol.js';
import type { ClientMsg, SMatch, SResult, ServerMsg } from './protocol.js';

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
}

interface Match {
  id: string;
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
export const createMatchServer = (opts: { port?: number; root?: string } = {}): Promise<MatchServer> => {
  const root = opts.root ?? REPO_ROOT;
  const charactersDir = join(root, 'characters');
  const stagesDir = join(root, 'stages');

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

  const tryPair = (): void => {
    while (queue.length >= 2) {
      const c0 = queue.shift()!;
      const c1 = queue.shift()!;
      if (c0.ws.readyState !== WebSocket.OPEN) { queue.unshift(c1); continue; }
      if (c1.ws.readyState !== WebSocket.OPEN) { queue.unshift(c0); continue; }

      const m: Match = {
        id: `m${nextMatch++}`,
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
          delay: INPUT_DELAY,
          chars: [
            { id: m.chars[0], hash: bundleOf(m.chars[0]).versionHash },
            { id: m.chars[1], hash: bundleOf(m.chars[1]).versionHash },
          ],
          names: [m.clients[0].name, m.clients[1].name],
          agents: [m.clients[0].agent, m.clients[1].agent],
        };
        send(c, setup);
      }
      console.log(`[match ${m.id}] ${c0.name}${c0.agent ? ' (agent)' : ''} vs ${c1.name}${c1.agent ? ' (agent)' : ''} · seed ${m.seed} · stage ${m.stage}`);
    }
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
        c.state = 'queued';
        queue.push(c);
        send(c, { t: 'queued' });
        return tryPair();
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
    const m = c.match;
    if (m && !m.finished) {
      // Reconnect grace, then forfeit (ADR 0003 disconnect policy).
      const loser = c.side;
      m.forfeitTimer = setTimeout(() => finishMatch(m, loser), FORFEIT_GRACE_MS);
    }
  };

  const http = createHttpServer((_, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      game: 'agent-fighter', engine: ENGINE_VERSION, protocol: PROTOCOL_VERSION,
      characters: characterIds, stages: stageIds,
      online: clients.size, queued: queue.length,
    }));
  });
  const wss = new WebSocketServer({ server: http });

  wss.on('connection', (ws) => {
    const c: Client = {
      ws, id: `c${nextId++}`, name: 'anon', agent: false,
      state: 'lobby', character: '', match: null, side: 0,
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
