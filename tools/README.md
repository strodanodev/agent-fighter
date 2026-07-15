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
