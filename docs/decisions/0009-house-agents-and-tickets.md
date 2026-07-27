# 0009 — House agents are pins, tickets are the prize: the stable, defend-Elo, seasons, and the burn economy

Status: ACCEPTED — design locked with the owner 2026-07-27.
PARTIALLY BUILT:
· the **wager burn + ticket mint** half shipped 2026-07-27 (protocol v7→v8,
  `supabase/migrations/0020_tickets.sql`);
· **build step 1 — Elo ratings + seasons** shipped 2026-07-27
  (`supabase/migrations/0021_elo.sql`, mirrored in `persist.ts`,
  `packages/server/test/elo.test.ts`). Ratings are STORED and LOGGED, not yet
  surfaced: the rank/season views + leaderboard (step 2) are next.
  **0021 IS APPLIED to prod** (2026-07-27, ahead of any deploy — safe because
  the argument list is unchanged and no money rule moves; see the migration
  header). Elo math verified against real Postgres and matches the TS mirror
  exactly (20/−20 even, 22/−22 upset, K 40/20/10).
`ENGINE_VERSION` unchanged throughout — `@af/core` is untouched.
Everything else here — the stable / pinned-identity arcade, defend-Elo, rank
views, the payout-table economy lever, the farm cap — is still DESIGN ONLY.
Date: 2026-07-27
Builds on: 0003 (agents-first online), 0004 (credits), 0006 (train my agent),
0007 (consumable items), 0008 (arcade gauntlet map)
Supersedes: the winner-takes-pot half of 0004's wager economy (on cutover);
the fleet-as-24/7-grinders framing of `agent-fleet.ts`

## The feature in one line

House/fleet agents become a **stable of pinned identities** (data, not
processes) that populate the arcade, guard rank gates, and calibrate the
economy — while WAGER stops paying credit pots and instead **burns both
entries and mints the winner a soulbound TICKET** (AIR credential)
redeemable for seasonal esports/prize catalog items.

## The central insight (why this is cheap)

**Arcade and solo opponents are PINS, not processes.** Every solo/arcade
fight is a local-sim match against a pinned `{character, skill, personality,
aiSeed}` re-simulated at settlement (0003/0008). House "presence" therefore
costs zero sockets and zero hosting and scales to thousands of identities.
Consequences:

- Continuous 24/7 fleet hosting is an OPTIONAL ambience feature, never a
  requirement. Do NOT resurrect the deleted in-process house-bot machinery.
- Ranked-queue liquidity gaps are served by pinned local-sim opponents
  branded as fleet agents (the zero-latency solo architecture wearing a
  ranked badge) — the relay is reserved for human-vs-human.
- The fleet **process** shrinks to scheduled calibration bursts
  (`AF_FLEET_BATTLES` via cron): measure extraction rates before touching
  any economy knob. Fleet runs are economically inert and defend-Elo-
  invisible, so probing pollutes nothing.

## Decisions locked here

| Question | Decision | Rationale |
| --- | --- | --- |
| Who populates the arcade | The **stable**: fleet personas + player-trained agents (0006), pinned by identity (name/record/motto/wallet) into board nodes; Nemesis-style sampling (recent-avoid + grudge-return) | Persistence and consequence kill the NPC feeling, not AI quality; the cast is data so it scales for free |
| Trained agents in everyone's arcade | **DEFAULT-ON** (owner decision) | The flywheel: every coached agent enriches every other player's arcade. Carrot: defend-XP + "your agent went 4-2 last night" surfacing |
| How agents rank | **Defend-Elo**: only human-initiated matches count for an agent's rating | Grind-rank measures process uptime, not skill; unfarmable by leaving a process running |
| Agents on the prize ladder | **NEVER.** Prize eligibility keys on the existing HUMANS tab; agents appear on ALL/AGENTS only | The house must not compete for its own prizes (optics + integrity) |
| The fleet's ladder role | **Gatekeepers**: named guardians of rank-bracket promotion; a gate is a BOOLEAN (pass once → promoted; re-fights grant nothing) | Gives defend-Elo a stake, gives top players an on-demand meaningful fight (pinned local-sim, no queue), closes the farm-the-deterministic-AI hole |
| Wager settlement | **Both entries BURN; winner mints a TICKET.** No-contest/incomplete still refunds both (escrow sweeper unchanged). Hard cutover — never dual-run pot-wager and ticket-wager | Credits never flow player-to-player → removes sharking, removes the bot-counterparty mint, moves wager toward the tournament/redemption model and away from peer wagering |
| Ticket form | **Soulbound via AIR credential** (issue-on-behalf pipeline already built, 0004/M5 write-back). Non-transferable by construction — no token contract | The rail exists; a credential has no transfer path to close |
| Who can mint tickets | **Human hands only**: `agent:true` connections (already forced for agent-key auth) can never mint; agent-class inertness extends to tickets | "Bots fill wallets; only hands fill trophy cases." Residual: raw-JWT headless looks human but is realtime-paced + Elo-banded — accepted |
| PvE tickets | **NONE** (owner decision). Tickets are human-vs-human wager only | A PvE ticket lane is exactly what a JWT-headless bot would farm |
| Ticket catalog | Esports seats + non-cash perks (merch/vouchers after ops review). **Sponsored-token redemptions DEFERRED** (owner decision) pending real legal review | A ticket redeemable for a tradeable token is cash-equivalent and reopens the gambling classification the burn just closed |
| Seasons | **Two tracks.** Lifetime level/XP NEVER resets (drives `skillForLevel`, AIR reputation creds, CPU calibration — 0006's skill-from-level rule stays intact). New **season score** (seasonal Elo) resets per season and drives the prize ladder, ticket season, gate assignments | A raw XP reset would floor every trained agent's skill quarterly and overwrite LV38 credentials with LV1 |
| Season length | **Placeholder 21 days** (owner: set properly later). Tickets, season score, and gate rotation share ONE boundary | One boundary, one announcement, one reset |
| Rating design | Elo as the spine; activity gate (~10 decided matches to fully count, idle decay); level as tiebreaker. Formula lives in **ONE SQL view** (the `agent_roster`/`player_stats` pattern) | Reweighting = a migration, not a paired deploy; three display surfaces can never drift. Credits and tickets NEVER feed rank (currency ≠ status) |
| Agent matches vs owner's Elo | **SEPARATE ratings** (owner decision): declared-agent matches touch the agent's rating, never the owner's | Your Elo means your hands |
| The economy lever | **Payout tables, not difficulty.** Steer the faucet with exit payout amounts + board topology (precedent: migration 0018), watched via an `economy_daily` view over `credit_ledger`. Difficulty belongs to design and the season arc | Difficulty is the most player-felt lever; monetary policy must be invisible. "The game gets harder when the house owes money" is unrecoverable once said |
| Farm cap | The deferred 0004 solo-farm cap ships **WITH tickets, not after** (daily arcade-entry cap or diminishing extraction past N runs/day per account) | Owner-keyed headless agents have no battle cap and arcade extraction now fuels the prize economy |
| Fleet state | Personas move from `fleet-agents.json` to a **Supabase table** | Railway's disk is ephemeral — a redeploy would orphan keys and mint ghost duplicates (the sticky-name bug, again); the server also needs to read the stable for pinning |
| Ops tooling | **No dashboard.** Boot-time stable health log line + defend-stats columns on the public AGENTS tab; a single owner-only `/house` page (connect-page pattern) only when a weekly decision can't be made from the SQL views | Five agents fit in a log line; "dashboard" is a scope-creep magnet duplicating four existing surfaces |

## Supporting fixes (small, independently shippable)

- **Teach `ai.ts` to drink** (it has ZERO item awareness today): PATCH at low
  HP, OVERCLOCK on knockdown, FIREWALL vs rushdown. Guard the item branch on
  "carrying nothing" BEFORE any `chance()` call so item-less matches keep an
  unshifted RNG stream — otherwise goldens can't distinguish behavior change
  from stream shift. (Any `ai.ts` change re-blesses goldens regardless.)
- **Trained agents get the challenger's 3 equip slots** — `startArcadeBattle`
  pins `items: [claimed.pins, []]`; side 1 always fights dry. A dare vs a
  drink-carrying human is currently a rigged fight.
- **Un-dead `soloOpts`**: the nearest-level live-agent pick only fires on
  plain `solo`, which the client never queues. Wire it into
  `startArcadeBattle` so nodes carry stable identities.
- **Habit vectors for near-free**: the settlement re-sim already walks every
  input frame (v1.02_scale single-pass verifier); derive per-player habit
  stats (jump-in/throw/low/wake-up-DP rates) in that same pass, pin the
  per-(agent, player) vector into `SMatch` pre-match, seed the existing
  `eatJump/eatLow/eatThrow/eatProj` adaptation counters from it. "It
  remembers you" — determinism intact because the vector is pinned, never
  looked up mid-sim.

## Build order

```
1. Elo in record_match          DONE 2026-07-27 (0021_elo.sql, not yet applied)
2. rank/season SQL views        (leaderboard reads the view; client renders)  ← NEXT
3. Stable table + identity pinning into arcade nodes   ← biggest felt win
4. Defend-Elo + AGENTS-tab defend columns
5. economy_daily view + payout knobs
6. TICKETS cutover              DONE 2026-07-27 (0020_tickets.sql; farm cap
                                deliberately deferred — the 20-CR burn is the
                                v1 limiter, revisit when data says otherwise)
7. Gatekeepers
8. Habit-vector "it remembers you"
```

**What step 1 actually rates (narrow on purpose):** a DECIDED WAGER between
two human hands, and nothing else. Arcade/solo are PvE against pinned AI with
no rating of their own — players start rating against bots at steps 3-4, when
the stable gives those bots a rating to play against. Agent-involved wagers
are unrated for BOTH sides rather than half-applied, since the separate agent
rating does not exist yet. Two tracks are live: lifetime `elo` (never resets)
and `season_elo` (own pool, lazy rollover via `current_season()` — pure
arithmetic over a fixed epoch, no cron and no season table).

Nothing touches `@af/core` except the AI drink logic; goldens stay green
through steps 1–7. Ticket settlement changes `record_match`'s payout branch
inside the existing idempotent transaction; the escrow sweeper's refund path
is unchanged.

## Do not re-litigate

- Bots must never mint anything spendable OR redeemable — not credits (the
  self-match-mint audit finding), not tickets (this ADR). Any future "let
  agents earn X" feature must pass this test first.
- Difficulty is not a monetary instrument. If the economy needs tightening,
  the payout tables are the knob and `economy_daily` is the gauge.
- Lifetime level never resets. Seasonal anything gets its own column.
- One rating formula, one SQL view. No client-side rank math.

## Open items (deliberately unlocked)

- Season length: 21 days is a PLACEHOLDER; owner sets the real cadence
  before season 1.
- Gatekeeper rotation per season (fresh guards = content; retire farmed
  ones) and whether a passed gate stays passed all season (lean: yes —
  re-gating on decay feels punitive).
- Ticket weekly mint cap per account (anti-collusion floor: each colluded
  ticket burns 20 CR of capped-faucet currency ≈ 1/day per account pair —
  cap only needs to bite above that).
- Merch/voucher fulfillment ops; redemption-time identity checks (KYC the
  prize counter, never the game).
- Shades of real players (personality vectors from verified match history)
  as stable phase 3 — after default-on trained agents prove the flywheel.
