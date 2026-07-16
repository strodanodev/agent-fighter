import { STAGE, TICKS_PER_SEC, TUNING } from '@af/core';
import type { GameState } from '@af/core';
import { drawPortrait } from './atlas.js';
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
 * HUD layout (rows, top-down): health bar · nameplate · pips+meter.
 * Asset sizes derive from the SVG kit geometry (HUD_GEO), scaled to fit the
 * 960px frame: portrait(92) · bar(328) · timer(96) · bar · portrait.
 */
const HUD = {
  edge: 108, // inner start of the bars (portraits live outside this)
  barW: 328,
  barH: 38,
  barY: 12,
  nameW: 226,
  nameH: 25,
  nameY: 56,
  pipY: 90,
  meterY: 88,
  meterSegW: 102,
  meterSegH: 15,
} as const;

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
  const s = 92;
  const x = i === 0 ? 8 : VW - 8 - s;
  const y = 8;
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

const drawRoundPips = (ctx: CanvasRenderingContext2D, i: 0 | 1, wins: number): void => {
  const need = TUNING.roundsToWin;
  const g = HUD_GEO.pip;
  const gap = 7;
  // Sits just inside the nameplate's outer end.
  for (let r = 0; r < need; r++) {
    const x = i === 0
      ? HUD.edge + HUD.nameW + 14 + r * (g.w + gap)
      : VW - HUD.edge - HUD.nameW - 14 - g.w - r * (g.w + gap);
    const on = r < wins;
    if (uiKit?.pipOn && uiKit.pipOff) {
      drawChrome(ctx, on ? uiKit.pipOn : uiKit.pipOff, x, HUD.pipY, g.w, g.h, i === 1);
    } else {
      bevel(ctx, x, HUD.pipY, 14, 14, on ? GOLD : '#191524', on ? GOLD_LT : '#4a4260', GOLD_DK, 1);
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
const drawGameLogo = (ctx: CanvasRenderingContext2D, cx: number, topY: number, tick: number): void => {
  if (!gameLogoImg || gameLogoImg.naturalWidth === 0) return;
  const box = gameLogoBBox ?? { x: 0, y: 0, w: gameLogoImg.naturalWidth, h: gameLogoImg.naturalHeight };
  const BASE_W = 100; // natural badge width before the size adjustments below
  const w = BASE_W * 0.7 * 2.5;
  const h = w * (box.h / box.w);
  const breathe = fxPulse(tick, 0.045, 0.96, 1.06); // slow "alive" scale

  ctx.save();
  ctx.translate(cx, topY);
  ctx.scale(breathe, breathe);
  ctx.imageSmoothingEnabled = true;
  // Pulses between near-white and light blue rather than a fixed hue.
  const glowMix = fxPulse(tick, 0.07); // 0..1
  const gr = Math.round(210 + 40 * glowMix), gg = Math.round(235 + 15 * glowMix), gb = 255;
  ctx.shadowColor = `rgba(${gr},${gg},${gb},${0.55 + 0.35 * fxPulse(tick, 0.09)})`;
  ctx.shadowBlur = 14 + 10 * fxPulse(tick, 0.09);
  // Two passes: the shadow builds a real halo around the artwork's own
  // silhouette without a second draw looking like a ghost/double-image.
  ctx.drawImage(gameLogoImg, box.x, box.y, box.w, box.h, -w / 2, 0, w, h);
  ctx.drawImage(gameLogoImg, box.x, box.y, box.w, box.h, -w / 2, 0, w, h);
  ctx.restore();
};

export interface HudFx {
  flash: [number, number]; // lagging health ratio per player (damage flash)
  comboOwner: number; // -1 none
  comboHits: number;
  comboAge: number; // ticks since comboOwner last went from none → set (drives the pop-in)
  announce: string;
  announceAge: number;
}

export const drawHud = (
  ctx: CanvasRenderingContext2D,
  g: GameState,
  rosters: [Roster, Roster],
  fx: HudFx,
  tags?: [string, string], // per-player nameplate suffix (e.g. "AGENT LV 12")
): void => {
  for (const i of [0, 1] as const) {
    const f = g.fighters[i];
    const max = rosters[i].ch.b.maxHealth;
    const ratio = Math.max(0, f.health) / max;
    drawHealthBar(ctx, i, ratio, fx.flash[i], g.tick);
    drawPortraitFrame(ctx, i, rosters[i], ratio < 0.25);
    drawNameplate(ctx, i, rosters[i].bundle.name + (tags?.[i] ? ` · ${tags[i]}` : ''));
    drawRoundPips(ctx, i, i === 0 ? g.roundsWon0 : g.roundsWon1);
    drawMeter(ctx, i, f.meter, g.tick);
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
  drawGameLogo(ctx, VW / 2, 70, g.tick);

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
  /** Sign-in required (M5): menu locked until the player authenticates. */
  gate?: boolean;
  /** Smart-account address (upper-left wallet line). */
  address?: string;
  /** Server account snapshot — credits/level/W-L (null = server offline). */
  account?: { credits: number; level: number; wins: number; losses: number } | null;
  /** Animate the "+10 DAILY CREDITS" toast. */
  dailyToast?: boolean;
  /** Remembered fighter (quick match) — shown as "FIGHTING AS …". */
  fighter?: string;
}

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
  // the logo file gets swapped for different art later. No opaque panel
  // behind it (by design): the key art / video backdrop shows through, and
  // display()/label() already carry their own outline+glow for contrast.
  const barH = 178, barY = VH - barH;

  const menuY0 = barY + 30;
  if (menu.gate) {
    // M5: signing in is REQUIRED — the AIR account is the wallet the whole
    // credits economy settles into, so there is nothing to enter as a ghost.
    const pulse = 1 + 0.04 * Math.sin(tick / 9);
    if (menu.authBusy) {
      display(ctx, 'SIGNING IN…', cx, menuY0 + 18, 26, { glow: 'rgba(143,184,255,0.55)' });
      label(ctx, 'complete the AIR dialog to continue', cx, menuY0 + 48, 13, '#ffffffaa');
    } else {
      display(ctx, 'SIGN IN TO ENTER', cx, menuY0 + 18, 28, { scale: pulse, glow: 'rgba(255,209,102,0.55)' });
      label(ctx, 'TAP / PRESS  L  ·  AIR ACCOUNT (GOOGLE / EMAIL / WALLET)', cx, menuY0 + 48, 14, '#ffd166');
      label(ctx, '10 FREE CREDITS EVERY DAY YOU LOG IN   ·   R: RANKINGS', cx, menuY0 + 70, 12, '#ffffff88');
      // The gate is mandatory and phones have no `L` key — the sign-in
      // headline itself has to be tappable or mobile can never get in.
      tapZone(cx - 260, menuY0 - 4, 520, 60, 'signin');
      tapZone(cx - 260, menuY0 + 60, 520, 22, 'ranks');
    }
    if (menu.authError) label(ctx, `⚠ ${menu.authError.slice(0, 64)}`, cx, menuY0 + 92, 12, '#ff9d9d');
  } else {
    // 2-player local is disabled (single-controller / mobile focus) — omitted.
    const rows: [Mode, string][] = [
      ['cpu', 'VS AGENT  ·  RANKED  ·  1 CREDIT'],
      ['online', 'ONLINE WAGER  ·  10 CREDITS  ·  WINNER TAKES POT'],
    ];
    rows.forEach(([m, txt], k) => {
      const y = menuY0 + k * 34;
      const on = menu.mode === m;
      tapZone(cx - 260, y - 17, 520, 34, `mode:${m}`);
      if (on) {
        const pulse = 1 + 0.035 * Math.sin(tick / 10);
        display(ctx, txt, cx, y, 22, { scale: pulse, glow: 'rgba(255,209,102,0.55)' });
        // A small bouncing arrow marker to the left, arcade-menu style.
        const bounce = 3 * Math.sin(tick / 9);
        label(ctx, '▶', cx - 236 + bounce, y, 18, GOLD_LT);
      } else {
        label(ctx, txt, cx, y, 16, '#ffffff70');
      }
    });
    const hintY = menuY0 + rows.length * 34 + 6;
    // Quick match (P0): ENTER launches with the remembered fighter — the
    // select screen is the C detour, not a toll booth on every match.
    if (menu.fighter) {
      label(ctx, `FIGHTING AS  ${menu.fighter.toUpperCase()}   ·   C  CHANGE FIGHTER`, cx, hintY, 12, '#8fd0ff');
    }
    label(ctx, 'TAP / ENTER  QUICK MATCH       R  RANKINGS       L  SIGN OUT', cx, hintY + 18, 13, '#ffffffaa');
    // Split the hint line into two halves so RANKINGS and SIGN OUT are each
    // reachable by touch (no keyboard on a phone).
    tapZone(cx - 20, hintY + 7, 150, 22, 'ranks');
    tapZone(cx + 130, hintY + 7, 150, 22, 'signin');
    // The fighter line is the touch path to the select screen.
    if (menu.fighter) tapZone(cx - 260, hintY - 11, 520, 20, 'changefighter');
  }

  // Account/wallet block — upper LEFT, minimal text (M5 spec).
  if (menu.authLabel) {
    label(ctx, `◆ ${menu.authLabel}`, 16, 22, 13, '#8fe8a0', 'left');
    if (menu.address) {
      label(ctx, `${menu.address.slice(0, 6)}…${menu.address.slice(-4)}`, 16, 40, 11, '#ffffff77', 'left');
    }
    const acctY = menu.address ? 58 : 40;
    if (menu.account) {
      const a = menu.account;
      label(ctx, `⛁ ${a.credits} CR   ·   LV ${a.level}   ·   ${a.wins}W ${a.losses}L`, 16, acctY, 12, '#ffd166', 'left');
    } else {
      label(ctx, 'SERVER OFFLINE · CREDITS UNAVAILABLE', 16, acctY, 11, '#ff9d9d', 'left');
    }
  }

  // Daily login bonus toast — under the account block, gold, hard to miss.
  if (menu.dailyToast) {
    const flash = tick % 30 < 22;
    if (flash) label(ctx, `+${10} DAILY LOGIN CREDITS`, 16, menu.address ? 80 : 62, 14, '#ffe9a3', 'left');
  }

  label(ctx, 'MILESTONE 5 · CREDITS BUILD', cx, VH - 12, 10, '#ffffff55');
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

export interface CpuBadgeInfo { cpuLevel: number; lever: number }

const drawCpuBadge = (ctx: CanvasRenderingContext2D, info: CpuBadgeInfo, tick: number): void => {
  const w = 168, h = 60;
  const x = VW - 16 - w, y = 12;
  const glow = 0.5 + 0.5 * Math.sin(tick / 14);
  ctx.save();
  ctx.shadowColor = `rgba(217,164,65,${0.25 + 0.2 * glow})`;
  ctx.shadowBlur = 10;
  bevel(ctx, x, y, w, h, PANEL, GOLD, GOLD_DK, 2);
  ctx.restore();
  label(ctx, 'AGENT LEVEL', x + w / 2, y + 15, 10, '#c8b98a');
  const delta = info.lever === 0 ? '' : info.lever > 0 ? ` (+${info.lever})` : ` (${info.lever})`;
  display(ctx, `LV ${info.cpuLevel}`, x + w / 2, y + 42, 22, { scale: 1 });
  if (delta) label(ctx, delta, x + w / 2 + 46, y + 42, 11, '#7ee85a');
  label(ctx, '[  /  ]  ADJUST', x + w / 2, y + h - 4, 9, '#c8c4ba99');
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
 * A player's fighter card: portrait + name + concrete numbers (HP, moves) +
 * the derived stat bars. Anchored to a screen corner and accent-colored per
 * player, so P1 (left) and the opponent (right) read as two facing corners.
 */
const drawFighterCard = (
  ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number,
  r: Roster, stats: CharStats, accent: string, header: string, locked: boolean, tick: number,
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
  display(ctx, r.bundle.name.toUpperCase(), infoX, py2 + 16, 20, {
    align: 'left', glow: accent + 'aa', glowBlur: 12,
  });
  label(ctx, `${stats.health.toLocaleString()} HP   ·   ${stats.moveCount} MOVES`,
    infoX, py2 + 34, 11, '#ffd99b', 'left', false);

  // 6) Stat bars.
  let by = py2 + 52;
  for (const s of stats.bars) {
    drawStatBar(ctx, infoX, by, infoW, s, accent, tick);
    by += 20;
  }
};

export const drawSelect = (
  ctx: CanvasRenderingContext2D,
  rosters: Roster[],
  cursors: [number, number],
  locked: [boolean, boolean],
  tick: number,
  cpuInfo?: CpuBadgeInfo,
): void => {
  drawMenuBackdrop(ctx);
  ctx.fillStyle = '#0a0616d9';
  ctx.fillRect(0, 0, VW, VH);

  const stats = computeRosterStats(rosters);
  display(ctx, 'SELECT YOUR FIGHTER', VW / 2, 46, 26);
  if (cpuInfo) drawCpuBadge(ctx, cpuInfo, tick);

  // Portrait grid — a single row (wraps past 6). Compact so the bottom band
  // is free for the two fighter cards.
  const cols = Math.min(rosters.length, 6);
  const gap = 12;
  const maxGridW = 720;
  const cell = Math.min(96, Math.floor((maxGridW - (cols - 1) * gap) / cols));
  const rows = Math.ceil(rosters.length / cols);
  const gridW = cols * cell + (cols - 1) * gap;
  const gx = (VW - gridW) / 2;
  const gy = 74;
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
  const cardW = 448, cardH = 188;
  const cardY = Math.max(gy + rows * (cell + gap + 20) + 6, VH - cardH - 30);

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
  const cardHeaders: [string, string] = ['PLAYER 1', p2Header];
  for (const i of [0, 1] as const) {
    const r = rosters[cursors[i]];
    if (!r) continue;
    const cx = i === 0 ? 16 : VW - 16 - cardW;
    drawFighterCard(ctx, cx, cardY, cardW, cardH, r, stats[cursors[i]]!,
      P_COLORS[i], cardHeaders[i], locked[i], tick);
  }

  const bothLocked = locked[0] && locked[1];
  if (bothLocked) {
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
}

export const drawResults = (
  ctx: CanvasRenderingContext2D,
  g: GameState,
  rosters: [Roster, Roster],
  tick: number,
  age: number, // ticks since the results screen appeared — drives the pop-in
  xp?: XpInfo | null,
  hint?: string, // bottom action line — callers label the rematch with its fee
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
  const w = g.winner;
  const title = w === 2 ? 'DRAW GAME' : `${rosters[w as 0 | 1].bundle.name.toUpperCase()} WINS`;
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
    if (xp.levelsUp > 0) {
      const flash = tick % 40 < 28;
      if (flash) display(ctx, `LEVEL UP!  LV ${xp.level}`, VW / 2, y, 26, { glow: 'rgba(255,209,102,0.6)' });
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
    label(ctx, `LV ${xp.level}  ·  ${xp.xp}/${xp.xpNeed} XP  ·  ${xp.wins}W ${xp.losses}L`, VW / 2, y, 13, '#ffffffcc');
    ctx.restore();
  }

  if (tick % 60 < 42) {
    label(ctx, hint ?? 'TAP / ENTER: REMATCH        ESC: CHARACTER SELECT', VW / 2, VH - 26, 15, '#ffffffcc');
  }
  // Rematch fills the screen; the smaller "back" strip sits on the left.
  tapZone(0, 0, VW, VH, 'start');
  tapZone(0, VH - 48, 240, 48, 'back');
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
}

export const RANK_TABS = ['ALL', 'HUMANS', 'AGENTS'] as const;

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
): void => {
  drawMenuBackdrop(ctx);
  ctx.fillStyle = '#0a0616cc';
  ctx.fillRect(0, 0, VW, VH);

  display(ctx, 'LEADERBOARD', VW / 2, 64, 40, { glow: 'rgba(255,209,102,0.5)' });

  // Tabs — ◄ ► cycles, arcade style.
  const tabY = 104;
  RANK_TABS.forEach((t, i) => {
    const x = VW / 2 + (i - 1) * 170;
    tapZone(x - 80, tabY - 16, 160, 32, `ranktab:${i}`);
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
  const cols = { rank: 40, name: 90, kind: 380, lv: 490, xp: 560, wl: 680 };
  label(ctx, '#', boxX + cols.rank, boxY + 28, 12, GOLD_LT);
  label(ctx, 'FIGHTER', boxX + cols.name + 60, boxY + 28, 12, GOLD_LT);
  label(ctx, 'TYPE', boxX + cols.kind + 24, boxY + 28, 12, GOLD_LT);
  label(ctx, 'LV', boxX + cols.lv, boxY + 28, 12, GOLD_LT);
  label(ctx, 'XP', boxX + cols.xp + 16, boxY + 28, 12, GOLD_LT);
  label(ctx, 'W — L', boxX + cols.wl, boxY + 28, 12, GOLD_LT);
  ctx.fillStyle = '#ffffff22';
  ctx.fillRect(boxX + 16, boxY + 38, boxW - 32, 1);

  if (error) {
    label(ctx, `⚠ ${error}`, VW / 2, boxY + boxH / 2, 15, '#ff9d9d');
    label(ctx, 'is the match server running?  npm run server', VW / 2, boxY + boxH / 2 + 26, 12, '#ffffff77');
  } else if (!rows) {
    const dots = '.'.repeat(1 + (Math.trunc(tick / 20) % 3));
    label(ctx, `FETCHING STANDINGS${dots}`, VW / 2, boxY + boxH / 2, 15, '#f7e0a3');
  } else {
    const filtered = rows.filter((r) =>
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
      label(ctx, String(r.xp), boxX + cols.xp + 16, y, 13, '#ffffff99');
      label(ctx, `${r.wins} — ${r.losses}`, boxX + cols.wl, y, 14, '#ffffffdd');
    });
  }

  label(ctx, 'TAP  TAB       R  REFRESH       ESC / TAP HERE  BACK', VW / 2, VH - 26, 13, '#ffffffaa');
  tapZone(24, VH - 44, 170, 36, 'back');
};

// ------------------------------------------------------------ wallet strip
/**
 * The persistent wallet (P0 loop redesign): the same minimal top-left text
 * as the title chip, rendered on every screen where money matters (select,
 * lobby, results). `delta` floats a "+2 CR" / "−1 CR" that drifts up and
 * fades — credits you can watch move feel real.
 */
export interface WalletView { credits: number; level: number; wins: number; losses: number }

export const drawWallet = (
  ctx: CanvasRenderingContext2D,
  w: WalletView | null,
  delta: { amt: number; age: number } | null,
): void => {
  if (!w) return;
  label(ctx, `⛁ ${w.credits} CR   ·   LV ${w.level}   ·   ${w.wins}W ${w.losses}L`, 16, 22, 12, '#ffd166', 'left');
  if (delta && delta.age < 120 && delta.amt !== 0) {
    const t = delta.age / 120;
    ctx.save();
    ctx.globalAlpha = 1 - t * t;
    const up = delta.age * 0.22;
    label(ctx, `${delta.amt > 0 ? '+' : '−'}${Math.abs(delta.amt)} CR`,
      16, 42 - up, 15, delta.amt > 0 ? '#7ee85a' : '#ff6b6b', 'left');
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
  mode: 'solo' | 'wager',
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
  label(ctx, mode === 'wager'
    ? 'IF IT WAS ALREADY DECIDED THE RESULT STANDS · OTHERWISE THE POT IS REFUNDED'
    : 'IF IT WAS ALREADY DECIDED THE RESULT STANDS · OTHERWISE YOUR CREDIT IS REFUNDED',
  VW / 2, boxY + 128, 11, '#ffd166');

  if (tick % 60 < 44) {
    label(ctx, 'ENTER / ESC — BACK TO MENU', VW / 2, boxY + 162, 14, GOLD_LT);
  }
  tapZone(boxX, boxY + 140, boxW, 40, 'back');
};
