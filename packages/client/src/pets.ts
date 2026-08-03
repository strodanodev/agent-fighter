/**
 * PETS — the companion that floats behind a fighter (ADR 0011).
 *
 * PURELY COSMETIC. The sim knows a pet only as five per-mille numbers on the
 * fighter (its aura); everything in this file is render-time. The pet's
 * position is a pure function of the fighter's state plus the tick, so it
 * rolls back with everything else and needs no state of its own.
 *
 * Art is optional. A pet.json with no `sprites` draws as a procedural
 * companion in its tint — which means a pet published ahead of its Studio art
 * is still playable, and a failed image load degrades instead of vanishing.
 */

import { STAGE } from '@af/core';
import type { FighterState, PetDef, PetMotion } from '@af/core';
import type { NetPetPin } from './net.js';

/** A loaded pet: its definition plus whatever art actually decoded. */
export interface LoadedPet {
  id: string;
  def: PetDef;
  frames: HTMLImageElement[];
  tint: string;
}

const DEFAULT_TINT = '#6fd3ff';
const petCache = new Map<string, Promise<LoadedPet | null>>();

const loadPetImage = (src: string): Promise<HTMLImageElement | null> =>
  new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null); // missing art is never fatal
    img.src = src;
  });

/**
 * Load `pets/<id>/pet.json` + its frames. Memoised per id (pets are immutable
 * for the page's lifetime, like character bundles) and never throws: an
 * unreachable pet resolves to null and the caller simply draws nothing.
 */
export const loadPet = (id: string, base = ''): Promise<LoadedPet | null> => {
  const hit = petCache.get(id);
  if (hit) return hit;
  const p = (async (): Promise<LoadedPet | null> => {
    try {
      const res = await fetch(`${base}pets/${id}/pet.json`);
      if (!res.ok) return null;
      const def = await res.json() as PetDef;
      const names = Array.isArray(def.sprites) ? def.sprites.slice(0, 16) : [];
      const frames = (await Promise.all(
        names.map((n) => loadPetImage(`${base}pets/${id}/${n}`)),
      )).filter((i): i is HTMLImageElement => i !== null);
      return { id, def, frames, tint: def.tint ?? DEFAULT_TINT };
    } catch {
      return null;
    }
  })();
  petCache.set(id, p);
  return p;
};

/** Preload the pets a match pinned. Returns one entry per side (null = none). */
export const loadMatchPets = async (
  pins: [NetPetPin | null, NetPetPin | null] | undefined, base = '',
): Promise<[LoadedPet | null, LoadedPet | null]> => {
  if (!pins) return [null, null];
  const [a, b] = await Promise.all([
    pins[0] ? loadPet(pins[0].id, base) : Promise.resolve(null),
    pins[1] ? loadPet(pins[1].id, base) : Promise.resolve(null),
  ]);
  return [a, b];
};

/**
 * Where the pet sits this frame: BEHIND the fighter (opposite the way they
 * face), shoulder height, bobbing.
 *
 * Deliberately derived from the fighter's CURRENT state only — no smoothing
 * buffer, no velocity integration of its own. A pet that kept private state
 * would drift after a rollback re-sim and the two peers' screens would stop
 * agreeing about where it is. The lag is faked by leaning the offset against
 * the fighter's velocity instead, which is a pure function of the frame.
 */
const petPos = (
  f: FighterState, tick: number, x: number, y: number, size: number,
  motion: PetMotion,
): { x: number; y: number; onGround: boolean } => {
  const behind = -f.facing; // the side away from the opponent
  const drift = Math.max(-14, Math.min(14, -(f.velX / 256) * 1.6)); // trails the dash
  const speed = Math.abs(f.velX) / 256;

  if (motion === 'ground') {
    // Walks the floor and STAYS there when the fighter jumps — that is the
    // whole difference between having feet and not. A trot bounce scales
    // with the fighter's speed, so it is still when they are still.
    const trot = speed > 0.5 ? Math.abs(Math.sin(tick * 0.28)) * Math.min(6, speed * 1.2) : 0;
    return {
      x: x + behind * (30 + size * 0.3) + drift,
      y: STAGE.floorYPx - trot,
      onGround: true,
    };
  }

  const bob = Math.sin((tick + x) * 0.06) * (size * 0.09);
  return {
    x: x + behind * (34 + size * 0.25) + drift,
    y: y - 78 - size * 0.35 + bob,
    onGround: false,
  };
};

/**
 * Draw one fighter's pet. Call BEFORE the fighter itself — "floating behind"
 * is both a position and a z-order.
 *
 * `critFlash` on the fighter (set by the sim when its crit aura fires) makes
 * the pet flare: the companion is where the aura visibly lives, so the player
 * can tell the pet did something rather than guessing at the damage numbers.
 */
export const drawPet = (
  ctx: CanvasRenderingContext2D,
  pet: LoadedPet,
  f: FighterState,
  tick: number,
  fx: number,
  fy: number,
): void => {
  const size = pet.def.sizePx ?? 44;
  const motion: PetMotion = pet.def.motion === 'ground' ? 'ground' : 'float';
  const { x, y, onGround } = petPos(f, tick, fx, fy, size, motion);
  const flare = f.critFlash > 0 ? f.critFlash / 24 : 0;
  // A ground pet is drawn standing ON its position; a floater is centred on
  // it. `gy` is where the glow and the procedural body belong either way.
  const gy = onGround ? y - size * 0.45 : y;

  ctx.save();

  if (onGround) {
    // Its own contact shadow — without one a walking pet reads as sliding.
    ctx.fillStyle = 'rgba(0,0,0,0.38)';
    ctx.beginPath();
    ctx.ellipse(x, STAGE.floorYPx + 2, size * 0.3, size * 0.09, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // Aura glow — brighter the instant a crit lands.
  const glow = ctx.createRadialGradient(x, gy, 1, x, gy, size * (0.85 + flare * 0.7));
  glow.addColorStop(0, `${pet.tint}${flare > 0 ? 'cc' : '66'}`);
  glow.addColorStop(1, `${pet.tint}00`);
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(x, gy, size * (0.85 + flare * 0.7), 0, Math.PI * 2);
  ctx.fill();
  ctx.globalCompositeOperation = 'source-over';

  if (pet.frames.length > 0) {
    const fps = Math.max(1, Math.min(30, pet.def.fps ?? 8));
    const img = pet.frames[Math.floor((tick * fps) / 60) % pet.frames.length]!;
    const h = size;
    const w = img.width > 0 ? (img.width / img.height) * h : h;
    ctx.imageSmoothingEnabled = false;
    // Mirror with the fighter so the pet always looks the way they do.
    ctx.translate(x, y);
    ctx.scale(f.facing, 1);
    // A ground pet stands ON y (feet on the floor); a floater is centred.
    ctx.drawImage(img, -w / 2, onGround ? -h : -h / 2, w, h);
  } else {
    drawProceduralPet(ctx, x, gy, size, pet.tint, tick, flare);
  }

  ctx.restore();
};

/**
 * The art-less companion: a hovering core with an orbiting spark and two
 * fins. Small, readable at gameplay scale, and clearly not a fighter — it
 * must never be mistaken for a hittable object, because it isn't one.
 */
const drawProceduralPet = (
  ctx: CanvasRenderingContext2D,
  x: number, y: number, size: number, tint: string, tick: number, flare: number,
): void => {
  const r = size * 0.26;
  const flap = Math.sin(tick * 0.16); // wing beat, not a drift

  ctx.translate(x, y);

  // Wings, beating. Big and translucent so the silhouette reads as ALIVE at
  // gameplay scale — a plain disc with a slot on it reads as a HUD icon, which
  // is the one thing a companion must never look like.
  for (const dir of [-1, 1]) {
    ctx.fillStyle = `${tint}44`;
    ctx.beginPath();
    ctx.moveTo(dir * r * 0.5, -r * 0.15);
    ctx.quadraticCurveTo(
      dir * r * 2.4, -r * (1.5 + flap * 0.5),
      dir * r * 2.2, r * (0.1 + flap * 0.3),
    );
    ctx.quadraticCurveTo(dir * r * 1.3, r * 0.5, dir * r * 0.5, r * 0.2);
    ctx.closePath();
    ctx.fill();
  }

  // Tail wisp, trailing the beat.
  ctx.strokeStyle = `${tint}66`;
  ctx.lineWidth = Math.max(1, r * 0.16);
  ctx.beginPath();
  ctx.moveTo(0, r * 0.7);
  ctx.quadraticCurveTo(r * 0.5 * flap, r * 1.5, -r * 0.4 * flap, r * 2.1);
  ctx.stroke();

  // Body.
  const body = ctx.createRadialGradient(-r * 0.3, -r * 0.4, r * 0.1, 0, 0, r);
  body.addColorStop(0, '#ffffff');
  body.addColorStop(0.5, tint);
  body.addColorStop(1, '#0b0e13');
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fill();

  // Two eyes — the cheapest possible "this is a creature" signal. They widen
  // on a crit, which is the only tell the player needs.
  const eyeR = Math.max(1, r * (0.17 + flare * 0.1));
  ctx.fillStyle = `rgba(8,11,17,${0.85 - flare * 0.5})`;
  for (const dir of [-1, 1]) {
    ctx.beginPath();
    ctx.arc(dir * r * 0.34, -r * 0.12, eyeR, 0, Math.PI * 2);
    ctx.fill();
  }

  // Orbiting spark.
  const a = tick * 0.08;
  ctx.fillStyle = '#ffffff';
  ctx.globalAlpha = 0.55 + flare * 0.45;
  ctx.beginPath();
  ctx.arc(Math.cos(a) * r * 1.7, Math.sin(a) * r * 0.8, Math.max(1.2, r * 0.14), 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;
};
