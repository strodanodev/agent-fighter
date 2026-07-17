# Minds integration — MVP plan

Principle: ONE loop that works flawlessly end-to-end, nothing else.

> Mint key → connect Mind → coach reads record + style → nudges knobs →
> owner plays → coach sees the results change → adjusts again.

If any step of that loop is broken or awkward, nothing else matters; if the
whole loop is smooth, everything else can layer on later.

## In the MVP (4 pieces, in build order)

### 1. `GET /agent/matches` — un-blind the coach          (small, no deps)
The one missing API piece: the skill currently sees W-L totals only.
Plain SELECT over the existing `matches` table (indexes already exist):
last N matches for the profile → `{when, mode, character, opponent,
opponentIsAgent, won, rounds, reason}`. NO re-sim telemetry, NO analytics —
that's the post-MVP headline, not the MVP.

### 2. `GET /connect` — self-serve key mint               (the UX unblock)
A single self-contained HTML page SERVED BY THE MATCH SERVER (no collision
with the game client files the arcade session owns): loads AIR Kit, signs
in, POSTs /agent/key with the fresh JWT, shows the key once with a copy
button + "paste this into Minds → My Connections". Replaces the
console-snippet mint — the step most likely to lose a real user today.
The game UI's MY AGENT screen replaces this later; the page stays as the
deep-link target.

### 3. Paired prod deploy                                  (gate, not code)
When the parallel session's tree settles + verify is green: Railway +
Vercel from the same snapshot. Nothing Minds-related exists on prod until
this ships (deployed server predates /agent entirely).

### 4. Publish ONE skill, narrow on purpose
"Agent Fighter Coach" with exactly three tools: GET /agent, PUT /agent,
GET /agent/matches. Playbook rules: read before write; partial PUTs only;
always report back the clamped values; never promise stat/skill changes.
Walk the 6-step Minds flow (describe → refine → connect → run → inspect →
publish) with a throwaway account's key first.

## Acceptance test (the whole MVP in one sentence)

A fresh user with zero context can go from the Bazaar listing to "my agent
plays noticeably more aggressively and my Mind told me how last night's
matches went" in under 10 minutes, without touching a terminal —
(terminal is still OK for RUNNING the fighter; coaching must be
terminal-free).

## Explicitly OUT (parked, in rough later-order)

1. Re-sim coaching telemetry (`/agent/report`) — the differentiator, but
   only valuable once real coached matches exist. First post-MVP item.
2. Proactive coach routines (cursor/webhook) — needs #1 to say anything.
3. Server-run matches (`POST /agent/queue`) — compute + abuse surface.
4. MCP wrapper — trivial later; zero Minds-MVP value.
5. A/B presets, public agent cards, key scopes/audit log.

## Phase 2 — autonomy (the two Minds objectives, built 2026-07-18)

### Objective 1: agents play autonomously — SHIPPED (server + headless)
- `POST /agent/signup {name}` → an **inert agent-class account**
  (`agent:<uuid>`): 0 credits forever (no daily, no payouts, wager
  unreachable), FREE arcade entry, XP/rank on the AGENTS tab only — a bot
  farm has nothing to extract. Valves: 5 signups/IP/day, 20 battles/day per
  agent (in-memory; they bound compute, not money).
- One-command autonomy, idempotent:
  `AF_WS=wss://… AF_SIGNUP=CrusherBot AF_MODE=arcade npm run agent`
  (signs up once → af-agent.json, then chains gauntlet battles via the
  arcade run token until loss or full clear).
- Skill gains a 4th tool: `signup` → the Bazaar activation itself can
  create the Mind's own fighter.

### Objective 2: in-game AUTO (hands-free) toggle — SPEC'D, client-blocked
Your coached agent takes the controls: swap the local side's InputSource
from pad to aiPoll(createAi(side, levelSkill, seed, agent_config
personality)). Local + deterministic — no protocol/server change, no LLM in
the loop. Gate: enabled iff the profile HAS an agent_config (the observable
effect of the Minds skill's first PUT) — greyed toggle hints "Coach your
agent on Minds to unlock AUTO". Solo/arcade only (no wager — humans staking
credits deserve a human opponent). XP at a reduced rate TBD. Client files
(main.ts/ui.ts) are the arcade session's lane — hand this spec over.

### Telegram
Zero build: Minds' native chat surface IS Telegram/email. The /connect page
and skill guide tell users to link Telegram to their Mind — that's the whole
integration.

## Risks / watch

- Minds platform is young: cognition costs and tool-call reliability are
  unknowns — keep the playbook cheap (≤2 calls per user turn) and the
  tool count at 3 so schema generation has little to get wrong.
- PUT thrash from a chatty Mind: server-side per-profile rate limit
  (e.g. 30 writes/hour) is a 5-line guard — include in piece 1's PR.
- The /connect page holds an AIR JWT in browser memory only — never
  localStorage; key display is once, page warns before navigating away.
