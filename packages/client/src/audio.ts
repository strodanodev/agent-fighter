/**
 * Sound playback — Web Audio API, no dependency.
 *
 * Music (MusicId): the MvC: Clash of Super Heroes BRSTM rips (decoded/
 * re-encoded to ogg offline, see tools/README.md), one file per arcade-mode
 * screen. There's no dedicated stage BGM yet, so the 4 "Ending" themes double
 * as the title-screen loop AND the in-match stage loop (ROTATION), picked
 * round-robin so neither screen repeats the same track back-to-back.
 *
 * Hit SFX (SfxId): a 10-clip pack (sounds/SFX HITS/, see tools/README.md)
 * covering swing, punch/kick impact by weight class, block, and a combo
 * accent. `hitSfxFor()` maps a connecting move's button (LP/MP/HP/LK/MK/HK)
 * to the right impact clip — the client-side juice layer (main.ts) is the
 * only caller, keyed off `attackConnected` state changes per the "cosmetic
 * effects live client-side, never inside the sim" rule.
 */

export type MusicId =
  | 'continue' | 'ending_after_the_battle' | 'ending_gambit' | 'ending_grief' | 'ending_megaman1'
  | 'game_over' | 'here_comes_a_new_challenger' | 'hurry_up' | 'player_select' | 'ranking' | 'vs' | 'win';

export type SfxId =
  | 'swing_a' | 'swing_b'
  | 'punch_light' | 'punch_medium' | 'punch_heavy_a' | 'punch_heavy_b'
  | 'kick_light' | 'kick_heavy'
  | 'block_hit' | 'combo_accent';

type SoundId = MusicId | SfxId;

const MUSIC_FILES: Record<MusicId, string> = {
  continue: '/assets/audio/bgm/continue.ogg',
  ending_after_the_battle: '/assets/audio/bgm/ending_after_the_battle.ogg',
  ending_gambit: '/assets/audio/bgm/ending_gambit.ogg',
  ending_grief: '/assets/audio/bgm/ending_grief.ogg',
  ending_megaman1: '/assets/audio/bgm/ending_megaman1.ogg',
  game_over: '/assets/audio/bgm/game_over.ogg',
  here_comes_a_new_challenger: '/assets/audio/bgm/here_comes_a_new_challenger.ogg',
  hurry_up: '/assets/audio/bgm/hurry_up.ogg',
  player_select: '/assets/audio/bgm/player_select.ogg',
  ranking: '/assets/audio/bgm/ranking.ogg',
  vs: '/assets/audio/bgm/vs.ogg',
  win: '/assets/audio/bgm/win.ogg',
};

const SFX_FILES: Record<SfxId, string> = {
  swing_a: '/assets/audio/sfx/swing_a.mp3',
  swing_b: '/assets/audio/sfx/swing_b.mp3',
  punch_light: '/assets/audio/sfx/punch_light.mp3',
  punch_medium: '/assets/audio/sfx/punch_medium.mp3',
  punch_heavy_a: '/assets/audio/sfx/punch_heavy_a.mp3',
  punch_heavy_b: '/assets/audio/sfx/punch_heavy_b.mp3',
  kick_light: '/assets/audio/sfx/kick_light.mp3',
  kick_heavy: '/assets/audio/sfx/kick_heavy.mp3',
  block_hit: '/assets/audio/sfx/block_hit.mp3',
  combo_accent: '/assets/audio/sfx/combo_accent.mp3',
};

const FILES: Record<SoundId, string> = { ...MUSIC_FILES, ...SFX_FILES };

/** Shared title-screen / stage-BGM pool — the 4 "Ending" themes. */
export const ROTATION: MusicId[] = [
  'ending_after_the_battle', 'ending_gambit', 'ending_grief', 'ending_megaman1',
];

/** Every button's normal-hit weight class → which impact clip(s) to draw from. */
const PUNCH: Record<'L' | 'M' | 'H', SfxId[]> = {
  L: ['punch_light'], M: ['punch_medium'], H: ['punch_heavy_a', 'punch_heavy_b'],
};
const KICK: Record<'L' | 'M' | 'H', SfxId[]> = {
  L: ['kick_light'], M: ['kick_light'], H: ['kick_heavy'], // only 2 kick clips in the pack
};
const SWING: SfxId[] = ['swing_a', 'swing_b'];

/** Picks the impact clip for a connecting normal, e.g. hitSfxFor('HP') → a heavy punch variant. */
export const hitSfxFor = (button: string | undefined): SfxId => {
  const kind: 'L' | 'M' | 'H' = button?.[0] === 'L' ? 'L' : button?.[0] === 'H' ? 'H' : 'M';
  const pool = button?.[1] === 'K' ? KICK[kind] : PUNCH[kind];
  return pool[Math.floor(Math.random() * pool.length)]!;
};

/** Every swing gets a whiff swoosh, whether or not it lands — classic fighting-game layering. */
export const swingSfx = (): SfxId => SWING[Math.floor(Math.random() * SWING.length)]!;

const BGM_LEVEL = 0.55;
const SFX_LEVEL = 0.85;
const DUCK_LEVEL = 0.12;

class AudioManager {
  private ctx: AudioContext | null = null;
  private bgmGain: GainNode | null = null;
  private sfxGain: GainNode | null = null;
  private buffers = new Map<SoundId, AudioBuffer>();
  private loading = new Map<SoundId, Promise<AudioBuffer>>();
  private bgmSource: AudioBufferSourceNode | null = null;
  private bgmId: MusicId | null = null;
  private rotationIndex = 0;
  private unlocked = false;

  private ctxOf(): AudioContext {
    if (!this.ctx) {
      // Safari (esp. older iOS) still exposes webkitAudioContext as the ctor.
      const g = globalThis as typeof globalThis & {
        AudioContext?: typeof AudioContext;
        webkitAudioContext?: typeof AudioContext;
      };
      const AC = g.AudioContext || g.webkitAudioContext;
      if (!AC) throw new Error('Web Audio API unavailable');
      const ctx = new AC();
      this.bgmGain = ctx.createGain();
      this.bgmGain.gain.value = BGM_LEVEL;
      this.bgmGain.connect(ctx.destination);
      this.sfxGain = ctx.createGain();
      this.sfxGain.gain.value = SFX_LEVEL;
      this.sfxGain.connect(ctx.destination);
      this.ctx = ctx;
    }
    return this.ctx;
  }

  /** Browsers block audio until a user gesture — call from the first input. */
  unlock(): void {
    if (this.unlocked) return;
    this.unlocked = true;
    const ctx = this.ctxOf();
    if (ctx.state === 'suspended') void ctx.resume();
  }

  /** True when this engine can decode Ogg Vorbis (Safari / iOS: never). */
  private static canOgg(): boolean {
    try {
      const a = document.createElement('audio');
      return a.canPlayType('audio/ogg; codecs="vorbis"') !== '';
    } catch {
      return false;
    }
  }

  /**
   * Candidate URLs for a clip. iOS/Safari cannot decode Ogg Vorbis, so any
   * `.ogg` path is paired with a `.mp3` sibling — prefer mp3 when ogg is
   * unsupported. Decode failures fall through the list silently.
   */
  private urlsFor(id: SoundId): string[] {
    const primary = FILES[id];
    if (!primary.endsWith('.ogg')) return [primary];
    const mp3 = primary.slice(0, -4) + '.mp3';
    return AudioManager.canOgg() ? [primary, mp3] : [mp3, primary];
  }

  private load(id: SoundId): Promise<AudioBuffer> {
    const cached = this.buffers.get(id);
    if (cached) return Promise.resolve(cached);
    const pending = this.loading.get(id);
    if (pending) return pending;
    const ctx = this.ctxOf();
    const urls = this.urlsFor(id);
    const p = (async (): Promise<AudioBuffer> => {
      let lastErr: unknown;
      for (const url of urls) {
        try {
          const res = await fetch(url);
          if (!res.ok) { lastErr = new Error(`${url} → ${res.status}`); continue; }
          const raw = await res.arrayBuffer();
          // copy: decodeAudioData may detach the buffer; keep retries clean
          const decoded = await ctx.decodeAudioData(raw.slice(0));
          this.buffers.set(id, decoded);
          return decoded;
        } catch (e) {
          lastErr = e;
        }
      }
      throw lastErr instanceof Error ? lastErr : new Error(`audio load failed: ${id}`);
    })().finally(() => { this.loading.delete(id); });
    this.loading.set(id, p);
    return p;
  }

  /** Warm the decode cache for every track/clip — total payload is ~6MB. */
  preload(): void {
    for (const id of Object.keys(FILES) as SoundId[]) void this.load(id);
  }

  /** Next track in the shared title/stage rotation pool. */
  nextRotationTrack(): MusicId {
    const id = ROTATION[this.rotationIndex % ROTATION.length]!;
    this.rotationIndex++;
    return id;
  }

  stopBgm(): void {
    if (this.bgmSource) {
      try { this.bgmSource.stop(); } catch { /* already stopped */ }
      this.bgmSource.disconnect();
      this.bgmSource = null;
    }
    this.bgmId = null;
  }

  /** Loop a track as the current BGM. No-op if it's already the active loop. */
  async playBgm(id: MusicId, opts: { fadeInSec?: number } = {}): Promise<void> {
    if (this.bgmId === id) return;
    try {
      const ctx = this.ctxOf();
      const buffer = await this.load(id);
      this.stopBgm();
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.loop = true;
      src.connect(this.bgmGain!);
      const fade = opts.fadeInSec ?? 0;
      if (fade > 0 && this.bgmGain) {
        this.bgmGain.gain.cancelScheduledValues(ctx.currentTime);
        this.bgmGain.gain.setValueAtTime(0, ctx.currentTime);
        this.bgmGain.gain.linearRampToValueAtTime(BGM_LEVEL, ctx.currentTime + fade);
      } else if (this.bgmGain) {
        this.bgmGain.gain.cancelScheduledValues(ctx.currentTime);
        this.bgmGain.gain.setValueAtTime(BGM_LEVEL, ctx.currentTime);
      }
      src.start();
      this.bgmSource = src;
      this.bgmId = id;
    } catch {
      /* iOS without a playable BGM codec, or offline — game stays silent */
    }
  }

  /**
   * One-shot jingle (VS splash, win/lose stinger, challenger reveal, hurry-up
   * warning). Ducks the BGM bed while it plays and restores after.
   */
  async playStinger(id: MusicId, opts: { duck?: boolean; onEnded?: () => void } = {}): Promise<void> {
    try {
      const ctx = this.ctxOf();
      const buffer = await this.load(id);
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(this.sfxGain!);
      const duck = opts.duck ?? true;
      if (duck && this.bgmGain) {
        this.bgmGain.gain.cancelScheduledValues(ctx.currentTime);
        this.bgmGain.gain.setTargetAtTime(DUCK_LEVEL, ctx.currentTime, 0.05);
      }
      src.onended = () => {
        if (duck && this.bgmGain) this.bgmGain.gain.setTargetAtTime(BGM_LEVEL, ctx.currentTime, 0.4);
        opts.onEnded?.();
      };
      src.start();
    } catch {
      opts.onEnded?.(); // still advance BGM sequencing if the stinger can't decode
    }
  }

  /**
   * Fire-and-forget hit/impact clip. Freely overlaps (each call is its own
   * source node) — combat routinely needs two of these in the same tick
   * (P1's swing landing while P2's counter also connects). A small random
   * pitch/gain wobble keeps rapid-fire jabs from sounding mechanically
   * identical.
   */
  playSfx(id: SfxId, opts: { volume?: number } = {}): void {
    const ctx = this.ctxOf();
    void this.load(id).then((buffer) => {
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.playbackRate.value = 0.94 + Math.random() * 0.12;
      const gain = ctx.createGain();
      gain.gain.value = (opts.volume ?? 1) * (0.9 + Math.random() * 0.1);
      src.connect(gain);
      gain.connect(this.sfxGain!);
      src.start();
    });
  }
}

export const audio = new AudioManager();
