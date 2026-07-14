/**
 * Agent Fighter Studio — character authoring tool (spec §5.2).
 * Embeds @af/core so the live preview IS the game engine: what you see in
 * the Test tab is exactly what ships. No framework; coarse re-render DOM.
 *
 * Tabs: Character (params) · Frames (timeline + visual boxes) · Moves
 * (frame-data table) · Cancels (graph matrix) · Test (playable vs dummy) ·
 * Generate (AI sprites → normalize → QC → accept).
 */
import {
  Action, Btn, Phase, STAGE, TICKS_PER_SEC, TUNING,
  characters, createGameState, debugBoxes, loadCharacter, setCharacters, step,
} from '@af/core';
import type {
  CharacterBundle, GameState, HitboxDef, InputFrame, MoveDef, MoveStep, Rect,
} from '@af/core';
import {
  CELL_W, PIVOT_X, PIVOT_Y, autoHurtboxes, canvasToPngDataUrl,
  decodeBase64Image, diffHitboxDraft, extractPalette, normalizeFrame, qcScore,
} from './pipeline.js';
import type { NormalizedFrame, QCResult, RGB } from './pipeline.js';

interface StudioMeta {
  desc?: string;
  palette?: RGB[];
  refBodyW?: number;
  moveDesc?: Record<string, string>;
}

type TabName = 'character' | 'frames' | 'moves' | 'cancels' | 'test' | 'generate';

// ------------------------------------------------------------------ state
let stCharId = 'analog';
let stCharList: string[] = [];
let stBundle: CharacterBundle | null = null;
let stTab: TabName = 'frames';
let stMoveIdx = 0;
let stStepIdx = 0;
let stSel: { list: 'hurt' | 'hit'; i: number } | null = null;
let stOnion = true;
let stStatus = 'loading…';
let stDirty = false;
let stRaf = 0;
let stSeed = 1;
const spriteImgs = new Map<string, HTMLCanvasElement | HTMLImageElement>();

interface GenResult { norm: NormalizedFrame; qc: QCResult; accepted: boolean }
let stGenResults = new Map<number, GenResult>();
let stGenBusy = false;
let stRefPreview: NormalizedFrame | null = null;

const meta = (): StudioMeta => {
  const b = stBundle as CharacterBundle & { meta?: StudioMeta };
  if (!b.meta) b.meta = {};
  return b.meta;
};

// ------------------------------------------------------------------ api
const apiJson = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const r = await fetch(path, init);
  const body = await r.json();
  if (!r.ok) throw new Error(body?.error ?? `HTTP ${r.status}`);
  return body as T;
};

const loadChar = async (id: string): Promise<void> => {
  stBundle = await apiJson<CharacterBundle>(`/api/characters/${id}`);
  stCharId = id;
  stMoveIdx = 0;
  stStepIdx = 0;
  stSel = null;
  stGenResults = new Map();
  stDirty = false;
  spriteImgs.clear();
  stStatus = `loaded ${id}`;
};

const saveChar = async (): Promise<void> => {
  try {
    loadCharacter(structuredClone(stBundle!)); // validate before persisting
    const r = await apiJson<{ versionHash: string }>(`/api/characters/${stCharId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(stBundle),
    });
    stDirty = false;
    stStatus = `saved · hash ${r.versionHash}`;
  } catch (e) {
    stStatus = `SAVE FAILED: ${(e as Error).message}`;
  }
  renderAll();
};

const generateImage = async (prompt: string, seed: number): Promise<HTMLImageElement> => {
  const body = { prompt, width: 1024, height: 1024, steps: 4, seed };
  const r = await apiJson<{ artifacts?: { base64: string }[]; b64_json?: string }>(
    '/api/generate',
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const b64 = r.artifacts?.[0]?.base64;
  if (!b64) throw new Error('no image in response');
  return decodeBase64Image(b64);
};

const saveSprite = async (name: string, cell: HTMLCanvasElement): Promise<void> => {
  await apiJson(`/api/characters/${stCharId}/sprites/${name}`, {
    method: 'PUT', body: canvasToPngDataUrl(cell),
  });
  spriteImgs.set(name, cell);
};

const getSprite = (name: string): HTMLCanvasElement | HTMLImageElement | null => {
  const hit = spriteImgs.get(name);
  if (hit) return hit;
  const img = new Image();
  img.src = `/characters/${stCharId}/sprites/${name}`;
  spriteImgs.set(name, img);
  return img.complete ? img : null;
};

// ------------------------------------------------------------------ dom
const mkEl = <K extends keyof HTMLElementTagNameMap>(
  tag: K, attrs: Record<string, unknown> = {}, ...children: (Node | string | null)[]
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === 'class') node.className = String(v);
    else if (k.startsWith('on')) (node as unknown as Record<string, unknown>)[k.toLowerCase()] = v;
    else if (k === 'value') (node as HTMLInputElement).value = String(v);
    else if (k === 'checked') (node as HTMLInputElement).checked = Boolean(v);
    else node.setAttribute(k, String(v));
  }
  for (const c of children) if (c != null) node.append(c);
  return node;
};

const numInput = (value: number, onCommit: (v: number) => void, width = 54): HTMLInputElement =>
  mkEl('input', {
    type: 'number', value, style: `width:${width}px`, step: 'any',
    onchange: (e: Event) => {
      const v = Number((e.target as HTMLInputElement).value);
      if (!Number.isNaN(v)) { onCommit(v); stDirty = true; renderAll(); }
    },
  });

const selInput = (value: string, options: string[], onCommit: (v: string) => void): HTMLSelectElement => {
  const s = mkEl('select', {
    onchange: (e: Event) => { onCommit((e.target as HTMLSelectElement).value); stDirty = true; renderAll(); },
  });
  for (const o of options) s.append(mkEl('option', { value: o, selected: o === value ? '' : null }, o || '(none)'));
  return s;
};

// ------------------------------------------------------------------ header
const renderHeader = (): HTMLElement => {
  const tabs: TabName[] = ['character', 'frames', 'moves', 'cancels', 'test', 'generate'];
  return mkEl('div', { class: 'header' },
    mkEl('span', { class: 'logo' }, 'AF STUDIO'),
    selInput(stCharId, stCharList, (id) => { void loadChar(id).then(renderAll); }),
    mkEl('button', {
      onclick: () => {
        const id = prompt('new character id (lowercase, dashes):');
        if (!id || !/^[a-z0-9][a-z0-9-]{0,40}$/.test(id)) return;
        // New characters start as a copy of the current bundle (archetype reuse).
        const copy = structuredClone(stBundle!);
        copy.name = id[0]!.toUpperCase() + id.slice(1);
        for (const mv of copy.moves) for (const s of mv.steps) delete s.sprite;
        stBundle = copy;
        stCharId = id;
        stDirty = true;
        void saveChar().then(() => apiJson<string[]>('/api/characters')).then((l) => { stCharList = l; renderAll(); });
      },
    }, '+ new'),
    ...tabs.map((t) => mkEl('button', {
      class: stTab === t ? 'tab active' : 'tab',
      onclick: () => { stTab = t; stSel = null; renderAll(); },
    }, t)),
    mkEl('button', { class: stDirty ? 'save dirty' : 'save', onclick: () => void saveChar() },
      stDirty ? 'save *' : 'save'),
    mkEl('span', { class: 'status' }, stStatus),
  );
};

// ------------------------------------------------------------------ character tab
const renderCharacterTab = (): HTMLElement => {
  const b = stBundle!;
  const field = (label: string, get: () => number, set: (v: number) => void): HTMLElement =>
    mkEl('label', { class: 'field' }, label, numInput(get(), set, 70));
  return mkEl('div', { class: 'pane grid' },
    mkEl('label', { class: 'field' }, 'name', mkEl('input', {
      value: b.name,
      onchange: (e: Event) => { b.name = (e.target as HTMLInputElement).value; stDirty = true; },
    })),
    field('maxHealth', () => b.maxHealth, (v) => { b.maxHealth = v; }),
    field('walkFSpeed', () => b.walkFSpeed, (v) => { b.walkFSpeed = v; }),
    field('walkBSpeed', () => b.walkBSpeed, (v) => { b.walkBSpeed = v; }),
    field('dashFSpeed', () => b.dashFSpeed, (v) => { b.dashFSpeed = v; }),
    field('dashFTicks', () => b.dashFTicks, (v) => { b.dashFTicks = v; }),
    field('dashBSpeed', () => b.dashBSpeed, (v) => { b.dashBSpeed = v; }),
    field('dashBTicks', () => b.dashBTicks, (v) => { b.dashBTicks = v; }),
    field('jumpVelY', () => b.jumpVelY, (v) => { b.jumpVelY = v; }),
    field('superJumpVelY', () => b.superJumpVelY, (v) => { b.superJumpVelY = v; }),
    field('jumpVelX', () => b.jumpVelX, (v) => { b.jumpVelX = v; }),
    field('gravity', () => b.gravity, (v) => { b.gravity = v; }),
    mkEl('label', { class: 'field' }, 'doubleJump', mkEl('input', {
      type: 'checkbox', checked: b.doubleJump,
      onchange: (e: Event) => { b.doubleJump = (e.target as HTMLInputElement).checked; stDirty = true; },
    })),
    mkEl('label', { class: 'field' }, 'airDash', mkEl('input', {
      type: 'checkbox', checked: b.airDash,
      onchange: (e: Event) => { b.airDash = (e.target as HTMLInputElement).checked; stDirty = true; },
    })),
    field('airDashSpeed', () => b.airDashSpeed, (v) => { b.airDashSpeed = v; }),
    field('airDashTicks', () => b.airDashTicks, (v) => { b.airDashTicks = v; }),
    field('bodyWidth', () => b.bodyWidth, (v) => { b.bodyWidth = v; }),
    field('throwRange', () => b.throwRange, (v) => { b.throwRange = v; }),
    field('throwDamage', () => b.throwDamage, (v) => { b.throwDamage = v; }),
    field('throwTossVelX', () => b.throwTossVelX, (v) => { b.throwTossVelX = v; }),
    field('throwTossVelY', () => b.throwTossVelY, (v) => { b.throwTossVelY = v; }),
  );
};

// ------------------------------------------------------------------ frames tab
const FR_SC = 2.2;
const FR_CX = 260;
const FR_CY = 430;
let frDrag: { mode: 'move' | 'resize'; startX: number; startY: number; orig: Rect } | null = null;

const selRect = (): Rect | null => {
  if (!stSel) return null;
  const stp = curStep();
  if (!stp) return null;
  return stSel.list === 'hurt'
    ? stp.hurtboxes[stSel.i] ?? null
    : stp.hitboxes?.[stSel.i]?.rect ?? null;
};

const curMove = (): MoveDef | null => stBundle?.moves[stMoveIdx] ?? null;
const curStep = (): MoveStep | null => curMove()?.steps[stStepIdx] ?? null;

const frToScreen = (r: Rect): { x: number; y: number; w: number; h: number } => ({
  x: FR_CX + r.x * FR_SC, y: FR_CY + r.y * FR_SC, w: r.w * FR_SC, h: r.h * FR_SC,
});

const frPaint = (cv: HTMLCanvasElement): void => {
  const ctx = cv.getContext('2d')!;
  ctx.fillStyle = '#181a28';
  ctx.fillRect(0, 0, cv.width, cv.height);
  // Floor + pivot.
  ctx.strokeStyle = '#3d4260';
  ctx.beginPath(); ctx.moveTo(0, FR_CY + 0.5); ctx.lineTo(cv.width, FR_CY + 0.5); ctx.stroke();
  ctx.strokeStyle = '#6b7280';
  ctx.beginPath(); ctx.moveTo(FR_CX - 8, FR_CY); ctx.lineTo(FR_CX + 8, FR_CY); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(FR_CX, FR_CY - 8); ctx.lineTo(FR_CX, FR_CY + 8); ctx.stroke();

  const stp = curStep();
  if (!stp) return;

  // Sprite (or body silhouette).
  if (stp.sprite) {
    const spr = getSprite(stp.sprite);
    if (spr) {
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(spr, FR_CX - PIVOT_X * FR_SC, FR_CY - PIVOT_Y * FR_SC,
        CELL_W * FR_SC, CELL_W * FR_SC);
    }
  } else {
    ctx.fillStyle = '#2c3050';
    const bw = stBundle!.bodyWidth;
    ctx.fillRect(FR_CX - (bw / 2) * FR_SC, FR_CY - 108 * FR_SC, bw * FR_SC, 108 * FR_SC);
  }

  // Onion skin: previous step boxes.
  if (stOnion && stStepIdx > 0) {
    const prev = curMove()!.steps[stStepIdx - 1]!;
    ctx.setLineDash([4, 4]);
    ctx.globalAlpha = 0.35;
    ctx.strokeStyle = '#4ade80';
    for (const r of prev.hurtboxes) { const s = frToScreen(r); ctx.strokeRect(s.x, s.y, s.w, s.h); }
    ctx.strokeStyle = '#f87171';
    for (const hb of prev.hitboxes ?? []) { const s = frToScreen(hb.rect); ctx.strokeRect(s.x, s.y, s.w, s.h); }
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  // Current boxes.
  stp.hurtboxes.forEach((r, i) => {
    const s = frToScreen(r);
    const seld = stSel?.list === 'hurt' && stSel.i === i;
    ctx.lineWidth = seld ? 2.5 : 1;
    ctx.strokeStyle = '#4ade80';
    ctx.strokeRect(s.x + 0.5, s.y + 0.5, s.w, s.h);
  });
  (stp.hitboxes ?? []).forEach((hb, i) => {
    const s = frToScreen(hb.rect);
    const seld = stSel?.list === 'hit' && stSel.i === i;
    ctx.lineWidth = seld ? 2.5 : 1;
    ctx.strokeStyle = '#f87171';
    ctx.strokeRect(s.x + 0.5, s.y + 0.5, s.w, s.h);
    ctx.fillStyle = '#f8717122';
    ctx.fillRect(s.x, s.y, s.w, s.h);
  });
  ctx.lineWidth = 1;
  // Resize handle on selection.
  const sr = selRect();
  if (sr) {
    const s = frToScreen(sr);
    ctx.fillStyle = '#ffd166';
    ctx.fillRect(s.x + s.w - 5, s.y + s.h - 5, 10, 10);
  }
};

const frMouse = (cv: HTMLCanvasElement): void => {
  const toChar = (e: MouseEvent): { x: number; y: number } => {
    const r = cv.getBoundingClientRect();
    return { x: (e.clientX - r.left - FR_CX) / FR_SC, y: (e.clientY - r.top - FR_CY) / FR_SC };
  };
  cv.onmousedown = (e) => {
    const p = toChar(e);
    const stp = curStep();
    if (!stp) return;
    const sr = selRect();
    // Resize handle?
    if (sr && Math.abs(p.x - (sr.x + sr.w)) < 6 / FR_SC * 3 && Math.abs(p.y - (sr.y + sr.h)) < 6 / FR_SC * 3) {
      frDrag = { mode: 'resize', startX: p.x, startY: p.y, orig: { ...sr } };
      return;
    }
    // Select (hitboxes take priority), else move current.
    const hitAt = (r: Rect): boolean => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
    let found: typeof stSel = null;
    (stp.hitboxes ?? []).forEach((hb, i) => { if (!found && hitAt(hb.rect)) found = { list: 'hit', i }; });
    if (!found) stp.hurtboxes.forEach((r, i) => { if (!found && hitAt(r)) found = { list: 'hurt', i }; });
    stSel = found;
    const nr = selRect();
    if (nr) frDrag = { mode: 'move', startX: p.x, startY: p.y, orig: { ...nr } };
    renderAll();
  };
  cv.onmousemove = (e) => {
    if (!frDrag) return;
    const p = toChar(e);
    const r = selRect();
    if (!r) return;
    const dx = Math.round(p.x - frDrag.startX);
    const dy = Math.round(p.y - frDrag.startY);
    if (frDrag.mode === 'move') {
      r.x = frDrag.orig.x + dx;
      r.y = frDrag.orig.y + dy;
    } else {
      r.w = Math.max(4, frDrag.orig.w + dx);
      r.h = Math.max(4, frDrag.orig.h + dy);
    }
    stDirty = true;
    frPaint(cv);
  };
  cv.onmouseup = () => { if (frDrag) { frDrag = null; renderAll(); } };
  cv.onmouseleave = cv.onmouseup;
};

const hitboxTemplate = (): HitboxDef => ({
  rect: { x: 20, y: -90, w: 50, h: 30 },
  damage: 500, chip: 0, hitstun: 16, blockstun: 12, hitstopFrames: 6,
  pushbackHit: 5, pushbackBlock: 6, guard: 'mid', juggleCost: 1,
});

const renderFramesTab = (): HTMLElement => {
  const b = stBundle!;
  const mv = curMove();
  const stp = curStep();

  // Step timeline strip.
  const timeline = mkEl('div', { class: 'steplist' },
    ...(mv?.steps.map((s, i) => mkEl('button', {
      class: `stepbtn ${s.phase} ${i === stStepIdx ? 'cur' : ''}`,
      onclick: () => { stStepIdx = i; stSel = null; renderAll(); },
    }, `${i}·${s.phase.slice(0, 3)}·${s.frames}f${s.sprite ? '·🖼' : ''}`)) ?? []),
    mkEl('button', {
      class: 'stepbtn add',
      onclick: () => {
        if (!mv) return;
        mv.steps.splice(stStepIdx + 1, 0, structuredClone(mv.steps[stStepIdx] ?? {
          frames: 4, phase: 'startup', hurtboxes: [{ ...b.standHurtbox }],
        }) as MoveStep);
        stStepIdx++;
        stDirty = true;
        renderAll();
      },
    }, '+step'),
  );

  const cv = mkEl('canvas', { width: 520, height: 470, class: 'frcanvas' });
  requestAnimationFrame(() => { frPaint(cv); });
  frMouse(cv);
  // Sprites may stream in async — repaint while tab visible.
  const repaint = (): void => { if (document.body.contains(cv)) { frPaint(cv); setTimeout(repaint, 250); } };
  setTimeout(repaint, 250);

  // Step properties.
  const stepProps = stp ? mkEl('div', { class: 'props' },
    mkEl('b', {}, `step ${stStepIdx}`),
    mkEl('label', { class: 'field' }, 'frames', numInput(stp.frames, (v) => { stp.frames = Math.max(1, Math.round(v)); })),
    mkEl('label', { class: 'field' }, 'phase', selInput(stp.phase, ['startup', 'active', 'recovery'], (v) => { stp.phase = v as MoveStep['phase']; })),
    mkEl('label', { class: 'field' }, 'velX', numInput(stp.velX ?? 0, (v) => { if (v === 0) delete stp.velX; else stp.velX = v; })),
    mkEl('label', { class: 'field' }, 'velY', numInput(stp.velY ?? 0, (v) => { if (v === 0) delete stp.velY; else stp.velY = v; })),
    mkEl('label', { class: 'field' }, 'sprite', mkEl('input', {
      value: stp.sprite ?? '', style: 'width:130px',
      onchange: (e: Event) => {
        const v = (e.target as HTMLInputElement).value.trim();
        if (v) stp.sprite = v; else delete stp.sprite;
        stDirty = true;
      },
    })),
    mkEl('button', {
      onclick: () => {
        stp.hurtboxes.push({ x: -26, y: -108, w: 52, h: 108 });
        stSel = { list: 'hurt', i: stp.hurtboxes.length - 1 };
        stDirty = true; renderAll();
      },
    }, '+hurtbox'),
    mkEl('button', {
      onclick: () => {
        (stp.hitboxes ??= []).push(hitboxTemplate());
        stSel = { list: 'hit', i: stp.hitboxes.length - 1 };
        stDirty = true; renderAll();
      },
    }, '+hitbox'),
    mkEl('button', {
      onclick: () => {
        if (!stSel) return;
        if (stSel.list === 'hurt') stp.hurtboxes.splice(stSel.i, 1);
        else { stp.hitboxes?.splice(stSel.i, 1); if (stp.hitboxes?.length === 0) delete stp.hitboxes; }
        stSel = null; stDirty = true; renderAll();
      },
    }, 'del box'),
    mkEl('button', {
      onclick: () => {
        if (!mv || mv.steps.length <= 1) return;
        mv.steps.splice(stStepIdx, 1);
        stStepIdx = Math.max(0, stStepIdx - 1);
        stSel = null; stDirty = true; renderAll();
      },
    }, 'del step'),
    mkEl('label', { class: 'field' }, 'onion', mkEl('input', {
      type: 'checkbox', checked: stOnion,
      onchange: (e: Event) => { stOnion = (e.target as HTMLInputElement).checked; renderAll(); },
    })),
    mkEl('button', {
      title: 'hurtbox draft from sprite alpha (head/torso/legs bands)',
      onclick: () => {
        if (!stp.sprite) { stStatus = 'no sprite on this step'; renderAll(); return; }
        const spr = spriteImgs.get(stp.sprite);
        if (!(spr instanceof HTMLCanvasElement)) { stStatus = 'sprite not loaded as canvas (accept via Generate tab first)'; renderAll(); return; }
        const boxes = autoHurtboxes(spr);
        if (boxes.length) { stp.hurtboxes = boxes; stDirty = true; stStatus = `drafted ${boxes.length} hurtboxes`; }
        renderAll();
      },
    }, 'auto-hurtbox'),
    mkEl('button', {
      title: 'hitbox draft from diff vs previous step sprite',
      onclick: () => {
        const prev = curMove()?.steps[stStepIdx - 1];
        const a = prev?.sprite ? spriteImgs.get(prev.sprite) : null;
        const bSpr = stp.sprite ? spriteImgs.get(stp.sprite) : null;
        if (!(a instanceof HTMLCanvasElement) || !(bSpr instanceof HTMLCanvasElement)) {
          stStatus = 'need canvas sprites on this + previous step'; renderAll(); return;
        }
        const draft = diffHitboxDraft(a, bSpr);
        if (draft) {
          (stp.hitboxes ??= []).push({ ...hitboxTemplate(), rect: draft });
          stSel = { list: 'hit', i: stp.hitboxes.length - 1 };
          stDirty = true; stStatus = 'hitbox drafted from sprite diff';
        } else stStatus = 'no significant diff region found';
        renderAll();
      },
    }, 'auto-hitbox'),
  ) : mkEl('div');

  // Selected hitbox full property editor.
  let hbProps: HTMLElement | null = null;
  if (stSel?.list === 'hit' && stp?.hitboxes?.[stSel.i]) {
    const hb = stp.hitboxes[stSel.i]!;
    const f = (label: string, get: () => number, set: (v: number) => void): HTMLElement =>
      mkEl('label', { class: 'field' }, label, numInput(get(), set));
    hbProps = mkEl('div', { class: 'props hbprops' },
      mkEl('b', {}, 'hitbox'),
      f('damage', () => hb.damage, (v) => { hb.damage = v; }),
      f('chip', () => hb.chip, (v) => { hb.chip = v; }),
      f('hitstun', () => hb.hitstun, (v) => { hb.hitstun = v; }),
      f('blockstun', () => hb.blockstun, (v) => { hb.blockstun = v; }),
      f('hitstop', () => hb.hitstopFrames, (v) => { hb.hitstopFrames = v; }),
      f('pushHit', () => hb.pushbackHit, (v) => { hb.pushbackHit = v; }),
      f('pushBlock', () => hb.pushbackBlock, (v) => { hb.pushbackBlock = v; }),
      f('juggleCost', () => hb.juggleCost, (v) => { hb.juggleCost = v; }),
      mkEl('label', { class: 'field' }, 'guard', selInput(hb.guard, ['mid', 'low', 'overhead', 'unblockable'], (v) => { hb.guard = v as HitboxDef['guard']; })),
      mkEl('label', { class: 'field' }, 'launcher', mkEl('input', {
        type: 'checkbox', checked: !!hb.launcher,
        onchange: (e: Event) => { hb.launcher = (e.target as HTMLInputElement).checked || undefined; stDirty = true; },
      })),
      f('launchVelY', () => hb.launchVelY ?? -16, (v) => { hb.launchVelY = v; }),
      mkEl('label', { class: 'field' }, 'knockdown', mkEl('input', {
        type: 'checkbox', checked: !!hb.knockdown,
        onchange: (e: Event) => { hb.knockdown = (e.target as HTMLInputElement).checked || undefined; stDirty = true; },
      })),
      f('airPopVelY', () => hb.airPopVelY ?? -7, (v) => { hb.airPopVelY = v; }),
    );
  }

  return mkEl('div', { class: 'pane' },
    mkEl('div', { class: 'row' },
      mkEl('label', {}, 'move ',
        selInput(mv?.id ?? '', b.moves.map((m) => m.id), (id) => {
          stMoveIdx = b.moves.findIndex((m) => m.id === id);
          stStepIdx = 0; stSel = null;
        })),
      mkEl('span', { class: 'hint' },
        mv ? `${mv.type} · ${mv.stance} · total ${mv.steps.reduce((n, s) => n + s.frames, 0)}f` : ''),
    ),
    timeline,
    mkEl('div', { class: 'row' }, cv, mkEl('div', {}, stepProps, hbProps)),
  );
};

// ------------------------------------------------------------------ moves tab
const renderMovesTab = (): HTMLElement => {
  const b = stBundle!;
  const rows = b.moves.map((mv, i) => {
    const startup = ((): number => {
      let n = 0;
      for (const s of mv.steps) { if (s.phase === 'active') return n; n += s.frames; }
      return n;
    })();
    const firstHb = mv.steps.find((s) => s.hitboxes?.length)?.hitboxes?.[0];
    return mkEl('tr', {},
      mkEl('td', {}, mkEl('input', {
        value: mv.id, style: 'width:64px',
        onchange: (e: Event) => {
          const nid = (e.target as HTMLInputElement).value.trim();
          if (!nid || b.moves.some((m, k) => k !== i && m.id === nid)) return;
          for (const edge of b.cancels) {
            if (edge.from === mv.id) edge.from = nid;
            edge.to = edge.to.map((t) => (t === mv.id ? nid : t));
          }
          mv.id = nid; stDirty = true; renderAll();
        },
      })),
      mkEl('td', {}, selInput(mv.type, ['normal', 'special', 'super', 'system'], (v) => { mv.type = v as MoveDef['type']; })),
      mkEl('td', {}, selInput(mv.stance, ['stand', 'crouch', 'air'], (v) => { mv.stance = v as MoveDef['stance']; })),
      mkEl('td', {}, selInput(mv.button ?? '', ['', 'LP', 'MP', 'HP', 'LK', 'MK', 'HK'], (v) => { if (v) mv.button = v as MoveDef['button']; else delete mv.button; })),
      mkEl('td', {}, selInput(String(mv.motion ?? ''), ['', '236', '214', '623'], (v) => { if (v) mv.motion = Number(v) as MoveDef['motion']; else delete mv.motion; })),
      mkEl('td', {}, selInput(mv.buttons ?? '', ['', 'P', 'K', 'PP'], (v) => { if (v) mv.buttons = v as MoveDef['buttons']; else delete mv.buttons; })),
      mkEl('td', { class: 'num' }, String(startup)),
      mkEl('td', { class: 'num' }, String(mv.steps.reduce((n, s) => n + s.frames, 0))),
      mkEl('td', {}, firstHb ? numInput(firstHb.damage, (v) => { firstHb.damage = v; }) : '—'),
      mkEl('td', {}, firstHb ? numInput(firstHb.hitstun, (v) => { firstHb.hitstun = v; }, 44) : '—'),
      mkEl('td', {}, firstHb ? numInput(firstHb.blockstun, (v) => { firstHb.blockstun = v; }, 44) : '—'),
      mkEl('td', {}, numInput(mv.meterGainWhiff, (v) => { mv.meterGainWhiff = v; }, 44)),
      mkEl('td', {}, numInput(mv.meterGainHit, (v) => { mv.meterGainHit = v; }, 44)),
      mkEl('td', {}, mv.type === 'super' ? numInput(mv.meterCost ?? 1000, (v) => { mv.meterCost = v; }, 54) : '—'),
      mkEl('td', {},
        mkEl('button', {
          onclick: () => { stMoveIdx = i; stStepIdx = 0; stTab = 'frames'; renderAll(); },
        }, 'frames'),
        mkEl('button', {
          onclick: () => {
            const copy = structuredClone(mv);
            copy.id = `${mv.id}~copy`;
            b.moves.splice(i + 1, 0, copy);
            stDirty = true; renderAll();
          },
        }, 'dup'),
        mkEl('button', {
          onclick: () => {
            if (!confirm(`delete ${mv.id}?`)) return;
            b.moves.splice(i, 1);
            const gone = mv.id;
            b.cancels = b.cancels
              .filter((edge) => edge.from !== gone)
              .map((edge) => ({ ...edge, to: edge.to.filter((t) => t !== gone) }))
              .filter((edge) => edge.to.length > 0);
            stMoveIdx = 0; stDirty = true; renderAll();
          },
        }, 'del'),
      ),
    );
  });
  return mkEl('div', { class: 'pane' },
    mkEl('table', { class: 'movetable' },
      mkEl('tr', {}, ...['id', 'type', 'stance', 'btn', 'motion', 'btns', 'startup', 'total', 'dmg', 'hitstun', 'blkstun', 'mWhiff', 'mHit', 'cost', ''].map((h) => mkEl('th', {}, h))),
      ...rows),
    mkEl('button', {
      onclick: () => {
        stBundle!.moves.push({
          id: `new${stBundle!.moves.length}`, type: 'normal', stance: 'stand', button: 'LP',
          steps: [
            { frames: 4, phase: 'startup', hurtboxes: [{ ...stBundle!.standHurtbox }] },
            { frames: 3, phase: 'active', hurtboxes: [{ ...stBundle!.standHurtbox }], hitboxes: [hitboxTemplate()] },
            { frames: 8, phase: 'recovery', hurtboxes: [{ ...stBundle!.standHurtbox }] },
          ],
          meterGainWhiff: 5, meterGainHit: 40,
        });
        stDirty = true; renderAll();
      },
    }, '+ move'),
  );
};

// ------------------------------------------------------------------ cancels tab
type CancelState = '' | 'H' | 'HB' | 'B';

const cancelStateOf = (from: string, to: string): CancelState => {
  let hit = false, block = false;
  for (const e of stBundle!.cancels) {
    if (e.from === from && e.to.includes(to)) {
      if (e.on.includes('hit')) hit = true;
      if (e.on.includes('block')) block = true;
    }
  }
  return hit && block ? 'HB' : hit ? 'H' : block ? 'B' : '';
};

const setCancelState = (from: string, to: string, cs: CancelState): void => {
  const b = stBundle!;
  // Remove `to` from all edges with this `from`, dropping empty edges.
  b.cancels = b.cancels
    .map((e) => (e.from === from ? { ...e, to: e.to.filter((t) => t !== to) } : e))
    .filter((e) => e.to.length > 0);
  if (cs === '') return;
  const on: ('hit' | 'block')[] = cs === 'H' ? ['hit'] : cs === 'B' ? ['block'] : ['hit', 'block'];
  // Merge into an existing edge with identical `on`, else append.
  const home = b.cancels.find((e) => e.from === from
    && e.on.length === on.length && on.every((o) => e.on.includes(o)));
  if (home) home.to.push(to);
  else b.cancels.push({ from, to: [to], on });
};

const renderCancelsTab = (): HTMLElement => {
  const b = stBundle!;
  const ids = b.moves.map((m) => m.id);
  const cycle: Record<CancelState, CancelState> = { '': 'H', H: 'HB', HB: 'B', B: '' };
  return mkEl('div', { class: 'pane scrollx' },
    mkEl('p', { class: 'hint' }, 'rows cancel INTO columns · click cycles: — → hit → hit+block → block'),
    mkEl('table', { class: 'canceltable' },
      mkEl('tr', {}, mkEl('th', {}, 'from \\ to'), ...ids.map((id) => mkEl('th', { class: 'rot' }, id))),
      ...ids.map((from) => mkEl('tr', {},
        mkEl('th', {}, from),
        ...ids.map((to) => {
          const cs = cancelStateOf(from, to);
          return mkEl('td', {
            class: `cc ${cs}`,
            onclick: () => { setCancelState(from, to, cycle[cs]); stDirty = true; renderAll(); },
          }, cs || '·');
        }),
      )),
    ),
  );
};

// ------------------------------------------------------------------ test tab
const keysDown = new Set<string>();
addEventListener('keydown', (e) => {
  keysDown.add(e.code);
  if (stTab === 'test' && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space'].includes(e.code)) e.preventDefault();
});
addEventListener('keyup', (e) => keysDown.delete(e.code));

const P1_KEYMAP: [string, number][] = [
  ['KeyA', Btn.Left], ['KeyD', Btn.Right], ['KeyW', Btn.Up], ['KeyS', Btn.Down],
  ['KeyT', Btn.LP], ['KeyY', Btn.MP], ['KeyU', Btn.HP],
  ['KeyG', Btn.LK], ['KeyH', Btn.MK], ['KeyJ', Btn.HK],
];

type DummyMode = 'idle' | 'block' | 'crouch' | 'jump' | 'mash';
let stDummy: DummyMode = 'idle';
let stGame: GameState | null = null;
let stShowBoxes = true;

const dummyInput = (g: GameState): InputFrame => {
  const me = g.fighters[1], op = g.fighters[0];
  const away = op.x > me.x ? Btn.Left : Btn.Right;
  switch (stDummy) {
    case 'idle': return 0;
    case 'block': return away | Btn.Down;
    case 'crouch': return Btn.Down;
    case 'jump': return g.tick % 90 < 40 ? Btn.Up : 0;
    case 'mash': return (g.tick % 14 < 2 ? Btn.LP : 0) | (g.tick % 120 < 40 ? (op.x > me.x ? Btn.Right : Btn.Left) : 0);
  }
};

const applyBundleToSim = (): string | null => {
  try {
    const lc = loadCharacter(structuredClone(stBundle!));
    setCharacters(lc, lc);
    stGame = createGameState(stSeed++);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
};

const testPaint = (cv: HTMLCanvasElement): void => {
  const g = stGame;
  const ctx = cv.getContext('2d')!;
  ctx.fillStyle = '#141625';
  ctx.fillRect(0, 0, cv.width, cv.height);
  if (!g) return;
  const camL = Math.max(0, Math.min(STAGE.widthPx - cv.width,
    (Math.trunc(g.fighters[0].x / 256) + Math.trunc(g.fighters[1].x / 256)) / 2 - cv.width / 2));
  const wx = (v: number): number => v - camL;
  ctx.fillStyle = '#2b2f45';
  ctx.fillRect(0, STAGE.floorYPx, cv.width, cv.height - STAGE.floorYPx);

  for (const i of [0, 1] as const) {
    const f = g.fighters[i];
    const x = wx(Math.trunc(f.x / 256));
    const y = Math.trunc(f.y / 256);
    // Sprite during attacks when the step has one; rect otherwise.
    let drew = false;
    if (f.action === Action.Attack && f.moveIdx >= 0) {
      const mv = characters[i].b.moves[f.moveIdx]!;
      let acc = 0;
      let stp: MoveStep | null = null;
      for (const s of mv.steps) { acc += s.frames; if (f.actionFrame < acc) { stp = s; break; } }
      if (stp?.sprite) {
        const spr = getSprite(stp.sprite);
        if (spr) {
          ctx.save();
          ctx.translate(x, y);
          ctx.scale(f.facing, 1);
          ctx.imageSmoothingEnabled = false;
          ctx.drawImage(spr, -PIVOT_X, -PIVOT_Y);
          ctx.restore();
          drew = true;
        }
      }
    }
    if (!drew) {
      const crouched = f.action === Action.Crouch || f.action === Action.BlockCrouch;
      const lying = f.action === Action.Knockdown || f.action === Action.Getup || f.action === Action.KO;
      const h = lying ? 30 : crouched ? 80 : 108;
      ctx.fillStyle = i === 0 ? '#e94560' : '#4ea8de';
      if (f.action === Action.Hitstun || f.action === Action.AirHitstun) ctx.fillStyle = '#fff';
      ctx.fillRect(x - 26, y - h, 52, h);
    }
  }
  for (const p of g.projectiles) {
    if (!p.active) continue;
    ctx.fillStyle = '#ffd166';
    ctx.beginPath();
    ctx.arc(wx(Math.trunc(p.x / 256)), Math.trunc(p.y / 256), 12, 0, Math.PI * 2);
    ctx.fill();
  }
  if (stShowBoxes) {
    for (const bx of debugBoxes(g)) {
      ctx.strokeStyle = '#4ade80';
      for (const r of bx.hurtboxes) ctx.strokeRect(wx(r.x) + 0.5, r.y + 0.5, r.w, r.h);
      ctx.strokeStyle = '#f87171';
      for (const r of bx.hitboxes) ctx.strokeRect(wx(r.x) + 0.5, r.y + 0.5, r.w, r.h);
    }
  }
  // Mini HUD.
  ctx.fillStyle = '#fff';
  ctx.font = '12px monospace';
  ctx.textAlign = 'left';
  const f0 = g.fighters[0], f1 = g.fighters[1];
  ctx.fillText(`P1 hp ${f0.health} meter ${f0.meter}`, 10, 16);
  ctx.textAlign = 'right';
  ctx.fillText(`dummy hp ${f1.health} combo ${f1.comboHits}`, cv.width - 10, 16);
  if (g.phase !== Phase.Fighting) {
    ctx.textAlign = 'center';
    ctx.font = 'bold 26px monospace';
    ctx.fillText(['READY', '', 'ROUND OVER', 'MATCH OVER'][g.phase] ?? '', cv.width / 2, 80);
  }
};

const renderTestTab = (): HTMLElement => {
  const err = applyBundleToSim();
  const cv = mkEl('canvas', { width: 960, height: 540, class: 'testcanvas' });
  const info = mkEl('span', { class: 'hint' },
    err ? `BUNDLE INVALID: ${err}` : 'P1: WASD + TYU/GHJ · edits apply on tab entry');

  let last = performance.now();
  let acc = 0;
  const loop = (now: number): void => {
    if (!document.body.contains(cv)) return; // tab switched — stop
    acc = Math.min(acc + now - last, 200);
    last = now;
    while (acc >= 1000 / TICKS_PER_SEC) {
      if (stGame && !err) {
        let p1 = 0;
        for (const [code, bit] of P1_KEYMAP) if (keysDown.has(code)) p1 |= bit;
        step(stGame, [p1, dummyInput(stGame)]);
        if (stGame.phase === Phase.MatchOver) stGame = createGameState(stSeed++);
      }
      acc -= 1000 / TICKS_PER_SEC;
    }
    testPaint(cv);
    stRaf = requestAnimationFrame(loop);
  };
  cancelAnimationFrame(stRaf);
  stRaf = requestAnimationFrame(loop);

  return mkEl('div', { class: 'pane' },
    mkEl('div', { class: 'row' },
      mkEl('button', { onclick: () => renderAll() }, 'apply + restart'),
      mkEl('label', {}, ' dummy ', selInput(stDummy, ['idle', 'block', 'crouch', 'jump', 'mash'], (v) => { stDummy = v as DummyMode; })),
      mkEl('label', {}, ' boxes ', mkEl('input', {
        type: 'checkbox', checked: stShowBoxes,
        onchange: (e: Event) => { stShowBoxes = (e.target as HTMLInputElement).checked; },
      })),
      info,
    ),
    cv,
  );
};

// ------------------------------------------------------------------ generate tab
const SPRITE_STYLE = 'flat solid white background, 2D fighting game sprite, full body, '
  + 'side view facing right, feet on the ground at the bottom, sharp pixel art style, '
  + 'crisp outlines, vibrant colors, centered, no text, no watermark';

const spriteName = (moveId: string, stepIdx: number): string =>
  `${moveId.replace(/[^a-zA-Z0-9_-]/g, '_')}_s${stepIdx}.png`;

const runGeneration = async (which: 'reference' | 'move'): Promise<void> => {
  if (stGenBusy || !stBundle) return;
  stGenBusy = true;
  const m = meta();
  const desc = m.desc || stBundle.name;
  try {
    if (which === 'reference') {
      stStatus = 'generating reference…'; renderAll();
      const img = await generateImage(
        `${desc}, standing idle fighting stance, character reference, ${SPRITE_STYLE}`,
        (Math.random() * 1e6) | 0);
      const norm = normalizeFrame(img, null);
      if (!norm) throw new Error('normalize failed (no subject found)');
      stRefPreview = norm;
      stStatus = 'reference generated — review and click "use as reference"';
    } else {
      const mv = curMove();
      if (!mv) throw new Error('no move selected');
      const palette = m.palette ?? null;
      const moveDesc = m.moveDesc?.[mv.id] || mv.id;
      const n = mv.steps.length;
      for (let i = 0; i < n; i++) {
        stStatus = `generating ${mv.id} frame ${i + 1}/${n}…`; renderAll();
        const img = await generateImage(
          `${desc}, ${moveDesc}, animation frame ${i + 1} of ${n}, ${SPRITE_STYLE}`,
          ((Math.random() * 1e6) | 0) + i);
        const norm = normalizeFrame(img, palette);
        if (!norm) continue;
        stGenResults.set(i, { norm, qc: qcScore(norm, m.refBodyW ?? null), accepted: false });
        renderAll();
      }
      stStatus = `generated ${stGenResults.size}/${n} frames — review QC + accept`;
    }
  } catch (e) {
    stStatus = `generation failed: ${(e as Error).message}`;
  }
  stGenBusy = false;
  renderAll();
};

const renderGenerateTab = (): HTMLElement => {
  const b = stBundle!;
  const m = meta();
  const mv = curMove();

  const thumb = (c: HTMLCanvasElement, size = 150): HTMLCanvasElement => {
    const t = mkEl('canvas', { width: size, height: size, class: 'thumb' });
    const tc = t.getContext('2d')!;
    tc.imageSmoothingEnabled = false;
    tc.fillStyle = '#12141f';
    tc.fillRect(0, 0, size, size);
    tc.drawImage(c, 0, 0, size, size);
    return t;
  };

  const refSection = mkEl('div', { class: 'genblock' },
    mkEl('b', {}, '1 · reference sheet (the consistency contract)'),
    mkEl('div', { class: 'row' },
      mkEl('label', {}, 'character description ', mkEl('input', {
        value: m.desc ?? '', style: 'width:420px',
        placeholder: 'e.g. cyberpunk karate robot, red chassis, yellow visor',
        onchange: (e: Event) => { m.desc = (e.target as HTMLInputElement).value; stDirty = true; },
      })),
      mkEl('button', { disabled: stGenBusy ? '' : null, onclick: () => void runGeneration('reference') },
        stGenBusy ? '…' : 'generate reference'),
    ),
    stRefPreview ? mkEl('div', { class: 'row' },
      thumb(stRefPreview.cell),
      mkEl('button', {
        onclick: () => {
          const pal = extractPalette(stRefPreview!.cell, 16);
          m.palette = pal;
          m.refBodyW = stRefPreview!.bodyW;
          void saveSprite('_reference.png', stRefPreview!.cell);
          stDirty = true;
          stStatus = `reference locked: ${pal.length}-color palette, body ${stRefPreview!.bodyW}×${stRefPreview!.bodyH}`;
          renderAll();
        },
      }, 'use as reference'),
    ) : null,
    m.palette ? mkEl('div', { class: 'row' },
      mkEl('span', { class: 'hint' }, `locked palette (${m.palette.length}):`),
      ...m.palette.map((c) => mkEl('span', {
        class: 'swatch', style: `background:rgb(${c[0]},${c[1]},${c[2]})`,
      })),
    ) : mkEl('p', { class: 'hint' }, 'no reference yet — frames will skip palette lock + QC'),
  );

  const results: HTMLElement[] = [];
  if (mv) {
    for (let i = 0; i < mv.steps.length; i++) {
      const r = stGenResults.get(i);
      results.push(mkEl('div', { class: 'genframe' },
        mkEl('div', { class: 'hint' }, `step ${i} · ${mv.steps[i]!.phase}`),
        r ? thumb(r.norm.cell) : mkEl('div', { class: 'thumb empty' }, '—'),
        r ? mkEl('div', { class: r.qc.pass ? 'qc pass' : 'qc fail' },
          `QC ${r.qc.score} · pal ${(r.qc.paletteMatch * 100).toFixed(0)}%`) : null,
        r ? mkEl('div', {},
          mkEl('button', {
            disabled: r.accepted ? '' : null,
            onclick: () => {
              const name = spriteName(mv.id, i);
              void saveSprite(name, r.norm.cell).then(() => {
                mv.steps[i]!.sprite = name;
                r.accepted = true;
                stDirty = true;
                stStatus = `accepted ${name}`;
                renderAll();
              });
            },
          }, r.accepted ? 'accepted ✓' : 'accept'),
        ) : null,
      ));
    }
  }

  const moveSection = mkEl('div', { class: 'genblock' },
    mkEl('b', {}, '2 · per-move animation frames'),
    mkEl('div', { class: 'row' },
      mkEl('label', {}, 'move ', selInput(mv?.id ?? '', b.moves.map((x) => x.id), (id) => {
        stMoveIdx = b.moves.findIndex((x) => x.id === id);
        stGenResults = new Map();
      })),
      mv ? mkEl('label', {}, ' pose description ', mkEl('input', {
        value: m.moveDesc?.[mv.id] ?? '', style: 'width:340px',
        placeholder: 'e.g. throwing a heavy straight right punch',
        onchange: (e: Event) => {
          (m.moveDesc ??= {})[mv.id] = (e.target as HTMLInputElement).value;
          stDirty = true;
        },
      })) : null,
      mkEl('button', { disabled: stGenBusy || !mv ? '' : null, onclick: () => void runGeneration('move') },
        stGenBusy ? 'generating…' : `generate ${mv?.steps.length ?? 0} frames`),
    ),
    mkEl('div', { class: 'genrow' }, ...results),
    mkEl('p', { class: 'hint' },
      'accept a frame → it becomes the step sprite; then Frames tab → auto-hurtbox / auto-hitbox drafts. Save when done.'),
  );

  return mkEl('div', { class: 'pane' }, refSection, moveSection);
};

// ------------------------------------------------------------------ root
const renderAll = (): void => {
  const app = document.getElementById('app')!;
  cancelAnimationFrame(stRaf);
  app.replaceChildren();
  if (!stBundle) {
    app.append(mkEl('div', { class: 'pane' }, stStatus));
    return;
  }
  app.append(renderHeader());
  switch (stTab) {
    case 'character': app.append(renderCharacterTab()); break;
    case 'frames': app.append(renderFramesTab()); break;
    case 'moves': app.append(renderMovesTab()); break;
    case 'cancels': app.append(renderCancelsTab()); break;
    case 'test': app.append(renderTestTab()); break;
    case 'generate': app.append(renderGenerateTab()); break;
  }
};

// boot
void (async () => {
  try {
    stCharList = await apiJson<string[]>('/api/characters');
    if (stCharList.length === 0) throw new Error('no characters found');
    await loadChar(stCharList.includes('analog') ? 'analog' : stCharList[0]!);
  } catch (e) {
    stStatus = `boot failed: ${(e as Error).message}`;
  }
  renderAll();
})();
