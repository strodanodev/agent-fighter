# Agent Fighter — TRAIN MY AGENT API (ADR 0006)

The coach-facing REST surface of the match server. This document is the
source for the Minds Bazaar skill manifest ("Agent Fighter Coach") and for
anyone wiring an external agent or coaching tool.

Base URL: the match server — production `https://match-server-production.up.railway.app`.

## The model

Your **agent** is a saved strategy profile on your player account:

```json
{
  "character": "vector",
  "personality": { "aggression": 180, "jumpiness": 60, "zoner": 120,
                   "throwHappy": 45, "pushblocker": 140, "patience": 190 },
  "motto": "fear the grid"
}
```

- `personality` — six style knobs. The server **clamps every knob to the
  same ranges the game's random opponents are sampled from** (returned as
  `ranges` by the API). Style, never power.
- **Stats are hardcoded.** Skill is derived from the account's level at
  match time; character frame data is hash-pinned. No API writes stats.
- Matches played by the agent settle on the **owner's** account (credits,
  XP, W-L, leaderboard — flagged `is_agent`).

## Auth

| Header | Who | Can |
|---|---|---|
| `Authorization: Bearer <AIR session JWT>` | the signed-in owner (game UI) | everything incl. key mint |
| `X-Agent-Key: afk_…` | a coach/agent holding the durable key | read/write config, play |

The durable key is minted once by the owner and shown once. Re-minting
rotates it (the old key dies). A key can never mint keys.

## Endpoints

### `POST /agent/key` — mint/rotate the durable key
Owner auth only. → `{ "key": "afk_…" }` (store it now — never shown again).

### `GET /agent` — the agent + its owner's read-only record
→ `{ name, level, xp, wins, losses, config, keyCreatedAt, ranges, characters }`
`config` is null until first coached. `characters` lists valid ids.

### `PUT /agent` — coach it
Body: any subset of `{ character, personality, motto }`. Partial writes
merge: sending `{ "personality": { "patience": 200 } }` nudges one knob and
keeps the rest. Out-of-range knobs clamp; unknown knobs drop; unknown
characters 400. → `{ config, ranges }` (the effective, clamped result).

### Playing
Headless queue play uses the ws protocol with `hello.agentKey` — the
reference client is `npm run agent -w @af/server`:

```
AF_WS=wss://match-server-production.up.railway.app \
AF_AGENT_KEY=afk_…  AF_MODE=solo  AF_MATCHES=3  npm run agent -w @af/server
```

With `AF_AGENT_KEY` set the client pulls the saved config first: coached
character + personality drive the built-in brain. `AF_MODE=wager` enters the
open PvP queue (10-credit pot); `solo` is a ranked match vs the house
(1 credit). Fees come from the owner's balance — the daily +10 login grant
covers casual play.

## Coaching semantics (for the skill playbook)

The six knobs, in plain words:

| Knob | High means |
|---|---|
| `aggression` | hunts knockdowns, presses advantage, okizeme |
| `jumpiness` | jumps in more, takes to the air under pressure |
| `zoner` | prefers fireball range, plays keep-away |
| `throwHappy` | reaches for throws in close |
| `pushblocker` | pushblocks pressure to reset to neutral |
| `patience` | waits for whiffs; low = forces the issue |

Read `GET /agent` (record + current config) → discuss results → nudge knobs
with a partial `PUT`. Typical translations:
- "stop eating jump-ins → be more patient, jump less": `{ patience: +40, jumpiness: −60 }`
- "rushdown style": high aggression + throwHappy, low zoner/patience.
- "lame them out": high zoner + patience + pushblocker.

There is no "make it stronger" knob — that's level, earned by playing.
