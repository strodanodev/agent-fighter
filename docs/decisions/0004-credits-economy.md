# ADR 0004 — The credits economy (M5): mandatory sign-in, daily grant, fees & pots

Status: accepted · 2026-07-17
Builds on: [0003 — online architecture, agents first](0003-online-architecture-agents-first.md)

## Decision

Play costs credits; credits and progression settle **only** on the server,
inside atomic idempotent Postgres functions. The client can render its
balance and nothing else.

| Rule | Value |
| --- | --- |
| Sign-in | **Required** to pass the title screen. The AIR account IS the wallet — there is nothing meaningful to do as a ghost. (`?dev=NAME` bypass exists for dev servers only.) |
| Daily login bonus | **+10 credits**, once per UTC day, granted on the first authenticated contact with the match server (`/me` or WS hello — whichever lands first). |
| VS AGENT (ranked solo) | Fee **1 credit** → escrowed at pair time. Win: 2 back (**net +1**) and +60 XP. **Loss: fee burned and −15 XP** (clamped at 0; never de-levels). Draw: refund, no XP. |
| ONLINE (wager) | Fee **10 credits each** → 20-credit pot. **Winner takes the pot** (net +10). XP win 60 / loss 20 / draw 30. Draw/undecided/incomplete: both refunded. |
| Deviator (hash-flagged cheat) | Forfeits the pot/award to the opponent **regardless of the sim outcome**, and books a loss. |
| Rage-quit | Already a forfeit (ADR 0003): the quitter is the loser, settlement follows. |
| Free play | 2P local and the offline VS AGENT fallback ("FREE PRACTICE") cost nothing and award nothing — no XP, no records. If it isn't server-verified, it doesn't pay. |

## Why VS AGENT had to move onto the server

The moment a PvE win pays credits, a client-reported PvE result is a mint.
So ranked solo is a real online match: the server pairs the player with a
**house bot** — an in-process `playOneMatch` agent (the same reference agent
skill everyone else uses) at a skill derived from the player's level — and
the input ledger + re-sim verification cover PvE exactly like PvP. House
bots queue with `soloFor:<clientId>` and are accepted **from loopback
only**; otherwise anyone could impersonate the house and throw ranked
matches to an accomplice. The house side plays with no identity: settlement
can never credit it and it never appears on leaderboards.

## Where the money logic lives

One set of rules, two implementations, kept in lockstep:

- `supabase/migrations/0002_credits.sql` — production. `get_account`
  (upsert + daily grant), `escrow_match` (all-or-none fee capture),
  `record_match` (settlement + XP, **idempotent by match-id insert**).
  Every mutation writes a `credit_ledger` row (append-only audit trail,
  unique `(profile, reason, match)` = retry safety). Service-role only;
  RLS public-read; clients have no write path at all.
- `packages/server/src/persist.ts` `memoryPersistence()` — the same
  semantics in TS for tests and keyless dev servers (flagged `dev: true`,
  which also unlocks name-keyed dev identities).

Escrow happens **at pair time** (before the match setup goes out), refunds
happen inside `record_match` for undecided outcomes — a crash between the
two leaves an escrowed match id that settles as `incomplete` → refund.

**Lesson (found by live smoke against real Postgres):** `_deviator` is
usually NULL and `NULL = s` is NULL in SQL — it silently poisoned every
settlement boolean until coalesced. The TS mirror couldn't catch it;
smoke-test SQL on the real database, always.

## AIR reputation write-back (built — activates on dashboard config)

After every settled ranked/wager match, the server re-issues an
"Agent Fighter Reputation" credential (level, xp, wins, losses, credits,
is_agent, engine) to the player's AIR account via the **Issue-on-Behalf
REST API** (`POST {AIR_API_URL}/credentials/issue-on-behalf`), authorized
by a Partner JWT we sign (RS256, 5-min expiry, recipient's email claim)
that AIR validates against our public JWKS.

- `tools/air-keygen.mjs` → `air/partner_rs256.pem` (secret, gitignored) +
  `air/jwks.json` (public, committed; served at `/.well-known/jwks.json`
  by both the match server and the Vercel deploy).
- `packages/server/src/air-issuer.ts` — JWT signer + issuance queue.
  Fire-and-forget (attestation must never touch settlement), per-profile
  60s cooldown with a trailing re-issue carrying the LATEST stats, and
  `onDuplicate: 'revoke'` — the credential is a snapshot, not a stack.
- Recipient email comes from the client hello and addresses delivery
  ONLY (progression keys on the verified token `sub`; AIR additionally
  asks the recipient for consent — a wrong email can't steal progression).
  Dev-economy identities (`dev:*`) are never written to AIR.

Activation checklist (dashboard, one-time): register the JWKS URL
(Account → General Settings), create an Issuer DID + a credential schema
matching `ReputationSubject` + an issuance program, then set
`AIR_ISSUER_DID` and `AIR_CREDENTIAL_ID` in `.env`. Until then the server
logs `[air] reputation write-back off` and Supabase remains the sole
system of record.

## Knobs deliberately left open

- Solo win pays net +1 (arcade "win a credit") — a high-skill grinder can
  farm the house; acceptable while credits have no cash-out. Revisit before
  credits become withdrawable (M6): cap daily solo profit, or scale house
  skill with the account's win-rate rather than level.
- Daily grant is flat +10 with no streaks/decay. Sybil pressure is real
  (one wallet per day per 10 credits) — Phase C should rate-limit accounts
  per verification tier before leaderboard prizes exist.
- Wager draws refund rather than splitting the pot; entrance fee is a
  constant, not a player-chosen stake. Stakes = M6, gated on legal review.
