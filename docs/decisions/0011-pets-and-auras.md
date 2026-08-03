# ADR 0011 — PETS: companions with rolled auras

Status: **ACCEPTED** (owner decisions locked 2026-08-03)
Supersedes nothing. Extends ADR 0007 (consumable items) — read that first;
pets reuse its entire spine.

## Context

The roster, the drinks and the arcade board all give a player something to
chase, but nothing that is *theirs* — every account fights with the same
fighters and buys the same cans. Pets add a persistent, account-bound
companion: a small creature that floats behind your fighter during a match
and passes a permanent, rolled "aura" to it.

Five things the owner asked for, verbatim:

1. in-game companions that appear during a match, floating behind the fighter;
2. generatable / uploadable in the **Studio**;
3. equippable on the **profile page of the landing site** (not in-game);
4. **account bound**;
5. random **aura** multipliers that help in SOLO and RANKED
   (+% atk damage, +% defense, +% hp regen, +% critical, +% energy regen).

Everything below is how those five survive contact with a deterministic,
money-carrying engine.

## The four decisions (locked with the owner)

### 1. Acquisition — credits gacha, aura rolled at mint

A pet is adopted from the same kind of machine as a drink: pay credits, the
**server** picks the pet and rolls its aura, atomically with the debit,
idempotent by a client nonce (`buy_pet`, mirroring `buy_item` from 0013).

The roll never happens on a client and never happens in the sim. By the time
a match starts, an aura is a fixed, known set of integers — exactly the
property that makes drinks safe (ADR 0007), and the reason the gacha does not
put variance into a wagered match.

Rejected: arcade loot drops (couples pets to ADR 0008 progression and gates
them behind clears); free-for-everyone (kills the chase).

### 2. Crit — a seeded roll off `GameState.rngSeed`

This is the one real engine question. Combat has been **variance-free** since
M1; `rngSeed` has been carried in `GameState` and hashed but never read, and
ADR 0007 deliberately reframed the gacha's "crit" as a flat damage-up to keep
it that way.

The owner chose real crits. That is legal and safe *specifically* because the
seed lives in state:

- `rngSeed` is pinned by the server in `SMatch.seed` — both peers start equal;
- it round-trips through `snapshot()`/`restore()`, so a rollback re-simulation
  re-rolls **identically** — the roll is a pure function of the tick history;
- the server's verifying re-sim reproduces every crit, so a client cannot
  claim a crit it did not roll.

The rule that keeps it honest: **the seed advances only when a fighter with a
crit aura lands a clean hit.** A pet-less match never touches `rngSeed`, so it
stays bit-identical to the pre-pet engine in behaviour.

Rejected: every-Nth-hit (countable, dull); flat damage-up (then "crit" and
"atk" are the same aura twice).

### 3. Strength — subtle, 1–8% per line

A pet is a nudge, not a build. One aura line rolls in `[10, 80]` per-mille and
a pet carries 1–3 lines by rarity (70 / 25 / 5, the drink odds). Worst case —
a 3-line legendary rolled at cap — is +8% damage, +8% defence and 8% of a
health bar per minute. Skill still decides the match, and the SOLO/RANKED
ladders stay comparable between accounts with pets and accounts without.

Per-mille integers throughout: no floats anywhere near the sim (ADR 0001).

### 4. Where it applies — open carry, everywhere

Same rule the drinks landed on: the aura applies in solo, arcade/ranked **and
wager**. Friendly challenges stay dry (they move no money and no rank, and
they are the "just play" mode).

The owner accepted the trade knowingly: a wagered match can now be entered
with a small permanent edge, disclosed on the VS card, the same way an
equipped drink is. Pets are cheap in credits and the ceiling is 8%.

## Account bound

There is no transfer path — not an endpoint, not an RPC, not a column. A pet
row's `profile_id` is written once by `buy_pet` and nothing in the schema ever
updates it. "Account bound" enforced by absence, which is the only kind that
cannot be bypassed by a leaked key.

Equipping is owner-authenticated only: an **agent key is refused** on every
pet route, exactly as it is on `/items` — a leaked coach key must never be
able to spend credits or reshape a loadout.

## Shape

```
Studio  ──authors──▶  pets/<id>/pet.json + pet.png     (assets, like stages)
                              │
                              ▼
landing /profile ──▶ match server /pets ──▶ Supabase pets table (owned + rolled aura)
                              │
                              ▼
                    SMatch.pets  (pinned aura per side)
                     │                    │
                     ▼                    ▼
              client sim            server verify re-sim   ← identical install
```

- **`@af/core/pets.ts`** owns the aura vocabulary, the ranges and the roll
  *table* — never the roll itself. Characters-are-data (ADR 0002) applies:
  the engine interprets aura numbers, there is no per-pet code.
- **The catalog is files, not a registry.** `pets/<id>/pet.json` sits beside
  `characters/` and `stages/`; the server reads the directory. A new pet ships
  by adding a folder, no code change — the Studio writes those folders.
- **The sim never loads pet art.** Sprites are cosmetic; the pet's position is
  a pure render-time function of the fighter's state.

## Consequences

- `ENGINE_VERSION` bumps (`af-core-7` → `af-core-8`): eight new `FighterState`
  fields and a live `rngSeed`. Goldens are re-blessed in the same commit; the
  61 behavioural tests must stay unchanged, because a pet-less match is still
  bit-identical.
- `PROTOCOL_VERSION` bumps (8 → 9). `SMatch.pets` is additive, but a client
  that ignores it would simulate a different match than the verifier, which is
  a desync, not a cosmetic gap. Old clients get the clean "protocol 9
  required" message instead.
- Persistence grows four methods (`buyPet` / `listPets` / `equipPet` /
  `equippedPet`) in **both** implementations. The dev in-memory economy must
  keep lying about nothing (the 0002 lesson: money logic lives twice, in
  lockstep, or the dev economy misleads).
- The ledger gains reason `pet` (free text, no CHECK to migrate — same as
  `gacha`).
- HP regen makes health non-monotonic for the first time. The HUD's damage-lag
  flash and every `health <` assumption in the client are audited for it.
