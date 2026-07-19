/**
 * Sound playback — Web Audio API, no dependency. Source library lives in
 * `sounds/<N>. <Category>/` (see tools/README.md for the raw→shipped
 * mapping); every id below is named for what it's FOR, not the source
 * filename.
 *
 * Music (MusicId): the MvC: Clash of Super Heroes BRSTM rips, one file per
 * arcade-mode screen, plus `credits` (a non-canon victory jingle that rolls
 * after an AGENT ARCADE full clear). There's no dedicated stage BGM yet, so
 * the 4 "Ending" themes double as the title-screen loop AND the in-match
 * stage loop (ROTATION), picked round-robin so neither screen repeats the
 * same track back-to-back.
 *
 * SFX (SfxId): impact/block/combo clips (weight-classed by button, see
 * `hitSfxFor`), menu stingers (select_confirm, you_lose), the announcer's
 * fight-call, and the character voice-bark pack (hit/ouch reactions on
 * taking damage, hiya kiai on some swings, shoryuken/hadouken callouts on
 * their matching motion specials). The client-side juice layer (main.ts) is
 * the only caller, keyed off GameState changes per the "cosmetic effects
 * live client-side, never inside the sim" rule.
 */

export type MusicId =
  | 'continue' | 'ending_after_the_battle' | 'ending_gambit' | 'ending_grief' | 'ending_megaman1'
  | 'game_over' | 'here_comes_a_new_challenger' | 'hurry_up' | 'player_select' | 'ranking' | 'vs' | 'win'
  | 'credits';

export type SfxId =
  | 'swing_a' | 'swing_b'
  | 'punch_light' | 'punch_medium' | 'punch_heavy_a' | 'punch_heavy_b'
  | 'kick_light' | 'kick_heavy' | 'special_hit'
  | 'block_hit' | 'combo_accent'
  | 'select_confirm' | 'you_lose'
  | 'fight_call_a' | 'fight_call_b'
  | 'hit_1' | 'hit_2' | 'hit_3' | 'hit_4'
  | 'hiya_1' | 'hiya_2'
  | 'ouch_1' | 'ouch_2' | 'ouch_3' | 'ouch_long'
  | 'shoryuken' | 'hadouken';

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
  // Rolls after an AGENT ARCADE full clear — mp3-only (no ogg sibling), the
  // urlsFor() fallback logic only kicks in for `.ogg` primaries so this is
  // served as-is everywhere.
  credits: '/assets/audio/bgm/credits.mp3',
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
  special_hit: '/assets/audio/sfx/special_hit.mp3',
  block_hit: '/assets/audio/sfx/block_hit.mp3',
  combo_accent: '/assets/audio/sfx/combo_accent.mp3',
  select_confirm: '/assets/audio/sfx/select_confirm.mp3',
  you_lose: '/assets/audio/sfx/you_lose.mp3',
  fight_call_a: '/assets/audio/voice/fight_call_a.mp3',
  fight_call_b: '/assets/audio/voice/fight_call_b.mp3',
  hit_1: '/assets/audio/voice/hit_1.mp3',
  hit_2: '/assets/audio/voice/hit_2.mp3',
  hit_3: '/assets/audio/voice/hit_3.mp3',
  hit_4: '/assets/audio/voice/hit_4.mp3',
  hiya_1: '/assets/audio/voice/hiya_1.mp3',
  hiya_2: '/assets/audio/voice/hiya_2.mp3',
  ouch_1: '/assets/audio/voice/ouch_1.mp3',
  ouch_2: '/assets/audio/voice/ouch_2.mp3',
  ouch_3: '/assets/audio/voice/ouch_3.mp3',
  ouch_long: '/assets/audio/voice/ouch_long.mp3',
  shoryuken: '/assets/audio/voice/shoryuken.mp3',
  hadouken: '/assets/audio/voice/hadouken.mp3',
};

const FILES: Record<SoundId, string> = { ...MUSIC_FILES, ...SFX_FILES };

/** Shared title-screen / stage-BGM pool — the 4 "Ending" themes. */
export const ROTATION: MusicId[] = [
  'ending_after_the_battle', 'ending_gambit', 'ending_grief', 'ending_megaman1',
];

/**
 * Short music-typed clips (a few seconds each) that fire mid-flow — worth
 * keeping decoded so stingers stay instant. The LONG tracks are everything
 * else in MUSIC_FILES and are decode-on-play + evicted (see preload()).
 */
const BGM_STINGERS: MusicId[] = ['vs', 'here_comes_a_new_challenger', 'hurry_up', 'win'];

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

/** Independent mute buses exposed by the title-screen audio menu. */
export type AudioChannel = 'music' | 'sfx' | 'hits';

/**
 * Combat clips (impact, block, combo accent, and every character voice bark)
 * ride the Hits bus. Menu/announcer stingers (swing whoosh, select confirm,
 * fight-call, you-lose) ride the SFX bus — that split is what the title
 * screen's Music/SFX/Hits toggles actually mute.
 */
const HIT_SFX: ReadonlySet<SfxId> = new Set([
  'punch_light', 'punch_medium', 'punch_heavy_a', 'punch_heavy_b',
  'kick_light', 'kick_heavy', 'special_hit', 'block_hit', 'combo_accent',
  'hit_1', 'hit_2', 'hit_3', 'hit_4', 'hiya_1', 'hiya_2',
  'ouch_1', 'ouch_2', 'ouch_3', 'ouch_long', 'shoryuken', 'hadouken',
]);

const AUDIO_PREFS_KEY = 'af-audio-mute';

interface AudioMutePrefs {
  master: boolean;
  music: boolean;
  sfx: boolean;
  hits: boolean;
}

const defaultMutePrefs = (): AudioMutePrefs => ({
  master: false, music: false, sfx: false, hits: false,
});

const loadMutePrefs = (): AudioMutePrefs => {
  try {
    const raw = localStorage.getItem(AUDIO_PREFS_KEY);
    if (!raw) return defaultMutePrefs();
    const p = JSON.parse(raw) as Partial<AudioMutePrefs>;
    return {
      master: !!p.master,
      music: !!p.music,
      sfx: !!p.sfx,
      hits: !!p.hits,
    };
  } catch {
    return defaultMutePrefs();
  }
};

const saveMutePrefs = (p: AudioMutePrefs): void => {
  try { localStorage.setItem(AUDIO_PREFS_KEY, JSON.stringify(p)); } catch { /* private mode */ }
};

class AudioManager {
  private ctx: AudioContext | null = null;
  private bgmGain: GainNode | null = null;
  private sfxGain: GainNode | null = null;
  private hitsGain: GainNode | null = null;
  private buffers = new Map<SoundId, AudioBuffer>();
  private loading = new Map<SoundId, Promise<AudioBuffer>>();
  private bgmSource: AudioBufferSourceNode | null = null;
  private bgmId: MusicId | null = null;
  private rotationIndex = 0;
  private unlocked = false;
  private prefs = loadMutePrefs();

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
      this.bgmGain.connect(ctx.destination);
      this.sfxGain = ctx.createGain();
      this.sfxGain.connect(ctx.destination);
      this.hitsGain = ctx.createGain();
      this.hitsGain.connect(ctx.destination);
      this.ctx = ctx;
      this.applyGains();
    }
    return this.ctx;
  }

  isMasterMuted(): boolean { return this.prefs.master; }
  isChannelMuted(ch: AudioChannel): boolean { return this.prefs[ch]; }

  /** One-tap master mute — silences every bus instantly. */
  toggleMaster(): void {
    this.prefs.master = !this.prefs.master;
    this.persistAndApply();
  }

  toggleChannel(ch: AudioChannel): void {
    this.prefs[ch] = !this.prefs[ch];
    this.persistAndApply();
  }

  private persistAndApply(): void {
    saveMutePrefs(this.prefs);
    this.applyGains();
  }

  private musicLevel(): number {
    return (this.prefs.master || this.prefs.music) ? 0 : BGM_LEVEL;
  }
  private sfxLevel(): number {
    return (this.prefs.master || this.prefs.sfx) ? 0 : SFX_LEVEL;
  }
  private hitsLevel(): number {
    return (this.prefs.master || this.prefs.hits) ? 0 : SFX_LEVEL;
  }
  private duckLevel(): number {
    return (this.prefs.master || this.prefs.music) ? 0 : DUCK_LEVEL;
  }

  /** Snap every bus to its current mute state (instant — no fade). */
  private applyGains(): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    if (this.bgmGain) {
      this.bgmGain.gain.cancelScheduledValues(t);
      this.bgmGain.gain.setValueAtTime(this.musicLevel(), t);
    }
    if (this.sfxGain) {
      this.sfxGain.gain.cancelScheduledValues(t);
      this.sfxGain.gain.setValueAtTime(this.sfxLevel(), t);
    }
    if (this.hitsGain) {
      this.hitsGain.gain.cancelScheduledValues(t);
      this.hitsGain.gain.setValueAtTime(this.hitsLevel(), t);
    }
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

  /**
   * Warm the decode cache for the SMALL clips only: sfx/voice + the short
   * BGM stingers. The full-length tracks are deliberately NOT preloaded —
   * decoded PCM is ~2MB/second, so eagerly decoding all 13 BGM tracks held
   * 300-400MB resident, which is past the iOS PWA jetsam threshold: the
   * game "crashed after a few arcade matches" exactly as the rotation
   * filled this cache. Long tracks decode on first play and are EVICTED
   * when the next one starts (see evictLongMusic).
   */
  preload(): void {
    for (const id of Object.keys(SFX_FILES) as SoundId[]) void this.load(id);
    for (const id of BGM_STINGERS) void this.load(id);
  }

  /**
   * Drop every decoded LONG music buffer except `keep`. Duration-keyed
   * (>30s = a full track), so the short stingers stay warm and cheap while
   * at most ONE full track's PCM is ever resident. Called whenever a new
   * BGM loop starts.
   */
  private evictLongMusic(keep: MusicId | null): void {
    for (const [id, buf] of this.buffers) {
      if (id === keep) continue;
      if ((id as string) in MUSIC_FILES && buf.duration > 30) this.buffers.delete(id);
    }
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
      const target = this.musicLevel();
      const fade = opts.fadeInSec ?? 0;
      if (fade > 0 && this.bgmGain && target > 0) {
        this.bgmGain.gain.cancelScheduledValues(ctx.currentTime);
        this.bgmGain.gain.setValueAtTime(0, ctx.currentTime);
        this.bgmGain.gain.linearRampToValueAtTime(target, ctx.currentTime + fade);
      } else if (this.bgmGain) {
        this.bgmGain.gain.cancelScheduledValues(ctx.currentTime);
        this.bgmGain.gain.setValueAtTime(target, ctx.currentTime);
      }
      src.start();
      this.bgmSource = src;
      this.bgmId = id;
      // Keep at most ONE full track's decoded PCM resident (iOS jetsam guard).
      this.evictLongMusic(id);
    } catch {
      /* iOS without a playable BGM codec, or offline — game stays silent */
    }
  }

  /**
   * One-shot jingle (VS splash, win/lose stinger, challenger reveal, hurry-up
   * warning). Ducks the BGM bed while it plays and restores after.
   * Routed through the SFX bus (not Hits) so the Music/SFX/Hits toggles stay
   * meaningful.
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
        this.bgmGain.gain.setTargetAtTime(this.duckLevel(), ctx.currentTime, 0.05);
      }
      src.onended = () => {
        if (duck && this.bgmGain) {
          this.bgmGain.gain.setTargetAtTime(this.musicLevel(), ctx.currentTime, 0.4);
        }
        opts.onEnded?.();
      };
      src.start();
    } catch {
      opts.onEnded?.(); // still advance BGM sequencing if the stinger can't decode
    }
  }

  /**
   * Fire-and-forget combat clip. Swings ride the SFX bus; impacts / blocks /
   * combo accents ride the Hits bus. Freely overlaps (each call is its own
   * source node) — combat routinely needs two of these in the same tick
   * (P1's swing landing while P2's counter also connects). A small random
   * pitch/gain wobble keeps rapid-fire jabs from sounding mechanically
   * identical.
   */
  playSfx(id: SfxId, opts: { volume?: number } = {}): void {
    const ctx = this.ctxOf();
    const bus = HIT_SFX.has(id) ? this.hitsGain! : this.sfxGain!;
    void this.load(id).then((buffer) => {
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.playbackRate.value = 0.94 + Math.random() * 0.12;
      const gain = ctx.createGain();
      gain.gain.value = (opts.volume ?? 1) * (0.9 + Math.random() * 0.1);
      src.connect(gain);
      gain.connect(bus);
      src.start();
    });
  }

  /**
   * Synthesized UI "button press" blip — fired whenever a tap triggers a menu
   * action (mode select, character/stage pick, back/exit, start, ranks…).
   * No asset: a short oscillator through sfxGain, so it honors SFX volume and
   * needs nothing decoded/loaded. Guarded so it's a silent no-op if Web Audio
   * is unavailable or the context hasn't been unlocked by a gesture yet.
   */
  blip(opts: { freq?: number; volume?: number } = {}): void {
    if (!this.unlocked) return;
    try {
      const ctx = this.ctxOf();
      if (ctx.state === 'suspended') void ctx.resume();
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      osc.type = 'square';
      const freq = opts.freq ?? 880;
      osc.frequency.setValueAtTime(freq, now);
      // Tiny downward pitch drop reads as a crisp physical "tick", not a tone.
      osc.frequency.exponentialRampToValueAtTime(freq * 0.66, now + 0.05);
      const gain = ctx.createGain();
      const level = opts.volume ?? 0.35;
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(level, now + 0.006);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.09);
      osc.connect(gain);
      gain.connect(this.sfxGain!);
      osc.start(now);
      osc.stop(now + 0.1);
    } catch {
      /* Web Audio unavailable — UI stays silent, never throws into the tap path */
    }
  }
}

export const audio = new AudioManager();
