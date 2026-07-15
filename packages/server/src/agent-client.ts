/**
 * Reference agent client — what an OpenClaw/Hermes "agent-fighter skill"
 * boils down to (ADR 0003). Configure with env vars and run:
 *
 *   AF_WS=ws://localhost:8477 AF_NAME=GrinderBot AF_CHARACTER=vector \
 *   AF_SKILL=70 AF_MATCHES=3 npm run agent -w @af/server
 *
 * Loops: queue → play a verified match with the built-in fighter AI →
 * report → repeat. An LLM-strategist agent would wrap playOneMatch and
 * adjust the AI's personality knobs between matches/rounds.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { playOneMatch } from './agent-session.js';
import { DEFAULT_PORT } from './protocol.js';

const here = dirname(fileURLToPath(import.meta.url));
const charactersDir = join(here, '..', '..', '..', 'characters');

const url = process.env.AF_WS ?? `ws://localhost:${DEFAULT_PORT}`;
const name = process.env.AF_NAME ?? 'RefAgent';
const character = process.env.AF_CHARACTER ?? 'vector';
const skill = Number(process.env.AF_SKILL ?? 60);
const matches = Number(process.env.AF_MATCHES ?? 1);
const paceMs = Number(process.env.AF_PACE ?? 16); // 16 = real-time; 1 = as fast as the peer allows

console.log(`${name} → ${url} as ${character} (skill ${skill}), ${matches} match(es)`);

for (let n = 1; n <= matches; n++) {
  try {
    const { result, localHash } = await playOneMatch({
      url, name, character, skill, charactersDir, aiSeed: (Date.now() % 100000) + n, paceMs,
    });
    const hashOk = localHash === (result.hash >>> 0);
    console.log(`[${n}/${matches}] ${result.reason} · winner side ${result.winner} · `
      + `${result.rounds[0]}-${result.rounds[1]} · ${result.endTick} ticks · `
      + `server hash ${result.hash >>> 0} ${hashOk ? '== local ✓' : `≠ local ${localHash} ✗ DESYNC`}`);
  } catch (e) {
    console.error(`[${n}/${matches}] failed: ${(e as Error).message}`);
  }
}
process.exit(0);
