# 0007 — Consumable items ("energy drinks"): vending-machine gacha + match buffs

Status: ACCEPTED (Phase 1 shipped this session; Phases 2–4 planned)
Date: 2026-07-19

## The feature in one line

Players spend credits at a **vending machine** (title screen, upper-right) on
a **gacha pull** that grants a random, tiered (LV 1/2/3) energy drink whose
fixed effect (heal / damage up / defense up / meter) can later be carried
into ranked matches.

## The one architectural insight (why this is cheap)

The gacha's randomness and the sim's determinism never meet:

- **The roll happens at PURCHASE time, server-side.** By the time a match
  starts, an item is a fixed, known effect. The sim never rolls dice — the
  vestigial in-state `rngSeed` stays vestigial.
- **Items are DATA** (`@af/core/src/items.ts`), exactly like characters: a
  small effect vocabulary the engine will interpret, never per-item code.
- **The loadout will ride match setup like `solo.personality` does**
  (ADR 0006): pinned by the server into `SMatch`, applied identically by the
  client sim and the verification re-sim. No trust in the client, ever.

## Decisions locked here (defaults — revisit before Phase 4)

| Question | Decision | Rationale |
| --- | --- | --- |
| Where randomness lives | Server, at purchase | Sim stays variance-free; verification unchanged |
| "Crit rate" effect | **Reframed as flat damage-up** ("OVERCLOCK") | Real crits need per-hit in-sim RNG — a deliberate variance decision this game has never made; revisit separately |
| Activation | Phase 2 = pre-match buff; Phase 3 = in-match button (`Btn` bit 10 — bits 10–30 are free, an input bit is rollback-safe by construction) | Ship value early; the schema (`itemId`/`buffTicksLeft` fighter fields) is the same either way |
| Modes | PvE first (arcade + solo), wager LAST | Wager still gated on the P1 browser-vs-Node CI gate; PvE has no fairness debate |
| Wager fairness | **OPEN CARRY (user decision 2026-07-19)** — each player buys and uses items at their own discretion; NOT symmetric | Owner's call: item advantage is a paid, deliberate choice. Mitigation kept: the opponent's carried item shows on the VS card (informed stakes, same spirit as the fee line) |
| Pricing | ITEM_COST 5 CR / pull; tier odds 70/25/5 | First real credit SINK in the economy (faucets: daily +10, referral +25, payouts). Solo win nets +1 ⇒ paid buffs are negative-EV for credit farming by construction |
| One item per match | Yes (Phase 2 rule) | Keeps the pin one field; stacking is a later knob |
| Agent-class accounts | Excluded automatically | They hold 0 credits forever (0011); the shop additionally refuses `agent:` subs |

**ADR 0006 precedent note:** trained-agent config "can never touch damage,
health, meter" — items deliberately cross that line for the *owner's own
fighter*, paid in credits, pinned and verified server-side. Style knobs
remain untouchable; this is a separate, priced vocabulary.

## Phase 1 (this ADR's shipped scope)

- `@af/core/src/items.ts` — the item registry (pure data; no sim reads it
  yet, so **no ENGINE_VERSION bump and goldens stay green**).
- Migration `0013_items.sql` — `items` table (service-role only; RLS
  default-deny like `referrals`) + `buy_item` RPC: atomic debit + grant,
  **idempotent by client nonce** (`credit_ledger` reason `'gacha'`,
  `match_id` = nonce — same pattern as the daily grant's date key).
- `persist.ts` — `buyItem`/`listItems` on the `Persistence` interface, both
  implementations (the memory mirror charges/replays identically — money
  logic lives twice in lockstep, as always).
- Server HTTP: `GET /items` (catalog + inventory), `POST /items/buy`
  ({nonce}) — owner auth only (AIR JWT / dev header; **agent keys refused**
  so a leaked coach key can never drain credits into cans).
- Client: vending icon (title upper-right, canvas `tapZone` — works on
  mouse + touch), `'shop'` screen: machine, PULL, reveal animation,
  inventory shelf.

## Phases 2–4 (planned, not in this change)

2. **Pre-match consumable in arcade/solo**: `CQueue.item` → server validates
   ownership + marks consumed (idempotent by match id, refund on
   no-contest like fees) → pins both sides' effects into `SMatch` → core
   applies at spawn. New fighter fields join `FIGHTER_FIELDS`
   (serialize.test enforces completeness). ENGINE_VERSION bump; additive
   behavior keeps existing goldens green; add item goldens.
3. **In-match activation**: `Btn.Item = 1 << 10`; HUD slot at the meter gap
   (`ui.ts` HUD block); touch button; juice via `updateJuice` edge detect.
4. **Wager**: DECIDED (2026-07-19) — open carry at player discretion (not
   symmetric). Show the opponent's carried item on the VS stakes card.

## Studio follow-up

Item/can/machine art can be generated through the existing provider
abstraction (the Stage tab already proves non-character art works; no
identity lock needed → cheapest provider). The fighter-specific
normalize/QC stages do not apply — items need only bg-removal + palette.

**Art shipped 2026-07-19:** user-authored vending-machine art —
`assets/vending machine.svg` (source; embeds a raster + alpha matte) →
composited/matted to `packages/client/assets/shop/vending-machine.png`,
loaded via `chrome.ts loadVendingArt()` and drawn by both the title icon
and the shop screen (procedural machine remains the loading/offline
fallback). Can art stays ORIGINAL procedural canvas: slanted silver/tier
two-tone + bolt — an energy-drink homage. A real-brand can photo (Red
Bull) was provided as reference; actual trade dress is deliberately NOT
shipped (trademark exposure in a credits game) — swap in Studio-generated
original cans later if wanted.
