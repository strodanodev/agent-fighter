/**
 * Music playback — Web Audio API, no dependency. Source tracks are the MvC:
 * Clash of Super Heroes BRSTM rips (decoded/re-encoded to ogg offline, see
 * tools/README.md), one file per arcade-mode screen. There's no dedicated
 * stage BGM yet, so the 4 "Ending" themes double as the title-screen loop
 * AND the in-match stage loop (ROTATION), picked round-robin so neither
 * screen repeats the same track back-to-back.
 */

export type MusicId =
  | 'continue' | 'ending_after_the_battle' | 'ending_gambit' | 'ending_grief' | 'ending_megaman1'
  | 'game_over' | 'here_comes_a_new_challenger' | 'hurry_up' | 'player_select' | 'ranking' | 'vs' | 'win';

const FILES: Record<MusicId, string> = {
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

/** Shared title-screen / stage-BGM pool — the 4 "Ending" themes. */
export const ROTATION: MusicId[] = [
  'ending_after_the_battle', 'ending_gambit', 'ending_grief', 'ending_megaman1',
];

const BGM_LEVEL = 0.55;
const SFX_LEVEL = 0.85;
const DUCK_LEVEL = 0.12;

class AudioManager {
  private ctx: AudioContext | null = null;
  private bgmGain: GainNode | null = null;
  private sfxGain: GainNode | null = null;
  private buffers = new Map<MusicId, AudioBuffer>();
  private loading = new Map<MusicId, Promise<AudioBuffer>>();
  private bgmSource: AudioBufferSourceNode | null = null;
  private bgmId: MusicId | null = null;
  private rotationIndex = 0;
  private unlocked = false;

  private ctxOf(): AudioContext {
    if (!this.ctx) {
      const ctx = new AudioContext();
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

  private load(id: MusicId): Promise<AudioBuffer> {
    const cached = this.buffers.get(id);
    if (cached) return Promise.resolve(cached);
    const pending = this.loading.get(id);
    if (pending) return pending;
    const ctx = this.ctxOf();
    const p = fetch(FILES[id])
      .then((r) => r.arrayBuffer())
      .then((raw) => ctx.decodeAudioData(raw))
      .then((decoded) => {
        this.buffers.set(id, decoded);
        this.loading.delete(id);
        return decoded;
      });
    this.loading.set(id, p);
    return p;
  }

  /** Warm the decode cache for every track — total payload is ~5.7MB. */
  preload(): void {
    for (const id of Object.keys(FILES) as MusicId[]) void this.load(id);
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
  }

  /**
   * One-shot jingle (VS splash, win/lose stinger, challenger reveal, hurry-up
   * warning). Ducks the BGM bed while it plays and restores after.
   */
  async playStinger(id: MusicId, opts: { duck?: boolean; onEnded?: () => void } = {}): Promise<void> {
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
  }
}

export const audio = new AudioManager();
