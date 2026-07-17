# PSG1 cross-play

Agent Fighter stays a PWA. We are not porting it to the Play Solana PSG1
("SG1") and we are not maintaining a device build. The goal is narrow: a PSG1
player and a browser player in the same match.

The finding that shapes everything below: **cross-play needs no netcode work,
because we already do something harder.**

## Cross-play is already solved

The match server runs one FIFO queue with no device, platform, or client-type
segmentation ([server.ts](../packages/server/src/server.ts) `tryPair`). It shifts two clients off the front and pairs
them. It has never known or cared what a client is running on.

We already prove this every day: `agent-session.ts` is a **headless Node
client with no DOM** that queues against browser clients and plays verified
matches. If a Node process and a browser can already share a match, a browser
on an Android handheld is not an interesting case — it is a strictly easier
one.

What actually guarantees a fair match is the `hello` handshake, which hard-gates
on two pins:

```ts
if (msg.v !== PROTOCOL_VERSION)     return send(c, { t: 'error', ... });
if (msg.engine !== ENGINE_VERSION)  return send(c, { t: 'error', ... });
```

Both sides run the same deterministic `@af/core` ([ADR 0001](decisions/0001-deterministic-fixed-point-core.md)) at the same
`ENGINE_VERSION`, or the server refuses the connection. Desync isn't handled;
it's made unrepresentable.

**So the netcode diff for PSG1 cross-play is zero lines.** Serve the same URL,
and there is no "cross" — it's one game with one queue.

That is also the design rule for this work, and the thing most likely to get
broken by accident:

> **One bundle, one `ENGINE_VERSION`, one queue.** The moment PSG1 gets its own
> build, its own fork of the sim, or its own queue, cross-play is gone and we
> own two games. Everything below is additive to the PWA and ships to every
> player at once.

## Then what is actually left?

Two things, and neither is PSG1-specific. Both are things a browser game with
touch controls should have anyway:

1. Gamepad input — we have none.
2. A layout that survives a 1240×1080 screen.

## The device, briefly

Only what matters here:

| | |
|---|---|
| OS | EchOS — Android fork, Chromium-based WebView/browser |
| SoC | RK3588S2, Mali-G610, 8 GB RAM |
| Display | 3.92" OLED, **1240×1080** |
| Input | D-pad, sticks, A/B/X/Y, L, R, Menu, Select. **No L2/R2** |
| Net | Wi-Fi 6 |

8 GB of RAM and a Mali-G610 running our fixed-point sim on a 960×540 canvas is
not a performance question. The RK3588S2 emulates GameCube.

## Gap 1 — Gamepad (the only real work)

`grep getGamepads packages/client/src` returns nothing. Input is keyboard
(`keydown`/`keyup` on `e.code`) and touch.

The button math lands exactly right, which is what usually kills a fighting
game on a handheld:

| Agent Fighter needs | PSG1 has |
|---|---|
| 4 directions | D-pad (+ left stick) |
| LP / MP / HP | Y / X / R |
| LK / MK / HK | B / A / L |

`Btn` ([input.ts](../packages/core/src/input.ts)) is 6 attack buttons + 4 directions. The PSG1 has exactly 6
usable action buttons. Nothing missing, nothing spare — and the missing L2/R2
cost us nothing, because we never bound them.

Add `packages/client/src/gamepad.ts`: poll `navigator.getGamepads()`, map to
`Btn`, OR into the existing `InputFrame`. `P0_MAP` is already a `[code, Btn][]`
table, so this is the same shape of thing next to it, feeding the same
`InputSource` seam. Keyboard and touch stay live alongside it.

One non-negotiable: **poll inside the fixed-timestep tick**, never on an event.
The Gamepad API is poll-only, and sampling it off the tick boundary
reintroduces exactly the input non-determinism ADR 0001 exists to prevent —
and with a shared queue, that lands as a desync in someone else's match.

This ships to everyone. Any browser player with a controller gets it. That is
the point — it isn't PSG1 work, it's gamepad support we lacked.

## Gap 2 — 1240×1080

`STAGE.viewportW/H` is 960×540 (16:9). The PSG1 panel is far squarer (~1.15:1).

Don't widen the camera to fill it. A fighting game's neutral *is* the
horizontal distance between fighters; widening changes spacing and footsies,
turns the goldens red, and forces an `ENGINE_VERSION` bump — which under one
shared queue means it isn't a PSG1 layout tweak anymore, it's a different game
that can't match against the web.

Pillar-safe instead: scale the 960×540 view to the full 1240 width → 1240×697,
and spend the leftover ~383 px band on HUD (health, meter, timer) that
currently overlays the play area. The sim camera is untouched, goldens stay
green, `ENGINE_VERSION` stays `af-core-1`. On a 3.92" screen, moving the HUD
out of the play area is a readability win rather than a consolation prize.

This is responsive work the PWA benefits from generally.

## How a PSG1 player reaches the PWA

The open question, and the only place "PWA-first" meets friction.

**PlayVERSE is not a shortcut here, despite the name.** It is the on-device
"Gaming dApp Store" — players discover, download, launch, and update games from
it, and it is how a PSG1 owner adds Solana games to their device. That is a
*player-facing* path, not a publishing one. Underneath it sits Play\<Gate\>,
described by Play Solana as "the onchain console publishing layer underpinning
PlayVERSE," which records submission receipts on Solana for **game builds** and
assets.

So "use the built-in PlayVERSE to add Web3 games" is the install story, not a
submit-a-URL story. PlayVERSE is the storefront over the same Play\<Gate\>
pipeline, and "download" + "update" imply artifacts. Nothing in Play Solana's
public material mentions HTML5, PWAs, browsers, or dApp links as a distribution
format — the phrase "dApp store" describes the games being on-chain, not the
games being web pages.

Two things worth noting from the same material, both of which back the plan:
Play Solana explicitly tells developers to **adapt their UI to 1240×1080 to
avoid scaling, border, and layout issues** (Gap 2, in their words), and there is
a **PSG1 DevKit** for approved developers — the clean way to do Phase 0 on real
hardware.

There is still no public "submit a URL" path, so the options are unchanged:

Three options, cheapest first:

1. **Just the browser + install to home screen.** EchOS is Android with a
   Chromium browser; `pwa.ts` already handles `beforeinstallprompt`. Zero work,
   zero submission, works today. But we are not in the launcher, so nobody
   finds us.
2. **A TWA shell** — a Trusted Web Activity is a browser tab in an APK, ~50 KB,
   no port, no forked build. It points at the Vercel URL and is the thinnest
   artifact that can go through Play\<Gate\> and land in the PlayVERSE catalog.
   Our service worker means it still works offline, which was my earlier
   objection to a TWA and no longer holds. **This is the recommendation if
   PlayVERSE presence matters.** It is a distribution shim, not a port — the PWA
   stays the product and the source of truth, and updates ship from Vercel
   without re-submitting.
3. Capacitor wrap — more control, more surface, a build to maintain. Not worth
   it for this scope.

Option 2 keeps the rule intact: same bundle, same `ENGINE_VERSION`, same queue.
The APK is a shortcut icon, and PSG1 players are in the same match pool as
everyone else because they are literally running the same build.

## Getting it onto our own PSG1 (today, no submission)

Different question from distribution, and a much easier one. Skip microSD — the
premise doesn't apply.

**There is no microSD slot.** The published specs are 128 GB eMMC with no
expandable storage; the box ships a USB-C cable. But the deeper point is that
**a PWA has no artifact to copy onto a card.** "Boot from microSD" is a mental
model for ROMs and native builds. There is no `.apk`, no ROM, no image — the
game is a URL. Nothing to put on a card even if a slot existed.

So, cheapest first:

1. **Open the Vercel URL in the device browser.** EchOS is Android with a
   Chromium browser and the device has Wi-Fi 6. This works today, with zero
   packaging, zero sideloading, and zero submission. `pwa.ts` then offers
   install-to-home-screen via `beforeinstallprompt`, and the service worker
   makes it offline-capable — at which point it looks and behaves like an
   installed game.
2. **Point it at our dev machine** for the actual iteration loop. `npm run play`
   already serves the bundle; put the PSG1 on the same Wi-Fi and hit
   `http://<dev-ip>:<port>`. Edit, refresh, test on real hardware — no rebuild,
   no reinstall, no cable. This is how Phases 1–2 should be developed, and it is
   a better loop than any native port would give us.
3. **Sideload an APK over USB-C (`adb install`)** — only relevant once there's a
   TWA shell to test, i.e. Phase 3. Not needed before that.

The device runs PS2/GameCube/Dreamcast emulation, which means users load ROMs
somehow, which means file access and general Android affordances are very
unlikely to be locked out. That is indirect evidence, not proof.

**The one thing to check first, and it takes two minutes:** does the EchOS
launcher actually expose a browser? Android underneath doesn't guarantee a
reachable browser app if the launcher is locked to PlayVERSE. Open a browser on
the device and load the Vercel URL. If it loads, Phase 0 is already done and
options 1–2 are real. If there is no browser, the "just use the PWA" path is
dead on the device and everything routes through a TWA in Phase 3 — which
inverts the plan's priorities and is worth knowing before writing any code.

## Plan

| Phase | Work | Est. |
|---|---|---|
| 0 | De-risk **on our own PSG1**: open the Vercel URL in the device browser. Does a browser exist? Does it hold 60 fps? Do the buttons enumerate via `navigator.getGamepads()`? | ½ day |
| 1 | `gamepad.ts` — poll in-tick, map to `Btn`, ships to all players | 1–2 days |
| 2 | Pillar-safe 1240×697 + HUD band. Goldens must stay green | 1–2 days |
| 3 | *(only if launcher presence matters)* TWA shell → Play\<Gate\> | 1 day + review |

Match server: no change. Queue: no change. `ENGINE_VERSION`: no change.

**Phase 0 kill criterion:** if the browser can't hold 60 fps on RK3588-class
hardware, stop. A 60 Hz fighting game that drops frames isn't shippable, and
under a shared queue a stuttering client is a bad match for the opponent too.

## Unverified

Two of these can move the plan:

- **Whether EchOS exposes a standard Gamepad API to its browser.** Assumed, and
  it is the biggest unknown. The Unity SDK advertises a "custom input system,"
  which hints the mapping may not be standard. If it isn't, we need button
  indices off real hardware. Phase 0 answers this.
- **Whether Play\<Gate\> / PlayVERSE accept a TWA.** That the pipeline takes
  APK/AAB "game builds" comes from Play Solana's public materials; the portal is
  sign-in gated and I could not read the spec. A TWA *is* a valid APK, but a
  curated store's policy may want a "real" game build, and PlayVERSE is
  described as curated. Worth asking directly before Phase 3 — and note that
  Phases 0–2 deliver a PSG1 player a working, controller-driven game in the
  device browser regardless of the answer.
- **Whether PlayVERSE has any unannounced web/dApp-link path.** Nothing public
  suggests one, but the catalog is young and it is a cheap question to ask
  alongside the TWA one.
- Panel orientation of the 1240×1080 screen, and any launcher metadata rules.

## Explicitly not doing

- Porting to Unity. The device is Android and the sim is engine-agnostic.
- A separate PSG1 build, fork, or queue. That would end cross-play.
- Solana wallet / Mobile Wallet Adapter. The device has a hardware wallet and we
  use AIR Kit ([auth.ts](../packages/client/src/auth.ts)) — but login is already optional and gates only
  XP/leaderboard, never the queue. So a PSG1 player can just play. Revisiting it
  means deciding whether credits go on-chain ([ADR 0004](decisions/0004-credits-economy.md)), which is a product
  question, not a cross-play one.
