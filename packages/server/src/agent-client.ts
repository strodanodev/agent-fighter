/**
 * Reference agent client — what an OpenClaw/Hermes/Minds "agent-fighter
 * skill" boils down to (ADR 0003/0006). Configure with env vars and run:
 *
 *   AF_WS=ws://localhost:8477 AF_NAME=GrinderBot AF_CHARACTER=vector \
 *   AF_SKILL=70 AF_MATCHES=3 npm run agent -w @af/server
 *
 * AGENT-CLASS CREATE (operator-owned): mint in-game (MY AGENT → CREATE
 * AGENT FIGHTER) or with an AIR token:
 *
 *   AF_WS=wss://… AF_TOKEN=<AIR JWT> AF_SIGNUP=CrusherBot AF_MODE=arcade \\
 *   npm run agent
 *
 * Saves credentials to af-agent.json; later runs reuse the key (drop
 * AF_SIGNUP / AF_TOKEN). Prefer minting in-game and setting AF_AGENT_KEY.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { playOneMatch } from './agent-session.js';
import { DEFAULT_PORT } from './protocol.js';

const here = dirname(fileURLToPath(import.meta.url));
const charactersDir = join(here, '..', '..', '..', 'characters');

const url = process.env.AF_WS ?? `ws://localhost:${DEFAULT_PORT}`;
const httpUrl = url.replace(/^ws/, 'http');
let name = process.env.AF_NAME ?? 'RefAgent';
let character = process.env.AF_CHARACTER ?? 'vector';
const skill = Number(process.env.AF_SKILL ?? 60);
const matches = Number(process.env.AF_MATCHES ?? 1); // arcade: number of RUNS
const paceMs = Number(process.env.AF_PACE ?? 16); // 16 = real-time; 1 = as fast as the peer allows
const authToken = process.env.AF_TOKEN; // owner's AIR session JWT → persistent XP/W-L
let agentKey = process.env.AF_AGENT_KEY; // durable key (afk_…) — ADR 0006
const mode = process.env.AF_MODE === 'solo' ? 'solo' as const
  : process.env.AF_MODE === 'arcade' ? 'arcade' as const
  : 'wager' as const;
const email = process.env.AF_EMAIL; // owner's AIR email → on-chain reputation write-back
// Solo only (ADR 0006): fight the TRAINED agent behind this dare/ref code
// instead of the house AI (your own code = sparring vs your own coaching).
const agentOf = process.env.AF_AGENT_OF;

// ---- Self-signup / stored credentials (agent-class account).
const credFile = join(process.cwd(), 'af-agent.json');
if (!agentKey && existsSync(credFile)) {
  try {
    const saved = JSON.parse(readFileSync(credFile, 'utf8')) as { name?: string; key?: string };
    if (saved.key) {
      agentKey = saved.key;
      if (!process.env.AF_NAME && saved.name) name = saved.name;
      console.log(`using stored agent account "${saved.name}" (${credFile})`);
    }
  } catch { /* unreadable — ignore, a signup below can replace it */ }
}
if (!agentKey && process.env.AF_SIGNUP) {
  const wanted = process.env.AF_SIGNUP.trim();
  const token = process.env.AF_TOKEN?.trim();
  const devName = process.env.AF_DEV_NAME?.trim();
  if (!token && !devName) {
    console.error('AF_SIGNUP requires AF_TOKEN (AIR JWT) or AF_DEV_NAME (dev server)');
    console.error('Or mint in-game: MY AGENT → CREATE AGENT FIGHTER, then AF_AGENT_KEY=afk_…');
    process.exit(1);
  }
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  else if (devName) headers['X-Dev-Name'] = devName;
  const res = await fetch(`${httpUrl}/agent/signup`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: wanted }),
  });
  const body = await res.json() as { sub?: string; name?: string; key?: string; error?: string };
  if (!res.ok || !body.key) {
    console.error(`signup failed: ${body.error ?? res.status}`);
    process.exit(1);
  }
  agentKey = body.key;
  name = body.name ?? wanted;
  writeFileSync(credFile, JSON.stringify({ sub: body.sub, name, key: body.key }, null, 2));
  console.log(`agent account created: ${name} (${body.sub})`);
  console.log(`credentials saved to ${credFile} — reused automatically next run`);
}

// TRAIN MY AGENT (ADR 0006): with a key, the saved coaching drives the brain —
// character + style personality come from the profile (env AF_CHARACTER still
// wins if explicitly set). Skill is NOT part of the config by design.
let personality: Record<string, number> | undefined;
if (agentKey) {
  try {
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

console.log(`${name} → ${url} as ${character} (skill ${skill}), mode ${mode}, ${matches} ${mode === 'arcade' ? 'run(s)' : 'match(es)'}`);

const base = { url, name, character, skill, charactersDir, paceMs, authToken, agentKey, personality, email, agentOf };
const report = (tag: string, r: Awaited<ReturnType<typeof playOneMatch>>): void => {
  const hashOk = r.localHash === (r.result.hash >>> 0);
  console.log(`${tag} ${r.result.reason} · winner side ${r.result.winner} · `
    + `${r.result.rounds[0]}-${r.result.rounds[1]} · ${r.result.endTick} ticks · `
    + `server hash ${r.result.hash >>> 0} ${hashOk ? '== local ✓' : `≠ local ${r.localHash} ✗ DESYNC`}`);
};

for (let n = 1; n <= matches; n++) {
  try {
    if (mode === 'arcade') {
      // Ranked play is wall-clock pace-checked server-side (anti-TAS):
      // faster-than-realtime sims settle as incomplete, not wins.
      if (paceMs < 14) console.log(`note: AF_PACE=${paceMs} is faster than realtime — ranked servers will flag it (use 16)`);
      // One RUN = battles until a loss ends it or the deep exit is reached.
      // ARCADE v2 (ADR 0008): this loop never names a board node, so the
      // server autopilots the cheapest line to the deep exit. That is the
      // whole integration — headless agents do not read maps, and being
      // agent-class they bank nothing anyway.
      let runToken: string | undefined;
      let battle = 0;
      let retries = 0;
      for (;;) {
        const r = await playOneMatch({
          ...base, mode, runToken, aiSeed: (Date.now() % 100000) + n * 100 + battle,
        });
        report(`[run ${n} · fight ${(r.arcade?.fights ?? battle) + 1}/${r.arcade?.total ?? '?'}]`, r);
        if (r.result.reason === 'incomplete' && r.arcade?.token && retries < 3) {
          // No-contest (pace/network): the run keeps its position, so retry
          // the SAME node rather than abandoning the run.
          retries++;
          runToken = r.arcade.token;
          console.log(`[run ${n}] no contest — retrying fight ${r.arcade.fights + 1} (${retries}/3)`);
          continue;
        }
        retries = 0;
        const won = r.result.reason === 'verified' && r.result.winner === 0;
        const total = r.arcade?.total ?? 0;
        battle = (r.arcade?.fights ?? battle) + 1;
        if (!won) { console.log(`[run ${n}] GAME OVER at fight ${battle}`); break; }
        if (battle >= total) { console.log(`[run ${n}] REACHED THE DEEP EXIT — ${total} fights`); break; }
        runToken = r.arcade?.token;
        if (!runToken) break; // server ended the run
      }
    } else {
      const r = await playOneMatch({ ...base, mode, aiSeed: (Date.now() % 100000) + n });
      report(`[${n}/${matches}]`, r);
    }
  } catch (e) {
    console.error(`[${n}/${matches}] failed: ${(e as Error).message}`);
  }
}
process.exit(0);
