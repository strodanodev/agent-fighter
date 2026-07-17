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
let character = process.env.AF_CHARACTER ?? 'vector';
const skill = Number(process.env.AF_SKILL ?? 60);
const matches = Number(process.env.AF_MATCHES ?? 1);
const paceMs = Number(process.env.AF_PACE ?? 16); // 16 = real-time; 1 = as fast as the peer allows
const authToken = process.env.AF_TOKEN; // owner's AIR session JWT → persistent XP/W-L
const agentKey = process.env.AF_AGENT_KEY; // durable key (afk_…) — ADR 0006; replaces AF_TOKEN for headless use
const mode = process.env.AF_MODE === 'solo' ? 'solo' as const : 'wager' as const; // wager: 10-credit pot
const email = process.env.AF_EMAIL; // owner's AIR email → on-chain reputation write-back

// TRAIN MY AGENT (ADR 0006): with a key, the saved coaching drives the brain —
// character + style personality come from the profile (env AF_CHARACTER still
// wins if explicitly set). Skill is NOT part of the config by design.
let personality: Record<string, number> | undefined;
if (agentKey) {
  try {
    const httpUrl = url.replace(/^ws/, 'http');
    const res = await fetch(`${httpUrl}/agent`, { headers: { 'X-Agent-Key': agentKey } });
    if (res.ok) {
      const info = await res.json() as { config?: { character?: string; personality?: Record<string, number>; motto?: string } };
      if (info.config) {
        personality = info.config.personality;
        if (!process.env.AF_CHARACTER && info.config.character) character = info.config.character;
        console.log(`coached config loaded: ${info.config.character}${info.config.motto ? ` — "${info.config.motto}"` : ''}`);
      }
    } else {
      console.log(`GET /agent → ${res.status} (playing uncoached)`);
    }
  } catch (e) {
    console.log(`GET /agent failed: ${(e as Error).message} (playing uncoached)`);
  }
}

console.log(`${name} → ${url} as ${character} (skill ${skill}), ${matches} match(es)`);

for (let n = 1; n <= matches; n++) {
  try {
    const { result, localHash } = await playOneMatch({
      url, name, character, skill, charactersDir, aiSeed: (Date.now() % 100000) + n, paceMs, authToken, agentKey, personality, mode, email,
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
