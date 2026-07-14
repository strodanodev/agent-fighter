# Agent Fighter — Architecture Recommendation (v1)
*Drafted 2026-07-14*

## Summary decision

**Build a lightweight custom 2D fighting engine, do not build on IkemenGO.** Instead, invest that "porting effort" directly into a web-native character-authoring tool with automated hitbox/animation generation. This solves the exact tedium problem you flagged, produces a format you control end-to-end, and avoids the legal and technical baggage of the MUGEN ecosystem.

## Why not IkemenGO

- It's a Go/Lua desktop engine that reimplements MUGEN. There's an experimental WASM fork (`tursom/Ikemen-wasm`) but it's not production-hardened for browser deployment, has no built-in netcode model suited to real-money wagering integrity, and you'd be fighting the engine's assumptions (desktop input, local file-based character packs, non-deterministic-for-networking Lua state machines) the whole way.
- Its character format (CNS/AIR/SFF + CLSN hitbox boxes) is hand-authored line-by-line — this is exactly the tedium you're worried about, and tooling built for it (Fighter Factory) is a separate desktop app disconnected from a web pipeline.
- A large share of the MUGEN community character pool is built on ripped/unlicensed sprites. For a monetized product with real wagering, that's a real IP liability you don't want anywhere near your asset pipeline.
- None of Ikemen's design targets (single-player desktop nostalgia project) line up with your requirements (browser, competitive online multiplayer, money on the line, AI opponents, auth/wallet integration).

## Recommended stack

**Renderer:** PixiJS (WebGL2, mature, built for 2D sprite-heavy games) or a lean custom canvas/WebGL renderer if you want zero dependency weight. Skip Unity/Godot-to-WASM — that's overhead a 2D fighter doesn't need and adds bundle size + licensing friction for no benefit.

**Simulation:** Deterministic, fixed-timestep game logic in TypeScript, fully decoupled from rendering. Per-character state machine (idle/walk/attack/hitstun/blockstun/knockdown/cancel-windows) driven by a frame-data table, not scattered conditionals — this determinism is what makes rollback netcode and server-side result verification possible later.

**Character data format:** your own JSON/YAML schema — frame images, per-frame hitbox/hurtbox rects, cancel windows, move properties. This is the direct equivalent of Ikemen's CNS/AIR files, but structured, diffable, and versionable.

## The tooling is worth building — this is the actual leverage point

Build a small web-based character-authoring tool early (before scaling the roster):

1. **Sprite importer** — ingest a spritesheet or per-frame PNG export (Aseprite-friendly) with auto-slicing.
2. **Auto-hitbox/hurtbox generation** — compute a starting hurtbox from each frame's alpha-channel bounding box automatically, so designers *adjust* boxes visually instead of hand-typing coordinates. This alone removes most of the manual tedium you called out.
3. **Frame-data / timeline editor** — onion-skinning, canvas-overlay box editing, live preview, export straight to your runtime JSON. No format-conversion loss like you'd get shuttling through Fighter Factory → Ikemen.
4. **Optional, bigger lever:** consider skeletal 2D animation (Spine-style rigging, e.g. via pixi-spine or an open alternative) instead of pure frame-by-frame sprites for at least some characters. It cuts animation cost substantially at the price of a smoother/tweened look rather than the crunchy sprite-swap look MvC fans expect — worth an explicit art-direction decision rather than defaulting into it.

This tool becomes a genuine product asset, not just internal plumbing — it's what lets you ship new characters fast, and later could even seed community-generated content without the legal mess MUGEN has.

## Multiplayer & anti-cheat (money changes the calculus here)

Because matches settle real wagers, pure P2P rollback (classic GGPO model) is riskier than in a normal fighting game — a compromised client can't be fully trusted to self-report a loss. Recommended hybrid:

- Client-side prediction + rollback (GGPO-style, e.g. adapt an existing JS rollback library like `backroll-js` rather than starting from zero) for responsive *feel*.
- A lightweight authoritative match server (Node/Bun/Rust, WebSocket or WebRTC data channel) that relays inputs, logs them, and **deterministically re-simulates the match server-side** to confirm the final result before it's used to settle a wager. Same pattern as verifiable/anti-cheat designs in other competitive-money games.
- Bots (AI opponents) should consume the exact same input interface as human players — keeps the engine agnostic to input source and keeps single-player and multiplayer code paths unified.

## AI opponents

Start with classic game AI — finite state machines or behavior trees with reaction-time/decision noise for difficulty tiers. This needs to make frame-perfect 60fps decisions; LLMs are the wrong tool for execution. An LLM/agent layer fits better as a *meta* layer later — commentary, personality, adaptive strategy narration — which also ties nicely into the "Agent Fighter" name/branding, without being on the frame-perfect hot path.

## Auth

**Privy** is a solid, mainstream choice — embedded wallets + social login, well-documented, widely integrated in web3 consumer apps. Confirmed current and active as of this writing ([privy.io](https://www.privy.io/), [docs](https://docs.privy.io/wallets/overview)).

**"AirKit"** — I couldn't confirm this refers to a mainstream wallet-auth SDK in the same category as Privy; the closest match I found is **AIR Kit** from air3.com, a ZK-identity/fintech/loyalty SDK, which seems like a different product category. Worth double-checking which specific "AirKit" you mean — if you're looking for a second option alongside Privy for wallet-connect / BYO-wallet support, the more established alternatives are **thirdweb Auth**, **Dynamic**, **Web3Auth**, or **Particle Network**.

## "Insert coin" + degen wagering — the highest-risk part

- **Insert coin (pay to play):** simplest is an off-chain credit ledger funded by an on-chain deposit — avoids per-match gas cost, keeps UX fast.
- **P2P wagering ("degen" mode):** this is the part that needs the most caution. User-vs-user wagering of value is regulated as gambling in many jurisdictions regardless of "skill-based" framing, and rules vary a lot by country/state. Practical de-risking path:
  - Validate the product first with non-withdrawable in-game credits or testnet tokens before any real-value wagering goes live.
  - If/when you do real-value wagering, prefer a **non-custodial escrow smart contract** (funds locked, released to the winner based on the server-attested/verifiable match result) over a custodial "house" model — reduces some regulatory exposure and doubles as a "provably fair" trust signal.
  - Geofencing/KYC may be required depending on where users are.
  - This is not legal advice — given the money-wagering + gaming intersection is heavily regulated and jurisdiction-specific, get this reviewed by counsel before enabling real-value wagering.

## Suggested build order

1. Core engine + one character, local 2-player same-keyboard, no netcode, no crypto — validate the feel.
2. Character-authoring tool MVP (importer, auto-hitbox, frame editor) — build character #2 with it to prove the tooling actually saves time.
3. Netcode: rollback locally, then LAN, then WAN.
4. Auth (Privy) + wallet connect + off-chain credit ledger + "insert coin" flow (no real wagering yet).
5. Single-player AI bots (FSM/behavior tree).
6. P2P wagering with escrow contract — gated on legal review, launched small-stakes/testnet first.

## Open questions to confirm

- Which "AirKit" specifically, and whether you want it alongside or instead of Privy.
- Target chain(s) for wagering (EVM chain(s)? Solana? multi-chain?) — affects escrow contract design and gas/UX tradeoffs.
- Art direction: frame-by-frame sprite art (MvC-authentic feel) vs. skeletal/rigged animation (cheaper, smoother, less "arcade-crunchy").
- Team size/skillset — affects how much of the tooling vs. engine work is realistic to take on first.
