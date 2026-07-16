/**
 * Transcode packages/client/assets/audio/bgm/*.ogg → sibling .mp3 files.
 * iOS Safari cannot decode Ogg Vorbis; the client falls back to these mp3s.
 *
 * Usage (from repo root or packages/client):
 *   node packages/client/tools/ogg-to-mp3.mjs
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const bgmDir = join(here, '..', 'assets', 'audio', 'bgm');
const require = createRequire(import.meta.url);

let ffmpeg = 'ffmpeg';
try {
  ffmpeg = require('ffmpeg-static');
} catch {
  /* use PATH */
}

if (!existsSync(bgmDir)) {
  console.error('ogg-to-mp3: missing', bgmDir);
  process.exit(1);
}

const oggs = readdirSync(bgmDir).filter((f) => f.endsWith('.ogg'));
if (oggs.length === 0) {
  console.error('ogg-to-mp3: no .ogg files in', bgmDir);
  process.exit(1);
}

let ok = 0;
for (const name of oggs) {
  const src = join(bgmDir, name);
  const dst = join(bgmDir, name.replace(/\.ogg$/i, '.mp3'));
  if (existsSync(dst)) {
    console.log(`skip  ${name} (mp3 exists)`);
    ok++;
    continue;
  }
  const r = spawnSync(ffmpeg, [
    '-y', '-i', src, '-codec:a', 'libmp3lame', '-qscale:a', '4', dst,
  ], { stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`fail  ${name}`);
    process.exit(r.status ?? 1);
  }
  console.log(`wrote ${name.replace(/\.ogg$/i, '.mp3')}`);
  ok++;
}
console.log(`ogg-to-mp3: ${ok}/${oggs.length} ready`);
