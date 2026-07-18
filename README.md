# Agent Fighter

Browser 2D fighting game (MvC-style) with a deterministic custom engine.
Full design: see `docs/build-spec.md`.

## Status: Milestone 2 — Studio MVP (in progress)

Studio (character authoring tool) is up: frames/moves/cancels editors with
visual hitbox editing, a live playable Test tab (the real engine renders the
preview), and the AI sprite pipeline — flux.2-klein-4b via NVIDIA build API →
background removal → palette lock → nearest-neighbor downscale → QC scoring →
auto-hurtbox/hitbox drafts. Character bundles live in `characters/<id>/` with
content hashes.

```
npm run studio             # build + serve → http://localhost:8474
                           # needs .env with NVAPI_KEY=... (gitignored)
```

**M2 exit test:** character #2 built entirely through Studio in < 2 days.

## Milestone 1 — "It feels like MvC" ✅ (feel-gate pending)

Full combat system on the deterministic core: 6 buttons, magic-series chains,
launcher + super-jump air combos with juggle points, motion specials
(236 fireball / 623 DP / 214 advancing kick), 1-bar super with flash freeze,
blocking (mid/low/overhead) + chip, pushblock, throws + techs, damage scaling
+ hitstun decay, hitstop, best-of-3 rounds, scrolling camera stage.
35 tests green (determinism, rollback, all mechanics).

**Remaining M1 gate:** people who play MvC say it feels right — tune
`TUNING` in `packages/core/src/data.ts` + the Analog frame data from
playtests.

## Layout

```
packages/core     @af/core   — deterministic simulation. Pure TS. No DOM, no
                               Date, no Math.random, integer-only (24.8 fixed
                               point). step(state, inputs) is the only way
                               state changes.
  src/data.ts                — character bundle format (spec §3) + TUNING knobs
  src/characters/analog.ts   — character #1, 100% declarative data
  src/motion.ts              — 236/214/623 motion parser + input history
  src/sim.ts                 — the combat engine
packages/client   @af/client — Canvas 2D renderer + camera + HUD + input.
                               Renderer is a pure function of GameState;
                               swap-ready for PixiJS in M2+.
```

## Commands

```
npm test                   # determinism + rollback + combat mechanics (tsx --test)
npm run demo               # bundle single-file playable demo → packages/client/demo/
npm run agent              # one-shot headless client (AF_* env — docs/headless-agent.md)
npm run fleet              # recurring free-tier agent supervisor (AF_FLEET=N)
```

## Controls (M1 demo)

|        | Move | LP MP HP | LK MK HK |
|--------|------|----------|----------|
| **P1** | WASD | T Y U    | G H J    |
| **P2** | Arrows | I O P (or Num 4/5/6) | K L ; (or Num 1/2/3) |

- **Chains:** L → M → H → 2HP (launcher) → hold up → air chain → j.HP/j.HK
- **Specials:** 236+P fireball · 623+P dragon punch · 214+K advancing kick
- **Super:** 236+PP (needs 1 bar)
- **Defense:** hold back (down-back for lows) · pushblock: 2 punches in blockstun
- **Throw:** close + 4/6 + HP (HP inside the window techs)
- **Movement:** double-tap dash · tap down→up super jump · double jump · air dash
- **B** toggles hitbox/frame-data debug overlay · **Enter** rematch

## Determinism rules (enforced; see build-spec §2.1)

- Fixed 60 ticks/sec; sim advances only via `step()`
- Integer fixed-point math only — no floats in sim state or sim math
- No `Math.random` (seeded PRNG in GameState), no `Date`, no DOM in `@af/core`
- All state serializable; `stateHash()` for desync detection + CI replay tests
- Cosmetic juice (sparks, screen shake) lives in the client, never in the sim

## Next: Milestone 2 — Studio MVP

Character authoring web tool: AI sprite generate → normalize → QC → auto-hitbox
pipeline + timeline/frame-data/cancel-graph editors. Exit test: character #2
built entirely through Studio in < 2 days. (Spec §5.)
