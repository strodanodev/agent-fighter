/**
 * Agent Fighter — Milestone 0 client.
 * Renderer is a pure function of GameState (plus cosmetic-only juice that
 * lives OUTSIDE the sim). Fixed-timestep 60Hz loop with an accumulator.
 * Canvas 2D for M0 (zero deps); the render() boundary is where PixiJS slots in.
 */
import {
  Action, Btn, Phase, STAGE, TICKS_PER_SEC,
  createGameState, debugBoxes, stateHash, step,
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

const P0_MAP: [string, Btn][] = [
  ['KeyA', Btn.Left], ['KeyD', Btn.Right], ['KeyW', Btn.Up], ['KeyS', Btn.Down], ['KeyF', Btn.Attack],
];
const P1_MAP: [string, Btn][] = [
  ['ArrowLeft', Btn.Left], ['ArrowRight', Btn.Right], ['ArrowUp', Btn.Up], ['ArrowDown', Btn.Down], ['KeyK', Btn.Attack],
];

const pollKeyboard = (map: [string, Btn][]): InputFrame => {
  let f = 0;
  for (const [code, bit] of map) if (keys.has(code)) f |= bit;
  return f;
};

// ---------------------------------------------------------------- game
let game: GameState = createGameState(1);
let showBoxes = true;
let inputLog: [InputFrame, InputFrame][] = [];

// Cosmetic juice (never simulated — safe under future rollback).
interface Spark { x: number; y: number; age: number }
let sparks: Spark[] = [];
let shake = 0;
let prevHealth = [game.fighters[0].health, game.fighters[1].health];

addEventListener('keydown', (e) => {
  if (e.code === 'KeyH') showBoxes = !showBoxes;
  if (e.code === 'Enter' && game.phase === Phase.Over) {
    game = createGameState((game.rngSeed + 1) | 0);
    inputLog = [];
    sparks = [];
    prevHealth = [game.fighters[0].health, game.fighters[1].health];
  }
});

// ---------------------------------------------------------------- canvas
const canvas = document.getElementById('game') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const W = STAGE.widthPx;
const H = 540;

const px = (fpv: number): number => Math.trunc(fpv / 256);

const P_COLORS = [
  { body: '#e94560', accent: '#ff8fa3', name: 'P1' },
  { body: '#4ea8de', accent: '#a3d5ff', name: 'P2' },
] as const;

const drawFighter = (i: 0 | 1): void => {
  const f = game.fighters[i];
  const c = P_COLORS[i];
  const x = px(f.x);
  const y = px(f.y);
  const w = 56;
  const h = 110;

  // Body: a rectangle with intent. Lean forward on attack, flash white in hitstun.
  const inHitstun = f.action === Action.Hitstun;
  const attacking = f.action === Action.Attack;
  ctx.save();
  ctx.translate(x, y);
  if (attacking) ctx.transform(1, 0, -0.08 * f.facing, 1, 0, 0);
  ctx.fillStyle = inHitstun && game.tick % 4 < 2 ? '#ffffff' : f.action === Action.KO ? '#555' : c.body;
  ctx.fillRect(-w / 2, -h, w, h);
  // "Face" stripe shows facing.
  ctx.fillStyle = c.accent;
  ctx.fillRect(f.facing === 1 ? w / 2 - 10 : -w / 2, -h, 10, 26);
  // Fist block during active frames.
  if (attacking) {
    const boxes = debugBoxes(game)[i];
    if (boxes && boxes.hitbox) {
      ctx.fillStyle = c.accent;
      ctx.fillRect(boxes.hitbox.x - x, boxes.hitbox.y - y, boxes.hitbox.w, boxes.hitbox.h);
    }
  }
  ctx.restore();
};

const drawHud = (): void => {
  const barW = 380, barH = 22, pad = 30, top = 24;
  for (const i of [0, 1] as const) {
    const f = game.fighters[i];
    const ratio = Math.max(0, f.health) / 1000;
    const x = i === 0 ? pad : W - pad - barW;
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
    ctx.fillText(P_COLORS[i].name, i === 0 ? x : x + barW, top + barH + 16);
  }
  // Timer.
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 30px monospace';
  ctx.textAlign = 'center';
  ctx.fillText(String(Math.ceil(game.timerTicks / TICKS_PER_SEC)).padStart(2, '0'), W / 2, top + 24);

  ctx.font = '11px monospace';
  ctx.fillStyle = '#ffffff88';
  ctx.fillText('P1: WASD + F   ·   P2: Arrows + K   ·   H: hitboxes   ·   Enter: rematch', W / 2, H - 12);
  ctx.fillText(`tick ${game.tick}  hash ${stateHash(game).toString(16).padStart(8, '0')}`, W / 2, H - 28);

  if (game.phase === Phase.Over) {
    ctx.fillStyle = '#000000aa';
    ctx.fillRect(0, H / 2 - 70, W, 120);
    ctx.fillStyle = '#ffd166';
    ctx.font = 'bold 52px monospace';
    ctx.fillText(game.winner === 2 ? 'DRAW' : `${P_COLORS[game.winner as 0 | 1].name} WINS`, W / 2, H / 2);
    ctx.font = '16px monospace';
    ctx.fillStyle = '#fff';
    ctx.fillText('Press Enter for rematch', W / 2, H / 2 + 32);
  }
};

const render = (): void => {
  ctx.save();
  if (shake > 0) ctx.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake); // cosmetic only

  // Stage.
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, '#141625');
  grad.addColorStop(1, '#1f2233');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#2b2f45';
  ctx.fillRect(0, STAGE.floorYPx, W, H - STAGE.floorYPx);
  ctx.strokeStyle = '#3d4260';
  ctx.beginPath();
  ctx.moveTo(0, STAGE.floorYPx + 0.5);
  ctx.lineTo(W, STAGE.floorYPx + 0.5);
  ctx.stroke();

  drawFighter(0);
  drawFighter(1);

  // Hit sparks (cosmetic).
  for (const sp of sparks) {
    const r = 4 + sp.age * 3;
    ctx.strokeStyle = `rgba(255, 209, 102, ${1 - sp.age / 8})`;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(sp.x, sp.y, r, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.lineWidth = 1;

  // Debug boxes.
  if (showBoxes) {
    for (const b of debugBoxes(game)) {
      ctx.strokeStyle = '#4ade80';
      ctx.strokeRect(b.hurtbox.x + 0.5, b.hurtbox.y + 0.5, b.hurtbox.w, b.hurtbox.h);
      if (b.hitbox) {
        ctx.strokeStyle = '#f87171';
        ctx.strokeRect(b.hitbox.x + 0.5, b.hitbox.y + 0.5, b.hitbox.w, b.hitbox.h);
      }
    }
  }

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
    if (game.phase === Phase.Fighting) inputLog.push(inputs);
    step(game, inputs);
    acc -= TICK_MS;

    // Juice triggers: detect damage outside the sim.
    for (const i of [0, 1] as const) {
      if (game.fighters[i].health < prevHealth[i]!) {
        const f = game.fighters[i];
        sparks.push({ x: px(f.x) + f.facing * -20, y: px(f.y) - 85, age: 0 });
        shake = 7;
      }
      prevHealth[i] = game.fighters[i].health;
    }
  }
  sparks = sparks.filter((sp) => ++sp.age < 8);
  shake = Math.max(0, shake - 0.6);

  render();
  requestAnimationFrame(frame);
};

requestAnimationFrame(frame);

// Expose for console poking / future replay export (input log = full match record).
Object.assign(globalThis, { afGame: () => game, afInputLog: () => inputLog });
