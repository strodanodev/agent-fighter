# M1 Feel Gate — playtest brief

> **The one gate that can invalidate everything downstream.** Build-spec §10 is
> blunt: *"Milestones 0–1 are the whole ballgame: if the core doesn't feel like
> MvC with one character, nothing downstream matters."* Studio, 12 characters,
> netcode, and the economy are all stacked on an assumption no external MvC
> player has confirmed yet. This is how you confirm it. It is the cheapest it
> will ever be — the roster only makes retuning more expensive.
>
> **This gate is human by definition.** No automated check can answer "does it
> feel right?" — that is the entire point. What's automated is everything
> *around* it: the build is live, playable guest-first, and (as of af-core-7)
> free of the freeze/crash bugs that would have poisoned a playtest.

## Who to get

**2–3 people who actually play Marvel vs Capcom** (or a comparable air-dasher —
MvC2/3, DBFZ, Skullgirls). Not fighting-game-curious; people whose hands know
what a magic series and a launcher-into-air-combo are supposed to feel like.
One is enough to learn something; three lets you separate a personal quirk from
a real problem.

## Setup — zero friction, no account

1. Send them **https://agent-fighter.vercel.app**.
2. Press **Enter**, pick a fighter (**G** or any attack button confirms) — a
   practice match vs the AI starts immediately. **No sign-in, no credits.**
   (Sign-in only matters for ranked/wager, which the feel gate does not touch.)
3. Press **B** to toggle the hitbox + frame-data overlay if they want to see it.
4. **Enter** rematches. That's the whole loop.

### Controls (Player 1)

| | Move | LP · MP · HP | LK · MK · HK |
|---|---|---|---|
| Keys | **W A S D** | **T Y U** | **G H J** |

- **Magic series (chains):** L → M → H → **2HP** (launcher)
- **Air combo:** after the launcher, **hold up** to super-jump, then j.LP→j.MP→**j.HP / j.HK**
- **Specials:** **236+P** fireball · **623+P** dragon punch · **214+K** advancing kick
- **Super:** **236+PP** (needs 1 meter bar)
- **Defense:** hold **back** (down-back for lows) · **pushblock:** two punches during blockstun
- **Throw:** close + **4/6 + HP** (HP inside the window techs it)
- **Movement:** double-tap a direction to **dash** · tap **down→up** to **super-jump** · **double jump** · **air-dash**

## The one question

> **Does this feel like Marvel vs Capcom?**

Everything below is just structure for *why* their gut says yes or no. Let them
play for ten minutes first, then walk these. Capture the answer in their words —
verbatim beats paraphrase.

| Dimension | What you're probing | Feels-wrong tells |
|---|---|---|
| **Chain rhythm** | Do L→M→H cancels flow, or fight you? | Cancels drop; window feels too tight/too loose; mashy |
| **Launcher → air** | Does 2HP → super-jump → air chain connect and read as one combo? | Launch height/timing off; air chain whiffs; juggle ends early |
| **Motion inputs** | Do 236/623/214 come out **when intended**, and not when not? | Fireballs eat your normals; DP won't come out; accidental specials |
| **Impact / hitstop** | Do hits feel like they *land* — weight, freeze, feedback? | Hits feel weightless; no "crunch"; hitstop too short/long |
| **Super** | Does the flash + freeze land dramatically? Meter build honest? | Anticlimactic; meter too fast/slow; freeze feels cheap |
| **Neutral & movement** | Dash, super-jump, air-dash — mobile enough to feel MvC? | Sluggish; floaty; can't approach; ground feels stuck |
| **Blocking / pushback** | Blockstun + pushback + pushblock spacing right? | Pushback too far/short; chip surprising; pushblock useless |
| **Damage pacing** | Do combos do a *satisfying but not instant* chunk? | TODs everywhere, or combos tickle; scaling feels wrong |

Two closing questions worth asking every tester:
- **"What's the first thing you'd change?"** — the highest-signal answer.
- **"Would you play a second match?"** — the honest verdict under the analysis.

## What to do with the answers

Everything they'll flag is a **data knob, not a rewrite** — that's the whole
point of the declarative design:

- Global feel → **`TUNING`** in [`packages/core/src/data.ts`](../packages/core/src/data.ts)
  (hitstop, gravity, pushback, damage scaling, meter rates, super-jump velocity).
- Per-move frame data / launch velocities → the character bundle
  ([`packages/core/src/characters/analog.ts`](../packages/core/src/characters/analog.ts)
  is character #1).
- Any sim-behaviour change bumps `ENGINE_VERSION` + re-blesses goldens (the
  golden test tells you) and needs a **paired deploy**.

**Retune → redeploy → re-test the same players.** Two or three tight loops with
the same MvC hands is worth more than a wide survey.

## Gate outcome

- **Pass:** the MvC players say it feels right (with tuning notes). Record it —
  this unblocks everything downstream and it has never been recorded.
- **Fail:** it feels floaty / stiff / mistimed. **Then this is the only work that
  matters** until it passes; the roster and economy can wait. Better to hear it
  now than after a launch push.
