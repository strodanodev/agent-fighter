import { STAGE, TICKS_PER_SEC, TUNING } from '@af/core';
import type { GameState } from '@af/core';
import { drawPortrait } from './atlas.js';
import type { Roster } from './atlas.js';

/**
 * Arcade presentation layer: rooftop stage, framed HUD, title / select /
 * results screens. Pure drawing — zero game logic, zero sim reads beyond the
 * exported GameState fields. Everything is procedural (no art assets): the
 * only images in the game are the character sprites.
 */

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

/** A fixed camera for the menu backdrops. */
export const menuCam = (x: number): Cam => ({
  x, y: STAGE.floorYPx - (VH / 1.5) * 0.86, zoom: 1.5,
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

const text = (
  ctx: CanvasRenderingContext2D, s: string, x: number, y: number,
  size: number, color: string, align: CanvasTextAlign = 'center', shadow = true,
): void => {
  ctx.font = `bold ${size}px "Courier New", monospace`;
  ctx.textAlign = align;
  if (shadow) {
    ctx.fillStyle = '#00000099';
    ctx.fillText(s, x + 2, y + 2);
  }
  ctx.fillStyle = color;
  ctx.fillText(s, x, y);
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
 * HUD layout (rows, top-down): health bar · nameplate · round pips · meter.
 * Kept as named constants so nothing silently overlaps when tuned.
 */
const HUD = {
  edge: 96, // inner edge of the bars (portraits live outside this)
  barW: 330,
  barH: 26,
  barY: 30,
  nameY: 64,
  nameH: 21,
  pipY: 92,
  pipS: 12,
  meterY: 110,
  meterH: 9,
} as const;

const drawHealthBar = (
  ctx: CanvasRenderingContext2D,
  i: 0 | 1, ratio: number, flashRatio: number,
): void => {
  const barW = HUD.barW, barH = HUD.barH;
  const x = i === 0 ? HUD.edge : VW - HUD.edge - barW;
  const y = HUD.barY;

  // Frame.
  bevel(ctx, x - 4, y - 4, barW + 8, barH + 8, '#3a3244', '#6f6480', '#1a1626', 2);
  bevel(ctx, x - 2, y - 2, barW + 4, barH + 4, PANEL, GOLD, GOLD_DK, 2);

  // Damage flash (recent damage drains behind the bar).
  const fw = Math.round(barW * Math.max(0, ratio));
  const flashW = Math.round(barW * Math.max(0, flashRatio));
  const barX = (w: number): number => (i === 0 ? x + barW - w : x);
  ctx.fillStyle = '#ffffff55';
  ctx.fillRect(barX(flashW), y, flashW, barH);

  // Fill (drains toward the center of the screen, MvC style).
  const grad = ctx.createLinearGradient(0, y, 0, y + barH);
  const danger = ratio < 0.25;
  grad.addColorStop(0, danger ? HP_DANGER : HP_HI);
  grad.addColorStop(1, danger ? '#8a1f30' : HP_LO);
  ctx.fillStyle = grad;
  ctx.fillRect(barX(fw), y, fw, barH);
  // Gloss.
  ctx.fillStyle = '#ffffff33';
  ctx.fillRect(barX(fw), y + 2, fw, 5);

  // Arrow cap on the inner edge (reference art has angled bar tips).
  ctx.fillStyle = GOLD;
  const tip = i === 0 ? x + barW : x - 12;
  ctx.beginPath();
  if (i === 0) {
    ctx.moveTo(tip, y - 2);
    ctx.lineTo(tip + 12, y + barH / 2);
    ctx.lineTo(tip, y + barH + 2);
  } else {
    ctx.moveTo(tip + 12, y - 2);
    ctx.lineTo(tip, y + barH / 2);
    ctx.lineTo(tip + 12, y + barH + 2);
  }
  ctx.closePath();
  ctx.fill();
};

const drawMeter = (ctx: CanvasRenderingContext2D, i: 0 | 1, meter: number): void => {
  const bars = Math.round(TUNING.meterMax / TUNING.meterBar);
  const gap = 5;
  const segW = Math.floor((HUD.barW - (bars - 1) * gap) / bars);
  const total = bars * segW + (bars - 1) * gap;
  const startX = i === 0 ? HUD.edge : VW - HUD.edge - total;
  const y = HUD.meterY;
  for (let b = 0; b < bars; b++) {
    const x = startX + b * (segW + gap);
    const seg = Math.max(0, Math.min(TUNING.meterBar, meter - b * TUNING.meterBar));
    const ratio = seg / TUNING.meterBar;
    bevel(ctx, x, y, segW, HUD.meterH, '#191524', '#4a4260', '#0d0a14', 1);
    const full = ratio >= 1;
    ctx.fillStyle = full ? METER_FULL : METER_HI;
    ctx.fillRect(x + 1, y + 1, Math.round((segW - 2) * ratio), HUD.meterH - 2);
  }
};

const drawPortraitFrame = (
  ctx: CanvasRenderingContext2D, i: 0 | 1, roster: Roster, lowHealth: boolean,
): void => {
  const s = 76;
  const x = i === 0 ? 12 : VW - 12 - s;
  const y = HUD.barY - 6;
  bevel(ctx, x - 3, y - 3, s + 6, s + 6, PANEL, GOLD, GOLD_DK, 3);
  ctx.save();
  if (lowHealth) ctx.filter = 'saturate(0.4) brightness(0.8)';
  drawPortrait(ctx, roster, x, y, s, s);
  ctx.restore();
  // Player tag.
  ctx.fillStyle = P_COLORS[i];
  ctx.fillRect(x, y + s - 14, 26, 14);
  text(ctx, `P${i + 1}`, x + 13, y + s - 3, 11, '#fff', 'center', false);
};

const drawNameplate = (ctx: CanvasRenderingContext2D, i: 0 | 1, name: string): void => {
  const w = 216, h = HUD.nameH;
  const x = i === 0 ? HUD.edge : VW - HUD.edge - w;
  const y = HUD.nameY;
  bevel(ctx, x, y, w, h, PANEL, GOLD, GOLD_DK, 2);
  // Angled inner tip toward the center.
  ctx.fillStyle = GOLD;
  if (i === 0) ctx.fillRect(x + w - 4, y, 4, h);
  else ctx.fillRect(x, y, 4, h);
  text(ctx, name.toUpperCase(), i === 0 ? x + 14 : x + w - 14, y + 15, 13, GOLD_LT,
    i === 0 ? 'left' : 'right');
};

const drawRoundPips = (ctx: CanvasRenderingContext2D, i: 0 | 1, wins: number): void => {
  const need = TUNING.roundsToWin;
  const s = HUD.pipS, gap = 6;
  const y = HUD.pipY;
  for (let r = 0; r < need; r++) {
    const x = i === 0
      ? HUD.edge + r * (s + gap)
      : VW - HUD.edge - s - r * (s + gap);
    bevel(ctx, x, y, s, s, r < wins ? GOLD : '#191524', r < wins ? GOLD_LT : '#4a4260', GOLD_DK, 1);
  }
};

const drawTimer = (ctx: CanvasRenderingContext2D, secs: number): void => {
  const cx = VW / 2, cy = 52, r = 42;
  // Octagon frame.
  const oct = (rr: number): void => {
    ctx.beginPath();
    for (let k = 0; k < 8; k++) {
      const a = (Math.PI / 4) * k + Math.PI / 8;
      const x = cx + Math.cos(a) * rr;
      const y = cy + Math.sin(a) * rr;
      if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
  };
  oct(r);
  ctx.fillStyle = GOLD;
  ctx.fill();
  oct(r - 4);
  ctx.fillStyle = PANEL;
  ctx.fill();
  const urgent = secs <= 10;
  text(ctx, String(Math.max(0, secs)).padStart(2, '0'), cx, cy + 12, 34,
    urgent ? HP_DANGER : '#ffffff');
};

export interface HudFx {
  flash: [number, number]; // lagging health ratio per player (damage flash)
  comboOwner: number; // -1 none
  comboHits: number;
  announce: string;
  announceAge: number;
}

export const drawHud = (
  ctx: CanvasRenderingContext2D,
  g: GameState,
  rosters: [Roster, Roster],
  fx: HudFx,
): void => {
  for (const i of [0, 1] as const) {
    const f = g.fighters[i];
    const max = rosters[i].ch.b.maxHealth;
    const ratio = Math.max(0, f.health) / max;
    drawHealthBar(ctx, i, ratio, fx.flash[i]);
    drawPortraitFrame(ctx, i, rosters[i], ratio < 0.25);
    drawNameplate(ctx, i, rosters[i].bundle.name);
    drawRoundPips(ctx, i, i === 0 ? g.roundsWon0 : g.roundsWon1);
    drawMeter(ctx, i, f.meter);
  }
  drawTimer(ctx, Math.ceil(g.timerTicks / TICKS_PER_SEC));

  // Combo counter.
  if (fx.comboOwner >= 0 && fx.comboHits >= 2) {
    const i = fx.comboOwner as 0 | 1;
    const x = i === 0 ? 110 : VW - 110;
    const align: CanvasTextAlign = i === 0 ? 'left' : 'right';
    text(ctx, `${fx.comboHits}`, x, 200, 46, GOLD_LT, align);
    text(ctx, 'HITS', i === 0 ? x + 62 : x - 62, 200, 20, '#fff', align);
  }

  // Center announcements (ROUND 1 / FIGHT! / KO).
  if (fx.announce) {
    const t = Math.min(1, fx.announceAge / 8);
    const size = 64 * (0.6 + 0.4 * t);
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, 1.6 - fx.announceAge / 60));
    text(ctx, fx.announce, VW / 2, VH / 2 - 40, size, GOLD_LT);
    ctx.restore();
  }

  // Controls hint.
  text(ctx, 'P1: WASD · TYU/GHJ      P2: ARROWS · IOP/KL;      B: HITBOXES', VW / 2, VH - 10, 11, '#ffffff66');
};

// ---------------------------------------------------------------- title
export const drawTitle = (
  ctx: CanvasRenderingContext2D, rosters: Roster[], tick: number,
): void => {
  ctx.save();
  const cam = menuCam(500);
  worldTransform(ctx, cam);
  drawStage(ctx, cam);
  ctx.restore();
  // Vignette so the logo reads.
  const vig = ctx.createLinearGradient(0, 0, 0, VH);
  vig.addColorStop(0, '#0a0616dd');
  vig.addColorStop(0.55, '#0a061633');
  vig.addColorStop(1, '#0a0616cc');
  ctx.fillStyle = vig;
  ctx.fillRect(0, 0, VW, VH);

  // Two fighters flanking the logo, squaring off.
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

  // Logo.
  const cx = VW / 2;
  ctx.save();
  ctx.textAlign = 'center';
  const logo = (s: string, y: number, size: number): void => {
    ctx.font = `bold ${size}px "Courier New", monospace`;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#0d1b3a';
    ctx.lineWidth = 12;
    ctx.strokeText(s, cx, y);
    ctx.strokeStyle = '#8fb8ff';
    ctx.lineWidth = 5;
    ctx.strokeText(s, cx, y);
    const g = ctx.createLinearGradient(0, y - size, 0, y + 8);
    g.addColorStop(0, '#ffffff');
    g.addColorStop(0.45, '#cfe3ff');
    g.addColorStop(0.5, '#4d7fd4');
    g.addColorStop(1, '#e8f1ff');
    ctx.fillStyle = g;
    ctx.fillText(s, cx, y);
  };
  logo('AGENT', 150, 82);
  logo('FIGHTER', 235, 82);
  ctx.restore();

  if (tick % 60 < 40) {
    text(ctx, 'PRESS ANY KEY TO BEGIN', cx, VH - 90, 20, GOLD_LT);
  }
  text(ctx, 'MILESTONE 2 · STUDIO BUILD', cx, VH - 40, 12, '#ffffff77');
};

// ---------------------------------------------------------------- select
export const drawSelect = (
  ctx: CanvasRenderingContext2D,
  rosters: Roster[],
  cursors: [number, number],
  locked: [boolean, boolean],
  tick: number,
): void => {
  ctx.save();
  const cam = menuCam(700);
  worldTransform(ctx, cam);
  drawStage(ctx, cam);
  ctx.restore();
  ctx.fillStyle = '#0a0616cc';
  ctx.fillRect(0, 0, VW, VH);

  text(ctx, 'SELECT YOUR FIGHTER', VW / 2, 62, 30, GOLD_LT);

  // Portrait grid.
  const cell = 132, gap = 18;
  const cols = Math.min(rosters.length, 5);
  const gridW = cols * cell + (cols - 1) * gap;
  const gx = (VW - gridW) / 2;
  const gy = 110;
  rosters.forEach((r, k) => {
    const x = gx + (k % cols) * (cell + gap);
    const y = gy + Math.floor(k / cols) * (cell + gap + 26);
    bevel(ctx, x - 3, y - 3, cell + 6, cell + 6, PANEL, GOLD, GOLD_DK, 3);
    drawPortrait(ctx, r, x, y, cell, cell);
    text(ctx, r.bundle.name.toUpperCase(), x + cell / 2, y + cell + 20, 14, '#fff');

    // Selection cursors.
    for (const i of [0, 1] as const) {
      if (cursors[i] !== k) continue;
      const blink = locked[i] || tick % 30 < 20;
      if (!blink) continue;
      ctx.strokeStyle = P_COLORS[i];
      ctx.lineWidth = 4;
      const o = i === 0 ? 0 : 5; // offset so both cursors are visible on the same cell
      ctx.strokeRect(x - 6 - o, y - 6 - o, cell + 12 + o * 2, cell + 12 + o * 2);
      ctx.lineWidth = 1;
      ctx.fillStyle = P_COLORS[i];
      const tagX = i === 0 ? x - 6 : x + cell + 6;
      ctx.fillRect(tagX - (i === 0 ? 0 : 30), y - 26, 30, 18);
      text(ctx, locked[i] ? `P${i + 1}✓` : `P${i + 1}`, tagX + (i === 0 ? 15 : -15), y - 12, 12, '#fff', 'center', false);
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
    if (tick % 60 < 42) text(ctx, 'PRESS START TO FIGHT', VW / 2, VH - 30, 20, GOLD_LT);
  } else {
    text(ctx, 'P1: A/D MOVE · F CONFIRM      P2: ←/→ MOVE · K CONFIRM',
      VW / 2, VH - 30, 13, '#ffffffaa');
  }
};

// ---------------------------------------------------------------- results
export const drawResults = (
  ctx: CanvasRenderingContext2D,
  g: GameState,
  rosters: [Roster, Roster],
  tick: number,
): void => {
  ctx.fillStyle = '#0a0616bb';
  ctx.fillRect(0, 0, VW, VH);
  const w = g.winner;
  const title = w === 2 ? 'DRAW GAME' : `${rosters[w as 0 | 1].bundle.name.toUpperCase()} WINS`;
  bevel(ctx, VW / 2 - 300, VH / 2 - 80, 600, 120, PANEL, GOLD, GOLD_DK, 3);
  text(ctx, title, VW / 2, VH / 2 - 20, 44, GOLD_LT);
  text(ctx, `${g.roundsWon0} — ${g.roundsWon1}`, VW / 2, VH / 2 + 22, 24, '#fff');
  if (tick % 60 < 42) {
    text(ctx, 'ENTER: REMATCH    ESC: CHARACTER SELECT', VW / 2, VH / 2 + 90, 16, '#ffffffcc');
  }
};
