# Audio conversion tools (not committed)

`vgmstream/` and `ffmpeg/` are portable, no-install binaries used once to
convert the MvC: Clash of Super Heroes `.brstm` rips in `../sounds/` (also
gitignored — unclear license, kept local-only) into the `.ogg` files that
actually ship in `packages/client/assets/audio/bgm/`.

Re-run if you add more `.brstm` tracks:

```sh
VG=tools/vgmstream/vgmstream-cli.exe
FF=tools/ffmpeg/bin/ffmpeg.exe
"$VG" -o out.wav "sounds/Some Track.brstm"
"$FF" -y -i out.wav -c:a libvorbis -q:a 4 packages/client/assets/audio/bgm/some_track.ogg
```

Re-download the tools themselves from their official GitHub releases if this
folder is ever wiped:
- vgmstream-cli: https://github.com/vgmstream/vgmstream/releases (`*-win64.zip`)
- ffmpeg: https://github.com/BtbN/FFmpeg-Builds/releases (`*-win64-gpl*.zip`)

## Sound library layout (`sounds/<N>. <Category>/`)

The source library is organized by category; every raw filename already
states its in-game purpose. Shipped ids and exact `SFX_FILES`/`MUSIC_FILES`
paths live in `packages/client/src/audio.ts` — this is just the raw→shipped
map for re-running the conversion.

- **`1. BGM/`** — `.brstm` rips → `packages/client/assets/audio/bgm/*.ogg`
  (vgmstream + ffmpeg, same pipeline as above). One arcade-mode screen each:
  Continue screen, Game Over, Here Comes a New Challenger, Hurry Up, Player
  Select, Ranking, Versus → `vs`, You Win → `win`. Plus **`Home Sceen.mp3`**
  (sic — source typo) → `home_screen.mp3` and **`Home Screen Alternate.mp3`**
  → `home_screen_alt.mp3` (both copied as-is, mp3) — `HOME_ROTATION`, the
  title-screen pool. Title does not draw from `ROTATION` (the in-match stage
  pool); `nextHomeTrack()` picks one of the two at random per title-screen
  entry (never the same track twice in a row), same pattern as stage BGM.
- **`2. SFX HITS/`** — mostly already-shipped mp3s (Swoosh 01_02/02_01 →
  `swing_a`/`swing_b`, swooth & hit 1/2/3 → `punch_light`/`medium`/
  `heavy_a`, Hit 1 → `punch_heavy_b`, Hit 2x → `combo_accent`, Kick 1/2 →
  `kick_heavy`/`kick_light`, Block → `block_hit`) plus one new file,
  **`special attack.wav`** → `special_hit.mp3` (ffmpeg to mp3) — the impact
  clip for any connecting `special`/`super` move, overriding the normal
  punch/kick weight pick (see the `updateJuice` call site in `main.ts`).
- **`3. Credits/`** → `bgm/credits.mp3` (copied as-is, mp3). Plays instead of
  the usual `ranking` loop the moment an AGENT ARCADE run is fully cleared
  (`arcade.stage + 1 >= arcade.total` on the win branch) — the closest thing
  this build has to an arcade ending/credits roll.
- **`4. FX/`** → `character select confirmed.wav` → `sfx/select_confirm.mp3`
  (ffmpeg to mp3; plays on the character-lock press in `tickSelect`), `you
  lose.mp3` → `sfx/you_lose.mp3` (copied as-is; layers over the `game_over`
  stinger whenever the human/local side is the one losing).
- **`agent_fighter_main_SFX.mp3`** (library root) → `sfx/title_intro.mp3`
  (copied as-is, mp3) — the MAIN-SCENE sting. ~11s, musical, fires once on
  every entry into the title screen and never loops; the trigger is the
  `lastScreen` watcher at the top of `frame()` in `main.ts`, so it covers
  boot and every back-out path without any call site opting in. Played with
  `vary: false` so `playSfx`'s combat pitch wobble doesn't detune it.
- **`5. Voice FX/`** → `voice/fight_call_a.mp3` / `fight_call_b.mp3` (copied
  as-is from `Main FX 1.mp3` / `Main FX 3.mp3`). **Guessed mapping** — the
  source names aren't self-describing like the other categories, so these
  were assigned to the round-start "FIGHT!" announcer callout (one picked at
  random each round) as the single most obvious "generic voice FX" moment;
  correct the mapping in `audio.ts` if that's not what they actually are.
- **`6. Voice Hits/`** → `voice/*.mp3` (ffmpeg to mp3). Hit 1-4 → light pain
  grunt on any hit taken; Ouch 1-3 → heavy pain grunt (damage > 600, same
  threshold as the screen-shake "big hit" flag); Ouch long → K.O. bark on
  `Phase.RoundOver`; Hiya 1/2 → occasional (30%) kiai on a connecting-normal
  swing; kick special shoryuken → voice callout on any move with
  `motion === 623` (the DP-motion uppercut); projectile hadouken → voice
  callout on any move with `motion === 236` (the fireball-motion special).
- **`7. Stage Music/`** → `stage music (1..6).mp3` → `bgm/stage_1..6.mp3`
  (copied as-is, mp3) — `ROTATION`, the in-match stage-BGM pool.
  `nextRotationTrack()` picks one at RANDOM per battle (never the same track
  twice in a row), not round-robin. This replaced the original 3 "Ending"
  themes that used to double as stage music (now removed from the library
  entirely — asset files deleted, `ending_*` ids dropped from `MusicId`,
  `ending_megaman1` included, since nothing else referenced any of them).
