# Architecture Decision Records

Durable memory of *why* the project is built the way it is — so a fresh agent
(any model) or a new contributor doesn't "helpfully" undo a deliberate choice.

Each ADR is one locked decision: the decision, why, consequences, and a
"do not re-litigate" note. Add one whenever you make an architectural choice
that would be expensive to reverse or non-obvious to a newcomer. Never delete
an ADR; if a decision is reversed, add a new ADR that supersedes it and note
the change.

- [0001 — Deterministic, fixed-point, dependency-free core](0001-deterministic-fixed-point-core.md)
- [0002 — Characters are data, not code](0002-characters-are-data.md)
