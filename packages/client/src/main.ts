/**
 * Agent Fighter — game client.
 * Fixed-timestep 60Hz loop; the renderer is a pure function of GameState plus
 * cosmetic juice that lives OUTSIDE the sim (safe under future rollback).
 * Characters are loaded from `characters/<id>/` bundles + packed atlases —
 * the client interprets no frame data, it only asks the engine which sprite
 * to draw (`spriteForFighter`) and blits it.
 */
import {
  Action, Btn, Phase, STAGE, TICKS_PER_SEC, TUNING,
  aiPoll, createAi, createGameState, debugBoxes, setCharacters, step,
} from '@af/core';
import type { AiState, GameState, InputFrame } from '@af/core';
import {
  cpuLevelFor, loadLever, loadProfile, saveLever, skillForCpuLevel, xpForNext,
} from './progress.js';
import type { Profile } from './progress.js';
import { listCharacters, loadRoster, drawFighter, resetFighterTrails } from './atlas.js';
import type { Roster } from './atlas.js';
import {
  CONTENT_BOT, CONTENT_TOP, P_COLORS, RANK_TABS, VH, VW, ZOOM_MAX, ZOOM_MIN,
  currentStageCamLimits, drawHud, drawRanks, drawResults, drawSelect, drawStage,
  drawStageSelect, drawTitle, drawVsCard, drawWallet, resetTaps, setBgVideo, setGameLogo,
  setLogo, setStageAsset, setUiKit, tapHit, worldTransform,
} from './ui.js';
import type { Cam, HudFx, Mode, RankRow, XpInfo } from './ui.js';
import { listStages, loadBgVideo, loadDisplayFont, loadGameLogo, loadLogo, loadStage, loadUiKit } from './chrome.js';
import type { StageAsset } from './chrome.js';
import { audio, hitSfxFor, swingSfx } from './audio.js';
import { auth, authLogin, authLogout, authName, authRehydrate, authToken } from './auth.js';
import { NetSession, SoloSession } from './net.js';
import type { NetAccount, Session } from './net.js';
import {
  auraGlow, drawFx, emitAura, emitBurst, emitRing, fxPulse, updateFx,
} from './fx.js';
import { initTouchControls, setTouchScreen } from './touch.js';
import { initPwa } from './pwa.js';

const TICK_MS = 1000 / TICKS_PER_SEC;

// ---------------------------------------------------------------- input
const keys = new Set<string>();
const pressedThisFrame = new Set<string>();
addEventListener('keydown', (e) => {
  audio.unlock(); // first user gesture — browsers block AudioContext until one fires
  if (!keys.has(e.code)) pressedThisFrame.add(e.code);
  keys.add(e.code);
  if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space'].includes(e.code)) e.preventDefault();
});
addEventListener('keyup', (e) => keys.delete(e.code));

const P0_MAP: [string, number][] = [
  ['KeyA', Btn.Left], ['KeyD', Btn.Right], ['KeyW', Btn.Up], ['KeyS', Btn.Down],
  ['KeyT', Btn.LP], ['KeyY', Btn.MP], ['KeyU', Btn.HP],
  ['KeyG', Btn.LK], ['KeyH', Btn.MK], ['KeyJ', Btn.HK],
];
const P1_MAP: [string, number][] = [
  ['ArrowLeft', Btn.Left], ['ArrowRight', Btn.Right], ['ArrowUp', Btn.Up], ['ArrowDown', Btn.Down],
  ['KeyI', Btn.LP], ['KeyO', Btn.MP], ['KeyP', Btn.HP],
  ['KeyK', Btn.LK], ['KeyL', Btn.MK], ['Semicolon', Btn.HK],
  ['Numpad4', Btn.LP], ['Numpad5', Btn.MP], ['Numpad6', Btn.HP],
  ['Numpad1', Btn.LK], ['Numpad2', Btn.MK], ['Numpad3', Btn.HK],
];
const CONFIRM = [['KeyT', 'KeyY', 'KeyU', 'KeyG', 'KeyH', 'KeyJ'], ['KeyI', 'KeyO', 'KeyP', 'KeyK', 'KeyL', 'Semicolon']];

const pollPad = (map: [string, number][]): InputFrame => {
  let f = 0;
  for (const [code, bit] of map) if (keys.has(code)) f |= bit;
  return f;
};

/**
 * Menu taps. The draw functions register their tappable rects every frame
 * (ui.ts tapZone), so a pointer press just hit-tests the CURRENT layout and
 * queues a semantic action ('mode:cpu', 'pick:3'). Screen handlers drain this
 * exactly like `pressedThisFrame`, and it's cleared at the end of each frame.
 *
 * Mouse and touch both land here, so clicking menus works on desktop too.
 */
const taps = new Set<string>();
const tapAt = (clientX: number, clientY: number): void => {
  const r = canvas.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return;
  // CSS-scaled + letterboxed canvas → virtual 960×540 space.
  const vx = ((clientX - r.left) / r.width) * VW;
  const vy = ((clientY - r.top) / r.height) * VH;
  if (vx < 0 || vy < 0 || vx > VW || vy > VH) return;
  const action = tapHit(vx, vy);
  if (action) taps.add(action);
};

// ---------------------------------------------------------------- state
type Screen = 'loading' | 'title' | 'select' | 'stageSelect' | 'online' | 'fight' | 'results' | 'ranks';

let screen: Screen = 'loading';
let mode: Mode = 'cpu';
let net: Session | null = null;
let netInstalled = false;

// ---- M5 credits: the AIR sign-in gate + the server-side account.
// ?dev=NAME bypasses the gate against a DEV-economy match server (in-memory
// persistence, name-keyed identities) — for development only; a production
// server (real Supabase) ignores dev names and demands a verified AIR token.
const DEV_GUEST = new URLSearchParams(location.search).get('dev');
let account: NetAccount | null = null;
let accountFetch: 'idle' | 'busy' | 'done' | 'fail' = 'idle';
let accountToastAge = -1; // ≥0 → the "+10 DAILY CREDITS" toast is animating
let queuedMode: 'solo' | 'wager' = 'wager';
let practiceFree = false; // offline-fallback match: no fee, no XP, no records

// ---- P0 loop redesign: quick play, VS card, wallet strip.
// The remembered fighter makes the title's ENTER a one-input path to a match.
const LAST_FIGHTER_KEY = 'af-last-fighter';
let lastFighter = localStorage.getItem(LAST_FIGHTER_KEY) ?? '';
/** Ticks the pre-fight stakes card has been showing (-1 = off). */
let vsCardAge = -1;
const VS_CARD_TICKS = 150; // ~2.5s; any key skips
let vsStakes: string[] = [];
// Wallet strip delta: animate credits the moment the balance visibly moves.
let walletShown: number | null = null;
let walletDelta: { amt: number; age: number } | null = null;

const drawWalletStrip = (): void => {
  if (!account) return;
  walletShown ??= account.credits;
  if (account.credits !== walletShown) {
    walletDelta = { amt: account.credits - walletShown, age: 0 };
    walletShown = account.credits;
  }
  if (walletDelta && ++walletDelta.age > 130) walletDelta = null;
  drawWallet(ctx, account, walletDelta);
};

/** Match-server endpoints (?ws= overrides for deploys/dev). */
const matchWsUrl = (): string =>
  new URLSearchParams(location.search).get('ws') ?? `ws://${location.hostname}:8477`;
const matchHttpUrl = (): string => matchWsUrl().replace(/^ws/, 'http');

// Public standings (drawRanks) — fetched from the match server on entry.
let ranksRows: RankRow[] | null = null;
let ranksTab = 0;
let ranksErr = '';
let ranksBusy = false;

const fetchRanks = (): void => {
  if (ranksBusy) return;
  ranksBusy = true;
  ranksRows = null;
  ranksErr = '';
  void fetch(`${matchHttpUrl()}/leaderboard?limit=100`)
    .then(async (res) => {
      if (!res.ok) throw new Error(`server said ${res.status}`);
      ranksRows = (await res.json()) as RankRow[];
    })
    .catch((e) => { ranksErr = (e as Error).message || 'unreachable'; })
    .finally(() => { ranksBusy = false; });
};

/**
 * Pull the account snapshot from the match server (also claims the daily
 * +10 login bonus — first authenticated contact of the day wins it).
 */
const fetchAccount = async (): Promise<void> => {
  accountFetch = 'busy';
  try {
    const headers: Record<string, string> = {};
    const token = await authToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    else if (DEV_GUEST) headers['X-Dev-Name'] = DEV_GUEST;
    else { accountFetch = 'idle'; return; }
    const res = await fetch(`${matchHttpUrl()}/me`, { headers });
    if (!res.ok) { accountFetch = 'fail'; return; }
    account = (await res.json()) as NetAccount;
    if (account.dailyGranted) accountToastAge = 0;
    accountFetch = 'done';
  } catch {
    accountFetch = 'fail'; // server offline — title shows it, local play still fine
  }
};
let uiTick = 0;
let allRosters: Roster[] = [];
let picks: [number, number] = [0, 0];
let locked: [boolean, boolean] = [false, false];

// Progression + the CPU difficulty lever.
const profile: Profile = loadProfile();
let lever = loadLever();
let cpuAi: AiState | null = null;
let statDmg = 0; // damage the human dealt this match
let statBestCombo = 0;
let xpBanner: XpInfo | null = null;
let resultsAge = 0; // ticks since the results screen appeared — drives its pop-in
let stageIds: string[] = [];
let stageAssets: (StageAsset | null)[] = [];
let stageCursor = 0;
let fighters: [Roster, Roster] | null = null;
let game: GameState | null = null;
let showBoxes = false;
let seed = 1;
let loadError = '';
let hurryPlayed = false; // per-round: has the "Hurry Up!" stinger fired yet
const HURRY_UP_TICKS = 10 * TICKS_PER_SEC; // MvC fires it at 10s left on the clock

// Cosmetic juice — never simulated.
const DANGER_RED = '#ff2d4a'; // critical-health aura / warning tint
interface Spark { x: number; y: number; age: number; big: boolean }
let sparks: Spark[] = [];
let shake = 0;
let cam: Cam = { x: 0, y: 0, zoom: 1.5 };
let hitStopFlash = 0;
const fx: HudFx = { flash: [1, 1], comboOwner: -1, comboHits: 0, comboAge: 0, announce: '', announceAge: 0 };
let prevHealth: [number, number] = [0, 0];
let prevConnected: [number, number] = [0, 0]; // fighters[i].attackConnected last frame — edge-detects new hits/blocks
let prevPhase: Phase = Phase.PreRound;
let prevSuperFlash = 0; // rising-edge detect for the super-activation shockwave
let prevMeter: [number, number] = [0, 0]; // to spot which fighter spent meter

// ---------------------------------------------------------------- canvas
const canvas = document.getElementById('game') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const px = (v: number): number => Math.trunc(v / 256);

// Menus are tappable/clickable: hit-test the layout the last frame drew.
// The in-match arcade overlay (touch.ts) sits above this and swallows its own
// presses, so a fight's controls never leak through as menu taps.
canvas.addEventListener('pointerdown', (e) => {
  audio.unlock(); // same first-gesture unlock the keydown path does
  tapAt(e.clientX, e.clientY);
});

// ---------------------------------------------------------------- boot
const boot = async (): Promise<void> => {
  try {
    await loadDisplayFont(); // awaited so the title screen never flashes the Impact fallback
    setUiKit(await loadUiKit());
    // Logo (11MB SVG) and background video (~10MB) are NOT awaited: both have
    // graceful fallbacks (text wordmark, static stage art), so the title
    // screen should be interactive immediately and swap in as they arrive —
    // important on mobile, where blocking boot on ~20MB of art would stall
    // first paint for seconds on a slow connection.
    void loadLogo().then(setLogo);
    void loadGameLogo().then(setGameLogo);
    setBgVideo(loadBgVideo('/assets/video/bg_video_main_af.mp4'));
    stageIds = await listStages();
    stageAssets = await Promise.all(stageIds.map(loadStage));
    if (stageAssets.length > 0) setStageAsset(stageAssets[0]!);
    const ids = await listCharacters();
    if (ids.length === 0) throw new Error('no characters found in characters/');
    allRosters = await Promise.all(ids.map(loadRoster));
    picks = [0, Math.min(1, allRosters.length - 1)];
    screen = 'title';
    audio.preload();
    // Landing / share deep-links: ?screen=title|select|ranks|play &mode=cpu|online &char=<id>
    applyBootDeepLink();
    if (screen === 'title') {
      void audio.playBgm(audio.nextRotationTrack(), { fadeInSec: 1.5 });
    }
    // Restore a previous AIR session silently (30-day sessions) — never blocks
    // boot, and offline play works identically if it fails or is skipped.
    void authRehydrate();
  } catch (e) {
    loadError = (e as Error).message;
  }
};

/**
 * Apply one-shot entry from the URL so the marketing site can open the real
 * in-game screens (select / play / leaderboards) without a path router.
 */
const applyBootDeepLink = (): void => {
  let q: URLSearchParams;
  try {
    q = new URLSearchParams(location.search);
  } catch {
    return;
  }
  const screenQ = (q.get('screen') ?? '').toLowerCase();
  const modeQ = (q.get('mode') ?? '').toLowerCase();
  const charQ = q.get('char');

  if (modeQ === 'cpu' || modeQ === 'online' || modeQ === '2p') {
    mode = modeQ;
  }

  const pickChar = (): void => {
    if (!charQ) return;
    const idx = allRosters.findIndex((r) => r.id === charQ && !r.disabled);
    if (idx >= 0) picks = [idx, idx];
  };

  const enterSelectFromLink = (): void => {
    screen = 'select';
    locked = [false, false];
    const fe = Math.max(0, allRosters.findIndex((r) => !r.disabled));
    picks = [fe, fe];
    pickChar();
    void audio.playBgm('player_select', { fadeInSec: 0.5 });
  };

  if (screenQ === 'ranks' || screenQ === 'leaderboard' || screenQ === 'leaderboards') {
    screen = 'ranks';
    fetchRanks();
    return;
  }
  if (screenQ === 'select' || screenQ === 'character' || screenQ === 'characters') {
    enterSelectFromLink();
    return;
  }
  if (screenQ === 'play') {
    // "Play now" → fighter select with VS AGENT (cpu) unless mode= was set.
    if (modeQ !== 'online' && modeQ !== '2p') mode = 'cpu';
    enterSelectFromLink();
    return;
  }
  // Title (default): still honor ?char= so a shared fighter opens ready to pick.
  pickChar();
};

/** Reset per-match juice/announce state (shared by local + online starts). */
const resetMatchFx = (g: GameState): void => {
  cam = { x: STAGE.widthPx / 2 - VW / 2 / 1.5, y: STAGE.floorYPx - (VH / 1.5) * 0.86, zoom: 1.5 };
  updateCamera(g);
  prevHealth = [g.fighters[0].health, g.fighters[1].health];
  prevConnected = [0, 0];
  prevPhase = g.phase;
  fx.flash = [1, 1];
  fx.comboOwner = -1;
  fx.comboHits = 0;
  fx.comboAge = 0;
  fx.announce = `ROUND ${g.roundNum + 1}`;
  fx.announceAge = 0;
  sparks = [];
  shake = 0;
  hurryPlayed = false;
  resetFighterTrails();
};

/**
 * Queue for a server match (ADR 0003 + M5 credits).
 * 'wager' = PvP, 10-credit entrance each, winner takes the pot.
 * 'solo'  = ranked vs the HOUSE agent at your level, 1 credit.
 */
const startOnline = (m: 'solo' | 'wager'): void => {
  const roster = allRosters[picks[0]]!;
  lastFighter = roster.id;
  localStorage.setItem(LAST_FIGHTER_KEY, lastFighter); // powers title quick play
  queuedMode = m;
  practiceFree = false;
  netInstalled = false;
  screen = 'online';
  // Play under the AIR identity (fresh token; the server verifies it against
  // the JWKS and settles credits/XP). ?dev=NAME plays a dev-economy account.
  const name = authName() ?? DEV_GUEST ?? `PLAYER-${(profile.wins + profile.losses) % 1000}`;
  void authToken().then((token) => {
    if (screen !== 'online' || net) return; // player backed out while fetching
    const email = auth.email || undefined; // AIR write-back target (ADR 0004)
    // Solo (v3): pure LOCAL simulation of the pinned house AI — zero added
    // latency; the server re-derives the AI to verify. Wager: rollback PvP.
    net = m === 'solo'
      ? new SoloSession(matchWsUrl(), name, roster.id, roster.bundle.versionHash, token, email)
      : new NetSession(matchWsUrl(), name, roster.id, roster.bundle.versionHash, token, m, email);
  });
};

/** Match setup arrived — install the pinned characters/stage and begin. */
const installOnlineMatch = (): void => {
  const s = net!.setup!;
  const r0 = allRosters.find((r) => r.id === s.chars[0].id);
  const r1 = allRosters.find((r) => r.id === s.chars[1].id);
  if (!r0 || !r1) {
    net!.error = `missing character "${!r0 ? s.chars[0].id : s.chars[1].id}" locally`;
    net!.close();
    return;
  }
  fighters = [r0, r1];
  setCharacters(r0.ch, r1.ch);
  const si = stageIds.indexOf(s.stage);
  if (si >= 0) setStageAsset(stageAssets[si] ?? null);
  net!.begin();
  game = net!.game;
  cpuAi = null;
  xpBanner = null;
  statDmg = 0;
  statBestCombo = 0;
  resetMatchFx(game!);
  netInstalled = true;
  screen = 'fight';
  // Stakes card (P0): what this match costs and pays, up front.
  vsCardAge = 0;
  vsStakes = s.mode === 'solo'
    ? ['ENTRY −1 CR      WIN +2 CR · +60 XP      LOSE −15 XP', 'RANKED · SERVER-VERIFIED']
    : [`ENTRY −${s.fee ?? 10} CR      WINNER TAKES THE ${(s.fee ?? 10) * 2} CR POT`, 'WAGER · SERVER-VERIFIED'];
  void audio.playStinger('vs', { onEnded: () => void audio.playBgm(audio.nextRotationTrack(), { fadeInSec: 1 }) });
};

const startFight = (): void => {
  fighters = [allRosters[picks[0]]!, allRosters[picks[1]]!];
  setCharacters(fighters[0].ch, fighters[1].ch);
  game = createGameState(seed++);
  cpuAi = mode === 'cpu'
    ? createAi(1, skillForCpuLevel(cpuLevelFor(profile, lever)), seed * 31 + 7)
    : null;
  statDmg = 0;
  statBestCombo = 0;
  xpBanner = null;
  net = null;
  resetMatchFx(game);
  screen = 'fight';
  vsCardAge = 0;
  vsStakes = mode === '2p'
    ? ['LOCAL VERSUS', '']
    : ['FREE PRACTICE      NO FEE · NO XP · NO RECORDS', ''];
  void audio.playStinger('vs', { onEnded: () => void audio.playBgm(audio.nextRotationTrack(), { fadeInSec: 1 }) });
};

/**
 * World px a fighter's body occupies. Sprites are authored supersampled (2x)
 * for anime detail and scaled back down at blit time via atlas.json `scale`,
 * so this stays the WORLD height — keep it equal to the Studio's WORLD_BODY_H.
 */
const FIGHTER_H = 112;

/**
 * Dynamic camera: frame BOTH fighters. Zooms in tight when they're close and
 * grounded (big, readable characters) and pulls back on super jumps / air
 * combos so nobody leaves the frame (spec §4: MvC-style vertical follow).
 * Solves for the zoom that fits the action box, then places the camera so the
 * box lands between the HUD and the bottom edge.
 */
const updateCamera = (g: GameState): void => {
  const x0 = px(g.fighters[0].x), x1 = px(g.fighters[1].x);
  const PAD_X = 150; // breathing room either side
  const boxL = Math.min(x0, x1) - PAD_X;
  const boxR = Math.max(x0, x1) + PAD_X;

  const highestFeet = Math.min(px(g.fighters[0].y), px(g.fighters[1].y));
  const boxT = highestFeet - FIGHTER_H - 50; // head + headroom
  const boxB = STAGE.floorYPx + 24; // a little deck below the feet

  // Stage art bounds the camera: it may not zoom out past the point where the
  // viewport would exceed the art (`limits.minZoom`), and cam.y is clamped so
  // the art always covers top and bottom — no flat sky/deck fill ever shows.
  const limits = currentStageCamLimits();
  const zoomFloor = limits ? Math.max(ZOOM_MIN, limits.minZoom) : ZOOM_MIN;

  const zoomX = VW / Math.max(1, boxR - boxL);
  const zoomY = (CONTENT_BOT - CONTENT_TOP) / Math.max(1, boxB - boxT);
  const targetZoom = Math.max(zoomFloor, Math.min(ZOOM_MAX, Math.min(zoomX, zoomY)));

  cam.zoom += (targetZoom - cam.zoom) * 0.08;

  // Place the camera so the action box sits inside the content band.
  const viewW = VW / cam.zoom;
  const viewH = VH / cam.zoom;
  const midX = (x0 + x1) / 2;
  const targetX = Math.max(0, Math.min(STAGE.widthPx - viewW, midX - viewW / 2));
  let targetY = boxT - CONTENT_TOP / cam.zoom;

  if (limits) {
    // Keep the art covering: its top must be at/above the screen top and its
    // bottom at/below the screen bottom. minZoom guarantees viewH ≤ art height,
    // so the [top, bottom-viewH] window is non-empty and this pins the image's
    // bottom edge to the screen bottom once fully zoomed out.
    const maxY = limits.botY - viewH;
    targetY = Math.max(limits.topY, Math.min(maxY, targetY));
  }

  cam.x += (targetX - cam.x) * 0.16;
  cam.y += (targetY - cam.y) * 0.12;
};

// ---------------------------------------------------------------- juice
const updateJuice = (g: GameState): void => {
  for (const i of [0, 1] as const) {
    const f = g.fighters[i];
    if (f.health < prevHealth[i]) {
      const dmg = prevHealth[i] - f.health;
      const big = dmg > 600;
      const hx = px(f.x) + f.facing * -22, hy = px(f.y) - 78;
      sparks.push({ x: hx, y: hy, age: 0, big });
      // Ember burst in the ATTACKER's color (the victim is fighter i).
      emitBurst(hx, hy, P_COLORS[(1 - i) as 0 | 1], big ? 1.8 : 0.9);
      shake = big ? 11 : 6;
      hitStopFlash = big ? 3 : 0;
    }
    // Hit SFX: a swoosh on every swing (attack's very first tick), plus a
    // punch/kick impact or block clip on the tick the attack actually makes
    // contact (attackConnected's rising edge: 0→1 hit, 0→2 block).
    if (f.action === Action.Attack && f.actionFrame === 0 && f.moveIdx >= 0) {
      audio.playSfx(swingSfx(), { volume: 0.45 });
    }
    if (f.attackConnected !== 0 && f.attackConnected !== prevConnected[i]) {
      if (f.attackConnected === 1) {
        const move = fighters![i].ch.b.moves[f.moveIdx];
        audio.playSfx(hitSfxFor(move?.button));
        if (g.fighters[(1 - i) as 0 | 1].comboHits >= 2) audio.playSfx('combo_accent', { volume: 0.6 });
      } else if (f.attackConnected === 2) {
        audio.playSfx('block_hit');
      }
    }
    prevConnected[i] = f.attackConnected;
    // Aura motes: a fighter that is CHARGED (≥1 super bar) or on CRITICAL
    // health smoulders — a steady trickle of embers rising off the body.
    const meterN = f.meter / TUNING.meterMax;
    const critical = f.health / fighters![i].ch.b.maxHealth < 0.25;
    const auraRate = (f.meter >= TUNING.meterBar ? 0.35 + meterN * 0.5 : 0) + (critical ? 0.4 : 0);
    if (auraRate > 0) {
      emitAura(px(f.x), px(f.y) - 56, 20, 52, critical ? DANGER_RED : P_COLORS[i], auraRate);
    }
    // Progression stats: what the human (P1) dished out.
    if (i === 1 && f.health < prevHealth[1]) statDmg += prevHealth[1] - f.health;
    prevHealth[i] = f.health;
    // Health bar lag (white flash draining behind the real bar).
    const max = fighters![i].ch.b.maxHealth;
    const target = Math.max(0, f.health) / max;
    fx.flash[i] = fx.flash[i] > target ? Math.max(target, fx.flash[i] - 0.006) : target;
  }
  statBestCombo = Math.max(statBestCombo, g.fighters[1].comboHits);

  // Combo counter tracks whoever is being hit.
  const v0 = g.fighters[0], v1 = g.fighters[1];
  const inCombo = (a: Action): boolean => a === Action.Hitstun || a === Action.AirHitstun;
  const bumpCombo = (owner: 0 | 1, hits: number): void => {
    // Re-pop on the OWNER changing or the hit count climbing (each new hit
    // in the string gets its own little punch), not on every frame the
    // counter merely stays on screen.
    if (fx.comboOwner !== owner || hits > fx.comboHits) fx.comboAge = 0; else fx.comboAge++;
    fx.comboOwner = owner;
    fx.comboHits = hits;
  };
  if (inCombo(v1.action) && v1.comboHits >= 2) bumpCombo(0, v1.comboHits);
  else if (inCombo(v0.action) && v0.comboHits >= 2) bumpCombo(1, v0.comboHits);
  else if (!inCombo(v0.action) && !inCombo(v1.action)) fx.comboOwner = -1;

  // Announcements on phase changes — each punctuated by a screen shockwave.
  if (g.phase !== prevPhase) {
    if (g.phase === Phase.Fighting) {
      fx.announce = 'FIGHT!'; fx.announceAge = 0;
      emitRing(VW / 2, VH / 2 - 40, 240, '#ffd166', { life: 30, width: 5 });
    } else if (g.phase === Phase.RoundOver) {
      fx.announce = g.roundWinner === 2 ? 'DOUBLE KO' : 'K.O.';
      fx.announceAge = 0;
      emitRing(VW / 2, VH / 2 - 40, 340, DANGER_RED, { life: 40, width: 7 });
    } else if (g.phase === Phase.PreRound) { fx.announce = `ROUND ${g.roundNum + 1}`; fx.announceAge = 0; }
    prevPhase = g.phase;
  }
  fx.announceAge++;

  // Super activation: on the rising edge of the freeze flash, blow a ring off
  // the fighter who supered (whichever one is spending meter / attacking).
  if (g.superFlashLeft > 0 && prevSuperFlash === 0) {
    // The super's owner is whoever just spent meter this frame.
    const d0 = prevMeter[0] - g.fighters[0].meter;
    const d1 = prevMeter[1] - g.fighters[1].meter;
    const su: 0 | 1 = d0 >= d1 ? 0 : 1;
    const sx = px(g.fighters[su].x), sy = px(g.fighters[su].y) - 56;
    emitRing(sx, sy, 160, P_COLORS[su], { life: 28, width: 6, layer: 'world' });
    emitBurst(sx, sy, P_COLORS[su], 2.2);
  }
  prevSuperFlash = g.superFlashLeft;
  prevMeter = [g.fighters[0].meter, g.fighters[1].meter];

  sparks = sparks.filter((s) => ++s.age < 9);
  shake = Math.max(0, shake - 0.7);
  if (hitStopFlash > 0) hitStopFlash--;
};

// ---------------------------------------------------------------- render
const renderFight = (g: GameState): void => {
  // World pass: everything below is in world coordinates.
  ctx.save();
  if (shake > 0) ctx.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake);
  worldTransform(ctx, cam);

  drawStage(ctx, cam);

  // Character aura (UNDER the sprite): an energy glow that intensifies when a
  // fighter is charged (super meter) or in critical health — the "this
  // fighter is dangerous / desperate" read, tinted to the player color.
  for (const i of [0, 1] as const) {
    const f = g.fighters[i];
    const meterN = f.meter / TUNING.meterMax;
    const critical = f.health / fighters![i].ch.b.maxHealth < 0.25;
    const intensity = 0.12 + meterN * 0.4 + (critical ? 0.3 : 0);
    const breathe = fxPulse(g.tick, 0.12, 0.8, 1); // subtle living pulse
    auraGlow(ctx, px(f.x), px(f.y) - 52, 70,
      critical ? DANGER_RED : P_COLORS[i], intensity * breathe);
  }

  // Fighters (draw the one in hitstun last so it reads on top).
  const order: (0 | 1)[] = g.fighters[0].action === Action.Hitstun ? [1, 0] : [0, 1];
  for (const i of order) {
    const f = g.fighters[i];
    // Ground shadow (shrinks with height — sells the jump arc).
    const height = STAGE.floorYPx - px(f.y);
    const sc = Math.max(0.35, 1 - height / 320);
    ctx.fillStyle = `rgba(0,0,0,${0.42 * sc})`;
    ctx.beginPath();
    ctx.ellipse(px(f.x), STAGE.floorYPx + 2, 26 * sc, 6 * sc, 0, 0, Math.PI * 2);
    ctx.fill();
    // Motion afterimage intensity from speed (fixed-point → px/tick): off while
    // standing/walking (~4px), ramping in over dashes/jumps/knockback (~10px+).
    const spd = (Math.abs(f.velX) + Math.abs(f.velY)) / 256;
    const motion = Math.max(0, Math.min(1, (spd - 3) / 7));
    drawFighter(ctx, fighters![i], f, g.tick, px(f.x), px(f.y), P_COLORS[i], { slot: i, motion });
  }

  // Projectiles.
  for (const p of g.projectiles) {
    if (!p.active) continue;
    const x = px(p.x);
    const y = px(p.y);
    const grd = ctx.createRadialGradient(x, y, 2, x, y, 20);
    grd.addColorStop(0, '#ffffff');
    grd.addColorStop(0.5, P_COLORS[p.owner as 0 | 1]);
    grd.addColorStop(1, '#ffffff00');
    ctx.fillStyle = grd;
    ctx.beginPath();
    ctx.arc(x, y, 20, 0, Math.PI * 2);
    ctx.fill();
  }

  // Hit sparks.
  for (const s of sparks) {
    const r = (s.big ? 10 : 5) + s.age * (s.big ? 6 : 3.5);
    ctx.strokeStyle = `rgba(255, 224, 130, ${1 - s.age / 9})`;
    ctx.lineWidth = s.big ? 4 : 2.5;
    ctx.beginPath();
    ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.lineWidth = 1;

  // Particle FX in world space (embers, auras, super rings) — on top of the
  // fighters so debris reads over the bodies.
  drawFx(ctx, 'world');

  // Debug boxes (world space — they come from the sim in world px).
  if (showBoxes) {
    for (const b of debugBoxes(g)) {
      ctx.strokeStyle = '#4ade80';
      for (const r of b.hurtboxes) ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w, r.h);
      ctx.strokeStyle = '#f87171';
      for (const r of b.hitboxes) ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w, r.h);
    }
  }
  ctx.restore();

  // Screen pass: full-frame flashes + HUD.
  if (g.superFlashLeft > 0) {
    ctx.fillStyle = g.superFlashLeft % 4 < 2 ? '#ffffff22' : '#000018aa';
    ctx.fillRect(0, 0, VW, VH);
  }
  if (hitStopFlash > 0) {
    ctx.fillStyle = '#ffffff33';
    ctx.fillRect(0, 0, VW, VH);
  }
  drawHud(ctx, g, fighters!, fx,
    net?.setup
      ? [
        `${net.setup.names[0]}${net.setup.agents[0] ? ' · AGENT' : ''}${net.side === 0 ? ' (YOU)' : ''}`,
        `${net.setup.names[1]}${net.setup.agents[1] ? ' · AGENT' : ''}${net.side === 1 ? ' (YOU)' : ''}`,
      ]
      : cpuAi ? ['', `AGENT LV ${cpuLevelFor(profile, lever)}`] : undefined);

  // Screen-space FX (announcement shockwaves) — over the HUD so a KO ring
  // sweeps across the whole frame.
  drawFx(ctx, 'screen');
};

// ---------------------------------------------------------------- screens
const tickSelect = (): void => {
  const n = allRosters.length;
  const enabled = (i: number): boolean => !allRosters[i]?.disabled;
  const anyEnabled = allRosters.some((_r, i) => enabled(i));
  const move = (i: 0 | 1, d: number): void => {
    if (locked[i] || !anyEnabled) return;
    // Step over disabled fighters so the cursor lands only on selectable ones.
    let p = picks[i];
    for (let s = 0; s < n; s++) {
      p = (p + d + n) % n;
      if (enabled(p)) { picks[i] = p; return; }
    }
  };
  if (pressedThisFrame.has('KeyA')) move(0, -1);
  if (pressedThisFrame.has('KeyD')) move(0, 1);

  // Touch: tapping a portrait moves the cursor onto it so its stats can be
  // read; tapping the one already under the cursor commits. Two light taps
  // beat one blind commit — you get to look before you lock.
  let tapConfirm = false;
  for (let k = 0; k < n; k++) {
    if (!taps.has(`pick:${k}`)) continue;
    if (!enabled(k) || locked[0]) break;
    if (picks[0] === k) tapConfirm = true; // second tap on the same fighter
    else picks[0] = k;
    break;
  }

  // The CPU difficulty lever: [ and ] on the select screen (CPU mode).
  if (mode === 'cpu') {
    if (pressedThisFrame.has('BracketLeft')) { lever = Math.max(-10, lever - 1); saveLever(lever); }
    if (pressedThisFrame.has('BracketRight')) { lever = Math.min(10, lever + 1); saveLever(lever); }
  } else {
    if (pressedThisFrame.has('ArrowLeft')) move(1, -1);
    if (pressedThisFrame.has('ArrowRight')) move(1, 1);
  }

  // A disabled fighter under the cursor cannot be confirmed.
  if (enabled(picks[0]) && (tapConfirm || CONFIRM[0]!.some((k) => pressedThisFrame.has(k)))) locked[0] = true;
  if (mode === 'online' || mode === 'cpu') {
    // Server modes (M5): your pick is the queue ticket. Wager matchmakes a
    // PvP opponent; ranked VS AGENT gets a house bot at your level — the
    // server picks its character (and charges the entrance fee).
    if (locked[0]) startOnline(mode === 'cpu' ? 'solo' : 'wager');
    return;
  }
  if (mode === '2p') {
    if (enabled(picks[1]) && CONFIRM[1]!.some((k) => pressedThisFrame.has(k))) locked[1] = true;
  } else if (locked[0] && !locked[1]) {
    // CPU picks its fighter — visibly, like an arcade opponent reveal — but
    // never a disabled one.
    let p = (seed * 17 + profile.wins * 5 + uiTick) % n;
    for (let s = 0; s < n && !enabled(p); s++) p = (p + 1) % n;
    picks[1] = p;
    locked[1] = true;
    void audio.playStinger('here_comes_a_new_challenger');
  }

  if (pressedThisFrame.has('Escape')) locked = [false, false];
  if (locked[0] && locked[1] && (pressedThisFrame.has('Enter') || pressedThisFrame.has('Space'))) {
    if (stageIds.length > 0) screen = 'stageSelect';
    else startFight(); // no stages installed — fall back to the procedural stage
  }
};

const tickStageSelect = (): void => {
  const n = stageIds.length;
  const move = (d: number): void => {
    stageCursor = (stageCursor + d + n) % n;
    setStageAsset(stageAssets[stageCursor] ?? null);
  };
  if (pressedThisFrame.has('KeyA') || pressedThisFrame.has('ArrowLeft')) move(-1);
  if (pressedThisFrame.has('KeyD') || pressedThisFrame.has('ArrowRight')) move(1);
  // Same look-then-commit rule as the fighter grid: tap to preview the stage
  // (the backdrop swaps), tap the highlighted one again to fight.
  let tapStart = false;
  for (let k = 0; k < n; k++) {
    if (!taps.has(`stage:${k}`)) continue;
    if (stageCursor === k) tapStart = true;
    else { stageCursor = k; setStageAsset(stageAssets[k] ?? null); }
    break;
  }
  if (pressedThisFrame.has('Escape') || taps.has('back')) { screen = 'select'; locked = [false, false]; return; }
  if (tapStart || pressedThisFrame.has('Enter') || pressedThisFrame.has('Space')) startFight();
};

const frame = (): void => {
  uiTick++;
  updateFx(); // advance cosmetic particles/rings every frame (fight AND results)
  // Tap targets are rebuilt by this frame's draw calls. Clearing here (rather
  // than after) means a press landing between frames still hit-tests the
  // layout the player can actually see.
  resetTaps();

  if (screen === 'loading') {
    ctx.fillStyle = '#0a0616';
    ctx.fillRect(0, 0, VW, VH);
    ctx.fillStyle = loadError ? '#e94560' : '#ffffffaa';
    ctx.font = 'bold 18px "Courier New", monospace';
    ctx.textAlign = 'center';
    ctx.fillText(loadError || 'LOADING CHARACTERS…', VW / 2, VH / 2);
    if (loadError) {
      ctx.font = '13px "Courier New", monospace';
      ctx.fillStyle = '#ffffff88';
      ctx.fillText('run `npm run play` from the repo root so characters/ is served', VW / 2, VH / 2 + 28);
    }
  } else if (screen === 'title') {
    // M5: the AIR account IS the wallet the credits settle into — signing in
    // is required to proceed (?dev=NAME bypasses against a dev server).
    const signedIn = auth.status === 'in' || !!DEV_GUEST;
    if (signedIn && accountFetch === 'idle') void fetchAccount();
    if (!signedIn && account) { account = null; accountFetch = 'idle'; } // signed out
    if (accountToastAge >= 0 && ++accountToastAge > 300) accountToastAge = -1;
    drawTitle(ctx, allRosters, uiTick, {
      mode, cpuLevel: cpuLevelFor(profile, lever),
      authLabel: authName() ?? (DEV_GUEST ? `DEV·${DEV_GUEST.toUpperCase()}` : null),
      authBusy: auth.status === 'busy',
      authError: auth.status === 'error' ? auth.error : undefined,
      gate: !signedIn,
      address: auth.address || undefined,
      account: accountFetch === 'done' && account
        ? { credits: account.credits, level: account.level, wins: account.wins, losses: account.losses }
        : null,
      dailyToast: accountToastAge >= 0,
      fighter: (allRosters.find((r) => r.id === lastFighter && !r.disabled)
        ?? allRosters.find((r) => !r.disabled))?.bundle.name,
    });
    // 2-player local is disabled on all platforms (single-controller / mobile
    // focus). The '2p' Mode value + its handling stay in the codebase, just no
    // longer offered on the menu.
    const MODES: Mode[] = ['cpu', 'online'];
    /** Leave the title for the fighter select (C — "change fighter"). */
    const enterSelect = (): void => {
      screen = 'select';
      locked = [false, false];
      // Cursor starts on the REMEMBERED fighter so select is one confirm away.
      let fe = allRosters.findIndex((r) => r.id === lastFighter && !r.disabled);
      if (fe < 0) fe = Math.max(0, allRosters.findIndex((r) => !r.disabled));
      picks = [fe, fe];
      void audio.playBgm('player_select', { fadeInSec: 0.5 });
    };
    /**
     * QUICK MATCH (P0): title → queue in ONE input, with the remembered
     * fighter. The select screen becomes an opt-in detour (C), not a toll.
     */
    const quickPlay = (): void => {
      let idx = allRosters.findIndex((r) => r.id === lastFighter && !r.disabled);
      if (idx < 0) idx = Math.max(0, allRosters.findIndex((r) => !r.disabled));
      picks[0] = idx;
      startOnline(mode === 'cpu' ? 'solo' : 'wager');
    };
    // A tapped mode row picks the mode AND launches — one tap to a match.
    const tappedMode = MODES.find((m) => taps.has(`mode:${m}`));
    if (pressedThisFrame.has('KeyL') || taps.has('signin')) {
      // AIR sign-in/out toggle — must not fall through to "any key starts".
      if (auth.status === 'in') {
        void authLogout();
        account = null;
        accountFetch = 'idle';
      } else {
        void authLogin();
      }
    } else if (pressedThisFrame.has('KeyR') || taps.has('ranks')) {
      // Standings are public — viewable even from the sign-in gate.
      screen = 'ranks';
      fetchRanks();
    } else if (!signedIn) {
      // Gated: every other key/tap waits for the sign-in.
    } else if (tappedMode) {
      mode = tappedMode;
      quickPlay();
    } else if (pressedThisFrame.has('ArrowUp') || pressedThisFrame.has('KeyW')) {
      mode = MODES[(MODES.indexOf(mode) + MODES.length - 1) % MODES.length]!;
    } else if (pressedThisFrame.has('ArrowDown') || pressedThisFrame.has('KeyS')) {
      mode = MODES[(MODES.indexOf(mode) + 1) % MODES.length]!;
    } else if (pressedThisFrame.has('KeyC') || taps.has('changefighter')) {
      enterSelect();
    } else if (pressedThisFrame.has('Enter') || pressedThisFrame.has('Space') || taps.has('start')) {
      quickPlay();
    }
  } else if (screen === 'ranks') {
    drawRanks(ctx, ranksRows, ranksTab, ranksErr, uiTick,
      authName() ?? (DEV_GUEST ?? undefined));
    if (pressedThisFrame.has('ArrowLeft') || pressedThisFrame.has('KeyA')) {
      ranksTab = (ranksTab + RANK_TABS.length - 1) % RANK_TABS.length;
    }
    if (pressedThisFrame.has('ArrowRight') || pressedThisFrame.has('KeyD')) {
      ranksTab = (ranksTab + 1) % RANK_TABS.length;
    }
    for (let i = 0; i < RANK_TABS.length; i++) if (taps.has(`ranktab:${i}`)) ranksTab = i;
    if (pressedThisFrame.has('KeyR')) fetchRanks();
    if (pressedThisFrame.has('Escape') || taps.has('back')) screen = 'title';
  } else if (screen === 'select') {
    tickSelect();
    drawSelect(ctx, allRosters, picks, locked, uiTick,
      mode === 'cpu' ? { cpuLevel: cpuLevelFor(profile, lever), lever } : undefined);
    drawWalletStrip();
  } else if (screen === 'stageSelect') {
    tickStageSelect();
    drawStageSelect(ctx, stageIds, stageCursor, uiTick);
  } else if (screen === 'online') {
    // Matchmaking lobby: connect → queue → match setup → install → fight.
    ctx.fillStyle = '#0a0616';
    ctx.fillRect(0, 0, VW, VH);
    const dots = '.'.repeat(1 + (Math.trunc(uiTick / 20) % 3));
    const solo = queuedMode === 'solo';
    const failed = net?.status === 'error';
    const msg = !net ? `CONNECTING${dots}` // token fetch in flight
      : failed ? `OFFLINE: ${net.error}`
      : net.setup ? 'OPPONENT FOUND — STARTING'
      : net.status === 'queued' ? (solo ? `CALLING THE HOUSE AGENT${dots}` : `SEARCHING FOR OPPONENT${dots}`)
      : `CONNECTING${dots}`;
    ctx.font = 'bold 22px "Courier New", monospace';
    ctx.textAlign = 'center';
    ctx.fillStyle = failed ? '#e94560' : '#f7e0a3';
    ctx.fillText(msg, VW / 2, VH / 2 - 34);
    ctx.font = 'bold 14px "Courier New", monospace';
    ctx.fillStyle = '#ffd166';
    ctx.fillText(solo
      ? 'RANKED VS AGENT · 1 CREDIT · WIN +1 · LOSE −15 XP'
      : 'WAGER · 10 CREDITS ENTRY EACH · WINNER TAKES THE 20 POT', VW / 2, VH / 2 - 4);
    ctx.font = '13px "Courier New", monospace';
    ctx.fillStyle = '#ffffff88';
    ctx.fillText(failed
      ? (solo ? 'ENTER: FREE PRACTICE (no fee · no XP · no records)  ·  ESC: back'
        : 'is the match server running?  npm run server  ·  ESC: back')
      : 'humans and agents share this queue  ·  ESC: cancel', VW / 2, VH / 2 + 24);
    drawWalletStrip();
    if (net?.setup && !netInstalled) installOnlineMatch();
    if (failed && solo && pressedThisFrame.has('Enter')) {
      // Server unreachable → the old local match, explicitly reward-free.
      practiceFree = true;
      net?.close();
      net = null;
      const en = allRosters.map((r, i) => (r.disabled ? -1 : i)).filter((i) => i >= 0);
      picks[1] = en[(seed * 13 + uiTick) % en.length] ?? picks[0];
      startFight();
    } else if (pressedThisFrame.has('Escape')) {
      net?.close();
      net = null;
      screen = 'select';
      locked = [false, false];
    }
  } else if (screen === 'fight' && game) {
    if (pressedThisFrame.has('KeyB')) showBoxes = !showBoxes;
    if (pressedThisFrame.has('Escape')) {
      net?.close(); // online: leaving is a forfeit (ADR 0003)
      net = null;
      screen = 'select'; locked = [false, false];
      void audio.playBgm('player_select', { fadeInSec: 0.5 });
    }
    // Stakes card: shown for the first ~2.5s; any key skips. Solo and local
    // matches HOLD the sim under it (nothing is waiting on us); wager keeps
    // stepping — the peer's card runs on the same clock and rollback absorbs
    // the difference if one side skips early.
    const cardUp = vsCardAge >= 0 && vsCardAge < VS_CARD_TICKS;
    if (cardUp && pressedThisFrame.size > 0 && vsCardAge > 20) vsCardAge = VS_CARD_TICKS;
    const holdSim = cardUp && net?.setup?.mode !== 'wager';
    if (net && !holdSim) {
      net.frame(pollPad(P0_MAP)); // session owns stepping (rollback or local-sim)
      if (net.status === 'error' && !net.result) {
        // Connection died mid-match: back out gracefully.
        fx.announce = 'CONNECTION LOST';
        fx.announceAge = 0;
      }
    } else if (!net && !holdSim) {
      const p2: InputFrame = cpuAi ? aiPoll(cpuAi, game) : pollPad(P1_MAP);
      step(game, [pollPad(P0_MAP), p2]);
    }
    updateJuice(game);
    updateCamera(game);
    renderFight(game);
    if (cardUp && fighters) {
      drawVsCard(ctx, fighters,
        net?.setup ? net.setup.names : [fighters[0].bundle.name, cpuAi ? `AGENT LV ${cpuLevelFor(profile, lever)}` : fighters[1].bundle.name],
        vsStakes.filter((s) => s), vsCardAge);
      vsCardAge++;
    } else if (vsCardAge >= 0) {
      vsCardAge = -1;
    }
    if (game.phase === Phase.Fighting && !hurryPlayed && game.timerTicks <= HURRY_UP_TICKS) {
      hurryPlayed = true;
      void audio.playStinger('hurry_up', { duck: false }); // layers over the stage loop, like the arcade original
    }
    if (game.phase === Phase.MatchOver) {
      // Progression is SERVER-AWARDED (M5): ranked/wager XP + credits arrive
      // in the post-result xp message. Free practice pays nothing by design.
      // Stale fight-screen state (a lingering "K.O." banner, a frozen combo
      // counter) must not bleed into the results screen's own layout.
      fx.announce = '';
      fx.comboOwner = -1;
      resultsAge = 0;
      screen = 'results';
      // CPU beat the human → arcade "Game Over"; anything else (human win,
      // 2P vs 2P, a draw) gets the victory jingle.
      const lostToCpu = Boolean(cpuAi) && game.winner === 1;
      void audio.playStinger(lostToCpu ? 'game_over' : 'win', {
        onEnded: () => void audio.playBgm('ranking', { fadeInSec: 1 }),
      });
    }
  } else if (screen === 'results' && game) {
    resultsAge++;
    // Online progression is SERVER-AWARDED (Phase B): the xp message lands
    // after the verified result, only for signed-in players.
    if (net?.xp && !xpBanner) {
      xpBanner = {
        gained: net.xp.gained, levelsUp: net.xp.levelsUp,
        level: net.xp.level, xp: net.xp.xp, xpNeed: xpForNext(net.xp.level),
        wins: net.xp.wins, losses: net.xp.losses,
        creditsDelta: net.xp.creditsDelta, credits: net.xp.credits,
      };
      // Keep the title-screen chip in sync without a refetch.
      if (account) {
        account = {
          ...account, credits: net.xp.credits, level: net.xp.level,
          xp: net.xp.xp, wins: net.xp.wins, losses: net.xp.losses,
        };
      }
    }
    renderFight(game);
    drawResults(ctx, game, fighters!, uiTick, resultsAge, xpBanner,
      net
        ? `TAP / ENTER: REMATCH · ${queuedMode === 'solo' ? '1 CR' : '10 CR'}        ESC: CHANGE FIGHTER`
        : undefined);
    // Online: the server's verdict is the real result (ADR 0003).
    if (net) {
      ctx.font = 'bold 15px "Courier New", monospace';
      ctx.textAlign = 'center';
      if (net.result) {
        const ok = net.result.reason === 'verified';
        const pot = net.setup?.mode === 'wager' && (net.setup.fee ?? 0) > 0
          ? ` · POT ${(net.setup.fee ?? 0) * 2} CR` : '';
        ctx.fillStyle = ok ? '#7ee85a' : '#ffd166';
        ctx.fillText(
          ok ? `✓ SERVER-VERIFIED RESULT · ${net.result.rounds[0]}-${net.result.rounds[1]}${pot}`
            : `RESULT: ${net.result.reason.toUpperCase()}`,
          VW / 2, VH - 44);
      } else {
        ctx.fillStyle = '#ffffff88';
        ctx.fillText('VERIFYING WITH SERVER…', VW / 2, VH - 44);
      }
    }
    drawWalletStrip();
    // 'back' overlaps the full-screen 'start' region, so check it first.
    if (pressedThisFrame.has('Escape') || taps.has('back')) {
      net?.close();
      net = null;
      screen = 'select'; locked = [false, false];
      void audio.playBgm('player_select', { fadeInSec: 0.5 });
    } else if (pressedThisFrame.has('Enter') || taps.has('start')) {
      // INSTANT REMATCH (P0): one input → straight back into the queue with
      // the same fighter and mode. No select detour, no re-confirm.
      if (net) {
        const again = queuedMode;
        net.close();
        net = null;
        startOnline(again);
      } else {
        startFight();
      }
    }
  }

  // The arcade overlay belongs to the match only — push the screen this frame
  // ended on, so it appears/disappears in lockstep with what was just drawn.
  setTouchScreen(screen);

  pressedThisFrame.clear();
  taps.clear();
};

// ---------------------------------------------------------------- loop
let last = performance.now();
let acc = 0;

// Perf overlay (F): live FPS (rAF cadence), frame cost (sim+render ms), and
// the netcode stall counter — the triage tool for "the game feels slow":
// low FPS = this machine/browser; high ms/f = our renderer; stalls = network.
let perfShow = false;
let perfFps = 60;
let perfMs = 0;
addEventListener('keydown', (e) => { if (e.code === 'KeyF') perfShow = !perfShow; });

const drawPerf = (): void => {
  const stalled = net ? net.stalled : 0;
  const txt = `${perfFps.toFixed(0)} FPS  ·  ${perfMs.toFixed(1)} ms/f${net ? `  ·  stall ${stalled}` : ''}`;
  ctx.save();
  ctx.font = 'bold 11px "Courier New", monospace';
  ctx.textAlign = 'right';
  const w = ctx.measureText(txt).width + 14;
  ctx.fillStyle = '#000000aa';
  ctx.fillRect(VW - w - 6, VH - 40, w, 18);
  ctx.fillStyle = perfFps > 55 ? '#7ee85a' : perfFps > 40 ? '#ffd166' : '#ff6b6b';
  ctx.fillText(txt, VW - 13, VH - 27);
  ctx.restore();
};

const loop = (now: number): void => {
  const rafDt = now - last;
  acc = Math.min(acc + rafDt, 200); // tab-switch guard
  last = now;
  perfFps += ((1000 / Math.max(1, rafDt)) - perfFps) * 0.05; // EMA
  let ran = false;
  const t0 = performance.now();
  while (acc >= TICK_MS) {
    frame();
    acc -= TICK_MS;
    ran = true;
  }
  if (ran) perfMs += (performance.now() - t0 - perfMs) * 0.1; // EMA
  if (!ran && screen === 'loading') frame(); // keep the loading screen painted
  if (perfShow) drawPerf();
  requestAnimationFrame(loop);
};

void boot();
requestAnimationFrame(loop);

/**
 * Console/automation hooks. `afStep(n)` advances exactly n frames without
 * rAF — the hook automated visual tests and headless screenshots drive
 * (browsers throttle rAF to zero in hidden tabs). Replay export lands here
 * later; the input log is already the full match record.
 */
Object.assign(globalThis, {
  afGame: () => game,
  afRosters: () => allRosters,
  afScreen: () => screen,
  afCam: () => ({ ...cam }),
  afStep: (n = 1) => { for (let k = 0; k < n; k++) frame(); },
  afPress: (code: string) => { pressedThisFrame.add(code); keys.add(code); },
  afRelease: (code: string) => { keys.delete(code); },
  afMode: (m?: Mode) => { if (m) mode = m; return mode; },
  afProfile: () => ({ ...profile, lever }),
  afAccount: () => (account ? { ...account, fetch: accountFetch } : { fetch: accountFetch }),
  afSetLever: (v: number) => { lever = Math.max(-10, Math.min(10, v | 0)); saveLever(lever); },
  afNet: () => (net ? {
    status: net.status, error: net.error, setup: net.setup, result: net.result,
    stalled: net.stalled, side: net.side,
  } : null),
});

// Mobile: auto-detect touch devices and lay the on-screen controls over the
// canvas; register the PWA + offer install on the first landing. Both are
// no-ops on desktop / when already installed. Runs after afScreen (above) is
// exposed so the overlay can sync its visibility to the current game screen.
initPwa();
initTouchControls();
