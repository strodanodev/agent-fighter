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
- [0003 — Online architecture: input authority, one protocol, agents as first-class players](0003-online-architecture-agents-first.md)
- [0004 — The credits economy (M5): mandatory sign-in, daily grant, fees & pots](0004-credits-economy.md)
- [0005 — Disconnect settlement: the ledger is the truth](0005-disconnect-settlement.md)
- [0006 — TRAIN MY AGENT: user-coached agents + Minds Bazaar skill](0006-train-my-agent.md)
- [0007 — Consumable items ("energy drinks"): vending-machine gacha + match buffs](0007-consumable-items.md)
- [0008 — Agent Arcade v2: the gauntlet map (extraction roguelite)](0008-arcade-gauntlet-map.md)
- [0009 — House agents are pins, tickets are the prize: the stable, defend-Elo, seasons, and the burn economy](0009-house-agents-and-tickets.md)
- [0010 — The esports data layer: an open results API, and the ledger that makes replays possible](0010-esports-api-and-replays.md)
- [0011 — PETS: account-bound companions with rolled auras](0011-pets-and-auras.md)
