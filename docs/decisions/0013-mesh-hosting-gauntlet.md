# 0013 — Mesh hosting: one match server per placed match, run by any litnode node

Status: ACCEPTED — gauntlet mode IMPLEMENTED (2026-10-05, `gauntlet.ts`,
`gauntlet-server.ts`); not yet deployed to any node. The always-on relay stays
until it is retired (litnode Title Hosting Standard, P4).
Date: 2026-10-05
Relates to: [0003](0003-online-architecture-agents-first.md) (input authority,
which this keeps), [0005](0005-disconnect-settlement.md) (the settlement ladder,
unchanged), [0010](0010-esports-api-and-replays.md) (the ledger, which is now
what the mesh settles)

## The decision in one line

When the LIT GAMES mesh places an Agent Fighter match, the host node runs this
repo's match server for that match alone, in **gauntlet mode**: no database, no
AIR, no publisher secret, the two placed keys only, the placement's seed, and the
signed input log handed to the node at the end.

## Why

On 27 Sep 2026 the desktop that ran the only relay went offline, and Agent
Fighter went with it. The mesh itself (pairing, placement, witnesses,
settlement) kept running; the game did not, because the match server needs
the Supabase service key and only the publisher's machines hold it. The goal
is that a game keeps working when its publisher is unavailable. A server
that holds no secret can run on any operator's node, so the publisher's
machines stop being special.

## What gauntlet mode is

- **Started by the node.** litnode `node/gauntlet.js` spawns
  `packages/server/src/gauntlet-server.ts` per placement it hosts, with its
  `GAUNTLET_*` environment, and ends it when the match settles or at its TTL.
- **No secrets.** `createMatchServer({ gauntlet })` skips `loadDotEnv` and
  forces `persistence: null`. Nothing in the checkout's `.env` is read.
- **Seats, not accounts.** A socket is admitted only with the node's seat
  ticket (HMAC over `{ sub, matchId, team, slot, exp }` with a per-match
  secret). The player is the ticket's key, never what `hello` claims. The
  client gets the ticket by signing the gateway's one-time challenge, through
  the arcade's `cabinet:sign-seat`. Side 0 is team 0.
- **The placement's seed.** `seed = first 32 bits of H(beacon, matchId)`: the
  seed every witness replays with. The relay's own LCG never runs.
- **One match.** After it starts, the server refuses every other queue.
- **The log is the match.** `result.ledger` covers exactly the ticks up to
  the final KO (`endTick`), so the head both players sign and the node replays
  is what was fought. The client sends its own record of that log with
  `cabinet:sign`, and the arcade computes the head itself before signing.
- **The node settles it.** The server waits up to 20 s for both
  signatures, then POSTs `{ matchId, entries, signatures, hydration: { pin,
  bundles } }` to the node's `/ledger` and exits.

## Consequences

- A gauntlet match credits nothing in Supabase: no XP, Elo, credits or
  items. Progression for mesh matches comes from the chain's settled results
  (MVP milestone M2), not from this server.
- The client skips AIR sign-in for a seated placed match (`meshSeated()`)
  and sends no AIR token to a gauntlet.
- A host that only fronts the relay has no seat to claim: the gateway
  answers 404, or the relay answers its own `/health`. The client then plays
  the placed room on the relay, as before.
- `AF_NO_PACE_CHECK=1` is honoured in gauntlet mode, set only by the node's
  config (an end-to-end test). The pace checks protect an economy, and a
  gauntlet has none.

## Do not re-litigate

Do not give the gauntlet a database "just for XP". The point is that it holds
nothing a stranger's node must not hold. Progression belongs to the mesh's
settled results.
