# 0008 — Agent Arcade v2: the gauntlet map (extraction roguelite)

Status: ACCEPTED — IMPLEMENTED + DEPLOYED (design locked with the owner
2026-07-26; built, migrated and shipped the same day. Protocol v7,
`ENGINE_VERSION` unchanged at af-core-7.)
Date: 2026-07-26
Supersedes: the linear ladder half of the AGENT ARCADE design (protocol v4)

## The feature in one line

Entering Agent Arcade generates a **32 × 32 board**; the player picks a route
through it after every match, choosing between **reaching an exit in as few
fights as possible** and **detouring through guarded credit piles and energy
drinks** — and banks nothing at all unless they reach an exit alive.

## Why this exists

The current arcade is a fixed ladder: fight every enabled character in a
shuffled order until you lose. Progression is a counter. There is exactly one
decision in a run (enter or don't) and it is made before the run starts.

The map turns every results screen into a decision with a number attached.

## The genre we are actually building

This is an **extraction roguelite** (Tarkov / Dark and Darker), not an arcade
ladder. Naming it matters, because it forces one consequence:

> Today **fighting is how you earn** (+1 CR per win). The new design says
> **fighting is the cost and the board is the earning.** Those cannot both be
> true. If wins still paid credits, the optimal line would remain "clear the
> board" and the map would be decoration.

So: **wins pay XP, the board pays credits.** That is the pivot this ADR turns
on. Everything else is consequence.

## The one architectural insight (why this is cheap)

**`@af/core` is not touched.** No new sim state, no new input bits, no
`ENGINE_VERSION` bump, goldens stay green.

- Matches remain independent best-of-3 bouts. **No HP carries between
  fights.** Attrition is not modelled in the sim — the pressure comes from
  each fight being an independent chance to lose the *whole* bag. That is
  mathematically sufficient for "fewer fights is better" and costs zero
  determinism risk.
- The board is **server-side data in `ArcadeRun`**, generated from a seed.
  The client renders it; the client never decides anything about it.
- Drinks already work: 3 equip slots, `Btn.Item/Item2/Item3`, server reads the
  loadout at queue time, `VerifyOutcome.spent` consumes only what was drunk
  (ADR 0007). Board-found drinks reuse all of it.

The entire feature is **server run-state + one new client screen**.

## Board model: spine + spurs

The board is a **directed acyclic graph laid out on a 32 × 32 lattice**. One
way only — you never backtrack. Two kinds of edge:

- **SPINE** — the mandatory line. Region gatekeepers and exit guards. Walking
  the pure spine to the deep exit is 7 fights and *zero* loot.
- **SPUR** — a side loop carrying one pickup, with **one extra fighter
  standing in front of it**, rejoining the spine afterwards.

**Every pickup costs exactly one more fight.** That single rule is the whole
game, it is explainable in one sentence, and it closes the hole that killed
the first two layouts we tried:

> *Rejected:* loot as free lateral nodes. With no step budget, lateral loot is
> free and you take all of it — greed vs speed collapses.
> *Rejected:* loot behind every branch. Then route choice never changes the
> fight count and only exit depth matters.

Three regions, three exits:

| Region | Zone | AI skill | Exit | Min fights | Base bonus |
| --- | --- | --- | --- | --- | --- |
| R1 | SCRAPYARD ROW | 35–50 | EXIT 1 | 2 | +2 CR |
| R2 | THE STACKS | 50–70 | EXIT 2 | 4 | +8 CR |
| R3 | THE CORE | 70–95 | EXIT 3 | 7 (incl. boss) | +18 CR |

**Skill ramps by region depth, not by fight count.** Otherwise a long, safe,
low-tier detour would be free money.

## Decisions locked with the owner (2026-07-26)

| Question | Decision | Rationale |
| --- | --- | --- |
| Traversal | **Branch choice at junctions.** Board drawn on the 32×32 lattice; you sit on a node and pick one of 2–4 outgoing routes after each match | One tap, mobile-safe, trivially validated server-side as a legal edge. Free tile-by-tile movement needs pan/zoom and a fuel system to have stakes |
| Exits | **Three, tiered by depth** | The map itself becomes the greed decision, every run. A single all-or-nothing exit has no mid-run tension |
| Rewards | **Board pays credits; fights pay XP only (+60 / −15, existing ladder).** The +1 CR per win is REMOVED | Makes "fight as few as possible, extract as much as possible" literally the winning strategy. XP keeps levelling and the leaderboards fed |
| Information | **Whole board revealed at run start** | It is a puzzle with a shortest path, as specified. All variance lives in combat, where it already is |
| Run length | **2 / 4 / 7 fights** (≈6 / 12 / 22 min) | Even the deep line fits one sitting; roughly halves today's 12-battle commitment. Matters on mobile, and matters given the iOS jetsam history |
| Payout targets | **3 / 12 / 30 CR** typical haul by exit | Deep run ≈ 6 shop pulls, ≈2× today's +14 full clear, gated behind 7 escalating fights. Arcade stays a faucet that funds the shop without printing |
| Board generation | **6–10 authored templates + seeded shuffle** of which fighter guards what and which spur holds which pickup | Every board is guaranteed solvable, readable and fair. Full procgen needs a validator and will ship unfun boards before tuning converges |
| Farm guard | **Diminishing returns per UTC day.** RETUNED after first live play (see below): the taper applies to **loot only**, counts **extractions** not entries, and runs 100/100/100/80/65/50 | Never hard-blocks play (a wall kills engagement) but caps a grinder. The first cut taxed the exit bonus and counted entries, which made a 10-fight deep clear pay 8 CR and taxed players for losing |
| Found drinks | **Usable mid-run AND bankable.** They land in a run bag; tap on the map screen to load one into an empty or already-drunk slot | The best decision in the mode: drink it to survive, or carry it out for value. Combat HUD stays at 3 slots |
| Route assist | **UI computes the math**: "FASTEST TO EXIT 2: 4 FIGHTS", each spur labelled "+6 CR · +1 FIGHT" | The board is revealed anyway; hiding arithmetic adds friction, not depth — especially on a 6-inch screen |
| Narrative | **Light flavor per region**: three named zones with a one-line intro, gatekeeper taunts reusing `meta.motto`, an extraction sting | Cheap, ships with v1, makes the board feel like a place. Chapters and a persistent rival are a separate project |
| Death | **Bag evaporates.** Entry gone, run token dies | Owner's rule and the genre's core. See mercy rules below |

## Rules that fall out (not separately negotiated)

- **Loot sits behind fights, always.** A zero-fight route to any exit would be
  a credit printer. Enforced structurally by the spine/spur model, and it must
  be a template-validation assertion, not a convention.
- **XP banks per win immediately; credits do not.** Losing an 8-fight run and
  walking away with literally nothing would be intolerable. The −15 XP loss
  penalty is unchanged.
- **Quitting mid-run forfeits the bag**, identical to dying. ESC already ends
  the run; the quit-confirm modal copy must now say what the bag costs.
- **Undrunk *shop* drinks still return on death** (existing `settleItems`
  behaviour). Board-found drinks do not — they were never yours.
- **Guests get the same board** in `startArcadePractice`, reward-free. It is
  the best demo surface we have.
- **Extracted drinks capped at 3 per UTC day.** A drink is worth 5 CR, so
  unscaled drinks would route around the diminishing-returns valve. Separate,
  auditable valve rather than a clever multiplier on an item.
- **Agent-class subs** (`agent:` sub, 0 credits forever, migration 0011) play
  the board for XP and rank only, as today.

## Server shape

`ArcadeRun` grows a board and a bag; `opponents[]` goes away (the opponent is
read off the node you move into):

```ts
interface ArcadeRun {
  token: string; sub: string; character: string;
  board: Board;                 // NEW — generated at /arcade/enter
  at: number;                   // NEW — current node id
  bag: { credits: number; drinks: ItemId[] };  // NEW — UNBANKED
  path: number[];               // NEW — audit trail
  battle: number; awaitingNext: boolean; paid: boolean; lastActive: number;
}
interface Board {
  templateId: string; seed: number;
  nodes: BoardNode[];           // {id, x, y, kind, charId?, region, loot?, exitTier?}
  edges: Array<[from: number, to: number]>;   // DIRECTED
}
```

New HTTP, matching the existing `/arcade/enter` pattern (owner auth):

- `POST /arcade/run { token, character? }` — with `character`, LOCKS the
  fighter and mints the board (which needs the roster minus the player's own
  fighter, so it cannot happen at `/arcade/enter`, which is before select).
  Without it, a plain read — which is also the RESUME path.
- `POST /arcade/extract { token, node }` — legal only when `node` is an exit
  ONE STEP from where the run stands. Applies the day's diminishing-returns
  multiplier, banks the bag, ends the run.

**There is no `/arcade/move`.** As built, *the move IS the queue*:
`CQueue { mode:'arcade', runToken, arcadeNode }` both chooses the route and
starts the match, and the queue handler is the move validator. This collapsed
a whole round trip and, with it, a class of bug — a dropped response between
"I moved" and "I fought" cannot desync a position that only ever advances on
a verified win.

Two consequences worth stating:

- **Auto-collect.** A guarded pickup's fighter has the pickup as its ONLY
  successor, so after winning there is no decision left. `advanceRun` walks
  single-successor loot nodes and banks them into the bag. A manual "collect"
  step could only ever fail.
- **Autopilot.** `CQueue.arcadeNode` is optional; omitted, the server walks
  the cheapest line to the deep exit itself. That is the entire headless-agent
  integration — `npm run agent` / `npm run fleet` never learned to read a map,
  and being agent-class they bank nothing, so the loot they skip is nobody's
  money.

The server derives the opponent and the skill from the node being moved to,
never from a battle counter.

`SMatch.arcade` changes shape (`{battle,total,token}` → position + board on
first send) ⇒ **PROTOCOL_VERSION 6 → 7**, paired Railway + Vercel deploy.
`ENGINE_VERSION` unchanged.

Migration `0017_arcade_extract.sql`: `arcade_extract(_profile, _amount, _key)`,
idempotent by run token, reason `'arcade_extract'` — a reason the 0003 escrow
sweeper's ghost query does not match, same trick as 0015. The day's run count
for the DR multiplier reads off `credit_ledger` rows with reason `'arcade'`
(the entry debits) — no new counter table. Mirrored in `persist.ts`
`memoryPersistence`, as always: **money logic lives twice in lockstep.**

## Client shape

One new `'map'` Screen, entered after character select and after every results
interstitial. Renders the lattice, the revealed board, your position, route
labels, the run bag, and the drink-swap taps. Extraction is a button on an
exit node.

`af-arcade-run` localStorage + the RESUME pill survive unchanged — the board
lives server-side, so a jetsam kill mid-run resumes exactly where it died.

## What is explicitly NOT in v1

Traps, one-way doors, mid-run shops, run timers, HP carryover, board rerolls,
a persistent rival, authored chapter dialogue.

## Where the code lives

| Piece | File |
| --- | --- |
| Board types + route math (shared) | `packages/core/src/arcade-map.ts` |
| Templates, seeded generation, validation | `packages/core/src/arcade-board.ts` |
| Run state, `/arcade/run`, `/arcade/extract`, move validation | `packages/server/src/server.ts` |
| Extraction payout + DR + drink valve | `packages/server/src/persist.ts` (both impls) |
| Payout RPC | `supabase/migrations/0017_arcade_extract.sql` |
| Map + extraction screens | `packages/client/src/ui.ts` (`drawMap` / `drawExtract`) |
| Run flow, practice boards | `packages/client/src/main.ts` |
| Tests | `packages/server/test/arcade.test.ts` (11) |

The generator sits in `@af/core`, not the server, because the guest/offline
PRACTICE gauntlet generates boards locally — one generator, one set of
templates, no drift. `generateBoard` takes a REQUIRED seed so core keeps its
determinism guarantee (no ambient randomness); the server picks the seed.

## Resolved during implementation

- **Fighter repeats.** Shuffled roster assigned in node order, wrapping only
  if a template needs more fight nodes than the enabled roster provides.
- **Template validation is a test**, not a checklist: `validateBoard` asserts
  acyclicity, reachability, no dead ends, every exit at EXACTLY its fight
  floor, and every loot node's predecessors all being fight nodes. It runs on
  all 8 templates × 5 seeds in the suite, and `validateAllTemplates` runs at
  server boot — a drifted template refuses to start the server rather than
  quietly mis-pricing runs.
- **Two rejected board shapes** (both collapse the greed/speed tension, both
  documented in `arcade-board.ts` so they don't get re-tried): loot as free
  lateral nodes; a fighter on every branch.
- **Mid-chain loot rejoins the spine.** A 2-deep spur must let you bank the
  first pickup and bail, or "go one deeper?" is a trap, not a decision.
- **`ARCADE_NEXT_GRACE_MS` 5min → 30min.** Between fights the player now sits
  on a board they are meant to STUDY, with an unbanked bag riding on the
  answer. Five minutes was generous for tapping "next challenger" and hostile
  to someone weighing a 12-credit detour — and expiry would cost them a paid
  run AND the bag. Nothing is held hostage by a long window: an arcade run has
  no waiting opponent and no escrow to strand. The client's RESUME-pill
  freshness check moved to 25min to stay inside it.

## Shipped

- **Migration `0017` APPLIED to prod Supabase** (`arcade_extract_payout`,
  2026-07-26) and smoke-tested on real Postgres with a throwaway profile:
  the 100/75/50/25 taper off entry counts, floor-not-round (5 CR × 75% → 3),
  run-token replay paying nothing, `xtr:` drink counting that ignores normal
  shop pulls, and `service_role`-only ACL matching `debit_credits`. Smoke
  rows deleted. **The TS mirror cannot catch SQL bugs** — this project has
  already been burned once by `NULL = s` silently poisoning a settlement.
- **Paired Railway + Vercel deploy** (protocol 6 → 7). `ENGINE_VERSION`
  stayed af-core-7, so goldens needed no re-bless — but a v6 client still
  gets a clean "protocol 7 required" until the client half lands, which is
  exactly why the two must ship together.

## Day-one economy bug and retune (2026-07-26, migration 0018)

The mode shipped and the payout was wrong. A live player's first evening:
**8 entries, 3 extractions — including a 10-fight clear of the DEEP exit —
for a net of ZERO credits.** The arithmetic was correct; the design was not.
Three compounding mistakes, all in the diminishing-returns rule:

1. **The multiplier taxed the exit bonus.** DR exists to bound *farming the
   board*. Applying it to `loot + bonus` also taxed the guaranteed reward for
   surviving, so the deeper and braver the run, the harder it was hit. That is
   how a 10-fight deep clear (14 loot + 18 bonus) paid **8 CR**.
2. **It counted ENTRIES.** The intent was "dying must not reset the ladder";
   the effect was that dying and abandoning *burned* it — the player was taxed
   for losing. Five of that evening's eight entries never reached an exit.
3. **It bottomed out on the 4th run.** A run is 6–22 minutes, so one session
   pinned the account at 25% permanently.

Visible symptom, and the worst one: a legitimate 2-fight extraction paid
**0 CR** — floor-rounding `(0 loot + 2 bonus) × 25%` — which is strictly worse
than the `+1 CR`/win it replaced. The "reads as a nerf" risk, realised.

**The fix** (`0018_arcade_extract_loot_only.sql`, owner-approved):

| | Before | After |
| --- | --- | --- |
| Taper applies to | loot + exit bonus | **loot only** — the bonus is always paid whole |
| Ladder counts | runs entered | **extractions banked** (a wipe costs the bag, not the rate) |
| Ladder | 100 / 75 / 50 / 25 | **100 / 100 / 100 / 80 / 65 / 50** |
| Minimum | could floor to 0 | a successful extraction **never** pays zero |

Same two receipts under the new rule: the 2-fight shallow run pays **2 CR**
(was 0); the 10-fight deep clear pays **25 CR even at the worst rate** (was 8).

The lesson worth carrying: a taper meant to bound farming must never touch the
part of the reward that represents *achievement*, or it punishes exactly the
players you want. Locked by `PAYOUT SHAPE` and `DYING DOES NOT BURN THE LADDER`
in `arcade.test.ts`.

## Still open
- **`main.ts` accretion** was flagged in the 2026-07-18 audit and this added a
  screen to it. Worth extracting the arcade lane next time it fights back.
- **Opponent-seed rerolling on a no-contest.** A no-contest keeps the run, its
  position and its bag (deliberately — a network blip must not cost a loaded
  run), and the retry draws a fresh `aiSeed`. So a determined player can abort
  and re-roll until they like the opponent's RNG. This is pre-existing v1
  behaviour and skill is still pinned by region, but the bag makes retrying
  more attractive than it used to be. Watch it before tightening anything.

## Risks

- **Session length drops** (12 battles → 2–7). Fewer fights per session is the
  point, but it reduces match volume feeding the leaderboards and the agent
  fleet. Watch it.
- **Credit supply** is the live risk. The DR multiplier and the drink cap are
  both first guesses; instrument `credit_ledger` by reason from day one and
  expect to retune.
- **Removing +1 CR per win** is a visible takeaway for existing players. The
  extraction bonuses more than replace it for anyone who reaches an exit, but
  the messaging has to land or it reads as a nerf.
