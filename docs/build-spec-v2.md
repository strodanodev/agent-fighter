# Agent Fighter — Build Spec v2

*2026-07-18 · Supersedes Build Spec v1 (2026-07-14, kept as `build-spec.md` for
history). v2 is written from a code-level audit of the working system, not from
intent: everything in the "as built" sections was verified against source,
tests, or production endpoints. Deltas from v1 are marked **[CHANGED]**,
**[DROPPED]**, or **[NEW]**. Open work is in §12.*

---

## 1. Product definition

A browser-based 2D fighting game that feels like a MUGEN/IkemenGO Marvel vs
Capcom mod — fast, crunchy, sprite-based, combo-heavy — on a custom
deterministic engine, with an AI-assisted character pipeline, online play,
a credits economy, and **agents as first-class players** [NEW: this became the
product's identity, not an add-on — humans and AI agents share one queue, one
economy, one leaderboard].

**Shipped scope (live in production):** 1v1 matches; local 2P; ranked solo vs
server-verified AI; online wager matches; friendly challenge rooms; dare
links (bounty challenges); arcade gauntlet; trained per-user agents coached
in-game or via Minds ("TRAIN MY AGENT", ADR 0006); autonomous agent accounts;
credits economy with daily grant, fees, pots, escrow; leaderboards (humans and
agents); 12-character roster; 3 stages; PWA/mobile/iOS support.

**Non-goals (unchanged from v1):** tag/assist gameplay, spectator mode,
community character uploads. **[CHANGED]** mobile touch controls shipped
(v1 excluded them). **[DROPPED from architecture]** tag-readiness — see §2.2.

## 2. Architecture as built

Monorepo, **npm workspaces** [CHANGED from pnpm], four packages:

```
@af/core    deterministic sim — pure TS, ZERO dependencies (enforced by tests)
@af/client  Canvas 2D renderer + input + rollback netcode + UI  [CHANGED: not PixiJS]
@af/server  Node ws match server: matchmaking, input ledger, re-sim verification,
            economy, AIR identity, agent API
@af/studio  local character authoring + AI sprite pipeline — NEVER deployed
```

`@af/core` runs identically in browser (play), Node (verification), and
headless fast-forward (agents, balance suites). This held: the same
`step(state, inputs)` settles real-credit matches server-side.

### 2.1 Determinism rules (non-negotiable — mechanically enforced)

Unchanged from v1 in substance, now stronger in enforcement than the spec
asked: fixed 60 Hz tick; 24.8 fixed-point integer math (`fp.ts`); seeded PRNG
in GameState; no `Math.random`/`Date`/DOM/async in the sim. Enforcement:

- `guards.test.ts` — source-level bans (Math.random, Date, DOM, globalThis,
  rAF, timers, fetch, storage, process, transcendental Math) in `@af/core`.
- `serialize.test.ts` — every scalar field provably reaches `stateHash` and
  round-trips `snapshot`/`restore`.
- Golden replay lock — `test/golden/hashes.json` pins full-match hashes;
  any sim behavior change is a red build until deliberately re-blessed
  (`npm run golden:bless`).
- `ENGINE_VERSION` (currently `af-core-2`) pins compatibility at match setup;
  bumped when AI derivation changes even if `step()` doesn't (solo
  verification re-derives the AI, so AI determinism is protocol).

**[GAP — v2 requirement]** v1 demanded a *cross-environment* (browser vs
Node) replay-hash CI gate. Still Node-only. Browser/Node equivalence is
proven empirically by live verified matches but not gated. Required before
any economy expansion (§12 P1).

### 2.2 Entity model **[CHANGED — decision]**

The sim is a hardcoded 2-fighter world: `fighters: [FighterState,
FighterState]` plus a projectile pool. v1's tag-ready entity-pool
requirement is **formally dropped**: v2 declares 1v1 the permanent shape of
this engine. Rationale: three days of building never needed it; the hash
format (client, server, goldens, settled matches) is denominated in the
2-tuple; a future tag game funds its own migration. Record as ADR if tag is
ever revisited.

`InputFrame` (bitfield: directions + 6 buttons) via the `InputSource`
abstraction remains the universal boundary: human, remote, AI, replay,
auto-special macros, and coached agents are indistinguishable to the sim.
This abstraction carried every post-M1 feature and is the most
load-bearing design decision in the codebase.

## 3. Character data format

As specified in v1 and shipped: one character = one folder =
`characters/<id>/character.json` (manifest + moves + cancels inline) +
`sprites/` (atlas.png + atlas.json + authored portraits). Bundle sha256
version-hash pinned at match setup. `sys.*` system moves (idle/walk/jump/
block/hitstun/knockdown/…) give every fighter state a sprite;
`anim.ts spriteForFighter` is the single sprite resolver for all renderers.

**[CHANGED]** Validation is hand-rolled in `loadCharacter()` (throws on
duplicate/missing/malformed) rather than zod — keeps core dependency-free.
**[v2 requirement — audit-confirmed holes]** validation must also bound
VALUES: today a bundle with negative `meterCost` gains meter on every super
(`sim.ts:145`), negative `juggleCost` bypasses the infinite-combo guard
(`sim.ts:582`), negative `chip` heals without an upper health clamp
(`sim.ts:555`), and `maxHealth <= 0` / NaN numerics are accepted. Harmless
while all bundles are first-party (both sides sim the same data, so it
cannot desync) — but these must be rejected, and negative-data tests added,
before any third-party bundle or wagering expansion.

## 4. Combat system (as shipped)

Everything in v1 §4 shipped and is live: 6 buttons; walk/dash/8-way jump/
super jump; magic-series chains via per-character cancel graph; launcher +
air combos with juggle points; 236/214/623 motions with lenient buffered
parsing; projectiles; 1 super per character (1 of 3 bars, flash freeze);
mid/low/overhead blocking + chip; pushblock; throws + techs; damage scaling
(×0.9 floor 20%) + hitstun decay; hitstop; best-of-3, 99s timer; scrolling
camera with dynamic zoom (0.85–1.9) framing both fighters.

**[DROPPED]** charge moves (no character uses them; add with the first
character that does). Double jump / air dash remain per-character flags
(air dash is horizontal-only; jumps are 3-way up, not full 8-way air
control — accepted simplifications, audit-verified). Two same-tick
findings to keep in mind for wagers: trades where a KO'd attacker still
lands its planned hit are intentional (`hitPlan` builds before applying),
and double-KO → both round counters advance → possible `winner=2` draw —
logic correct, currently untested. The in-state `rngSeed` is vestigial
(combat has zero randomness; only the AI consumes randomness, on its own
stream outside GameState — which is also why AI opponents must never be a
rollback peer).

**Feel gate: STILL OPEN.** v1's M1 gate — "people who play MvC say it feels
right" — has never been run with external players. It remains the top
project risk (§12 P0).

## 5. Character pipeline + Studio (as built)

Studio is a local-only tool (`npm run studio`, port 8474). **It must never
be deployed**: it proxies image-provider keys and has unauthenticated
bundle-write CRUD by design.

Pipeline reality vs v1 §5 (hard-won; see memory of failed experiments):

- **Reference conditioning [CHANGED]:** NVIDIA-hosted flux cannot accept
  user reference images (gallery ids only). True identity lock ships via
  the **Gemini provider** (reference-conditioned) — provider is pluggable
  per request (`IMAGE_PROVIDER` nvidia|bfl|fal|gemini).
- **Strip generation** is the consistency mechanism: one 1536×640 image per
  move, all poses in one image, sliced by column-gap analysis
  (`sliceStrip`). One image = one costume. Per-move seeds; NEVER one shared
  anchor+seed (proven to collapse all animation into one picture).
  Prompts cap at 800 chars (API 422s beyond).
- **Normalization (deterministic):** bg removal incl. enclosed pockets →
  median-cut palette lock → chroma gate → nearest-neighbor downscale to
  192×192 cells (feet pivot 96,176) → connected-component filter.
- **QC gate:** palette conformity, chroma vs reference, multi-figure
  detection, facing detection (auto-flip), DUPE detection (same content in
  two moves), per-type thresholds. **[DROPPED]** CLIP/embedding similarity
  — heuristics proved sufficient.
- **Auto-hitbox/hurtbox drafts** from alpha bounds; edited visually in
  Studio; atlas packed on save.
- Authored portrait slots: `selectPortrait` (COVER fit) + `vsPortrait`
  (CONTAIN into fixed frame). Studio preview fit-math MUST stay mirrored
  with client `atlas.ts drawPortrait`.

Archetype pose libraries (shoto etc.) auto-prompt whole movesets; character
#2 through Studio took ~5 minutes of generation (v1 budgeted < 2 days).

## 6. Rendering (as built) **[CHANGED]**

Dependency-free **Canvas 2D**, not PixiJS. Measured 1.9 ms/frame vs the
16.7 ms budget; demo bundle 332 KB vs the 5 MB ceiling. The renderer is a
pure function of GameState + cosmetic FX layer (particles, afterimages,
screen shake, voice/SFX buses) held outside the sim. Debug: perf overlay
(F). PixiJS remains a possible future swap behind the same interface, no
longer planned. SVG chrome kit + PNG stage system (parallax planes,
draggable floorY anchor) make UI/stage art swappable without code.

## 7. Online architecture (as built; ADR 0003/0005)

**Transport [CHANGED]: WebSocket relay, not WebRTC P2P.** GGPO-style
rollback runs over the relay (predict last input, 128-snapshot ring,
MAX_AHEAD stall guard, INPUT_DELAY 3 for wager). The relay also hides peer
IPs — revisit DDoS exposure before any P2P upgrade.

**Trust spine (unchanged in principle, richer in practice):**
matchmaking pins {engine version, bundle hashes, stage, seed, delay};
first-write-wins input ledger on the server; at match end the server
**re-simulates the ledger** and derives the result itself; desync hash
checkpoints name the deviating side; deviator forfeits.

**Zero-latency ranked solo (protocol v3+):** the house/trained AI is
deterministic, so the client sims the whole match locally (delay 0) and
streams only its inputs; `verifySoloLedger` re-derives the same AI from
pinned `{skill, aiSeed, personality}` server-side. Anti-TAS wall-clock pace
bounds. This pattern — *offline feel, server-verified* — is the engine's
killer economic property and MUST be preserved by any future mode.

**Desync policy [CHANGED from v1]:** v1 said persistent hash mismatch →
match VOIDS. As built (and adopted here): the server names the deviating
side via ledger re-simulation and the deviator forfeits the pot — stronger
for wagering, since voiding would let a losing cheater force a refund.

**Settlement ladder (ADR 0005):** ledger-reached-MatchOver → VERIFIED
regardless of sockets; exactly-one-absent/silent → forfeit (20s grace,
30s idle sweep); nobody-to-blame → no-contest refund. Match resume via
per-side bearer tokens; seat adoption keeps settlement stable. Escrow
sweeper refunds fees stranded by a crash (settle-then-refund order makes
refund-then-payout double-spend impossible). Protocol v6 adds
opponent-disconnect heads-up.

## 8. AI and agents (as built; ADR 0006) **[NEW — this section replaced v1 §8]**

- `core/src/ai.ts`: deterministic InputSource — intent system, reaction
  delay/jitter by skill, execution flubs, 6-knob personality
  (aggression/jumpiness/zoner/throwHappy/pushblocker/patience), adaptation
  counters, combo book derived from the character's own cancel graph.
  One lever: skill 0–100 (server-derived from owner level; never editable).
- **TRAIN MY AGENT:** `profiles.agent_config` = {character, personality,
  motto}; knobs server-clamped to the same ranges random opponents sample
  from (style, never power). Coached in-game or by a Minds Mind via the
  REST agent API (`/agent`, `/agent/key`, `/agent/matches`, `/connect`);
  durable `afk_` bearer keys (sha256 stored, shown once, rotate-on-remint).
  Trained agents fight offline owners via the solo pipeline — no runners.
- **Autonomous agent accounts:** `POST /agent/signup` (no auth) creates
  inert agent-class accounts — 0 credits forever, no daily grant, wager
  unreachable, free arcade entry, AGENTS leaderboard only. Valves: 5
  signups/IP/day, 20 battles/day/account.
- Headless reference client (`npm run agent`, AF_* env) plays the real
  queue at ~8× realtime; balance smoke tests (skill 85 beats skill 25
  ≥70%) are in the test suite.

## 9. Identity & economy (as built; ADR 0004) **[CHANGED from v1 §9]**

- **Identity: AIR Kit (Moca)** [not Privy]. Sign-in required at title
  (account = wallet). ES256 JWKS verification server-side (prod + sandbox
  keys); soft-fail to anonymous for unranked.
- **Credits (off-chain, no cash-out):** +10/UTC day on first authed
  contact; ranked solo fee 1 (win +1 net, +60xp; loss burns fee, −15xp
  floor-clamped); wager 10 each → winner takes 20; deviator forfeits pot;
  draws/incompletes refund. Money logic lives twice in lockstep —
  Supabase SQL RPCs (source of truth: `get_account`/`escrow_match`/
  `record_match` — atomic, idempotent by match id) and an in-memory dev
  mirror. **Rule learned in production: every money-path SQL change must be
  smoke-tested on real Postgres** (`NULL = x` poisoned settlement once).
- **AIR reputation write-back:** server issues "Agent Fighter Reputation"
  credentials (level/xp/W-L/credits/is_agent) via issue-on-behalf after
  settled matches; our RS256 partner JWT + published JWKS.
- **Explicit release gate: credits must not be convertible to value until**
  (a) sybil/farming valves are closed for human accounts, (b) ledger
  signatures ship, (c) legal review (v1 §9 Phase C) happens. The economy's
  current safety rests on non-convertibility.

## 10. Deployment topology (production)

| Piece | Where | Notes |
|---|---|---|
| Game client | Vercel — agent-fighter.vercel.app | static demo bundle; serves characters/ + stages/ + JWKS |
| Match server | Railway — match-server-production.up.railway.app | ws + HTTP (health, /me, /leaderboard, /agent*, /connect) |
| Database | Supabase aogkimkaaavntmdgstji | profiles, matches, credit_ledger, RLS on, service key server-side only |
| Landing/marketing | Vercel (Next.js, `landing/`) | leaderboard reads; service key server-side only |
| Studio | NEVER DEPLOYED | local authoring only |

Deploy gotchas are recorded in `docs/deploy.md` (Railway env, .railwayignore,
vercel-build wholesale copy, workflow-scope token). Engine/protocol drift
between local and prod is checked by comparing `/` health JSON to
`ENGINE_VERSION`/`PROTOCOL_VERSION` in source.

## 11. First principles (v2 statement)

The five principles the codebase actually runs on — every future change
should be checked against them:

1. **The sim is the only truth.** Deterministic, dependency-free,
   mechanically guarded. Anything that can't be re-simulated can't be
   trusted, and anything that can be re-simulated doesn't need trust.
2. **Characters are data.** No character code, ever. Schema vocabulary
   grows; a scripting runtime never does.
3. **Everything is an InputSource.** New actors (humans, bots, macros,
   coached agents) enter through inputs, never through sim hooks.
4. **The ledger is the truth for money.** Settlement follows re-simulation
   of inputs, not client claims; disconnects settle by the ladder;
   idempotency by match id everywhere.
5. **Verification over runners.** Deterministic AI means offline presence
   is a pinned config, not a hosted process — zero marginal cost per agent.

Violations to watch for (from the audit): game-feel logic drifting into
`client/main.ts`; validation gaps at the bundle boundary; money logic
diverging between SQL and the TS mirror; unversioned AI changes.

## 12. Roadmap — what production-ready still requires

Priority-ordered; each item's rationale is in `docs/audit-2026-07-18.md`.

- **P-1 — Hotfix the self-match credit mint** (audit finding: `tryPair`
  pairs identical subs; ledger idempotency halves the fee; pot pays
  double → unbounded mint). Guard in tryPair + `_p0 = _p1` raise in
  escrow_match + real-Postgres regression test.
- **P0 — Run the feel gate.** External MvC players on the live build. The
  only open item that can invalidate everything above it.
- **P1 — Cross-environment determinism gate in CI** (browser vs Node golden
  hashes). Prerequisite to scaling the economy.
- **P2 — Boundary hardening:** value-range validation in `loadCharacter`
  (+ negative-data tests); client resilience — guard module-init
  `localStorage` access (white-screen risk), skip-not-abort on a failed
  roster manifest, visible stall overlay when an opponent throttles
  without disconnecting; CSP meta in the bundle; server ws payload/rate
  limits; fuzz the protocol.
- **P3 — Economy valves before any conversion:** human-account sybil
  limits, solo-farm caps, ledger signatures, legal review. Written gate:
  no cash-out until closed.
- **P4 — Observability + lifecycle:** structured logs with match ids,
  error alerting, deep health check (probe Supabase), minimal metrics
  (matches/day, verify failures, escrow sweeps); graceful SIGTERM
  (settle/refund live matches before exit — today every deploy strands
  them for the 30-min sweeper and in-flight winners forfeit winnings).
- **P5 — Client refactor when it next resists:** split `ui.ts`/`main.ts`;
  VS poses for the remaining roster; baked-shadow sprite cleanup.
- **Explicitly deferred:** WebRTC P2P (re-opens DDoS exposure), PixiJS,
  tag/assist (dropped), hosted agent runners (rejected), cash-out.
