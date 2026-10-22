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
2. **Push** agent-fighter `master`.
3. **Deploy** the client (Vercel) and the relay (Railway) together. The engine
   is now `af-core-9`, and the relay rejects other engines at `hello`.
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
