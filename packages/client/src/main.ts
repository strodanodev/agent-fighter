/**
 * Agent Fighter — Milestone 1 client.
 * Renderer is a pure function of GameState (plus cosmetic-only juice that
 * lives OUTSIDE the sim). Fixed-timestep 60Hz loop with an accumulator.
 * Canvas 2D (zero deps, single-file demo); the render() boundary is where
 * PixiJS slots in for M2+.
 */
import {
  Action, Btn, Phase, STAGE, TICKS_PER_SEC, TUNING,
  characters, createGameState, debugBoxes, debugInfo, stateHash, step,
} from '@af/core';
import type { GameState, InputFrame } from '@af/core';

const TICK_MS = 1000 / TICKS_PER_SEC;

// ---------------------------------------------------------------- input
/** Keyboard InputSource for two local players sharing one keyboard. */
const keys = new Set<string>();
addEventListener('keydown', (e) => {
  keys.add(e.code);
  if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space'].includes(e.code)) e.preventDefault();
});
addEventListener('keyup', (e) => keys.delete(e.code));

// P1: WASD move · T/Y/U punches · G/H/J kicks
const P0_MAP: [string, number][] = [
  ['KeyA', Btn.Left], ['KeyD', Btn.Right], ['KeyW', Btn.Up], ['KeyS', Btn.Down],
  ['KeyT', Btn.LP], ['KeyY', Btn.MP], ['KeyU', Btn.HP],
  ['KeyG', Btn.LK], ['KeyH', Btn.MK], ['KeyJ', Btn.HK],
];
// P2: Arrows move · I/O/P punches · K/L/; kicks (numpad 4/5/6 + 1/2/3 also work)
const P1_MAP: [string, number][] = [
  ['ArrowLeft', Btn.Left], ['ArrowRight', Btn.Right], ['ArrowUp', Btn.Up], ['ArrowDown', Btn.Down],
  ['KeyI', Btn.LP], ['KeyO', Btn.MP], ['KeyP', Btn.HP],
  ['KeyK', Btn.LK], ['KeyL', Btn.MK], ['Semicolon', Btn.HK],
  ['Numpad4', Btn.LP], ['Numpad5', Btn.MP], ['Numpad6', Btn.HP],
  ['Numpad1', Btn.LK], ['Numpad2', Btn.MK], ['Numpad3', Btn.HK],
];

const pollKeyboard = (map: [string, number][]): InputFrame => {
  let f = 0;
  for (const [code, bit] of map) if (keys.has(code)) f |= bit;
  return f;
};

// ---------------------------------------------------------------- game
let game: GameState = createGameState(1);
let showBoxes = false;
let inputLog: [InputFrame, InputFrame][] = [];

// Cosmetic juice (never simulated — safe under future rollback).
interface Spark { x: number; y: number; age: number; big: boolean }
let sparks: Spark[] = [];
let shake = 0;
let camX = 0;
let camY = 0;
let prevHealth = [game.fighters[0].health, game.fighters[1].health];

addEventListener('keydown', (e) => {
  if (e.code === 'KeyB') showBoxes = !showBoxes;
  if (e.code === 'Enter' && game.phase === Phase.MatchOver) {
    game = createGameState((game.rngSeed + 1) | 0);
    inputLog = [];
    sparks = [];
    prevHealth = [game.fighters[0].health, game.fighters[1].health];
  }
});

// ---------------------------------------------------------------- canvas
const canvas = document.getElementById('game') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const VW = STAGE.viewportW;
const VH = STAGE.viewportH;

const px = (fpv: number): number => Math.trunc(fpv / 256);
const MAXHP = characters[0].b.maxHealth;

const P_COLORS = [
  { body: '#e94560', accent: '#ff8fa3', name: 'P1' },
  { body: '#4ea8de', accent: '#a3d5ff', name: 'P2' },
] as const;

const ACTION_NAMES = [
  'idle', 'walk', 'walk', 'crouch', 'jumpsquat', 'air', 'dash', 'backdash', 'airdash',
  'attack', 'hitstun', 'air hitstun', 'block', 'block', 'block', 'knockdown', 'getup',
  'grab', 'thrown', 'KO',
];

// ---------------------------------------------------------------- camera
const updateCamera = (): void => {
  const [f0, f1] = game.fighters;
  const midX = (px(f0.x) + px(f1.x)) / 2;
  const targetX = Math.max(0, Math.min(STAGE.widthPx - VW, midX - VW / 2));
  // Vertical follow on super jumps (spec §4): track the highest fighter.
  const highest = Math.min(px(f0.y), px(f1.y));
  const heightAboveFloor = STAGE.floorYPx - highest;
  const targetY = Math.max(0, (heightAboveFloor - 240) * 0.85);
  camX += (targetX - camX) * 0.18;
  camY += (targetY - camY) * 0.12;
};

const sx = (worldX: number): number => worldX - camX;
const sy = (worldY: number): number => worldY + camY;

// ---------------------------------------------------------------- fighters
const drawFighter = (i: 0 | 1): void => {
  const f = game.fighters[i];
  const c = P_COLORS[i];
  const x = sx(px(f.x));
  const y = sy(px(f.y));
  const a = f.action;
  const w = 52;

  const crouched = a === Action.Crouch || a === Action.BlockCrouch;
  const lying = a === Action.Knockdown || a === Action.Getup
    || (a === Action.KO && px(f.y) >= STAGE.floorYPx);
  const blocking = a === Action.BlockStand || a === Action.BlockCrouch || a === Action.BlockAir;
  const inHitstun = a === Action.Hitstun || a === Action.AirHitstun || a === Action.Thrown;
  const attacking = a === Action.Attack;
  const dashing = a === Action.DashF || a === Action.DashB || a === Action.AirDash;
  const h = lying ? 30 : crouched ? 80 : 108;
  const bw = lying ? 96 : w;

  ctx.save();
  ctx.translate(x, y);
  if (attacking) ctx.transform(1, 0, -0.08 * f.facing, 1, 0, 0);
  if (a === Action.Getup) ctx.globalAlpha = 0.6; // wakeup invulnerability reads as ghosting
  ctx.fillStyle = inHitstun && game.tick % 4 < 2 ? '#ffffff'
    : a === Action.KO ? '#555'
    : blocking ? '#7f8cff'
    : c.body;
  ctx.fillRect(-bw / 2, -h, bw, h);
  // Face stripe shows facing.
  if (!lying) {
    ctx.fillStyle = c.accent;
    ctx.fillRect(f.facing === 1 ? w / 2 - 10 : -w / 2, -h, 10, 24);
  }
  // Block shield.
  if (blocking) {
    ctx.strokeStyle = '#c3d0ff';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(f.facing * (w / 2 + 8), -h / 2, 26, -Math.PI / 2.5, Math.PI / 2.5);
    ctx.stroke();
    ctx.lineWidth = 1;
  }
  // Dash lines.
  if (dashing) {
    ctx.strokeStyle = c.accent + '99';
    for (const dy of [-h + 16, -h / 2, -14]) {
      ctx.beginPath();
      ctx.moveTo(-f.facing * (w / 2 + 6), dy);
      ctx.lineTo(-f.facing * (w / 2 + 30), dy);
      ctx.stroke();
    }
  }
  // Active limb block during attacks (drawn from real hitbox data).
  if (attacking) {
    const boxes = debugBoxes(game)[i];
    if (boxes) {
      for (const hb of boxes.hitboxes) {
        ctx.fillStyle = c.accent;
        ctx.fillRect(sx(hb.x) - x, sy(hb.y) - y, hb.w, hb.h);
      }
    }
  }
  ctx.restore();
};

const drawProjectiles = (): void => {
  for (const p of game.projectiles) {
    if (!p.active) continue;
    const x = sx(px(p.x));
    const y = sy(px(p.y));
    const owner = P_COLORS[p.owner as 0 | 1];
    ctx.fillStyle = owner.accent;
    ctx.beginPath();
    ctx.arc(x, y, 14, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(x - px(p.velX) * 1.5, y, 8, 0, Math.PI * 2);
    ctx.fill();
  }
};

// ---------------------------------------------------------------- HUD
const drawMeter = (i: 0 | 1): void => {
  const f = game.fighters[i];
  const segW = 90, segH = 10, gap = 4, pad = 30, bottom = VH - 40;
  const bars = TUNING.meterMax / TUNING.meterBar;
  for (let b = 0; b < bars; b++) {
    const x = i === 0 ? pad + b * (segW + gap) : VW - pad - segW - b * (segW + gap);
    const segMeter = Math.max(0, Math.min(TUNING.meterBar, f.meter - b * TUNING.meterBar));
    const ratio = segMeter / TUNING.meterBar;
    ctx.fillStyle = '#222738';
    ctx.fillRect(x, bottom, segW, segH);
    ctx.fillStyle = ratio >= 1 ? '#ffd166' : '#9a7bd6';
    const fw = Math.round(segW * ratio);
    ctx.fillRect(i === 0 ? x : x + segW - fw, bottom, fw, segH);
    ctx.strokeStyle = '#ffffff33';
    ctx.strokeRect(x + 0.5, bottom + 0.5, segW, segH);
  }
};

const drawHud = (): void => {
  const barW = 380, barH = 22, pad = 30, top = 24;
  for (const i of [0, 1] as const) {
    const f = game.fighters[i];
    const ratio = Math.max(0, f.health) / MAXHP;
    const x = i === 0 ? pad : VW - pad - barW;
    ctx.fillStyle = '#222738';
    ctx.fillRect(x, top, barW, barH);
    ctx.fillStyle = ratio > 0.3 ? '#ffd166' : '#e94560';
    const fillW = Math.round(barW * ratio);
    // Drain toward center: remaining health hugs the outer screen edge.
    ctx.fillRect(i === 0 ? x : x + barW - fillW, top, fillW, barH);
    ctx.strokeStyle = '#ffffff33';
    ctx.strokeRect(x + 0.5, top + 0.5, barW, barH);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 13px monospace';
    ctx.textAlign = i === 0 ? 'left' : 'right';
    ctx.fillText(`${P_COLORS[i].name} · ${characters[i].b.name}`, i === 0 ? x : x + barW, top + barH + 16);
    // Round pips.
    const wins = i === 0 ? game.roundsWon0 : game.roundsWon1;
    for (let r = 0; r < TUNING.roundsToWin; r++) {
      const cx = i === 0 ? x + 8 + r * 18 : x + barW - 8 - r * 18;
      ctx.beginPath();
      ctx.arc(cx, top + barH + 32, 6, 0, Math.PI * 2);
      ctx.fillStyle = r < wins ? '#ffd166' : '#222738';
      ctx.fill();
      ctx.strokeStyle = '#ffffff44';
      ctx.stroke();
    }
    drawMeter(i);
  }

  // Combo counter: hits the *opponent* has taken, shown on the attacker's side.
  for (const i of [0, 1] as const) {
    const hits = game.fighters[1 - i]!.comboHits;
    const vicAction = game.fighters[1 - i]!.action;
    const inCombo = vicAction === Action.Hitstun || vicAction === Action.AirHitstun;
    if (hits >= 2 && inCombo) {
      ctx.fillStyle = '#ffd166';
      ctx.font = 'bold 34px monospace';
      ctx.textAlign = i === 0 ? 'left' : 'right';
      ctx.fillText(`${hits} HITS`, i === 0 ? pad : VW - pad, 150);
    }
  }

  // Timer.
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 30px monospace';
  ctx.textAlign = 'center';
  ctx.fillText(String(Math.max(0, Math.ceil(game.timerTicks / TICKS_PER_SEC))).padStart(2, '0'), VW / 2, top + 24);

  ctx.font = '11px monospace';
  ctx.fillStyle = '#ffffff88';
  ctx.fillText('P1: WASD + TYU/GHJ · P2: Arrows + IOP/KL; · B: hitboxes · Enter: rematch', VW / 2, VH - 12);

  // Phase banners.
  const banner = (main: string, sub?: string): void => {
    ctx.fillStyle = '#000000aa';
    ctx.fillRect(0, VH / 2 - 70, VW, 120);
    ctx.fillStyle = '#ffd166';
    ctx.font = 'bold 52px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(main, VW / 2, VH / 2);
    if (sub) {
      ctx.font = '16px monospace';
      ctx.fillStyle = '#fff';
      ctx.fillText(sub, VW / 2, VH / 2 + 32);
    }
  };
  if (game.phase === Phase.PreRound) {
    banner(game.phaseTimer > TUNING.preRoundTicks / 3 ? `ROUND ${game.roundNum + 1}` : 'FIGHT!');
  } else if (game.phase === Phase.RoundOver) {
    banner(game.roundWinner === 2 ? 'DRAW' : 'KO',
      game.roundWinner === 2 ? '' : `${P_COLORS[game.roundWinner as 0 | 1].name} takes the round`);
  } else if (game.phase === Phase.MatchOver) {
    banner(game.winner === 2 ? 'DRAW' : `${P_COLORS[game.winner as 0 | 1].name} WINS`,
      'Press Enter for rematch');
  }
};

const drawDebug = (): void => {
  if (!showBoxes) return;
  const boxes = debugBoxes(game);
  for (const b of boxes) {
    ctx.strokeStyle = '#4ade80';
    for (const hb of b.hurtboxes) ctx.strokeRect(sx(hb.x) + 0.5, sy(hb.y) + 0.5, hb.w, hb.h);
    ctx.strokeStyle = '#f87171';
    for (const hb of b.hitboxes) ctx.strokeRect(sx(hb.x) + 0.5, sy(hb.y) + 0.5, hb.w, hb.h);
  }
  const info = debugInfo(game);
  ctx.font = '11px monospace';
  for (const i of [0, 1] as const) {
    const d = info[i]!;
    const f = game.fighters[i];
    ctx.fillStyle = '#a3ffb0';
    ctx.textAlign = i === 0 ? 'left' : 'right';
    const lines = [
      `${ACTION_NAMES[d.action]} ${d.moveId} f${d.moveFrame} ${d.phase}`,
      `meter ${d.meter} juggle ${d.juggleBudget} taken ${d.comboHitsTaken}`,
      `motion ${d.lastMotion || '-'} pos ${px(f.x)},${px(f.y)}`,
    ];
    lines.forEach((ln, k) => ctx.fillText(ln, i === 0 ? 8 : VW - 8, 96 + k * 13));
  }
  ctx.fillStyle = '#ffffff66';
  ctx.textAlign = 'center';
  ctx.fillText(`tick ${game.tick}  hash ${stateHash(game).toString(16).padStart(8, '0')}`, VW / 2, VH - 28);
};

// ---------------------------------------------------------------- stage
const drawStage = (): void => {
  const grad = ctx.createLinearGradient(0, 0, 0, VH);
  grad.addColorStop(0, '#141625');
  grad.addColorStop(1, '#1f2233');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, VW, VH);

  // Parallax back wall pillars (move at half camera speed).
  ctx.fillStyle = '#1b1e30';
  for (let wx = 0; wx < STAGE.widthPx; wx += 160) {
    const x = wx - camX * 0.5;
    if (x > -40 && x < VW + 40) ctx.fillRect(x, sy(120), 26, STAGE.floorYPx - 120);
  }

  // Floor.
  const floorY = sy(STAGE.floorYPx);
  ctx.fillStyle = '#2b2f45';
  ctx.fillRect(0, floorY, VW, VH - floorY + 200);
  ctx.strokeStyle = '#3d4260';
  ctx.beginPath();
  ctx.moveTo(0, floorY + 0.5);
  ctx.lineTo(VW, floorY + 0.5);
  ctx.stroke();
  // Floor seams scroll with the world (sells the camera).
  ctx.strokeStyle = '#353a55';
  for (let wx = 0; wx < STAGE.widthPx; wx += 80) {
    const x = sx(wx);
    if (x < -10 || x > VW + 10) continue;
    ctx.beginPath();
    ctx.moveTo(x, floorY);
    ctx.lineTo(x - 30, VH);
    ctx.stroke();
  }
  // Stage edges.
  ctx.fillStyle = '#12141f';
  const leftEdge = sx(0);
  const rightEdge = sx(STAGE.widthPx);
  if (leftEdge > 0) ctx.fillRect(0, 0, leftEdge, VH);
  if (rightEdge < VW) ctx.fillRect(rightEdge, 0, VW - rightEdge, VH);
};

// ---------------------------------------------------------------- render
const render = (): void => {
  ctx.save();
  if (shake > 0) ctx.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake); // cosmetic only

  drawStage();
  drawFighter(0);
  drawFighter(1);
  drawProjectiles();

  // Super flash: dark cinema + flash the super's owner.
  if (game.superFlashLeft > 0) {
    ctx.fillStyle = `rgba(0,0,10,0.72)`;
    ctx.fillRect(0, 0, VW, VH);
    const owner = game.fighters[0].action === Action.Attack
      && characters[0].b.moves[game.fighters[0].moveIdx]?.type === 'super' ? 0 : 1;
    const f = game.fighters[owner as 0 | 1];
    ctx.fillStyle = game.superFlashLeft % 4 < 2 ? '#ffffff' : P_COLORS[owner as 0 | 1].accent;
    ctx.fillRect(sx(px(f.x)) - 26, sy(px(f.y)) - 108, 52, 108);
  }

  // Hit sparks (cosmetic).
  for (const sp of sparks) {
    const r = (sp.big ? 8 : 4) + sp.age * (sp.big ? 5 : 3);
    ctx.strokeStyle = `rgba(255, 209, 102, ${1 - sp.age / 8})`;
    ctx.lineWidth = sp.big ? 4 : 3;
    ctx.beginPath();
    ctx.arc(sx(sp.x), sy(sp.y), r, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.lineWidth = 1;

  drawDebug();
  drawHud();
  ctx.restore();
};

// ---------------------------------------------------------------- loop
let last = performance.now();
let acc = 0;

const frame = (now: number): void => {
  acc += now - last;
  last = now;
  if (acc > 200) acc = 200; // tab-switch guard

  while (acc >= TICK_MS) {
    const inputs: [InputFrame, InputFrame] = [pollKeyboard(P0_MAP), pollKeyboard(P1_MAP)];
    if (game.phase !== Phase.MatchOver) inputLog.push(inputs);
    step(game, inputs);
    acc -= TICK_MS;

    // Juice triggers: detect damage outside the sim.
    for (const i of [0, 1] as const) {
      const f = game.fighters[i];
      if (f.health < prevHealth[i]!) {
        const big = prevHealth[i]! - f.health > 600;
        sparks.push({ x: px(f.x) + f.facing * -20, y: px(f.y) - 85, age: 0, big });
        shake = big ? 10 : 6;
      }
      prevHealth[i] = f.health;
    }
  }
  sparks = sparks.filter((sp) => ++sp.age < 8);
  shake = Math.max(0, shake - 0.6);

  updateCamera();
  render();
  requestAnimationFrame(frame);
};

requestAnimationFrame(frame);

// Expose for console poking / future replay export (input log = full match record).
Object.assign(globalThis, { afGame: () => game, afInputLog: () => inputLog });
