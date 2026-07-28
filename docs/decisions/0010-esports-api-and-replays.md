# 0010 — The esports data layer: an open results API, and the ledger that makes replays possible

Status: ACCEPTED — the READ API is IMPLEMENTED + DEPLOYED (2026-07-28,
`agent-fighter-web` commit e107c86). Ledger persistence (Phase 0 below) is
ACCEPTED and being built. Replays are DESIGNED, NOT BUILT.
Date: 2026-07-28
Relates to: [0003](0003-online-architecture-agents-first.md) (input authority —
this ADR is downstream of it), [0005](0005-disconnect-settlement.md) (the
settlement ladder this publishes), [0009](0009-house-agents-and-tickets.md)
(seasons and Elo, which the API reads rather than reinvents)

## The feature in one line

Publish every verified match result — free, open and unauthenticated — so
third-party developers, prediction markets, sportsbetting platforms and esports
organisers can consume Agent Fighter's outcomes, and store the input ledger so
those matches can later be *replayed* rather than merely reported.

## The insight this ADR turns on

**Agent Fighter was already an esports-grade system and did not know it.**

Since ADR 0003 the server has settled every ranked match by re-simulating the
complete input ledger from tick 0 on a deterministic engine and deriving the
winner itself. Nobody's client is trusted. That means a published result is not
a scoreboard someone typed in — it is the output of a computation any party can
reproduce, pinned by `state_hash` and `engine`.

Three products fall out of that one fact:

| Product | What it needs | Status |
|---|---|---|
| Verified results feed | nothing new — the data already exists | **shipped** |
| Deep per-match stats | somewhere to re-walk the match from | needs the ledger |
| Replays | the ledger + a codec + a viewer | needs the ledger |

And all three block on the same single gap: **`Match.inputs` is memory-only and
is destroyed the moment a match settles** (`liveMatches.delete(m.id)` in
`finishMatch`). The ledger — the most valuable artefact the server produces —
is currently thrown away microseconds after it has been used to decide money.

Persisting it is therefore the keystone of this whole layer, and it is a
remarkably small change: no `@af/core` edit, no `ENGINE_VERSION` bump, no
protocol bump, no golden re-bless.

## Decision 1 — the read API lives on the marketing site, not the match server

The match server is a single-threaded Node process whose event loop is the hot
path for live fights, and whose settlement re-simulation already blocks it
(the v1.02_scale DoS fix exists precisely because verification was too slow).
Attaching a crawlable, pollable, publicly-advertised read API to it would put
third-party traffic in the same event loop as people's matches.

So the public API is served by the **landing site** (Next.js on Vercel),
reading Supabase directly. This buys CDN caching in front of the database,
which is not an optimisation but the thing that keeps the whole feed inside the
Supabase free tier.

The split is by *nature*, not convenience:

- **Historical** (results, profiles, standings, aggregates) → Supabase via Vercel.
- **Live** (queue depth, matches in progress) → the match server, because it is
  the only thing that knows.

### Do not re-litigate

Moving these endpoints "closer to the data" by hosting them on the match server
would reintroduce a DoS surface we already paid to close.

## Decision 2 — THE SETTLEMENT CONTRACT

This is the part that money settles against, and the only part of the API that
is genuinely hard. Internal outcomes map onto exactly three market-meaningful
states, and nothing may invent a fourth:

- `final` — the result can never change. Safe to settle.
- `void` — no contest. Refund.
- `provisional` — not yet re-simulated. **Never settle on this.**

| reason | winner | desync | → outcome | method | settlement |
|---|---|---|---|---|---|
| verified | 0/1 | — | decided | `ko_or_timeout` | final |
| verified | 0/1 | convicted | decided | `desync_forfeit` | final |
| verified | 2 | — | draw | `draw` | final |
| forfeit | 0/1 | — | decided | `forfeit` | final |
| incomplete | −1 | — | no_contest | `no_contest` | void |

Three consequences worth stating explicitly:

1. **`outcome` and `settlement` are CLOSED enums; `method` is OPEN.** The
   database does not yet distinguish a KO from a timeout, nor a pace anomaly
   from a both-sides disconnect — the re-simulation knows both, but only the
   collapsed `reason` is stored. So the API reports `ko_or_timeout` rather than
   guessing, and consumers are told in writing not to switch exhaustively on
   `method`. Splitting those is a settlement-side change; when it lands, new
   rows gain finer methods and no consumer breaks.
2. **A forfeit is `decided` + `final`.** Leaving a wager loses it (ADR 0005) —
   that is the deterrent the whole disconnect ladder rests on. Many books void
   forfeits under their own house rules, which is exactly why `method` is
   published *separately* from `outcome`: we state what happened, they choose
   what to pay.
3. **`provisional` exists even though nothing serves it today.** It is reserved
   so that a future live feed can never be mistaken for a settled one. A market
   that settles on mid-match state will eventually settle wrong, because the
   server is only authoritative at settlement and a desync conviction can flip a
   winner after the fact.

## Decision 3 — the public API runs on the ANON key, never the service key

The service-role key bypasses RLS. On an open, crawlable, unauthenticated feed
that would make our hand-written column projections the *only* thing between a
query bug and a dump of wallet addresses, coach-key hashes and agent ownership.

On the anon key, RLS stays a second line of defence and a mistake in our code
degrades to "returns nothing" instead of "returns everything".

Corollaries, both load-bearing:

- **Nothing may `select=*` on `profiles`.** RLS permits reading whole rows, so
  column safety is still ours to enforce. The allowlist is `PROFILE_PUBLIC_COLUMNS`.
- **AIR subjects never leave the service.** The public identity is `ref_code`,
  which already rides share links. `address`, `agent_key_hash` and `owner_sub`
  are permanently excluded.

(Found while implementing: production had *no* anon key configured and the whole
site was running on the service key. That is now fixed for every page, not just
the API.)

## Decision 4 — Phase 0: persist the input ledger

**Store the ledger at settlement, for PvP only.**

### What is stored

`match_ledgers`, one row per settled match:

- the **pin** — everything needed to reconstruct the match deterministically:
  seed, bounds, characters + bundle hashes, input delay, item loadouts, and the
  solo AI pin where relevant;
- the **two input tracks**, RLE + varint encoded (`@af/core/src/replay.ts`);
- `engine`, `protocol`, `codec_version`;
- a **canonical sha256** over the whole record.

### Which matches

**Wager (PvP) and future tournament matches only. Not arcade, not solo.**

This is the owner's call and it is also the one that makes storage a
non-problem. Arcade is 94.6% of all matches (768 of 812 measured) and is
single-player against a pinned AI — the least watchable material in the game.
PvP is ~4 matches/day today, ~6 KB each: **under 10 MB/year.** Storing
everything would be ~170 MB/year now and multiples of that under any growth
worth having.

Solo/arcade ledgers may later be stored *on explicit player request* ("save this
replay"), which is self-limiting by construction.

### Where the codec lives — `@af/core`, not a separate package

The obvious home for a replay codec is its own package. It went into
`@af/core/src/replay.ts` instead, for one decisive reason: **anyone who can
replay a match already needs the engine**, so a separate package would mean
importing two things to do one job — and the format is a serialisation of
`InputFrame`, which core already defines.

It is data-only. The sim never reads it, so it does not move
`ENGINE_VERSION` and the golden replays are untouched — the same argument that
let `items.ts` land in core (ADR 0007).

Consequences of that placement, all deliberate:

- **No `Buffer`, no `btoa`, no `globalThis`.** Core's determinism guards forbid
  them and, more practically, the codec must emit byte-identical output in Node
  and in a browser. Base64url is therefore hand-rolled rather than delegated to
  whichever runtime we happen to be standing on.
- **Holes decode as `0`.** A ledger array can be sparse if a tick never
  arrived, and the server's verifier reads it as `inputs[t]! | 0` — a missing
  input *is* neutral input. The codec agrees with the authority that decided
  the match, rather than preserving sparseness nobody can act on.
- **`codec_version` is separate from `engine`.** They answer different
  questions: codec says "can these bytes be parsed", engine says "will
  replaying them reproduce the recorded result". An old ledger stays readable
  long after it stops being reproducible.

### Why the canonical hash matters now

It is one column, and it is the only thing that must exist *before* the fact to
keep on-chain provenance available later. A Merkle tree over per-match hashes,
anchored once per epoch, gives per-match inclusion proofs at near-zero marginal
cost — and can be applied **retroactively over all history**, but only if the
hashes were computed from bytes we still have. Without the column, that option
closes permanently.

**Per-match on-chain minting is explicitly rejected**: it is a cost and
throughput mistake for a feed that settles thousands of rows.

**The digest must be hashed over CANONICAL json (sorted keys), not
`JSON.stringify`.** Learned immediately, on the first real production match:
the pin is stored as Postgres `jsonb`, which does not preserve key order, so
hashing our insertion order produced a digest that *nobody reading the row back
could reproduce* — destroying the one property the field exists for. A digest
must be a function of the DATA, not of the code path that happened to
serialise it. `canonicalJson` in `@af/core/src/replay.ts`; regression-tested
against a simulated jsonb round-trip.

### Verifying it — `tools/replay-verify.mts`

The whole layer rests on one claim, so there is a tool that checks it against
production rather than a fixture: recompute the digest, confirm the character
bundles are still the ones the match was fought with, decode, replay, and
compare winner / rounds / endTick / `stateHash` to what was recorded.

It also encodes a distinction that matters commercially: **a forfeit's winner
is not in the ledger and must not be expected there.** The disconnect ladder
awards it (ADR 0005); the ledger reproduces only the ticks that were actually
played. That is the same thing the public API publishes as
`resolution.verified` — true only when the outcome came out of a full
re-simulation. Demanding a derived winner from a forfeited ledger would be
asking the data to lie.

### What we are NOT doing yet

AIR credentials (ADR 0004's reputation write-back) are the right tool for
*player* attestations and already work. They are the **wrong** tool for
per-match provenance: subject-scoped, revocable by design, and not independently
verifiable by a third party without AIR's cooperation. Match provenance is
served instead by **signed settlement receipts** using the partner RS256 keypair
we already publish a JWKS for — near-zero work, verifiable offline, no chain
required.

## Decision 5 — deep stats are DERIVED, never client-reported

Damage, combos, meter usage, block ratios and the rest do not travel over the
wire and are never taken from a client. They are computed by re-walking the
match — and the verification pass **already walks every tick of every settled
match**, so an observer hung on that pass costs approximately nothing.

Two rules on that observer:

1. It reads state only through exported helpers (the renderer rule from
   `CLAUDE.md` applies — nothing reaches into sim internals).
2. It is wrapped so that an observer bug can never break settlement.
   **Settlement is money; statistics are not.**

The payoff of deriving rather than reporting: a stat invented next year can be
**backfilled across the entire archive** by re-running the deriver over stored
ledgers. That property is why this is worth doing properly once.

## Consequences

- `@af/core` is untouched. No new sim state, no input bits, no
  `ENGINE_VERSION` bump, goldens stay green.
- No protocol bump. The server already has everything it stores.
- Replays become a client-only feature once the ledger exists: a
  `ReplaySession` alongside `NetSession`/`SoloSession` (they already share a
  `Session` union), and **seek is already solved** by the 128-slot snapshot
  ring built for rollback.
- **Engine-version rot is the carried risk.** A ledger only reproduces on the
  engine that produced it, and `af-core-1 → af-core-7` happened in a fortnight.
  Replays must therefore publish `playable: true|false` against the current
  engine and refuse to lie; serving a stats-only "archived" view for old
  matches is the launch answer, and lazily loading versioned engine bundles is
  the stretch one.

## The honest limitation

The API is ready before the market is. There are **28 human-vs-human matches in
existence**, they are unscheduled (players are paired from an anonymous queue),
and so there are no pre-match fixtures to price. Post-hoc and in-play markets
are what this feed supports today. `GET /stats` publishes `by_mode` precisely so
an integrator discovers this from the data rather than from a sales conversation.

Fixtures need announced participants. The cheapest path to them is scheduled
challenges built on the friendly-room rendezvous that already exists — not a new
subsystem. The owner has deferred the agent-vs-agent ladder that would supply
continuous, modelable volume; when it arrives, this feed already describes it.

## Do not re-litigate

- The read API does not move onto the match server.
- The public feed does not use the service-role key.
- AIR subjects, wallet addresses and key hashes are not published, ever.
- Arcade ledgers are not stored by default.
- Match provenance is not minted per match on-chain.
