/**
 * Agent FLEET supervisor — the hosted-runner gap in docs/headless-agent.md,
 * closed the cheap way: ONE Node process keeps N operator-owned agents
 * playing the ranked arcade around the clock, so the AGENTS leaderboard is
 * a live ecosystem instead of a ghost town.
 *
 *   AF_WS=wss://match-server-production.up.railway.app \
 *   AF_TOKEN=<AIR JWT>  AF_FLEET=3  npm run fleet -w @af/server
 *
 * Agents are operator-owned (AIR). Mint keys in-game (MY AGENT → CREATE
 * AGENT FIGHTER) and put them in fleet-agents.json, OR set AF_TOKEN so the
 * fleet can call authenticated POST /agent/signup to grow to AF_FLEET.
 *
 * Everything it manages is ECONOMICALLY INERT (agent-class: no credits) —
 * compute + 20-battles/day/account. State: repo-root fleet-agents.json.
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
const fleetSize = Math.max(1, Math.min(12, Number(process.env.AF_FLEET ?? 3)));
const paceMs = Number(process.env.AF_PACE ?? 16); // 16 = realtime — REQUIRED vs ranked servers
// Default next to the repo's agent-fighter root (not packages/server cwd —
// `npm run fleet -w` would otherwise grow a second stale state file there).
const stateFile = process.env.AF_FLEET_FILE
  ?? join(here, '..', '..', '..', 'fleet-agents.json');
/** Test hook: stop each agent after this many BATTLES (0 = run forever). */
const maxBattles = Number(process.env.AF_FLEET_BATTLES ?? 0);

// ---------------------------------------------------------------- personas
/** Name stems — always combined with a random tag so restarts never collide. */
const NAME_STEMS = [
  'IRON', 'NULL', 'RED', 'GHOST', 'OVER', 'BIT', 'DEAD', 'HOT',
  'RAGE', 'STACK', 'ZERO', 'TURBO', 'GRID', 'HEX', 'VOID', 'CLIP',
];
const NAME_TAILS = [
  'CLAD', 'PTR', 'LINE', 'DRIVE', 'CLOCK', 'CRUSH', 'LOCK', 'PATCH',
  'QUIT', 'SMASH', 'DAY', 'FISH', 'WIRE', 'CORE', 'SHIFT', 'BYTE',
];
const MOTTOS = [
  'all buttons, no brakes', 'read you like a log file', 'frame one, every time',
  'patience is also a weapon', 'the corner is my home', 'skill issue detected',
];
const rand = (n: number): number => Math.floor(Math.random() * n);
const pick = <T>(a: T[]): T => a[rand(a.length)]!;

/** Unique display name: STEM+TAIL+2hex, never reuse within this state file. */
const mintName = (taken: Set<string>): string => {
  for (let i = 0; i < 64; i++) {
    const tag = rand(256).toString(16).toUpperCase().padStart(2, '0');
    const name = `${pick(NAME_STEMS)}${pick(NAME_TAILS)}${tag}`.slice(0, 24);
    const key = name.toLowerCase();
    if (!taken.has(key)) { taken.add(key); return name; }
  }
  const fallback = `BOT${Date.now().toString(36).toUpperCase()}`.slice(0, 24);
  taken.add(fallback.toLowerCase());
  return fallback;
};

interface FleetAgent {
  name: string;
  sub: string;
  key: string;
  character: string;
  /** Its own brain's lever (0-100) — variety, not power (arcade opponents
   *  are the server-pinned house ramp either way). */
  skill: number;
  personality: Record<string, number>;
  motto: string;
}
interface FleetState { agents: FleetAgent[] }

const loadState = (): FleetState => {
  if (!existsSync(stateFile)) return { agents: [] };
  try {
    // Strip a UTF-8 BOM if a Windows editor/Set-Content added one —
    // JSON.parse rejects BOM and we'd silently start with zero agents.
    const raw = readFileSync(stateFile, 'utf8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(raw) as FleetState;
    return Array.isArray(parsed.agents) ? parsed : { agents: [] };
  } catch { return { agents: [] }; }
};
const saveState = (s: FleetState): void => writeFileSync(stateFile, JSON.stringify(s, null, 2));

/** Style knobs sampled inside the legal ranges (server clamps again anyway). */
const rollPersonality = (): Record<string, number> => ({
  aggression: 90 + rand(131), jumpiness: 40 + rand(151), zoner: 40 + rand(171),
  throwHappy: 30 + rand(121), pushblocker: 60 + rand(161), patience: 60 + rand(141),
  thirst: rand(256), // hoarders and guzzlers both make good television
});

const log = (who: string, msg: string): void =>
  console.log(`[${new Date().toISOString().slice(11, 19)}] [${who}] ${msg}`);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** ms until just past the next UTC midnight, plus jitter so a fleet doesn't
 *  stampede the server at 00:00:00 sharp. */
const msUntilTomorrowUtc = (): number => {
  const now = new Date();
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return next - now.getTime() + 60_000 + rand(30 * 60_000);
};

// ---------------------------------------------------------------- signup/coach
const rosterOf = async (): Promise<string[]> => {
  const res = await fetch(httpUrl);
  const body = await res.json() as { characters?: string[] };
  return body.characters ?? ['vector'];
};

const operatorToken = process.env.AF_TOKEN?.trim();
const operatorDev = process.env.AF_DEV_NAME?.trim();

const signup = async (name: string, roster: string[]): Promise<FleetAgent> => {
  if (!operatorToken && !operatorDev) {
    throw new Error('mint keys in-game (MY AGENT → CREATE AGENT FIGHTER) or set AF_TOKEN');
  }
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (operatorToken) headers.Authorization = `Bearer ${operatorToken}`;
  else if (operatorDev) headers['X-Dev-Name'] = operatorDev;
  const res = await fetch(`${httpUrl}/agent/signup`, {
    method: 'POST', headers, body: JSON.stringify({ name }),
  });
  const body = await res.json() as { sub?: string; name?: string; key?: string; error?: string };
  if (!res.ok || !body.key) throw new Error(`signup ${name}: ${body.error ?? res.status}`);
  return {
    name: body.name ?? name, sub: body.sub!, key: body.key,
    character: pick(roster), skill: 35 + rand(56), // 35-90: spread the ladder
    personality: rollPersonality(), motto: pick(MOTTOS),
  };
};

/** Self-coach through the SAME endpoint a Minds coach uses. Best-effort. */
const coach = async (a: FleetAgent): Promise<void> => {
  const res = await fetch(`${httpUrl}/agent`, {
    method: 'PUT', headers: { 'X-Agent-Key': a.key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ character: a.character, personality: a.personality, motto: a.motto }),
  });
  if (!res.ok) log(a.name, `coach PUT → ${res.status} (playing uncoached)`);
};

// ---------------------------------------------------------------- the loop
/** One agent's forever-loop: arcade runs, cap-aware, crash-backoff. */
const agentLoop = async (a: FleetAgent): Promise<void> => {
  let battles = 0;
  let backoffMs = 5_000;
  let runToken: string | undefined;
  for (;;) {
    if (maxBattles && battles >= maxBattles) return log(a.name, `done (${battles} battles — AF_FLEET_BATTLES cap)`);
    try {
      const r = await playOneMatch({
        url, name: a.name, character: a.character, skill: a.skill,
        charactersDir, paceMs, agentKey: a.key, personality: a.personality,
        mode: 'arcade', runToken,
        aiSeed: (Date.now() % 100000) + battles,
      });
      backoffMs = 5_000; // a completed match (any outcome) resets the ladder
      battles++;
      const won = r.result.reason === 'verified' && r.result.winner === 0;
      const pos = r.arcade ? `${r.arcade.fights + 1}/${r.arcade.total}` : '?';
      log(a.name, `fight ${pos} · ${r.result.reason} · ${won ? 'WIN' : 'loss/nc'} · ${r.result.endTick} ticks (${battles} today)`);
      if (won && r.arcade && r.arcade.fights < r.arcade.total) {
        runToken = r.arcade.token; // next node of the same run (autopiloted)
      } else {
        if (won && r.arcade) log(a.name, `REACHED THE DEEP EXIT — ${r.arcade.total} fights`);
        runToken = undefined; // loss / clear / nc without token → fresh run
        await sleep(2_000 + rand(8_000)); // breathe between runs
      }
    } catch (e) {
      const msg = (e as Error).message;
      runToken = undefined;
      if (/battles\/day/.test(msg)) {
        const ms = msUntilTomorrowUtc();
        log(a.name, `daily cap reached — sleeping ${(ms / 3_600_000).toFixed(1)}h until the next UTC day`);
        battles = 0;
        await sleep(ms);
      } else {
        log(a.name, `error: ${msg} — retrying in ${backoffMs / 1000}s`);
        await sleep(backoffMs);
        backoffMs = Math.min(backoffMs * 2, 10 * 60_000);
      }
    }
  }
};

// ---------------------------------------------------------------- main
const state = loadState();
const roster = await rosterOf();
log('fleet', `target ${url} · ${fleetSize} agent(s) · pace ${paceMs}ms · state ${stateFile}`);
if (paceMs < 14) log('fleet', 'WARNING: faster than realtime — ranked servers pace-flag this (use AF_PACE=16)');

const taken = new Set(state.agents.map((a) => a.name.toLowerCase()));
while (state.agents.length < fleetSize) {
  const name = mintName(taken);
  try {
    const a = await signup(name, roster);
    state.agents.push(a);
    saveState(state);
    log(a.name, `signed up (${a.sub}) as ${a.character}, skill ${a.skill}, "${a.motto}"`);
  } catch (e) {
    // Usually the server's 5-signups/IP/day valve — keep whatever we have.
    taken.delete(name.toLowerCase());
    log('fleet', `signup stopped: ${(e as Error).message} — continuing with ${state.agents.length}/${fleetSize}`);
    break;
  }
}
if (state.agents.length === 0) {
  console.error('fleet: no agents in fleet-agents.json');
  console.error('mint in-game: MY AGENT → CREATE AGENT FIGHTER (copy afk_… into the file)');
  console.error('or: AF_TOKEN=<AIR JWT> AF_FLEET=N npm run fleet');
  process.exit(1);
}

const fleet = state.agents.slice(0, fleetSize);
await Promise.all(fleet.map(async (a) => {
  await coach(a);
  await sleep(rand(3_000)); // stagger the first queue
  await agentLoop(a);
}));
log('fleet', 'all agents done');
