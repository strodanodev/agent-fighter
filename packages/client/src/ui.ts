import {
  AI_PERSONALITY_RANGES, EXIT_BONUS, EXIT_FIGHT_FLOOR, REGION_NAME, REGION_SKILL,
  STAGE, TICKS_PER_SEC, TUNING, exitRoutes, nodeById, successors,
} from '@af/core';
import type { Board, BoardNode, BoardNodeKind, BoardRegion, ExitTier, GameState } from '@af/core';
import { drawIdleSprite, drawPortrait } from './atlas.js';
import type { Roster } from './atlas.js';
import {
  DISPLAY_FONT_STACK, HUD_GEO, clipPoly, drawBgVideoCover, drawChrome, drawStageLayers, opaqueBBox, stageCamLimits,
} from './chrome.js';
import type { BgVideo, ImgBBox, StageAsset, StageCamLimits, UiKit } from './chrome.js';
import { fxPulse, glowBar, marchingOutline, warningPulse } from './fx.js';
import { drawFlag } from './flags.js';

// Injected at boot (null = procedural fallbacks everywhere).
let uiKit: UiKit | null = null;
let stageAsset: StageAsset | null = null;
let logoImg: HTMLImageElement | null = null;
let logoBBox: ImgBBox | null = null;
let gameLogoImg: HTMLImageElement | null = null;
let gameLogoBBox: ImgBBox | null = null;
let bgVideo: BgVideo | null = null;
export const setUiKit = (k: UiKit): void => { uiKit = k; };
export const setStageAsset = (s: StageAsset | null): void => { stageAsset = s; };
// The logo art is a design-tool SVG export with large transparent padding
// around the wordmark (verified: raw viewBox 1363.5×720.75, actual glyph
// content roughly the middle-right third) — cropping to its opaque bbox once
// here is what lets drawTitle cover-fit just the artwork, not the void.
export const setLogo = (img: HTMLImageElement | null): void => {
  logoImg = img;
  logoBBox = img ? opaqueBBox(img) : null;
};
// Same crop-to-opaque-bbox treatment for the compact in-game badge logo.
export const setGameLogo = (img: HTMLImageElement | null): void => {
  gameLogoImg = img;
  gameLogoBBox = img ? opaqueBBox(img) : null;
};
export const setBgVideo = (v: BgVideo | null): void => { bgVideo = v; };
// Vending-machine art (ADR 0007) — already alpha-matted tight, no bbox pass.
let vendingImg: HTMLImageElement | null = null;
export const setVendingArt = (img: HTMLImageElement | null): void => { vendingImg = img; };

/**
 * Menu backdrop: the looping ambient video when it's playing, falling back
 * to the static stage art (menuCam + drawStage) otherwise — used by both the
 * title and character-select screens. Screen-space (not world-transformed);
 * the video is an ambient backdrop, not a stage element.
 */
const drawMenuBackdrop = (ctx: CanvasRenderingContext2D): void => {
  if (bgVideo && drawBgVideoCover(ctx, bgVideo, 0, 0, VW, VH)) return;
  ctx.save();
  const cam = menuCam();
  worldTransform(ctx, cam);
  drawStage(ctx, cam);
  ctx.restore();
};

/**
 * Camera limits for the active stage, or null when there's no art (procedural
 * fallback stage) — in which case the camera keeps its old unbounded behavior.
 */
export const currentStageCamLimits = (): StageCamLimits | null =>
  stageAsset && (stageAsset.image || stageAsset.layers.length > 0)
    ? stageCamLimits(stageAsset, VW, VH)
    : null;

/**
 * The active stage's VIEW-LOCK region in world px. The camera clamps `cam.x`
 * to it; no bounds (or no stage art) → the full stage width, i.e. today's
 * behavior. Kept in lockstep with the sim walls the server pins per match.
 */
export const currentStageBounds = (): { left: number; right: number } => {
  const b = stageAsset?.meta.bounds;
  return b ? { left: b.left, right: b.right } : { left: 0, right: STAGE.widthPx };
};

/**
 * Arcade presentation layer: rooftop stage, framed HUD, title / select /
 * results screens. Pure drawing — zero game logic, zero sim reads beyond the
 * exported GameState fields. Character art is the only thing not authored
 * here; everything else (chrome, stage fallback, typography) is procedural
 * or a customizable asset file (assets/ui/*.svg, assets/fonts/).
 */

export type Mode = 'cpu' | '2p' | 'online';

export const VW = STAGE.viewportW; // 960 — screen px
export const VH = STAGE.viewportH; // 540

/**
 * Dynamic camera (the classic fighting-game rig). The sim thinks in world
 * pixels — a fighter is 112 tall — and the camera frames BOTH fighters:
 * zoomed in tight during neutral (big, readable characters) and pulling back
 * on super jumps and air combos so nobody leaves the frame.
 *
 * Everything drawn under `worldTransform()` is in WORLD coordinates; the HUD
 * is drawn afterwards in screen coordinates.
 */
export interface Cam { x: number; y: number; zoom: number }

export const ZOOM_MIN = 0.85;
export const ZOOM_MAX = 1.9;
/** Fighters must be framed below the HUD and above the bottom edge. */
export const CONTENT_TOP = 132;
export const CONTENT_BOT = VH - 12;

// ------------------------------------------------------------ tap targets
/**
 * Tappable regions in canvas (960×540) space, rebuilt from scratch every
 * frame by the draw functions as they lay their UI out.
 *
 * The point of registering a rect from inside the same code that draws the
 * element is that a tap target can never silently drift away from what the
 * player actually sees — move the art, the hitbox moves with it. main.ts
 * clears the list each frame, then hit-tests pointer taps against it; touch
 * and mouse both arrive through that one path.
 *
 * `action` is semantic ('mode:cpu', 'pick:3'), NOT a key code — the screen
 * handlers in main.ts decide what each one means.
 */
export interface TapRegion { x: number; y: number; w: number; h: number; action: string }
let tapRegions: TapRegion[] = [];
export const resetTaps = (): void => { tapRegions = []; };
/** Register a tappable rect (canvas space). Cheap — just a push. */
export const tapZone = (x: number, y: number, w: number, h: number, action: string): void => {
  tapRegions.push({ x, y, w, h, action });
};
/** Topmost region containing the point, or null. Later draws win overlaps. */
export const tapHit = (vx: number, vy: number): string | null => {
  for (let i = tapRegions.length - 1; i >= 0; i--) {
    const r = tapRegions[i]!;
    if (vx >= r.x && vx < r.x + r.w && vy >= r.y && vy < r.y + r.h) return r.action;
  }
  return null;
};
/** Debug/test hook: what's currently tappable. */
export const tapRegionList = (): TapRegion[] => tapRegions.slice();

export const worldTransform = (ctx: CanvasRenderingContext2D, cam: Cam): void => {
  ctx.scale(cam.zoom, cam.zoom);
  ctx.translate(-cam.x, -cam.y);
};

/**
 * Fixed camera for the menu backdrops (title / character select / stage
 * select). Always centered on the middle of the stage image so every stage
 * previews the same way on first load, regardless of where its detail sits.
 */
const MENU_ZOOM = 1.5;
export const menuCam = (): Cam => ({
  x: STAGE.widthPx / 2 - (VW / MENU_ZOOM) / 2, // horizontally centered on the image
  y: STAGE.floorYPx - (VH / MENU_ZOOM) * 0.86,
  zoom: MENU_ZOOM,
});

// ---------------------------------------------------------------- palette
const GOLD = '#d9a441';
const GOLD_LT = '#f7e0a3';
const GOLD_DK = '#8a5f1e';
const PANEL = '#14121f';
const PANEL_LT = '#2a2438';
const HP_HI = '#7ee85a';
const HP_LO = '#3fa22c';
const HP_DANGER = '#e94560';
const METER_HI = '#6fd3ff';
const METER_FULL = '#ffd166';

export const P_COLORS = ['#e94560', '#4ea8de'] as const;

// ---------------------------------------------------------------- easing
/** Ease-out cubic — snappy start, soft landing. Used for pop-ins. */
const easeOutCubic = (t: number): number => 1 - (1 - t) ** 3;
/** Ease-out back — slight overshoot, the "arrives with a little bounce" feel. */
const easeOutBack = (t: number): number => {
  const c1 = 1.70158, c3 = c1 + 1;
  return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2;
};
const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

// ---------------------------------------------------------------- helpers
/** Beveled plate: the workhorse of the arcade frame look. */
const bevel = (
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number,
  fill: string, light = GOLD_LT, dark = GOLD_DK, t = 2,
): void => {
  ctx.fillStyle = fill;
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = light;
  ctx.fillRect(x, y, w, t); // top
  ctx.fillRect(x, y, t, h); // left
  ctx.fillStyle = dark;
  ctx.fillRect(x, y + h - t, w, t); // bottom
  ctx.fillRect(x + w - t, y, t, h); // right
};

/**
 * Clean condensed-bold label text — nameplates, hints, HUD numbers. Same
 * type family as the display treatment (Anton) for a cohesive "one game, one
 * font" arcade look, but flat (no skew/outline) so small/fast-changing text
 * stays crisp and legible.
 */
const label = (
  ctx: CanvasRenderingContext2D, s: string, x: number, y: number,
  size: number, color: string, align: CanvasTextAlign = 'center', shadow = true,
): void => {
  ctx.font = `${size}px ${DISPLAY_FONT_STACK}`;
  ctx.textAlign = align;
  ctx.textBaseline = 'alphabetic';
  if (shadow) {
    ctx.fillStyle = '#000000aa';
    ctx.fillText(s, x + 2, y + 2);
  }
  ctx.fillStyle = color;
  ctx.fillText(s, x, y);
};
/** @deprecated alias kept for readability at call sites migrated gradually. */
const text = label;

export interface DisplayOpts {
  align?: CanvasTextAlign;
  skew?: number; // italic shear, 0 = upright
  from?: string; // gradient top stop
  mid?: string;
  to?: string; // gradient bottom stop
  outline?: string;
  rim?: string; // thin bright inner stroke
  glow?: string;
  glowBlur?: number;
  scale?: number; // pop-in / pulse animation hook
  alpha?: number;
}

/**
 * SF-style display type: italic-sheared Anton, heavy dark outline, warm
 * vertical gradient fill, thin bright rim for pop. Used for anything that
 * should feel like arcade-cabinet marquee text — logo, round announcements,
 * results title, combo counter, level-up banner.
 */
const display = (
  ctx: CanvasRenderingContext2D, s: string, x: number, y: number, size: number,
  opts: DisplayOpts = {},
): void => {
  const {
    align = 'center', skew = 0.16,
    from = '#fff8e6', mid = '#ffd166', to = '#c9781a',
    outline = '#33101a', rim = 'rgba(255,255,255,0.55)',
    glow, glowBlur = 18, scale = 1, alpha = 1,
  } = opts;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(x, y);
  if (scale !== 1) ctx.scale(scale, scale);
  ctx.transform(1, 0, -skew, 1, 0, 0);
  ctx.font = `${size}px ${DISPLAY_FONT_STACK}`;
  ctx.textAlign = align;
  ctx.textBaseline = 'alphabetic';
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;

  if (glow) { ctx.shadowColor = glow; ctx.shadowBlur = glowBlur; }
  ctx.strokeStyle = outline;
  ctx.lineWidth = Math.max(2, size * 0.16);
  ctx.strokeText(s, 0, 0);
  ctx.shadowBlur = 0; // glow only wants the outline pass, not a double-blur on fill

  const g = ctx.createLinearGradient(0, -size * 0.78, 0, size * 0.12);
  g.addColorStop(0, from);
  g.addColorStop(0.5, mid);
  g.addColorStop(1, to);
  ctx.fillStyle = g;
  ctx.fillText(s, 0, 0);

  ctx.strokeStyle = rim;
  ctx.lineWidth = Math.max(1, size * 0.035);
  ctx.strokeText(s, 0, 0);
  ctx.restore();
};

const DANGER_OPTS: DisplayOpts = { from: '#ffe3e6', mid: '#ff6b81', to: '#8f1626', outline: '#2a0810' };
const COOL_OPTS: DisplayOpts = { from: '#eaf6ff', mid: '#7fd0ff', to: '#1a5f8f', outline: '#0a1a2a' };

/**
 * Emphasized CREDITS readout — a big, glowing gold "⛁ N CR". The whole
 * economy runs on credits, so they get the loudest treatment on the home and
 * select screens. Left-anchored; returns the drawn width so a small stats line
 * can sit beside it. `y` is the baseline.
 */
const drawCredits = (
  ctx: CanvasRenderingContext2D, x: number, y: number, credits: number, size: number,
): number => {
  const txt = `⛁ ${credits.toLocaleString()} CR`;
  ctx.save();
  ctx.font = `${size}px ${DISPLAY_FONT_STACK}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  // Gold bloom pass, then a crisp fill on top.
  ctx.shadowColor = 'rgba(255,190,60,0.75)';
  ctx.shadowBlur = size * 0.7;
  ctx.fillStyle = '#ffe28c';
  ctx.fillText(txt, x, y);
  ctx.shadowBlur = 0;
  ctx.fillStyle = '#000000aa';
  ctx.fillText(txt, x + 1.5, y + 1.5);
  ctx.fillStyle = '#ffd23a';
  ctx.fillText(txt, x, y);
  const w = ctx.measureText(txt).width;
  ctx.restore();
  return w;
};

/**
 * Center announcement (ROUND n / FIGHT! / K.O. / DOUBLE KO) — the marquee
 * moment of each round. Drawn as the FRONT-MOST HUD element (called dead last
 * in drawHud, after the brand badge) so nothing occludes it.
 *
 * The look: a cinematic dark letterbox band for contrast over busy stages,
 * radiating speed lines on entry, a heavy slam-in with overshoot (plus a
 * short shake on K.O.), a diagonal gleam that sweeps across as it settles, and
 * a per-type palette (gold for ROUND/FIGHT, red for K.O.). `age` is ticks
 * since the text last changed (fx.announceAge), driving the whole timeline.
 */
const drawAnnounce = (ctx: CanvasRenderingContext2D, s: string, age: number): void => {
  // Rise in ~5 ticks, hold, fade out by ~112; nothing draws once faded.
  const alpha = clamp01(Math.min(age / 5, (112 - age) / 20));
  if (alpha <= 0) return;

  const danger = s === 'K.O.' || s === 'DOUBLE KO';
  const isFight = s === 'FIGHT!';
  const size = danger ? 112 : isFight ? 98 : 80;
  const cx = VW / 2, cy = 258;

  // Slam: overshoot down from a large scale to 1, then a faint breathe.
  const inT = clamp01(age / 9);
  const scale = (1.95 - 0.95 * easeOutBack(inT)) * (1 + 0.02 * Math.sin(age / 9));
  const shake = danger && age < 16 ? Math.sin(age * 2.3) * (1 - age / 16) * 7 : 0;

  ctx.font = `${size}px ${DISPLAY_FONT_STACK}`;
  const tw = ctx.measureText(s).width * scale + size * 0.5;

  // 1) Letterbox band — a soft dark strip behind the text so it reads over any
  // stage. Full width; vertical gradient fades top/bottom.
  ctx.save();
  ctx.globalAlpha = alpha;
  const bandH = size * 1.5;
  const band = ctx.createLinearGradient(0, cy - bandH * 0.72, 0, cy + bandH * 0.28);
  band.addColorStop(0, 'rgba(6,4,12,0)');
  band.addColorStop(0.5, 'rgba(6,4,12,0.72)');
  band.addColorStop(1, 'rgba(6,4,12,0)');
  ctx.fillStyle = band;
  ctx.fillRect(0, cy - bandH * 0.72, VW, bandH);
  ctx.restore();

  // 2) Speed lines — brief horizontal streaks radiating from the center on
  // entry, additive, selling the impact.
  if (age < 16) {
    const sl = (1 - age / 16) * alpha;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = danger ? `rgba(255,120,140,${0.4 * sl})` : `rgba(255,225,150,${0.4 * sl})`;
    for (let k = -2; k <= 2; k++) {
      if (k === 0) continue;
      const ly = cy - size * 0.32 + k * size * 0.24;
      const len = (100 + age * 26) * (1.1 - Math.abs(k) * 0.18);
      ctx.lineWidth = size * 0.03;
      ctx.beginPath(); ctx.moveTo(cx - len, ly); ctx.lineTo(cx - size * 0.9, ly);
      ctx.moveTo(cx + len, ly); ctx.lineTo(cx + size * 0.9, ly); ctx.stroke();
    }
    ctx.restore();
  }

  // 3) The text itself (SF-style display treatment, per-type palette + glow).
  display(ctx, s, cx + shake, cy, size, {
    scale, alpha,
    ...(danger ? DANGER_OPTS : {}),
    glow: danger ? 'rgba(255,60,90,0.85)' : 'rgba(255,214,120,0.8)',
    glowBlur: size * 0.4,
  });

  // 4) Gleam — a diagonal highlight sweeping across the text as it settles.
  const gT = (age - 6) / 22;
  if (gT > 0 && gT < 1) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(cx - tw / 2 - 12, cy - size * 1.05, tw + 24, size * 1.3);
    ctx.clip();
    ctx.globalCompositeOperation = 'lighter';
    ctx.translate(cx - tw / 2 - 20 + gT * (tw + 60), cy - size * 0.4);
    ctx.rotate(-0.26);
    const gw = size * 0.55;
    const gl = ctx.createLinearGradient(-gw / 2, 0, gw / 2, 0);
    const gi = Math.sin(gT * Math.PI) * 0.6 * alpha;
    gl.addColorStop(0, 'rgba(255,255,255,0)');
    gl.addColorStop(0.5, `rgba(255,255,255,${gi})`);
    gl.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = gl;
    ctx.fillRect(-gw / 2, -size * 1.3, gw, size * 2.6);
    ctx.restore();
  }
};

// ---------------------------------------------------------------- stage
/**
 * Rooftop at sunset: parallax skyline, chain-link fence, tiled deck.
 * Drawn in WORLD coordinates — call under worldTransform(). Parallax layers
 * counter-shift by the camera so distant things drift slower.
 */
export const drawStage = (ctx: CanvasRenderingContext2D, cam: Cam): void => {
  const viewW = VW / cam.zoom;
  const viewH = VH / cam.zoom;
  const L = cam.x, R = cam.x + viewW, T = cam.y, B = cam.y + viewH;
  const floorY = STAGE.floorYPx;

  // Image stage (stages/<id>/, single flat background OR parallax layers) —
  // the procedural rooftop below is only the fallback for a checkout with
  // no stage assets at all.
  if (stageAsset && (stageAsset.image || stageAsset.layers.length > 0)) {
    drawStageLayers(ctx, stageAsset, cam, VW, VH);
    ctx.fillStyle = 'rgba(16, 10, 28, 0.18)'; // veil: fighters pop
    ctx.fillRect(L - 10, T - 10, viewW + 20, viewH + 20);
    return;
  }

  // Sky.
  const sky = ctx.createLinearGradient(0, T, 0, floorY);
  sky.addColorStop(0, '#2b1b4d');
  sky.addColorStop(0.42, '#6a2f6b');
  sky.addColorStop(0.75, '#c05a5a');
  sky.addColorStop(1, '#f0a35e');
  ctx.fillStyle = sky;
  ctx.fillRect(L - 10, T - 10, viewW + 20, floorY - T + 20);

  // Sun (very slow parallax).
  ctx.fillStyle = '#ffd9a0';
  ctx.beginPath();
  ctx.arc(STAGE.widthPx * 0.5 + cam.x * 0.72, floorY - 120, 54, 0, Math.PI * 2);
  ctx.fill();

  // Far skyline.
  ctx.fillStyle = '#3a2352';
  for (let i = 0; i < 30; i++) {
    const bw = 54 + ((i * 37) % 40);
    const bh = 90 + ((i * 53) % 120);
    const x = i * 90 + cam.x * 0.35; // counter-shift = slower drift
    if (x > R + 60 || x + bw < L - 60) continue;
    ctx.fillRect(x, floorY - bh, bw, bh);
  }
  // Near skyline + lit windows.
  for (let i = 0; i < 26; i++) {
    const bw = 70 + ((i * 29) % 46);
    const bh = 140 + ((i * 71) % 130);
    const bx = i * 110 + 30 + cam.x * 0.16;
    if (bx > R + 80 || bx + bw < L - 80) continue;
    const by = floorY - bh;
    ctx.fillStyle = '#241638';
    ctx.fillRect(bx, by, bw, bh);
    ctx.fillStyle = '#ffcf7a44';
    for (let wy = by + 12; wy < by + bh - 10; wy += 22) {
      for (let wxx = bx + 8; wxx < bx + bw - 10; wxx += 18) {
        if ((Math.trunc(wxx) * 7 + Math.trunc(wy) * 13 + i) % 3 === 0) ctx.fillRect(wxx, wy, 7, 10);
      }
    }
  }

  // Chain-link fence (world-locked, behind the fighters).
  const fenceTop = floorY - 118;
  ctx.strokeStyle = '#2a243888';
  ctx.lineWidth = 1;
  const startX = Math.floor((L - 20) / 14) * 14;
  for (let wx = startX; wx < R + 20; wx += 14) {
    ctx.beginPath();
    ctx.moveTo(wx, fenceTop);
    ctx.lineTo(wx + 14, floorY);
    ctx.moveTo(wx + 14, fenceTop);
    ctx.lineTo(wx, floorY);
    ctx.stroke();
  }
  ctx.strokeStyle = '#4a4260';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(L - 10, fenceTop);
  ctx.lineTo(R + 10, fenceTop);
  ctx.stroke();
  ctx.fillStyle = '#3a3450';
  for (let wx = Math.floor(L / 180) * 180; wx < R + 180; wx += 180) {
    ctx.fillRect(wx, fenceTop, 6, floorY - fenceTop);
  }

  // Roof deck.
  ctx.fillStyle = '#4a4358';
  ctx.fillRect(L - 10, floorY, viewW + 20, Math.max(40, B - floorY + 20));
  ctx.fillStyle = '#3e384a';
  ctx.fillRect(L - 10, floorY, viewW + 20, 5);
  ctx.strokeStyle = '#5a5370';
  ctx.lineWidth = 1;
  for (let wx = Math.floor((L - 200) / 90) * 90; wx < R + 200; wx += 90) {
    ctx.beginPath();
    ctx.moveTo(wx, floorY + 5);
    ctx.lineTo(wx - 60, B + 20);
    ctx.stroke();
  }
  for (let k = 1; k < 5; k++) {
    const y = floorY + 5 + k * k * 6;
    if (y > B + 10) break;
    ctx.beginPath();
    ctx.moveTo(L - 10, y);
    ctx.lineTo(R + 10, y);
    ctx.stroke();
  }
  // Puddles catching the sunset.
  ctx.fillStyle = '#c07a6a33';
  for (const [wx, wy, ww] of [[240, 30, 90], [900, 52, 130], [1420, 24, 70]] as const) {
    ctx.beginPath();
    ctx.ellipse(wx, floorY + wy, ww / 2, 6, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.lineWidth = 1;

  // Atmospheric veil: pushes the stage back so the fighters (drawn next) pop.
  ctx.fillStyle = 'rgba(20, 12, 34, 0.34)';
  ctx.fillRect(L - 10, T - 10, viewW + 20, viewH + 20);
};

// ---------------------------------------------------------------- HUD
/**
 * HUD layout (rows, top-down): health bar · nameplate+pips · meter, with the
 * portrait outboard of the bars and the drink rack hanging under it.
 * Asset sizes derive from the SVG kit geometry (HUD_GEO), scaled to fit the
 * 960px frame: portrait(92) · bar(328) · timer(96) · bar · portrait.
 *
 * 2026-07 layout pass (phone-first). Two things swapped places:
 *  · ROUND PIPS moved off the meter row (`pipY` 90 → 54). They used to sit at
 *    y=90 on the rail that the 318px-wide meter also occupies, and since the
 *    meter is drawn after them it painted straight over the top — the
 *    match score was invisible for most of a fight.
 *  · The DRINK RACK vacated that rail (it was the pips' new home) and moved
 *    under the portrait, which is where a phone thumb can actually reach it
 *    without crossing the fight, and reads as "this player's kit".
 */
const HUD = {
  edge: 108, // inner start of the bars (portraits live outside this)
  barW: 328,
  barH: 38,
  barY: 12,
  nameW: 226,
  nameH: 25,
  nameY: 56,
  /** Gap from the nameplate's inner end to the pip rail. */
  railGap: 22,
  pipY: 54, // under the health bar, clear of the meter row
  meterY: 88,
  meterSegW: 102,
  meterSegH: 15,
  /** Portrait thumbnail box — the drink rack is centred under it. */
  portraitS: 92,
  portraitPad: 8,
  portraitY: 8,
} as const;

/** Left edge of player i's portrait thumbnail. */
const portraitX = (i: 0 | 1): number =>
  (i === 0 ? HUD.portraitPad : VW - HUD.portraitPad - HUD.portraitS);

const drawHealthBar = (
  ctx: CanvasRenderingContext2D,
  i: 0 | 1, ratio: number, flashRatio: number, tick: number,
): void => {
  const { barW, barH, barY: y } = HUD;
  const x = i === 0 ? HUD.edge : VW - HUD.edge - barW;
  const mirror = i === 1;
  const danger = ratio < 0.25 && ratio > 0;

  const fillBar = (r: number, style: string | CanvasGradient): void => {
    const g = HUD_GEO.healthframe;
    ctx.save();
    clipPoly(ctx, HUD_GEO.healthWindow, g.w, g.h, x, y, barW, barH, mirror);
    // MvC drain: remaining health anchors at the OUTER edge; damage eats
    // from the center-facing tip.
    const w = barW * Math.max(0, Math.min(1, r));
    ctx.fillStyle = style;
    ctx.fillRect(i === 0 ? x : x + barW - w, y, w, barH);
    ctx.restore();
  };

  // Low-health urgency: a pulsing red warning halo hugging the frame.
  if (danger) warningPulse(ctx, x - 4, y - 4, barW + 8, barH + 8, tick, HP_DANGER);

  if (uiKit?.healthframe) {
    // Paint order under the frame: dark tray → damage flash → health → gloss.
    fillBar(1, '#0c0e13');
    fillBar(flashRatio, '#ffffff66');
    const grad = ctx.createLinearGradient(0, y, 0, y + barH);
    grad.addColorStop(0, danger ? '#ff8d9e' : '#b9f66d');
    grad.addColorStop(0.45, danger ? HP_DANGER : HP_HI);
    grad.addColorStop(1, danger ? '#7a1b2b' : HP_LO);
    fillBar(ratio, grad);
    // Gloss line inside the window.
    ctx.save();
    const g = HUD_GEO.healthframe;
    clipPoly(ctx, HUD_GEO.healthWindow, g.w, g.h, x, y, barW, barH, mirror);
    ctx.fillStyle = '#ffffff2e';
    ctx.fillRect(x, y + 3, barW, 6);
    ctx.restore();
    drawChrome(ctx, uiKit.healthframe, x, y, barW, barH, mirror);
    return;
  }

  // Procedural fallback.
  bevel(ctx, x - 3, y - 3, barW + 6, barH + 6, PANEL, GOLD, GOLD_DK, 2);
  const fw = Math.round((barW - 4) * Math.max(0, ratio));
  ctx.fillStyle = '#ffffff55';
  ctx.fillRect(i === 0 ? x + 2 : x + barW - 2 - Math.round((barW - 4) * flashRatio), y + 2,
    Math.round((barW - 4) * flashRatio), barH - 4);
  ctx.fillStyle = danger ? HP_DANGER : HP_HI;
  ctx.fillRect(i === 0 ? x + 2 : x + barW - 2 - fw, y + 2, fw, barH - 4);
};

const drawMeter = (ctx: CanvasRenderingContext2D, i: 0 | 1, meter: number, tick: number): void => {
  const bars = Math.round(TUNING.meterMax / TUNING.meterBar);
  const gap = 6;
  const segW = HUD.meterSegW, segH = HUD.meterSegH;
  const total = bars * segW + (bars - 1) * gap;
  const startX = i === 0 ? HUD.edge : VW - HUD.edge - total;
  const y = HUD.meterY;
  const mirror = i === 1;
  for (let b = 0; b < bars; b++) {
    // Segments fill outward from the screen edge, like the health bar.
    const idx = i === 0 ? b : bars - 1 - b;
    const x = startX + idx * (segW + gap);
    const seg = Math.max(0, Math.min(TUNING.meterBar, meter - b * TUNING.meterBar));
    const ratio = seg / TUNING.meterBar;
    const full = ratio >= 1;
    if (uiKit?.meterseg) {
      const g = HUD_GEO.meterseg;
      ctx.save();
      clipPoly(ctx, HUD_GEO.meterWindow, g.w, g.h, x, y, segW, segH, mirror);
      ctx.fillStyle = '#0c0e13';
      ctx.fillRect(x, y, segW, segH);
      ctx.fillStyle = full ? METER_FULL : METER_HI;
      const w = segW * ratio;
      ctx.fillRect(mirror ? x + segW - w : x, y, w, segH);
      ctx.restore();
      drawChrome(ctx, uiKit.meterseg, x, y, segW, segH, mirror);
    } else {
      bevel(ctx, x, y, segW, segH, '#191524', '#4a4260', '#0d0a14', 1);
      ctx.fillStyle = full ? METER_FULL : METER_HI;
      ctx.fillRect(x + 1, y + 1, Math.round((segW - 2) * ratio), segH - 2);
    }
    // A full bar breathes with a warm halo — usable meter is "hot".
    if (full) glowBar(ctx, x, y, segW, segH, METER_FULL, 8, fxPulse(tick, 0.16, 0.4, 0.85));
  }
  // ULTIMATE READY (all bars full): a marching-ants outline sweeps the strip.
  if (meter >= TUNING.meterMax) {
    marchingOutline(ctx, startX - 2, y - 2, total + 4, segH + 4, tick, METER_FULL);
  }
};

const drawPortraitFrame = (
  ctx: CanvasRenderingContext2D, i: 0 | 1, roster: Roster, lowHealth: boolean,
): void => {
  const s = HUD.portraitS;
  const x = portraitX(i);
  const y = HUD.portraitY;
  const win = HUD_GEO.portraitWindow;

  ctx.save();
  if (lowHealth) ctx.filter = 'saturate(0.4) brightness(0.8)';
  if (uiKit?.portrait) {
    drawPortrait(ctx, roster, x + win.x, y + win.y, win.w, win.h);
  } else {
    drawPortrait(ctx, roster, x + 4, y + 4, s - 8, s - 8);
  }
  ctx.restore();
  if (uiKit?.portrait) drawChrome(ctx, uiKit.portrait, x, y, s, s, i === 1);
  else bevel(ctx, x, y, s, s, '#00000000', GOLD, GOLD_DK, 3);

  // Player tag.
  ctx.fillStyle = P_COLORS[i];
  const tagX = i === 0 ? x + 4 : x + s - 30;
  ctx.fillRect(tagX, y + s - 20, 26, 14);
  label(ctx, `P${i + 1}`, tagX + 13, y + s - 9, 12, '#fff', 'center', false);
};

const drawNameplate = (ctx: CanvasRenderingContext2D, i: 0 | 1, name: string): void => {
  const w = HUD.nameW, h = HUD.nameH;
  const x = i === 0 ? HUD.edge : VW - HUD.edge - w;
  const y = HUD.nameY;
  if (uiKit?.nameplate) {
    drawChrome(ctx, uiKit.nameplate, x, y, w, h, i === 1);
  } else {
    bevel(ctx, x, y, w, h, PANEL, GOLD, GOLD_DK, 2);
  }
  label(ctx, name.toUpperCase(), i === 0 ? x + 16 : x + w - 16, y + h - 7, 15, '#e8e4da',
    i === 0 ? 'left' : 'right');
};

/**
 * Rounds won, on the rail just inside the nameplate's end and one row up from
 * the meter. Pips fill outward from the screen edge like everything else in
 * the block, so P1's score reads left→right and P2's right→left.
 */
const drawRoundPips = (ctx: CanvasRenderingContext2D, i: 0 | 1, wins: number): void => {
  const need = TUNING.roundsToWin;
  const g = HUD_GEO.pip;
  const gap = 7;
  for (let r = 0; r < need; r++) {
    const x = i === 0
      ? HUD.edge + HUD.nameW + HUD.railGap + r * (g.w + gap)
      : VW - HUD.edge - HUD.nameW - HUD.railGap - g.w - r * (g.w + gap);
    const on = r < wins;
    if (uiKit?.pipOn && uiKit.pipOff) {
      drawChrome(ctx, on ? uiKit.pipOn : uiKit.pipOff, x, HUD.pipY, g.w, g.h, i === 1);
    } else {
      bevel(ctx, x, HUD.pipY, g.w, g.h, on ? GOLD : '#191524', on ? GOLD_LT : '#4a4260', GOLD_DK, 1);
    }
  }
};

const drawTimer = (ctx: CanvasRenderingContext2D, secs: number, tick: number): void => {
  const s = 96;
  const cx = VW / 2, y = 6;
  const urgent = secs <= 10 && secs > 0;
  // Urgent pulse: a small scale breathing so the last ten seconds read as tense.
  const pulse = urgent ? 1 + 0.06 * Math.sin(tick / 6) : 1;

  ctx.save();
  ctx.translate(cx, y + s / 2);
  ctx.scale(pulse, pulse);
  ctx.translate(-cx, -(y + s / 2));
  if (uiKit?.timer) {
    drawChrome(ctx, uiKit.timer, cx - s / 2, y, s, s);
    label(ctx, String(Math.max(0, secs)).padStart(2, '0'), cx, y + s / 2 + 15, 40,
      urgent ? HP_DANGER : '#ffffff');
    ctx.restore();
    return;
  }
  const cy = y + s / 2, r = 42;
  const oct = (rr: number): void => {
    ctx.beginPath();
    for (let k = 0; k < 8; k++) {
      const a = (Math.PI / 4) * k + Math.PI / 8;
      ctx.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
    }
    ctx.closePath();
  };
  oct(r);
  ctx.fillStyle = GOLD;
  ctx.fill();
  oct(r - 4);
  ctx.fillStyle = PANEL;
  ctx.fill();
  label(ctx, String(Math.max(0, secs)).padStart(2, '0'), cx, cy + 12, 34,
    urgent ? HP_DANGER : '#ffffff');
  ctx.restore();
};

/**
 * Brand badge over the fight timer — drawn LAST in drawHud (see the call
 * site) so it sits on the top layer, free to overlap the timer/health/meter
 * chrome beneath it. Crops to the art's opaque bbox (same reasoning as the
 * title logo — the source SVG carries transparent padding that would
 * otherwise show as an odd gap), sized to 175% of the original 100px base
 * (70% reduction × 2.5 enlargement, per the two size requests), and carries a
 * breathing scale pulse + a pulsing white/light-blue glow that follows the
 * art's own silhouette (shadowBlur tracks alpha, unlike a rectangular halo).
 * `topY` anchors the TOP edge (not center) — set to the timer's vertical
 * midpoint so the badge only overlaps the timer's lower half and hangs down
 * past it, rather than burying the whole badge. Silently omitted if the
 * asset hasn't loaded (fire-and-forget at boot).
 */
const drawGameLogo = (
  ctx: CanvasRenderingContext2D, cx: number, topY: number, tick: number,
  charged = false, // ≥1 meter bar → Auto Special can pop the super
): void => {
  if (!gameLogoImg || gameLogoImg.naturalWidth === 0) return;
  const box = gameLogoBBox ?? { x: 0, y: 0, w: gameLogoImg.naturalWidth, h: gameLogoImg.naturalHeight };
  const BASE_W = 100; // natural badge width before the size adjustments below
  const w = BASE_W * 0.7 * 2.5;
  const h = w * (box.h / box.w);
  // Charged reads as agitated, not just recoloured: it breathes harder and
  // faster, so the badge catches the eye in peripheral vision mid-fight.
  const breathe = charged
    ? fxPulse(tick, 0.11, 0.94, 1.12)
    : fxPulse(tick, 0.045, 0.96, 1.06);

  ctx.save();
  ctx.translate(cx, topY);
  ctx.scale(breathe, breathe);
  ctx.imageSmoothingEnabled = true;
  const glowMix = fxPulse(tick, charged ? 0.16 : 0.07); // 0..1
  if (charged) {
    // Aggressive red: hot core → deep red, pumping fast.
    const gr = 255, gg = Math.round(40 + 60 * glowMix), gb = Math.round(30 + 40 * glowMix);
    ctx.shadowColor = `rgba(${gr},${gg},${gb},${0.75 + 0.25 * fxPulse(tick, 0.19)})`;
    ctx.shadowBlur = 22 + 20 * fxPulse(tick, 0.19);
  } else {
    // Idle: pulses between near-white and light blue rather than a fixed hue.
    const gr = Math.round(210 + 40 * glowMix), gg = Math.round(235 + 15 * glowMix), gb = 255;
    ctx.shadowColor = `rgba(${gr},${gg},${gb},${0.55 + 0.35 * fxPulse(tick, 0.09)})`;
    ctx.shadowBlur = 14 + 10 * fxPulse(tick, 0.09);
  }
  // Two passes: the shadow builds a real halo around the artwork's own
  // silhouette without a second draw looking like a ghost/double-image.
  ctx.drawImage(gameLogoImg, box.x, box.y, box.w, box.h, -w / 2, 0, w, h);
  ctx.drawImage(gameLogoImg, box.x, box.y, box.w, box.h, -w / 2, 0, w, h);
  // A third pass while charged deepens the halo into a real red rim.
  if (charged) ctx.drawImage(gameLogoImg, box.x, box.y, box.w, box.h, -w / 2, 0, w, h);
  ctx.restore();

  // Tap target — generous, and registered from the same geometry that drew the
  // badge so it tracks the art. Unscaled bounds (the breathe is cosmetic).
  tapZone(cx - w / 2 - 8, topY - 8, w + 16, h + 16, 'special');
};

export interface HudFx {
  flash: [number, number]; // lagging health ratio per player (damage flash)
  comboOwner: number; // -1 none
  comboHits: number;
  comboAge: number; // ticks since comboOwner last went from none → set (drives the pop-in)
  announce: string;
  announceAge: number;
}

/**
 * Per-fighter identity for the HUD strip beneath the portrait/health/meter:
 * wallet + on-chain stats. Every field except `wallet` is optional so a live
 * opponent with unknown record, or a local guest, degrades gracefully. The
 * signed-in player's own row shows CREDITS (gold); an opponent shows its
 * record + streak + a Minds tag.
 */
export interface HudId {
  wallet: string; // already shortened (0xAB…CDEF), or ''
  credits?: number;
  level?: number;
  wins?: number;
  losses?: number;
  streak?: number;
  minds?: boolean;
}

/** The identity strip below one player's HUD block (under the meter). */
const drawPlayerId = (ctx: CanvasRenderingContext2D, i: 0 | 1, id: HudId): void => {
  const align: CanvasTextAlign = i === 0 ? 'left' : 'right';
  const ax = i === 0 ? HUD.edge : VW - HUD.edge;
  const y = HUD.meterY + HUD.meterSegH + 9; // just under the charge bar
  if (id.wallet) label(ctx, id.wallet, ax, y, 10, '#8fb6d8', align, true);
  const parts: string[] = [];
  const gold = id.credits !== undefined;
  if (gold) parts.push(`⛁ ${id.credits!.toLocaleString()} CR`);
  if (id.level) parts.push(`LV ${id.level}`);
  if ((id.wins ?? 0) + (id.losses ?? 0) > 0) parts.push(`${id.wins ?? 0}W ${id.losses ?? 0}L`);
  if (id.streak) parts.push(`W${id.streak} STREAK`);
  if (id.minds) parts.push('◇ MINDS™');
  if (parts.length) {
    label(ctx, parts.join('  ·  '), ax, y + 13, 11, gold ? '#ffd23a' : '#cfe0ef', align, true);
  }
};

/** Item-effect kind code (state.ts) → HUD accent + tiny label. */
const ITEM_KIND_UI: Record<number, { color: string; tag: string }> = {
  1: { color: '#7ddf8a', tag: 'HEAL' },
  2: { color: '#ff9d6b', tag: 'PWR' },
  3: { color: '#6fd3ff', tag: 'DEF' },
  4: { color: '#ffd166', tag: 'MTR' },
};

/** Carried slot s of a fighter (mirrors core slotOf — HUD read only). */
const hudSlotKind = (f: GameState['fighters'][0], s: number): number =>
  s === 0 ? f.itemKind0 : s === 1 ? f.itemKind1 : f.itemKind2;

/**
 * CONSUMABLES (ADR 0007): the energy-drink rack under each player's PORTRAIT —
 * up to 3 equipped cans side by side. The local player's carried cans are TAP
 * TARGETS ('item:use:N'); pressing R drinks the next un-drunk one. The
 * opponent's rack shows dimmed (open carry = informed stakes). Active
 * OVERCLOCK/FIREWALL buffs show countdown chips after their can is drunk.
 *
 * Under the portrait rather than under the health bar (2026-07): the rack is
 * the only tappable thing in the fight HUD, and on a phone the screen corner
 * is the one place a thumb reaches without covering the fighters. It also
 * groups the cans with the face that owns them instead of floating them on the
 * meter rail, which the round pips now use.
 */
const drawItemSlot = (
  ctx: CanvasRenderingContext2D, i: 0 | 1, f: GameState['fighters'][0],
  tick: number, isLocal: boolean,
): void => {
  const w = 20, h = 28, gap = 10;
  const rackW = w * 3 + gap * 2;
  const baseX = portraitX(i) + (HUD.portraitS - rackW) / 2; // centred under the thumbnail
  // Clears the portrait's bottom edge with room for the 'R' key hint above the
  // first can — the hint's baseline is y-3 and it is 10px tall, so this gap is
  // load-bearing: drop it below ~13 and the glyph rides up onto the frame.
  const y = HUD.portraitY + HUD.portraitS + 18;
  let firstCarried = true;

  for (let s = 0; s < 3; s++) {
    const kind = hudSlotKind(f, s);
    const x = baseX + s * (w + gap);
    if (kind === 0) continue; // never carried, or already drunk
    const ui = ITEM_KIND_UI[kind] ?? { color: '#cfd8e3', tag: 'CAN' };
    if (isLocal) {
      tapZone(x - 5, y - 6, w + 10, h + 24, `item:use:${s}`);
      const pulse = 0.5 + 0.5 * Math.abs(Math.sin(tick / 14));
      ctx.save();
      ctx.shadowColor = ui.color;
      ctx.shadowBlur = firstCarried ? 6 + 10 * pulse : 4;
      drawCan(ctx, x, y, w, h, ui.color, 4);
      ctx.restore();
      label(ctx, ui.tag, x + w / 2, y + h + 10, 9, ui.color);
      if (firstCarried) {
        label(ctx, 'R', x + w / 2, y - 3, 10, tick % 40 < 30 ? '#ffffff' : ui.color);
      }
      firstCarried = false;
    } else {
      ctx.save();
      ctx.globalAlpha = 0.65;
      drawCan(ctx, x, y, w, h, ui.color, 0);
      ctx.restore();
      label(ctx, ui.tag, x + w / 2, y + h + 10, 9, `${ui.color}aa`);
    }
  }

  // (Active-buff feedback lives in drawBuffState — glow, energy bars, and
  // the XL countdown — so no tiny chips here anymore.)
};

/**
 * PET AURA (ADR 0011) — the permanent buff strip.
 *
 * Values are read from the FIGHTER, not from the match pin: the aura lives in
 * GameState, so this renders correctly in a replay too, and it can never
 * disagree with what the sim is actually applying.
 *
 * Order and colours mirror @af/core AURA_LINES.
 */
const AURA_CHIPS = [
  { read: (f: GameState['fighters'][0]) => f.auraAtk, tag: 'ATK', color: '#ff9d6b' },
  { read: (f: GameState['fighters'][0]) => f.auraDef, tag: 'DEF', color: '#6fd3ff' },
  { read: (f: GameState['fighters'][0]) => f.auraHpRegen, tag: 'HP', color: '#7cffa0' },
  { read: (f: GameState['fighters'][0]) => f.auraCrit, tag: 'CRIT', color: '#ffd166' },
  { read: (f: GameState['fighters'][0]) => f.auraEnergyRegen, tag: 'NRG', color: '#c084fc' },
] as const;

/** Per-mille → "4.3%" (trailing ".0" trimmed), matching the profile page. */
const auraPct = (v: number): string => `${(v / 10).toFixed(1).replace(/\.0$/, '')}%`;

/** What the HUD knows about a side's pet — name/tint only; values come from the sim. */
export interface PetHud { name: string; tint: string }

/**
 * A row of chips under the meter: which aura lines this fighter is carrying
 * and how much. Always on (unlike a drink, an aura is never spent), so it sits
 * quietly at low contrast — except the CRIT chip, which flares on the tick the
 * sim actually rolls one, turning an invisible mechanic into visible feedback.
 */
const drawPetAura = (
  ctx: CanvasRenderingContext2D, i: 0 | 1, f: GameState['fighters'][0],
  tick: number, pet?: PetHud | null,
): void => {
  const lines = AURA_CHIPS
    .map((c) => ({ ...c, amount: c.read(f) }))
    .filter((c) => c.amount > 0);
  if (lines.length === 0) return;

  const tint = pet?.tint ?? '#cfd8e3';
  // BELOW the wallet/stats band, which starts at exactly this offset and runs
  // two rows deep — sharing that line hid the first chip behind "459 CR · LV1"
  // on the left and behind the partner badge on the right. The offset is
  // UNCONDITIONAL even when there is no id strip: a HUD row that moves
  // depending on whether you are signed in is worse than one that always sits
  // a little low.
  const y = HUD.meterY + HUD.meterSegH + 9 + 30;
  const h = 15;
  const pad = 6;
  const gap = 5;
  const flare = f.critFlash > 0;

  ctx.save();
  ctx.font = 'bold 10px ui-monospace, Consolas, monospace';

  // Measure first so the whole strip can be right-aligned for player 2.
  const pawW = 13;
  const all = lines.map((c) => ({
    ...c,
    w: ctx.measureText(`${c.tag} +${auraPct(c.amount)}`).width + pad * 2,
  }));

  // Never run under the centre logo/timer. A real roll tops out at THREE
  // lines (rarity decides how many), so this only bites if that ever changes
  // — but a HUD that silently slides under the brand mark is not something to
  // leave to a data constant somewhere else.
  const budget = VW / 2 - 150 - HUD.edge;
  const shown: typeof all = [];
  let used = pawW;
  for (const c of all) {
    if (used + c.w + gap > budget) break;
    used += c.w + gap;
    shown.push(c);
  }
  const hidden = all.length - shown.length;
  if (shown.length === 0) { ctx.restore(); return; }

  const widths = shown.map((c) => c.w);
  // The overflow marker is part of the strip's width, or P2 — which is laid
  // out from the RIGHT edge inward — would draw it off the screen.
  const overflowW = hidden > 0 ? ctx.measureText(`+${hidden}`).width + 4 : 0;
  const total = used + overflowW;
  let x = i === 0 ? HUD.edge : VW - HUD.edge - total;

  // Backing plate: the strip sits over stage art that can be any brightness.
  ctx.fillStyle = 'rgba(8,10,16,0.55)';
  ctx.fillRect(x - 4, y - 2, total + 8, h + 4);

  // Paw mark: whose buff this is, in the pet's own colour.
  ctx.fillStyle = tint;
  ctx.globalAlpha = 0.9;
  ctx.beginPath();
  ctx.arc(x + 5, y + h / 2 + 1, 3.1, 0, Math.PI * 2);
  ctx.fill();
  for (let t = 0; t < 3; t++) {
    ctx.beginPath();
    ctx.arc(x + 1.6 + t * 3.4, y + h / 2 - 4.2, 1.5, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  x += pawW;

  shown.forEach((c, k) => {
    const w = widths[k]!;
    const hot = c.tag === 'CRIT' && flare;
    ctx.globalAlpha = hot ? 1 : 0.95;
    ctx.fillStyle = hot ? c.color : `${c.color}26`;
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = hot ? c.color : `${c.color}66`;
    ctx.fillRect(x, y, 2, h); // inner accent bar
    ctx.fillStyle = hot ? '#12070a' : c.color;
    ctx.textAlign = 'left';
    ctx.fillText(`${c.tag} +${auraPct(c.amount)}`, x + pad, y + h - 4);
    ctx.globalAlpha = 1;
    x += w + gap;
  });

  // Say so when a line did not fit, rather than quietly dropping it.
  if (hidden > 0) {
    ctx.fillStyle = `${tint}bb`;
    ctx.textAlign = 'left';
    ctx.fillText(`+${hidden}`, x, y + h - 4);
  }

  ctx.restore();
};

/** Buff accents: [0] = OVERCLOCK (damage), [1] = FIREWALL (defense). */
const BUFF_UI = [
  { color: '#ff9d6b' },
  { color: '#6fd3ff' },
] as const;

/**
 * Per-side buff TOTALS, edge-detected from the sim's countdown fields
 * (cosmetic module state — the engine deliberately doesn't store the
 * original duration once a can is drunk). A countdown INCREASING = a fresh
 * drink armed/refreshed; capture that as the energy bar's 100% mark.
 */
const buffTotals: [[number, number], [number, number]] = [[0, 0], [0, 0]];
const prevBuffLeft: [[number, number], [number, number]] = [[0, 0], [0, 0]];

/**
 * ACTIVE BUFF STATE (ADR 0007): everything a spectator needs at a glance,
 * for BOTH players —
 *  1. the health bar pulses a halo in the buff color (hard flash right as
 *     the can is drunk, then a steady breathe),
 *  2. depleting ENERGY BARS along the health bar's bottom edge show the
 *     remaining duration (one strip per active buff, side-mirrored),
 *  3. an XL countdown (seconds) under the HUD block, urgent-pulsing and
 *     red-tinged in the last 3 seconds.
 */
const drawBuffState = (
  ctx: CanvasRenderingContext2D, i: 0 | 1, f: GameState['fighters'][0], tick: number,
): void => {
  const lefts = [f.itemDmgLeft, f.itemDefLeft] as const;
  for (let b = 0; b < 2; b++) {
    if (lefts[b]! > prevBuffLeft[i][b]!) buffTotals[i][b] = lefts[b]!;
    prevBuffLeft[i][b] = lefts[b]!;
  }
  const active = ([0, 1] as const).filter((b) => lefts[b] > 0);
  if (active.length === 0) return;

  const bx = i === 0 ? HUD.edge : VW - HUD.edge - HUD.barW;
  const glowColor = active.length === 2 ? '#ffd166' : BUFF_UI[active[0]!].color;

  // 1. Health-bar halo: a hard pop for the first ~0.4s after drinking, then
  // a steady breathe for the rest of the buff.
  const elapsed = Math.min(...active.map((b) => buffTotals[i][b]! - lefts[b]!));
  const pulse = fxPulse(tick, 0.5, 0.5, 1);
  const fresh = elapsed < 24;
  glowBar(ctx, bx - 2, HUD.barY - 2, HUD.barW + 4, HUD.barH + 4, glowColor,
    fresh ? 30 : 12 + 10 * pulse, fresh ? 1 : 0.45 + 0.35 * pulse);

  // 2. Energy bars: deplete toward the screen edge (mirrored like the
  // health bars themselves), stacked when both buffs run.
  active.forEach((b, k) => {
    const ratio = Math.min(1, lefts[b]! / Math.max(1, buffTotals[i][b]!));
    const w = Math.max(2, Math.trunc((HUD.barW - 8) * ratio));
    const y = HUD.barY + HUD.barH - 6 - k * 6;
    const x = i === 0 ? bx + 4 : bx + HUD.barW - 4 - w;
    ctx.save();
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = BUFF_UI[b].color;
    ctx.fillRect(x, y, w, 4);
    ctx.fillStyle = '#ffffff88';
    ctx.fillRect(i === 0 ? x + w - 2 : x, y, 2, 4); // bright leading edge
    ctx.restore();
  });

  // 3. XL countdown (shortest active buff) — big, both players, urgent tail.
  const secs = Math.ceil(Math.min(...active.map((b) => lefts[b]!)) / TICKS_PER_SEC);
  const urgent = secs <= 3;
  display(ctx, `${secs}s`, bx + HUD.barW / 2, 172, urgent ? 46 : 38, {
    glow: glowColor,
    scale: 1 + (urgent ? 0.1 * Math.abs(Math.sin(tick / 5)) : 0.03 * Math.sin(tick / 9)),
    ...(urgent ? DANGER_OPTS : {}),
  });
};

export const drawHud = (
  ctx: CanvasRenderingContext2D,
  g: GameState,
  rosters: [Roster, Roster],
  fx: HudFx,
  tags?: [string, string], // per-player nameplate suffix (e.g. "AGENT LV 12")
  autoSpecialCharged = false, // local player has ≥1 bar → logo badge glows red
  ids?: [HudId | null, HudId | null], // wallet + stats strip under each HUD block
  localSide: number = -1, // which side is the human's (their can is tappable); -1 none
  pets?: [PetHud | null, PetHud | null], // pet name/tint for the aura strip (ADR 0011)
): void => {
  for (const i of [0, 1] as const) {
    const f = g.fighters[i];
    const max = rosters[i].ch.b.maxHealth;
    // A mid-match HEAL is capped at max, so the bar never exceeds full.
    const ratio = Math.min(1, Math.max(0, f.health) / max);
    drawHealthBar(ctx, i, ratio, fx.flash[i], g.tick);
    drawPortraitFrame(ctx, i, rosters[i], ratio < 0.25);
    drawNameplate(ctx, i, rosters[i].bundle.name + (tags?.[i] ? ` · ${tags[i]}` : ''));
    drawMeter(ctx, i, f.meter, g.tick);
    // After the meter, not before: the pips were painted over by it for the
    // whole of the previous layout, and drawing them last makes that
    // impossible to regress into again.
    drawRoundPips(ctx, i, i === 0 ? g.roundsWon0 : g.roundsWon1);
    if (ids?.[i]) drawPlayerId(ctx, i, ids[i]!);
    drawItemSlot(ctx, i, f, g.tick, i === localSide);
    drawBuffState(ctx, i, f, g.tick);
    drawPetAura(ctx, i, f, g.tick, pets?.[i]);
  }
  drawTimer(ctx, Math.ceil(g.timerTicks / TICKS_PER_SEC), g.tick);

  // Combo counter: punches in on each new hit (re-triggered via comboAge
  // reset in main.ts whenever comboHits increases), settles with overshoot.
  if (fx.comboOwner >= 0 && fx.comboHits >= 2) {
    const i = fx.comboOwner as 0 | 1;
    const x = i === 0 ? 110 : VW - 110;
    const align: CanvasTextAlign = i === 0 ? 'left' : 'right';
    const pop = 0.7 + 0.3 * easeOutBack(clamp01(fx.comboAge / 8));
    display(ctx, `${fx.comboHits}`, x, 200, 46, { align, scale: pop, ...(fx.comboHits >= 6 ? DANGER_OPTS : {}) });
    label(ctx, 'HITS', i === 0 ? x + 62 : x - 62, 200, 20, '#fff', align);
  }

  // Controls strip (dark band like the reference).
  ctx.fillStyle = '#0b0a12dd';
  ctx.fillRect(0, VH - 24, VW, 24);
  ctx.fillStyle = '#2e3140';
  ctx.fillRect(0, VH - 24, VW, 1);
  label(ctx, 'P1: WASD · TYU / GHJ        P2: ARROWS · IOP / KL;        B: HITBOXES        ESC: MENU',
    VW / 2, VH - 8, 11, '#c8c4ba');

  // Brand badge over the timer's lower rim (top layer of the persistent HUD).
  drawGameLogo(ctx, VW / 2, 70, g.tick, autoSpecialCharged);

  // Center announcement (ROUND n / FIGHT! / K.O.) — drawn ABSOLUTELY LAST so it
  // is the front-most element, over the brand badge and everything else.
  if (fx.announce) drawAnnounce(ctx, fx.announce, fx.announceAge);
};

// ---------------------------------------------------------------- title
export interface TitleMenuState {
  mode: Mode;
  cpuLevel: number;
  /** AIR account chip: display handle when logged in, null when out. */
  authLabel?: string | null;
  authBusy?: boolean;
  authError?: string;
  /**
   * A real AIR session (or ?dev= identity). Guests still see the full menu and
   * can play AGENT ARCADE for free — false only downgrades the copy and gates
   * the account-only actions (wager / shop / my agent / dare) behind sign-in.
   */
  signedIn?: boolean;
  /** Smart-account address (upper-left wallet line). */
  address?: string;
  /** Server account snapshot — credits/level/W-L (null = server offline). */
  account?: { credits: number; level: number; wins: number; losses: number } | null;
  /** Animate the "+10 DAILY CREDITS" toast. */
  dailyToast?: boolean;
  /** Animate the "+25 DARE ACCEPTED" referral-bonus toast. */
  referralToast?: boolean;
  /** This player's dare code — enables the DARE A FRIEND row. */
  refCode?: string;
  /** A ?room= challenge link is waiting on sign-in — say so on the gate. */
  challenge?: boolean;
  /** Remembered fighter (the select cursor's start) — "FIGHTING AS …". */
  fighter?: string;
  /** Title-screen audio mute chip (upper-left). */
  audio?: AudioMenuState;
}

/** Live mute state for the title-screen speaker chip + Music/SFX/Hits menu. */
export interface AudioMenuState {
  masterMuted: boolean;
  musicMuted: boolean;
  sfxMuted: boolean;
  hitsMuted: boolean;
  /** Dropdown open (Music / SFX / Hits rows). */
  open: boolean;
}

/**
 * Compact transparent speaker control — upper-left of the title screen.
 * Tap the speaker = instant master mute/unmute; tap the chevron = Music /
 * SFX / Hits dropdown. Drawn last so its tap zones win over the wallet chip.
 */
export const drawAudioControl = (ctx: CanvasRenderingContext2D, menu: AudioMenuState): void => {
  const x = 12, y = 10, h = 28, speakerW = 30, chevW = 18;
  const w = speakerW + chevW;
  ctx.fillStyle = 'rgba(10,6,22,0.40)';
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = 'rgba(255,255,255,0.22)';
  ctx.lineWidth = 1.25;
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);

  // Speaker glyph (simple path — no emoji dependency on canvas fonts).
  const muted = menu.masterMuted;
  const cx = x + speakerW / 2, cy = y + h / 2;
  ctx.fillStyle = muted ? '#ffffff66' : '#ffffffcc';
  ctx.strokeStyle = muted ? '#ffffff66' : '#ffffffcc';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(cx - 7, cy - 3);
  ctx.lineTo(cx - 3, cy - 3);
  ctx.lineTo(cx + 2, cy - 7);
  ctx.lineTo(cx + 2, cy + 7);
  ctx.lineTo(cx - 3, cy + 3);
  ctx.lineTo(cx - 7, cy + 3);
  ctx.closePath();
  ctx.fill();
  if (muted) {
    ctx.beginPath();
    ctx.moveTo(cx + 5, cy - 5);
    ctx.lineTo(cx + 11, cy + 5);
    ctx.moveTo(cx + 11, cy - 5);
    ctx.lineTo(cx + 5, cy + 5);
    ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.arc(cx + 3, cy, 5, -0.6, 0.6);
    ctx.stroke();
  }

  // Chevron separator + caret.
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.beginPath();
  ctx.moveTo(x + speakerW, y + 5);
  ctx.lineTo(x + speakerW, y + h - 5);
  ctx.stroke();
  const ax = x + speakerW + chevW / 2, ay = y + h / 2 + (menu.open ? -1 : 1);
  ctx.fillStyle = '#ffffffaa';
  ctx.beginPath();
  if (menu.open) {
    ctx.moveTo(ax - 4, ay + 3);
    ctx.lineTo(ax + 4, ay + 3);
    ctx.lineTo(ax, ay - 3);
  } else {
    ctx.moveTo(ax - 4, ay - 3);
    ctx.lineTo(ax + 4, ay - 3);
    ctx.lineTo(ax, ay + 3);
  }
  ctx.closePath();
  ctx.fill();

  tapZone(x, y, speakerW, h, 'audio:mute');
  tapZone(x + speakerW, y, chevW, h, 'audio:menu');

  if (!menu.open) {
    ctx.lineWidth = 1;
    return;
  }

  const rows: [string, string, boolean][] = [
    ['Music', 'audio:music', menu.musicMuted],
    ['SFX', 'audio:sfx', menu.sfxMuted],
    ['Hits', 'audio:hits', menu.hitsMuted],
  ];
  const rowH = 28, panelW = 118, panelH = rows.length * rowH + 6;
  const px = x, py = y + h + 4;
  ctx.fillStyle = 'rgba(10,6,22,0.78)';
  ctx.fillRect(px, py, panelW, panelH);
  ctx.strokeStyle = 'rgba(255,255,255,0.22)';
  ctx.lineWidth = 1.25;
  ctx.strokeRect(px + 0.5, py + 0.5, panelW - 1, panelH - 1);
  rows.forEach(([txt, act, chMuted], i) => {
    const ry = py + 3 + i * rowH;
    tapZone(px, ry, panelW, rowH, act);
    label(ctx, txt, px + 12, ry + rowH / 2 + 4, 13, chMuted ? '#ffffff66' : '#ffffffdd', 'left');
    label(ctx, chMuted ? 'OFF' : 'ON', px + panelW - 12, ry + rowH / 2 + 4, 11,
      chMuted ? '#ff9d9d99' : '#8fe8a0cc', 'right');
  });
  ctx.lineWidth = 1;
};

/**
 * Boot / "LOADING CHARACTERS…" screen — main badge logo at 200% plus a
 * charging bar that tracks `progress` (0..1). Intentionally light: no
 * backdrop video, no roster art, just the brand and a readable charge %.
 */
export const drawLoading = (
  ctx: CanvasRenderingContext2D,
  progress: number,
  tick: number,
  error = '',
): void => {
  ctx.fillStyle = '#0a0616';
  ctx.fillRect(0, 0, VW, VH);

  const cx = VW / 2;
  const cy = VH / 2 - 24;

  // Main logo (assets/logo/main_logo_AF.svg) at 200% of the 100px badge base.
  if (gameLogoImg && gameLogoImg.naturalWidth > 0) {
    const box = gameLogoBBox ?? {
      x: 0, y: 0, w: gameLogoImg.naturalWidth, h: gameLogoImg.naturalHeight,
    };
    const w = 100 * 2;
    const h = w * (box.h / box.w);
    const breathe = fxPulse(tick, 0.05, 0.97, 1.04);
    ctx.save();
    ctx.translate(cx, cy - h / 2 - 8);
    ctx.scale(breathe, breathe);
    ctx.imageSmoothingEnabled = true;
    const glowMix = fxPulse(tick, 0.08);
    ctx.shadowColor = `rgba(${Math.round(210 + 40 * glowMix)},${Math.round(235 + 15 * glowMix)},255,${0.45 + 0.3 * fxPulse(tick, 0.1)})`;
    ctx.shadowBlur = 16 + 10 * fxPulse(tick, 0.1);
    ctx.drawImage(gameLogoImg, box.x, box.y, box.w, box.h, -w / 2, 0, w, h);
    ctx.drawImage(gameLogoImg, box.x, box.y, box.w, box.h, -w / 2, 0, w, h);
    ctx.restore();
  }

  const p = Math.max(0, Math.min(1, progress));
  const barW = 340, barH = 16;
  const bx = cx - barW / 2;
  const by = cy + 78;

  // Track
  ctx.fillStyle = '#ffffff14';
  ctx.fillRect(bx, by, barW, barH);
  ctx.strokeStyle = '#ffffff40';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(bx + 0.5, by + 0.5, barW - 1, barH - 1);

  // Charge fill
  const fillW = Math.max(0, Math.round((barW - 4) * p));
  if (fillW > 0) {
    const full = p >= 0.999;
    const grd = ctx.createLinearGradient(bx, by, bx + barW, by);
    grd.addColorStop(0, METER_HI);
    grd.addColorStop(1, full ? METER_FULL : '#9ae6ff');
    ctx.fillStyle = grd;
    ctx.fillRect(bx + 2, by + 2, fillW, barH - 4);
    // Sweeping highlight so the bar reads as "charging" even on a long stall.
    const sweep = ((tick * 3) % (barW + 40)) - 20;
    if (sweep > 0 && sweep < fillW) {
      const sw = Math.min(36, fillW - sweep);
      const hi = ctx.createLinearGradient(bx + 2 + sweep, by, bx + 2 + sweep + sw, by);
      hi.addColorStop(0, 'rgba(255,255,255,0)');
      hi.addColorStop(0.5, 'rgba(255,255,255,0.35)');
      hi.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = hi;
      ctx.fillRect(bx + 2 + sweep, by + 2, sw, barH - 4);
    }
    glowBar(ctx, bx, by, Math.max(fillW + 4, 8), barH, full ? METER_FULL : METER_HI, 10,
      0.35 + 0.25 * fxPulse(tick, 0.12));
  }

  const pct = Math.round(p * 100);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  if (error) {
    ctx.fillStyle = '#e94560';
    ctx.font = 'bold 16px "Courier New", monospace';
    ctx.fillText(error, cx, by + barH + 26);
    ctx.font = '13px "Courier New", monospace';
    ctx.fillStyle = '#ffffff88';
    ctx.fillText('run `npm run play` from the repo root so characters/ is served', cx, by + barH + 48);
  } else {
    ctx.fillStyle = '#ffffffaa';
    ctx.font = 'bold 15px "Courier New", monospace';
    ctx.fillText('LOADING CHARACTERS…', cx, by + barH + 26);
    ctx.fillStyle = '#cfe3ff';
    ctx.font = 'bold 22px "Courier New", monospace';
    ctx.fillText(`${pct}%`, cx, by + barH + 52);
  }
  ctx.lineWidth = 1;
};

export const drawTitle = (
  ctx: CanvasRenderingContext2D, rosters: Roster[], tick: number, menu: TitleMenuState,
): void => {
  drawMenuBackdrop(ctx);
  const cx = VW / 2;
  const haveLogo = !!logoImg && logoImg.naturalWidth > 0;

  if (haveLogo) {
    // Maximized: cover-fit the art's OPAQUE content (not its full source
    // rect) into the frame, cropping overflow like drawBgVideoCover — the
    // source SVG carries transparent padding around the wordmark that, if
    // stretched in full, reads as a black border/background once composited
    // over the dark menu backdrop. No vignette here on purpose: the point of
    // maximizing is to actually SEE the key art, not dim it.
    const box = logoBBox ?? { x: 0, y: 0, w: logoImg!.naturalWidth, h: logoImg!.naturalHeight };
    ctx.imageSmoothingEnabled = true;
    const scale = Math.max(VW / box.w, VH / box.h) * 0.9;
    const dw = box.w * scale, dh = box.h * scale;
    ctx.drawImage(logoImg!, box.x, box.y, box.w, box.h, (VW - dw) / 2, (VH - dh) / 2, dw, dh);
  } else {
    // Fallback (art file missing): the old vignette + flanking portraits +
    // text wordmark treatment, unchanged.
    const vig = ctx.createLinearGradient(0, 0, 0, VH);
    vig.addColorStop(0, '#0a0616dd');
    vig.addColorStop(0.5, '#0a061640');
    vig.addColorStop(0.78, '#0a0616aa');
    vig.addColorStop(1, '#0a0616ee');
    ctx.fillStyle = vig;
    ctx.fillRect(0, 0, VW, VH);

    const bob = Math.sin(tick / 46) * 3;
    rosters.slice(0, 2).forEach((r, i) => {
      const img = r.portrait;
      if (!img) return;
      ctx.save();
      ctx.translate(i === 0 ? 210 : VW - 210, VH - 40);
      ctx.scale(i === 0 ? 1.9 : -1.9, 1.9);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(img, -96, -176);
      ctx.restore();
    });
    display(ctx, 'AGENT', cx, 150 + bob, 84, {
      glow: 'rgba(143,184,255,0.55)', from: '#ffffff', mid: '#cfe3ff', to: '#4d7fd4', outline: '#0d1b3a',
    });
    display(ctx, 'FIGHTER', cx, 235 + bob, 84, {
      glow: 'rgba(143,184,255,0.55)', from: '#ffffff', mid: '#cfe3ff', to: '#4d7fd4', outline: '#0d1b3a',
    });
  }

  // Bottom menu: laid out at a fixed offset from the bottom edge rather than
  // guessed from where the art's elements happen to land — robust even if
  // the logo file gets swapped for different art later. Rows are drawn as
  // translucent button plates (finger-sized tap targets) so the key art /
  // video backdrop still shows through them.
  const barH = 200, barY = VH - barH;

  const menuY0 = barY + 30;
  // AGENT ARCADE is FREE-TO-PLAY: the menu is always live. Signing in is only
  // needed for RANKED wager + the account tools — a guest sees the same layout,
  // just with sign-in copy and those actions routed through the AIR dialog.
  const guest = !menu.signedIn;
  {
    // Guest status line above the rows: sign-in progress, a waiting challenge,
    // or the last auth error — the old full-screen "SIGN IN TO ENTER" wall is
    // gone (it blocked free play).
    if (guest) {
      if (menu.authBusy) {
        label(ctx, 'SIGNING IN…  complete the AIR dialog', cx, menuY0 - 8, 13, '#ffd166');
      } else if (menu.challenge && tick % 40 < 30) {
        label(ctx, '⚔ YOUR OPPONENT IS WAITING — SIGN IN TO FIGHT ⚔', cx, menuY0 - 8, 13, '#ff5d7e');
      }
      if (menu.authError) label(ctx, `⚠ ${menu.authError.slice(0, 64)}`, cx, menuY0 + 8, 12, '#ff9d9d');
    }
    // 2-player local is disabled (single-controller / mobile focus) — omitted.
    // Mode rows are big button plates (≥44px tall — a real finger target on a
    // phone), each with a one-line subtitle explaining the stakes.
    const rows: [Mode, string, string][] = [
      ['cpu', 'AGENT ARCADE', guest
        ? 'FREE TO PLAY · BEAT EVERY AGENT · NO SIGN-IN'
        : 'RANKED · 1 CREDIT PER RUN · BEAT EVERY AGENT'],
      ['online', 'ONLINE WAGER', guest
        ? 'SIGN IN TO WAGER · WIN A 🎟 TICKET'
        : '10 CR ENTRY · WINNER TAKES A 🎟 TICKET'],
    ];
    const btnW = Math.min(560, VW - 48), btnH = 46, btnGap = 10;
    const btnX = cx - btnW / 2;
    rows.forEach(([m, txt, sub], k) => {
      const y = barY + 12 + k * (btnH + btnGap);
      const on = menu.mode === m;
      tapZone(btnX, y, btnW, btnH, `mode:${m}`);
      ctx.fillStyle = on ? 'rgba(24,16,44,0.82)' : 'rgba(10,6,22,0.55)';
      ctx.fillRect(btnX, y, btnW, btnH);
      ctx.strokeStyle = on ? GOLD : 'rgba(255,255,255,0.22)';
      ctx.lineWidth = on ? 2.5 : 1.5;
      ctx.strokeRect(btnX + 0.5, y + 0.5, btnW - 1, btnH - 1);
      if (on) {
        const pulse = 1 + 0.03 * Math.sin(tick / 10);
        // A small bouncing arrow marker to the left, arcade-menu style.
        const bounce = 3 * Math.sin(tick / 9);
        label(ctx, '▶', btnX + 22 + bounce, y + btnH / 2 + 6, 18, GOLD_LT);
        display(ctx, txt, cx, y + 22, 20, { scale: pulse, glow: 'rgba(255,209,102,0.55)' });
        label(ctx, sub, cx, y + 39, 10, '#ffd166cc');
      } else {
        label(ctx, txt, cx, y + 22, 17, '#ffffff99');
        label(ctx, sub, cx, y + 39, 10, '#ffffff55');
      }
    });
    ctx.lineWidth = 1;
    // The fighter line shows where the select cursor will start; both modes
    // route through the select screen now, so tapping it (or a mode row) all
    // land on select — this is just the shortcut label.
    const fy = barY + 12 + rows.length * (btnH + btnGap) + 4;
    if (menu.fighter) {
      label(ctx, `FIGHTING AS  ${menu.fighter.toUpperCase()}   ·   TAP / C  CHANGE`, cx, fy + 12, 12, '#8fd0ff');
      tapZone(btnX, fy, btnW, 22, 'changefighter');
    }
    // Bottom action pills: every keyboard shortcut gets a real button — no
    // keyboard on a phone. Registered as generous ≥30px-tall tap targets.
    // GUESTS get a prominent SIGN IN (rewards + ranked) beside RANKINGS; the
    // account tools (MY AGENT / DARE / SIGN OUT) appear once signed in.
    const pills: [string, string, string][] = guest
      ? [
        ['L · SIGN IN', 'signin', tick % 44 < 36 ? '#ffd166' : '#ffe9a3'],
        ['R · RANKINGS', 'ranks', '#ffffffcc'],
      ]
      : [
        ['A · MY AGENT', 'myagent', '#8fd0ff'],
        ['R · RANKINGS', 'ranks', '#ffffffcc'],
        ['L · SIGN OUT', 'signin', '#ffffff99'],
      ];
    if (!guest && menu.refCode) pills.push(['D · DARE +25', 'dare', tick % 44 < 36 ? '#ffd166' : '#ffe9a3']);
    const pillW = 158, pillH = 30, pillGap = 12;
    const rowW = pills.length * pillW + (pills.length - 1) * pillGap;
    const py = fy + 24;
    pills.forEach(([txt, act, col], k) => {
      const x = cx - rowW / 2 + k * (pillW + pillGap);
      tapZone(x, py, pillW, pillH, act);
      ctx.fillStyle = 'rgba(10,6,22,0.55)';
      ctx.fillRect(x, py, pillW, pillH);
      ctx.strokeStyle = 'rgba(255,255,255,0.18)';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x + 0.5, py + 0.5, pillW - 1, pillH - 1);
      label(ctx, txt, x + pillW / 2, py + pillH / 2 + 4, 12, col);
    });
    ctx.lineWidth = 1;

    // VENDING MACHINE (ADR 0007) — upper-RIGHT corner, the only chrome that
    // lives there on the title. Signed-in only: pulls cost credits.
    if (!guest) drawVendingIcon(ctx, tick);
  }

  // Account/wallet block — upper LEFT, under the audio chip (M5 spec).
  const acctBase = 48; // leaves room for the speaker control at y=10
  if (menu.authLabel) {
    label(ctx, `◆ ${menu.authLabel}`, 16, acctBase, 13, '#8fe8a0', 'left');
    if (menu.address) {
      label(ctx, `${menu.address.slice(0, 6)}…${menu.address.slice(-4)}`, 16, acctBase + 18, 11, '#ffffff77', 'left');
    }
    const acctY = menu.address ? acctBase + 36 : acctBase + 18;
    if (menu.account) {
      const a = menu.account;
      // CREDITS emphasized (big, glowing gold); level + record small alongside.
      const cw = drawCredits(ctx, 16, acctY + 6, a.credits, 19);
      label(ctx, `LV ${a.level}   ·   ${a.wins}W ${a.losses}L`, 16 + cw + 14, acctY + 4, 11, '#dcd6c8', 'left');
    } else {
      label(ctx, 'SERVER OFFLINE · CREDITS UNAVAILABLE', 16, acctY, 11, '#ff9d9d', 'left');
    }
  }

  // Referral dare bonus toast — the invitee just cashed in an accepted dare.
  if (menu.referralToast) {
    const flash = (tick + 15) % 30 < 22;
    const y = (menu.address ? acctBase + 58 : acctBase + 40) + (menu.dailyToast ? 18 : 0);
    if (flash) label(ctx, '+25 DARE ACCEPTED — BONUS CREDITS', 16, y, 14, '#8fe8a0', 'left');
  }

  // Daily login bonus toast — under the account block, gold, hard to miss.
  if (menu.dailyToast) {
    const flash = tick % 30 < 22;
    if (flash) {
      label(ctx, `+${10} DAILY LOGIN CREDITS`, 16, menu.address ? acctBase + 58 : acctBase + 40, 14, '#ffe9a3', 'left');
    }
  }

  label(ctx, 'MILESTONE 5 · CREDITS BUILD', cx, VH - 4, 9, '#ffffff55');

  // Audio chip last so its tap zones sit above the wallet/toast text.
  if (menu.audio) drawAudioControl(ctx, menu.audio);
};

// ----------------------------------------------------------------- shop
// VENDING MACHINE (ADR 0007 Phase 1): gacha energy drinks for credits.
// All art is procedural (consistent with the chrome) until the Studio
// grows an item-art path.

/** Tier accents — LV1 steel, LV2 cool blue, LV3 gold (mirrors core ITEM_TIER_COLORS). */
const TIER_COLORS = ['', '#cfd8e3', '#6fd3ff', '#ffd166'] as const;
const TIER_LABELS = ['', 'LV 1', 'LV 2', 'LV 3'] as const;

/** A little energy-drink can: body, shine, pull tab — tinted per tier. */
const drawCan = (
  ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number,
  color: string, glow = 0,
): void => {
  ctx.save();
  if (glow > 0) {
    ctx.shadowColor = color;
    ctx.shadowBlur = glow;
  }
  ctx.fillStyle = '#1b1826';
  ctx.fillRect(x, y, w, h);
  // Slanted two-tone label (energy-drink trade-dress homage, original art):
  // silver upper-left / tier color lower-right, split on a diagonal.
  const ly = y + h * 0.14, lh = h * 0.72;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, ly, w, lh);
  ctx.clip();
  ctx.fillStyle = '#cdd6e2';
  ctx.fillRect(x, ly, w, lh);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x, ly + lh);
  ctx.lineTo(x + w, ly + lh * 0.22);
  ctx.lineTo(x + w, ly + lh);
  ctx.closePath();
  ctx.fill();
  // Lightning bolt over the split (readable ≥18px wide; skip when tiny).
  if (w >= 18) {
    const bx = x + w * 0.5, byy = ly + lh * 0.18;
    ctx.fillStyle = '#1b1206';
    ctx.beginPath();
    ctx.moveTo(bx + w * 0.10, byy);
    ctx.lineTo(bx - w * 0.16, byy + lh * 0.38);
    ctx.lineTo(bx - w * 0.02, byy + lh * 0.38);
    ctx.lineTo(bx - w * 0.12, byy + lh * 0.66);
    ctx.lineTo(bx + w * 0.18, byy + lh * 0.28);
    ctx.lineTo(bx + w * 0.02, byy + lh * 0.28);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
  ctx.shadowBlur = 0;
  ctx.fillStyle = '#e8eef5';
  ctx.fillRect(x, y, w, h * 0.1); // lid
  ctx.fillRect(x, y + h * 0.92, w, h * 0.08); // base
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  ctx.fillRect(x + w * 0.16, y + h * 0.12, w * 0.14, h * 0.76); // shine
  ctx.fillStyle = '#0a0812';
  ctx.fillRect(x + w * 0.4, y + h * 0.02, w * 0.24, h * 0.05); // tab
  ctx.restore();
};

/**
 * Compact vending-machine chip — title screen upper-right (the corner is
 * otherwise empty; the account block owns the upper-LEFT). Whole thing is
 * one tap target: 'shop'.
 */
const drawVendingIcon = (ctx: CanvasRenderingContext2D, tick: number): void => {
  const glowMix = fxPulse(tick, 0.06);
  if (vendingImg && vendingImg.naturalWidth > 0) {
    // Authored machine art (wider than tall) — contain-fit into the corner.
    const dw = 108, dh = dw * (vendingImg.naturalHeight / vendingImg.naturalWidth);
    const x = VW - 14 - dw, y = 8;
    tapZone(x - 4, y - 4, dw + 8, dh + 26, 'shop');
    ctx.save();
    ctx.shadowColor = `rgba(120,255,170,${0.4 + 0.35 * glowMix})`;
    ctx.shadowBlur = 16;
    ctx.drawImage(vendingImg, x, y, dw, dh);
    ctx.restore();
    label(ctx, 'B · SHOP', x + dw / 2, y + dh + 14, 11,
      tick % 44 < 36 ? '#ffd166' : '#ffe9a3');
    return;
  }
  const w = 74, h = 96;
  const x = VW - 14 - w, y = 10;
  tapZone(x - 4, y - 4, w + 8, h + 26, 'shop');
  ctx.save();
  ctx.shadowColor = `rgba(255,209,102,${0.35 + 0.3 * glowMix})`;
  ctx.shadowBlur = 14;
  bevel(ctx, x, y, w, h, PANEL);
  ctx.restore();
  // Marquee strip.
  ctx.fillStyle = GOLD;
  ctx.fillRect(x + 4, y + 4, w - 8, 12);
  label(ctx, 'ENERGY', x + w / 2, y + 14, 9, '#1b1206');
  // Glass window with two shelves of cans (one can per tier + repeats).
  ctx.fillStyle = '#0a0812';
  ctx.fillRect(x + 6, y + 20, w - 22, h - 44);
  for (let row = 0; row < 2; row++) {
    for (let col = 0; col < 3; col++) {
      const tier = 1 + ((row + col) % 3);
      drawCan(ctx, x + 9 + col * 15, y + 25 + row * 34, 11, 26,
        TIER_COLORS[tier]!, tier === 3 ? 6 : 0);
    }
  }
  // Coin slot + dispense tray.
  ctx.fillStyle = PANEL_LT;
  ctx.fillRect(x + w - 13, y + 24, 7, 26);
  ctx.fillStyle = '#000';
  ctx.fillRect(x + w - 11, y + 30, 3, 12);
  ctx.fillStyle = '#000000cc';
  ctx.fillRect(x + 6, y + h - 20, w - 12, 12);
  label(ctx, 'B · SHOP', x + w / 2, y + h + 14, 11,
    tick % 44 < 36 ? '#ffd166' : '#ffe9a3');
};

export interface ShopInventoryEntry {
  rowId: number;
  name: string;
  tier: number;
  desc: string;
  /** 0..2 when in the equipped loadout; null = in the stash. */
  equippedSlot?: number | null;
}

export interface ShopReveal { name: string; tier: number; desc: string; flavor: string }

/** One catalog drink (name + tier is all the slot reel needs). */
export interface ShopReelEntry { name: string; tier: number }

export interface ShopView {
  status: 'idle' | 'busy' | 'done' | 'fail';
  /** Balance (null = unknown / server offline). */
  credits: number | null;
  cost: number;
  /** Unconsumed drinks, newest first. */
  items: ShopInventoryEntry[];
  pullBusy: boolean;
  /** The drink the last pull granted (drives the reveal card). */
  reveal: ShopReveal | null;
  /** Ticks since the reveal landed; -1 = none. */
  revealAge: number;
  /** Error line (e.g. insufficient credits); -1 age = hidden. */
  err: string;
  errAge: number;
  /** True = the yes/no purchase confirm modal is up. */
  confirm: boolean;
  /** Ticks into the slot-machine spin; -1 = not spinning. */
  spinAge: number;
  /** Full drink catalog — the slot reel cycles through it. */
  catalog: ShopReelEntry[];
  /** The equipped loadout in slot order (≤3) — drawn as the EQUIPPED rack. */
  equipped: ShopInventoryEntry[];
}

/** Spin length: 3 seconds at 60 ticks/sec (main.ts lands the reveal here). */
export const SHOP_SPIN_TICKS = 180;

/** The vending-machine screen: machine + PULL + reveal card + stash shelf. */
export const drawShop = (ctx: CanvasRenderingContext2D, tick: number, v: ShopView): void => {
  drawMenuBackdrop(ctx);
  ctx.fillStyle = 'rgba(6,4,14,0.72)';
  ctx.fillRect(0, 0, VW, VH);
  const cx = VW / 2;

  display(ctx, 'VENDING MACHINE', cx, 54, 40, { glow: 'rgba(255,209,102,0.5)' });
  label(ctx, 'GACHA ENERGY DRINKS · RANDOM EFFECT · RANDOM TIER (LV 1 / 2 / 3)', cx, 78, 12, '#ffd166cc');

  // Wallet (upper-left, same treatment as the title) + back (upper-right).
  if (v.credits !== null) drawCredits(ctx, 16, 34, v.credits, 19);
  tapZone(VW - 118, 10, 104, 30, 'back');
  ctx.fillStyle = 'rgba(10,6,22,0.55)';
  ctx.fillRect(VW - 118, 10, 104, 30);
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(VW - 117.5, 10.5, 103, 29);
  label(ctx, '‹ TITLE', VW - 66, 30, 13, '#ffffffcc');

  if (v.status === 'fail') {
    label(ctx, 'SERVER OFFLINE · THE MACHINE TAKES NO COINS', cx, VH / 2, 16, '#ff9d9d');
    label(ctx, 'ESC · BACK', cx, VH / 2 + 26, 12, '#ffffff77');
    return;
  }

  // ---- The machine (left column) -----------------------------------------
  const mx = 92, my = 108, mw = 250, mh = 320;
  if (vendingImg && vendingImg.naturalWidth > 0) {
    // Authored art (assets/shop/) — the machine BODY sits right-of-center in
    // the image (its neon cable trails off to the left), so geometric
    // centering looks lopsided. Anchor the body's visual center (≈0.69 of
    // the width, measured from the alpha matte) over the PULL button's
    // center, bottom-aligned just above the button.
    const BODY_CX = 0.69;
    const dw = 290, dh = dw * (vendingImg.naturalHeight / vendingImg.naturalWidth);
    const ix = (mx + mw / 2) - dw * BODY_CX;
    const iy = (my + mh + 14) - 8 - dh; // 8px gap above the button at my+mh+14
    ctx.save();
    ctx.shadowColor = v.pullBusy
      ? `rgba(255,209,102,${0.5 + 0.3 * Math.sin(tick / 4)})`
      : 'rgba(120,255,170,0.35)';
    ctx.shadowBlur = v.pullBusy ? 34 : 24;
    ctx.drawImage(vendingImg, ix, iy, dw, dh);
    ctx.restore();
  } else {
    ctx.save();
    ctx.shadowColor = 'rgba(255,209,102,0.25)';
    ctx.shadowBlur = 24;
    bevel(ctx, mx, my, mw, mh, PANEL, GOLD_LT, GOLD_DK, 3);
    ctx.restore();
    ctx.fillStyle = GOLD;
    ctx.fillRect(mx + 8, my + 8, mw - 16, 30);
    label(ctx, 'ENERGY', mx + mw / 2, my + 30, 22, '#1b1206');
    ctx.fillStyle = '#0a0812';
    ctx.fillRect(mx + 12, my + 46, mw - 60, mh - 120);
    // Shelves: 3 rows × 4 cans, tiers cycling; the LV3 can glows.
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 4; col++) {
        const tier = 1 + ((row * 4 + col) % 3);
        const wob = tier === 3 ? Math.sin((tick + col * 9) / 16) * 1.5 : 0;
        drawCan(ctx, mx + 24 + col * 42, my + 58 + row * 60 + wob, 26, 46,
          TIER_COLORS[tier]!, tier === 3 ? 10 : 0);
        ctx.fillStyle = 'rgba(255,255,255,0.10)';
        ctx.fillRect(mx + 12, my + 46 + (row + 1) * 60 - 3, mw - 60, 2); // shelf lip
      }
    }
    // Coin panel + tray.
    ctx.fillStyle = PANEL_LT;
    ctx.fillRect(mx + mw - 42, my + 46, 30, 90);
    ctx.fillStyle = '#000';
    ctx.fillRect(mx + mw - 32, my + 58, 10, 30);
    label(ctx, `${v.cost}`, mx + mw - 27, my + 112, 15, GOLD_LT);
    label(ctx, 'CR', mx + mw - 27, my + 126, 9, '#ffffff88');
    ctx.fillStyle = '#000000cc';
    ctx.fillRect(mx + 16, my + mh - 62, mw - 32, 44);
    label(ctx, v.pullBusy ? 'DISPENSING…' : 'PUSH', mx + mw / 2, my + mh - 36, 13,
      v.pullBusy ? '#ffd166' : '#ffffff44');
  }

  // ---- PULL button (under the machine) -----------------------------------
  const canAfford = v.credits === null || v.credits >= v.cost;
  const spinning = v.spinAge >= 0;
  const bw = 250, bh = 44, bx = mx, by = my + mh + 14;
  if (!v.confirm) tapZone(bx, by, bw, bh, 'shop:pull');
  const armed = !v.pullBusy && canAfford && !spinning && !v.confirm;
  ctx.fillStyle = armed ? 'rgba(58,38,10,0.9)' : 'rgba(20,16,28,0.8)';
  ctx.fillRect(bx, by, bw, bh);
  ctx.strokeStyle = armed ? GOLD : 'rgba(255,255,255,0.2)';
  ctx.lineWidth = armed ? 2.5 : 1.5;
  ctx.strokeRect(bx + 0.5, by + 0.5, bw - 1, bh - 1);
  if (armed) {
    const pulse = 1 + 0.03 * Math.sin(tick / 9);
    display(ctx, `INSERT ${v.cost} CR · PULL`, bx + bw / 2, by + 29, 19,
      { scale: pulse, glow: 'rgba(255,209,102,0.55)' });
  } else {
    label(ctx, spinning || v.pullBusy ? 'DISPENSING…' : `INSERT ${v.cost} CR · PULL`,
      bx + bw / 2, by + 27, 15, '#ffffff66');
  }
  if (!canAfford) {
    label(ctx, 'NOT ENOUGH CREDITS — WIN MATCHES OR CLAIM THE DAILY +10', bx + bw / 2, by + bh + 16, 10, '#ff9d9d');
  }

  // ---- Reveal card (right column) ----------------------------------------
  const rx = 400, rw = VW - rx - 26;
  if (v.reveal && v.revealAge >= 0) {
    const t = clamp01(v.revealAge / 16);
    const pop = easeOutBack(t);
    const tier = Math.max(1, Math.min(3, v.reveal.tier));
    const col = TIER_COLORS[tier]!;
    const ry = 108, rh = 224;
    ctx.save();
    ctx.globalAlpha = clamp01(v.revealAge / 6);
    ctx.translate(rx + rw / 2, ry + rh / 2);
    ctx.scale(pop, pop);
    ctx.translate(-(rx + rw / 2), -(ry + rh / 2));
    ctx.shadowColor = col;
    ctx.shadowBlur = tier === 3 ? 34 : 18;
    bevel(ctx, rx, ry, rw, rh, PANEL, col, GOLD_DK, 3);
    ctx.shadowBlur = 0;
    drawCan(ctx, rx + 30, ry + 42, 64, 130, col, tier === 3 ? 18 : 8);
    label(ctx, TIER_LABELS[tier]!, rx + 62, ry + 196, 14, col);
    display(ctx, v.reveal.name, rx + 118, ry + 74, 24,
      tier === 3 ? { align: 'left' }
        : tier === 2 ? { ...COOL_OPTS, align: 'left' }
        : { from: '#ffffff', mid: '#cfd8e3', to: '#6b7686', outline: '#101318', align: 'left' });
    label(ctx, v.reveal.desc, rx + 118, ry + 104, 14, '#ffffffdd', 'left');
    label(ctx, `“${v.reveal.flavor}”`, rx + 118, ry + 126, 11, '#ffffff88', 'left');
    label(ctx, 'CARRY IT INTO ARENA OR WAGER · DRINK IT MID-FIGHT (TAP / R)', rx + 118, ry + 158, 10, '#8fd0ff', 'left');
    ctx.restore();
    // Sparkle ring on a fresh LV3.
    if (tier === 3 && v.revealAge < 40) {
      ctx.save();
      ctx.strokeStyle = `rgba(255,209,102,${1 - v.revealAge / 40})`;
      ctx.lineWidth = 3;
      const rad = 30 + v.revealAge * 5;
      ctx.beginPath();
      ctx.arc(rx + 62, ry + 106, rad, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  } else if (spinning) {
    // ---- SLOT REEL: fast vertical blur → deceleration; main.ts swaps in the
    // reveal card (easeOutBack pop) when the spin lands — the pop + flash
    // masks the reel-to-result snap, arcade-style.
    const ry = 108, rh = 224;
    const rowH = 56;
    ctx.save();
    ctx.shadowColor = 'rgba(255,209,102,0.45)';
    ctx.shadowBlur = 20 + 10 * Math.sin(tick / 5);
    bevel(ctx, rx, ry, rw, rh, PANEL, GOLD_LT, GOLD_DK, 3);
    ctx.shadowBlur = 0;
    // Payline arrows either side of the center row.
    const cyMid = ry + rh / 2;
    ctx.fillStyle = GOLD;
    ctx.beginPath();
    ctx.moveTo(rx + 6, cyMid - 9); ctx.lineTo(rx + 20, cyMid); ctx.lineTo(rx + 6, cyMid + 9);
    ctx.closePath(); ctx.fill();
    ctx.beginPath();
    ctx.moveTo(rx + rw - 6, cyMid - 9); ctx.lineTo(rx + rw - 20, cyMid); ctx.lineTo(rx + rw - 6, cyMid + 9);
    ctx.closePath(); ctx.fill();
    // Reel window (clipped) — position decelerates over SHOP_SPIN_TICKS.
    ctx.beginPath();
    ctx.rect(rx + 26, ry + 8, rw - 52, rh - 16);
    ctx.clip();
    const t = clamp01(v.spinAge / SHOP_SPIN_TICKS);
    const speed = 0.9 * (1 - t) * (1 - t) + 0.02;   // rows/tick, eases out
    // Integrated distance: s(t) of the eased speed — monotonic scroll pos.
    const pos = (0.9 * (v.spinAge - v.spinAge * t + (v.spinAge * t * t) / 3) + 0.02 * v.spinAge);
    const n = Math.max(1, v.catalog.length);
    const frac = pos % 1;
    for (let k = -3; k <= 3; k++) {
      const idx = ((Math.floor(pos) + k) % n + n) % n;
      const entry = v.catalog[idx]!;
      const tier = Math.max(1, Math.min(3, entry.tier));
      const y = cyMid + (k - frac) * rowH;
      const centered = Math.abs(y - cyMid) < rowH / 2;
      ctx.globalAlpha = centered ? 1 : 0.35;
      drawCan(ctx, rx + 44, y - 21, 24, 42, TIER_COLORS[tier]!, centered && tier === 3 ? 8 : 0);
      label(ctx, entry.name, rx + 84, y + 6, centered ? 18 : 14,
        centered ? '#ffffff' : '#ffffff88', 'left');
      label(ctx, TIER_LABELS[tier]!, rx + rw - 66, y + 6, 12, TIER_COLORS[tier]!, 'left');
    }
    ctx.restore();
    // Motion blur streaks while the reel is fast.
    if (speed > 0.25) {
      ctx.save();
      ctx.globalAlpha = Math.min(0.5, speed);
      ctx.fillStyle = '#ffffff22';
      for (let s = 0; s < 5; s++) {
        ctx.fillRect(rx + 30 + s * ((rw - 60) / 5), ry + 12, 2, rh - 24);
      }
      ctx.restore();
    }
    label(ctx, 'THE MACHINE IS CHOOSING…', rx + rw / 2, ry + rh + 22, 12,
      tick % 30 < 22 ? '#ffd166' : '#ffe9a3');
  } else {
    // ---- HOW IT WORKS (idle right column) — the gacha rules, big and clear.
    const ry = 108, rh = 224;
    bevel(ctx, rx, ry, rw, rh, 'rgba(12,8,24,0.82)', 'rgba(255,255,255,0.22)', 'rgba(0,0,0,0.5)', 2);
    display(ctx, v.status === 'busy' ? 'STOCKING…' : 'HOW IT WORKS', rx + rw / 2, ry + 34, 22,
      { glow: 'rgba(255,209,102,0.4)' });
    const lx = rx + 22;
    label(ctx, `1 · INSERT ${v.cost} CR — THE MACHINE PICKS YOUR DRINK AT RANDOM`, lx, ry + 64, 12, '#ffffffdd', 'left');
    label(ctx, '2 · RANDOM EFFECT — HEAL · DAMAGE UP · DEFENSE UP · SUPER METER', lx, ry + 86, 12, '#ffffffdd', 'left');
    label(ctx, '3 · RANDOM TIER — HIGHER TIER, STRONGER DRINK:', lx, ry + 108, 12, '#ffffffdd', 'left');
    // Odds bar: three segments sized by the real 70/25/5 odds, tier-colored.
    const obX = lx + 14, obW = rw - 72, obY = ry + 120, obH = 18;
    const segs: Array<[number, number, string]> = [[70, 1, 'LV 1 · 70%'], [25, 2, 'LV 2 · 25%'], [5, 3, 'LV 3 · 5%']];
    let sx = obX;
    for (const [pct, tier, tag] of segs) {
      const sw = (obW * pct) / 100;
      ctx.fillStyle = TIER_COLORS[tier]!;
      ctx.globalAlpha = 0.85;
      ctx.fillRect(sx, obY, sw - 2, obH);
      ctx.globalAlpha = 1;
      if (sw > 70) label(ctx, tag, sx + sw / 2, obY + 13, 10, '#10131b');
      sx += sw;
    }
    // Narrow segments get their tags to the right of the bar.
    label(ctx, 'LV 2 · 25%   LV 3 · 5%', obX + obW * 0.7 + 6, obY + 31, 9, '#ffffff88', 'left');
    label(ctx, '4 · CARRY ONE INTO ARENA OR WAGER, THEN TAP THE CAN', lx, ry + 178, 12, '#8fd0ff', 'left');
    label(ctx, '(OR PRESS R) TO DRINK IT MID-FIGHT. USED = GONE.', lx + 14, ry + 196, 12, '#8fd0ff', 'left');
  }

  // ---- EQUIPPED rack (ADR 0007): the ≤3 cans that ride into every ranked
  // match. Tap an equipped can to send it back to the stash; tap a stash
  // row to equip it into the next free slot (both fire 'equip:<rowId>').
  const eqY = 340;
  label(ctx, 'EQUIPPED — CARRIED INTO EVERY FIGHT', rx, eqY, 13, GOLD_LT, 'left');
  for (let s = 0; s < 3; s++) {
    const bx = rx + s * 62, by = eqY + 8, bw = 54, bh = 58;
    const it = v.equipped[s];
    ctx.fillStyle = it ? 'rgba(24,44,26,0.85)' : 'rgba(12,10,24,0.7)';
    ctx.fillRect(bx, by, bw, bh);
    ctx.strokeStyle = it ? '#7ddf8a' : 'rgba(255,255,255,0.18)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(bx + 0.5, by + 0.5, bw - 1, bh - 1);
    if (it) {
      tapZone(bx, by, bw, bh, `equip:${it.rowId}`);
      const tier = Math.max(1, Math.min(3, it.tier));
      drawCan(ctx, bx + 16, by + 6, 20, 34, TIER_COLORS[tier]!, tier === 3 ? 8 : 0);
      label(ctx, TIER_LABELS[tier]!, bx + bw / 2, by + bh - 6, 9, TIER_COLORS[tier]!);
    } else {
      label(ctx, `${s + 1}`, bx + bw / 2, by + bh / 2 + 6, 16, '#ffffff33');
    }
  }
  label(ctx, 'TAP TO UNEQUIP', rx + 3 * 62 + 8, eqY + 42, 9, '#ffffff55', 'left');

  // ---- Stash (inventory shelf) — tap a row to EQUIP it -------------------
  const stash = v.items.filter((it) => it.equippedSlot === null || it.equippedSlot === undefined);
  const sy = 424;
  label(ctx, `MY STASH · ${stash.length}`, rx, sy, 14, GOLD_LT, 'left');
  if (stash.length === 0) {
    label(ctx, v.status === 'done'
      ? (v.items.length > 0 ? 'ALL CANS EQUIPPED' : 'EMPTY — PULL YOUR FIRST DRINK')
      : '…', rx, sy + 26, 12, '#ffffff66', 'left');
  }
  const shown = stash.slice(0, 4);
  shown.forEach((it, k) => {
    const y = sy + 12 + k * 26;
    const tier = Math.max(1, Math.min(3, it.tier));
    tapZone(rx - 4, y - 3, rw + 8, 26, `equip:${it.rowId}`);
    drawCan(ctx, rx, y, 12, 20, TIER_COLORS[tier]!);
    label(ctx, `${it.name}  ·  ${TIER_LABELS[tier]}`, rx + 20, y + 14, 12, '#ffffffcc', 'left');
    label(ctx, it.desc, rx + 20 + 190, y + 14, 10, '#ffffff66', 'left');
  });
  if (stash.length > shown.length) {
    label(ctx, `+${stash.length - shown.length} MORE IN THE STASH`, rx, sy + 12 + shown.length * 26 + 14, 10, '#ffffff55', 'left');
  } else if (shown.length > 0) {
    label(ctx, 'TAP A CAN TO EQUIP IT', rx, sy + 12 + shown.length * 26 + 14, 10, '#7ddf8a99', 'left');
  }

  // Error toast (insufficient credits / server hiccup) — flashing red.
  if (v.err && v.errAge >= 0 && v.errAge % 30 < 22) {
    label(ctx, `⚠ ${v.err}`, cx, VH - 30, 14, '#ff5d7e');
  }
  label(ctx, v.confirm ? 'ENTER / Y CONFIRM · ESC / N CANCEL' : 'ENTER / TAP PULL · ESC BACK',
    cx, VH - 8, 10, '#ffffff55');

  // ---- Purchase confirm modal (topmost — its tap zones must win) ----------
  if (v.confirm) {
    ctx.fillStyle = 'rgba(4,2,10,0.72)';
    ctx.fillRect(0, 0, VW, VH);
    const pw = 430, ph = 190, px = cx - pw / 2, py = VH / 2 - ph / 2 - 20;
    ctx.save();
    ctx.shadowColor = 'rgba(255,209,102,0.5)';
    ctx.shadowBlur = 26;
    bevel(ctx, px, py, pw, ph, PANEL, GOLD_LT, GOLD_DK, 3);
    ctx.restore();
    display(ctx, `INSERT ${v.cost} CR?`, cx, py + 46, 28, { glow: 'rgba(255,209,102,0.55)' });
    label(ctx, 'ONE RANDOM ENERGY DRINK — NO REFUNDS, NO RE-ROLLS', cx, py + 74, 11, '#ffffffcc');
    if (v.credits !== null) {
      label(ctx, `BALANCE AFTER: ${v.credits - v.cost} CR`, cx, py + 94, 12, GOLD_LT);
    }
    const btnW = 180, btnH = 48, gap = 26;
    const yesX = cx - btnW - gap / 2, noX = cx + gap / 2, btnY = py + ph - 68;
    tapZone(yesX, btnY, btnW, btnH, 'shop:yes');
    ctx.fillStyle = 'rgba(28,66,30,0.95)';
    ctx.fillRect(yesX, btnY, btnW, btnH);
    ctx.strokeStyle = '#7ddf8a';
    ctx.lineWidth = 2.5;
    ctx.strokeRect(yesX + 0.5, btnY + 0.5, btnW - 1, btnH - 1);
    display(ctx, 'YES · PULL', yesX + btnW / 2, btnY + 32, 19,
      { from: '#eaffe9', mid: '#8dfF9a', to: '#2c7c3a', outline: '#0a2010' });
    tapZone(noX, btnY, btnW, btnH, 'shop:no');
    ctx.fillStyle = 'rgba(66,24,28,0.95)';
    ctx.fillRect(noX, btnY, btnW, btnH);
    ctx.strokeStyle = '#ff8d9d';
    ctx.lineWidth = 2.5;
    ctx.strokeRect(noX + 0.5, btnY + 0.5, btnW - 1, btnH - 1);
    display(ctx, 'NO · KEEP IT', noX + btnW / 2, btnY + 32, 19, DARE_OPTS);
  }
  ctx.lineWidth = 1;
};

// ---------------------------------------------------------------- invite
/** Hot-red display() treatment for the dare headline / CTA. */
const DARE_OPTS: DisplayOpts = { from: '#ffe3e3', mid: '#ff5d7e', to: '#93202f', outline: '#2a060f' };

/**
 * The invite ("dare a friend") screen — the SENDER side of the referral
 * loop. Everything here frames sharing as an act of aggression, not a
 * referral chore: the player is putting a bounty on their own head, and the
 * poster panel previews roughly what lands in the friend's group chat
 * (the landing /dare/<code> page + OG card render the same name/record/taunt).
 */
export interface InviteView {
  /** Display handle (upper-cased upstream). */
  name: string;
  /** Server account snapshot (null = server offline). */
  account: { credits: number; level: number; wins: number; losses: number } | null;
  /** Dare code — the screen is only enterable once this exists. */
  refCode?: string;
  /** Remembered fighter — poster art + "MAIN" label. */
  roster?: Roster;
  /** Full roster (same array the select screen uses) — for the stat profile. */
  rosters?: Roster[];
  /** The active taunt line (from the curated preset list). */
  taunt: string;
  tauntIdx: number;
  tauntCount: number;
  /** Human-readable link shown under the button (no query noise). */
  linkLabel: string;
  /** ≥0 → ticks since the link was copied/shared (flips the button green). */
  copiedAge: number;
  /** OS share sheet available → the button SENDS instead of copies. */
  canShare: boolean;
  /** Friends who ever redeemed this player's code. */
  daresAccepted?: number;
  /** Inviter payouts remaining in the rolling week (server caps at 10). */
  bountiesLeft?: number;
  /**
   * DARE-VS-AGENT (ADR 0006): a coached agent config exists, so the dare can
   * target the sender's TRAINED AGENT instead of the sender live. Absent =
   * no toggle drawn (coach on Minds first).
   */
  agentReady?: boolean;
  /** The toggle's current state: true = the link dares them to beat MY AGENT. */
  vsAgent?: boolean;
}

export const drawInvite = (
  ctx: CanvasRenderingContext2D, tick: number, v: InviteView,
): void => {
  drawMenuBackdrop(ctx);
  // Same treatment as the landing dare page: the video stays visible, but a
  // vignette guarantees the type pops against any frame of it.
  const vig = ctx.createLinearGradient(0, 0, 0, VH);
  vig.addColorStop(0, '#0a0616cc');
  vig.addColorStop(0.45, '#0a061677');
  vig.addColorStop(1, '#0a0616ee');
  ctx.fillStyle = vig;
  ctx.fillRect(0, 0, VW, VH);
  const cx = VW / 2;

  if ((tick + 12) % 44 < 34) {
    label(ctx, '⚠ PUT A BOUNTY ON YOUR OWN HEAD ⚠', cx, 44, 14, '#ff5d7e');
  }
  display(ctx, 'I DARE YOU', cx, 100, 46, {});
  display(ctx, 'TO FIGHT', cx, 150, 46, DARE_OPTS);

  // ---- poster panel: the wanted-poster preview of what the friend sees.
  // Left = full-body mugshot (contain-fit, never cropped); middle = the
  // callout + this player's live record; right = the fighter's stat profile,
  // which is what fills the card instead of the old dead space.
  const pw = 664, ph = 150, px0 = cx - pw / 2, py0 = 170;
  bevel(ctx, px0, py0, pw, ph, PANEL, GOLD, GOLD_DK, 3);

  // Mugshot cell — dark panel + red footlight; the whole fighter contain-fit
  // and bottom-anchored so no head/limb is ever clipped (sprite aspect ratios
  // run ~0.5–1.0 across the roster, which the old overscale-crop mangled).
  const cellX = px0 + 8, cellY = py0 + 8, cellW = 128, cellH = ph - 16;
  ctx.save();
  rrect(ctx, cellX, cellY, cellW, cellH, 6);
  ctx.clip();
  const foot = ctx.createRadialGradient(
    cellX + cellW / 2, cellY + cellH, 8, cellX + cellW / 2, cellY + cellH, cellH);
  foot.addColorStop(0, 'rgba(255,61,110,0.24)');
  foot.addColorStop(1, 'rgba(6,4,12,0.92)');
  ctx.fillStyle = foot;
  ctx.fillRect(cellX, cellY, cellW, cellH);
  const img = v.roster?.portrait;
  if (img?.naturalWidth) {
    const fit = Math.min((cellW - 14) / img.naturalWidth, (cellH - 10) / img.naturalHeight);
    const w = img.naturalWidth * fit, h = img.naturalHeight * fit;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, cellX + cellW / 2 - w / 2, cellY + cellH - 5 - h, w, h);
  } else {
    label(ctx, '?', cellX + cellW / 2, cellY + cellH / 2 + 14, 40, '#ffffff33');
  }
  ctx.restore();
  ctx.strokeStyle = 'rgba(255,61,110,0.55)';
  ctx.lineWidth = 1.5;
  rrect(ctx, cellX, cellY, cellW, cellH, 6);
  ctx.stroke();

  // Middle column: the callout + this player's live record.
  const tx = px0 + 152;
  label(ctx, '⚠ WANTED: ANYONE WHO CAN TAKE ONE ROUND', tx, py0 + 26, 11, '#ff9db0', 'left');
  const nameSize = v.name.length > 13 ? 18 : v.name.length > 10 ? 21 : 26;
  display(ctx, v.name, tx, py0 + 60, nameSize, { align: 'left' });
  const a = v.account;
  label(ctx,
    a ? `${a.wins}W — ${a.losses}L    ·    LV ${a.level}${v.roster ? `    ·    MAIN ${v.roster.bundle.name.toUpperCase()}` : ''}`
      : 'SERVER OFFLINE — STATS UNAVAILABLE',
    tx, py0 + 86, 13, a ? '#ffd166' : '#ff9d9d', 'left');
  if (a) label(ctx, `⛁ ${a.credits} CR IN THE BANK`, tx, py0 + 108, 11, '#8fd0ff', 'left');
  label(ctx, 'THIS IS THE POSTER THAT LANDS IN THEIR CHAT', tx, py0 + ph - 14, 10, '#ffffff59', 'left');

  // Right column: the fighter's stat profile — the very same bars the select
  // screen derives from the bundle, which is the "player/character stats"
  // that fill the card. computeRosterStats is memoized on the array ref, so
  // passing allRosters here is a cache hit against the select screen.
  let stats: CharStats | null = null;
  if (v.roster && v.rosters) {
    const idx = v.rosters.indexOf(v.roster);
    if (idx >= 0) stats = computeRosterStats(v.rosters)[idx] ?? null;
  }
  if (stats) {
    ctx.fillStyle = 'rgba(217,164,65,0.22)';
    ctx.fillRect(px0 + 408, py0 + 14, 1, ph - 28);
    const sx = px0 + 424, sw = pw - 424 - 14;
    label(ctx, 'FIGHTER PROFILE', sx, py0 + 22, 10, '#c8b98a', 'left', false);
    stats.bars.forEach((s, i) => drawStatBar(ctx, sx, py0 + 36 + i * 21, sw, s, '#e8a24a', tick));
  }

  // Escape hatch — phones have no ESC. Same chip as select / ranks.
  const backW = 110, backH = 34;
  tapZone(VW - 16 - backW, 12, backW, backH, 'back');
  ctx.fillStyle = 'rgba(10,6,22,0.6)';
  ctx.fillRect(VW - 16 - backW, 12, backW, backH);
  ctx.strokeStyle = 'rgba(255,255,255,0.22)';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(VW - 16 - backW + 0.5, 12.5, backW - 1, backH - 1);
  ctx.lineWidth = 1;
  label(ctx, '‹ BACK', VW - 16 - backW / 2, 12 + backH / 2 + 4, 12, '#ffffffcc');

  // ---- taunt row: ◀ ▶ cycles presets (fat hit targets for thumbs).
  const ty = py0 + ph + 26;
  label(ctx, '◀', cx - 300, ty, 18, GOLD_LT);
  label(ctx, '▶', cx + 300, ty, 18, GOLD_LT);
  tapZone(cx - 350, ty - 28, 96, 52, 'taunt:prev');
  tapZone(cx + 254, ty - 28, 96, 52, 'taunt:next');
  label(ctx, `“${v.taunt}”`, cx, ty, v.taunt.length > 52 ? 12 : 15, '#ffe9a3');
  label(ctx, `TAUNT ${v.tauntIdx + 1}/${v.tauntCount}  ·  ◀ ▶  TO CHANGE`, cx, ty + 20, 11, '#ffffff77');

  // ---- dare target toggle (ADR 0006): who the invitee actually fights —
  // YOU live (friendly room / async referral) or your TRAINED AGENT (the
  // link gains &agent=1 and the accepter fights your coached config via the
  // verified solo pipeline while you're offline). Only drawn once a coach
  // has saved a config; everyone else just sees the classic screen.
  let ctaY = ty + 36;
  if (v.agentReady) {
    const tgY = ty + 32;
    const half = 168, tgH = 26, tgX = cx - half;
    const opts: [string, boolean][] = [['THEY FIGHT ME', !v.vsAgent], ['THEY FIGHT MY AGENT', !!v.vsAgent]];
    opts.forEach(([txt, on], k) => {
      const x = tgX + k * half;
      tapZone(x, tgY - 6, half, tgH + 12, k === 0 ? 'daretype:me' : 'daretype:agent');
      ctx.fillStyle = on ? 'rgba(46,26,10,0.85)' : 'rgba(10,6,22,0.55)';
      ctx.fillRect(x, tgY, half, tgH);
      ctx.strokeStyle = on ? GOLD : 'rgba(255,255,255,0.2)';
      ctx.lineWidth = on ? 2 : 1;
      ctx.strokeRect(x + 0.5, tgY + 0.5, half - 1, tgH - 1);
      label(ctx, `${on ? '◆' : '◇'} ${txt}`, x + half / 2, tgY + tgH / 2 + 4, 11,
        on ? GOLD_LT : '#ffffff77');
    });
    ctx.lineWidth = 1;
    ctaY = tgY + tgH + 14;
  }

  // ---- two CTAs side by side: async dare (copy/send link) + live challenge
  // (park in a room keyed by your code). On copy the left plate greys out
  // with a green ring; challenge stays armed — fight them right now.
  const gap = 14, bh = 46, by = ctaY;
  const copyW = v.refCode ? 360 : 420;
  const chalW = 220;
  const rowW = v.refCode ? copyW + gap + chalW : copyW;
  const rowX = cx - rowW / 2;
  const bx = rowX;
  const armed = v.copiedAge >= 0;
  if (armed) {
    bevel(ctx, bx, by, copyW, bh, '#191a20', '#3f414c', '#101116', 3);
    const pop = easeOutBack(clamp01(v.copiedAge / 12));
    display(ctx, '✓ INVITE LINK COPIED', bx + copyW / 2, by + 31, 17,
      { from: '#eafff0', mid: '#8fe8a0', to: '#3f7a4f', outline: '#0e2a12', scale: pop });
    if (v.copiedAge < 28) {
      const t = v.copiedAge / 28;
      ctx.save();
      ctx.globalAlpha = (1 - t) * 0.85;
      ctx.strokeStyle = '#7ee85a';
      ctx.lineWidth = 3;
      rrect(ctx, bx - t * 12, by - t * 10, copyW + t * 24, bh + t * 20, 7);
      ctx.stroke();
      ctx.restore();
    }
  } else {
    const pulse = 1 + 0.03 * Math.sin(tick / 8);
    bevel(ctx, bx, by, copyW, bh, '#3a0e18', '#ff5d7e', '#6e1024', 3);
    display(ctx, v.canShare ? 'SEND INVITE LINK' : 'COPY INVITE LINK', bx + copyW / 2, by + 31, 18,
      { ...DARE_OPTS, scale: pulse });
  }
  tapZone(bx - 8, by - 8, copyW + 16, bh + 16, 'copydare');

  // CHALLENGE LIVE (protocol v5): free unranked room keyed by your code.
  if (v.refCode) {
    const cxBtn = rowX + copyW + gap;
    const pulse = 1 + 0.03 * Math.sin(tick / 8 + 1.2);
    bevel(ctx, cxBtn, by, chalW, bh, '#0e2438', '#5db8ff', '#163a5a', 3);
    display(ctx, '⚔ CHALLENGE', cxBtn + chalW / 2, by + 31, 18,
      { from: '#eaf6ff', mid: '#8fd0ff', to: '#3a7ab0', outline: '#0a1a2a', scale: pulse });
    tapZone(cxBtn - 8, by - 8, chalW + 16, bh + 16, 'challenge');
  }

  // Under the buttons: the link when idle, the send-it instruction when copied.
  if (armed) {
    label(ctx,
      v.canShare ? 'SENT — NOW GO CALL THEM OUT'
        : 'NOW SEND IT TO A FRIEND  ·  WHATSAPP · DISCORD · IMESSAGE · ANYWHERE',
      cx, by + bh + 20, 12, '#8fe8a0');
  } else {
    label(ctx, v.refCode ? v.linkLabel : 'CONNECTING TO SERVER…', cx, by + bh + 20, 12, '#8fd0ff');
  }

  // ---- the economics, as scarcity: the 10/week payout cap is urgency.
  let iy = by + bh + 42;
  label(ctx,
    `+25 CREDITS EACH WHEN THEY SIGN IN${v.bountiesLeft !== undefined ? `   ·   ${v.bountiesLeft}/10 BOUNTIES LEFT THIS WEEK` : ''}`,
    cx, iy, 13, v.bountiesLeft === 0 ? '#ff9d9d' : '#ffd166');
  if ((v.daresAccepted ?? 0) > 0) {
    iy += 19;
    label(ctx, `${v.daresAccepted} FIGHTER${v.daresAccepted === 1 ? '' : 'S'} ALREADY TOOK THE BAIT`, cx, iy, 12, '#8fd0ff');
  }

  label(ctx,
    `‹ BACK      ◀ ▶  TAUNT      C  CHALLENGE      ENTER  ${v.canShare ? 'SEND' : 'COPY'}`,
    cx, VH - 12, 12, '#ffffff99');
};

// ---------------------------------------------------------------- select
// Character stats derived DIRECTLY from the Studio bundle config (never
// hand-authored) so the select screen always reflects the real character.
// Each raw metric is normalized across the whole roster into 1..5 filled
// segments, i.e. the bars read as "how this fighter compares to the cast".
export interface CharStat { key: string; label: string; segs: number }
export interface CharStats {
  bars: CharStat[];
  health: number; // raw maxHealth (concrete config number)
  moveCount: number; // attack moves (excludes sys.* animation tracks)
}

/**
 * Peak single-hit damage the character can deal (normals, specials, super,
 * projectile, throw) — the honest "how hard do they hit" number.
 */
const peakDamage = (b: Roster['bundle']): number => {
  let peak = b.throwDamage;
  for (const mv of b.moves) {
    for (const st of mv.steps) {
      for (const hb of st.hitboxes ?? []) if (hb.damage > peak) peak = hb.damage;
    }
    if (mv.projectile && mv.projectile.hit.damage > peak) peak = mv.projectile.hit.damage;
  }
  return peak;
};

/** Furthest a hitbox reaches in front of the fighter; projectiles score high. */
const reach = (b: Roster['bundle']): number => {
  let r = 0;
  for (const mv of b.moves) {
    for (const st of mv.steps) {
      for (const hb of st.hitboxes ?? []) r = Math.max(r, hb.rect.x + hb.rect.w);
    }
    // A projectile is a full-screen zoning tool — its reach dwarfs any normal.
    if (mv.projectile) r = Math.max(r, 260 + mv.projectile.velX * mv.projectile.lifetime * 0.05);
  }
  return Math.max(r, b.throwRange);
};

/** Toolkit depth: specials, super, and how interconnected the cancel graph is. */
const technique = (b: Roster['bundle']): number => {
  const specials = b.moves.filter((m) => m.type === 'special').length;
  const supers = b.moves.filter((m) => m.type === 'super').length;
  const cancelLinks = b.cancels.reduce((n, e) => n + e.to.length, 0);
  return specials * 3 + supers * 4 + cancelLinks;
};

/** Attack moves only (drop the sys.* animation-only tracks). */
const attackMoveCount = (b: Roster['bundle']): number =>
  b.moves.filter((m) => m.type !== 'system').length;

/**
 * Map a raw metric to 1..5 filled segments against a fixed ABSOLUTE reference
 * band (not the roster). Absolute is the right call for "reflect the actual
 * configuration": a 10k-HP fighter reads the same STAMINA no matter who else
 * is on the roster, and a character's profile only moves when its own Studio
 * config changes. Bands are chosen so the shipped archetype lands mid-to-high
 * and a designer's tuning visibly pushes bars up or down.
 */
const band = (v: number, lo: number, hi: number): number =>
  Math.max(1, Math.min(5, Math.round(1 + 4 * ((v - lo) / (hi - lo)))));

// Memoized: metrics never change for a loaded roster; recomputing every frame
// on the select screen would be wasteful.
let statsCacheKey: Roster[] | null = null;
let statsCache: CharStats[] = [];

const computeRosterStats = (rosters: Roster[]): CharStats[] => {
  if (statsCacheKey === rosters) return statsCache;
  statsCache = rosters.map((r) => {
    const b = r.bundle;
    return {
      bars: [
        { key: 'power', label: 'POWER', segs: band(peakDamage(b), 500, 1300) },
        { key: 'speed', label: 'SPEED', segs: band(b.walkFSpeed + b.dashFSpeed, 8, 20) },
        { key: 'range', label: 'RANGE', segs: band(reach(b), 90, 340) },
        { key: 'stamina', label: 'STAMINA', segs: band(b.maxHealth, 7000, 13000) },
        { key: 'technique', label: 'TECHNIQUE', segs: band(technique(b), 40, 180) },
      ],
      health: b.maxHealth,
      moveCount: attackMoveCount(b),
    };
  });
  statsCacheKey = rosters;
  return statsCache;
};

/**
 * The AI-agent opponent's identity for the select-screen badge — resolved by
 * the client from the match server's /agents/roster (real live agents), or the
 * house agent (real aggregate record + a per-player calibrated level) when no
 * live agent is available.
 */
export interface AgentOpponent {
  kind: 'live' | 'house';
  name: string;
  level: number;
  wins: number;
  losses: number;
  streak: number;
  wallet: string; // already shortened (0xAB…CDEF), or ''
  minds: boolean; // show the "Connected to Minds™" badge
}
export interface CpuBadgeInfo { cpuLevel: number; lever: number; opp?: AgentOpponent }

const AGENT_ACCENT = '#4ea8de'; // opponent (P2) blue

/**
 * Upper-right AGENT OPPONENT card: who you're about to fight. Shows the
 * agent's name, LEVEL (still lever-adjustable), win/loss record, current win
 * streak and shortened wallet — real data for a live agent, the house agent's
 * live aggregate otherwise. A "Connected to Minds™" ribbon marks the house /
 * simulated-agent case; a "LIVE AGENT" tag marks a real one.
 */
const drawCpuBadge = (ctx: CanvasRenderingContext2D, info: CpuBadgeInfo, tick: number): void => {
  const opp = info.opp;
  const w = 244, h = 68;
  const x = VW - 10 - w, y = 6;
  const pulse = fxPulse(tick, 0.09);
  const accent = AGENT_ACCENT;
  const delta = info.lever === 0 ? '' : info.lever > 0 ? `+${info.lever}` : `${info.lever}`;

  // Panel: rounded, gradient fill, glowing accent outline.
  ctx.save();
  ctx.shadowColor = accent + 'aa';
  ctx.shadowBlur = 10 + 6 * pulse;
  const gp = ctx.createLinearGradient(0, y, 0, y + h);
  gp.addColorStop(0, '#161a28f4');
  gp.addColorStop(1, '#0b0d16f4');
  rrect(ctx, x, y, w, h, 10);
  ctx.fillStyle = gp;
  ctx.fill();
  ctx.restore();
  ctx.save();
  rrect(ctx, x + 1.5, y + 1.5, w - 3, h - 3, 9);
  ctx.strokeStyle = accent;
  ctx.lineWidth = 1.5;
  ctx.shadowColor = accent;
  ctx.shadowBlur = 5 + 5 * pulse;
  ctx.stroke();
  ctx.restore();

  // Header strip: "AGENT OPPONENT" + LIVE / Minds ribbon.
  ctx.save();
  rrect(ctx, x, y, w, h, 10);
  ctx.clip();
  const gh = ctx.createLinearGradient(x, 0, x + w, 0);
  gh.addColorStop(0, tintHex(accent, -8));
  gh.addColorStop(1, tintHex(accent, -52));
  ctx.fillStyle = gh;
  ctx.fillRect(x, y, w, 15);
  ctx.restore();
  label(ctx, 'AGENT OPPONENT', x + 8, y + 12, 9, '#ffffff', 'left', true);
  const live = opp?.kind === 'live';
  const ribbon = live ? '◆ LIVE AGENT' : '◇ CONNECTED · MINDS™';
  label(ctx, ribbon, x + w - 8, y + 12, 9, live ? '#8fe8a0' : '#bfe0ff', 'right', true);

  if (!opp) {
    // Fallback: bare calibrated level (server unreachable, identity pending).
    display(ctx, `LV ${info.cpuLevel}`, x + w / 2, y + 46, 24, { align: 'center' });
    if (delta) label(ctx, `(${delta})`, x + w / 2 + 52, y + 46, 11, '#7ee85a', 'left', false);
    label(ctx, '[  /  ]  ADJUST LEVEL', x + w / 2, y + h - 5, 9, '#c8c4ba99');
    return;
  }

  // Name + level.
  display(ctx, opp.name.toUpperCase().slice(0, 16), x + 10, y + 36, 17, {
    align: 'left', glow: accent + 'aa', glowBlur: 10,
  });
  display(ctx, `LV ${opp.level}`, x + w - 10, y + 36, 18, { align: 'right' });
  if (delta) label(ctx, delta, x + w - 10, y + 47, 9, '#7ee85a', 'right', false);

  // Record · streak (left) and wallet (right).
  const streakStr = opp.streak > 0 ? `  ·  W${opp.streak} STREAK` : '';
  label(ctx, `${opp.wins}W  ${opp.losses}L${streakStr}`, x + 10, y + 55, 10, '#ffd99b', 'left', true);
  if (opp.wallet) label(ctx, opp.wallet, x + 10, y + 65, 9, '#8fb6d8', 'left', false);
  label(ctx, '[ / ] LV', x + w - 10, y + 64, 8, '#c8c4ba88', 'right', false);
};

/**
 * AGENT ARCADE's replacement for the opponent card (ADR 0008). The gauntlet
 * has no single opponent to name — the fighter you meet is whoever guards the
 * node you choose, on a board that is not minted until the pick is locked —
 * and no difficulty lever, because skill is pinned by REGION DEPTH server-side
 * (`REGION_SKILL`), never by the player. So this card quotes the ramp: the one
 * honest answer to "who am I fighting" that this screen can give.
 */
const drawGauntletOpposition = (ctx: CanvasRenderingContext2D, tick: number): void => {
  const w = 244, h = 68;
  const x = VW - 10 - w, y = 6;
  const pulse = fxPulse(tick, 0.09);
  const accent = AGENT_ACCENT;

  ctx.save();
  ctx.shadowColor = accent + 'aa';
  ctx.shadowBlur = 10 + 6 * pulse;
  const gp = ctx.createLinearGradient(0, y, 0, y + h);
  gp.addColorStop(0, '#161a28f4');
  gp.addColorStop(1, '#0b0d16f4');
  rrect(ctx, x, y, w, h, 10);
  ctx.fillStyle = gp;
  ctx.fill();
  ctx.restore();
  ctx.save();
  rrect(ctx, x + 1.5, y + 1.5, w - 3, h - 3, 9);
  ctx.strokeStyle = accent;
  ctx.lineWidth = 1.5;
  ctx.shadowColor = accent;
  ctx.shadowBlur = 5 + 5 * pulse;
  ctx.stroke();
  ctx.restore();

  ctx.save();
  rrect(ctx, x, y, w, h, 10);
  ctx.clip();
  const gh = ctx.createLinearGradient(x, 0, x + w, 0);
  gh.addColorStop(0, tintHex(accent, -8));
  gh.addColorStop(1, tintHex(accent, -52));
  ctx.fillStyle = gh;
  ctx.fillRect(x, y, w, 15);
  ctx.restore();
  label(ctx, 'THE OPPOSITION', x + 8, y + 12, 9, '#ffffff', 'left', true);
  label(ctx, '◇ DEEPER = HARDER', x + w - 8, y + 12, 9, '#bfe0ff', 'right', true);

  // One row per region: zone name and the AI skill band standing in it.
  const regions = [1, 2, 3] as const;
  const tint = ['#8fe8a0', '#ffd99b', '#ff9d9d'];
  regions.forEach((r, k) => {
    const ry = y + 30 + k * 13;
    label(ctx, REGION_NAME[r], x + 10, ry, 10, tint[k]!, 'left', true);
    const [lo, hi] = REGION_SKILL[r];
    label(ctx, `SKILL ${lo}–${hi}`, x + w - 10, ry, 10, '#c8c4bacc', 'right', false);
  });
};

// ------------------------------------------------------------- fighter lore
/**
 * The authored flavor block on a character bundle (`meta`, spec §3 — cosmetic,
 * stripped before the sim version hash, so editing it can never desync a
 * match). `style` is the CANONICAL archetype: the same field the match server
 * reads to build an arcade opponent's personality, so the select screen and
 * the AI it describes can never disagree.
 */
interface FighterLore { bio?: string; quote?: string; style?: string }

const loreOf = (r: Roster): FighterLore =>
  (r.bundle as { meta?: FighterLore }).meta ?? {};

/** What each archetype actually DOES, in the player's language. */
const STYLE_INFO: Record<string, { label: string; tag: string; color: string }> = {
  rushdown: { label: 'RUSHDOWN', tag: 'CLOSE THE GAP AND NEVER LET GO', color: '#ff7a5c' },
  zoner: { label: 'ZONER', tag: 'OWN THE SPACE · PUNISH THE APPROACH', color: '#6fd3ff' },
  turtle: { label: 'TURTLE', tag: 'BLOCK · READ · PUNISH', color: '#8fd0ff' },
  jumpy: { label: 'AERIAL', tag: 'ATTACK FROM ABOVE · NEVER STAND STILL', color: '#c39bff' },
  grappler: { label: 'GRAPPLER', tag: 'WALK YOU DOWN AND TAKE YOU DOWN', color: '#ffb45c' },
  'all-rounder': { label: 'ALL-ROUNDER', tag: 'NO BAD MATCHUP · NO FREE ROUND', color: '#8fe8a0' },
};
const styleInfo = (r: Roster): { label: string; tag: string; color: string } =>
  STYLE_INFO[loreOf(r).style ?? ''] ?? { label: 'UNKNOWN', tag: 'AN UNFILED FIGHTING STYLE', color: '#c8c4ba' };

/**
 * Greedy word wrap in the display font, hard-capped at `maxLines` with an
 * ellipsis when the text overruns — authored bios are free-form, so the panel
 * must survive a long one rather than painting over its own frame.
 */
const wrapLines = (
  ctx: CanvasRenderingContext2D, s: string, maxW: number, size: number, maxLines: number,
): string[] => {
  ctx.font = `${size}px ${DISPLAY_FONT_STACK}`;
  const words = s.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let line = '';
  let i = 0;
  for (; i < words.length; i++) {
    const next = line ? `${line} ${words[i]}` : words[i]!;
    if (!line || ctx.measureText(next).width <= maxW) { line = next; continue; }
    out.push(line);
    line = words[i]!;
    if (out.length >= maxLines) break;
  }
  if (out.length < maxLines && line) { out.push(line); i = words.length; }
  if (i < words.length && out.length > 0) {
    // Ran out of lines mid-sentence: mark the truncation instead of hiding it.
    let last = out[out.length - 1]!;
    while (last.length > 1 && ctx.measureText(`${last}…`).width > maxW) last = last.slice(0, -1);
    out[out.length - 1] = `${last}…`;
  }
  return out;
};

/** Rounded-rectangle path (no fill/stroke — caller decides). */
const rrect = (
  ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number,
): void => {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
};

/** Lighten (d>0) / darken (d<0) a #rrggbb hex by a flat per-channel delta. */
const tintHex = (hex: string, d: number): string => {
  const n = parseInt(hex.slice(1), 16);
  const c = (v: number): number => Math.max(0, Math.min(255, v + d));
  return `rgb(${c((n >> 16) & 255)},${c((n >> 8) & 255)},${c(n & 255)})`;
};

/**
 * One labeled 5-segment stat bar. Filled segments are glossy accent pills with
 * a soft glow; a bright energy pulse travels across the filled run (the
 * "charging" fill animation); empty slots are dark with a faint accent stroke.
 */
const drawStatBar = (
  ctx: CanvasRenderingContext2D, x: number, y: number, w: number,
  stat: CharStat, accent: string, tick: number,
): void => {
  label(ctx, stat.label, x, y + 9, 10, '#d3cfe0', 'left', false);
  const trackX = x + 80, trackW = w - 80;
  const n = 5, sgap = 3, bh = 11, rad = 3;
  const segW = (trackW - (n - 1) * sgap) / n;
  const lightC = tintHex(accent, 75), darkC = tintHex(accent, -55);
  for (let s = 0; s < n; s++) {
    const sx = trackX + s * (segW + sgap);
    rrect(ctx, sx, y, segW, bh, rad);
    if (s < stat.segs) {
      const grad = ctx.createLinearGradient(0, y, 0, y + bh);
      grad.addColorStop(0, lightC);
      grad.addColorStop(0.5, accent);
      grad.addColorStop(1, darkC);
      ctx.save();
      ctx.shadowColor = accent;
      ctx.shadowBlur = 6;
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.restore();
      // Top gloss line.
      ctx.fillStyle = 'rgba(255,255,255,0.4)';
      rrect(ctx, sx + 1.5, y + 1.5, segW - 3, 2.5, 1);
      ctx.fill();
      // Travelling energy pulse — a bright wave sweeping left→right through the
      // filled run, each segment lit as the wave reaches it.
      const wave = Math.sin(tick / 9 - s * 0.85);
      if (wave > 0.05) {
        ctx.save();
        rrect(ctx, sx, y, segW, bh, rad);
        ctx.clip();
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = wave * 0.55;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(sx, y, segW, bh);
        ctx.restore();
      }
    } else {
      ctx.fillStyle = '#00000066';
      ctx.fill();
      ctx.strokeStyle = accent + '33';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }
};

/**
 * Progression shown on a fighter card. `xp`/`xpNeed` are the CURRENT level's
 * progress (the same pair the results screen animates — `xpForNext(level)`),
 * not a lifetime total; omit them and the bar is simply not drawn.
 */
export interface FighterRecord {
  level: number;
  xp?: number;
  xpNeed?: number;
  wins: number;
  losses: number;
}

/**
 * CHARACTER LEVEL / XP / W-L, as a compact three-part visual: a glowing level
 * chip, the record with its win rate, and a charging XP bar toward the next
 * level. Anchored inside a fighter card's info column.
 *
 * Returns the y it consumed down to, so the stat bars below can flow.
 */
const drawRecordBand = (
  ctx: CanvasRenderingContext2D, x: number, y: number, w: number,
  rec: FighterRecord, accent: string, tick: number,
): number => {
  const pulse = fxPulse(tick, 0.07);

  // 1) LEVEL chip — the loudest number on the band.
  const chipW = 62, chipH = 18;
  ctx.save();
  const gchip = ctx.createLinearGradient(0, y, 0, y + chipH);
  gchip.addColorStop(0, tintHex(accent, 30));
  gchip.addColorStop(1, tintHex(accent, -60));
  rrect(ctx, x, y, chipW, chipH, 5);
  ctx.fillStyle = gchip;
  ctx.shadowColor = accent;
  ctx.shadowBlur = 6 + 5 * pulse;
  ctx.fill();
  ctx.restore();
  rrect(ctx, x + 0.75, y + 0.75, chipW - 1.5, chipH - 1.5, 4.5);
  ctx.strokeStyle = tintHex(accent, 85);
  ctx.lineWidth = 1;
  ctx.stroke();
  label(ctx, `LV ${rec.level}`, x + chipW / 2, y + 14, 13, '#ffffff', 'center', true);

  // 2) W / L + win rate. Colored per outcome so the split reads at a glance.
  const games = rec.wins + rec.losses;
  const rate = games > 0 ? Math.round((rec.wins * 100) / games) : 0;
  ctx.font = `12px ${DISPLAY_FONT_STACK}`;
  const lossTxt = `${rec.losses}L`;
  const rateTxt = games > 0 ? `  ·  ${rate}%` : '  ·  NO RECORD';
  const rateW = ctx.measureText(rateTxt).width;
  const lossW = ctx.measureText(lossTxt).width;
  label(ctx, rateTxt, x + w, y + 14, 12, games > 0 ? '#ffd99b' : '#ffffff55', 'right', false);
  label(ctx, lossTxt, x + w - rateW, y + 14, 12, '#ff9d9d', 'right', true);
  label(ctx, `${rec.wins}W `, x + w - rateW - lossW, y + 14, 12, '#8fe8a0', 'right', true);

  // 3) XP bar toward the next level (absent on a record with no XP source).
  const barY = y + chipH + 5;
  if (rec.xpNeed === undefined || rec.xp === undefined || rec.xpNeed <= 0) return barY;
  const barH = 9;
  const frac = Math.max(0, Math.min(1, rec.xp / rec.xpNeed));
  rrect(ctx, x, barY, w, barH, 4);
  ctx.fillStyle = '#00000077';
  ctx.fill();
  ctx.strokeStyle = accent + '44';
  ctx.lineWidth = 1;
  ctx.stroke();
  if (frac > 0) {
    ctx.save();
    rrect(ctx, x, barY, w, barH, 4);
    ctx.clip();
    const gxp = ctx.createLinearGradient(0, barY, 0, barY + barH);
    gxp.addColorStop(0, tintHex(accent, 80));
    gxp.addColorStop(0.5, accent);
    gxp.addColorStop(1, tintHex(accent, -55));
    ctx.fillStyle = gxp;
    ctx.fillRect(x, barY, w * frac, barH);
    // Energy sweep along the filled run — the same "charging" language as the
    // stat bars, so the card reads as one system.
    const sweep = ((tick / 70) % 1) * (w * frac + 60) - 30;
    const gs = ctx.createLinearGradient(x + sweep - 26, 0, x + sweep + 26, 0);
    gs.addColorStop(0, 'rgba(255,255,255,0)');
    gs.addColorStop(0.5, 'rgba(255,255,255,0.35)');
    gs.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = gs;
    ctx.fillRect(x, barY, w * frac, barH);
    ctx.restore();
  }
  label(ctx, `${rec.xp} / ${rec.xpNeed} XP`, x + w / 2, barY + barH - 1, 8.5, '#ffffffdd', 'center', true);
  return barY + barH;
};

/**
 * A player's fighter card: portrait + name + concrete numbers (HP, moves) +
 * the derived stat bars, plus the pilot's LEVEL / XP / W-L when there is a
 * record to show. Anchored to a screen corner and accent-colored per player,
 * so P1 (left) and the opponent (right) read as two facing corners.
 */
const drawFighterCard = (
  ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number,
  r: Roster, stats: CharStats, accent: string, header: string, locked: boolean, tick: number,
  record?: FighterRecord,
): void => {
  const rad = 12;
  const pulse = fxPulse(tick, 0.08); // 0..1 breathing for the accent glow

  // 1) Panel: rounded, vertical gradient fill, cast on a soft accent glow that
  // intensifies when the pick is locked in.
  ctx.save();
  ctx.shadowColor = accent + (locked ? 'ee' : '88');
  ctx.shadowBlur = (locked ? 20 : 11) + 7 * pulse;
  const gpanel = ctx.createLinearGradient(0, y, 0, y + h);
  gpanel.addColorStop(0, '#1b1728f4');
  gpanel.addColorStop(1, '#0c0a15f4');
  rrect(ctx, x, y, w, h, rad);
  ctx.fillStyle = gpanel;
  ctx.fill();
  ctx.restore();

  // 2) Glowing accent outline (the "stroke" ask) — double stroke: a wide soft
  // halo underneath, a crisp bright line on top.
  ctx.save();
  rrect(ctx, x + 1.5, y + 1.5, w - 3, h - 3, rad - 1);
  ctx.strokeStyle = accent;
  ctx.lineWidth = 2;
  ctx.shadowColor = accent;
  ctx.shadowBlur = 7 + 6 * pulse;
  ctx.stroke();
  ctx.restore();
  ctx.save();
  rrect(ctx, x + 1.5, y + 1.5, w - 3, h - 3, rad - 1);
  ctx.strokeStyle = tintHex(accent, 90);
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.restore();

  // 3) Header strip: horizontal accent gradient with a bright lower edge,
  // clipped to the card's rounded top.
  ctx.save();
  rrect(ctx, x, y, w, h, rad);
  ctx.clip();
  const ghead = ctx.createLinearGradient(x, 0, x + w, 0);
  ghead.addColorStop(0, tintHex(accent, -6));
  ghead.addColorStop(1, tintHex(accent, -52));
  ctx.fillStyle = ghead;
  ctx.fillRect(x, y, w, 22);
  ctx.fillStyle = tintHex(accent, 80);
  ctx.fillRect(x, y + 21, w, 1.5);
  // A faint top inner highlight across the whole panel.
  const gtop = ctx.createLinearGradient(0, y + 22, 0, y + 52);
  gtop.addColorStop(0, 'rgba(255,255,255,0.08)');
  gtop.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gtop;
  ctx.fillRect(x, y + 22, w, 30);
  ctx.restore();
  // White text with a dark drop-shadow reads across the whole accent gradient
  // (black was unreadable on the strip's dark end).
  label(ctx, header, x + 10, y + 15, 12, '#ffffff', 'left', true);
  // Status: a small pulsing dot + word.
  const statusTxt = locked ? 'LOCKED' : 'CHOOSING…';
  if (!locked) {
    ctx.globalAlpha = 0.5 + 0.5 * fxPulse(tick, 0.12);
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(x + w - 78, y + 11, 2.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }
  label(ctx, statusTxt, x + w - 10, y + 15, 10, locked ? '#ffffff' : '#ffffffcc', 'right', true);

  // 4) Portrait on the inner-left: a glowing accent ring, a rounded framed
  // window, a slow diagonal shine, and the locked marching-ants outline.
  const pad = 12;
  const pSize = h - 32 - pad;
  const px2 = x + pad;
  const py2 = y + 24 + pad;
  ctx.save();
  ctx.shadowColor = accent;
  ctx.shadowBlur = 9 + 5 * pulse;
  rrect(ctx, px2 - 3, py2 - 3, pSize + 6, pSize + 6, 7);
  ctx.strokeStyle = accent;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();
  ctx.save();
  rrect(ctx, px2, py2, pSize, pSize, 5);
  ctx.clip();
  ctx.fillStyle = '#0c0a14';
  ctx.fillRect(px2, py2, pSize, pSize);
  drawPortrait(ctx, r, px2, py2, pSize, pSize);
  // Diagonal shine sweeping across the portrait every few seconds.
  const shT = (tick % 240) / 240;
  ctx.globalCompositeOperation = 'lighter';
  ctx.translate(px2 - pSize + shT * (pSize * 2.4), py2);
  ctx.rotate(-0.35);
  const sg = ctx.createLinearGradient(-14, 0, 14, 0);
  sg.addColorStop(0, 'rgba(255,255,255,0)');
  sg.addColorStop(0.5, 'rgba(255,255,255,0.14)');
  sg.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = sg;
  ctx.fillRect(-14, -pSize * 0.5, 28, pSize * 2);
  ctx.restore();
  if (locked) marchingOutline(ctx, px2 - 4, py2 - 4, pSize + 8, pSize + 8, tick, accent, 10, 0.7);

  // 5) Name (with a matching glow) + concrete config numbers.
  const infoX = px2 + pSize + 14;
  const infoW = x + w - pad - infoX;
  display(ctx, r.bundle.name.toUpperCase(), infoX, py2 + 15, 20, {
    align: 'left', glow: accent + 'aa', glowBlur: 12,
  });
  label(ctx, `${stats.health.toLocaleString()} HP   ·   ${stats.moveCount} MOVES`,
    infoX, py2 + 31, 11, '#ffd99b', 'left', false);

  // 6) LEVEL / XP / W-L, then the stat bars in whatever room is left. With no
  // record (local P2, a friendly's opponent) the bars simply breathe wider
  // rather than leaving a hole where the band would have been.
  const bandEnd = record ? drawRecordBand(ctx, infoX, py2 + 38, infoW, record, accent, tick) : 0;
  let by = record ? bandEnd + 6 : py2 + 46;
  const step = record ? 19 : 24;
  for (const s of stats.bars) {
    drawStatBar(ctx, infoX, by, infoW, s, accent, tick);
    by += step;
  }
};

/**
 * FIGHTER INFO — who this character actually is, in the slot the AGENT ARCADE
 * rules panel used to occupy. The gauntlet's rules moved to the map screen
 * (where the route decision is actually made); this screen's job is the pick,
 * so it answers the pick's question instead: what does this fighter play like,
 * and what do they have to say about it.
 *
 * Every line is authored character data (`meta.bio` / `meta.quote` /
 * `meta.style`) — nothing here is re-typed prose that can drift from the
 * bundle, and a character with no lore degrades to its art description.
 */
const drawFighterInfo = (
  ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number,
  r: Roster, tick: number,
): void => {
  const rad = 12;
  const pulse = fxPulse(tick, 0.06);
  const st = styleInfo(r);
  const accent = st.color;

  ctx.save();
  ctx.shadowColor = accent + '77';
  ctx.shadowBlur = 10 + 5 * pulse;
  const gp = ctx.createLinearGradient(0, y, 0, y + h);
  gp.addColorStop(0, '#1b1728f4');
  gp.addColorStop(1, '#0c0a15f4');
  rrect(ctx, x, y, w, h, rad);
  ctx.fillStyle = gp;
  ctx.fill();
  ctx.restore();
  ctx.save();
  rrect(ctx, x + 1.5, y + 1.5, w - 3, h - 3, rad - 1);
  ctx.strokeStyle = accent;
  ctx.lineWidth = 1.6;
  ctx.shadowColor = accent;
  ctx.shadowBlur = 6 + 5 * pulse;
  ctx.stroke();
  ctx.restore();

  // Header strip, same language as the fighter card opposite it.
  ctx.save();
  rrect(ctx, x, y, w, h, rad);
  ctx.clip();
  const gh = ctx.createLinearGradient(x, 0, x + w, 0);
  gh.addColorStop(0, tintHex(accent, -20));
  gh.addColorStop(1, tintHex(accent, -70));
  ctx.fillStyle = gh;
  ctx.fillRect(x, y, w, 22);
  ctx.fillStyle = tintHex(accent, 70);
  ctx.fillRect(x, y + 21, w, 1.5);
  ctx.restore();
  label(ctx, 'FIGHTER INFO', x + 10, y + 15, 12, '#ffffff', 'left', true);
  label(ctx, r.bundle.name.toUpperCase().slice(0, 18), x + w - 10, y + 15, 12, '#ffffffcc', 'right', true);

  const pad = 14;
  const ix = x + pad;
  const iw = w - pad * 2;

  // FIGHTING STYLE — a chip in the archetype's own color plus what it means.
  ctx.font = `13px ${DISPLAY_FONT_STACK}`;
  const chipW = Math.min(iw, ctx.measureText(st.label).width + 22);
  const chipY = y + 32;
  ctx.save();
  const gchip = ctx.createLinearGradient(0, chipY, 0, chipY + 20);
  gchip.addColorStop(0, tintHex(accent, 10));
  gchip.addColorStop(1, tintHex(accent, -70));
  rrect(ctx, ix, chipY, chipW, 20, 5);
  ctx.fillStyle = gchip;
  ctx.shadowColor = accent;
  ctx.shadowBlur = 6;
  ctx.fill();
  ctx.restore();
  label(ctx, st.label, ix + chipW / 2, chipY + 15, 13, '#ffffff', 'center', true);
  label(ctx, 'FIGHTING STYLE', ix + chipW + 10, chipY + 8, 9, '#ffffff77', 'left', false);
  label(ctx, st.tag, ix + chipW + 10, chipY + 19, 10, accent, 'left', false);

  const rule = (ry: number): void => {
    ctx.strokeStyle = 'rgba(255,255,255,0.10)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(ix, ry);
    ctx.lineTo(ix + iw, ry);
    ctx.stroke();
  };
  rule(chipY + 32);

  // DESCRIPTION — the authored bio, falling back to the art description so a
  // freshly generated character is never a blank panel.
  const lore = loreOf(r);
  const bio = (lore.bio ?? (r.bundle as { meta?: { desc?: string } }).meta?.desc ?? '').trim();
  let ty = chipY + 50;
  label(ctx, 'DESCRIPTION', ix, ty, 9, '#ffffff77', 'left', false);
  ty += 15;
  const bioLines = bio
    ? wrapLines(ctx, bio.toUpperCase(), iw, 12, 3)
    : ['NO DOSSIER ON FILE.'];
  for (const ln of bioLines) {
    label(ctx, ln, ix, ty, 12, '#e6e1f0', 'left', false);
    ty += 15;
  }

  // QUOTE — set apart by a colored spine and oversized quote marks, so it
  // reads as the character talking rather than another stat line.
  const qTop = y + h - 54;
  rule(qTop - 10);
  const quote = (lore.quote ?? '').trim();
  if (quote) {
    ctx.fillStyle = accent + '88';
    ctx.fillRect(ix, qTop, 2.5, 40);
    display(ctx, '“', ix + 12, qTop + 26, 30, {
      align: 'left', alpha: 0.35, from: '#ffffff', mid: accent, to: accent,
      outline: 'rgba(0,0,0,0)', rim: 'rgba(0,0,0,0)',
    });
    const qLines = wrapLines(ctx, quote.toUpperCase(), iw - 34, 13, 2);
    let qy = qTop + (qLines.length === 1 ? 24 : 16);
    for (const ln of qLines) {
      label(ctx, ln, ix + 30, qy, 13, GOLD_LT, 'left', true);
      qy += 16;
    }
  } else {
    label(ctx, 'SAYS NOTHING. LETS THE FRAME DATA TALK.', ix, qTop + 24, 12, '#ffffff55', 'left', false);
  }
};

export const drawSelect = (
  ctx: CanvasRenderingContext2D,
  rosters: Roster[],
  cursors: [number, number],
  locked: [boolean, boolean],
  tick: number,
  cpuInfo?: CpuBadgeInfo,
  /**
   * Set = AGENT ARCADE entry: swaps the P2 card for the gauntlet rules panel
   * and the opponent card for the region ramp. `practice` = a guest's local,
   * reward-free run — the panel must not quote a fee it will never charge.
   */
  arcade?: { practice: boolean },
  /** Set = friendly challenge entry: retitles the screen (free, no stakes). */
  friendly?: boolean,
  /** The player's own progression (level / XP / W-L) for their card. */
  record?: FighterRecord,
): void => {
  drawMenuBackdrop(ctx);
  ctx.fillStyle = '#0a0616d9';
  ctx.fillRect(0, 0, VW, VH);

  const stats = computeRosterStats(rosters);
  const heading = arcade
    ? (arcade.practice ? 'AGENT ARCADE — PRACTICE RUN' : 'AGENT ARCADE — CHOOSE YOUR FIGHTER')
    : friendly ? 'FRIENDLY CHALLENGE — CHOOSE YOUR FIGHTER'
    : 'SELECT YOUR FIGHTER';
  display(ctx, heading, VW / 2, 46, 24);
  // Escape hatch back to the title — phones have no ESC key. Top-LEFT, tucked
  // just under the wallet strip (which owns the very top line), so the
  // top-right corner is free for the AGENT OPPONENT card (drawn last, on top).
  const backW = 100, backH = 28;
  const backX = 12, backY = 34;
  tapZone(backX, backY, backW, backH, 'back');
  ctx.fillStyle = 'rgba(10,6,22,0.6)';
  ctx.fillRect(backX, backY, backW, backH);
  ctx.strokeStyle = 'rgba(255,255,255,0.22)';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(backX + 0.5, backY + 0.5, backW - 1, backH - 1);
  ctx.lineWidth = 1;
  label(ctx, '‹ TITLE', backX + backW / 2, backY + backH / 2 + 4, 12, '#ffffffcc');
  // Top-right: the gauntlet quotes its skill ramp (no one opponent, no lever);
  // every other mode names the agent you are about to face.
  if (arcade) drawGauntletOpposition(ctx, tick);
  else if (cpuInfo) drawCpuBadge(ctx, cpuInfo, tick);

  // Portrait grid — wraps past 6 columns. The fighter cards below own a FIXED
  // band at the bottom of the screen; the grid gets the fixed region between
  // the heading and that band. Cells shrink to fit as the roster grows so the
  // grid never pushes the cards off-screen (that cropped the layout once the
  // roster passed two rows).
  const cols = Math.min(rosters.length, 6);
  const gap = 12;
  const nameH = 20; // per-cell headroom for the name label under each portrait
  const maxGridW = 720;
  const rows = Math.ceil(rosters.length / cols);
  const cardW = 448, cardH = 206;
  const cardY = VH - cardH - 26; // fixed: the card band never moves
  const gy = 74;
  const bandH = cardY - 6 - gy; // vertical room the grid must fit within
  const cellByW = Math.floor((maxGridW - (cols - 1) * gap) / cols);
  const cellByH = Math.floor((bandH - nameH - (rows - 1) * (gap + nameH)) / rows);
  const cell = Math.max(28, Math.min(96, cellByW, cellByH));
  const gridW = cols * cell + (cols - 1) * gap;
  const gx = (VW - gridW) / 2;
  rosters.forEach((r, k) => {
    const x = gx + (k % cols) * (cell + gap);
    const y = gy + Math.floor(k / cols) * (cell + gap + 20);
    // Tap the portrait to move the cursor here; tap the selected one again to
    // confirm (main.ts). Disabled fighters register nothing — untappable.
    if (!r.disabled) tapZone(x - 2, y - 2, cell + 4, cell + 24, `pick:${k}`);
    bevel(ctx, x - 2, y - 2, cell + 4, cell + 4, PANEL, GOLD, GOLD_DK, 2);
    drawPortrait(ctx, r, x, y, cell, cell);
    if (r.disabled) {
      // Grey veil + tag: the fighter is present but unselectable.
      ctx.save();
      ctx.fillStyle = '#0a0a12cc';
      ctx.fillRect(x, y, cell, cell);
      ctx.restore();
      label(ctx, 'DISABLED', x + cell / 2, y + cell / 2 + 3, 10, '#c04a5a', 'center', false);
    }
    label(ctx, r.bundle.name.toUpperCase(), x + cell / 2, y + cell + 14, 11, r.disabled ? '#5a5f70' : '#fff');

    // Selection cursors: smooth pulsing glow instead of a hard blink.
    // (Disabled fighters are skipped by the cursor, so none render here.)
    for (const i of [0, 1] as const) {
      if (i === 1 && arcade) break; // arcade: only the player's cursor exists
      if (cursors[i] !== k) continue;
      const pulse = locked[i] ? 1 : 0.55 + 0.45 * (0.5 + 0.5 * Math.sin(tick / 8));
      const o = i === 0 ? 0 : 4; // offset so both cursors are visible on the same cell
      const fx = { x: x - 5 - o, y: y - 5 - o, w: cell + 10 + o * 2, h: cell + 10 + o * 2 };
      ctx.save();
      ctx.globalAlpha = pulse;
      ctx.strokeStyle = P_COLORS[i];
      ctx.lineWidth = 3;
      ctx.strokeRect(fx.x, fx.y, fx.w, fx.h);
      ctx.restore();
      // Locked-in: an energized marching-ants outline seals the pick.
      if (locked[i]) marchingOutline(ctx, fx.x - 3, fx.y - 3, fx.w + 6, fx.h + 6, tick, P_COLORS[i], 10, 0.8);
      ctx.fillStyle = P_COLORS[i];
      const tagX = i === 0 ? x - 5 : x + cell - 25;
      ctx.fillRect(tagX, y - 20, 30, 15);
      label(ctx, locked[i] ? `P${i + 1}✓` : `P${i + 1}`, tagX + 15, y - 9, 10, '#fff', 'center', false);
    }
  });

  // Two fighter cards in the bottom band — one per side, showing the fighter
  // each cursor is hovering, with stats derived from real bundle config.
  // (cardW/cardH/cardY are fixed above; the grid sizes itself around them.)

  // Animated hanging BANNERS in the empty side-margins beside the grid: the
  // player's (device region) on the left, the opponent's (auth metadata) on
  // the right — both fall back to a WE ARE ANONYMOUS banner when unknown. They
  // hang the full height from the top down to just above the fighter cards.
  const flagBoxW = gx - 16;
  if (flagBoxW >= 72) {
    const flagY = 74;
    const flagH = cardY - flagY - 6;
    drawFlag(ctx, 0, 8, flagY, flagBoxW, flagH, tick, false);
    drawFlag(ctx, 1, gx + gridW + 8, flagY, flagBoxW, flagH, tick, true);
  }
  const p2Header = cpuInfo ? `AGENT · LV ${cpuInfo.cpuLevel}` : 'PLAYER 2';
  // Arcade has no player 2 to be the first of — the card is simply your run.
  const cardHeaders: [string, string] = [arcade ? 'YOUR FIGHTER' : 'PLAYER 1', p2Header];
  // The opponent card quotes the agent's OWN record (its level and W-L are
  // real server data); a local P2 has none, and gets the wider bar layout.
  const oppRecord: FighterRecord | undefined = cpuInfo?.opp
    ? { level: cpuInfo.opp.level, wins: cpuInfo.opp.wins, losses: cpuInfo.opp.losses }
    : undefined;
  for (const i of [0, 1] as const) {
    if (i === 1 && arcade) break; // arcade: the fighter-info panel takes P2's slot
    const r = rosters[cursors[i]];
    if (!r) continue;
    const cx = i === 0 ? 16 : VW - 16 - cardW;
    drawFighterCard(ctx, cx, cardY, cardW, cardH, r, stats[cursors[i]]!,
      P_COLORS[i], cardHeaders[i], locked[i], tick, i === 0 ? record : oppRecord);
  }

  // AGENT ARCADE: the mode's RULES now live on the map screen, where the route
  // decision they describe is actually made. This slot answers the question
  // this screen asks instead — who is this fighter.
  if (arcade) {
    const hovered = rosters[cursors[0]];
    if (hovered) drawFighterInfo(ctx, VW - 16 - cardW, cardY, cardW, cardH, hovered, tick);
  }

  const bothLocked = locked[0] && locked[1];
  if (arcade) {
    // The one claim that MUST survive here is the money one — everything else
    // about the gauntlet is explained on the board itself.
    label(ctx, arcade.practice
      ? 'FREE PRACTICE RUN · NOTHING BANKS · TAP TWICE / F  LOCK IN — YOUR PICK RIDES THE WHOLE RUN'
      : '1 CREDIT ENTRY · TAP TWICE / F  LOCK IN — YOUR PICK MINTS THE BOARD AND RIDES THE WHOLE RUN',
    VW / 2, VH - 8, 12, '#ffffffaa');
  } else if (bothLocked) {
    const pulse = 1 + 0.04 * Math.sin(tick / 9);
    display(ctx, 'PRESS START TO FIGHT', VW / 2, VH - 8, 20, { scale: pulse, glow: 'rgba(255,209,102,0.5)' });
  } else {
    label(ctx, 'P1: A/D MOVE · F CONFIRM      P2: ←/→ MOVE · K CONFIRM',
      VW / 2, VH - 8, 12, '#ffffffaa');
  }
};

// ---------------------------------------------------------------- stage select
export const drawStageSelect = (
  ctx: CanvasRenderingContext2D,
  stageIds: string[],
  cursor: number,
  tick: number,
): void => {
  // Backdrop previews the currently-highlighted stage — the caller keeps
  // the global stage asset in sync with `cursor` as it moves.
  ctx.save();
  const cam = menuCam();
  worldTransform(ctx, cam);
  drawStage(ctx, cam);
  ctx.restore();
  ctx.fillStyle = '#0a0616cc';
  ctx.fillRect(0, 0, VW, VH);

  display(ctx, 'SELECT STAGE', VW / 2, 60, 32);

  const cell = 172, cellH = 108, gap = 22;
  const cols = stageIds.length;
  const gridW = cols * cell + (cols - 1) * gap;
  const gx = (VW - gridW) / 2;
  const gy = 150;
  stageIds.forEach((id, k) => {
    const x = gx + k * (cell + gap);
    const y = gy;
    const on = k === cursor;
    tapZone(x - 3, y - 3, cell + 6, cellH + 6, `stage:${k}`);
    bevel(ctx, x - 3, y - 3, cell + 6, cellH + 6, PANEL, on ? GOLD : GOLD_DK, GOLD_DK, on ? 3 : 2);
    ctx.fillStyle = PANEL_LT;
    ctx.fillRect(x, y, cell, cellH);
    label(ctx, id.toUpperCase(), x + cell / 2, y + cellH / 2 + 6, 16, on ? '#fff' : '#ffffffaa');

    if (on) {
      const pulse = 0.6 + 0.4 * (0.5 + 0.5 * Math.sin(tick / 8));
      ctx.save();
      ctx.globalAlpha = pulse;
      ctx.strokeStyle = GOLD_LT;
      ctx.lineWidth = 4;
      ctx.strokeRect(x - 8, y - 8, cell + 16, cellH + 16);
      ctx.restore();
    }
  });

  label(ctx, 'TAP / ◄ ►  CHOOSE STAGE      ENTER  FIGHT      ESC  BACK', VW / 2, VH - 26, 13, '#ffffffaa');
  tapZone(24, VH - 44, 150, 36, 'back');
};

// ---------------------------------------------------------------- results
export interface XpInfo {
  gained: number; // negative on a ranked-solo loss (the "loser burns XP" rule)
  levelsUp: number;
  level: number;
  xp: number;
  xpNeed: number;
  wins: number;
  losses: number;
  /** Net credits vs before the entrance fee (wager win +10, loss −10 …). */
  creditsDelta?: number;
  /** Balance after settlement. */
  credits?: number;
  /** Free vending pulls earned by levelling up this match — revealed here. */
  freePulls?: ShopReveal[];
  /** This win minted a wager TICKET (ADR 0009); `tickets` = new balance. */
  ticket?: boolean;
  tickets?: number;
  /** Local offline "TRAINING LV" (no server, no credits, no pulls) — the
   *  banner reads as practice progress + a sign-in nudge, not the account. */
  training?: boolean;
}

export const drawResults = (
  ctx: CanvasRenderingContext2D,
  g: GameState,
  rosters: [Roster, Roster],
  tick: number,
  age: number, // ticks since the results screen appeared — drives the pop-in
  xp?: XpInfo | null,
  hint?: string, // bottom action line — callers label the rematch with its fee
  dare?: boolean, // human won + signed in → offer the dare screen (peak ego)
  /**
   * The SERVER's verdict, for matches the local sim never finished (opponent
   * forfeit / mid-match settlement): g.winner is still -1 then, and indexing
   * rosters[-1] crashed this screen before this fallback existed.
   */
  serverWinner?: number,
): void => {
  ctx.fillStyle = '#0a0616bb';
  ctx.fillRect(0, 0, VW, VH);

  const pop = easeOutBack(clamp01(age / 16));
  const boxW = 600, boxH = 120;
  const boxX = VW / 2 - boxW / 2, boxY = VH / 2 - 80;

  ctx.save();
  ctx.translate(VW / 2, VH / 2 - 20);
  ctx.scale(pop, pop);
  ctx.translate(-VW / 2, -(VH / 2 - 20));
  bevel(ctx, boxX, boxY, boxW, boxH, PANEL, GOLD, GOLD_DK, 3);
  const w = g.winner >= 0 ? g.winner : serverWinner ?? -1;
  const title = w === 2 ? 'DRAW GAME'
    : w < 0 ? 'NO CONTEST'
    : `${rosters[w as 0 | 1].bundle.name.toUpperCase()} WINS`;
  display(ctx, title, VW / 2, VH / 2 - 20, 44, w === 2 ? COOL_OPTS : {});
  label(ctx, `${g.roundsWon0} — ${g.roundsWon1}`, VW / 2, VH / 2 + 22, 24, '#fff');
  ctx.restore();

  // XP section: fully below the box, own vertical rhythm, never touches
  // the fixed bottom hint line.
  if (xp && age > 10) {
    const xpPop = clamp01((age - 10) / 14);
    ctx.save();
    ctx.globalAlpha = xpPop;
    let y = boxY + boxH + 30;
    const lvWord = xp.training ? 'TRAINING LV' : 'LV';
    if (xp.levelsUp > 0) {
      const flash = tick % 40 < 28;
      if (flash) display(ctx, `LEVEL UP!  ${lvWord} ${xp.level}`, VW / 2, y, 26, { glow: 'rgba(255,209,102,0.6)' });
      y += 32;
    }
    const xpTxt = `${xp.gained >= 0 ? '+' : ''}${xp.gained} XP`;
    display(ctx, xpTxt, VW / 2, y, 22, xp.gained >= 0
      ? { from: '#d9ffcf', mid: '#7ee85a', to: '#2f7a1f', outline: '#0e2a08' }
      : { from: '#ffd7d7', mid: '#ff6b6b', to: '#8a1f1f', outline: '#2a0808' });
    if (xp.creditsDelta !== undefined) {
      const cd = xp.creditsDelta;
      const cTxt = `${cd >= 0 ? '+' : '−'}${Math.abs(cd)} CREDIT${Math.abs(cd) === 1 ? '' : 'S'}   ·   BALANCE ${xp.credits ?? '?'}`;
      label(ctx, cTxt, VW / 2, y + 22, 15, cd >= 0 ? '#ffd166' : '#ff9d9d');
      y += 24;
    }
    // THE MINT (ADR 0009). A wager win pays no credits, so this line IS the
    // reward — give it the level-up treatment rather than burying it beside a
    // negative credit delta.
    if (xp.ticket) {
      y += 26;
      const glow = tick % 48 < 32;
      display(ctx, '🎟  TICKET EARNED  🎟', VW / 2, y, 20,
        glow
          ? { from: '#e8f7ff', mid: '#8ad6ff', to: '#1f5f8a', outline: '#06202e' }
          : { from: '#cfe9ff', mid: '#6fb8e0', to: '#164a6d', outline: '#06202e' });
      y += 20;
      // Cosmetic collectible — never promise a redemption we do not offer.
      label(ctx, `YOU HOLD ${xp.tickets ?? 1} · SHOWN ON THE LEADERBOARD`, VW / 2, y, 13, '#ffffffcc');
    }
    y += 16;
    const barW = 300, barH = 8;
    const bx = VW / 2 - barW / 2;
    ctx.fillStyle = '#101116';
    ctx.fillRect(bx - 2, y - 2, barW + 4, barH + 4);
    ctx.fillStyle = '#23242e';
    ctx.fillRect(bx, y, barW, barH);
    ctx.fillStyle = '#6fd3ff';
    ctx.fillRect(bx, y, Math.round((barW * Math.min(xp.xp, xp.xpNeed)) / Math.max(1, xp.xpNeed)), barH);
    y += 28;
    label(ctx, `${lvWord} ${xp.level}  ·  ${xp.xp}/${xp.xpNeed} XP  ·  ${xp.wins}W ${xp.losses}L`, VW / 2, y, 13, '#ffffffcc');
    // FREE PULL(S): the tangible level-up reward — a gold callout naming each
    // drink the machine coughed up (already granted server-side; this reveals).
    if (xp.freePulls && xp.freePulls.length > 0) {
      y += 26;
      const glow = tick % 44 < 30;
      display(ctx, `★ FREE PULL${xp.freePulls.length > 1 ? ` ×${xp.freePulls.length}` : ''}! ★`, VW / 2, y, 18,
        glow ? { glow: 'rgba(255,209,102,0.7)' } : {});
      xp.freePulls.forEach((it, k) => {
        const col = TIER_COLORS[it.tier] ?? '#fff';
        label(ctx, `${it.name}  ·  ${TIER_LABELS[it.tier] ?? ''}  —  ${it.desc}`, VW / 2, y + 20 + k * 17, 12, col);
      });
      y += 20 + xp.freePulls.length * 17;
    } else if (xp.training && xp.levelsUp > 0) {
      // Offline level-ups can't grant real rewards — nudge toward the account.
      y += 22;
      label(ctx, 'SIGN IN TO EARN ACCOUNT LEVELS + FREE VENDING PULLS', VW / 2, y, 12, '#ffd166cc');
    }
    ctx.restore();
  }

  if (tick % 60 < 42) {
    label(ctx, hint ?? 'TAP / ENTER: REMATCH        ESC: CHARACTER SELECT', VW / 2, VH - 26, 15, '#ffffffcc');
  }
  // Rematch fills the screen; the smaller "back" strip sits on the left.
  tapZone(0, 0, VW, VH, 'start');
  tapZone(0, VH - 48, 240, 48, 'back');
  // The moment after a win is peak ego — the best second to throw a dare.
  // Registered last so its tap wins over the full-screen rematch zone.
  if (dare) {
    const flash = tick % 50 < 38;
    label(ctx, 'D · TOO EASY? DARE A FRIEND — BOTH GET +25 CR', VW / 2, VH - 54, 13,
      flash ? '#ffd166' : '#ffe9a3');
    tapZone(VW / 2 - 240, VH - 70, 480, 24, 'dare');
  }
};

// ---------------------------------------------------------------- game over
/** Hot-red treatment for the GAME OVER headline. */
const GAMEOVER_OPTS: DisplayOpts = {
  from: '#ffe3e3', mid: '#ff5d7e', to: '#93202f', outline: '#2a060f', glow: 'rgba(255,45,74,0.5)',
};

/**
 * AGENT ARCADE run-ender: one loss anywhere in the gauntlet lands here, over
 * the frozen final frame of the fight. Any tap/key — or the countdown running
 * out — returns to the title (the caller owns that transition).
 */
export const drawGameOver = (
  ctx: CanvasRenderingContext2D,
  tick: number,
  age: number, // ticks since the screen appeared — drives pop-in + countdown
  info: { by: string; stage: number; total: number },
): void => {
  ctx.fillStyle = '#12040acc';
  ctx.fillRect(0, 0, VW, VH);

  const pop = easeOutBack(clamp01(age / 20));
  ctx.save();
  ctx.translate(VW / 2, VH / 2 - 30);
  ctx.scale(pop, pop);
  ctx.translate(-VW / 2, -(VH / 2 - 30));
  display(ctx, 'GAME OVER', VW / 2, VH / 2 - 30, 72, GAMEOVER_OPTS);
  ctx.restore();

  if (age > 14) {
    label(ctx, `DEFEATED BY ${info.by.toUpperCase()}  ·  BATTLE ${info.stage} OF ${info.total}`,
      VW / 2, VH / 2 + 24, 16, '#ffd7d7');
    label(ctx, 'THE GAUNTLET RESETS — ENTER AGAIN FROM THE TITLE', VW / 2, VH / 2 + 50, 12, '#ffffff88');
  }
  const secs = Math.max(0, 10 - Math.trunc(age / 60));
  if (tick % 60 < 42) {
    label(ctx, `TAP / ENTER — TITLE SCREEN (${secs})`, VW / 2, VH - 30, 15, '#ffffffcc');
  }
  tapZone(0, 0, VW, VH, 'start');
};

// ------------------------------------------------------------- leaderboard
/** One row of the public standings (the server's /leaderboard shape). */
export interface RankRow {
  name: string;
  is_agent: boolean;
  level: number;
  xp: number;
  wins: number;
  losses: number;
  rank: number;
  /**
   * Wager tickets. PHASE A (owner decision 2026-07-27, ADR 0009): a COSMETIC
   * collectible — no redemption, no prize, no cash-out TODAY. Phase B makes
   * them redeemable for esports seats and other non-cash prizes, against
   * schema that already exists, so nothing minted now is invalidated later.
   * UI RULE while in Phase A: say what a ticket IS, never what it may become —
   * no "redeemable soon", no teased catalog. Displayed here and nowhere in
   * the sort, because `rank` must stay a measure of play. Absent on a
   * pre-0021 server.
   */
  tickets?: number;
  /**
   * Ratings (ADR 0009 step 2). Served by `/leaderboard` but NOT RENDERED yet,
   * deliberately: this screen is sorted by progression (level/XP), and until a
   * rated wager has actually happened every value here is the 1200 base — a
   * column of identical numbers on a ladder that is not sorted by them. The
   * Elo ladder is its own board (`/leaderboard?board=season`, the
   * `season_board` view) and lands with the season/prize UI, which is where a
   * rating is the thing being ranked. Absent on a pre-0022 server.
   */
  elo?: number;
  season_elo?: number;
  rated?: number;
  season_rated?: number;
  /**
   * DEFEND record (ADR 0009 step 4): held/fell when humans fought this
   * agent's pinned matches. THE meaningful agent stat — rendering it on the
   * AGENTS tab is the season-UI pass, alongside the rating columns above.
   * Absent on a pre-0028 server.
   */
  defend_elo?: number;
  defend_wins?: number;
  defend_losses?: number;
}

export const RANK_TABS = ['ALL', 'HUMANS', 'AGENTS', 'SEASON'] as const;

/** Messaging for the current season, mirrored from @af/server persist.ts —
 *  the clock is FROZEN at season 0 until the owner starts season 1. */
export const SEASON_LABEL = 'SEASON 0 · OPEN BETA';

/**
 * One row of `/leaderboard?board=season` (the `season_board` view): the Elo
 * ladder, ranked ONLY for profiles past the provisional gate; everyone else
 * is listed below with a null rank ("placements"). Absent on a pre-0024
 * server, which ignores ?board= and returns RankRow-shaped rows — the
 * renderer tolerates that by falling back through the shared field names.
 */
export interface SeasonRow {
  name: string;
  is_agent: boolean;
  /** Season Elo (the view aliases season_elo to `elo`). */
  elo?: number;
  /** Rated matches this season — the provisional gate counts to 10. */
  rated?: number;
  level: number;
  wins: number;
  losses: number;
  qualified?: boolean;
  rank: number | null;
}

/**
 * Public standings screen (M5): humans and agents ranked together, with tab
 * filters — the "one game, two kinds of players" pitch made visible.
 * `you` highlights the signed-in player's own row (matched upstream).
 */
export const drawRanks = (
  ctx: CanvasRenderingContext2D,
  rows: RankRow[] | null, // null = still loading
  tab: number,
  error: string,
  tick: number,
  you?: string,
  seasonRows?: SeasonRow[] | null, // the SEASON tab's board (null = loading)
): void => {
  drawMenuBackdrop(ctx);
  ctx.fillStyle = '#0a0616cc';
  ctx.fillRect(0, 0, VW, VH);

  display(ctx, 'LEADERBOARD', VW / 2, 58, 40, { glow: 'rgba(255,209,102,0.5)' });
  label(ctx, SEASON_LABEL, VW / 2, 80, 12, '#8ad6ffcc');

  // Escape hatch back to the title — phones have no ESC key.
  // (Previously an invisible bottom-left zone; the footer said "TAP HERE"
  // at center so taps missed. Match the select screen's ‹ TITLE button.)
  const backW = 110, backH = 34;
  tapZone(VW - 16 - backW, 12, backW, backH, 'back');
  ctx.fillStyle = 'rgba(10,6,22,0.6)';
  ctx.fillRect(VW - 16 - backW, 12, backW, backH);
  ctx.strokeStyle = 'rgba(255,255,255,0.22)';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(VW - 16 - backW + 0.5, 12.5, backW - 1, backH - 1);
  ctx.lineWidth = 1;
  label(ctx, '‹ TITLE', VW - 16 - backW / 2, 12 + backH / 2 + 4, 12, '#ffffffcc');

  // Tabs — ◄ ► cycles, arcade style. Spacing derives from the count so a
  // new tab never overlaps its neighbours.
  const tabY = 104;
  RANK_TABS.forEach((t, i) => {
    const x = VW / 2 + (i - (RANK_TABS.length - 1) / 2) * 150;
    tapZone(x - 70, tabY - 16, 140, 32, `ranktab:${i}`);
    if (i === tab) {
      const pulse = 1 + 0.04 * Math.sin(tick / 10);
      display(ctx, t, x, tabY, 18, { scale: pulse, glow: 'rgba(255,209,102,0.55)' });
    } else {
      label(ctx, t, x, tabY, 14, '#ffffff66');
    }
  });

  const boxX = VW / 2 - 380, boxW = 760, boxY = 126, boxH = 356;
  bevel(ctx, boxX, boxY, boxW, boxH, PANEL, GOLD, GOLD_DK, 3);

  // Column layout (x offsets inside the box).
  // Re-spaced when TICKETS joined (0021) — everything shifts left to make a
  // column of room on the right without widening the panel.
  const cols = { rank: 36, name: 78, kind: 330, lv: 440, xp: 500, wl: 585, tix: 692 };
  const seasonTab = tab === 3;
  const agentsTab = tab === 2;
  label(ctx, '#', boxX + cols.rank, boxY + 28, 12, GOLD_LT);
  label(ctx, 'FIGHTER', boxX + cols.name + 60, boxY + 28, 12, GOLD_LT);
  label(ctx, 'TYPE', boxX + cols.kind + 24, boxY + 28, 12, GOLD_LT);
  if (seasonTab) {
    // The Elo ladder: rating is THE ranked number here; the right side says
    // whether a fighter holds a rank at all (10 rated matches to qualify).
    label(ctx, 'ELO', boxX + cols.lv + 10, boxY + 28, 12, GOLD_LT);
    label(ctx, 'W — L', boxX + cols.wl - 30, boxY + 28, 12, GOLD_LT);
    label(ctx, 'STATUS', boxX + cols.tix - 10, boxY + 28, 12, GOLD_LT);
  } else if (agentsTab) {
    // The DEFEND record (ADR 0009 step 4) is what agent rank MEANS — how it
    // holds up when humans come for it — so it replaces the grind columns.
    label(ctx, 'LV', boxX + cols.lv, boxY + 28, 12, GOLD_LT);
    label(ctx, 'DEF ELO', boxX + cols.xp + 16, boxY + 28, 12, GOLD_LT);
    label(ctx, 'DEFENSE', boxX + cols.wl + 4, boxY + 28, 12, GOLD_LT);
    label(ctx, 'TICKETS', boxX + cols.tix, boxY + 28, 12, GOLD_LT);
  } else {
    label(ctx, 'LV', boxX + cols.lv, boxY + 28, 12, GOLD_LT);
    label(ctx, 'XP', boxX + cols.xp + 16, boxY + 28, 12, GOLD_LT);
    label(ctx, 'W — L', boxX + cols.wl, boxY + 28, 12, GOLD_LT);
    label(ctx, 'TICKETS', boxX + cols.tix, boxY + 28, 12, GOLD_LT);
  }
  ctx.fillStyle = '#ffffff22';
  ctx.fillRect(boxX + 16, boxY + 38, boxW - 32, 1);

  const activeRows = seasonTab ? seasonRows : rows;
  if (error) {
    label(ctx, `⚠ ${error}`, VW / 2, boxY + boxH / 2, 15, '#ff9d9d');
    label(ctx, 'is the match server running?  npm run server', VW / 2, boxY + boxH / 2 + 26, 12, '#ffffff77');
  } else if (!activeRows) {
    const dots = '.'.repeat(1 + (Math.trunc(tick / 20) % 3));
    label(ctx, `FETCHING STANDINGS${dots}`, VW / 2, boxY + boxH / 2, 15, '#f7e0a3');
  } else if (seasonTab) {
    const srows = seasonRows ?? [];
    if (srows.length === 0) {
      label(ctx, 'NO SEASON MATCHES YET — WIN A WAGER TO START PLACEMENTS', VW / 2, boxY + boxH / 2, 14, '#ffffff88');
    }
    srows.slice(0, 10).forEach((r, i) => {
      const y = boxY + 62 + i * 30;
      const isYou = !!you && r.name === you;
      if (isYou) {
        ctx.fillStyle = '#ffd16622';
        ctx.fillRect(boxX + 12, y - 18, boxW - 24, 26);
      }
      const qualified = r.qualified === true && r.rank != null;
      const medal = r.rank === 1 ? '#ffd166' : r.rank === 2 ? '#cfd8e3' : r.rank === 3 ? '#d9915b' : '#ffffffbb';
      label(ctx, qualified ? String(r.rank) : '—', boxX + cols.rank, y, 15, qualified ? medal : '#ffffff44');
      label(ctx, r.name.slice(0, 22).toUpperCase() + (isYou ? '  (YOU)' : ''), boxX + cols.name, y, 15,
        isYou ? GOLD_LT : qualified ? '#ffffffdd' : '#ffffff88', 'left');
      label(ctx, r.is_agent ? '🤖 AGENT' : 'HUMAN', boxX + cols.kind, y, 12, r.is_agent ? '#8fd0ff' : '#8fe8a0', 'left');
      label(ctx, String(r.elo ?? 1200), boxX + cols.lv + 10, y, 15, qualified ? '#ffe28c' : '#ffffff77');
      label(ctx, `${r.wins} — ${r.losses}`, boxX + cols.wl - 30, y, 13, '#ffffff99');
      label(ctx, qualified ? 'QUALIFIED' : `PLACEMENTS ${Math.min(r.rated ?? 0, 10)}/10`,
        boxX + cols.tix - 10, y, qualified ? 12 : 11, qualified ? '#8fe8a0' : '#ffffff66');
    });
  } else {
    const filtered = rows!.filter((r) =>
      tab === 0 || (tab === 1 ? !r.is_agent : r.is_agent));
    if (filtered.length === 0) {
      label(ctx, 'NO RANKED FIGHTERS YET — WIN A MATCH TO CLAIM #1', VW / 2, boxY + boxH / 2, 14, '#ffffff88');
    }
    filtered.slice(0, 10).forEach((r, i) => {
      const y = boxY + 62 + i * 30;
      const isYou = !!you && r.name === you;
      if (isYou) {
        ctx.fillStyle = '#ffd16622';
        ctx.fillRect(boxX + 12, y - 18, boxW - 24, 26);
      }
      const medal = r.rank === 1 ? '#ffd166' : r.rank === 2 ? '#cfd8e3' : r.rank === 3 ? '#d9915b' : '#ffffffbb';
      label(ctx, String(r.rank), boxX + cols.rank, y, 15, medal);
      label(ctx, r.name.slice(0, 22).toUpperCase() + (isYou ? '  (YOU)' : ''), boxX + cols.name, y, 15, isYou ? GOLD_LT : '#ffffffdd', 'left');
      label(ctx, r.is_agent ? '🤖 AGENT' : 'HUMAN', boxX + cols.kind, y, 12, r.is_agent ? '#8fd0ff' : '#8fe8a0', 'left');
      label(ctx, String(r.level), boxX + cols.lv, y, 15, '#ffffffdd');
      if (agentsTab) {
        // Defend columns (pre-0028 server: dim dashes, not fake zeros).
        const held = r.defend_wins ?? 0;
        const fell = r.defend_losses ?? 0;
        const fresh = r.defend_elo == null || (held === 0 && fell === 0);
        label(ctx, r.defend_elo == null ? '—' : String(r.defend_elo),
          boxX + cols.xp + 16, y, 13, fresh ? '#ffffff44' : '#ffe28c');
        label(ctx, fresh ? 'UNTESTED' : `${held} — ${fell}`,
          boxX + cols.wl + 4, y, fresh ? 11 : 14, fresh ? '#ffffff44' : '#ffffffdd');
      } else {
        label(ctx, String(r.xp), boxX + cols.xp + 16, y, 13, '#ffffff99');
        label(ctx, `${r.wins} — ${r.losses}`, boxX + cols.wl, y, 14, '#ffffffdd');
      }
      // A column of zeros reads as a broken feature, so an empty case is a
      // dim dash. Agent-class fighters can never mint, so theirs stays dashed
      // by construction — that is honest, not a gap.
      const tix = r.tickets ?? 0;
      label(ctx, tix > 0 ? `🎟 ${tix}` : '—', boxX + cols.tix, y,
        tix > 0 ? 14 : 13, tix > 0 ? '#8ad6ff' : '#ffffff44');
    });
  }

  label(ctx, 'TAP  TAB       R  REFRESH       ESC / ‹ TITLE  BACK', VW / 2, VH - 26, 13, '#ffffffaa');
};

// ---------------------------------------------------------------- MY AGENT
/**
 * The in-game face of TRAIN MY AGENT (ADR 0006). Everything here is
 * read-only EXCEPT key minting and the spar entry — coaching itself happens
 * through a Mind (PUT /agent), which is the whole product: the screen shows
 * the observable RESULT of coaching, never an editor (stats are hardcoded,
 * style belongs to the coach conversation).
 */
export interface AgentView {
  /** GET /agent fetch state — 'fail' renders the offline hint. */
  status: 'idle' | 'busy' | 'done' | 'fail';
  /** Owner display name (the agent fights as "<NAME>'S AGENT"). */
  name?: string;
  level?: number;
  wins?: number;
  losses?: number;
  /** The coached config (null = no coach has saved one yet). */
  config?: { character?: string; personality?: Record<string, number>; motto?: string } | null;
  /** Key age — proof a coach connection exists (the key itself is hashed). */
  keyCreatedAt?: string | null;
  /** Roster entry of the coached character — portrait + display name. */
  roster?: Roster;
  /** Fresh plaintext key (shown ONCE). */
  mintedKey?: string;
  /** coach = POST /agent/key on your profile; fighter = POST /agent/signup agent-class. */
  mintedKeyKind?: 'coach' | 'fighter';
  mintBusy?: boolean;
  /** ≥0 → ticks since the key was copied (flips the copy chip green). */
  keyCopiedAge?: number;
  /** Human-readable /connect URL for the Minds hand-off instructions. */
  connectLabel?: string;
}

/** Friendly labels for the six coachable knobs (core AI_PERSONALITY_RANGES). */
const KNOB_LABELS: Record<string, string> = {
  aggression: 'AGGRESSION',
  jumpiness: 'JUMPINESS',
  zoner: 'ZONING',
  throwHappy: 'THROWS',
  pushblocker: 'PUSHBLOCK',
  patience: 'PATIENCE',
};

export const drawAgent = (
  ctx: CanvasRenderingContext2D, tick: number, v: AgentView,
): void => {
  drawMenuBackdrop(ctx);
  ctx.fillStyle = '#0a0616cc';
  ctx.fillRect(0, 0, VW, VH);
  const cx = VW / 2;

  display(ctx, 'MY AGENT', cx, 58, 38, { glow: 'rgba(143,184,255,0.5)' });
  label(ctx, 'IT FIGHTS FOR YOU · COACH IT BY CHATTING WITH A MIND · STATS ARE NEVER EDITABLE', cx, 84, 11, '#ffffff88');

  // Escape hatch — same chip as ranks/select.
  const backW = 110, backH = 34;
  tapZone(VW - 16 - backW, 12, backW, backH, 'back');
  ctx.fillStyle = 'rgba(10,6,22,0.6)';
  ctx.fillRect(VW - 16 - backW, 12, backW, backH);
  ctx.strokeStyle = 'rgba(255,255,255,0.22)';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(VW - 16 - backW + 0.5, 12.5, backW - 1, backH - 1);
  ctx.lineWidth = 1;
  label(ctx, '‹ TITLE', VW - 16 - backW / 2, 12 + backH / 2 + 4, 12, '#ffffffcc');

  const pw = 720, ph = 210, px0 = cx - pw / 2, py0 = 102;
  bevel(ctx, px0, py0, pw, ph, PANEL, GOLD, GOLD_DK, 3);

  if (v.status === 'busy' || v.status === 'idle') {
    const dots = '.'.repeat(1 + (Math.trunc(tick / 20) % 3));
    label(ctx, `FETCHING YOUR AGENT${dots}`, cx, py0 + ph / 2, 15, '#f7e0a3');
  } else if (v.status === 'fail') {
    label(ctx, '⚠ COULD NOT REACH THE MATCH SERVER', cx, py0 + ph / 2 - 10, 15, '#ff9d9d');
    label(ctx, 'your agent lives server-side — try again once you are online', cx, py0 + ph / 2 + 16, 12, '#ffffff77');
  } else if (!v.config) {
    // ---- untrained: the screen IS the onboarding funnel.
    label(ctx, 'NO COACH CONNECTED YET', cx, py0 + 42, 16, GOLD_LT);
    const steps = [
      '1 · MINT YOUR COACH KEY BELOW (shown once — copy it)',
      '2 · IN MINDS: ADD THE KEY UNDER “MY CONNECTIONS”',
      '3 · ENABLE THE “AGENT FIGHTER COACH” SKILL FROM THE BAZAAR',
      '4 · TELL YOUR MIND: “SET UP MY AGENT — AGGRESSIVE RUSHDOWN”',
    ];
    steps.forEach((s, i) => label(ctx, s, cx, py0 + 78 + i * 24, 12, '#ffffffbb'));
    if (v.connectLabel) {
      label(ctx, `NO MINDS ACCOUNT? THE SAME KEY MINTS AT  ${v.connectLabel}`, cx, py0 + ph - 22, 11, '#8fd0ff');
    }
  } else {
    // ---- trained: portrait + identity + record | the six coached knobs.
    const cellX = px0 + 12, cellY = py0 + 12, cellW = 120, cellH = ph - 24;
    ctx.save();
    rrect(ctx, cellX, cellY, cellW, cellH, 6);
    ctx.clip();
    const foot = ctx.createRadialGradient(
      cellX + cellW / 2, cellY + cellH, 8, cellX + cellW / 2, cellY + cellH, cellH);
    foot.addColorStop(0, 'rgba(93,184,255,0.22)');
    foot.addColorStop(1, 'rgba(6,4,12,0.92)');
    ctx.fillStyle = foot;
    ctx.fillRect(cellX, cellY, cellW, cellH);
    const img = v.roster?.portrait;
    if (img?.naturalWidth) {
      const fit = Math.min((cellW - 14) / img.naturalWidth, (cellH - 10) / img.naturalHeight);
      const w = img.naturalWidth * fit, h = img.naturalHeight * fit;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(img, cellX + cellW / 2 - w / 2, cellY + cellH - 5 - h, w, h);
    } else {
      label(ctx, '?', cellX + cellW / 2, cellY + cellH / 2 + 14, 40, '#ffffff33');
    }
    ctx.restore();
    ctx.strokeStyle = 'rgba(93,184,255,0.55)';
    ctx.lineWidth = 1.5;
    rrect(ctx, cellX, cellY, cellW, cellH, 6);
    ctx.stroke();

    const tx = px0 + 150;
    const owner = (v.name ?? 'FIGHTER').toUpperCase();
    display(ctx, `${owner}'S AGENT`, tx, py0 + 40, owner.length > 10 ? 17 : 21, { align: 'left' });
    label(ctx, `MAINS ${(v.roster?.bundle.name ?? v.config.character ?? '?').toUpperCase()}`, tx, py0 + 64, 13, '#8fd0ff', 'left');
    if (v.config.motto) {
      label(ctx, `“${v.config.motto.slice(0, 40)}”`, tx, py0 + 88, 11, '#ffe9a3', 'left');
    }
    label(ctx, `LV ${v.level ?? 1}    ·    ${v.wins ?? 0}W — ${v.losses ?? 0}L  (YOUR RECORD — THE AGENT PLAYS AT YOUR STRENGTH)`, tx, py0 + (v.config.motto ? 112 : 92), 10, '#ffd166', 'left');
    label(ctx,
      v.keyCreatedAt
        ? `COACH KEY ACTIVE SINCE ${v.keyCreatedAt.slice(0, 10)}`
        : 'NO COACH KEY YET — MINT ONE BELOW',
      tx, py0 + ph - 20, 10, v.keyCreatedAt ? '#8fe8a0' : '#ff9db0', 'left');

    // Right column: the coached style, normalized inside each knob's legal
    // range — the bars visualize what the coach last saved, nothing more.
    ctx.fillStyle = 'rgba(217,164,65,0.22)';
    ctx.fillRect(px0 + 432, py0 + 14, 1, ph - 28);
    const sx = px0 + 452, sw = pw - 452 - 18;
    label(ctx, 'COACHED STYLE', sx, py0 + 26, 10, '#c8b98a', 'left');
    Object.entries(AI_PERSONALITY_RANGES).forEach(([key, [lo, hi]], i) => {
      const y = py0 + 44 + i * 27;
      const raw = v.config?.personality?.[key];
      const t = raw === undefined ? 0.5 : Math.max(0, Math.min(1, (raw - lo) / (hi - lo)));
      label(ctx, KNOB_LABELS[key] ?? key.toUpperCase(), sx, y + 9, 10, '#ffffff99', 'left');
      const bx = sx + 92, bw = sw - 92;
      ctx.fillStyle = 'rgba(255,255,255,0.10)';
      ctx.fillRect(bx, y, bw, 12);
      ctx.fillStyle = raw === undefined ? 'rgba(255,255,255,0.25)' : '#e8a24a';
      ctx.fillRect(bx, y, Math.max(3, bw * t), 12);
      ctx.strokeStyle = 'rgba(255,255,255,0.25)';
      ctx.lineWidth = 1;
      ctx.strokeRect(bx + 0.5, y + 0.5, bw - 1, 11);
    });
  }

  // ---- fresh key reveal (mint response, shown exactly once).
  const kb = py0 + ph + 14;
  const fighterKey = v.mintedKeyKind === 'fighter';
  if (v.mintedKey) {
    const kw = 620, kx = cx - kw / 2, kh = 54;
    bevel(ctx, kx, kb, kw, kh, '#101a12', '#7ee85a', '#123018', 3);
    label(ctx, fighterKey
      ? 'AGENT FIGHTER KEY — FOR HEADLESS / FLEET · NEVER SHOWN AGAIN'
      : 'YOUR COACH KEY — COPY IT NOW, IT IS NEVER SHOWN AGAIN', cx, kb + 18, 11, '#8fe8a0');
    const copied = (v.keyCopiedAge ?? -1) >= 0;
    const copiedMsg = fighterKey
      ? '✓ COPIED — AF_AGENT_KEY=…  OR PASTE INTO fleet-agents.json'
      : '✓ COPIED — PASTE IT INTO MINDS › MY CONNECTIONS';
    label(ctx, copied ? copiedMsg : v.mintedKey, cx, kb + 40,
      copied ? 12 : v.mintedKey.length > 44 ? 12 : 14, copied ? '#8fe8a0' : '#eafff0');
    tapZone(kx, kb, kw, kh, 'agent:copykey');
  }

  // ---- CTA row: spar + mint coach key; second row creates an agent-class fighter.
  const bh = 46, by = v.mintedKey ? kb + 68 : kb + 10;
  const canSpar = v.status === 'done' && !!v.config;
  const sparW = 300, mintW = 300, gap = 16;
  const rowX = cx - (sparW + gap + mintW) / 2;
  if (canSpar) {
    const pulse = 1 + 0.03 * Math.sin(tick / 8);
    bevel(ctx, rowX, by, sparW, bh, '#2a1a08', GOLD, GOLD_DK, 3);
    display(ctx, '⚔ SPAR MY AGENT · 1 CR', rowX + sparW / 2, by + 31, 17, { scale: pulse, glow: 'rgba(255,209,102,0.55)' });
  } else {
    bevel(ctx, rowX, by, sparW, bh, '#191a20', '#3f414c', '#101116', 3);
    label(ctx, 'SPAR MY AGENT (COACH FIRST)', rowX + sparW / 2, by + 29, 13, '#ffffff55');
  }
  tapZone(rowX, by, sparW, bh, 'agent:spar');
  const mx = rowX + sparW + gap;
  if (v.mintBusy) {
    bevel(ctx, mx, by, mintW, bh, '#191a20', '#3f414c', '#101116', 3);
    label(ctx, 'MINTING…', mx + mintW / 2, by + 29, 13, '#ffffff88');
  } else {
    bevel(ctx, mx, by, mintW, bh, '#0e2438', '#5db8ff', '#163a5a', 3);
    display(ctx, v.keyCreatedAt || (v.mintedKey && !fighterKey) ? '↻ ROTATE COACH KEY' : '🔑 MINT COACH KEY', mx + mintW / 2, by + 31, 16,
      { from: '#eaf6ff', mid: '#8fd0ff', to: '#3a7ab0', outline: '#0a1a2a' });
  }
  tapZone(mx, by, mintW, bh, 'agent:mint');

  const by2 = by + bh + 12;
  const fightW = sparW + gap + mintW;
  if (v.mintBusy) {
    bevel(ctx, rowX, by2, fightW, bh, '#191a20', '#3f414c', '#101116', 3);
    label(ctx, 'CREATING…', cx, by2 + 29, 13, '#ffffff88');
  } else {
    bevel(ctx, rowX, by2, fightW, bh, '#1a1028', '#c49bff', '#2a1848', 3);
    display(ctx, '🤖 CREATE AGENT FIGHTER · HEADLESS KEY', cx, by2 + 31, 15,
      { from: '#f5eaff', mid: '#c49bff', to: '#6a3a9a', outline: '#140a22' });
  }
  tapZone(rowX, by2, fightW, bh, 'agent:fighter');
  label(ctx, 'CREATES A FREE AGENT-CLASS ACCOUNT YOU OWN · USE THE KEY WITH npm run agent / fleet',
    cx, by2 + bh + 14, 10, '#ffffff66');

  label(ctx, 'S  SPAR       K  COACH KEY       F  AGENT FIGHTER       ESC / ‹ TITLE  BACK', cx, VH - 14, 11, '#ffffff99');
};

// ------------------------------------------------------------ wallet strip
/**
 * The persistent wallet (P0 loop redesign): the same minimal top-left text
 * as the title chip, rendered on every screen where money matters (select,
 * lobby, results). `delta` floats a "+2 CR" / "−1 CR" that drifts up and
 * fades — credits you can watch move feel real.
 */
export interface WalletView {
  credits: number; level: number; wins: number; losses: number;
  /** Unredeemed wager tickets (ADR 0009) — shown only once you hold one. */
  tickets?: number;
}

export const drawWallet = (
  ctx: CanvasRenderingContext2D,
  w: WalletView | null,
  delta: { amt: number; age: number } | null,
): void => {
  if (!w) return;
  // CREDITS emphasized (big, glowing gold); level + record small alongside.
  const cw = drawCredits(ctx, 16, 27, w.credits, 21);
  // Tickets ride alongside the credit balance, but ONLY when you hold one —
  // an always-visible "0 🎟" would read as a currency you are failing at.
  const tix = w.tickets ?? 0;
  let x = 16 + cw + 16;
  if (tix > 0) {
    const txt = `🎟 ${tix}`;
    label(ctx, txt, x, 25, 15, '#8ad6ff', 'left');
    ctx.save();
    ctx.font = '15px "Courier New", monospace';
    x += ctx.measureText(txt).width + 16;
    ctx.restore();
  }
  label(ctx, `LV ${w.level}   ·   ${w.wins}W ${w.losses}L`, x, 25, 12, '#dcd6c8', 'left');
  if (delta && delta.age < 120 && delta.amt !== 0) {
    const t = delta.age / 120;
    ctx.save();
    ctx.globalAlpha = 1 - t * t;
    const up = delta.age * 0.22;
    label(ctx, `${delta.amt > 0 ? '+' : '−'}${Math.abs(delta.amt)} CR`,
      16, 46 - up, 16, delta.amt > 0 ? '#7ee85a' : '#ff6b6b', 'left');
    ctx.restore();
  }
};

// ---------------------------------------------------------------- VS card
/** Deterministic per-index pseudo-random in [0,1) — stable ember layouts. */
const hash01 = (i: number, salt = 0): number => {
  const s = Math.sin(i * 127.1 + salt * 311.7) * 43758.5453;
  return s - Math.floor(s);
};

/** The VS card's fixed portrait frame — the SAME box for every character. */
const VS_FRAME_W = 250;
const VS_FRAME_H = 340;
const VS_FEET_Y = VH - 52; // frame bottom / nameplate baseline
const VS_CX: [number, number] = [188, VW - 188];

/**
 * One fighter on the VS card.
 *  · Authored VS pose (Studio meta.vsPortrait) → COVER-fit into the fixed
 *    frame, so every character fills exactly the same box however its source
 *    art is proportioned. Clipped to a diagonal-cut panel for the classic
 *    VS-screen slash.
 *  · No VS pose → contain-fit the select portrait, bottom-anchored so feet are
 *    never cropped (sizes vary — that's why authoring a VS pose is better).
 */
const drawVsFighter = (
  ctx: CanvasRenderingContext2D, roster: Roster, side: 0 | 1, slide: number, tick: number,
): void => {
  const cx = VS_CX[side] + (side === 0 ? -slide : slide);
  const dir = side === 0 ? 1 : -1;
  const x = cx - VS_FRAME_W / 2;
  const y = VS_FEET_Y - VS_FRAME_H;

  if (roster.vsPortrait) {
    ctx.save();
    // Diagonal-cut panel: the inner edge rakes toward the center like a slash.
    const rake = 26;
    ctx.beginPath();
    if (side === 0) {
      ctx.moveTo(x, y); ctx.lineTo(x + VS_FRAME_W + rake, y);
      ctx.lineTo(x + VS_FRAME_W - rake, y + VS_FRAME_H); ctx.lineTo(x, y + VS_FRAME_H);
    } else {
      ctx.moveTo(x - rake, y); ctx.lineTo(x + VS_FRAME_W, y);
      ctx.lineTo(x + VS_FRAME_W, y + VS_FRAME_H); ctx.lineTo(x + rake, y + VS_FRAME_H);
    }
    ctx.closePath();
    ctx.clip();
    // Backing wash so a transparent pose still reads against the video.
    const g = ctx.createLinearGradient(x, y, x, y + VS_FRAME_H);
    g.addColorStop(0, side === 0 ? '#2a0f14cc' : '#0f1a2acc');
    g.addColorStop(1, '#06040ccc');
    ctx.fillStyle = g;
    ctx.fillRect(x - rake, y, VS_FRAME_W + rake * 2, VS_FRAME_H);
    // The authored pose, mirrored so both fighters face the center.
    ctx.save();
    ctx.translate(cx, 0);
    ctx.scale(dir, 1);
    drawPortrait(ctx, roster, -VS_FRAME_W / 2, y, VS_FRAME_W, VS_FRAME_H, 'vs');
    ctx.restore();
    // Rim light along the raking edge.
    ctx.strokeStyle = side === 0 ? 'rgba(255,120,120,0.5)' : 'rgba(120,190,255,0.5)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    if (side === 0) { ctx.moveTo(x + VS_FRAME_W + rake, y); ctx.lineTo(x + VS_FRAME_W - rake, y + VS_FRAME_H); }
    else { ctx.moveTo(x - rake, y); ctx.lineTo(x + rake, y + VS_FRAME_H); }
    ctx.stroke();
    ctx.restore();
    return;
  }

  // Fallback: contain-fit the select portrait, bottom-anchored (never cropped).
  const img = roster.portrait;
  if (!img?.naturalWidth || !img.naturalHeight) return;
  const fit = Math.min(VS_FRAME_H / img.naturalHeight, (VS_FRAME_W + 20) / img.naturalWidth);
  const w = img.naturalWidth * fit;
  const h = img.naturalHeight * fit;
  ctx.save();
  ctx.translate(cx, VS_FEET_Y + 6 + Math.sin(tick / 40 + side) * 2); // idle bob
  ctx.scale(dir, 1);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(img, -w / 2, -h, w, h);
  ctx.restore();
};

/**
 * Pre-fight stakes card (P0): 2½ seconds of "this is what's on the line" —
 * fighters, names, and the exact credit/XP terms. Doubles as the fight's
 * establishing beat (the 'vs' stinger plays under it). Pure overlay: the
 * caller decides whether the sim runs beneath it.
 *
 * All FX are procedural (no assets): the menu background video, a diagonal
 * red/blue split, converging speed lines, an impact burst behind the VS mark,
 * drifting embers, scanlines and a vignette. Cheap by construction — a few
 * dozen strokes per frame, no per-pixel work.
 */
export const drawVsCard = (
  ctx: CanvasRenderingContext2D,
  rosters: [Roster, Roster],
  names: [string, string],
  stakes: string[], // 1-3 short lines, most important first
  age: number, // ticks since the card appeared — drives pop-in
  levels?: [number | null, number | null], // per-fighter LV chip (null = hide)
): void => {
  const inT = easeOutBack(clamp01(age / 14));
  const wipe = clamp01(age / 18);

  // ---- backdrop: the menu video, heavily darkened so fighters/text pop.
  ctx.save();
  ctx.beginPath(); ctx.rect(0, 0, VW, VH); ctx.clip();
  if (!(bgVideo && drawBgVideoCover(ctx, bgVideo, 0, 0, VW, VH))) {
    ctx.fillStyle = '#0a0616';
    ctx.fillRect(0, 0, VW, VH);
  }
  ctx.restore();
  ctx.fillStyle = `rgba(6,4,12,${0.72 * clamp01(age / 6)})`;
  ctx.fillRect(0, 0, VW, VH);

  // ---- diagonal split: red side / blue side, wiping in from the seam.
  const seamTop = VW * 0.545, seamBot = VW * 0.455;
  const seamX = (t: number): number => seamTop + (seamBot - seamTop) * t; // t: 0 top → 1 bottom
  ctx.save();
  ctx.globalAlpha = 0.5 * wipe;
  ctx.beginPath();
  ctx.moveTo(0, 0); ctx.lineTo(seamTop, 0); ctx.lineTo(seamBot, VH); ctx.lineTo(0, VH);
  ctx.closePath();
  const gl = ctx.createLinearGradient(0, 0, seamTop, VH);
  gl.addColorStop(0, '#00000000'); gl.addColorStop(1, '#8f1f2e88');
  ctx.fillStyle = gl; ctx.fill();
  ctx.beginPath();
  ctx.moveTo(seamTop, 0); ctx.lineTo(VW, 0); ctx.lineTo(VW, VH); ctx.lineTo(seamBot, VH);
  ctx.closePath();
  const gr = ctx.createLinearGradient(VW, 0, seamBot, VH);
  gr.addColorStop(0, '#00000000'); gr.addColorStop(1, '#1f4f8f88');
  ctx.fillStyle = gr; ctx.fill();
  ctx.restore();

  // ---- converging speed lines (each side rakes toward the seam).
  ctx.save();
  ctx.globalAlpha = 0.22 * wipe;
  ctx.lineWidth = 2;
  for (let i = 0; i < 26; i++) {
    const side = i % 2;
    const t = hash01(i, 1);
    const y = t * VH;
    const len = 60 + hash01(i, 2) * 190;
    const drift = ((age * 3 + hash01(i, 3) * 400) % 460) - 60;
    const x0 = side === 0 ? drift : VW - drift;
    ctx.strokeStyle = side === 0 ? '#ff8a9a' : '#8ac6ff';
    ctx.beginPath();
    ctx.moveTo(x0, y);
    ctx.lineTo(x0 + (side === 0 ? len : -len), y);
    ctx.stroke();
  }
  ctx.restore();

  // ---- fighters (behind the seam flash + text).
  const slide = (1 - inT) * 210;
  drawVsFighter(ctx, rosters[0], 0, slide, age);
  drawVsFighter(ctx, rosters[1], 1, slide, age);

  // ---- the seam itself: a bright energy slash with a travelling glint.
  ctx.save();
  ctx.globalAlpha = wipe;
  const seamGrad = ctx.createLinearGradient(seamTop, 0, seamBot, VH);
  seamGrad.addColorStop(0, 'rgba(255,209,102,0)');
  seamGrad.addColorStop(0.5, 'rgba(255,240,200,0.85)');
  seamGrad.addColorStop(1, 'rgba(255,209,102,0)');
  ctx.strokeStyle = seamGrad;
  ctx.lineWidth = 3;
  ctx.shadowColor = 'rgba(255,209,102,0.9)';
  ctx.shadowBlur = 18;
  ctx.beginPath();
  ctx.moveTo(seamTop, -10); ctx.lineTo(seamBot, VH + 10);
  ctx.stroke();
  // Glint sliding down the slash.
  const gt = ((age % 90) / 90);
  ctx.globalAlpha = wipe * (1 - Math.abs(gt - 0.5) * 2) * 0.9;
  ctx.fillStyle = '#fffbe8';
  ctx.beginPath();
  ctx.arc(seamX(gt), gt * VH, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // ---- embers drifting up the frame (stable per-index layout).
  ctx.save();
  for (let i = 0; i < 20; i++) {
    const speed = 0.35 + hash01(i, 4) * 0.5;
    const ey = (VH + 40 - ((age * speed + hash01(i, 5) * VH) % (VH + 80)));
    const ex = hash01(i, 6) * VW + Math.sin((age / 30) + i) * 8;
    const r = 1 + hash01(i, 7) * 2;
    ctx.globalAlpha = 0.5 * wipe * (0.4 + hash01(i, 8) * 0.6);
    ctx.fillStyle = ex < seamX(ey / VH) ? '#ffb08a' : '#8ac6ff';
    ctx.beginPath();
    ctx.arc(ex, ey, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  // ---- impact burst behind the VS mark, once on entry.
  if (age < 34) {
    const bt = age / 34;
    ctx.save();
    ctx.globalAlpha = (1 - bt) * 0.8;
    ctx.strokeStyle = '#ffe9a3';
    ctx.lineWidth = 6 * (1 - bt) + 1;
    ctx.beginPath();
    ctx.arc(VW / 2, 152, 20 + bt * 180, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
  // White slam flash on the first frames.
  if (age < 7) {
    ctx.fillStyle = `rgba(255,255,255,${(1 - age / 7) * 0.5})`;
    ctx.fillRect(0, 0, VW, VH);
  }

  // ---- VS mark: slams in, then breathes.
  const breathe = 1 + 0.02 * Math.sin(age / 12);
  ctx.save();
  ctx.translate(VW / 2, 152);
  ctx.scale(inT * breathe, inT * breathe);
  ctx.translate(-VW / 2, -152);
  display(ctx, 'VS', VW / 2, 168, 96, { glow: 'rgba(255,209,102,0.75)' });
  ctx.restore();

  // ---- terms band: a dark scrim keeps the stakes readable over the art.
  if (stakes.length > 0 && age > 8) {
    const bandA = clamp01((age - 8) / 12);
    const bandY = 208, bandH = 24 + stakes.length * 24;
    ctx.save();
    ctx.globalAlpha = bandA;
    const bg = ctx.createLinearGradient(0, bandY, 0, bandY + bandH);
    bg.addColorStop(0, 'rgba(10,7,20,0.0)');
    bg.addColorStop(0.15, 'rgba(10,7,20,0.85)');
    bg.addColorStop(0.85, 'rgba(10,7,20,0.85)');
    bg.addColorStop(1, 'rgba(10,7,20,0.0)');
    ctx.fillStyle = bg;
    ctx.fillRect(0, bandY, VW, bandH);
    // Gold hairlines top and bottom, drawn from the center out.
    const lineW = VW * bandA;
    ctx.fillStyle = 'rgba(255,209,102,0.55)';
    ctx.fillRect(VW / 2 - lineW / 2, bandY + 6, lineW, 1);
    ctx.fillRect(VW / 2 - lineW / 2, bandY + bandH - 6, lineW, 1);
    stakes.forEach((s, k) => {
      label(ctx, s, VW / 2, bandY + 30 + k * 24, k === 0 ? 17 : 13, k === 0 ? GOLD_LT : '#ffffffaa');
    });
    ctx.restore();
  }

  // ---- nameplates under each fighter.
  ([0, 1] as const).forEach((i) => {
    const nx = VS_CX[i] + (i === 0 ? -slide : slide);
    ctx.save();
    ctx.globalAlpha = inT;
    label(ctx, names[i].toUpperCase().slice(0, 20), nx, VH - 26, 16, i === 0 ? '#8fe8a0' : '#ff9d9d');
    // LV chip: the matchup stat that frames the fight (higher = expected win).
    const lv = levels?.[i];
    if (lv != null) {
      const txt = `LV ${lv}`;
      ctx.font = '700 12px ' + DISPLAY_FONT_STACK;
      const cw = ctx.measureText(txt).width + 16;
      const cy = VH - 12, chH = 15;
      bevel(ctx, nx - cw / 2, cy - chH + 3, cw, chH, '#1a1526e0', GOLD, GOLD_DK, 1);
      label(ctx, txt, nx, cy - 1, 11, GOLD_LT);
    }
    ctx.restore();
  });

  // ---- scanlines + vignette: cheap CRT-ish polish.
  ctx.save();
  ctx.globalAlpha = 0.06;
  ctx.fillStyle = '#000';
  for (let y = 0; y < VH; y += 3) ctx.fillRect(0, y, VW, 1);
  ctx.restore();
  const vig = ctx.createRadialGradient(VW / 2, VH / 2, VH * 0.35, VW / 2, VH / 2, VH * 0.85);
  vig.addColorStop(0, 'rgba(0,0,0,0)');
  vig.addColorStop(1, 'rgba(0,0,0,0.65)');
  ctx.fillStyle = vig;
  ctx.fillRect(0, 0, VW, VH);

  if (age > 40 && age % 50 < 36) {
    label(ctx, 'ANY KEY — FIGHT', VW / 2, VH - 8, 12, '#ffffff77');
  }
};

// ------------------------------------------------------- connection failure
/**
 * Mid-match connection loss (ADR 0005). The sim is frozen behind this — say
 * so plainly, say what it costs, and always offer the way out. Never leave a
 * dead match rendering a live-looking frame with no exit, which reads as a
 * crash.
 */
export const drawNetError = (
  ctx: CanvasRenderingContext2D,
  error: string,
  mode: 'solo' | 'wager' | 'arcade' | 'friendly',
  tick: number,
): void => {
  ctx.fillStyle = 'rgba(6,4,12,0.82)';
  ctx.fillRect(0, 0, VW, VH);

  const boxW = 620, boxH = 190;
  const boxX = VW / 2 - boxW / 2, boxY = VH / 2 - boxH / 2;
  bevel(ctx, boxX, boxY, boxW, boxH, PANEL, '#e94560', '#5a1220', 3);

  const pulse = 1 + 0.03 * Math.sin(tick / 10);
  display(ctx, 'CONNECTION LOST', VW / 2, boxY + 52, 30, {
    scale: pulse, from: '#ffd7d7', mid: '#ff6b6b', to: '#8a1f1f', outline: '#2a0808',
  });
  // Only surface the raw reason when it adds something over the headline.
  const detail = error.trim().toUpperCase();
  if (detail && detail !== 'CONNECTION LOST') {
    label(ctx, detail.slice(0, 60), VW / 2, boxY + 78, 12, '#ffffff77');
  }

  // What happens to the money — the first thing a player wants to know.
  label(ctx, 'THE SERVER SETTLES THIS MATCH FROM ITS OWN RECORD.', VW / 2, boxY + 108, 13, '#ffffffcc');
  label(ctx, mode === 'friendly'
    ? 'FRIENDLY MATCH — NOTHING WAS STAKED, NOTHING IS LOST'
    : mode === 'wager'
      ? 'IF IT WAS ALREADY DECIDED THE RESULT STANDS · OTHERWISE THE POT IS REFUNDED'
      : 'IF IT WAS ALREADY DECIDED THE RESULT STANDS · OTHERWISE YOUR CREDIT IS REFUNDED',
  VW / 2, boxY + 128, 11, '#ffd166');

  if (tick % 60 < 44) {
    label(ctx, 'ENTER / ESC — BACK TO MENU', VW / 2, boxY + 162, 14, GOLD_LT);
  }
  tapZone(boxX, boxY + 140, boxW, 40, 'back');
};

/**
 * Mid-match reconnect banner (ADR 0005): the socket blipped but the server
 * is holding our seat — the session retries by itself. Amber, not red: this
 * is a hiccup, not a verdict.
 */
export const drawReconnecting = (ctx: CanvasRenderingContext2D, tick: number): void => {
  ctx.fillStyle = 'rgba(6,4,12,0.7)';
  ctx.fillRect(0, 0, VW, VH);
  const boxW = 560, boxH = 140;
  const boxX = VW / 2 - boxW / 2, boxY = VH / 2 - boxH / 2;
  bevel(ctx, boxX, boxY, boxW, boxH, PANEL, GOLD, GOLD_DK, 3);
  const dots = '.'.repeat(1 + (Math.trunc(tick / 20) % 3));
  const pulse = 1 + 0.03 * Math.sin(tick / 10);
  display(ctx, `RECONNECTING${dots}`, VW / 2, boxY + 52, 28, { scale: pulse, glow: 'rgba(255,209,102,0.55)' });
  label(ctx, 'CONNECTION HICCUP — YOUR SEAT IS HELD FOR 20 SECONDS', VW / 2, boxY + 84, 13, '#ffffffcc');
  label(ctx, 'ESC — ABANDON (COUNTS AS LEAVING)', VW / 2, boxY + 112, 12, '#ffffff77');
};

/**
 * The OPPONENT dropped and the server is holding their seat (v6). Distinct
 * from drawReconnecting (which is about OUR socket) — here our connection is
 * fine, the peer's isn't, and the rollback sim has frozen on its last known
 * frame. Without this the freeze reads as a crash; with it, it reads as
 * "they bailed, you're about to win." `secsLeft` is the live grace countdown;
 * `friendly` swaps the stakes line (a friendly forfeit costs the quitter
 * nothing but the round).
 */
export const drawOpponentGone = (
  ctx: CanvasRenderingContext2D, secsLeft: number, friendly: boolean, tick: number,
): void => {
  ctx.fillStyle = 'rgba(6,4,12,0.72)';
  ctx.fillRect(0, 0, VW, VH);
  const boxW = 600, boxH = 160;
  const boxX = VW / 2 - boxW / 2, boxY = VH / 2 - boxH / 2;
  bevel(ctx, boxX, boxY, boxW, boxH, PANEL, GOLD, GOLD_DK, 3);
  const dots = '.'.repeat(1 + (Math.trunc(tick / 20) % 3));
  const pulse = 1 + 0.03 * Math.sin(tick / 10);
  display(ctx, 'OPPONENT DISCONNECTED', VW / 2, boxY + 48, 26, { scale: pulse, glow: 'rgba(255,209,102,0.55)' });
  label(ctx, `WAITING FOR THEM TO RECONNECT${dots}`, VW / 2, boxY + 80, 14, '#ffffffcc');
  // The countdown IS the reassurance — a number ticking down beats a frozen frame.
  const s = Math.max(0, Math.ceil(secsLeft));
  display(ctx, `${s}`, VW / 2, boxY + 122, 30, {
    from: '#ffe9a3', mid: '#ffd166', to: '#a5711a', outline: '#2a1c04',
  });
  label(ctx, friendly
    ? "IF THEY DON'T RETURN, THE ROUND IS YOURS — NOTHING WAS STAKED"
    : "IF THEY DON'T RETURN, YOU WIN BY FORFEIT",
  VW / 2, boxY + 146, 11, '#ffd166');
};

// ---------------------------------------------------------------- ARCADE MAP
/**
 * AGENT ARCADE v2 — the gauntlet map screen (ADR 0008).
 *
 * The whole board is revealed from the first frame: this is a PUZZLE, and a
 * puzzle you cannot see is a gamble. All the variance lives in the fights.
 *
 * The screen has exactly one job — make the trade legible. Every pickup on
 * this board has a fighter standing in front of it, so the only question a
 * player ever answers here is "is that pile worth another fight?". The right
 * panel therefore quotes both halves of it: what each route costs, and what
 * each exit is still worth from where they are standing.
 */
export interface MapView {
  board: Board;
  /** Node the run is standing on. */
  at: number;
  fights: number;
  total: number;
  /** UNBANKED pickups — the thing a loss would take away. */
  bag: { credits: number; drinks: number };
  /** Practice/guest run: same board, no stakes, no payouts. */
  practice: boolean;
  /** charId to display name (the roster lookup lives in main.ts). */
  nameOf: (charId: string) => string;
  /** charId to its loaded roster entry — portraits and idle art for the board. */
  rosterOf: (charId: string) => Roster | undefined;
  /** The fighter locked into this run: the token standing on the board. */
  player?: Roster;
  /**
   * The route currently HIGHLIGHTED, or -1. Picking and committing are two
   * separate acts on this screen (the action button commits) — a route costs a
   * fight or ends the run, so it must never be one stray tap away.
   */
  sel: number;
  /** A request is in flight — inputs are disarmed. */
  busy: boolean;
  toast?: string;
}

/** Per-kind piece look. `w`/`h` are the unscaled piece size (see fitScale). */
interface NodeSkin { w: number; h: number; stroke: string; fill: string }
const NODE_SKIN: Record<BoardNodeKind, NodeSkin> = {
  start: { w: 30, h: 26, stroke: '#e9e4f5', fill: '#232037' },
  fight: { w: 34, h: 30, stroke: '#e2564a', fill: '#26141a' },
  gate: { w: 36, h: 31, stroke: '#f0a93b', fill: '#2a1f10' },
  boss: { w: 38, h: 33, stroke: '#ff5d3b', fill: '#2c1410' },
  loot: { w: 24, h: 22, stroke: '#f2c14e', fill: '#2a2210' },
  exit: { w: 32, h: 28, stroke: '#5cb85c', fill: '#12240f' },
};

/** The board plate and the route panel beside it. */
const MAP_PLATE = { x: 16, y: 88, w: 452, h: VH - 88 - 22 };
const MAP_PANEL = { x: 478, y: 88, w: VW - 478 - 14, h: VH - 88 - 22 };

/** A jigsaw edge: +1 = knob sticking out, -1 = socket cut in, 0 = flat. */
interface PieceTabs { n: number; e: number; s: number; w: number }

/**
 * Path a single jigsaw piece centered on (cx, cy). Knobs point at the node's
 * SUCCESSORS and sockets at its PREDECESSORS, so two connected nodes always
 * present a matching knob/socket pair across their connector — the board reads
 * as one interlocking puzzle rather than a scatter of dots, which is exactly
 * what it is (ADR 0008: fully revealed, all variance in the fights).
 */
const puzzlePiece = (
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number, w: number, h: number, tabs: PieceTabs,
): void => {
  const x = cx - w / 2, y = cy - h / 2;
  const r = Math.min(w, h) * 0.18;
  const t = Math.min(w, h) * 0.20; // half-width of the tab neck
  const k = Math.min(w, h) * 0.26; // how far a knob reaches out
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  if (tabs.n !== 0) {
    ctx.lineTo(cx - t, y);
    ctx.bezierCurveTo(cx - t, y - k * tabs.n, cx + t, y - k * tabs.n, cx + t, y);
  }
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  if (tabs.e !== 0) {
    ctx.lineTo(x + w, cy - t);
    ctx.bezierCurveTo(x + w + k * tabs.e, cy - t, x + w + k * tabs.e, cy + t, x + w, cy + t);
  }
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  if (tabs.s !== 0) {
    ctx.lineTo(cx + t, y + h);
    ctx.bezierCurveTo(cx + t, y + h + k * tabs.s, cx - t, y + h + k * tabs.s, cx - t, y + h);
  }
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y, r);
  if (tabs.w !== 0) {
    ctx.lineTo(x, cy + t);
    ctx.bezierCurveTo(x - k * tabs.w, cy + t, x - k * tabs.w, cy - t, x, cy - t);
  }
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
};

/**
 * Faint interlocking lattice behind the board — the "unsolved" half of the
 * puzzle the route is cut out of. Purely decorative, deterministic (hash01),
 * and clipped to the plate.
 */
const drawPuzzleField = (
  ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, cell: number,
): void => {
  const cols = Math.ceil(w / cell), rows = Math.ceil(h / cell);
  const t = cell * 0.13, k = cell * 0.17;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.strokeStyle = 'rgba(255,255,255,0.055)';
  ctx.lineWidth = 1;
  for (let r = 1; r < rows; r++) {
    const ly = y + r * cell;
    ctx.beginPath();
    ctx.moveTo(x, ly);
    for (let c = 0; c < cols; c++) {
      const mid = x + c * cell + cell / 2;
      const dir = hash01(r * 37 + c, 11) > 0.5 ? 1 : -1;
      ctx.lineTo(mid - t, ly);
      ctx.bezierCurveTo(mid - t, ly - k * dir, mid + t, ly - k * dir, mid + t, ly);
      ctx.lineTo(x + (c + 1) * cell, ly);
    }
    ctx.stroke();
  }
  for (let c = 1; c < cols; c++) {
    const lx = x + c * cell;
    ctx.beginPath();
    ctx.moveTo(lx, y);
    for (let r = 0; r < rows; r++) {
      const mid = y + r * cell + cell / 2;
      const dir = hash01(c * 53 + r, 23) > 0.5 ? 1 : -1;
      ctx.lineTo(lx, mid - t);
      ctx.bezierCurveTo(lx - k * dir, mid - t, lx - k * dir, mid + t, lx, mid + t);
      ctx.lineTo(lx, y + (r + 1) * cell);
    }
    ctx.stroke();
  }
  ctx.restore();
};

/** The prize sitting behind a guarded node (its only successor's loot). */
const prizeBehind = (board: Board, n: BoardNode): BoardNode['loot'] | undefined => {
  const behind = successors(board, n.id)
    .map((s) => nodeById(board, s))
    .filter((b): b is BoardNode => !!b);
  return behind.length === 1 ? behind[0]!.loot : undefined;
};

/** What a route row / the action button offers, in one short phrase. */
const routeOffer = (board: Board, n: BoardNode): { text: string; color: string } => {
  if (n.kind === 'exit') {
    return { text: `+${EXIT_BONUS[(n.exitTier ?? 1) as ExitTier]} CR`, color: '#7ee85a' };
  }
  const prize = prizeBehind(board, n);
  return prize?.kind === 'credits' ? { text: `+${prize.amount} CR · 1 FIGHT`, color: '#f2c14e' }
    : prize?.kind === 'drink' ? { text: '+1 DRINK · 1 FIGHT', color: '#4fc4d6' }
      : { text: '1 FIGHT', color: '#ffffff77' };
};

export const drawMap = (ctx: CanvasRenderingContext2D, tick: number, v: MapView): void => {
  drawMenuBackdrop(ctx);
  ctx.fillStyle = 'rgba(6,4,14,0.82)';
  ctx.fillRect(0, 0, VW, VH);

  const { board, at } = v;
  const here = nodeById(board, at);
  const options = successors(board, at)
    .map((id) => nodeById(board, id))
    .filter((n): n is BoardNode => !!n);
  const selNode = options.find((n) => n.id === v.sel) ?? null;

  display(ctx, 'GAUNTLET MAP', 24, 54, 32, { align: 'left', glow: 'rgba(255,209,102,0.45)' });
  label(ctx, v.practice
    ? 'PRACTICE RUN · NO ENTRY · NO REWARDS'
    : `${REGION_NAME[here ? here.region : 1]} · ${v.fights} FIGHT${v.fights === 1 ? '' : 'S'} DEEP`,
  24, 74, 12, '#ffd166cc', 'left');

  // ---- the board -----------------------------------------------------------
  // Its OWN dark plate: without one the menu backdrop art reads straight
  // through the lattice and the routes become unreadable, which is fatal for
  // the one screen whose entire job is legibility.
  const P = MAP_PLATE;
  ctx.save();
  rrect(ctx, P.x, P.y, P.w, P.h, 10);
  ctx.fillStyle = 'rgba(8,5,18,0.88)';
  ctx.fill();
  ctx.restore();

  // Projection: the lattice is 32×32 but a board only ever occupies part of
  // it, so fit the ACTUAL extent to the plate. Pieces are then scaled to the
  // tightest node spacing this particular board produced, which is what keeps
  // every template (some pack loot two rows apart) collision-free.
  const xs = board.nodes.map((n) => n.x);
  const ys = board.nodes.map((n) => n.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  // Asymmetric margins: a wider LEFT gutter for the region spines (so a zone
  // name can never be buried under a piece) and a deeper BOTTOM one for the
  // "YOU" marker under the piece the run is standing on.
  const insetL = 42, insetR = 26, insetT = 26, insetB = 34;
  const sx = (P.w - insetL - insetR) / Math.max(1, maxX - minX);
  const sy = (P.h - insetT - insetB) / Math.max(1, maxY - minY);
  const px = (x: number): number => P.x + insetL + (x - minX) * sx;
  const py = (y: number): number => P.y + insetT + (y - minY) * sy;
  let gap = Infinity;
  for (let i = 0; i < board.nodes.length; i++) {
    for (let j = i + 1; j < board.nodes.length; j++) {
      const a = board.nodes[i]!, b = board.nodes[j]!;
      gap = Math.min(gap, Math.hypot(px(a.x) - px(b.x), py(a.y) - py(b.y)));
    }
  }
  const fit = Math.max(0.6, Math.min(1.1, gap / 40));

  // Region bands (depth at a glance) under the puzzle lattice.
  const bands: [BoardRegion, string][] = [[1, '#e2564a'], [2, '#f0a93b'], [3, '#8b5cf6']];
  ctx.save();
  rrect(ctx, P.x, P.y, P.w, P.h, 10);
  ctx.clip();
  for (const [region, color] of bands) {
    const rys = board.nodes.filter((n) => n.region === region).map((n) => n.y);
    if (rys.length === 0) continue;
    const top = Math.max(P.y, py(Math.min(...rys)) - 18);
    const bot = Math.min(P.y + P.h, py(Math.max(...rys)) + 18);
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.11;
    ctx.fillRect(P.x, top, P.w, bot - top);
    ctx.globalAlpha = 0.5;
    ctx.fillRect(P.x, top, 3, bot - top); // zone spine down the gutter
    ctx.globalAlpha = 1;
    // The zone name runs UP its own spine, in the left gutter no piece uses.
    ctx.save();
    ctx.translate(P.x + 17, (top + bot) / 2);
    ctx.rotate(-Math.PI / 2);
    label(ctx, REGION_NAME[region], 0, 0, 10, `${color}ee`, 'center', false);
    ctx.restore();
  }
  ctx.restore();
  drawPuzzleField(ctx, P.x, P.y, P.w, P.h, 44);
  ctx.save();
  rrect(ctx, P.x + 0.75, P.y + 0.75, P.w - 1.5, P.h - 1.5, 10);
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.restore();

  // Which side of a piece faces a neighbour — knobs out toward successors,
  // sockets in from predecessors. Both ends of an edge derive the side from
  // the same delta, so a knob always lands opposite its socket.
  const tabs = new Map<number, PieceTabs>();
  for (const n of board.nodes) tabs.set(n.id, { n: 0, e: 0, s: 0, w: 0 });
  const setTab = (id: number, dx: number, dy: number, val: number): void => {
    const t = tabs.get(id);
    if (!t) return;
    const side = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'e' : 'w') : (dy > 0 ? 's' : 'n');
    if (t[side] === 0 || val > 0) t[side] = val; // a knob wins a contested side
  };
  for (const [from, to] of board.edges) {
    const a = nodeById(board, from), b = nodeById(board, to);
    if (!a || !b) continue;
    const dx = px(b.x) - px(a.x), dy = py(b.y) - py(a.y);
    setTab(from, dx, dy, 1);
    setTab(to, -dx, -dy, -1);
  }

  // Connectors: a dark channel with a bright core. The routes leaving HERE are
  // lit gold and carry a flowing pulse toward their destination.
  for (const [from, to] of board.edges) {
    const a = nodeById(board, from), b = nodeById(board, to);
    if (!a || !b) continue;
    const live = from === at;
    const ax = px(a.x), ay = py(a.y), bx = px(b.x), by = py(b.y);
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(4,2,10,0.75)';
    ctx.lineWidth = live ? 8 : 5;
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.stroke();
    ctx.strokeStyle = live ? 'rgba(255,209,102,0.9)' : 'rgba(255,255,255,0.24)';
    ctx.lineWidth = live ? 2.6 : 1.5;
    ctx.stroke();
    if (live) {
      // Energy flowing along the offered route — the map's "these are yours".
      const t = ((tick / 46) + (to % 5) * 0.2) % 1;
      const ex = ax + (bx - ax) * t, ey = ay + (by - ay) * t;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = 'rgba(255,229,160,0.85)';
      ctx.beginPath();
      ctx.arc(ex, ey, 2.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    ctx.lineCap = 'butt';
  }

  // Pieces.
  for (const n of board.nodes) {
    const cx = px(n.x), cy = py(n.y);
    const skin = NODE_SKIN[n.kind];
    const isHere = n.id === at;
    const reachable = options.some((o) => o.id === n.id);
    const isSel = selNode?.id === n.id;
    const hot = isHere || reachable;
    const pop = isSel ? 1.16 + 0.03 * Math.sin(tick / 8) : reachable ? 1.06 : 1;
    const w = skin.w * fit * pop, h = skin.h * fit * pop;
    const t = tabs.get(n.id) ?? { n: 0, e: 0, s: 0, w: 0 };
    const guard = n.charId ? v.rosterOf(n.charId) : undefined;

    ctx.save();
    ctx.globalAlpha = hot ? 1 : 0.5;
    // Body: piece fill, then the guard's portrait clipped INTO the piece so
    // every fight on the board wears the face you'd be fighting.
    puzzlePiece(ctx, cx, cy, w, h, t);
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.6)';
    ctx.shadowBlur = 6;
    ctx.shadowOffsetY = 2;
    ctx.fillStyle = skin.fill;
    ctx.fill();
    ctx.restore();
    if (guard?.portrait) {
      ctx.save();
      ctx.clip();
      ctx.globalAlpha = (hot ? 1 : 0.5) * (isHere ? 0.45 : 0.95);
      drawPortrait(ctx, guard, cx - w / 2, cy - h / 2, w, h);
      // Darken the lower third so the kind badge stays readable on any art.
      const gsh = ctx.createLinearGradient(0, cy, 0, cy + h / 2);
      gsh.addColorStop(0, 'rgba(6,4,12,0)');
      gsh.addColorStop(1, 'rgba(6,4,12,0.75)');
      ctx.fillStyle = gsh;
      ctx.fillRect(cx - w / 2, cy, w, h / 2);
      ctx.restore();
    }
    // Rim.
    puzzlePiece(ctx, cx, cy, w, h, t);
    ctx.save();
    ctx.strokeStyle = skin.stroke;
    ctx.lineWidth = reachable || isHere ? 2.2 : 1.3;
    if (reachable) { ctx.shadowColor = skin.stroke; ctx.shadowBlur = 6 + 4 * fxPulse(tick, 0.1); }
    ctx.stroke();
    ctx.restore();

    // Face: what this piece IS.
    if (n.loot?.kind === 'credits') {
      label(ctx, `${n.loot.amount}`, cx, cy + h * 0.16, 11 * fit, '#ffe28c', 'center', true);
    } else if (n.loot?.kind === 'drink') {
      label(ctx, '▯', cx, cy + h * 0.18, 13 * fit, '#4fc4d6', 'center', true);
    } else if (n.kind === 'exit') {
      label(ctx, 'EXIT', cx, cy - h * 0.02, 9 * fit, '#c9ffc9', 'center', true);
      label(ctx, `${n.exitTier ?? 1}`, cx, cy + h * 0.34, 12 * fit, '#7ee85a', 'center', true);
    } else if (n.kind === 'boss') {
      label(ctx, '☠ BOSS', cx, cy + h * 0.40, 9 * fit, '#ffc9b4', 'center', true);
    } else if (n.kind === 'gate') {
      label(ctx, 'GATE', cx, cy + h * 0.40, 8.5 * fit, '#ffd9a0', 'center', true);
    } else if (n.kind === 'start') {
      label(ctx, 'START', cx, cy + h * 0.16, 9 * fit, '#e9e4f5', 'center', true);
    }
    ctx.restore();

    if (isSel) {
      marchingOutline(ctx, cx - w / 2 - 5, cy - h / 2 - 5, w + 10, h + 10, tick, GOLD_LT, 9, 0.85);
      // Name the fighter you just chose, right where you chose them — ABOVE
      // the piece, because below it is where the player token stands.
      // A cast node names its STABLE guard (ADR 0009): the same rival the
      // nameplate and match record will bill as.
      const who = n.kind === 'exit' ? 'EXTRACTION POINT'
        : n.agent ? `${n.agent.name.toUpperCase()} · LV${n.agent.level}`.slice(0, 24)
          : v.nameOf(n.charId ?? '').toUpperCase().slice(0, 16);
      label(ctx, who, cx, cy - h / 2 - 12, 11, GOLD_LT, 'center', true);
    }
    // The whole piece is the tap target for reachable routes.
    if (reachable && !v.busy) {
      tapZone(cx - w / 2 - 6, cy - h / 2 - 6, w + 12, h + 12, `map:sel:${n.id}`);
    }
  }

  // YOU ARE HERE: the run's own fighter, idling ON the piece it stands on.
  // Feet sit on the piece's lower edge and the figure is kept short enough
  // that its head never reaches the next piece up (verified against every
  // template's tightest spacing).
  if (here) {
    const cx = px(here.x), cy = py(here.y);
    const skin = NODE_SKIN[here.kind];
    const footY = cy + (skin.h * fit) / 2;
    const bob = Math.sin(tick / 22) * 1.5;
    // Ground marker: a shadow plus a breathing ring AT THE FEET, so the
    // fighter reads as standing on the board rather than caged in a circle.
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.beginPath();
    ctx.ellipse(cx, footY, 13 * fit, 4.5 * fit, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.ellipse(cx, footY, (15 + Math.sin(tick / 7) * 1.5) * fit, 5.2 * fit, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
    const drawn = v.player
      ? drawIdleSprite(ctx, v.player, tick, cx, footY + bob, 40 * fit, 0.97)
      : false;
    if (!drawn && v.player) {
      // No atlas art for this fighter: a portrait medallion still says "you".
      const s = 26 * fit;
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, footY - s / 2 + bob, s / 2, 0, Math.PI * 2);
      ctx.clip();
      drawPortrait(ctx, v.player, cx - s / 2, footY - s + bob, s, s);
      ctx.restore();
      ctx.strokeStyle = '#ffffffaa';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(cx, footY - s / 2 + bob, s / 2, 0, Math.PI * 2);
      ctx.stroke();
    }
    label(ctx, 'YOU', cx, footY + 13, 10, '#ffffffcc', 'center', true);
  }

  // ---- the panel -----------------------------------------------------------
  const N = MAP_PANEL;
  ctx.save();
  rrect(ctx, N.x, N.y, N.w, N.h, 10);
  ctx.fillStyle = 'rgba(10,6,22,0.72)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.16)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.restore();
  const inX = N.x + 16;
  const inW = N.w - 32;
  const rule = (ry: number): void => {
    ctx.strokeStyle = 'rgba(255,255,255,0.10)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(inX, ry);
    ctx.lineTo(inX + inW, ry);
    ctx.stroke();
  };

  // CARRYING — the thing a loss would take away.
  label(ctx, 'CARRYING', inX, 112, 12, '#ffffff88', 'left');
  const bagText = `${v.bag.credits} CR`
    + (v.bag.drinks > 0 ? `  ·  ${v.bag.drinks} DRINK${v.bag.drinks === 1 ? '' : 'S'}` : '');
  label(ctx, bagText, inX + inW, 112, 16, v.bag.credits > 0 ? '#f2c14e' : '#ffffff55', 'right');
  label(ctx, v.bag.credits + v.bag.drinks > 0
    ? 'LOSE A FIGHT AND THIS IS GONE'
    : 'NOTHING TO LOSE YET',
  inX, 128, 10, '#ff9d9d', 'left');
  rule(138);

  // EXITS FROM HERE — the greed/speed decision, priced, from where you stand.
  label(ctx, 'EXITS FROM HERE', inX, 156, 12, '#ffffff88', 'left');
  const routes = exitRoutes(board, at);
  const colW = inW / 3;
  routes.forEach(({ node, route }, k) => {
    const cxc = inX + colW * k + colW / 2;
    const tier = (node.exitTier ?? 1) as ExitTier;
    const gone = !route.reachable;
    label(ctx, `EXIT ${tier}`, cxc, 176, 12, gone ? '#ffffff33' : '#7ee85a', 'center');
    label(ctx, gone ? 'ROUTED PAST' : `${route.fights} FIGHT${route.fights === 1 ? '' : 'S'}`,
      cxc, 191, 11, gone ? '#ffffff33' : '#ffffffcc', 'center');
    label(ctx, `+${EXIT_BONUS[tier]} CR`, cxc, 207, 13, gone ? '#ffffff33' : '#f2c14e', 'center');
  });
  rule(218);

  // YOUR MOVE — one row per legal route. Selecting is free; the action button
  // below is the only thing that spends a fight.
  label(ctx, 'YOUR MOVE', inX, 238, 12, '#ffffff88', 'left');
  const rowH = 30;
  options.forEach((n, k) => {
    const rowY = 244 + k * rowH;
    const on = n.id === v.sel;
    ctx.save();
    rrect(ctx, inX, rowY, inW, rowH - 4, 6);
    ctx.fillStyle = on ? 'rgba(255,209,102,0.16)' : 'rgba(255,255,255,0.05)';
    ctx.fill();
    if (on) {
      ctx.strokeStyle = GOLD_LT;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    ctx.restore();
    if (!v.busy) tapZone(inX, rowY, inW, rowH - 4, `map:sel:${n.id}`);

    // Thumbnail: the guard's face, or the exit's mark.
    const th = rowH - 12;
    const tx = inX + 8, ty = rowY + 4;
    const guard = n.charId ? v.rosterOf(n.charId) : undefined;
    ctx.save();
    rrect(ctx, tx, ty, th, th, 4);
    ctx.fillStyle = n.kind === 'exit' ? '#12240f' : '#0c0a14';
    ctx.fill();
    ctx.save();
    ctx.clip();
    if (guard) drawPortrait(ctx, guard, tx, ty, th, th);
    ctx.restore();
    ctx.strokeStyle = NODE_SKIN[n.kind].stroke;
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.restore();
    if (n.kind === 'exit') label(ctx, '↥', tx + th / 2, ty + th - 5, 15, '#7ee85a', 'center', true);

    const labelX = tx + th + 10;
    const who = n.kind === 'exit' ? `EXTRACT · EXIT ${n.exitTier ?? 1}`
      : (n.agent?.name ?? v.nameOf(n.charId ?? '')).toUpperCase().slice(0, 16);
    const kindTag = n.kind === 'boss' ? 'BOSS' : n.kind === 'gate' ? 'GATE' : '';
    label(ctx, `${k + 1}`, labelX, rowY + 19, 12, on ? GOLD_LT : '#ffffff66', 'left', false);
    label(ctx, who, labelX + 14, rowY + 19, 13, on ? '#ffffff' : '#ffffffdd', 'left', true);
    if (kindTag) {
      ctx.font = `13px ${DISPLAY_FONT_STACK}`;
      const wWidth = ctx.measureText(who).width;
      label(ctx, kindTag, labelX + 20 + wWidth, rowY + 19, 9,
        n.kind === 'boss' ? '#ff9d7a' : '#ffd9a0', 'left', false);
    }
    const offer = routeOffer(board, n);
    label(ctx, offer.text, inX + inW - 10, rowY + 19, 12, offer.color, 'right', false);
  });
  if (options.length === 0) {
    label(ctx, 'NO ROUTES LEFT — THIS RUN IS OVER', inX, 264, 12, '#ff9d9d', 'left');
  }

  // NEXT UP — the dossier on the highlighted fighter, in whatever room the
  // route list left behind. A short list leaves a hole; this fills it with the
  // one thing a player still wants before committing: who that is.
  const rowsEnd = 244 + options.length * rowH;
  const nextUp = selNode && selNode.kind !== 'exit' && selNode.charId
    ? v.rosterOf(selNode.charId) : undefined;
  if (nextUp && 368 - rowsEnd >= 50) {
    const cardY2 = rowsEnd + 8;
    const cardH2 = Math.min(74, 368 - cardY2 - 10);
    const st = styleInfo(nextUp);
    ctx.save();
    rrect(ctx, inX, cardY2, inW, cardH2, 8);
    ctx.fillStyle = 'rgba(255,255,255,0.045)';
    ctx.fill();
    ctx.strokeStyle = st.color + '55';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
    const pS = cardH2 - 16;
    ctx.save();
    rrect(ctx, inX + 8, cardY2 + 8, pS, pS, 6);
    ctx.clip();
    drawPortrait(ctx, nextUp, inX + 8, cardY2 + 8, pS, pS);
    ctx.restore();
    const tX = inX + 8 + pS + 12;
    const tW = inW - (tX - inX) - 10;
    // Deliberately identity-only (no bio): the full dossier is the select
    // screen's job, and a variable-height block here would fight the button
    // anchored below it.
    // A cast node headlines its STABLE guard (ADR 0009) — a real coached
    // agent with a record and a motto — over the character it pilots.
    const mid = cardY2 + cardH2 / 2;
    const guardId = selNode?.agent;
    label(ctx, guardId ? 'GUARDED BY' : 'NEXT UP', tX, mid - 14, 9, '#ffffff77', 'left', false);
    display(ctx, (guardId?.name ?? nextUp.bundle.name).toUpperCase().slice(0, 16), tX, mid + 6, 18, {
      align: 'left', glow: st.color + '99', glowBlur: 10,
    });
    const sub = guardId
      ? `LV${guardId.level} · ${guardId.wins}-${guardId.losses}`
        + (guardId.motto ? `  ·  “${guardId.motto}”` : `  ·  ${st.label}`)
      : `${st.label}  ·  ${st.tag}`;
    const styleTxt = wrapLines(ctx, sub, tW, 9.5, 1)[0] ?? st.label;
    label(ctx, styleTxt, tX, mid + 19, 9.5, st.color, 'left', false);
  }

  // ---- ACTION BUTTON -------------------------------------------------------
  // Bottom-anchored so it never moves with the route count: the one control
  // that commits, always in the same place under the thumb.
  const btnY = 368, btnH = 52;
  const extract = selNode?.kind === 'exit';
  const armed = !!selNode && !v.busy;
  const accent = extract ? '#5cb85c' : '#e2564a';
  const btnPulse = fxPulse(tick, 0.09);
  ctx.save();
  if (armed) {
    ctx.shadowColor = accent;
    ctx.shadowBlur = 12 + 8 * btnPulse;
  }
  const gb = ctx.createLinearGradient(0, btnY, 0, btnY + btnH);
  gb.addColorStop(0, armed ? tintHex(accent, 10) : '#20202c');
  gb.addColorStop(1, armed ? tintHex(accent, -78) : '#131320');
  rrect(ctx, inX, btnY, inW, btnH, 9);
  ctx.fillStyle = gb;
  ctx.fill();
  ctx.restore();
  ctx.save();
  rrect(ctx, inX + 1, btnY + 1, inW - 2, btnH - 2, 8);
  ctx.strokeStyle = armed ? tintHex(accent, 95) : '#ffffff22';
  ctx.lineWidth = 1.6;
  ctx.stroke();
  ctx.restore();

  if (selNode) {
    // The opponent you are about to meet, idling inside the button — the
    // screen's hand-off to the VS card.
    const guard = selNode.charId ? v.rosterOf(selNode.charId) : undefined;
    if (guard) {
      ctx.save();
      rrect(ctx, inX + 4, btnY + 4, btnH - 8, btnH - 8, 7);
      ctx.clip();
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.fillRect(inX + 4, btnY + 4, btnH - 8, btnH - 8);
      if (!drawIdleSprite(ctx, guard, tick, inX + 4 + (btnH - 8) / 2,
        btnY + btnH - 6 + Math.sin(tick / 20) * 1.5, btnH - 10)) {
        drawPortrait(ctx, guard, inX + 4, btnY + 4, btnH - 8, btnH - 8);
      }
      ctx.restore();
    }
    // Centred on the BUTTON, not on the strip left over beside the portrait.
    // Centring in the remainder pushed the label half the portrait's width
    // (~29px) right of the button's midline, which reads as a misalignment
    // because the portrait is a 44px badge pinned to the edge — it never looked
    // like a column claiming its own half. The badge sits ~150px clear of even
    // the longest verb ("BREAK THE GATE") at this width, so there is nothing to
    // collide with.
    const actX = inX + inW / 2;
    const verb = extract ? 'EXTRACT'
      : selNode.kind === 'boss' ? 'FIGHT THE BOSS'
        : selNode.kind === 'gate' ? 'BREAK THE GATE'
          : 'FIGHT NOW';
    display(ctx, verb, actX, btnY + 28, 24, {
      scale: 1 + 0.02 * btnPulse,
      ...(extract ? { from: '#eaffe6', mid: '#7ee85a', to: '#2e7a39' } : {}),
    });
    const offer = routeOffer(board, selNode);
    label(ctx, extract ? `BANK ${v.bag.credits} CR  ·  ${offer.text} BONUS` : offer.text,
      actX, btnY + 44, 12, '#ffffffcc', 'center', true);
    if (!v.busy) tapZone(inX, btnY, inW, btnH, 'map:act');
  } else {
    label(ctx, options.length === 0 ? 'NO ROUTES LEFT' : 'CHOOSE A ROUTE',
      inX + inW / 2, btnY + 34, 16, '#ffffff66', 'center', true);
  }
  rule(btnY + btnH + 12);

  // ---- THE GAUNTLET --------------------------------------------------------
  // The mode's rules, moved off the character-select screen to the place the
  // decision they describe is actually made. Every claim is derived from the
  // shipped constants (EXIT_FIGHT_FLOOR / EXIT_BONUS), never re-typed — the
  // old copy outlived its ruleset once already.
  const floors = ([1, 2, 3] as const).map((t) => EXIT_FIGHT_FLOOR[t]).join(' / ');
  label(ctx, 'THE GAUNTLET', inX, btnY + btnH + 30, 12, '#ffffff88', 'left');
  label(ctx, 'ONE BOARD · PICK YOUR ROUTE AFTER EVERY WIN',
    inX + inW, btnY + btnH + 30, 10, '#ffd166aa', 'right');
  const lines: [string, string][] = [
    ['WINS PAY XP — THE BOARD PAYS CREDITS', '#8fd0ff'],
    ['EVERY PICKUP COSTS ONE EXTRA FIGHT', '#ffffffcc'],
    ['EXTRACT TO BANK THE BAG — LOSE OR QUIT AND IT IS GONE', '#ff9d9d'],
    [v.practice
      ? 'PRACTICE RUN · NOTHING BANKS · SIGN IN TO PLAY FOR CREDITS'
      : `EXITS SIT ${floors} FIGHTS DEEP · DEEPER PAYS MORE`, '#ffffff99'],
  ];
  lines.forEach(([txt, col], k) => label(ctx, txt, inX, btnY + btnH + 44 + k * 13, 11, col, 'left'));

  if (v.busy) label(ctx, 'WORKING…', N.x + N.w / 2, VH - 30, 13, '#ffd166');
  if (v.toast) label(ctx, v.toast.slice(0, 46), P.x + P.w / 2, VH - 30, 12, '#ffd166');
  label(ctx, '1-4 / TAP  CHOOSE A ROUTE      ENTER  GO      ESC  ABANDON THE RUN',
    24, VH - 8, 11, '#ffffff66', 'left');
};

/**
 * Post-extraction summary — the payoff for the only action in the mode that
 * turns a bag into money. Also the honest place to show a diminishing-returns
 * haircut, rather than letting a player wonder why the board said 30 and the
 * wallet said 22.
 */
export interface ExtractView {
  exitTier: number;
  bonus: number;
  bag: number;
  granted: number;
  multiplierPct: number;
  drinks: number;
  drinksLeftBehind: number;
  fights: number;
  practice: boolean;
}

export const drawExtract = (ctx: CanvasRenderingContext2D, tick: number, v: ExtractView): void => {
  drawMenuBackdrop(ctx);
  ctx.fillStyle = 'rgba(4,10,6,0.84)';
  ctx.fillRect(0, 0, VW, VH);
  const cx = VW / 2;

  display(ctx, 'EXTRACTED', cx, 150, 64, {
    from: '#e8ffe6', mid: '#7ee85a', to: '#2e7a39', glow: 'rgba(126,232,90,0.45)',
  });
  label(ctx, `EXIT ${v.exitTier} · ${v.fights} FIGHT${v.fights === 1 ? '' : 'S'} SURVIVED`,
    cx, 178, 14, '#ffffffcc');

  // The receipt gets its own plate. This is the one screen where a player
  // checks arithmetic against what the board promised — the backdrop art
  // reads straight through otherwise and the numbers stop being numbers.
  const rows = 2
    + (!v.practice && v.multiplierPct < 100 ? 1 : 0)
    + (v.drinks > 0 ? 1 : 0)
    + (v.drinksLeftBehind > 0 ? 1 : 0);
  const plateH = 26 * rows + 62;
  ctx.fillStyle = 'rgba(6,12,8,0.88)';
  ctx.fillRect(cx - 214, 208, 428, plateH);
  ctx.strokeStyle = 'rgba(126,232,90,0.28)';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(cx - 213.5, 208.5, 427, plateH - 1);

  let y = 236;
  const row = (k: string, val: string, color = '#ffffffdd'): void => {
    label(ctx, k, cx - 190, y, 14, '#ffffff88', 'left');
    label(ctx, val, cx + 190, y, 16, color, 'right');
    y += 26;
  };
  // Order matters: the rate sits DIRECTLY under the line it multiplies, so
  // nobody has to guess whether their exit bonus got taxed. (It never does.)
  row('PICKED UP', `${v.bag} CR`);
  if (!v.practice && v.multiplierPct < 100) {
    row("TODAY'S RATE · LOOT ONLY", `x${v.multiplierPct}%`, '#ffd166');
  }
  row(`EXIT ${v.exitTier} BONUS`, `+${v.bonus} CR`, '#7ee85a');
  if (v.drinks > 0) row('DRINKS BANKED', `${v.drinks}`, '#4fc4d6');
  if (v.drinksLeftBehind > 0) row('OVER DAILY DRINK CAP', `${v.drinksLeftBehind} LOST`, '#ff9d9d');

  y += 8;
  ctx.strokeStyle = 'rgba(255,255,255,0.2)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(cx - 190, y - 18);
  ctx.lineTo(cx + 190, y - 18);
  ctx.stroke();
  label(ctx, v.practice ? 'PRACTICE — NOTHING BANKED' : 'BANKED', cx - 190, y, 15, '#ffffff', 'left');
  label(ctx, v.practice ? '0 CR' : `+${v.granted} CR`, cx + 190, y, 26,
    v.practice ? '#ffffff55' : '#7ee85a', 'right');

  label(ctx, 'TAP / ENTER: TITLE', cx, VH - 40, 13,
    `rgba(255,255,255,${0.55 + Math.sin(tick / 10) * 0.25})`);
  tapZone(0, 0, VW, VH, 'start');
};
