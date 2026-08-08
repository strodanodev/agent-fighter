# 0011 — PETS: the warden's cache (deep-clear gacha) + the repeat-play ladder

Status: **PROPOSED — needs owner sign-off before any code.** The owner floated
the core idea ("free random pet gacha at the end of the gauntlet, if users
defeat the boss", 2026-08-08); this ADR turns it into a buildable design that
survives the rules locked in 0004/0007/0008/0009. Nothing here is built.
Date: 2026-08-08
Builds on: 0007 (gacha plumbing), 0008 (gauntlet map), 0009 (cosmetic-first
collectibles, bots-never-mint, no-prize-promises)

## The feature in one line

Clearing THE CORE — beating the warden and extracting through EXIT 3 — mints
one **pet gacha pull**: a random, tiered cosmetic companion that follows your
fighter on the gauntlet map and select screen, collected in a kennel, forever.

## Why a pet and not more credits

The audit found the deep clear pays +18 CR and *nothing else you can point
at*. Credits are fungible and spent by tomorrow; the diminishing-returns
taper (0018) deliberately caps them as a repeat motivator by design. What the
mode lacks is a **non-fungible reason to run it again**: something you can
only get by beating the warden, that accumulates, that other players can see,
and that never touches the credit faucet. That is exactly the shape 0009
already proved out with tickets ("cosmetic collectible, value added at the
redemption counter later, nothing minted now is invalidated").

A pet-per-clear also self-tunes: the first clear is a guaranteed pull (the
owner's "free random pet if you defeat the boss"), and every later clear is a
shot at the species/rarity you're missing — the collection IS the pity timer.

## Rules inherited from prior ADRs (non-negotiable, already locked)

- **Bots never mint anything** (0009 "do not re-litigate"): agent-class subs
  are excluded exactly like tickets; autopilot/fleet deep clears mint nothing.
- **Cosmetic only, forever-by-default** (0009 phase discipline): a pet has NO
  gameplay effect. Pet "abilities" would be a paid-power vocabulary — that
  crossing was priced and gated once (0007 drinks) and doesn't need a second
  door. If pets ever become more than cosmetic, that is a new ADR.
- **Say what it is, never what it might become** (0009): no "tradeable
  later", no rarity-value talk. A pet is a creature that follows you around.
- **Randomness lives server-side at grant time** (0007): the roll happens in
  the extraction transaction. The sim never reads pets; no ENGINE_VERSION
  bump; goldens untouched.
- **Money logic lives twice in lockstep** (0007/0008): the grant is a SQL
  migration + the persist.ts memory mirror, idempotent, RLS default-deny.

## Proposed decisions (for the owner to lock or veto)

| Question | Proposal | Rationale |
| --- | --- | --- |
| Trigger | **Tier-3 extraction only** (`/arcade/extract`, exitTier 3), NOT the boss KO itself | The boss's only successor is EXIT 3 (validateBoard guarantees it), so "beat the warden" and "extract deep" differ only by one un-fightable step — and granting at extraction reuses the existing idempotent payout transaction (`pet:<runToken>` key, the `xtr:` drink pattern). A KO-time grant would need a new settlement path for zero player-visible difference |
| Odds | One pull per deep clear; species uniform within region theme, rarity 70/25/5 (the 0007 odds) | Guaranteed pull honors "free random pet if you defeat the boss"; rarity reuses tuned numbers |
| Dupes | Dupes add a **star** to the owned pet (★2, ★3…) | Every clear still pays something visible; no dust/shard economy to balance |
| Daily cap | **None beyond idempotency** (one pull per run token) | The DR taper already prices runs 4+ per day; a cosmetic needs no valve, and adding one would be the "difficulty as monetary policy" smell in miniature |
| Where it shows | Follows the YOU token on the map, idles beside your fighter on select, sits in the extract receipt reveal; a KENNEL shelf on the shop screen (existing stash pattern) | All existing draw surfaces; zero protocol change beyond the grant response + a `pets` list endpoint |
| In-match presence | **Phase 2, cosmetic client layer only** (trailing sprite keyed off GameState, like sparks) | Legal under determinism rule 7; deferred so phase 1 ships without touching the fight renderer |
| Art | Phase 1 **procedural** (the can-art precedent: tier-tinted canvas creatures, ~12 species × 3 regions of the board as themes); Studio-generated art later via the provider abstraction (non-character art needs no identity lock — the stage/can pipeline) | Ships without waiting on an art pass; pets inherit board lore (scrap-mites of SCRAPYARD ROW, stack-wisps, core-wardlings) |
| Storage | `pets` table: profile_id, species, rarity, stars, minted run token; service-role only; grant folded into the `arcade_extract` migration family | The tickets/items table shape, third verse |
| Leaderboard | **No column for now** | 0009: currency ≠ status, and the board already gained tickets recently; the kennel is the showcase |

## What this is NOT (so it never drifts there)

- Not a power system. Not tradeable. Not burnable for credits. No paid pulls
  with credits — the pet pull is EARNED ONLY (the vending machine sells
  drinks; the warden pays pets). A credit-priced pet gacha would compete with
  the drink sink and turn the cosmetic into a purchasable, which re-opens the
  0009 farming analysis for nothing.
- Not a login streak, not a battle pass. One source: clear THE CORE.

## The rest of the repeat-play ladder (smaller, independently shippable)

Ordered by leverage per effort, from the 2026-08-08 audit:

1. **Mid-run drink use** — ADR 0008 locked "found drinks are usable mid-run
   AND bankable" but no endpoint exists; the bag's drinks only materialize at
   extraction. This is a designed, owner-approved feature that simply never
   shipped, and it deepens exactly the risk decision the mode is built on.
2. **Daily board** — one shared seed per UTC day ("TODAY'S BOARD"), same for
   every player, with a today-only extraction tally. Compare hauls, no new
   economy, pure bragging; the generator already takes a required seed.
3. **Arcade personal records** — best haul, deepest clear, clears count, on
   the profile/extract screen (client + one SQL view; no new currency).
4. **Named warden rotation** — castBoard already puts the highest-level
   stable agent on the boss node; give that slot a per-season named identity
   ("beat all 3 wardens this season" is a collection hook that feeds the
   pet/kennel surface and 0009's gatekeeper ambitions).
5. **Nemesis/grudge sampling** — already deferred in 0009 (habit-vector
   step); the boss slot is where it lands hardest ("IRONCLAD remembers you").

## Open questions for the owner

- Pet count/themes: 12 species (4 per region) feel right, or start smaller?
- Should practice (guest) deep clears show the reveal with a "sign in to
  keep pets" hook, mirroring the game-over CTA? (Lean: yes — best demo
  moment in the mode; grants nothing, per bots/guests-mint-nothing.)
- Extract-screen reveal order: pet before or after the credit receipt?
  (Lean: after — money first, creature as the curtain call.)
