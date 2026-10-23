# Agent Fighter → LITNODE: settlement v4 hand-back

Written 2026-10-22 against `strodanodev/litnode` master `84c6fb0` (v0.12.0 RC,
protocol 4). Its `docs/SETTLEMENT-STANDARD.md` is the canonical contract and
wins over the prompt text. (The serverless M4 commit `d7a4478` the prompt cites
is on litnode master, not in this repo.)

**Status: all five goals are implemented and `npm run verify` is green** (core
150/150, server 157/157, typecheck, and `check-contracts`). Nothing is pushed,
deployed, registered or sent on-chain.

Local commits, one per goal:

| # | Commit | Goal |
| --- | --- | --- |
| 1 | `core: af-core-9 — integer match stats in GameState, match pins per state` | 1 + 2 |
| 2 | `server: the gauntlet is the only ranked intake; ships as a litnode server bundle` | 3 |
| 3 | `arcade identity: a relay records a player key only once it signed the log` | 4 |
| 4 | `client: contract set only from the arcade; proof level and links in results and history` | 5 |
| 5 | `docs: settlement v4 hand-back for all five goals` | — |

---

## 1. Stats: names and ops (goal 1)

| name | op | meaning |
| --- | --- | --- |
| `kos` | sum | rounds won by KO |
| `roundsWon` | sum | rounds won (a drawn round counts for both, as in scoring) |
| `perfectRounds` | sum | rounds won outright without taking any damage |
| `damageDealt` | sum | health actually removed from the opponent: hits, chip and throws (no overkill) |
| `maxCombo` | max | longest combo landed, in hits |
| `supersLanded` | sum | supers that landed at least one clean hit, counted once per super |
| `throwTechs` | sum | throws escaped with a tech |
| `fastestKo` | min | fewest round-clock ticks (60/s) to a KO; **omitted** when the side never KO'd, so `min` skips it |

`parries` was dropped: the engine has no parry mechanic. All values are
non-negative integers. No name shadows `matches`, `wins` or `ticks`, and every
name matches `[a-zA-Z][a-zA-Z0-9]{0,31}`.

## 2. Engine fields that hold them

These are appended to `FighterState` (`packages/core/src/state.ts`
`STAT_FIELDS`), at the end of `FIGHTER_FIELDS`, so they are in `serialize()`
and `stateHash()`:

- `stKos`, `stPerfects`, `stDamage`, `stMaxCombo`, `stSupers`, `stTechs`,
  `stFastestKo`
- `stTouched`: a per-round "took damage" flag for the perfect check

`roundsWon` reads the existing `GameState.roundsWon0/1`. The names, ops and
field mapping live in core (`packages/core/src/stats.ts`: `STATS_SCHEMA`, and
`matchStats(state) → [line0, line1]`), so a stat cannot drift from its counter.

**The stats are pure observers.** `test/stats.test.ts` proves it two ways:

- It scrambles every stat field on every tick and checks that the rest of the
  state never changes.
- `legacyStateHash()` (the state hashed without the stat fields) reproduces all
  six committed af-core-8 golden final and per-tick trace hashes.

The golden hashes moved only because the layout grew, and they were
re-blessed.

## 3. Adapter patch for `titles/agent-fighter.adapter.js`

```diff
-export const exclusive = true;
+// af-core-9: the engine's match pins live on GameState (createGameState pins),
+// so a process may replay any number of matches; `exclusive` is gone.
@@ services
-    stats: { track: ['matches', 'wins', 'ticks'] },
+    stats: { track: ['matches', 'wins', 'ticks'], schema: core.STATS_SCHEMA },
@@ init: replace the three process-global pins + createGameState with
-    core.setCharacters(core.loadCharacter(sides[0].bundle), core.loadCharacter(sides[1].bundle));
-    core.setMatchPets(sides[0].aura, sides[1].aura);
-    core.setMatchItems(sides[0].items, sides[1].items);
-
-    const state = core.createGameState(seedInt, bounds);
+    const state = core.createGameState(seedInt, bounds, {
+      chars: [core.loadCharacter(sides[0].bundle), core.loadCharacter(sides[1].bundle)],
+      items: [sides[0].items, sides[1].items],
+      pets: [sides[0].aura, sides[1].aura],
+    });
@@ after scores()
+  /** Settlement v4: per-match stats from the final state's integer counters
+   *  (serialized, so every witness recomputes them bit-exactly). */
+  stats(s) {
+    const [a, b] = s.pins.participants;
+    const [la, lb] = core.matchStats(s);
+    return { [a]: la, [b]: lb };
+  },
```

Also delete the `LIMIT (stated, not hidden)` paragraph in the header comment.

`GameState.chars` is **non-enumerable**, so `view: core.snapshot(s)`, JSON and
`canonical()` see exactly what they saw before, and no bundle leaks into a view.

An existing bug in the adapter: `export const exclusive = true` was never
passed to `defineTitle`, so the manifest always said `exclusive: false`. It did
no harm, because nothing in `node/` reads `exclusive` and `node/sandbox-child.mjs`
already gives every job a fresh vm context.

## 4. New engine version and rebuilding the bundle

- `ENGINE_VERSION` goes from `af-core-8` to **`af-core-9`**.
  - It is a consensus change: new bundle, new buildHash, re-register.
  - Old results are never relabelled.
  - `rulesetId` stays `agent-fighter.v1`.
- Rebuild, in litnode with this repo at commit 1 or later:
  1. `npm run bundle:af`
  2. `npm run conformance`
  3. `npm run publish:title -- set-build rulesets/agent-fighter.v1.js` (a user step: TitleRegistry tx)
- The AF relay checks `hello.engine`, so the client and server deploy
  together.
- Replays and ledgers archived on af-core-8 still verify. `replay-player.ts`
  accepts `legacyStateHash`, and `tools/replay-verify.mts` uses it when
  `row.engine === 'af-core-8'`.

## 5. Pins moved into state (goal 2): yes

- `createGameState(seed, bounds?, pins?)` takes `{ chars, items, pets }`.
  - Characters stay on the state as the non-serialized `GameState.chars`
    (agreed by bundle hash at setup, as before).
  - Drinks and auras are copied into numeric fighter fields at spawn.
- `step`, `resetRound`, the AI, `debugBoxes` and `debugInfo` read
  `charsOf(state)`, never a global.
- `setCharacters` / `setMatchItems` / `setMatchPets` remain only as defaults
  for a caller that passes no pins.
- These now pass pins: server `verifyAndScan` and `agent-session`, client
  `net.ts` and `replay-player.ts`, and `tools/replay-verify.mts`. The last was
  missing pets; it now includes them.
- Tested: two matches with different characters, drinks and auras, stepped
  interleaved in one process, each hash identically to running alone.

**LITNODE can drop `exclusive`.**

## 6. One intake and the relay retirement plan (goal 3)

Full text: [ADR 0014](decisions/0014-one-ranked-intake.md).

**The three intakes today:**

1. **Relay + af-watch.**
   - The relay archives wager matches and `LIT-` friendlies to Supabase
     `match_ledgers`.
   - `LITNODE-DESKTOP/tools/af-watch.mjs` polls the table every 5 s,
     relay-signs, and POSTs `/ledger`.
   - It can settle ranked when the node still holds the descriptor.
   - It builds `af:<name>` participants when the pin lacks two keys
     (`tools/lib/af-submission.mjs:46`, the only `af:` path anywhere).
2. **Gauntlet** (`packages/server/src/gauntlet-server.ts`): seat keys from the
   node's HMAC tickets, players sign, one match per process.
3. **Import** (`af-import-ledger.mjs`): manual backfill and debugging from
   `match_ledgers` with no relay signature. It settles `host`, or ranked only
   if placed and signed.

**What changed here:**

- The gauntlet **refuses to post a ranked match without both players'
  signatures**. It reports `{ posted: false, error: "ranked needs both
  players' ledger signatures (n/2 signed); not submitted" }`.
- Every archived pin carries `intake: 'gauntlet' | 'relay'`.
- `SMatch.placed = { intake, mode }` tells the client the truth. A
  relay-hosted `LIT-` room is always `casual`.
- A gauntlet never turns on AIR, even if the operator's environment has
  `AIR_*`. litnode passes its env through, minus `OPERATOR_SECRETS`.
- **Server bundle.** litnode's `tools/bundle-server.mjs` with
  `gauntlets/agent-fighter.server.json` packs this server. The new
  `packages/server/test/server-bundle.test.ts` builds the identical layout
  with identical esbuild options and checks:
  - two builds are byte-identical;
  - only Node builtins remain as imports;
  - it runs from a bare temp dir with **no node_modules** and a scrubbed
    environment;
  - it plays a signed ranked match to a fake node, posts it, and exits 0.

**Retirement plan:**

1. **Now — af-watch (litnode).**
   - Submit relay rows as unplaced casual, under the relay's own match id.
   - Omit player signatures for them. They were made over the mesh id, so
     under the relay id `verifyLedger` would refuse the whole submission.
   - Skip `pin.intake === 'gauntlet'` rows.
   - Use only `pin.playerKeys` as participants (now proven keys, §7), else
     `af:<name>`.
2. **Now — client (done):** a relay-hosted placed room is labelled CASUAL.
3. **User:** publish the server bundle and serve it from the publisher's node.
4. **Ops:** run the gauntlet on **≥ 2 operators**
   (`GAUNTLET_SERVERS=agent-fighter.v1`).
5. **After step 4 holds for a week:**
   - The relay stops archiving `LIT-` rooms.
   - The client drops its relay fallback for placed rooms ("no host
     available").
   - Retire af-watch.
6. **Permanent:** import stays for backfill, casual-only.

## 7. Arcade identity everywhere (goal 4)

The arcade passes `?player=` only for placed matches (`cabinet/app.js play()`),
so "every mode the arcade launches" means placed rooms: gauntlet and relay
fallback.

- **Gauntlet:** the participant is the seat key, proven at the door by the
  node's seat ticket over the arcade's `cabinet:sign-seat`. This was already
  true.
- **Relay:** `hello.playerKey` is only a claim. The relay now records a key in
  the archived pin (`playerKeys`, `signatures`) **only after verifying that
  key's ed25519 ledger signature** (`mesh-ledger.ts verifyLedgerSig`).
  - The check is over `ledger NUL canonical({ matchId, ticks, head,
    buildHash })` for the mesh match whose room this is
    (`roomCodeFor(matchId) === room`).
  - It is cross-checked against litnode's own `protocol/keys.js` sign/verify,
    with and without `buildHash`.
  - `CSign` now carries `matchId` and `buildHash`, sent by the client and by
    `agent-session`.
  - An unproven side is archived with no key, which leaves it to the casual,
    name-labelled path.
  - New pin fields: `meshMatchId`, `intake`.
- **UI labels:**
  - Lobby: a seated placed match shows `PLACED BY THE MESH · YOUR ARCADE KEY
    SIGNS`; a relay fallback shows `CASUAL · RELAY-HOSTED · NOT RANKED`.
  - VS card and results come from `SMatch.placed`: `RANKED · PLACED BY THE
    MESH`, `CASUAL · PLACED BY THE MESH`, or `CASUAL · RELAY-HOSTED · NOT
    RANKED ON THE MESH`.
- Tests: `identity.test.ts` (an honest key is kept; a claimed-but-unsigned key
  is dropped; a relay room is announced casual) and `gauntlet.test.ts`.

## 8. Contract addresses from the arcade; proof level and links (goal 5)

**Contracts.**
- `mesh.ts` has no baked pair any more. The contract set comes from
  `cabinet:init.chain` (a first-party arcade, with its origin) or
  `https://arcade.litvm.games/contracts.json`.
  - A set read within 10 min is used as is.
  - With no answer, a set read within 7 days stands in.
  - Otherwise discovery fails closed with a clear error; a `?ws=` launch still
    plays.
- The RPC comes from the set's `rpc`. The constant is only used if a set names
  none, and it is not an address.
- `tools/check-contracts.mjs` now **forbids any `0x…40-hex` literal** in
  `packages/*/src`, `packages/*/tools` and `tools/`, and it is part of
  `npm run verify`, so CI finally runs it. `--arcade` additionally checks that
  the live set names NodeDirectory, NodeStake, MatchBook and EpochAnchor.

**Proof** (`packages/client/src/proof.ts`).
- **Results:** after a placed gauntlet match, the client polls the arcade's
  node `GET /delta/<matchId>` (every 5 s, up to 3 min). It shows `PROOF L3
  VERIFIED · RANKED · MATCHBOOK RECEIPT ›` (or SETTLING… until the node holds
  the result), and the line is tappable.
- **History:** on the select screen of an arcade launch, the client lists this
  key's latest results from `GET /deltas?ruleset=agent-fighter.v1`, each with
  win/loss, proof level, mode, OFFICIAL, and a tappable `MATCHBOOK ›` or
  `EPOCHANCHOR ›`.
- **Links:**
  - A result on MatchBook (`chain` not `none`) opens the arcade's receipt page
    `https://arcade.litvm.games/#/match/<matchId>`, which lists its MatchBook
    transactions on the explorer.
  - A result off MatchBook opens EpochAnchor on the explorer when the set
    names an `explorer`; otherwise it opens the same receipt page.
  - Addresses come only from the set.
- Checked in the browser pane against a fake node: rows render, and taps open
  `…/#/match/<id>`. A guard stops the press that opened the screen from also
  opening a link. The results-screen line uses the same helpers but was not
  seen live, since that needs a real placed gauntlet match.

## 9. User steps

1. **Commit.** The af-core-9 commit waits on your call:
   `determinism:browser` cannot run here because this Playwright needs
   Chromium headless shell 1228 and WebKit 2311. Either install them
   (`npx playwright install chromium webkit`) and rerun, or let CI run it.
   Commits 2–5 follow it.
2. **Push** agent-fighter `master`. *(Done 23 Oct: `8aaa934`.)*
3. **Deploy** the client and the relay together: the engine is now
   `af-core-9`, and the relay rejects other engines at `hello`. The client
   deploys from the push (Vercel's GitHub integration). The relay is the
   `litnode-relay` scheduled task on the publisher's node, so restarting it is
   the deploy (`npm run deploy`, docs/deploy.md). *(Done 23 Oct.)*
4. **litnode, ruleset:** apply §3, `npm run bundle:af`, `npm run conformance`,
   then `npm run publish:title -- set-build rulesets/agent-fighter.v1.js`
   (TitleRegistry tx).
5. **litnode, server bundle:**
   - Set `absWorkingDir: src` in `tools/bundle-server.mjs` (§10, Q1).
   - `npm run bundle:server -- gauntlets/agent-fighter.server.json`.
   - `npm run publish:title -- set-build servers/agent-fighter.v1.server.json`
     (TitleRegistry tx).
   - Serve it from the publisher's node:
     `GAUNTLET_SERVERS=agent-fighter.v1=servers/agent-fighter.v1.server.tgz`.
6. **Operators:** `GAUNTLET_SERVERS=agent-fighter.v1` on two or more operators.
7. **af-watch** (litnode desktop checkout): the step-1 changes in §6.
8. **Optional:** add `explorer` to litnode's `contracts.json`, so EpochAnchor
   links go straight to the explorer.

## 10. Open questions for the LITNODE session

1. **`serverHash` is not machine-independent today.**
   - `tools/bundle-server.mjs` calls esbuild without `absWorkingDir`.
   - esbuild's per-module path comments are relative to the cwd, so the same
     checkout bundled from litnode's directory gives a different hash than
     from the checkout:
     - `9534a38d…` with the path comment
       `// ../AGENT FIGHTER/agent-fighter/packages/server/src/server.ts`;
     - `fd4fdced…` with `// packages/server/src/server.ts`.
   - Fix: `absWorkingDir: src`. Until then, two publishers or a re-build on
     another machine cannot reproduce the registered hash.
2. **`contracts.json` has no `explorer`.** litnode's cabinet hard-codes it in
   `cabinet/config.js`. Can it be published in the set?
3. **`GET /delta/<id>` has no `chain` / `official`.** Only `/deltas` applies
   `withChain`, so the results screen cannot tell "final on MatchBook" from
   the single-match route. Can `/delta` get `withChain`?
4. **`GET /deltas?player=<key>`** would let the in-game history avoid
   downloading every Agent Fighter result.
5. **The gauntlet child inherits the operator's environment** (minus
   `OPERATOR_SECRETS`). An allowlist would be safer. Agent Fighter now ignores
   `AIR_*` in gauntlet mode regardless.
6. **Is `fastestKo`** (min, absent when no KO) acceptable as the first `min`
   stat on L3?
7. **af-watch:** confirm the §6 step-1 rule (unplaced casual under the relay
   id, no player signatures, skip gauntlet rows), or stop it now.

---

## After litnode 7b752dd (2026-10-23)

litnode took the §3 patch as-is and answered §10 Q1–Q7. Its build from this
repo at `3d4d1d6` is buildHash `290200cf…7691` and passes conformance.

### What changed here (commit `d70eea5`)

- **The ledger carries the placement descriptor** (litnode 0.11.31 binding).
  - The client keeps `cabinet:init` `match.descriptor` and sends it back with
    its ledger signature (`CSign.descriptor`).
  - The gauntlet forwards the first envelope from a seated player that names
    this match: id, ruleset, mode and the two seated keys.
  - It must also carry its placer's `match` signature
    (`mesh-ledger.ts descriptorProblem`, cross-checked against litnode's own
    `seal` / `opened`).
  - It goes into the submission as `descriptor`. A forged or mismatched one is
    dropped and logged.
  - The node still verifies the placer's bond and the beacon.
- **Proof routes.**
  - The result screen polls `GET /delta/<id>?chain=1`.
  - The history asks `GET /deltas?ruleset=agent-fighter.v1&player=<key>`. The
    client-side participant filter stays for nodes before 0.12.0.
- **Links have one source per kind and no fallbacks.**
  - A result on MatchBook opens the receipt page of the arcade the contract
    set came from.
  - A result off MatchBook opens EpochAnchor at the set's `explorer`. If no
    explorer is named, there is no link.
  - `check-contracts` stays green. With `--arcade`, it warns while the live
    set names no explorer.
- **Browser determinism, run locally.**
  - Both engines reproduce all 6 af-core-9 goldens bit for bit: Chromium
    6/6 and WebKit 6/6.
  - This used the repo's harness with the installed Chromium headless shell
    1248 and WebKit 2370 via `executablePath`. Playwright 1.61.1 pins 1228 and
    2311, which aren't installed here.
  - CI runs the pinned builds on push.
- `npm run verify` is green: core 150/150, server 159/159, typecheck and
  `check-contracts`.

### The commit to bundle from

**`d70eea5`**, or any later commit (the commit after it is docs only).

- `packages/core` has not changed since `29ca1a2`, so `npm run bundle:af`
  should reproduce **`290200cf…7691`**.
- The gauntlet server did change (`server.ts`, `mesh-ledger.ts`,
  `protocol.ts`, `agent-session.ts`), so **`101661fb…dd62` is stale**. Rebuild
  the server bundle from `d70eea5`.

### What litnode still needs

1. **A new server bundle hash** from `d70eea5` (above).
2. **The live arcade on 0.12.0.** `contracts.json` must carry `explorer`, and
   the nodes the arcade points at must serve `?chain=1` and `?player=`.
   - Until then EpochAnchor links stay off.
   - An older node's `/delta` has no `chain`, so a final ranked match links
     to EpochAnchor instead of its MatchBook receipt.
3. **Optional:** pass the node's own envelope to the gauntlet (for example a
   `GAUNTLET_DESCRIPTOR` env) as a second source when neither player sends
   one. Today only the players' copies travel.

### User steps, in order

Status as of 23 Oct, after `b7d0923`.

1. Push agent-fighter `master`. *(Done: `0c49e9b..8aaa934`, then `29d4400`
   and `b7d0923`.)*
2. Deploy the client and the relay **together**, because the engine is
   `af-core-9`. *(Done.)*
   - **Client:** www.agentfighter.wtf serves `af-core-9` from `b7d0923`.
     That commit adds the RPC fallback: Caldera's public `/http` ran out of
     bandwidth on 23 Oct, and discovery now falls through to
     `/infra-partner-http`.
   - **Relay:** the desktop's `litnode-relay` task was restarted on `8aaa934`.
     The server has not changed since.
   - **m16 standby:** it runs no relay, so there is nothing to pull.
   - There is no Railway any more. `npm run deploy` does both halves
     (docs/deploy.md).
3. **Ruleset.** *(Done 23 Oct.)* `7414ddf3…4423` was built and
   release-signed in litnode `bea6429` / `0e9e948` from `29d4400`, and
   `packages/core` has not changed since.
   - Registered on TitleRegistry: tx `0xaec4d385…`, active since 10:30:11 UTC.
4. **Gauntlet server bundle.** *(Done 23 Oct.)* `e8d8f22b…02fd` was built in
   litnode from `29d4400`. Rebuilt here from `b7d0923`, it is byte-identical.
   - Registered on TitleRegistry: tx `0x60c38999…`, active since 10:30:27 UTC.
   - The desktop serves it from `C:\litvm\servers\`. The af-core-8 server
     `00f7319c…` is kept in `C:\litvm\servers\af-core-8-00f7319c\`.
   - litnode's `demo/server-bundle.test.mjs` "real server" case passes on
     0.12.0. A second node fetches the bundle by hash, places a ranked match
     and plays it with bots, and the result settles with both players'
     signatures.
5. **litnode 0.12.0.** *(Done 23 Oct.)*
   1. The release has been on GitHub Releases since 22 Oct 20:24 UTC, signed
      with the release key `4d8759b0…`. **Do not run `npm run release`
      again.** It re-uploads the zips over the published ones.
   2. Its four zips are registered on ReleaseRegistry (tx `0x4fae4a8a…` and
      three more), active since 10:31:09 UTC.
   3. Pickle Brawl `98d23e4e…` is registered too (tx `0x47c49afa…`).
      FLOOD CONTROL is not on TitleRegistry at all, and registering it picks
      its owner wallet.
   4. **The wallet for all of these** is
      `0x04bE2b954346324Ee54c4B4c0189DF5bb577a378`. It is the testnet
      deployer, the ReleaseRegistry admin, and the holder of the
      `agent-fighter.v1` and `pickle-brawl.v1` titles. Both tools take its
      key as `DEPLOYER_KEY`.
   5. **The desktop node** (`5b703f12…`) runs 0.12.0 on protocol 4.
      - It is bonded, holds `7414ddf3…`, and the gauntlet serves
        `e8d8f22b…`.
      - Doctor reports `settlement` protocol 4.
      - It announced its new tunnel on NodeDirectory (tx `0x682bc990…`).
      - The 0.11.29 rollback copy is kept at
        `E:\NPC\litnode-desktop-rollback-0.11.29`.
   6. **The arcade** was redeployed from litnode `cabinet/`.
      - The Vercel team is `NPC`, project `cabinet`, deployment
        `cabinet-aktx449hb`. The previous one, `cabinet-o9nnsjp9u`, is the
        rollback.
      - `contracts.json` carries `explorer`, and the client's EpochAnchor
        links are on.
      - It still has no `rpcFallback`. The client carries its own fallback
        list, so that field is optional.
   7. **Gotcha: the LITNODE Control Plane app.** Opening it starts its own
      bundled 0.11.29 node as `desktop-test`, unbonded, on port 7801. That
      blocks the `litnode` task's node.
      - Quitting the app leaves that node and its `cloudflared` running.
      - Don't open it on the publisher's desktop until the app ships 0.12.0
        and drives the task node instead.
   8. **Restarting the node task.** `schtasks /End` ends only the task's
      wrapper. The elevated node survives and keeps the port.
      - When an update is pending, a loopback `POST /update` applies it and
        the node exits on its own.
      - Otherwise run `restart-node.cmd` from an admin prompt.
      - If the wrapper is gone, follow either with
        `schtasks /Run /TN litnode`.
6. **Dedicated relay checkout.** *(Prepared: `E:\NPC\AGENT FIGHTER\agent-fighter-relay`,
   a clone of `b7d0923` that tracks GitHub `master`, with `npm ci` done.
   Without `.env` it refuses to start, as designed.)*
   - **Left:**
     1. Copy `.env` into it, and `air/partner_rs256.pem` too if AIR
        write-back is on.
     2. Set `AF_ROOT` in `E:\NPC\LITNODE-DESKTOP\node.env` to the new
        checkout.
     3. Run `LITNODE_DIR=E:\NPC\LITNODE-DESKTOP npm run deploy:relay`.
   - Do the copy **before** the `AF_ROOT` change. A relay without `.env`
     does not come back up.
7. **Stable relay hostname.** A named tunnel needs a hostname in a Cloudflare
   zone. `agentfighter.wtf` and `litvm.games` are both on Vercel DNS, so this
   needs a domain (or a subdomain's zone) moved to Cloudflare first. Then:
   1. `cloudflared tunnel login`
   2. `create`
   3. `route dns`
   4. Set `RELAY_TUNNEL_NAME` / `RELAY_TUNNEL_HOST` in `node.env`.

   `cloudflared` 2025.7.0 is installed on the desktop.
8. Operators: `GAUNTLET_SERVERS=agent-fighter.v1` on two or more operators,
   then the week-long relay retirement in ADR 0014.
