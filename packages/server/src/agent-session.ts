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
  setCharacters, setMatchItems, stateHash, step,
} from '@af/core';
import type { AiState, CharacterBundle, GameState, InputFrame, ItemEffect } from '@af/core';
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
  /**
   * AIR session token of the agent's OWNING account (optional). Gives the
   * agent persistent XP/W-L under that identity — a declared agent playing
   * for its owner, per ADR 0003.
   */
  authToken?: string;
  /**
   * Durable agent key (`afk_…`, ADR 0006) — the headless alternative to a
   * short-lived AIR JWT. Resolves server-side to the owner's profile.
   */
  agentKey?: string;
  /**
   * Coached personality (ADR 0006) — style knobs for the default aiPoll
   * brain, clamped in core to AI_PERSONALITY_RANGES. Fetched from
   * GET /agent by the reference client; ignored when `policy` is set.
   */
  personality?: Record<string, number>;
  /**
   * Queue mode — 'wager' (default, PvP pot), 'solo' (one match vs the house
   * AI), or 'arcade' (one BATTLE of the ranked gauntlet — chain battles by
   * passing the returned run token back via `runToken`). Solo and arcade
   * battles are LOCAL-SIM (protocol v3/v4): the server pins a deterministic
   * house AI in the setup; this session simulates it locally and streams
   * only its own inputs. No opponent packets exist at all.
   */
  mode?: 'wager' | 'solo' | 'arcade';
  /** Arcade continuation: the run token from the previous battle's result. */
  runToken?: string;
  /**
   * Solo only (ADR 0006): fight the TRAINED agent behind this dare/ref code
   * instead of the house AI (your own code = sparring vs your own agent).
   */
  agentOf?: string;
  /**
   * CONSUMABLES (ADR 0007 Phase 2, solo/arcade): inventory rowId of one
   * drink to carry. Applied only if the server echoes it in setup.items.
   */
  item?: number;
  /** Owner's AIR email — target for the reputation write-back (ADR 0004). */
  email?: string;
}

export interface AgentResult {
  result: SResult;
  localHash: number; // my sim's final hash — must equal result.hash
  localTicks: number;
  /** Arcade battles: run position + the token that queues the NEXT battle. */
  arcade?: { battle: number; total: number; token: string };
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
    // This match's loaded characters, re-pinned into the ENGINE-GLOBAL slots
    // before every sim burst: concurrent in-process sessions (house bots,
    // tests, the server's own verifier) share those globals, and two matches
    // with different character pairs would silently corrupt each other's
    // lockstep sims without this.
    let myChars: [ReturnType<typeof loadCharacter>, ReturnType<typeof loadCharacter>] | null = null;
    // Pinned drink loadouts (ADR 0007) are engine-global exactly like
    // characters — re-pin both before every burst or concurrent sessions
    // corrupt each other. undefined when the setup carried no items.
    let myItems: SMatch['items'] = undefined;
    const pinChars = (): void => {
      if (!myChars) return;
      setCharacters(myChars[0], myChars[1]);
      setMatchItems(
        myItems?.[0]?.map((p) => p.effect as ItemEffect) ?? null,
        myItems?.[1]?.map((p) => p.effect as ItemEffect) ?? null,
      );
    };

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
      sendMsg({ t: 'hello', v: PROTOCOL_VERSION, name: opts.name, agent: true, engine: ENGINE_VERSION, auth: opts.authToken, agentKey: opts.agentKey, email: opts.email });
      sendMsg({
        t: 'queue',
        character: opts.character,
        bundleHash: bundleOf(opts.character).versionHash,
        mode: opts.mode ?? 'wager',
        runToken: opts.runToken,
        agentOf: opts.agentOf,
        item: opts.item,
      });
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
          myChars = [
            loadCharacter(bundleOf(msg.chars[0].id)),
            loadCharacter(bundleOf(msg.chars[1].id)),
          ];
          myItems = msg.items;
          pinChars();
          game = createGameState(msg.seed);
          ai = createAi(side, opts.skill, opts.aiSeed ?? msg.seed ^ (side + 1) * 0x9e37, opts.personality);
          const paceMs = opts.paceMs ?? 16;
          const burst = paceMs <= 2 ? 64 : 1;

          if (msg.solo) {
            // LOCAL-SIM SOLO (protocol v3): no opponent packets — simulate
            // the pinned deterministic house AI locally (aiPoll BEFORE step,
            // the exact ordering the server's verifier re-derives) and
            // stream only OUR inputs.
            // A pinned personality = the opponent is a TRAINED agent
            // (dare-vs-agent, ADR 0006) — same re-derivation either way.
            const houseAi = createAi(1, msg.solo.skill, msg.solo.aiSeed, msg.solo.personality);
            pacer = setInterval(() => {
              if (!game || !ai) return;
              pinChars();
              for (let b = 0; b < burst && game.phase !== Phase.MatchOver; b++) {
                const mine = opts.policy ? opts.policy(game, ai) : aiPoll(ai, game);
                myInputs[simTick] = mine;
                sendMsg({ t: 'i', k: simTick, v: mine });
                const opp = aiPoll(houseAi, game);
                step(game, [mine, opp]);
                simTick++;
                if (simTick % HASH_EVERY === 0) sendMsg({ t: 'h', k: simTick, x: stateHash(game) });
              }
              if (game.phase === Phase.MatchOver && !overSent) {
                overSent = true;
                sendMsg({ t: 'over', k: simTick });
              }
            }, paceMs);
            return;
          }

          // WAGER (PvP lockstep): first `delay` ticks are neutral by
          // convention (symmetric).
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
          pacer = setInterval(() => {
            pinChars();
            for (let b = 0; b < burst && sendTick - simTick < delay + 8; b++) emitOne();
            advance();
          }, paceMs);
          return;
        }
        case 'i': {
          oppInputs[msg.k] = msg.v;
          pinChars();
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
          return resolve({ result: msg, localHash, localTicks: simTick, arcade: setup?.arcade });
        }
        default:
          return;
      }
    });

    ws.on('error', (e) => fail(`ws error: ${String(e)}`));
    ws.on('close', () => { if (pacer) clearInterval(pacer); });

    setTimeout(() => { if (!setup) fail('no match within 60s'); }, 60_000);
  });
