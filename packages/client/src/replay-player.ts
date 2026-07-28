/**
 * REPLAY PLAYER (ADR 0010) — watch a stored match ledger.
 *
 * Self-contained and embeddable: it is bundled to a standalone ESM served from
 * the game origin, and the marketing site imports it cross-origin to play a
 * replay inside its own page. That is the same pattern the site already uses
 * for the AIR Kit SDK, and it exists for the same reason — the sim and the
 * renderer must have exactly ONE source of truth, and it lives here, next to
 * `@af/core`, under `npm run verify`.
 *
 * WHAT A REPLAY ACTUALLY IS
 * The two input tracks plus the pinned setup. Nothing about the match is
 * stored as pixels or state: the sim is re-stepped from tick 0 with the
 * recorded buttons, which is bit-for-bit what the server did when it decided
 * the result. So this player is not "a video of the match" — it IS the match,
 * recomputed. That is why it can also VERIFY itself: re-simulate to the end,
 * hash the final state, and compare to the hash the server recorded.
 *
 * Rendering deliberately reuses the game's own `loadRoster` + `drawFighter`
 * rather than reimplementing sprite pivots and scaling. A replay that drew
 * fighters even slightly differently from the game would be a lie told in a
 * detail nobody would think to check.
 */
import {
  Phase, STAGE, createGameState, decodeLedger, fpToPx, setCharacters,
  setMatchItems, stateHash, step,
} from '@af/core';
import type { GameState, ItemEffect } from '@af/core';
import { drawFighter, loadRoster, resetFighterTrails } from './atlas.js';
import type { Roster } from './atlas.js';

/** The `pin` column of a `match_ledgers` row (see ADR 0010 / migration 0023). */
export interface ReplayPin {
  seed: number;
  stage?: string;
  bounds?: { left: number; right: number } | null;
  chars: [string, string];
  names: [string, string];
  delay?: number;
  items?: [Array<{ effect: ItemEffect }>, Array<{ effect: ItemEffect }>] | null;
  result?: {
    hash: number; winner: number; rounds: [number, number];
    endTick: number; reason: string;
  };
}

export interface ReplayState {
  ready: boolean;
  playing: boolean;
  /** Current tick, and how many the ledger holds. */
  tick: number;
  total: number;
  speed: number;
  /** Live round score, for a HUD drawn outside the canvas if the host wants. */
  rounds: [number, number];
  health: [number, number];
  /**
   * null until the replay has been simulated to its end, then:
   * true  — the final state hash matched what the server recorded;
   * false — it did not (engine drift, or a retuned character bundle).
   */
  verified: boolean | null;
  error: string | null;
}

export interface ReplayHandle {
  play(): void;
  pause(): void;
  toggle(): void;
  /** Jump to a tick. Rebuilds from 0 — a few thousand steps costs ~10ms. */
  seek(tick: number): void;
  setSpeed(mult: number): void;
  restart(): void;
  destroy(): void;
  getState(): ReplayState;
}

export interface MountOptions {
  canvas: HTMLCanvasElement;
  /** base64url ledger from the API. */
  ledger: string;
  pin: ReplayPin;
  /**
   * Origin serving `characters/` and `stages/` (the game site). Empty string
   * means same-origin, which is how the game itself would use this.
   */
  assetBase?: string;
  autoplay?: boolean;
  onState?: (s: ReplayState) => void;
}

const TICK_MS = 1000 / 60;

export const mountReplay = async (opts: MountOptions): Promise<ReplayHandle> => {
  const { canvas, pin } = opts;
  const base = (opts.assetBase ?? '').replace(/\/$/, '');
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('replay: canvas 2d context unavailable');

  const state: ReplayState = {
    ready: false, playing: false, tick: 0, total: 0, speed: 1,
    rounds: [0, 0], health: [1, 1], verified: null, error: null,
  };
  const emit = (): void => opts.onState?.({ ...state });

  // ---- decode + load the cast
  const [track0, track1] = decodeLedger(opts.ledger);
  state.total = Math.min(track0.length, track1.length);

  const [r0, r1] = await Promise.all([
    loadRoster(pin.chars[0], base),
    loadRoster(pin.chars[1], base),
  ]);
  const rosters: [Roster, Roster] = [r0, r1];
  const maxHealth: [number, number] = [
    r0.bundle.maxHealth || 1, r1.bundle.maxHealth || 1,
  ];

  let game: GameState = createGameState(pin.seed, pin.bounds ?? undefined);

  /**
   * Install the pinned setup and re-step to `target`.
   *
   * Characters and items are re-installed on EVERY rebuild, not once at mount.
   * They live in module-level slots inside the core (the `setCharacters`
   * pattern), so another replay — or the game itself — mounting in the same
   * page would otherwise leave the wrong cast installed and silently produce a
   * different match.
   */
  const rebuild = (target: number): void => {
    setCharacters(r0.ch, r1.ch);
    setMatchItems(
      (pin.items?.[0] ?? []).map((p) => p.effect),
      (pin.items?.[1] ?? []).map((p) => p.effect),
    );
    game = createGameState(pin.seed, pin.bounds ?? undefined);
    resetFighterTrails();
    let t = 0;
    while (t < target && t < state.total && game.phase !== Phase.MatchOver) {
      step(game, [track0[t]! | 0, track1[t]! | 0]);
      t++;
    }
    state.tick = t;
    syncReadouts();
  };

  const syncReadouts = (): void => {
    state.rounds = [game.roundsWon0, game.roundsWon1];
    state.health = [
      Math.max(0, game.fighters[0].health) / maxHealth[0],
      Math.max(0, game.fighters[1].health) / maxHealth[1],
    ];
  };

  const advance = (): void => {
    if (state.tick >= state.total || game.phase === Phase.MatchOver) {
      state.playing = false;
      checkVerified();
      return;
    }
    step(game, [track0[state.tick]! | 0, track1[state.tick]! | 0]);
    state.tick++;
    syncReadouts();
  };

  /**
   * The trust check, run once the replay reaches its end: does the state we
   * arrived at hash to what the server recorded?
   *
   * A forfeit is exempt. Its winner was awarded by the disconnect ladder, not
   * derived from the ledger, so the ledger legitimately stops before anyone
   * has won — the HASH still matches, which is what is checked here.
   */
  const checkVerified = (): void => {
    if (state.verified !== null || !pin.result) return;
    state.verified = stateHash(game) === pin.result.hash;
  };

  // ---------------------------------------------------------------- render

  const draw = (): void => {
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    // Backdrop is procedural on purpose: the authored stage art is ~9 MB a
    // piece, which is an absurd toll on a page that just wants to show a
    // 40-second fight. The fight reads off the fighters, not the wallpaper.
    const sky = ctx.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0, '#0a1730');
    sky.addColorStop(0.55, '#0d2140');
    sky.addColorStop(1, '#050a14');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, w, h);

    const left = pin.bounds?.left ?? 0;
    const right = pin.bounds?.right ?? STAGE.widthPx;
    const f0 = game.fighters[0];
    const f1 = game.fighters[1];
    const x0 = fpToPx(f0.x);
    const x1 = fpToPx(f1.x);

    // Camera: frame both fighters with margin, clamped to the playfield, and
    // never zoomed past 1:1 — a replay that pushed in on a lone fighter would
    // hide the spacing, which in a fighting game is most of the information.
    const pad = 200;
    const spanX = Math.max(Math.abs(x1 - x0) + pad * 2, 520);
    const scale = Math.min(w / spanX, h / (STAGE.floorYPx + 120), 1.9);
    const midX = (x0 + x1) / 2;
    const halfW = w / (2 * scale);
    const camX = Math.max(left + halfW, Math.min(right - halfW, midX));
    const floorScreenY = h - 54;

    ctx.save();
    ctx.translate(w / 2, floorScreenY);
    ctx.scale(scale, scale);
    ctx.translate(-camX, -STAGE.floorYPx);

    // Ground plane + a few uprights so motion is legible against something.
    ctx.fillStyle = 'rgba(47,143,255,0.10)';
    ctx.fillRect(left, STAGE.floorYPx, right - left, 400);
    ctx.strokeStyle = 'rgba(110,182,255,0.55)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(left, STAGE.floorYPx);
    ctx.lineTo(right, STAGE.floorYPx);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(110,182,255,0.10)';
    ctx.lineWidth = 1;
    for (let gx = Math.ceil(left / 160) * 160; gx < right; gx += 160) {
      ctx.beginPath();
      ctx.moveTo(gx, STAGE.floorYPx - 260);
      ctx.lineTo(gx, STAGE.floorYPx);
      ctx.stroke();
    }

    const motion = (vx: number): number => Math.min(1, Math.abs(fpToPx(vx)) / 7);
    drawFighter(ctx, rosters[0], f0, state.tick, x0, fpToPx(f0.y), '#6eb6ff',
      { slot: 0, motion: motion(f0.velX) });
    drawFighter(ctx, rosters[1], f1, state.tick, x1, fpToPx(f1.y), '#ff3d6e',
      { slot: 1, motion: motion(f1.velX) });
    ctx.restore();

    drawHud(w);
  };

  const drawHud = (w: number): void => {
    const barW = Math.min(300, w / 2 - 28);
    const y = 16;
    for (const side of [0, 1] as const) {
      const frac = state.health[side]!;
      const x = side === 0 ? 16 : w - 16 - barW;
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(x - 2, y - 2, barW + 4, 16);
      ctx.fillStyle = 'rgba(255,255,255,0.14)';
      ctx.fillRect(x, y, barW, 12);
      const fillW = barW * frac;
      ctx.fillStyle = frac > 0.3 ? '#6eb6ff' : '#ff3d6e';
      // Both bars drain toward the centre, mirroring the game's HUD.
      ctx.fillRect(side === 0 ? x : x + barW - fillW, y, fillW, 12);

      ctx.font = '600 12px system-ui, sans-serif';
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = side === 0 ? 'left' : 'right';
      ctx.fillText(pin.names[side]!.slice(0, 22), side === 0 ? x : x + barW, y + 30);

      // Round pips
      const won = state.rounds[side]!;
      for (let i = 0; i < 2; i++) {
        const px = side === 0 ? x + i * 14 : x + barW - 8 - i * 14;
        ctx.beginPath();
        ctx.arc(px + 4, y + 42, 4, 0, Math.PI * 2);
        ctx.fillStyle = i < won ? '#ffe566' : 'rgba(255,255,255,0.22)';
        ctx.fill();
      }
    }

    ctx.textAlign = 'center';
    ctx.font = '600 13px ui-monospace, monospace';
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.fillText(`${(state.tick / 60).toFixed(1)}s`, w / 2, y + 14);

    if (game.phase === Phase.MatchOver || state.tick >= state.total) {
      const winner = pin.result?.winner ?? game.winner;
      ctx.font = '700 18px system-ui, sans-serif';
      ctx.fillStyle = '#ffe566';
      ctx.fillText(
        winner === 0 || winner === 1 ? `${pin.names[winner]!} WINS` : 'NO CONTEST',
        w / 2, y + 44,
      );
    }
  };

  // ------------------------------------------------------------- loop

  let raf = 0;
  let last = 0;
  let acc = 0;
  let alive = true;

  const frame = (now: number): void => {
    if (!alive) return;
    raf = requestAnimationFrame(frame);
    if (state.playing) {
      // Clamp the delta: a backgrounded tab returns with a huge gap, and
      // replaying ten seconds of match in one frame looks like a glitch.
      const dt = Math.min(now - last, 250);
      acc += dt * state.speed;
      let guard = 0;
      while (acc >= TICK_MS && state.playing && guard++ < 600) {
        acc -= TICK_MS;
        advance();
      }
    }
    last = now;
    draw();
    emit();
  };

  rebuild(0);
  state.ready = true;
  state.playing = opts.autoplay !== false;
  last = performance.now();
  raf = requestAnimationFrame(frame);
  emit();

  return {
    play: () => { state.playing = true; acc = 0; },
    pause: () => { state.playing = false; },
    toggle: () => { state.playing = !state.playing; acc = 0; },
    seek: (t: number) => {
      state.verified = null;
      rebuild(Math.max(0, Math.min(state.total, Math.floor(t))));
      if (state.tick >= state.total) checkVerified();
    },
    setSpeed: (m: number) => { state.speed = Math.max(0.1, Math.min(4, m)); },
    restart: () => { state.verified = null; rebuild(0); state.playing = true; },
    destroy: () => { alive = false; cancelAnimationFrame(raf); },
    getState: () => ({ ...state }),
  };
};
