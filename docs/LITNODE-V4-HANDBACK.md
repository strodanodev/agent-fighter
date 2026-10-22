# Agent Fighter → LITNODE: settlement v4 hand-back

Written 2026-10-22 against `strodanodev/litnode` master `84c6fb0` (v0.12.0 RC,
protocol 4). Its `docs/SETTLEMENT-STANDARD.md` is the canonical contract and
wins over the prompt text. **Status: goals 1 and 2 are done (engine). Goals 3–5
are inventoried, not implemented: the session hit its usage limit.**

## 1. Stats: names and ops (goal 1, done)

| name | op | meaning |
|---|---|---|
| `kos` | sum | rounds won by KO |
| `roundsWon` | sum | rounds won (a drawn round counts for both, as in scoring) |
| `perfectRounds` | sum | rounds won outright without taking any damage |
| `damageDealt` | sum | health actually removed from the opponent: hits, chip, throws (no overkill) |
| `maxCombo` | max | longest combo landed, in hits |
| `supersLanded` | sum | supers that landed at least one clean hit (counted once per super) |
| `throwTechs` | sum | throws escaped with a tech |
| `fastestKo` | min | fewest round-clock ticks (60/s) to a KO; **omitted** when the side never KO'd, so `min` skips it |

`parries` was dropped because the engine has no parry mechanic. All values are
non-negative integers, and no name shadows `matches`, `wins` or `ticks`.

## 2. Engine fields that hold them

These are appended `FighterState` fields (`packages/core/src/state.ts`,
`STAT_FIELDS`), at the end of `FIGHTER_FIELDS`, so they are in `serialize()`
and `stateHash()`:

- `stKos`, `stPerfects`, `stDamage`, `stMaxCombo`, `stSupers`, `stTechs`
- `stFastestKo`
- `stTouched`: a per-round flag (took damage this round), used for the perfect check

`roundsWon` reads the existing `GameState.roundsWon0/1`. The mapping and the
schema live in core (`packages/core/src/stats.ts`: `STATS_SCHEMA`,
`matchStats(state) → [line0, line1]`), so a stat cannot drift from its counter.

**The stats are pure observers.** The sim writes them and never reads them back
into an outcome. `test/stats.test.ts` proves this two ways:

- It scrambles every stat field on every tick and checks that nothing else
  changes.
- `legacyStateHash()` (the hash without the stat fields) reproduces all six
  committed af-core-8 golden final and trace hashes bit-exactly. Only the
  golden hashes moved, and they were re-blessed.

Core tests: 150/150.

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
`canonical()` are unchanged and no bundle leaks into a view. Separately, today's
`export const exclusive = true` was never passed into `defineTitle`, so the
manifest always said `exclusive: false`. Nothing in `node/` reads it anyway,
and the sandbox already gives each job a fresh vm context.

## 4. New engine version and rebuilding the bundle

- `ENGINE_VERSION` goes from `af-core-8` to **`af-core-9`**. This is a
  consensus change: new bundle, new buildHash, re-register. Old results are
  never relabelled.
- Rebuild, in litnode with this repo at the af-core-9 commit:
  `npm run bundle:af`, then `npm run conformance`.
- Register (user step):
  `npm run publish:title -- set-build rulesets/agent-fighter.v1.js`.
  `rulesetId` stays `agent-fighter.v1`.
- The AF relay checks `hello.engine`, so the client and server must deploy
  together.
- Replays and ledgers archived on af-core-8 still verify:
  - `replay-player.ts` accepts `legacyStateHash`.
  - `tools/replay-verify.mts` uses it when `row.engine === 'af-core-8'`.

## 5. Pins moved into state (goal 2, done)

- `createGameState(seed, bounds?, pins?)` takes `{ chars, items, pets }`.
  - Characters stay on the state as `GameState.chars` (not serialized; agreed
    by bundle hash, as before).
  - Drinks and auras are copied into numeric fighter fields at spawn.
- `step`, `resetRound`, the AI, `debugBoxes` and `debugInfo` read
  `charsOf(state)`, never a global.
- `setCharacters` / `setMatchItems` / `setMatchPets` remain only as defaults
  for callers that pass no pins.
- These now pass pins:
  - server `verifyAndScan` and `agent-session`
  - client `net.ts` and `replay-player.ts`
  - `tools/replay-verify.mts`, which was also missing pets and now includes them
- Tested: two matches with different characters, drinks and auras, stepped
  interleaved in one process, each hash identically to running alone.

**LITNODE can drop `exclusive`.**

## 6. Relay retirement plan (goal 3, NOT implemented)

The three intakes, verified by reading the code:

1. **Relay + af-watch.**
   - The relay archives wager matches and `LIT-` friendlies to Supabase
     `match_ledgers`.
   - `LITNODE-DESKTOP/tools/af-watch.mjs` polls that table, relay-signs, and
     POSTs `/ledger`.
   - It can still produce ranked: it takes the mode from the descriptor when
     the node still holds it.
   - It builds `af:<name>` participants when the pin lacks two keys
     (`tools/lib/af-submission.mjs:46`, the only `af:` path anywhere).
2. **Gauntlet** (`packages/server/src/gauntlet-server.ts`).
   - Seat keys from the HMAC ticket, players sign, one match per process.
   - It POSTs `mode: GAUNTLET_PLACED_MODE`, even without both signatures (the
     node then refuses).
3. **Import** (`af-import-ledger.mjs`).
   - Manual backfill and debugging from `match_ledgers`, with no relay
     signature: it settles `host`, or ranked only if placed and signed.

Plan:

- Ranked only via the gauntlet with both player signatures.
- Until it runs on ≥2 operators:
  - af-watch must submit relay ledgers as **unplaced casual** under the relay's
    own match id. Sending `casual` against a ranked descriptor is refused
    outright: settle.js "descriptor mode … submission …".
  - The client must label a relay-fallback `LIT-` room CASUAL. Today it says
    `RANKED · PLACED BY THE MESH` (`main.ts:3528`).
  - The gauntlet should send `placedMode` in `SMatch` so the client labels
    from fact.
- Once the gauntlet is on ≥2 operators:
  - Stop archiving `LIT-` rooms on the relay.
  - Retire af-watch.
  - Keep import for backfill, casual-only.
- Server bundle: there is no AF builder yet (`node/server-bundle.js` defines
  the format). Gotchas found:
  - `REPO_ROOT` is 3 levels up.
  - It reads `characters/`, `stages/` and `pets/` at runtime.
  - The only npm dep is `ws`; mark `bufferutil` external.
  - `loadIssuerConfig` reads `AIR_*`.
  - `server.ts`'s `isMain` would also start the relay if it became `argv[1]`.

## 7. Identity and contracts (goals 4–5, NOT implemented)

**Identity.**
- The gauntlet already uses arcade keys.
- On the relay, `hello.playerKey` is unverified; only the ledger signatures
  prove it.
- `SoloSession` never sends `playerKey`.
- There is no casual label anywhere in the UI.

**Contracts.**
- `mesh.ts` still has a `BAKED` gen-3 NodeDirectory/NodeStake fallback.
- `tools/check-contracts.mjs` is **not run in CI**, despite the comments that
  say so. `verify.yml` runs only `verify` and `determinism:browser`.
- Recommendation: delete `BAKED` and fail closed (no mesh discovery) when
  neither `/contracts.json` nor `cabinet:init.chain` answers.

**Proof display.** No proof level, MatchBook or EpochAnchor link is shown, and
the client has no match history (only server `GET /agent/matches`). There is
also no explorer base URL or chain id in the repo; LITNODE should add both to
`/contracts.json`.

## 8. User steps

1. Review and commit the af-core-9 change, if it isn't committed yet. Then
   deploy the client and the relay together (engine check).
2. In litnode: apply §3, `npm run bundle:af`, conformance, then
   `publish:title set-build` on TitleRegistry.
3. Push both repos. Nothing was pushed, deployed, registered or sent on-chain.

## 9. Open questions for LITNODE

- Should `/contracts.json` carry `explorer` and `chainId`, so titles link
  MatchBook and EpochAnchor without hard-coding?
- Should af-watch keep relay ledgers as unplaced casual under the relay id
  (recommended), or stop now?
- Is `fastestKo` (min, absent when no KO) acceptable as the first `min` stat
  on L3?
