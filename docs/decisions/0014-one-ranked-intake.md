# 0014 — One ranked intake: the gauntlet, with both players signing

Status: ACCEPTED. The Agent Fighter side is implemented (2026-10-22). The
relay intake was retired outright on 2026-10-23; see "Update: the relay intake
is gone".
Date: 2026-10-22
Relates to: [0013](0013-mesh-hosting-gauntlet.md) (gauntlet mode, which this
makes the only ranked path), [0010](0010-esports-api-and-replays.md) (the
ledger archive the relay intake reads), litnode `docs/SETTLEMENT-STANDARD.md`
(settlement v4: proof levels, identity, placement)

## The decision in one line

A match counts as **ranked** on the mesh only if it was played on a node's
per-match gauntlet server (ADR 0013) and **both** placed players signed its
ledger. Every other route by which an Agent Fighter ledger reaches a node is
casual.

## Why

Settlement v4 has one pipeline with several entry points. Agent Fighter had
three of them, and two could produce a ranked result without the property
that makes a result official: that the players themselves signed the log.

1. **Relay + af-watch.**
   - The always-on relay (`packages/server/src/server.ts`) archives wager
     matches and `LIT-` friendlies into Supabase `match_ledgers`.
   - `af-watch` (litnode desktop checkout, `tools/af-watch.mjs`, launched by
     `run-af-watch.cmd`) polls that table every 5 s. It builds a submission
     (`tools/lib/af-submission.mjs`), relay-signs it, and POSTs `/ledger`.
   - It takes the mode from the placement descriptor when the node still
     holds it, so a placed ranked room played on the relay could settle
     ranked on the relay's word.
   - It writes `af:<name>` participants when the pin lacks two player keys.
     That is the only `af:` path anywhere.
2. **Gauntlet.**
   - A node spawns `gauntlet-server.ts` for one placed match. Seats are the
     placed keys, proven by the node's tickets.
   - Players sign `{ matchId, ticks, head, buildHash }` through the arcade's
     `cabinet:sign`, and the server POSTs the log to the node.
3. **Import.**
   - `af-import-ledger.mjs` (litnode desktop checkout) is run by hand. It
     reads `match_ledgers` with the Supabase service key and writes or POSTs
     the same submission with no relay signature.
   - It is for backfill and debugging. Unsigned, it settles at `host`.

Also: a relay is a single operator vouching for a log (`checkable` at best,
SETTLEMENT-STANDARD §5), and `hello.playerKey` on the relay is unverified. The
gauntlet has neither weakness.

## What changed here

- **The gauntlet refuses to post an unsigned ranked match.** `handOff` reports
  `{ posted: false, error: "ranked needs both players' ledger signatures" }`
  instead of sending something the node can only refuse. A ranked descriptor
  binds the mode, so the log cannot settle casual either. Test:
  `gauntlet.test.ts`.
- **Every archived pin names its intake.** `pin.intake` is `'gauntlet'` or
  `'relay'`. A consumer (af-watch, import, a witness reading the hydration)
  can tell a relay ledger apart without guessing from the room name.
- **The client is told the truth.** `SMatch.placed = { intake, mode }` for
  `LIT-` rooms: `gauntlet` carries the placement's mode; `relay` is always
  `casual`. The client labels from it (ADR 0014 §identity, goal 4).
- **No AIR in a gauntlet.** litnode passes the operator's environment to the
  child (minus `OPERATOR_SECRETS`). An `AIR_*` set on that machine no longer
  turns a placed match into a credential issuer.
- **The server ships as a litnode server bundle.**
  - litnode's `tools/bundle-server.mjs` and
    `gauntlets/agent-fighter.server.json` pack it.
  - `server-bundle.test.ts` builds the same layout with the same esbuild
    options and checks:
    - two builds are byte-identical;
    - only Node builtins remain as imports;
    - it runs from a bare directory with a scrubbed environment;
    - it plays a signed ranked match to a fake node and exits 0.

## Retirement plan for the relay intake

| Step | When | Who |
| --- | --- | --- |
| 1. af-watch submits relay ledgers as **unplaced casual**, under the relay's own match id, never the mesh id: a `casual` body against a `ranked` descriptor is refused outright. It skips `pin.intake === 'gauntlet'` rows (the gauntlet already settled them) | now | litnode (af-watch) |
| 2. The client labels a relay-hosted `LIT-` room **CASUAL** and never shows RANKED for it | now (this repo, goal 4) | AF |
| 3. Publish the gauntlet server bundle under the title (`npm run bundle:server`, `publish:title set-build`) and serve it from the publisher's node | after this lands | user |
| 4. Run the gauntlet on **two or more operators** (`GAUNTLET_SERVERS=agent-fighter.v1`) | ops | operators |
| 5. With ≥2 gauntlet operators: the relay stops archiving `LIT-` rooms (`meshPlaced` → false), the placed-room relay fallback in the client is removed (a failed seat claim says "no host available" instead), af-watch is retired | after step 4 holds for a week | AF + litnode |
| 6. `af-import-ledger.mjs` stays for backfill and forensics, casual-only, labelled as such in its output | permanent | litnode |

Wager matches keep archiving to `match_ledgers` for replays (ADR 0010). They
are the publisher's off-chain economy and never go to the mesh as ranked.

## Update: the relay intake is gone (2026-10-23)

Step 5 ran early, and step 6 was dropped. The precondition (two or more
gauntlet operators) protected availability, but the relay and the only
gauntlet host are the same desktop behind the same tunnel. When one is down,
so is the other. The fallback added no uptime; it only turned failed ranked
matches into silent casual ones.

- **Relay:** it turns away `LIT-` rooms ("launch it again from the arcade") and
  archives only wagers, with no mesh keys or signatures in the pin. Test:
  `identity.test.ts`.
- **Client:** a failed seat claim says "no seat on the host, launch the match
  again from the arcade". It never falls back to the relay.
- **litnode:** `af-watch`, `af-import-ledger`, `af-submission` and the bridge's
  Agent Fighter adapter are removed, and so is the `litnode-watch` task.
  Relay matches stay in Agent Fighter's own database. The gauntlet, in bundle
  mode, is the only way an Agent Fighter match reaches the mesh.

## Do not re-litigate

Do not add a "relay-signed ranked" path back for convenience when the
gauntlet is unavailable. A placement that cannot find a gauntlet host is a
match that does not happen ranked. That is the price of results that count.
