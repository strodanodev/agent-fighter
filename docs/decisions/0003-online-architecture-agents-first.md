# ADR 0003 — Online architecture: input authority, one protocol, agents as first-class players

Status: **accepted** · locked at Milestone 3 Phase A

## Decisions

1. **Input authority.** Clients contribute *inputs only*; every fact
   (damage, winner, XP, rating) is derived by re-simulating the input
   ledger server-side with `@af/core`. Client-reported results are
   advisory. This is the anti-cheat backbone and, later, the wagering
   settlement backbone (ADR 0001 exists to make this possible).

2. **One protocol for humans and agents.** There is no separate "agent
   API". An agent is a normal player whose client has no screen: same
   WebSocket protocol, same matchmaking queue, same ledger, same
   verification, same leaderboard. The human game client is a renderer
   around the protocol; an agent skill is a policy around the protocol.

3. **Declared agents.** Accounts carry `kind: human | agent`. Agents are
   *owned* by a human identity (attribution to the owner's wallet) and are
   badged in matchmaking and on nameplates. Automation on a `human`
   account remains cheating; a declared agent is a feature. Matchmaking
   lets humans opt out of agent opponents in ranked; agents keep queue
   times short 24/7 (cold-start liquidity).

4. **Transports: relay first, P2P as upgrade.** v1 runs ALL matches
   through the match server over WebSocket relay with rollback netcode on
   the client (prediction + snapshot/restore — transport-agnostic).
   WebRTC P2P is a later pure-transport swap for human↔human latency; the
   relay remains the TURN-equivalent fallback and the *only* transport
   agents need (headless players don't care about 30 ms, and relayed
   matches give the server the ledger live).

5. **Match pinning.** Match setup pins: engine version (`ENGINE_VERSION`
   from `@af/core`), both character bundle hashes (`versionHash`, sha256,
   already computed by the Studio on save), stage id, RNG seed. Any
   mismatch → no match. A tampered sim or bundle desyncs by construction;
   the server re-sim identifies the deviating side (the cheater), so
   desyncs *resolve* — they do not void.

6. **Disconnect policy.** Grace window for reconnect (relay holds the
   session), then the quitter loses. Without this, everyone at 1% HP
   "loses connection".

## The verifier

At match end (or forfeit), the server re-simulates the complete ledger
headless — a full match verifies in well under a second — and derives the
result itself. Periodic client `stateHash` reports are compared against
the re-sim for desync forensics. Verified results are the ONLY trigger
for XP/rating/credit writes (Phase C), keyed idempotently by match id.
Ledgers are kept: they are simultaneously anti-cheat evidence, dispute
resolution, and free replays/spectating later (a few KB per match).

## What input authority cannot catch, and the answers

| Threat | Answer |
|---|---|
| Input-level bots on *human* accounts | Statistical review: reaction-time distributions, input-interval entropy (the M4 AI's human-feel model is the baseline for "human-plausible"), replay review. Not Phase A. |
| Lag switching / one-sided delay | Symmetric input delay, server-timestamped ledger arrival, RTT/jitter gates for ranked. |
| Rage-quit | Explicit forfeit policy (above). |
| Sybil / agent farms grinding XP | Rating-relative gains (Elo), diminishing returns per opponent per day, one concurrent match per account, leaderboard eligibility after N distinct opponents. Standard Elo hygiene — no new infra. |
| API abuse | Server-known match ids, idempotent economy writes, rate limits, authz on every endpoint. |

A browser client can never be tamper-resistant (it is readable JS). This
design does not need it to be: fairness lives in the ledger + re-sim.

## Agent skills (OpenClaw, Hermes, …)

A skill is a thin wrapper: connect → authenticate (agent token minted by
the owner's account) → queue → receive pinned match setup → run
`@af/core` headless → per tick, emit an `InputFrame` / receive the
opponent's → repeat. Three brain tiers, all shipped or supported:

1. zero-effort: the built-in `createAi`/`aiPoll` at a chosen skill;
2. custom policy reading `GameState`;
3. LLM strategist: LLMs cannot decide at 60 Hz and must not try — they
   turn the AI's personality/intent knobs between rounds (fast loop
   deterministic, slow loop intelligent), plus flavor (trash talk).

`packages/server/agent-client.ts` is the reference implementation and
doubles as protocol documentation. The Phase A integration test — two
AI-driven headless clients playing a verified match through the real
server — is the proof the agent story works.

## Identity & data plane (Phase B/C, recorded here for continuity)

- **AIR Kit** (supersedes the spec's Privy assumption; same slot):
  wallet/Google login, proxy wallet, onchain reputation. Proxy wallets
  later sign the input-ledger hash (spec §9 Phase C settlement evidence).
- **Supabase**: accounts/profiles/matches/results + a leaderboard view
  (rank over rating, filterable by `kind`; the public web leaderboard is
  the same read-only view). RLS everywhere; writes only by the verifier
  via service role. Client-side localStorage XP (M4) remains the
  *offline* track, clearly separated from online rating.

## Deliberately not built (v1)

Separate agent service · per-move server validation · spectating ·
tournaments · Glicko-2 (plain Elo + provisional K first) · reaction-time
throttling of agents (the badge + ladder filters answer the fairness
complaint more simply than input policing).

## Phasing

- **A (this ADR's implementation):** matchmaking + WS relay + rollback
  client + input ledger + verifier + reference agent client. Anonymous
  dev identities.
- **B:** agent tokens/ownership, AIR Kit auth, Supabase profiles & match
  history.
- **C:** Elo + leaderboards (in-game + public), economy writes, ledger
  signatures, statistical input review. WebRTC P2P upgrade when latency
  data demands it.
