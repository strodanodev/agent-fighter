# 0006 — TRAIN MY AGENT: user-coached agents + Minds Bazaar skill

Status: PROPOSED (draft for review — nothing here is implemented yet)
Date: 2026-07-17

## The feature in one line

Your agent is a **saved strategy profile** — character + six style knobs —
that fights on your behalf; you "coach" it (in-game or by chatting with an
Animoca Mind), and other players can challenge it any time because the server
can simulate it deterministically. **Stats are never editable.**

## The one architectural insight (why this is cheap)

We already ship everything hard:

| Need | Already exists |
|---|---|
| A parameterized fighting brain | `core/src/ai.ts` — `AiPersonality` (aggression, jumpiness, zoner, throwHappy, pushblocker, patience — 0..255) + `skill` lever, fully deterministic |
| Verified matches vs a server-pinned AI with NO live process | solo local-sim (protocol v3): server pins `{skill, aiSeed}`, client sims, `verifySoloLedger` re-derives — cheat-proof, zero runner cost |
| A headless agent loop for real-time queue play | `agent-session.ts` (`playOneMatch`, pluggable `policy`) + `agent-client.ts` (AF_* env) |
| Per-profile persistence + atomic economy | `profiles` + RPCs (`get_account` / `escrow_match` / `record_match`) |
| HTTP auth surface on the match server | `/me` (Bearer AIR JWT), CORS, `/leaderboard` |
| Bearer-secret pattern | match resume tokens |

So TRAIN MY AGENT v1 is **a config blob + a token + three HTTP endpoints +
one field on the solo setup message**. No new netcode, no hosted runners, no
new verification machinery.

## Hard rules (integrity)

- **Stats are hardcoded.** `skill` is always server-derived from the OWNER's
  level (same ramp as today's house AI). Character frame data is bundle-hash
  pinned. The config can never touch damage, health, meter, or skill.
- **Style knobs are clamped server-side** to the exact ranges `createAi`
  already samples from (e.g. aggression 90–220). Outside-range values are
  clamped, never rejected — coaching always "works". This also prevents
  degenerate stall-bots (patience 255) and turbo-bots.
- **Verification unchanged**: a trained agent fights via the existing solo
  pipeline; `verifySoloLedger` re-derives it from the pinned
  `{skill, aiSeed, personality}` — puppeteering it still fails the re-sim.
  `step()` is untouched → **no ENGINE_VERSION bump** (personality rides in
  the setup message exactly like `skill` does today).

## Data model (migration 0007)

`profiles` gains:
- `agent_config jsonb` — `{ character, personality: {6 knobs}, motto }`,
  validated + clamped in the RPC. NULL = no trained agent yet.
- `agent_key_hash text`, `agent_key_created_at` — sha256 of the durable
  agent key (ADR 0003 Phase B "agent tokens", finally). Key shown once.

## API (same match-server HTTP listener)

- `POST /agent/key` — Bearer AIR JWT → mints the durable agent key
  (returns plaintext once; stores hash). Re-POST rotates/revokes.
- `GET /agent` — AIR JWT **or** `X-Agent-Key` → config + record
  (level, W-L, credits are read-only in the response).
- `PUT /agent` — same auth → write config (server clamps).
- `GET /agent/matches?limit=` — recent settled matches for the profile.
- ws `hello.agentKey` — the reference agent client authenticates with the
  durable key instead of a short-lived AIR JWT (`AF_AGENT_KEY` env) —
  removes today's "dig the JWT out of devtools" blocker.

## Game modes it unlocks

1. **VS MY AGENT (sparring)** — free/1cr solo match against your own config.
   The training feedback loop: coach → spar → adjust.
2. **Challenge a trained agent** — dare links gain `?agent=1`: the accepter
   fights the SENDER's trained agent via the solo pipeline (server pins the
   sender's config). The sender is offline; no runner, still verified.
   Economy v1: standard solo fee/payout vs the house — the owner earns
   nothing yet (no new exploit surface); bounty rake is a later knob.
3. **Queue grinding (unchanged)** — `npm run agent` with `AF_AGENT_KEY`;
   default policy now reads the owner's saved personality.

## Minds Bazaar integration (the "coach" interface)

Per build.hellominds.ai docs: skills are described in natural language; the
platform generates the registry offering / app manifest / tool schemas /
playbook, and the user's credentials live in Minds "My Connections" (the
Mind never holds the key).

Our side (all we actually build):
- The REST API above — key-authenticated, JSON, stable.
- `docs/agent-api.md` — endpoint reference the skill manifest is built from.
- A skill description template ("Agent Fighter Coach"): the Mind reads
  `GET /agent` + `/agent/matches`, discusses results ("you keep losing to
  jump-ins"), and applies coaching via `PUT /agent` — e.g. "be more
  patient, stop jumping" → `{patience:+40, jumpiness:-60}`.

User setup flow ("agent account" prerequisites, now clean):
1. Sign into the game with AIR (existing) — this IS the account.
2. Title screen → MY AGENT → "CONNECT A COACH" → mints + shows the agent
   key once (copy).
3. In Minds: create a Mind, add the Agent Fighter connection (paste key),
   enable the Coach skill from the Bazaar.
4. Chat to train. Credits/level/W-L remain game-earned only.

## Explicitly NOT in v1 (rejected complexity)

- Hosted always-on agent runners (solo-pipeline simulation covers offline
  presence; runners are pure cost + abuse surface).
- LLM calls anywhere in the 60 Hz loop (ADR 0003: strategists sit ABOVE
  `playOneMatch`, tuning knobs between matches).
- Editable skill/stats, per-character scripting, custom combo authoring
  (characters are data; the cancel-graph-derived combo book stays).
- OAuth — one durable key per profile, rotate on demand, matches the
  resume-token trust pattern.

## Build order

1. Migration 0007 + persist.ts (both impls) — config CRUD + key hash.
2. `createAi` personality override + solo setup/verify plumbing (+ tests:
   clamps, determinism with pinned personality, re-sim equality).
3. HTTP endpoints + `AF_AGENT_KEY` in the agent client.
4. VS MY AGENT sparring entry + minimal MY AGENT screen (view config,
   mint key).
5. `docs/agent-api.md` + Minds skill description; register + publish.
6. Dare-vs-agent mode (after economy review).
