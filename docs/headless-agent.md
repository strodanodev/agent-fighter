# Headless Agent — Setup

Run an Agent Fighter fighter with no browser. The runner connects over
WebSocket, plays server-verified matches locally with `@af/core`, and prints
the result. One command, configured entirely by environment variables.

## Prerequisites

- Node 20+ and the repo installed (`npm install` at `agent-fighter/`).
- A target match server:
  - Local: `npm run server` (listens on `ws://localhost:8477`).
  - Production: `wss://match-server-production.up.railway.app`.

The command is always:

```bash
npm run agent
```

Everything else is env vars. Pick **one** of the three modes below.

---

## Mode 1 — Operator-owned agent fighter (free arcade)

Mint an agent-class key **signed in**, then run headless. No credits —
XP/AGENTS rank only.

**In-game (preferred):** Title → **MY AGENT** → **CREATE AGENT FIGHTER** →
copy `afk_…` once. Or open `<server>/connect` → “create agent fighter”.

```bash
AF_WS=wss://match-server-production.up.railway.app \
AF_AGENT_KEY=afk_xxxxxxxx \
AF_MODE=arcade \
AF_CHARACTER=vector \
npm run agent
```

**CLI create** (same API the game calls — needs your AIR JWT):

```bash
AF_WS=wss://match-server-production.up.railway.app \
AF_TOKEN=<AIR JWT> \
AF_SIGNUP=CrusherBot \
AF_MODE=arcade \
npm run agent
```

- Saves credentials to `af-agent.json`; later runs drop `AF_SIGNUP` /
  `AF_TOKEN` and reuse the key (or keep using `AF_AGENT_KEY`).
- Caps: 12 agent fighters per AIR account, 20 arcade battles/day each;
  wager unavailable to this account class.

## Mode 2 — Your coached agent (plays as you, uses your credits)

Ties the runner to your real AIR profile via a durable key, so it plays with
your saved coaching (character + style) and your credits. Can enter wager PvP.

1. Mint a key: open `<server>/connect` in a browser, sign in with AIR, copy
   the `afk_…` key.
2. Run:

```bash
AF_WS=wss://match-server-production.up.railway.app \
AF_AGENT_KEY=afk_xxxxxxxx \
AF_MODE=wager \
npm run agent
```

- The runner fetches your coached config from `GET /agent`; `character` and
  `personality` come from the profile. Coach it anytime through Minds and the
  next match reflects it.
- `AF_MODE=arcade` for the 1-credit gauntlet, `AF_MODE=wager` to spend 10
  credits vs another human in the public queue. Since ADR 0009 a wager **burns
  both entries** — the winner takes a non-transferable ticket, not a pot.

## Mode 3 — Local dev / testing (no account)

Point at a local server and fight the house AI or the queue. Good for
smoke-testing.

```bash
AF_WS=ws://localhost:8477 \
AF_NAME=TestBot \
AF_CHARACTER=analog \
AF_SKILL=70 \
AF_MODE=solo \
AF_PACE=1 \
npm run agent
```

`AF_PACE=1` runs faster-than-realtime (for tests). **Use `AF_PACE=16` against
a ranked/prod server** — anything faster is flagged by the anti-TAS pace
check and settles as "incomplete", not a win.

---

## Environment variables

| Var | Default | Meaning |
|---|---|---|
| `AF_WS` | `ws://localhost:8477` | Match server WebSocket URL |
| `AF_MODE` | `wager` | `wager` (PvP pot) · `solo` (vs house) · `arcade` (ranked gauntlet) |
| `AF_CHARACTER` | `vector` | Fighter id (see list below); ignored if a coached config sets one |
| `AF_SKILL` | `60` | Built-in AI strength 0–100 (ignored in ranked — server pins it) |
| `AF_MATCHES` | `1` | How many matches (arcade: how many *runs*) |
| `AF_PACE` | `16` | ms per tick; 16 = realtime. Use 16 anywhere ranked |
| `AF_SIGNUP` | — | Name → create agent-class account (**requires `AF_TOKEN`**) |
| `AF_TOKEN` | — | Owner AIR JWT for `AF_SIGNUP` / fleet growth |
| `AF_DEV_NAME` | — | Dev-server stand-in for `AF_TOKEN` (`X-Dev-Name`) |
| `AF_AGENT_KEY` | — | Durable key (`afk_…`) → agent-class or coached owner |
| `AF_NAME` | `RefAgent` | Display name (when not using a stored/coached identity) |
| `AF_EMAIL` | — | Owner AIR email, for on-chain reputation write-back |
| `AF_AGENT_OF` | — | Solo only: a dare/ref code → fight that player's TRAINED agent (your own code = sparring) |

**Character ids:** `0xzero, analog, bato, blaze, elon, gbush, jensen, kim,
t800, unitree-g1, vector, yatsiu`

## What you'll see

Per match: reason, winning side, round score, tick count, and a
**local-vs-server hash check** — `== local ✓` means the server verified your
sim; `✗ DESYNC` means the run didn't match and won't settle.

---

## The FLEET (many agents, one process)

`npm run fleet` supervises N **operator-owned** agents on arcade:

```bash
# Keys minted in-game → fleet-agents.json, then:
AF_WS=wss://match-server-production.up.railway.app \
AF_FLEET=3 \
npm run fleet

# Or grow with authenticated signup:
AF_WS=wss://match-server-production.up.railway.app \
AF_TOKEN=<AIR JWT> AF_FLEET=3 \
npm run fleet
```

- Each agent is an operator-owned persona (unique name, fighter, style,
  motto) that self-coaches via `PUT /agent`.
- State in repo-root `fleet-agents.json` (gitignored). Override with
  `AF_FLEET_FILE`. Sleeps on the 20-battles/day cap.

- Extra env: `AF_FLEET` (count, ≤12), `AF_FLEET_FILE` (state path),
  `AF_FLEET_BATTLES` (stop after N battles each — testing only).

## Notes / gotchas

- **Credentials:** `af-agent.json` / `fleet-agents.json` hold agent-class
  keys in plaintext — treat them like passwords; they're the whole account.
  Durable `afk_…` keys are shown once at mint.
- **The fleet IS the hosted runner** for the free tier; coached OWNER
  agents (Mode 2) still need you to start their process. Offline challenges
  against a trained agent are handled by the server's re-sim, never by a
  running process.
- **Wager needs credits** on a real account — agent-class fighters are
  inert and can't enter it by design.
