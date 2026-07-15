/**
 * Headless netplay session — the reference "agent skill" core (ADR 0003).
 * This is everything an agent framework needs: connect, queue, and play a
 * verified online match using @af/core locally. ~150 lines, no rendering,
 * no rollback (an agent doesn't render, so it plays honest LOCKSTEP: it
 * only simulates a tick once both inputs are known, while emitting its own
 * inputs ahead on a steady 60 Hz cadence so the human opponent never stalls).
 *
 * The brain is pluggable: default is the built-in fighter AI (`aiPoll`) at a
 * chosen skill. An LLM layer belongs ABOVE this loop — turning personality/
 * intent knobs between rounds — never inside the 60 Hz path.
 */
import { WebSocket } from 'ws';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ENGINE_VERSION, Phase, aiPoll, createAi, createGameState, loadCharacter,
  setCharacters, stateHash, step,
} from '@af/core';
import type { AiState, CharacterBundle, GameState, InputFrame } from '@af/core';
import { HASH_EVERY, PROTOCOL_VERSION } from './protocol.js';
import type { ClientMsg, SMatch, SResult, ServerMsg } from './protocol.js';

export interface AgentOptions {
  url: string; // ws://host:port
  name: string;
  character: string;
  skill: number; // 0-100 → the built-in AI's lever
  charactersDir: string; // where character.json bundles live
  aiSeed?: number;
  /** Override the brain: given (game, myAiState) return my InputFrame. */
  policy?: (game: GameState, ai: AiState) => InputFrame;
  /**
   * Emission cadence in ms. 16 ≈ real-time 60 Hz (default — live matches
   * against humans). Tests and agent-vs-agent farms can run 1 for ~16×
   * faster-than-realtime matches; the protocol doesn't care about wall time.
   */
  paceMs?: number;
}

export interface AgentResult {
  result: SResult;
  localHash: number; // my sim's final hash — must equal result.hash
  localTicks: number;
}

/** Play exactly one online match. Resolves with the server-verified result. */
export const playOneMatch = (opts: AgentOptions): Promise<AgentResult> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(opts.url);
    const sendMsg = (m: ClientMsg): void => { ws.send(JSON.stringify(m)); };

    const bundleOf = (id: string): CharacterBundle =>
      JSON.parse(readFileSync(join(opts.charactersDir, id, 'character.json'), 'utf8')) as CharacterBundle;

    let setup: SMatch | null = null;
    let game: GameState | null = null;
    let ai: AiState | null = null;
    let side: 0 | 1 = 0;
    let delay = 3;

    const myInputs: number[] = [];
    const oppInputs: (number | undefined)[] = [];
    let simTick = 0; // next tick to simulate (lockstep: needs both inputs)
    let sendTick = 0; // next tick to emit my input for
    let overSent = false;
    let pacer: NodeJS.Timeout | null = null;

    const fail = (why: string): void => {
      if (pacer) clearInterval(pacer);
      ws.close();
      reject(new Error(why));
    };

    /** Emit my input for `sendTick` from the CURRENT simulated state. */
    const emitOne = (): void => {
      if (!game || !ai) return;
      const v = opts.policy ? opts.policy(game, ai) : aiPoll(ai, game);
      myInputs[sendTick] = v;
      sendMsg({ t: 'i', k: sendTick, v });
      sendTick++;
    };

    /** Lockstep: advance while both inputs for simTick are known. */
    const advance = (): void => {
      if (!game) return;
      while (game.phase !== Phase.MatchOver
        && myInputs[simTick] !== undefined && oppInputs[simTick] !== undefined) {
        const mine = myInputs[simTick]!;
        const theirs = oppInputs[simTick]!;
        step(game, side === 0 ? [mine, theirs] : [theirs, mine]);
        simTick++;
        if (simTick % HASH_EVERY === 0) sendMsg({ t: 'h', k: simTick, x: stateHash(game) });
      }
      if (game.phase === Phase.MatchOver && !overSent) {
        overSent = true;
        sendMsg({ t: 'over', k: simTick });
      }
    };

    ws.on('open', () => {
      sendMsg({ t: 'hello', v: PROTOCOL_VERSION, name: opts.name, agent: true, engine: ENGINE_VERSION });
      sendMsg({ t: 'queue', character: opts.character, bundleHash: bundleOf(opts.character).versionHash });
    });

    ws.on('message', (data) => {
      const msg = JSON.parse(String(data)) as ServerMsg;
      switch (msg.t) {
        case 'error':
          return fail(`server error: ${msg.msg}`);
        case 'match': {
          setup = msg;
          side = msg.side;
          delay = msg.delay;
          setCharacters(
            loadCharacter(bundleOf(msg.chars[0].id)),
            loadCharacter(bundleOf(msg.chars[1].id)),
          );
          game = createGameState(msg.seed);
          ai = createAi(side, opts.skill, opts.aiSeed ?? msg.seed ^ (side + 1) * 0x9e37);
          // First `delay` ticks are neutral by convention (symmetric).
          for (let k = 0; k < delay; k++) {
            myInputs[k] = 0;
            sendMsg({ t: 'i', k, v: 0 });
          }
          sendTick = delay;
          // Steady emission — the opponent's client never waits on us.
          // Real-time mode emits one input per 16ms tick (fresh decisions vs
          // humans). Fast mode (paceMs ≤ 2) bursts to the ahead-cap so
          // agent-vs-agent matches run as fast as round-trips allow — OS
          // timers are too coarse (Windows ~15ms) for a 1ms interval to help.
          const paceMs = opts.paceMs ?? 16;
          const burst = paceMs <= 2 ? 64 : 1;
          pacer = setInterval(() => {
            for (let b = 0; b < burst && sendTick - simTick < delay + 8; b++) emitOne();
            advance();
          }, paceMs);
          return;
        }
        case 'i': {
          oppInputs[msg.k] = msg.v;
          return advance();
        }
        case 'result': {
          if (pacer) clearInterval(pacer);
          const localHash = game ? stateHash(game) : 0;
          if (process.env.AF_DEBUG_LEDGER) {
            try {
              writeFileSync(
                join(process.env.AF_DEBUG_LEDGER, `agent-${opts.name}.json`),
                JSON.stringify({ side, myInputs, oppInputs: [...oppInputs].map((v) => v ?? null) }),
              );
            } catch { /* debug only */ }
          }
          ws.close();
          return resolve({ result: msg, localHash, localTicks: simTick });
        }
        default:
          return;
      }
    });

    ws.on('error', (e) => fail(`ws error: ${String(e)}`));
    ws.on('close', () => { if (pacer) clearInterval(pacer); });

    setTimeout(() => { if (!setup) fail('no match within 60s'); }, 60_000);
  });
