# AGENTS.md — Agent Fighter working contract

**Read this first, every session, regardless of which AI/IDE you are (Claude
Code, Cursor/Grok, Copilot, human).** This file is the tool-neutral source of
truth. `CLAUDE.md` and `.cursor/rules/` point here. If they ever disagree,
**this file wins.**

Agent Fighter is a browser 2D fighting game (Marvel-vs-Capcom feel) built on a
custom **deterministic** engine. It is an *engine* and a *game* developed
together. The full design is in `docs/build-spec.md` (read before large
changes); architecture rationale is in `docs/architecture-recommendation.md`;
locked decisions are in `docs/decisions/` (ADRs).

## The one rule that makes this project survive model/context switches

```
npm run verify
```

Run it **before you start** (know the baseline is green) and **before you
claim any change is done**. It runs: typecheck (all packages) + the full test
suite (gameplay + determinism + golden replay + invariant guards). If it is
red, you are not done — **a red `verify` is a wall, not a suggestion.** Never
edit tests or golden data to make it pass unless changing them IS the task
(see "Golden hashes" below).

You cannot hold this whole codebase in context, and the next session may be a
different model with no memory of this one. So correctness does not live in
anyone's head — it lives in `verify`. Trust it over your assumptions.

## Repository shape

```
packages/core     @af/core   — deterministic simulation. Pure TS, ZERO deps.
                               step(state, inputs) is the ONLY way state changes.
packages/client   @af/client — Canvas2D renderer + input + loop. Pure view of state.
packages/studio   @af/studio — character authoring tool + AI sprite pipeline.
characters/<id>/  — character bundles (character.json + sprites/ + atlas).
docs/             — build-spec, architecture, ADRs.
```

`@af/core`'s public API is whatever `packages/core/src/index.ts` exports —
**that file is the contract.** Read it before using or adding core APIs; do
not reach into core internals from client/studio. Do not add dependencies to
`@af/core`, ever.

## Determinism rules — NON-NEGOTIABLE in `@af/core` (mechanically enforced)

The sim must be **bit-identical** across browsers, Node, and re-simulation.
Rollback netcode and server-side match verification (anti-cheat for future
wagering) depend on it. These rules are enforced by
`packages/core/test/guards.test.ts` — violating them fails `verify`:

1. State advances ONLY via `step(state, inputs)`; fixed 60 ticks/sec.
2. Integer fixed-point math only (24.8; helpers in `fp.ts`). No floats in sim
   state/arithmetic. No `Math.random`, `Date`, `performance`, DOM, timers,
   `fetch`, `process`, or transcendental `Math.*` (sqrt/trig/pow/log/exp) in
   `@af/core`. Allowed integer-exact Math: abs/min/max/trunc/floor/ceil/round/
   sign/imul.
3. Seeded PRNG lives in `GameState` (`nextRand` + the seed). Never wall-clock,
   never ambient randomness.
4. **Field order is protocol.** Every field in `GameState` must be listed in
   `serialize()` (state.ts) and round-trip through `snapshot`/`restore`. Add a
   field → add it in all three places. `serialize.test.ts` enforces this
   automatically; if it fails, you forgot one.
5. Cosmetic effects (sparks, screen shake, sounds, sprite selection) live in
   the client/studio, keyed off state — NEVER inside the sim. (`anim.ts` is a
   pure, deterministic *name resolver*; it is cosmetic and the sim never calls
   it.)

## Golden hashes (behavior lock) — how to change gameplay on purpose

`packages/core/test/golden/hashes.json` pins what the game *does*: committed
final + trace hashes for a corpus of full matches. Any change to sim behavior
turns the golden test red — even a one-in-a-thousand balance tweak.

- **Golden test fails and you did NOT mean to change behavior** → you have a
  regression. Fix the code. Do **not** touch `hashes.json`.
- **You DID intend it** (balance/mechanic/bugfix that legitimately alters
  outcomes) → run `npm run golden:bless` and commit the regenerated
  `hashes.json` **in the same commit**, so the diff documents exactly which
  matches changed and a reviewer can confirm it was deliberate.

## Design principles (from build-spec §3)

- **Characters are DATA, not code.** No per-character TypeScript. The engine
  interprets frame-data tables + cancel graphs. If a mechanic seems to need
  character code, extend the schema vocabulary instead.
- All input consumers go through the `InputFrame` bitfield / `InputSource`
  seam — human, AI, network, replay are indistinguishable to the sim.
- Tuning values (hitstop, pushback, gravity, damage scaling) belong in data
  (`TUNING` in `data.ts`, or the character bundle), not scattered in logic.

## Workflow contract

1. `npm run verify` green before you start.
2. Make the smallest change that accomplishes the task.
3. Prefer editing data over adding engine code; prefer extending the schema
   over special-casing.
4. `npm run verify` green before you call it done. If you changed gameplay on
   purpose, bless the golden hashes in the same commit.
5. Commit in coherent units with a message that says what changed and why.
   Update `docs/decisions/` if you made an architectural choice.

## Headless agents / fleet (ops — read before inventing a scheduler)

Canonical doc: [`docs/headless-agent.md`](docs/headless-agent.md). Public mirror:
landing site `/docs/headless-runner`.

| Command | Use |
|---|---|
| `npm run agent` | One-shot / finite session (`AF_MATCHES`, `AF_MODE`, …) |
| `npm run fleet` | Recurring play: one Node process, N free agent-class bots |

- Fleet code: `packages/server/src/agent-fleet.ts`. Env: `AF_WS`, `AF_FLEET`
  (≤12), `AF_PACE=16` on prod, optional `AF_FLEET_FILE` / `AF_FLEET_BATTLES`.
- State/keys: `af-agent.json` / `fleet-agents.json` (gitignored, plaintext).
- **Operator-owned agents:** `POST /agent/signup` requires AIR (or
  `X-Dev-Name` in dev). Mint in-game **MY AGENT → CREATE AGENT FIGHTER**
  (or `/connect`). Links via `profiles.owner_sub` (migration `0017`).
  Cap: 12 agents/owner. Auth gate is in `server.ts` (DB keeps a legacy
  3-arg RPC until the match server is redeployed — then drop it).
- Fleet state: repo-root `fleet-agents.json`. Growth needs `AF_TOKEN` or
  pre-minted keys. Migration `0014_sticky_agent_names` keeps `agent:*`
  names sticky through `record_match` (applied on prod).
- **Do not add a cron farm** — fleet loops + daily-cap sleep is enough.

## Current status & roadmap

See `CLAUDE.md` "Current status" and `docs/build-spec.md` §10 (milestones).
Short version: M1 (full MvC combat) code-complete; M2 (Studio + AI sprite
pipeline) built, character #2 produced through it. Next candidates: M1 human
feel-gate, M3 rollback netcode + verifying match server (the sim is already
rollback-native — `snapshot`/`restore`/`stateHash`).
