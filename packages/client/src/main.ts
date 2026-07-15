/**
 * Agent Fighter — game client.
 * Fixed-timestep 60Hz loop; the renderer is a pure function of GameState plus
 * cosmetic juice that lives OUTSIDE the sim (safe under future rollback).
 * Characters are loaded from `characters/<id>/` bundles + packed atlases —
 * the client interprets no frame data, it only asks the engine which sprite
 * to draw (`spriteForFighter`) and blits it.
 */
import {
  Action, Btn, Phase, STAGE, TICKS_PER_SEC,
  createGameState, debugBoxes, setCharacters, step,
} from '@af/core';
import type { GameState, InputFrame } from '@af/core';
import { listCharacters, loadRoster, drawFighter } from './atlas.js';
import type { Roster } from './atlas.js';
import {
  CONTENT_BOT, CONTENT_TOP, P_COLORS, VH, VW, ZOOM_MAX, ZOOM_MIN,
  currentStageCamLimits, drawHud, drawResults, drawSelect, drawStage,
  drawStageSelect, drawTitle, setStageAsset, setUiKit, worldTransform,
} from './ui.js';
import type { Cam, HudFx } from './ui.js';
import { listStages, loadStage, loadUiKit } from './chrome.js';
import type { StageAsset } from './chrome.js';

const TICK_MS = 1000 / TICKS_PER_SEC;

// ---------------------------------------------------------------- input
const keys = new Set<string>();
const pressedThisFrame = new Set<string>();
addEventListener('keydown', (e) => {
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

// ---------------------------------------------------------------- state
type Screen = 'loading' | 'title' | 'select' | 'stageSelect' | 'fight' | 'results';

let screen: Screen = 'loading';
let uiTick = 0;
let allRosters: Roster[] = [];
let picks: [number, number] = [0, 0];
let locked: [boolean, boolean] = [false, false];
let stageIds: string[] = [];
let stageAssets: (StageAsset | null)[] = [];
let stageCursor = 0;
let fighters: [Roster, Roster] | null = null;
let game: GameState | null = null;
let showBoxes = false;
let seed = 1;
let loadError = '';

// Cosmetic juice — never simulated.
interface Spark { x: number; y: number; age: number; big: boolean }
let sparks: Spark[] = [];
let shake = 0;
let cam: Cam = { x: 0, y: 0, zoom: 1.5 };
let hitStopFlash = 0;
const fx: HudFx = { flash: [1, 1], comboOwner: -1, comboHits: 0, announce: '', announceAge: 0 };
let prevHealth: [number, number] = [0, 0];
let prevPhase: Phase = Phase.PreRound;

// ---------------------------------------------------------------- canvas
const canvas = document.getElementById('game') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const px = (v: number): number => Math.trunc(v / 256);

// ---------------------------------------------------------------- boot
const boot = async (): Promise<void> => {
  try {
    setUiKit(await loadUiKit());
    stageIds = await listStages();
    stageAssets = await Promise.all(stageIds.map(loadStage));
    if (stageAssets.length > 0) setStageAsset(stageAssets[0]!);
    const ids = await listCharacters();
    if (ids.length === 0) throw new Error('no characters found in characters/');
    allRosters = await Promise.all(ids.map(loadRoster));
    picks = [0, Math.min(1, allRosters.length - 1)];
    screen = 'title';
  } catch (e) {
    loadError = (e as Error).message;
  }
};

const startFight = (): void => {
  fighters = [allRosters[picks[0]]!, allRosters[picks[1]]!];
  setCharacters(fighters[0].ch, fighters[1].ch);
  game = createGameState(seed++);
  cam = { x: STAGE.widthPx / 2 - VW / 2 / 1.5, y: STAGE.floorYPx - (VH / 1.5) * 0.86, zoom: 1.5 };
  updateCamera(game); // settle before the first frame so round 1 opens framed
  prevHealth = [game.fighters[0].health, game.fighters[1].health];
  prevPhase = game.phase;
  fx.flash = [1, 1];
  fx.comboOwner = -1;
  fx.comboHits = 0;
  fx.announce = `ROUND ${game.roundNum + 1}`;
  fx.announceAge = 0;
  sparks = [];
  shake = 0;
  screen = 'fight';
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
      sparks.push({ x: px(f.x) + f.facing * -22, y: px(f.y) - 78, age: 0, big });
      shake = big ? 11 : 6;
      hitStopFlash = big ? 3 : 0;
    }
    prevHealth[i] = f.health;
    // Health bar lag (white flash draining behind the real bar).
    const max = fighters![i].ch.b.maxHealth;
    const target = Math.max(0, f.health) / max;
    fx.flash[i] = fx.flash[i] > target ? Math.max(target, fx.flash[i] - 0.006) : target;
  }

  // Combo counter tracks whoever is being hit.
  const v0 = g.fighters[0], v1 = g.fighters[1];
  const inCombo = (a: Action): boolean => a === Action.Hitstun || a === Action.AirHitstun;
  if (inCombo(v1.action) && v1.comboHits >= 2) { fx.comboOwner = 0; fx.comboHits = v1.comboHits; }
  else if (inCombo(v0.action) && v0.comboHits >= 2) { fx.comboOwner = 1; fx.comboHits = v0.comboHits; }
  else if (!inCombo(v0.action) && !inCombo(v1.action)) fx.comboOwner = -1;

  // Announcements on phase changes.
  if (g.phase !== prevPhase) {
    if (g.phase === Phase.Fighting) { fx.announce = 'FIGHT!'; fx.announceAge = 0; }
    else if (g.phase === Phase.RoundOver) {
      fx.announce = g.roundWinner === 2 ? 'DOUBLE KO' : 'K.O.';
      fx.announceAge = 0;
    } else if (g.phase === Phase.PreRound) { fx.announce = `ROUND ${g.roundNum + 1}`; fx.announceAge = 0; }
    prevPhase = g.phase;
  }
  fx.announceAge++;

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
    drawFighter(ctx, fighters![i], f, g.tick, px(f.x), px(f.y), P_COLORS[i]);
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
  drawHud(ctx, g, fighters!, fx);
};

// ---------------------------------------------------------------- screens
const tickSelect = (): void => {
  const n = allRosters.length;
  const move = (i: 0 | 1, d: number): void => {
    if (locked[i]) return;
    picks[i] = (picks[i] + d + n) % n;
  };
  if (pressedThisFrame.has('KeyA')) move(0, -1);
  if (pressedThisFrame.has('KeyD')) move(0, 1);
  if (pressedThisFrame.has('ArrowLeft')) move(1, -1);
  if (pressedThisFrame.has('ArrowRight')) move(1, 1);
  for (const i of [0, 1] as const) {
    if (CONFIRM[i]!.some((k) => pressedThisFrame.has(k))) locked[i] = true;
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
  if (pressedThisFrame.has('Escape')) { screen = 'select'; locked = [false, false]; }
  if (pressedThisFrame.has('Enter') || pressedThisFrame.has('Space')) startFight();
};

const frame = (): void => {
  uiTick++;

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
    drawTitle(ctx, allRosters, uiTick);
    if (pressedThisFrame.size > 0) { screen = 'select'; locked = [false, false]; }
  } else if (screen === 'select') {
    tickSelect();
    drawSelect(ctx, allRosters, picks, locked, uiTick);
  } else if (screen === 'stageSelect') {
    tickStageSelect();
    drawStageSelect(ctx, stageIds, stageCursor, uiTick);
  } else if (screen === 'fight' && game) {
    if (pressedThisFrame.has('KeyB')) showBoxes = !showBoxes;
    if (pressedThisFrame.has('Escape')) { screen = 'select'; locked = [false, false]; }
    step(game, [pollPad(P0_MAP), pollPad(P1_MAP)]);
    updateJuice(game);
    updateCamera(game);
    renderFight(game);
    if (game.phase === Phase.MatchOver) screen = 'results';
  } else if (screen === 'results' && game) {
    renderFight(game);
    drawResults(ctx, game, fighters!, uiTick);
    if (pressedThisFrame.has('Enter')) startFight();
    if (pressedThisFrame.has('Escape')) { screen = 'select'; locked = [false, false]; }
  }

  pressedThisFrame.clear();
};

// ---------------------------------------------------------------- loop
let last = performance.now();
let acc = 0;

const loop = (now: number): void => {
  acc = Math.min(acc + (now - last), 200); // tab-switch guard
  last = now;
  let ran = false;
  while (acc >= TICK_MS) {
    frame();
    acc -= TICK_MS;
    ran = true;
  }
  if (!ran && screen === 'loading') frame(); // keep the loading screen painted
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
});
