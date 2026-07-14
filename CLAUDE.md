# Agent Fighter — Claude Code project context

> **The canonical, tool-neutral working contract is [`AGENTS.md`](AGENTS.md).**
> Read it first. It is shared with Cursor/Grok and any other agent via
> `.cursor/rules/`. If this file and `AGENTS.md` ever disagree, `AGENTS.md`
> wins. The one rule: **run `npm run verify` before you start and before you
> call any change done** — typecheck + tests + golden replay + determinism
> guards. A red `verify` is a wall, not a suggestion.

Browser 2D fighting game (Marvel vs Capcom feel) with a custom deterministic
engine. Online multiplayer with rollback netcode, single-player vs AI, and a
phased crypto layer (pay-to-play credits, then P2P wagering) are planned.
The full build spec lives in `docs/build-spec.md` — read it before large
changes. Architecture rationale (why not IkemenGO/Phaser, prior art) is in
`docs/architecture-recommendation.md`. Locked decisions: `docs/decisions/`.

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
Analog frame data from playtests.

**Milestone 2 (Studio MVP) in progress.** `packages/studio`:
- `server.mjs` — zero-dep Node server: serves the SPA, proxies image
  generation to NVIDIA build API (flux.2-klein-4b; key in gitignored `.env`
  as NVAPI_KEY — NEVER commit it or ship it to the browser), character
  bundle CRUD with sha256 content hash on save.
- `src/main.ts` — SPA embedding @af/core: Character/Frames/Moves/Cancels
  editors, live Test tab (real engine preview vs dummy), Generate tab.
- `src/pipeline.ts` — deterministic sprite post-processing (spec §5.1):
  bg removal → palette lock → nearest downscale into 192×192 cell (feet
  pivot 96,176) → QC score vs reference → auto-hurtbox/hitbox drafts.
- Bundles on disk: `characters/<id>/character.json` + `sprites/*.png`.
  `loadCharacter()` validates; `setCharacters()` swaps bundles between
  matches (never mid-sim). Sprites are cosmetic — the sim never reads them.
- Run: `npm run studio` → http://localhost:8474.
- Shoto archetype pose library (SHOTO_POSES in studio main.ts) auto-fills
  generation prompts per canonical move id — reused across the roster;
  characters override via meta.moveDesc. "batch ALL moves" generates every
  step of every move, auto-accepts QC passes, one seed-salted retry on
  failure. Seeds are stable per (char, move, step) for reproducibility.
- Atlas packed on every save (browser-side grid of fixed 192px cells) →
  characters/<id>/sprites/atlas.png + atlas.json — the spec §3 ship format.
- Test tab has a P2 character select for versus matches between bundles.
- **STRIP GENERATION is how costume consistency is achieved (spec §5.1
  stage 2).** Generating each frame as its own image makes the model
  re-invent the outfit every call — the fighter appears to change clothes
  mid-animation. Instead each move is ONE image (1536×640) containing all
  its poses side by side, sliced back apart by `sliceStrip()` (column-gap
  analysis). Inside one image the model draws one character in one costume.
  All strips of a character also share one seed (`charSeed`), which keeps
  costumes consistent BETWEEN moves. Moves with >4 steps are chunked into
  strips of ≤4. Falls back to per-frame only if slicing fails — and that
  fallback is REPORTED in the status line (`strips N ok / M fell back`),
  never silent.
- **API CONSTRAINTS (learned the hard way):** prompts are capped at **800
  characters** (422 `string_too_long` beyond it) — `buildStripPrompt()`
  budgets against `PROMPT_MAX` and trims pose text to fit. Width/height
  must come from a discrete list, max 1536. An over-long prompt fails the
  whole request, which is why strip mode silently degraded to per-frame
  before the budget existed.
- **THE CONSISTENCY CEILING (read before "fixing" sprite drift again).**
  NVIDIA's hosted flux CANNOT accept a user reference image — proven on
  BOTH flux.2-klein-4b and flux.1-kontext-dev, with base64, data-URI, and
  a properly uploaded NVCF asset id. The `image` field only accepts their
  gallery `example_id`. So on IMAGE_PROVIDER=nvidia, cross-image character
  identity is fundamentally best-effort: strips hold a costume WITHIN one
  move; between moves only the text description + palette lock carry it.
- **REAL FIX = img2img.** `server.mjs` now has a pluggable IMAGE_PROVIDER
  (`nvidia` | `bfl` | `fal`). Set `IMAGE_PROVIDER=bfl` + `BFL_API_KEY`
  (api.bfl.ai) or `IMAGE_PROVIDER=fal` + `FAL_KEY` (fal.run) in `.env` and
  the Studio automatically sends the locked reference sheet with EVERY
  frame request (FLUX Kontext: "keep this character, change the pose") —
  true identity lock. `GET /api/capabilities` reports whether img2img is
  live; the Generate tab shows a banner either way. The bfl/fal paths are
  implemented but UNTESTED (no key available at the time of writing).
- **FAILED EXPERIMENT — do not repeat.** Prepending a fixed "anchor" idle
  pose to every strip AND using one shared seed per character collapsed the
  model onto a single image: the jab, sweep, DP and walk all came back
  PIXEL-IDENTICAL (48 distinct images out of 100). Perfect costume
  consistency, dead animation. Poses need distinct seeds + distinct pose
  text. The sprite audit now flags `DUPE` (identical content across two
  different moves) so this class of failure can never ship silently.
- **System animations (2026-07-15):** every non-attack state has a sprite
  track. Bundles carry `sys.*` moves (type:"system" — idle/walkF/walkB/
  crouch/jump(3-step)/dash/block×3/hitstun/airHitstun/knockdown/getup/ko);
  Studio auto-adds missing ones on load. `@af/core/src/anim.ts` exports
  `spriteForFighter(f, ch, tick)` — the ONLY correct way for any renderer
  to pick a frame. The sim never reads system moves (cosmetic only; they
  are never selectable as attacks). Analog + Vector both have 98/98 steps
  sprited. Pipeline hardening: connected-component filter (drops shadows/
  second figures), multi-figure QC fail, per-type QC thresholds (45 for
  special/super VFX frames, palette-only for lying poses), batch retries
  up to 3× with random salts, "missing only" batch mode.
- Known gap: the single-file M1 demo client still renders rects (it embeds
  the sprite-less ANALOG TS module). Making the game client load
  characters/<id>/ bundles + atlas is part of the game-UI phase (title
  screen/select/HUD per the user's reference art), which comes next.

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
