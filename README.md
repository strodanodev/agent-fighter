# Agent Fighter

Browser 2D fighting game (MvC-style) with a deterministic custom engine.
Full design: see `build-spec.md` in the Agent Fighter project docs.

## Status: Milestone 0 — deterministic sim skeleton ✅

Two rectangle fighters, walk/jump/one attack, hit detection, health, KO,
timer, local 2-player on one keyboard. Snapshot/restore (the rollback
primitive) and replay-hash determinism tests are green.

## Layout

```
packages/core     @af/core   — deterministic simulation. Pure TS. No DOM, no
                               Date, no Math.random, integer-only (24.8 fixed
                               point). step(state, inputs) is the only way
                               state changes.
packages/client   @af/client — Canvas 2D renderer + fixed-timestep loop.
                               Renderer is a pure function of GameState;
                               swap-ready for PixiJS (M0 runs dependency-free
                               because this build env has no npm access).
```

## Commands

```
npm test                   # determinism + rollback + gameplay tests (tsx --test)
npm run demo               # bundle single-file playable demo → packages/client/demo/
```

Requires global `typescript` + `tsx` (or `npm i -g typescript tsx`).

## Controls (M0 demo)

P1: WASD move/jump, F attack · P2: Arrows, K attack · H toggle hitboxes · Enter rematch

## Determinism rules (enforced; see build-spec §2.1)

- Fixed 60 ticks/sec; sim advances only via `step()`
- Integer fixed-point math only — no floats in sim state or sim math
- No `Math.random` (seeded PRNG in GameState), no `Date`, no DOM in `@af/core`
- All state serializable; `stateHash()` for desync detection + CI replay tests
- Cosmetic juice (sparks, screen shake) lives in the client, never in the sim

## Next: Milestone 1 — "It feels like MvC"

Full combat per spec §4: 6 buttons, chains/magic series, launcher + air
combos, motion-input specials, super + meter, pushblock, throws, hitstop
tuning, real character data loaded from the declarative bundle format (§3).
