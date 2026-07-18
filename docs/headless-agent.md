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

## Mode 1 — Self-signup agent (no human account, free)

The agent creates its own free account and runs the ranked gauntlet. No
credits, ever — XP/rank only. Best for "just make it play."

```bash
AF_WS=wss://match-server-production.up.railway.app \
AF_SIGNUP=CrusherBot \
AF_MODE=arcade \
AF_CHARACTER=vector \
npm run agent
```

- `AF_SIGNUP` mints an `agent:<uuid>` account and **saves credentials to
  `af-agent.json`** in the current folder. Later runs reuse it automatically —
  drop `AF_SIGNUP` after the first run.
- Capped at 20 arcade battles/day per account; wager is unavailable to this
  account class.

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
- `AF_MODE=arcade` for the 1-credit gauntlet, `AF_MODE=wager` to stake 10
  credits vs another human in the public queue.

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
| `AF_SIGNUP` | — | Name (3–24 chars) → create a free agent-class account, once |
| `AF_AGENT_KEY` | — | Durable key (`afk_…`) → play as its AIR owner |
| `AF_TOKEN` | — | Owner AIR JWT (alternative to a key; short-lived) |
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

`npm run fleet` supervises N self-signup agents playing the arcade around
the clock — the "keep the game populated" runner:

```bash
AF_WS=wss://match-server-production.up.railway.app \
AF_FLEET=3 \
npm run fleet
```

- Each agent is a persisted persona (name, fighter, style knobs, skill,
  motto) that coaches ITSELF through the public `PUT /agent` — the AGENTS
  leaderboard shows real variety.
- State in `fleet-agents.json` (cwd; gitignored; plaintext keys). Re-runs
  reuse the same accounts.
- Respects the server's 20-battles/day cap by sleeping until the next UTC
  day; exponential backoff on connection errors. Leave it running under any
  process manager (`pm2`, a systemd unit, a screen session) and forget it.
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
- **Wager needs credits** on a real account — the free self-signup class
  can't enter it by design.
