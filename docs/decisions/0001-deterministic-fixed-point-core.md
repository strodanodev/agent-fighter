# ADR 0001 — Deterministic, fixed-point, dependency-free simulation core

Status: **accepted** · locked at Milestone 0

## Decision

`@af/core` is a pure, deterministic simulation: `step(state, inputs) → state`
at a fixed 60 ticks/sec, all positions/velocities in 24.8 fixed-point
integers, seeded PRNG inside `GameState`, no floats in sim math, no `Date`,
`Math.random`, DOM, timers, IO, or transcendental `Math.*`. `GameState` is a
flat serializable structure with cheap `snapshot`/`restore`. Zero runtime
dependencies.

## Why

- **Rollback netcode** (GGPO-style) requires cheap snapshot/restore and
  re-simulation that reproduces exactly. Float math diverges across
  browsers/CPUs and breaks it.
- **Server-side match verification** (anti-cheat, and the settlement backbone
  for future wagering) requires the server to re-simulate the input log and
  get bit-identical results.
- Both are effectively free *if determinism is designed in from day 0* and a
  rewrite if retrofitted. So it is non-negotiable, not a later optimization.

## Consequences

- Enforced mechanically by `guards.test.ts` (forbidden constructs) and
  `serialize.test.ts` (field completeness), and locked by the golden replay
  corpus. See `AGENTS.md`.
- Cosmetic effects (sparks, shake, sound, sprite selection) must live in the
  client/studio, keyed off state — never in the sim.
- Do not add dependencies to `@af/core`.

## Do not re-litigate

A future agent "simplifying" the sim to use floats, `Math.hypot` for
distances, `Date.now()` for timing, or `structuredClone` of a non-flat state
would break the entire netcode + anti-cheat strategy. Don't.
