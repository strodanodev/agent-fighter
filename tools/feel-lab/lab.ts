/**
 * FEEL LAB — a local bench for tuning the game's feel and testing matchups.
 *
 * It embeds the REAL @af/core sim (the exact code that ships), runs a live
 * human-vs-AI match with the debug overlay, and exposes:
 *   · every TUNING knob as a live slider — the sim reads TUNING each step, so
 *     hitstop / pushback / gravity / scaling changes are felt IMMEDIATELY;
 *   · feel diagnostics — per-fighter action/move/phase/frame, hitstop, combo
 *     scaling, juggle budget, and a P0 input-history strip;
 *   · an AI opponent picker (skill + personality style) so the personality
 *     variety is visible side by side.
 *
 * LOCAL ONLY. It calls applyTuning, which the shipped client and the server
 * verifier never do — so nothing here can affect an online/verified match.
 * Character bundles are injected at build time as window.__LAB_BUNDLES__.
 */
import {
  createGameState, step, setCharacters, loadCharacter,
  Phase, Btn, STAGE, TICKS_PER_SEC,
  TUNING, TUNING_DEFAULTS, applyTuning, resetTuning, CHAR_TUNING_KEYS,
  debugBoxes, debugInfo,
  characters, createAi, aiPoll,
} from '@af/core';
import type { GameState, AiState, CharacterBundle, CharTuning, InputFrame } from '@af/core';

// ------------------------------------------------------------------- bundles
const BUNDLES = (window as unknown as { __LAB_BUNDLES__: Record<string, CharacterBundle> }).__LAB_BUNDLES__ ?? {};
const IDS = Object.keys(BUNDLES).sort();
if (IDS.length === 0) throw new Error('no character bundles were embedded at build time');
const nameOf = (id: string): string => (BUNDLES[id] as { name?: string })?.name ?? id;

// --------------------------------------------------------------- AI styles
// Mirrors the arcade signature styles (server.ts ARCADE_STYLES) so the Lab
// shows the SAME personalities the gauntlet uses.
type Style = Record<string, number>;
const STYLES: Record<string, Style | null> = {
  'random (seed)': null,
  rushdown: { aggression: 210, jumpiness: 120, zoner: 45, throwHappy: 110, pushblocker: 90, patience: 70 },
  zoner: { aggression: 110, jumpiness: 55, zoner: 205, throwHappy: 40, pushblocker: 120, patience: 190 },
  turtle: { aggression: 100, jumpiness: 45, zoner: 120, throwHappy: 60, pushblocker: 210, patience: 195 },
  jumpy: { aggression: 175, jumpiness: 185, zoner: 70, throwHappy: 70, pushblocker: 80, patience: 90 },
  grappler: { aggression: 200, jumpiness: 50, zoner: 45, throwHappy: 150, pushblocker: 140, patience: 120 },
  'all-rounder': { aggression: 150, jumpiness: 110, zoner: 120, throwHappy: 90, pushblocker: 140, patience: 130 },
};

// P1 control mode.
type P1Mode = 'ai' | 'stand' | 'crouch-block' | 'jump' | 'human';

// ----------------------------------------------------------------- match state
interface Sel { p0: string; p1: string; skill: number; style: string; mode: P1Mode; }
const sel: Sel = { p0: IDS[0]!, p1: IDS[Math.min(1, IDS.length - 1)]!, skill: 60, style: 'rushdown', mode: 'ai' };

let game: GameState;
let ai: AiState | null = null;
let seedN = 1;
// Damage bookkeeping (last combo dealt to each side), for the readout.
let lastHp: [number, number] = [0, 0];
let comboDmg: [number, number] = [0, 0];
const inputHist: number[] = []; // P0 InputFrames, most-recent last

// Per-character tuning overrides the user dials in the Lab (empty = the
// character's own bundle value, or the global TUNING default). Applied on top
// of the bundle at load, so it rides the same validated path as a shipped
// archetype override.
const labTun: [Record<string, number>, Record<string, number>] = [{}, {}];
const mkChar = (id: string, side: 0 | 1) => {
  const b = BUNDLES[id]!;
  // Always clone (never the shared embedded bundle) so live edits to
  // characters[side].b.tuning can't pollute another match.
  return loadCharacter({ ...b, tuning: { ...(b as { tuning?: CharTuning }).tuning, ...labTun[side] } });
};

const resetMatch = (): void => {
  setCharacters(mkChar(sel.p0, 0), mkChar(sel.p1, 1));
  game = createGameState((seedN = (seedN * 1103515245 + 12345) & 0x7fffffff));
  const style = STYLES[sel.style] ?? undefined;
  ai = createAi(1, sel.skill, (seedN ^ 0xabcd) | 0, style ?? undefined);
  lastHp = [game.fighters[0].health, game.fighters[1].health];
  comboDmg = [0, 0];
  inputHist.length = 0;
};

// ------------------------------------------------------------------- input
const held = new Set<string>();
const P0_KEYS: Record<string, number> = {
  KeyA: Btn.Left, KeyD: Btn.Right, KeyW: Btn.Up, KeyS: Btn.Down,
  KeyU: Btn.LP, KeyI: Btn.MP, KeyO: Btn.HP,
  KeyJ: Btn.LK, KeyK: Btn.MK, KeyL: Btn.HK,
};
const P1_KEYS: Record<string, number> = {
  ArrowLeft: Btn.Left, ArrowRight: Btn.Right, ArrowUp: Btn.Up, ArrowDown: Btn.Down,
  Numpad4: Btn.LP, Numpad5: Btn.MP, Numpad6: Btn.HP,
  Numpad1: Btn.LK, Numpad2: Btn.MK, Numpad3: Btn.HK,
};
const pollKeys = (map: Record<string, number>): InputFrame => {
  let f = 0;
  for (const k in map) if (held.has(k)) f |= map[k]!;
  return f as InputFrame;
};
addEventListener('keydown', (e) => {
  if (e.code in P0_KEYS || e.code in P1_KEYS || e.code === 'KeyR') {
    held.add(e.code);
    e.preventDefault();
    if (e.code === 'KeyR') resetMatch();
  }
});
addEventListener('keyup', (e) => held.delete(e.code));

const pollP1 = (): InputFrame => {
  switch (sel.mode) {
    case 'ai': return ai ? aiPoll(ai, game) : 0 as InputFrame;
    case 'stand': return 0 as InputFrame;
    case 'crouch-block': return (game.fighters[1].facing === 1 ? Btn.Left : Btn.Right) | Btn.Down as InputFrame;
    case 'jump': return (game.fighters[1].action === 0 ? Btn.Up : 0) as InputFrame; // hop when idle
    case 'human': return pollKeys(P1_KEYS);
  }
};

// ------------------------------------------------------------------- render
const CANVAS_W = 960, CANVAS_H = 400;
const SCALE = CANVAS_W / STAGE.widthPx;
const sx = (wx: number): number => wx * SCALE;
const sy = (wy: number): number => wy * SCALE;

const drawGame = (ctx: CanvasRenderingContext2D): void => {
  ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
  // backdrop + floor + walls
  ctx.fillStyle = '#11151c';
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
  const floor = sy(STAGE.floorYPx);
  ctx.strokeStyle = '#33405a'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(0, floor); ctx.lineTo(CANVAS_W, floor); ctx.stroke();
  ctx.strokeStyle = '#222a38';
  ctx.strokeRect(sx(STAGE.wallPad), 0, sx(STAGE.widthPx - STAGE.wallPad * 2), floor);

  // hitstop flash — the "crunch" made visible
  if (game.hitstopLeft > 0) { ctx.fillStyle = 'rgba(255,240,180,0.06)'; ctx.fillRect(0, 0, CANVAS_W, CANVAS_H); }

  const boxes = debugBoxes(game);
  for (let i = 0; i < 2; i++) {
    const f = game.fighters[i]!;
    const b = boxes[i]!;
    // hurtboxes (the body) — team-tinted outline
    ctx.strokeStyle = i === 0 ? '#4fd1ff' : '#ff8a5c'; ctx.lineWidth = 1.5;
    for (const h of b.hurtboxes) ctx.strokeRect(sx(h.x), sy(h.y), sx(h.w), sy(h.h));
    // hitboxes (active attack) — red
    ctx.fillStyle = 'rgba(255,60,60,0.30)'; ctx.strokeStyle = '#ff3c3c';
    for (const h of b.hitboxes) { ctx.fillRect(sx(h.x), sy(h.y), sx(h.w), sy(h.h)); ctx.strokeRect(sx(h.x), sy(h.y), sx(h.w), sy(h.h)); }
    // feet marker + facing
    const fx = sx(f.x / 256), fy = sy(f.y / 256);
    ctx.fillStyle = i === 0 ? '#4fd1ff' : '#ff8a5c';
    ctx.fillRect(fx - 2, fy - 2, 4, 4);
    ctx.fillRect(fx, fy - 26, f.facing * 10, 3);
  }
  // projectiles
  ctx.fillStyle = '#ffe27a';
  for (const p of game.projectiles) if (p.active) ctx.fillRect(sx(p.x / 256) - 4, sy(p.y / 256) - 4, 8, 8);
};

// ------------------------------------------------------------------- diagnostics DOM
const $ = (id: string): HTMLElement => document.getElementById(id)!;
const actionName = (n: number): string => `#${n}`;

const bar = (val: number, max: number, color: string): string =>
  `<div class="bar"><span style="width:${Math.max(0, Math.min(100, (val / max) * 100))}%;background:${color}"></span></div>`;

const glyph = (f: number): string => {
  let s = '';
  if (f & Btn.Up) s += '↑'; if (f & Btn.Down) s += '↓';
  if (f & Btn.Left) s += '←'; if (f & Btn.Right) s += '→';
  if (f & Btn.LP) s += 'a'; if (f & Btn.MP) s += 'b'; if (f & Btn.HP) s += 'c';
  if (f & Btn.LK) s += 'x'; if (f & Btn.MK) s += 'y'; if (f & Btn.HK) s += 'z';
  return s || '·';
};

let uiTick = 0;
const drawDiag = (): void => {
  if (uiTick++ % 3 !== 0) return; // throttle DOM writes
  const info = debugInfo(game);
  const f0 = game.fighters[0]!, f1 = game.fighters[1]!;
  const ch0 = BUNDLES[sel.p0] as { maxHealth?: number }, ch1 = BUNDLES[sel.p1] as { maxHealth?: number };
  const side = (i: number, f: typeof f0, ch: { maxHealth?: number }, id: string): string => {
    const d = info[i]!;
    return `<div class="fi">
      <div class="fh"><b style="color:${i === 0 ? '#4fd1ff' : '#ff8a5c'}">${i === 0 ? 'P0 (you)' : 'P1'}</b> ${nameOf(id)}</div>
      ${bar(f.health, ch.maxHealth ?? 10000, i === 0 ? '#4fd1ff' : '#ff8a5c')}
      <div class="k">HP <b>${f.health}</b> · meter <b>${f.meter}</b>/${TUNING.meterMax}</div>
      ${bar(f.meter, TUNING.meterMax, '#c9a24b')}
      <div class="k">move <b>${d.moveId || actionName(d.action)}</b> · ${d.phase || '—'} · f${d.moveFrame}</div>
      <div class="k">hitstun <b>${f.hitstunLeft}</b> · comboHits <b>${d.comboHitsTaken}</b> · juggle <b>${d.juggleBudget}</b> · scale <b>${(f.comboScaling / 10).toFixed(0)}%</b></div>
      <div class="k">last combo dealt to this side: <b>${comboDmg[i]}</b></div>
    </div>`;
  };
  // frame-advantage-ish signal: when one side is in stun and the other is free.
  const adv = f1.hitstunLeft > 0 && f0.hitstunLeft === 0 ? `P0 +${f1.hitstunLeft}`
    : f0.hitstunLeft > 0 && f1.hitstunLeft === 0 ? `P1 +${f0.hitstunLeft}` : '—';
  $('diag').innerHTML =
    `<div class="crunch ${game.hitstopLeft > 0 ? 'on' : ''}">HITSTOP ${game.hitstopLeft}</div>
     <div class="k big">advantage: <b>${adv}</b> · round ${game.roundsWon0}-${game.roundsWon1} · phase ${game.phase}</div>
     ${side(0, f0, ch0, sel.p0)}${side(1, f1, ch1, sel.p1)}
     <div class="hist">${inputHist.slice(-46).map(glyph).map((g) => `<span>${g}</span>`).join('')}</div>`;
};

// ------------------------------------------------------------------- tuning UI
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const KEYS = Object.keys(TUNING_DEFAULTS) as (keyof typeof TUNING_DEFAULTS)[];
const syncers: (() => void)[] = [];

const buildTuning = (): void => {
  const root = $('tuning');
  root.innerHTML = '';
  for (const k of KEYS) {
    const def = (TUNING_DEFAULTS as Record<string, number | boolean>)[k]!;
    const row = document.createElement('div'); row.className = 'trow';
    const label = document.createElement('label'); label.textContent = k;
    row.appendChild(label);
    if (isBool(def)) {
      const cb = document.createElement('input'); cb.type = 'checkbox';
      cb.checked = (TUNING as Record<string, boolean>)[k]!;
      cb.onchange = () => applyTuning({ [k]: cb.checked } as never);
      syncers.push(() => { cb.checked = (TUNING as Record<string, boolean>)[k]!; });
      row.appendChild(cb);
    } else {
      const d = def as number;
      const intStep = Number.isInteger(d);
      const max = d > 0 ? Math.max(d * 3, intStep ? 4 : 1) : 100;
      const slider = document.createElement('input');
      slider.type = 'range'; slider.min = '0'; slider.max = String(max);
      slider.step = intStep ? '1' : '0.05';
      slider.value = String((TUNING as Record<string, number>)[k]!);
      const out = document.createElement('input'); out.type = 'number'; out.className = 'num';
      out.step = slider.step; out.value = slider.value;
      const set = (v: number) => { applyTuning({ [k]: v } as never); slider.value = String(v); out.value = String(v); };
      slider.oninput = () => set(intStep ? Math.round(+slider.value) : +slider.value);
      out.onchange = () => set(intStep ? Math.round(+out.value) : +out.value);
      syncers.push(() => { const v = (TUNING as Record<string, number>)[k]!; slider.value = String(v); out.value = String(v); });
      row.appendChild(slider); row.appendChild(out);
    }
    root.appendChild(row);
  }
};
const syncTuning = (): void => { for (const s of syncers) s(); };

// -------------------------------------------------- per-character tuning UI
// Push the current per-character overrides onto the LIVE loaded character so a
// change is felt this tick (no match reset). Only integer≥1 values are stored,
// so this can never inject a NaN duration that would soft-lock a state.
const applyCharTun = (side: 0 | 1): void => {
  const ch = characters[side];
  if (!ch) return;
  const own = (BUNDLES[side === 0 ? sel.p0 : sel.p1] as { tuning?: CharTuning }).tuning;
  (ch.b as { tuning?: CharTuning }).tuning = { ...own, ...labTun[side] };
};
const buildCharTuning = (): void => {
  const root = $('chartun');
  const col = (side: 0 | 1): string => {
    const id = side === 0 ? sel.p0 : sel.p1;
    const own = ((BUNDLES[id] as { tuning?: CharTuning }).tuning ?? {}) as Record<string, number>;
    const inputs = CHAR_TUNING_KEYS.map((k) => {
      const def = own[k] ?? (TUNING_DEFAULTS as Record<string, number>)[k];
      const cur = labTun[side][k];
      return `<div class="ctrow"><label>${k}</label><input data-side="${side}" data-key="${k}" type="number" min="1" step="1" placeholder="${def}" value="${cur ?? ''}"></div>`;
    }).join('');
    return `<div class="ctcol"><div class="cth" style="color:${side === 0 ? '#4fd1ff' : '#ff8a5c'}">${side === 0 ? 'P0' : 'P1'} ${nameOf(id)}</div>${inputs}</div>`;
  };
  root.innerHTML = col(0) + col(1);
  root.querySelectorAll('input').forEach((el) => {
    const inp = el as HTMLInputElement;
    inp.onchange = () => {
      const side = Number(inp.dataset.side) as 0 | 1;
      const key = inp.dataset.key!;
      const v = parseInt(inp.value, 10);
      if (Number.isInteger(v) && v >= 1) labTun[side][key] = v;
      else { delete labTun[side][key]; inp.value = ''; }
      applyCharTun(side); // live — no match reset
    };
  });
};

// ------------------------------------------------------------------- match controls DOM
const opt = (v: string, cur: string): string => `<option value="${v}" ${v === cur ? 'selected' : ''}>${v}</option>`;
const buildControls = (): void => {
  const charOpts = (cur: string) => IDS.map((id) => `<option value="${id}" ${id === cur ? 'selected' : ''}>${nameOf(id)}</option>`).join('');
  $('controls').innerHTML = `
    <div class="crow"><label>P0</label><select id="selP0">${charOpts(sel.p0)}</select></div>
    <div class="crow"><label>P1</label><select id="selP1">${charOpts(sel.p1)}</select></div>
    <div class="crow"><label>P1 mode</label><select id="selMode">${(['ai', 'stand', 'crouch-block', 'jump', 'human'] as P1Mode[]).map((m) => opt(m, sel.mode)).join('')}</select></div>
    <div class="crow"><label>AI skill</label><input id="selSkill" type="range" min="0" max="100" value="${sel.skill}"><span id="skillV">${sel.skill}</span></div>
    <div class="crow"><label>AI style</label><select id="selStyle">${Object.keys(STYLES).map((s) => opt(s, sel.style)).join('')}</select></div>
    <div class="crow"><button id="btnReset">reset match (R)</button></div>`;
  ($('selP0') as HTMLSelectElement).onchange = (e) => { sel.p0 = (e.target as HTMLSelectElement).value; labTun[0] = {}; resetMatch(); buildCharTuning(); };
  ($('selP1') as HTMLSelectElement).onchange = (e) => { sel.p1 = (e.target as HTMLSelectElement).value; labTun[1] = {}; resetMatch(); buildCharTuning(); };
  ($('selMode') as HTMLSelectElement).onchange = (e) => { sel.mode = (e.target as HTMLSelectElement).value as P1Mode; };
  ($('selStyle') as HTMLSelectElement).onchange = (e) => { sel.style = (e.target as HTMLSelectElement).value; resetMatch(); };
  const sk = $('selSkill') as HTMLInputElement;
  sk.oninput = () => { sel.skill = +sk.value; $('skillV').textContent = sk.value; resetMatch(); };
  ($('btnReset') as HTMLButtonElement).onclick = () => resetMatch();
};

// ------------------------------------------------------------------- loop
const TICK_MS = 1000 / TICKS_PER_SEC;
let acc = 0, last = performance.now();
const ctx = ($('cv') as HTMLCanvasElement).getContext('2d')!;

const tick = (): void => {
  const p0 = pollKeys(P0_KEYS);
  const p1 = pollP1();
  const before: [number, number] = [game.fighters[0].health, game.fighters[1].health];
  step(game, [p0, p1]);
  inputHist.push(p0);
  if (inputHist.length > 200) inputHist.shift();
  // combo damage: accumulate while a side keeps losing HP without recovering
  for (let i = 0; i < 2; i++) {
    const lost = before[i] - game.fighters[i]!.health;
    if (lost > 0) comboDmg[i] = (game.fighters[i]!.comboHits <= 1 ? 0 : comboDmg[i]) + lost;
    lastHp[i] = game.fighters[i]!.health;
  }
};

const frame = (now: number): void => {
  requestAnimationFrame(frame);
  acc += now - last; last = now;
  if (acc > 200) acc = 200; // don't spiral after a stall
  let steps = 0;
  while (acc >= TICK_MS && steps < 8) { tick(); acc -= TICK_MS; steps++; }
  drawGame(ctx);
  drawDiag();
};

// ------------------------------------------------------------------- boot
buildControls();
buildTuning();
buildCharTuning();
$('btnResetTuning').onclick = () => { resetTuning(); syncTuning(); };
$('btnExport').onclick = () => {
  const json = JSON.stringify(TUNING, null, 2);
  (navigator.clipboard?.writeText(json) ?? Promise.reject()).then(
    () => { ($('btnExport') as HTMLButtonElement).textContent = 'copied!'; setTimeout(() => ($('btnExport') as HTMLButtonElement).textContent = 'export TUNING', 1200); },
    () => { ($('exportOut') as HTMLTextAreaElement).value = json; ($('exportOut') as HTMLElement).style.display = 'block'; },
  );
};
resetMatch();
requestAnimationFrame(frame);
