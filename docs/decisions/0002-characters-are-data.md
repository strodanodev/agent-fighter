# ADR 0002 — Characters are data, not code

Status: **accepted** · locked at Milestone 1

## Decision

A character is 100% declarative data: a `CharacterBundle` (frame-data table of
moves + a cancel graph + tuning), stored as `characters/<id>/character.json`
with a packed sprite atlas. The engine *interprets* this data. There is no
per-character TypeScript, and no embedded per-character scripting language.
`packages/core/src/characters/analog.ts` is an in-repo authoring convenience
that produces a bundle — it is data expressed in TS, not character logic.

## Why

- This is the deliberate replacement for MUGEN's CNS/AIR hand-authored config
  and its scripting trap (build-spec §3). Data is validatable, hashable,
  diffable, and safe to load from untrusted sources later.
- The bundle **content hash** becomes part of match setup, so both clients and
  the verifying server provably simulate identical characters — required once
  money is on the line (wagering, Milestone 6).
- The Studio (Milestone 2) authors these bundles; a data format means the tool
  and the engine never drift.

## Consequences

- If a character seems to need bespoke logic (e.g. a stance system), add a
  small allowlisted "behavior flag" to the schema — do NOT embed a scripting
  runtime, and do NOT add a per-character code path in the sim.
- Tuning lives in data (`TUNING` in `data.ts` and the bundle), not scattered
  constants.

## Do not re-litigate

Adding `if (character === 'ryu')` branches, a per-character class hierarchy, or
an eval-based move-script interpreter all reintroduce the MUGEN trap and break
the hash-equality guarantee. Extend the data schema instead.
