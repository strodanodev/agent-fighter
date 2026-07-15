import { STAGE, TICKS_PER_SEC, TUNING } from '@af/core';
import type { GameState } from '@af/core';
import { drawPortrait } from './atlas.js';
import type { Roster } from './atlas.js';
import {
  DISPLAY_FONT_STACK, HUD_GEO, clipPoly, drawBgVideoCover, drawChrome, drawStageLayers, opaqueBBox, stageCamLimits,
} from './chrome.js';
import type { BgVideo, ImgBBox, StageAsset, StageCamLimits, UiKit } from './chrome.js';

// Injected at boot (null = procedural fallbacks everywhere).
let uiKit: UiKit | null = null;
let stageAsset: StageAsset | null = null;
let logoImg: HTMLImageElement | null = null;
let logoBBox: ImgBBox | null = null;
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

export type Mode = 'cpu' | '2p';

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

  // Low-health urgency: a soft pulsing red glow behind the frame.
  if (danger) {
    const pulse = 0.35 + 0.35 * (0.5 + 0.5 * Math.sin(tick / 8));
    ctx.save();
    ctx.shadowColor = `rgba(233,69,96,${pulse})`;
    ctx.shadowBlur = 16;
    ctx.fillStyle = 'rgba(233,69,96,0.01)'; // near-invisible fill just to cast the shadow
    ctx.fillRect(x - 4, y - 4, barW + 8, barH + 8);
    ctx.restore();
  }

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

const drawMeter = (ctx: CanvasRenderingContext2D, i: 0 | 1, meter: number): void => {
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
  tags?: [string, string], // per-player nameplate suffix (e.g. "CPU LV 12")
): void => {
  for (const i of [0, 1] as const) {
    const f = g.fighters[i];
    const max = rosters[i].ch.b.maxHealth;
    const ratio = Math.max(0, f.health) / max;
    drawHealthBar(ctx, i, ratio, fx.flash[i], g.tick);
    drawPortraitFrame(ctx, i, rosters[i], ratio < 0.25);
    drawNameplate(ctx, i, rosters[i].bundle.name + (tags?.[i] ? ` · ${tags[i]}` : ''));
    drawRoundPips(ctx, i, i === 0 ? g.roundsWon0 : g.roundsWon1);
    drawMeter(ctx, i, f.meter);
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

  // Center announcements (ROUND 1 / FIGHT! / KO): pop in with overshoot, hold, fade.
  if (fx.announce) {
    const inT = clamp01(fx.announceAge / 10);
    const scale = 0.5 + 0.5 * easeOutBack(inT);
    const alpha = clamp01(1.6 - fx.announceAge / 60);
    const danger = fx.announce === 'K.O.' || fx.announce === 'DOUBLE KO';
    display(ctx, fx.announce, VW / 2, VH / 2 - 40, 64, {
      scale, alpha, ...(danger ? DANGER_OPTS : {}),
      glow: danger ? 'rgba(233,69,96,0.7)' : 'rgba(255,209,102,0.6)',
    });
  }

  // Controls strip (dark band like the reference).
  ctx.fillStyle = '#0b0a12dd';
  ctx.fillRect(0, VH - 24, VW, 24);
  ctx.fillStyle = '#2e3140';
  ctx.fillRect(0, VH - 24, VW, 1);
  label(ctx, 'P1: WASD · TYU / GHJ        P2: ARROWS · IOP / KL;        B: HITBOXES        ESC: MENU',
    VW / 2, VH - 8, 11, '#c8c4ba');
};

// ---------------------------------------------------------------- title
export interface TitleMenuState {
  mode: Mode;
  cpuLevel: number;
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
    const scale = Math.max(VW / box.w, VH / box.h) * 0.8;
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

  const rows: [Mode, string][] = [
    ['cpu', `VS CPU  ·  LV ${menu.cpuLevel}`],
    ['2p', '2 PLAYERS'],
  ];
  const menuY0 = barY + 40;
  rows.forEach(([m, txt], k) => {
    const y = menuY0 + k * 34;
    const on = menu.mode === m;
    if (on) {
      const pulse = 1 + 0.035 * Math.sin(tick / 10);
      display(ctx, txt, cx, y, 24, { scale: pulse, glow: 'rgba(255,209,102,0.55)' });
      // A small bouncing arrow marker to the left, arcade-menu style.
      const bounce = 3 * Math.sin(tick / 9);
      label(ctx, '▶', cx - 112 + bounce, y, 18, GOLD_LT);
    } else {
      label(ctx, txt, cx, y, 17, '#ffffff70');
    }
  });
  label(ctx, '↑ / ↓  SELECT       ENTER  START', cx, menuY0 + 62, 13, '#ffffffaa');

  label(ctx, 'MILESTONE 4 · AI + LEVELING BUILD', cx, VH - 12, 10, '#ffffff55');
};

// ---------------------------------------------------------------- select
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
  label(ctx, 'CPU DIFFICULTY', x + w / 2, y + 15, 10, '#c8b98a');
  const delta = info.lever === 0 ? '' : info.lever > 0 ? ` (+${info.lever})` : ` (${info.lever})`;
  display(ctx, `LV ${info.cpuLevel}`, x + w / 2, y + 42, 22, { scale: 1 });
  if (delta) label(ctx, delta, x + w / 2 + 46, y + 42, 11, '#7ee85a');
  label(ctx, '[  /  ]  ADJUST', x + w / 2, y + h - 4, 9, '#c8c4ba99');
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
  ctx.fillStyle = '#0a0616cc';
  ctx.fillRect(0, 0, VW, VH);

  display(ctx, 'SELECT YOUR FIGHTER', VW / 2, 60, 32);
  if (cpuInfo) drawCpuBadge(ctx, cpuInfo, tick);

  // Portrait grid.
  const cell = 132, gap = 18;
  const cols = Math.min(rosters.length, 5);
  const gridW = cols * cell + (cols - 1) * gap;
  const gx = (VW - gridW) / 2;
  const gy = 118;
  rosters.forEach((r, k) => {
    const x = gx + (k % cols) * (cell + gap);
    const y = gy + Math.floor(k / cols) * (cell + gap + 26);
    bevel(ctx, x - 3, y - 3, cell + 6, cell + 6, PANEL, GOLD, GOLD_DK, 3);
    drawPortrait(ctx, r, x, y, cell, cell);
    label(ctx, r.bundle.name.toUpperCase(), x + cell / 2, y + cell + 20, 14, '#fff');

    // Selection cursors: smooth pulsing glow instead of a hard blink.
    for (const i of [0, 1] as const) {
      if (cursors[i] !== k) continue;
      const pulse = locked[i] ? 1 : 0.55 + 0.45 * (0.5 + 0.5 * Math.sin(tick / 8));
      ctx.save();
      ctx.globalAlpha = pulse;
      ctx.strokeStyle = P_COLORS[i];
      ctx.lineWidth = 4;
      const o = i === 0 ? 0 : 5; // offset so both cursors are visible on the same cell
      ctx.strokeRect(x - 6 - o, y - 6 - o, cell + 12 + o * 2, cell + 12 + o * 2);
      ctx.restore();
      ctx.fillStyle = P_COLORS[i];
      const tagX = i === 0 ? x - 6 : x + cell + 6;
      ctx.fillRect(tagX - (i === 0 ? 0 : 30), y - 26, 30, 18);
      label(ctx, locked[i] ? `P${i + 1}✓` : `P${i + 1}`, tagX + (i === 0 ? 15 : -15), y - 12, 12, '#fff', 'center', false);
    }
  });

  // Big preview of each player's pick.
  rosters.forEach((r, k) => {
    for (const i of [0, 1] as const) {
      if (cursors[i] !== k || !r.portrait) continue;
      ctx.save();
      ctx.globalAlpha = locked[i] ? 1 : 0.75;
      ctx.translate(i === 0 ? 120 : VW - 120, VH - 40);
      ctx.scale(i === 0 ? 1.15 : -1.15, 1.15);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(r.portrait, -96, -176);
      ctx.restore();
    }
  });

  const bothLocked = locked[0] && locked[1];
  if (bothLocked) {
    const pulse = 1 + 0.04 * Math.sin(tick / 9);
    display(ctx, 'PRESS START TO FIGHT', VW / 2, VH - 26, 22, { scale: pulse, glow: 'rgba(255,209,102,0.5)' });
  } else {
    label(ctx, 'P1: A/D MOVE · F CONFIRM      P2: ←/→ MOVE · K CONFIRM',
      VW / 2, VH - 26, 13, '#ffffffaa');
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

  label(ctx, '◄ / ►  CHOOSE STAGE      ENTER  FIGHT      ESC  BACK', VW / 2, VH - 26, 13, '#ffffffaa');
};

// ---------------------------------------------------------------- results
export interface XpInfo {
  gained: number;
  levelsUp: number;
  level: number;
  xp: number;
  xpNeed: number;
  wins: number;
  losses: number;
}

export const drawResults = (
  ctx: CanvasRenderingContext2D,
  g: GameState,
  rosters: [Roster, Roster],
  tick: number,
  age: number, // ticks since the results screen appeared — drives the pop-in
  xp?: XpInfo | null,
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
    display(ctx, `+${xp.gained} XP`, VW / 2, y, 22, { from: '#d9ffcf', mid: '#7ee85a', to: '#2f7a1f', outline: '#0e2a08' });
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
    label(ctx, 'ENTER: REMATCH    ESC: CHARACTER SELECT', VW / 2, VH - 26, 15, '#ffffffcc');
  }
};
