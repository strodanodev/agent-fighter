# Agent Fighter — Claude Code project context

Browser 2D fighting game (Marvel vs Capcom feel) with a custom deterministic
engine. Online multiplayer with rollback netcode, single-player vs AI, and a
phased crypto layer (pay-to-play credits, then P2P wagering) are planned.
The full build spec lives in `docs/build-spec.md` — read it before large
changes. Architecture rationale (why not IkemenGO/Phaser, prior art) is in
`docs/architecture-recommendation.md`.

## Current status

Milestone 1 code-complete (2026-07-14): full MvC combat system on the
deterministic core — 6 buttons, magic-series chains via cancel graph,
launcher + super-jump air combos with juggle points, motion specials
(236P fireball projectile, 623P DP, 214K), 236PP super (1 bar of 3, flash
freeze), blocking mid/low/overhead + chip, pushblock, throws + techs,
damage scaling ×0.9 floor 20%, hitstun decay, hitstop, best-of-3 rounds,
1600px scrolling stage. Character data is declarative (spec §3 shape):
`src/data.ts` defines the bundle format + `TUNING` knobs;
`src/characters/analog.ts` is character #1 (pure data, zero code).
35 tests green (`test/determinism.test.ts` + `test/combat.test.ts`).

**Remaining M1 gate (human):** MvC players confirm the feel; tune TUNING +
Analog frame data from playtests. After that: Milestone 2 — Studio MVP
(AI sprite pipeline + editors, spec §5).

## Layout

- `packages/core` (`@af/core`) — deterministic simulation. Pure TS.
- `packages/client` (`@af/client`) — renderer + input + game loop.
- Future: `packages/server` (match relay + result verification),
  `packages/studio` (character authoring tool). See spec §2.

## Commands

- `npm test` — full test suite (`tsx --test`, no framework deps)
- `npm run demo` — bundle single-file playable demo → `packages/client/demo/`
- `typescript` + `tsx` are devDependencies (npm install at the root).
- The client renderer is designed to move to PixiJS v8 in M2+ — but keep
  `@af/core` dependency-free forever.

## Determinism rules — NON-NEGOTIABLE in `@af/core`

The sim must be bit-identical across browsers, Node, and re-simulation.
Rollback netcode and server-side match verification (anti-cheat for wagering)
depend on it.

1. State advances ONLY via `step(state, inputs)`; fixed 60 ticks/sec.
2. Integer fixed-point math only (24.8, helpers in `src/fp.ts`). No floats
   in sim state or sim arithmetic. No `Math.sqrt`/trig on sim paths.
3. No `Math.random` (use `nextRand` with the seed in GameState), no `Date`,
   no DOM/async/IO imports in `@af/core`.
4. Everything in GameState is a number; keep `serialize()`/`stateHash()`
   field lists in sync when adding fields (field order is protocol).
5. `snapshot()`/`restore()` must stay cheap and complete — every new state
   field must round-trip through them.
6. No iteration over unordered collections (object key order, Set/Map) in
   ways that affect outcomes.
7. Cosmetic effects (sparks, shake, sounds) live client-side only, keyed off
   state changes — never inside the sim.

Every PR/change to `@af/core` must keep `npm test` green; the determinism
and rollback tests in `packages/core/test/determinism.test.ts` are the
contract. Add replay-hash coverage for new mechanics.

## Design principles

- Characters are DATA, not code (spec §3). No per-character TS classes, no
  embedded scripting language. Engine interprets frame-data tables +
  cancel graphs. If a mechanic seems to need character code, extend the
  schema vocabulary instead.
- All input consumers go through the `InputFrame` bitfield / `InputSource`
  interface — human, AI, network, replay are indistinguishable to the sim.
- Renderer is a pure function of GameState. Never put game logic in the
  client. Never read sim internals except through exported helpers.
- Tuning values (hitstop, pushback, gravity, damage scaling) belong in data
  files, not constants scattered in logic — they will be tuned constantly.

## Milestone roadmap (spec §10)

M1 full combat/feel → M2 Studio character tool (AI sprite pipeline; vendor
MIT-licensed agent-sprite-forge post-processor as seed, see spec §11) →
M3 rollback netcode + verifying match server → M4 AI opponents + roster →
M5 Privy auth + credits → M6 escrow wagering (gated on legal review).
