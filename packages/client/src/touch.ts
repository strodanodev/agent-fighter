/**
 * On-screen touch controls for phones/tablets. Auto-detects iOS/Android (or any
 * coarse-pointer device) and, when present, overlays an MvC-style pad: an 8-way
 * motion stick on the left (so quarter-circle / dragon-punch motions roll
 * naturally) and — since the 2026-07 control redesign — a second, radial stick
 * on the right that carries all six attacks, with a SPECIAL button above it.
 *
 * WHY A WHEEL AND NOT SIX BUTTONS. A 3×2 grid of round buttons is a keyboard
 * drawn on glass: every magic-series link (LP→MP→HP) is a separate lift-and-
 * re-aim, and a thumb that lands between two buttons presses nothing. The
 * wheel is hit-tested by ANGLE from its center, so the whole disc is live —
 * there is no dead gap to miss — and sliding one thumb around the rim rolls
 * straight through a chain without ever leaving the glass.
 *
 * It is deliberately DECOUPLED from the game's input code: each control simply
 * drives Player-0's existing key bindings (via the afPress/afRelease hooks, or
 * synthetic `KeyboardEvent`s as a fallback), so the sim, audio-unlock, and menu
 * handling all run through the exact same path as a physical keyboard. Nothing
 * in the deterministic core is touched.
 *
 * Multi-touch is fully supported and is what makes combos work: every pointer
 * tracks its OWN wedge, so two thumbs on the wheel hold two attacks at once
 * (throws = LP+LK, super = 2 punches) exactly like two fingers on a real pad.
 */

import { audio } from './audio.js';
import { DISPLAY_FONT_STACK } from './chrome.js';

/**
 * Set by initTouchControls once the overlay exists. Kept as a module-level
 * hook so main.ts can push the current screen from inside its own game frame
 * (see setTouchScreen) rather than the overlay running a second rAF loop of
 * its own — one clock, no extra wakeups on a phone, and it stays in step with
 * what the renderer just drew.
 */
let applyScreen: ((screen: string) => void) | null = null;

/** Tell the touch overlay which screen is live. No-op on desktop. */
export const setTouchScreen = (screen: string): void => { applyScreen?.(screen); };

/** Same one-clock arrangement as `applyScreen`, for the SPECIAL button. */
let applyCharged: ((charged: boolean) => void) | null = null;

/**
 * Tell the overlay whether the local fighter has at least one meter bar.
 * SPECIAL is hidden without it: the button spends a bar, and a control that is
 * present but inert teaches players to distrust the pad. Pushed per frame from
 * main.ts (edge-triggered inside), so it appears the instant the bar fills.
 */
export const setTouchCharged = (charged: boolean): void => { applyCharged?.(charged); };

/** True on iOS/iPadOS/Android or any primary coarse-pointer (touch) device. */
export const isMobileDevice = (): boolean => {
  // Manual override for touchscreen laptops / QA: ?touch=1 forces on, ?touch=0 off.
  const force = new URLSearchParams(location.search).get('touch');
  if (force === '1') return true;
  if (force === '0') return false;
  const ua = navigator.userAgent || '';
  const iOS = /iPhone|iPad|iPod/i.test(ua)
    // iPadOS 13+ masquerades as desktop Safari — detect by touch + Mac.
    || (/Macintosh/.test(ua) && typeof document !== 'undefined' && 'ontouchend' in document);
  const android = /Android/i.test(ua);
  const coarse = typeof matchMedia === 'function'
    && matchMedia('(pointer: coarse)').matches && navigator.maxTouchPoints > 0;
  return iOS || android || coarse;
};

// Player-0 key bindings (must mirror P0_MAP / CONFIRM in main.ts).
const K = {
  left: 'KeyA', right: 'KeyD', up: 'KeyW', down: 'KeyS',
  lp: 'KeyT', mp: 'KeyY', hp: 'KeyU', lk: 'KeyG', mk: 'KeyH', hk: 'KeyJ',
  start: 'Enter', back: 'Escape',
} as const;

/**
 * The attack wheel's six wedges, in ANGLE order (degrees, screen space: 0° =
 * right, +90° = DOWN). Every wedge is 60° wide and the seams fall on the
 * vertical axis, which is what puts punches on the left half and kicks on the
 * right half — the same left/right split as the P/K columns of the old grid,
 * so muscle memory carries over. Strength runs bottom→top: light at the
 * bottom (where the thumb rests), heavy at the top (a deliberate reach, and
 * the one you least want to fat-finger).
 *
 * Order matters: `wedgeAt` indexes this array directly from the angle.
 */
const WEDGES = [
  { code: K.mk, label: 'MK', a0: -30, cls: 'k', str: 2 },
  { code: K.lk, label: 'LK', a0: 30, cls: 'k', str: 1 },
  { code: K.lp, label: 'LP', a0: 90, cls: 'p', str: 1 },
  { code: K.mp, label: 'MP', a0: 150, cls: 'p', str: 2 },
  { code: K.hp, label: 'HP', a0: 210, cls: 'p', str: 3 },
  { code: K.hk, label: 'HK', a0: 270, cls: 'k', str: 3 },
] as const;
const WEDGE_DEG = 60;

/**
 * ATTACK GLYPHS — a fist for punches, a boot for kicks, authored in a 24×24
 * box. Letters ("LP", "MK") are a manual, not a control: they need reading,
 * they're English, and at phone size six two-letter pairs turn into six
 * identical grey smudges. A fist and a boot separate on SILHOUETTE alone, at
 * any size, in any language — and strength is carried by the pip count under
 * the glyph plus a size step, so the whole label is read, never parsed.
 *
 * Each glyph is a UNION of plain shapes with no strokes: stroking the parts
 * would draw every internal seam between them. Separation from the stage art
 * comes from a drop-shadow, which follows the union's own alpha.
 */
const GLYPH: Record<'p' | 'k', { body: string; cut: string }> = {
  // Fist, side-on, facing right: cuff, palm mass, three knuckle bumps, thumb.
  // The cuts are what make it a FIST rather than a blob — a silhouette this
  // small has no internal contrast of its own, so the knuckle gaps have to be
  // drawn in as negative space.
  p: {
    body: '<rect x="1" y="9.6" width="5.6" height="6" rx="1.6"/>'
      + '<rect x="4.6" y="6.6" width="12.6" height="12.4" rx="4.6"/>'
      + '<circle cx="16.8" cy="9.6" r="2.7"/><circle cx="17.6" cy="13.2" r="2.8"/>'
      + '<circle cx="16.8" cy="16.8" r="2.7"/>'
      + '<circle cx="9.6" cy="18.4" r="3.1"/>',
    cut: '<path d="M13.4,10.9 H19.2 M13.4,15.4 H19.4 M12.4,7.4 V18.2"/>',
  },
  // Boot in profile, toe right: shin, foot, rounded toe and heel + ankle cut.
  k: {
    body: '<rect x="5.2" y="2.2" width="6.8" height="11.4" rx="2.4"/>'
      + '<rect x="4.2" y="11.2" width="14" height="6.9" rx="2.8"/>'
      + '<circle cx="17.3" cy="14.6" r="3.5"/><circle cx="7.4" cy="14.7" r="3.4"/>',
    cut: '<path d="M5.6,11.4 H12.2"/>',
  },
};

/** Light→dark glass sheen, one per SVG so no id can collide document-wide. */
const sheenDefs = (id: string): string =>
  `<defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">`
  + '<stop offset="0" stop-color="#ffffff" stop-opacity="0.22"/>'
  + '<stop offset="0.42" stop-color="#ffffff" stop-opacity="0.03"/>'
  + '<stop offset="1" stop-color="#000000" stop-opacity="0.18"/>'
  + '</linearGradient></defs>';

/** A row of `n` gold diamonds — the strength read (1 = light, 3 = heavy). */
const pips = (n: number, y: number): string => {
  const gap = 7.4;
  const x0 = -((n - 1) * gap) / 2;
  return Array.from({ length: n }, (_, i) => {
    const x = x0 + i * gap;
    return `<polygon class="pip" points="${x},${y - 2.8} ${x + 2.8},${y} ${x},${y + 2.8} ${x - 2.8},${y}"/>`;
  }).join('');
};

/** Wheel geometry in SVG user units (viewBox 0 0 200 200). */
const WHEEL = { cx: 100, cy: 100, r: 94, labelR: 58, hubR: 19 } as const;

/** Polar → cartesian in the wheel's own SVG space. */
const wheelPt = (deg: number, rad: number): [number, number] => {
  const a = (deg * Math.PI) / 180;
  return [WHEEL.cx + Math.cos(a) * rad, WHEEL.cy + Math.sin(a) * rad];
};

/**
 * ---- ARCADE CHROME -------------------------------------------------------
 * The pads are cut as POLYGONS, not circles, so they belong to the same world
 * as the rest of the HUD: the fight timer is a gold-rimmed octagon (ui.ts
 * drawTimer), the nameplates and pips are angular chrome, and real arcade
 * sticks ship with octagonal gates. So the motion stick gets an octagon and
 * the attack wheel a hexagon whose six flat faces are its six buttons — the
 * shape states the input count before you read a single label.
 *
 * Everything stays translucent: gold hairlines and low-alpha fills over the
 * fight, never a solid panel sitting on top of it.
 */

/** Vertices of a regular n-gon, first vertex at `start`°, in SVG units. */
const ngon = (n: number, start: number, r: number, cx = 100, cy = 100): [number, number][] =>
  Array.from({ length: n }, (_, k) => {
    const a = ((start + (360 / n) * k) * Math.PI) / 180;
    return [cx + Math.cos(a) * r, cy + Math.sin(a) * r] as [number, number];
  });

/** n-gon as an SVG `points` attribute. */
const poly = (n: number, start: number, r: number, cx = 100, cy = 100): string =>
  ngon(n, start, r, cx, cy).map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' ');

/**
 * The same n-gon as a CSS `clip-path`, in percent. Used to clip each pad's
 * backdrop blur to its silhouette — without it the blur would render as an
 * obvious frosted SQUARE behind a polygonal frame.
 */
const padClip = (n: number, start: number): string =>
  `polygon(${ngon(n, start, 50, 50, 50).map(([x, y]) => `${x.toFixed(2)}% ${y.toFixed(2)}%`).join(',')})`;

/** Octagon rotated 22.5° — flat top/sides, exactly like the fight timer. */
const OCT_START = 22.5;
/** Hexagon with a vertex on every wedge seam, so each wedge owns one face. */
const HEX_START = 30;

// HUD palette (ui.ts) — the pads must read as the same kit as the health bars.
const PAD_GOLD = '#d9a441';
const PAD_GOLD_LT = '#f7e0a3';

/**
 * Which wedge a touch at (dx, dy) from the wheel's center selects. Distance is
 * IGNORED on purpose: the entire disc is live (no dead center to miss), and a
 * thumb that slides past the rim mid-combo keeps holding its wedge instead of
 * silently dropping the button.
 */
const wedgeAt = (dx: number, dy: number): number => {
  const deg = (Math.atan2(dy, dx) * 180) / Math.PI;
  // Rotate so wedge 0 ([-30°,30°)) starts at 0, then bucket by 60°.
  const rel = (((deg - WEDGES[0].a0) % 360) + 360) % 360;
  return Math.min(WEDGES.length - 1, Math.floor(rel / WEDGE_DEG));
};

/** Install the overlay. No-op on desktop or if already installed. */
export const initTouchControls = (): void => {
  if (!isMobileDevice()) return;
  if (document.getElementById('af-touch')) return;

  // ---- key dispatch ------------------------------------------------------
  // Prefer the client's afPress/afRelease hooks (direct Set mutation). Synthetic
  // KeyboardEvents are unreliable on iOS Safari — `code` has historically been
  // empty on constructed events, which would silently kill the whole pad.
  type KeyHooks = { afPress?: (c: string) => void; afRelease?: (c: string) => void };
  const hooks = (): KeyHooks => globalThis as KeyHooks;
  const down = new Set<string>();
  const press = (code: string): void => {
    if (down.has(code)) return; // keydown fires once per hold, like a real key
    down.add(code);
    const h = hooks();
    if (h.afPress) h.afPress(code);
    else window.dispatchEvent(new KeyboardEvent('keydown', { code, key: code, bubbles: true }));
  };
  const release = (code: string): void => {
    if (!down.has(code)) return;
    down.delete(code);
    const h = hooks();
    if (h.afRelease) h.afRelease(code);
    else window.dispatchEvent(new KeyboardEvent('keyup', { code, key: code, bubbles: true }));
  };
  /** Drop every held key — used when the overlay hides, backgrounds, or opens a menu. */
  const releaseAll = (): void => { for (const c of [...down]) release(c); };

  // ---- styles ------------------------------------------------------------
  const style = document.createElement('style');
  style.textContent = `
    /* The overlay speaks the HUD's language: Anton (DISPLAY_FONT_STACK, the
       same face as the nameplates, timer and announcements) instead of the
       Courier it shipped with, which read like a terminal bolted to an arcade
       cabinet. Anton is condensed titling, so labels get real tracking. */
    #af-touch{position:fixed;inset:0;z-index:50;pointer-events:none;
      touch-action:none;-webkit-user-select:none;user-select:none;
      -webkit-tap-highlight-color:transparent;font-family:${DISPLAY_FONT_STACK}}
    #af-touch.hidden{display:none}
    #af-touch .zone{position:absolute;bottom:0;pointer-events:none}
    #af-touch button,#af-touch .pad{pointer-events:auto;touch-action:none;
      -webkit-user-select:none;user-select:none;-webkit-tap-highlight-color:transparent}
    /* Translucent throughout — gold hairlines and low-alpha fills, never a
       solid panel. The controls must read over bright stage art AND a dark KO
       screen without ever becoming the thing you look at. Glass, not paint.
       Every pad is a POLYGON clipped to its own silhouette so the backdrop
       blur can't show up as a frosted square behind an angular frame. */
    /* NOTE: no position here. An id+class selector outranks a bare id, so a
       position declared in this shared rule silently beats the motion stick's
       own position:fixed and drops it into normal flow at the top-left of the
       page. Each pad declares its own positioning. */
    #af-touch .pad{
      -webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px);
      filter:drop-shadow(0 4px 14px rgba(0,0,0,0.42))}
    #af-touch .pad>svg{position:absolute;inset:0;width:100%;height:100%;
      pointer-events:none;overflow:visible}
    /* Shared plate language: a gold rim, a darker inner keyline, and a fill
       you can see the fight through. */
    #af-touch .rim{fill:rgba(18,15,28,0.20);stroke:${PAD_GOLD};stroke-width:2.5;
      stroke-linejoin:round;opacity:0.78}
    #af-touch .rim-in{fill:none;stroke:rgba(255,255,255,0.20);stroke-width:1.25;
      stroke-linejoin:round}
    /* Lit from above, like every other piece of chrome in the HUD. Non-
       interactive paint that only ever ADDS light at the top and shade at the
       bottom, so the pads stay see-through. */
    #af-touch .sheen{pointer-events:none}
    /* Panel screws. Two-tone (bright core, dark ring) so they read as hardware
       at 3px rather than as stray dots. */
    #af-touch .rivet{fill:rgba(247,224,163,0.55);stroke:rgba(0,0,0,0.45);
      stroke-width:1}
    /* motion stick (left) — octagonal gate, like the fight timer and like the
       real thing: an arcade stick's gate is what makes 236/623 motions roll. */
    #af-pad{position:fixed;left:max(3.5vmin,env(safe-area-inset-left));
      bottom:max(4vmin,env(safe-area-inset-bottom));
      width:34vmin;height:34vmin;max-width:210px;max-height:210px;
      clip-path:${padClip(8, OCT_START)}}
    #af-pad .gate{fill:none;stroke:rgba(255,255,255,0.14);stroke-width:1;
      stroke-dasharray:4 6;stroke-linejoin:round}
    #af-pad .tick{stroke:rgba(255,255,255,0.34);stroke-width:1.6;stroke-linecap:round}
    #af-pad .tick.major{stroke:${PAD_GOLD};stroke-width:2.6;opacity:0.75}
    /* The knob is its own octagon, half a step brighter than the gate so the
       eye tracks it against the fight behind. */
    #af-pad .stick{position:absolute;left:50%;top:50%;width:46%;height:46%;
      transform:translate(-50%,-50%);transition:transform .04s linear;
      pointer-events:none;filter:drop-shadow(0 2px 6px rgba(0,0,0,0.5))}
    #af-pad .stick svg{width:100%;height:100%;overflow:visible}
    #af-pad .knob{fill:rgba(255,255,255,0.18);stroke:${PAD_GOLD_LT};stroke-width:3;
      stroke-linejoin:round}
    #af-pad .knob-sheen{pointer-events:none}
    #af-pad .knob-in{fill:none;stroke:${PAD_GOLD};stroke-width:1.6;
      stroke-linejoin:round;opacity:0.8}
    #af-pad .knob-dot{fill:rgba(247,224,163,0.5);stroke:rgba(0,0,0,0.35);stroke-width:1}
    /* right-hand column: SPECIAL stacked over the attack wheel. A flex column
       (rather than two independently-positioned elements) is what keeps the
       plate glued to the wheel's top edge across every phone size — the
       wheel's vmin sizing would otherwise have to be duplicated in a calc(). */
    #af-right{position:fixed;right:max(3vmin,env(safe-area-inset-right));
      bottom:max(4vmin,env(safe-area-inset-bottom));
      width:38vmin;max-width:232px;
      display:flex;flex-direction:column;align-items:center;gap:2vmin;
      pointer-events:none}
    /* SPECIAL — hidden until the meter can actually pay for it (see
       setTouchCharged). It fades in place rather than being display:none'd:
       the row keeps its height either way, so the WHEEL never jumps under a
       thumb the moment a bar fills. Red is already this client's "super
       ready" colour (the brand badge over the timer goes red when charged),
       so the two cues agree instead of competing. */
    /* Selector carries #af-touch as well: the shared "#af-touch button" rule
       above sets pointer-events:auto and outranks a bare #af-special, which
       would leave an INVISIBLE but still-tappable SPECIAL sitting over the
       wheel whenever the meter is empty. Same trap as .pad and position. */
    #af-touch #af-special{position:relative;width:100%;height:9.5vmin;max-height:58px;
      border:0;background:none;padding:0;color:${PAD_GOLD_LT};font-family:inherit;
      font-size:4.2vmin;line-height:1;letter-spacing:3px;
      text-shadow:0 2px 5px rgba(0,0,0,0.75);
      display:flex;align-items:center;justify-content:center;
      opacity:0;transform:scale(0.84);pointer-events:none;
      transition:opacity .16s ease-out,transform .16s ease-out;
      filter:drop-shadow(0 3px 10px rgba(0,0,0,0.45))}
    #af-touch #af-special.ready{opacity:1;transform:none;pointer-events:auto;
      animation:af-charge 1.5s ease-in-out infinite}
    #af-special svg{position:absolute;inset:0;width:100%;height:100%;
      pointer-events:none;overflow:visible}
    #af-special .plate{fill:rgba(214,46,52,0.52);stroke:${PAD_GOLD};stroke-width:2.5;
      stroke-linejoin:round}
    #af-special .plate-sheen{pointer-events:none}
    #af-special .plate-in{fill:none;stroke:rgba(255,225,190,0.34);stroke-width:1.2;
      stroke-linejoin:round}
    /* The label sits above the plate art; the bolt is inline with the text and
       inherits its colour, so the two can never drift apart. Overrides the
       absolute-positioned rule for the plate SVGs above — hence the class. */
    #af-special span{position:relative;display:inline-flex;align-items:center;
      gap:0.34em}
    #af-special svg.bolt{position:static;width:0.86em;height:0.86em;
      fill:currentColor;flex:0 0 auto;
      filter:drop-shadow(0 0 4px rgba(255,150,120,0.7))}
    #af-touch #af-special.ready:active,#af-touch #af-special.on{
      transform:scale(.94);animation:none}
    #af-special.on .plate{fill:rgba(255,96,80,0.62);stroke:${PAD_GOLD_LT}}
    @keyframes af-charge{
      0%,100%{filter:drop-shadow(0 3px 10px rgba(0,0,0,0.45))}
      50%{filter:drop-shadow(0 3px 10px rgba(0,0,0,0.45)) drop-shadow(0 0 9px rgba(233,69,96,0.85))}}
    /* attack wheel (right) — hexagonal, one flat face per attack, so the
       silhouette states "six buttons" before a single label is read. */
    #af-atk{position:relative;width:100%;aspect-ratio:1/1;
      clip-path:${padClip(6, HEX_START)}}
    /* Punches read a step brighter than kicks — a hairline of hierarchy
       without reintroducing colour. */
    #af-atk .w{transition:fill .05s;stroke:${PAD_GOLD};stroke-width:1.25;
      stroke-linejoin:round;opacity:0.9}
    #af-atk .w.p{fill:rgba(255,255,255,0.13)}
    #af-atk .w.k{fill:rgba(255,255,255,0.07)}
    /* Press feedback has to survive a bright stage behind 60%-transparent
       glass, so the active wedge goes to a near-opaque gold with a light rim
       rather than a polite tint — on a phone this flash IS the button. */
    #af-atk .w.on{fill:rgba(247,224,163,0.72);stroke:#fff6df;stroke-width:3;
      opacity:1}
    /* The inset bevel that seats each wedge as its own plate. */
    #af-atk .facet{fill:none;stroke:rgba(255,255,255,0.16);stroke-width:1;
      stroke-linejoin:round;pointer-events:none}
    #af-atk .hub{fill:rgba(18,15,28,0.34);stroke:${PAD_GOLD};stroke-width:2;
      stroke-linejoin:round;opacity:0.85}
    #af-atk .hub-in{fill:none;stroke:rgba(247,224,163,0.45);stroke-width:1}
    /* Glyphs: bright, unstroked silhouettes lifted off the stage by a shadow
       that follows their own alpha (a stroke would draw the seams between the
       shapes each glyph is assembled from). */
    #af-atk .glyph{fill:rgba(255,255,255,0.96);
      filter:drop-shadow(0 1px 2px rgba(0,0,0,0.9))}
    /* Negative-space detail drawn ON the silhouette (knuckle gaps, ankle). */
    #af-atk .cut{fill:none;stroke:rgba(20,14,30,0.72);stroke-width:1.5;
      stroke-linecap:round}
    #af-atk .pip{fill:${PAD_GOLD_LT};stroke:rgba(0,0,0,0.5);stroke-width:0.9}
    #af-atk .gl{pointer-events:none}
    /* A pressed wedge INVERTS — the glyph goes dark on the lit gold plate.
       Brightening the plate alone is easy to miss in peripheral vision; the
       polarity flip is not. */
    #af-atk .gl.on .glyph{fill:#2b1c05;filter:none}
    #af-atk .gl.on .cut{stroke:rgba(247,224,163,0.9)}
    #af-atk .gl.on .pip{fill:#2b1c05;stroke:none}
    /* in-match menu button (upper LEFT) + its popup */
    #af-pause{position:fixed;top:max(2vmin,env(safe-area-inset-top));
      left:max(2vmin,env(safe-area-inset-left));
      min-width:11vmin;height:7.5vmin;max-height:44px;padding:0 2.4vmin;border-radius:6px;
      border:2px solid ${PAD_GOLD}99;background:rgba(18,15,28,0.28);
      -webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px);
      color:${PAD_GOLD_LT};font-family:inherit;font-size:3.6vmin;letter-spacing:2px;
      text-shadow:0 1px 3px rgba(0,0,0,0.6)}
    #af-pause:active{background:rgba(217,164,65,0.34)}
    #af-menu{position:fixed;inset:0;z-index:60;display:flex;align-items:center;
      justify-content:center;background:rgba(7,5,13,0.62);
      -webkit-backdrop-filter:blur(5px);backdrop-filter:blur(5px);pointer-events:auto}
    #af-menu.hidden{display:none}
    #af-menu .card{display:flex;flex-direction:column;gap:2vmin;padding:4vmin 5vmin;
      border-radius:8px;border:2px solid ${PAD_GOLD}99;
      background:rgba(18,15,28,0.55);text-align:center}
    #af-menu h2{margin:0 0 1vmin;color:${PAD_GOLD_LT};font-size:4.6vmin;letter-spacing:3px;
      font-weight:400}
    #af-menu button{min-width:44vmin;padding:2.4vmin 4vmin;border-radius:6px;
      border:2px solid ${PAD_GOLD}99;background:rgba(255,255,255,0.10);
      color:rgba(255,255,255,0.95);font-family:inherit;font-size:3.8vmin;
      letter-spacing:2px}
    #af-menu button:active{background:rgba(217,164,65,0.38)}
    @media (max-width:520px){#af-special{font-size:5vmin}#af-pause{font-size:4.4vmin}}
  `;
  document.head.appendChild(style);

  // ---- DOM ---------------------------------------------------------------
  // Wedge geometry is generated rather than hand-written so the angles in
  // WEDGES stay the single source of truth for BOTH the art and the hit test.
  // A hexagon's vertices sit exactly on the wedge seams, so each wedge is a
  // plain triangle out to one flat face — no arcs, and the seams double as the
  // plate's own facets.
  const wedgeSvg = WEDGES.map((w, i) => {
    const [x0, y0] = wheelPt(w.a0, WHEEL.r);
    const [x1, y1] = wheelPt(w.a0 + WEDGE_DEG, WHEEL.r);
    return `<polygon class="w ${w.cls}" data-wedge="${i}" points="${WHEEL.cx},${WHEEL.cy} `
      + `${x0.toFixed(2)},${y0.toFixed(2)} ${x1.toFixed(2)},${y1.toFixed(2)}"/>`;
  }).join('');
  // A second, inset copy of each wedge: the machined bevel that turns six flat
  // fills into six seated PLATES. Purely decorative, drawn over the fill layer.
  const facetSvg = WEDGES.map((w) => {
    const tri: [number, number][] = [
      [WHEEL.cx, WHEEL.cy], wheelPt(w.a0, WHEEL.r), wheelPt(w.a0 + WEDGE_DEG, WHEEL.r),
    ];
    const gx = (tri[0]![0] + tri[1]![0] + tri[2]![0]) / 3;
    const gy = (tri[0]![1] + tri[1]![1] + tri[2]![1]) / 3;
    const p = tri
      .map(([x, y]) => `${(gx + (x - gx) * 0.84).toFixed(2)},${(gy + (y - gy) * 0.84).toFixed(2)}`)
      .join(' ');
    return `<polygon class="facet" points="${p}"/>`;
  }).join('');
  // Glyph + strength pips per wedge, replacing the old two-letter labels.
  const glyphSvg = WEDGES.map((w) => {
    const [x, y] = wheelPt(w.a0 + WEDGE_DEG / 2, WHEEL.labelR);
    // Heavier attack, bigger glyph. Sized so the largest still clears the
    // hexagon's inradius once the pip row is added underneath.
    const s = [0.96, 1.08, 1.22][w.str - 1]!;
    const g = GLYPH[w.cls];
    return `<g class="gl" transform="translate(${x.toFixed(2)},${y.toFixed(2)})">`
      + `<g transform="translate(${(-12 * s).toFixed(2)},${(-12 * s - 5).toFixed(2)}) scale(${s})">`
      + `<g class="glyph">${g.body}</g><g class="cut">${g.cut}</g></g>`
      + `${pips(w.str, 12 * s)}</g>`;
  }).join('');
  // Panel screws at the plate corners — the cabinet cue that stops the pads
  // reading as flat vector shapes.
  const rivets = (n: number, start: number, r: number): string =>
    ngon(n, start, r).map(([x, y]) =>
      `<circle class="rivet" cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="2.6"/>`).join('');
  // Gate ticks: long on the four cardinals a fighting game actually cares about
  // (jump, walk, crouch), short on the diagonals that complete the 8-way.
  const tickSvg = [0, 45, 90, 135, 180, 225, 270, 315].map((deg) => {
    const major = deg % 90 === 0;
    const [x1, y1] = wheelPt(deg, major ? 68 : 76);
    const [x2, y2] = wheelPt(deg, 86);
    return `<line class="tick${major ? ' major' : ''}" x1="${x1.toFixed(2)}" y1="${y1.toFixed(2)}" `
      + `x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}"/>`;
  }).join('');

  const root = document.createElement('div');
  root.id = 'af-touch';
  root.innerHTML = `
    <div id="af-pad" class="pad" role="group" aria-label="motion stick">
      <svg viewBox="0 0 200 200" aria-hidden="true">
        ${sheenDefs('af-g-pad')}
        <polygon class="rim" points="${poly(8, OCT_START, 96)}"/>
        <polygon class="sheen" fill="url(#af-g-pad)" points="${poly(8, OCT_START, 96)}"/>
        <polygon class="rim-in" points="${poly(8, OCT_START, 84)}"/>
        <polygon class="gate" points="${poly(8, OCT_START, 60)}"/>
        ${tickSvg}
        ${rivets(8, OCT_START, 90)}
      </svg>
      <div class="stick">
        <svg viewBox="0 0 100 100" aria-hidden="true">
          ${sheenDefs('af-g-knob')}
          <polygon class="knob" points="${poly(8, OCT_START, 46, 50, 50)}"/>
          <polygon class="knob-sheen" fill="url(#af-g-knob)" points="${poly(8, OCT_START, 46, 50, 50)}"/>
          <polygon class="knob-in" points="${poly(8, OCT_START, 28, 50, 50)}"/>
          <circle class="knob-dot" cx="50" cy="50" r="6"/>
        </svg>
      </div>
    </div>
    <div id="af-right">
      <button id="af-special" aria-label="special attack">
        <svg viewBox="0 0 200 48" preserveAspectRatio="none" aria-hidden="true">
          ${sheenDefs('af-g-sp')}
          <polygon class="plate" points="14,2 186,2 198,24 186,46 14,46 2,24"/>
          <polygon class="plate-sheen" fill="url(#af-g-sp)" points="14,2 186,2 198,24 186,46 14,46 2,24"/>
          <polygon class="plate-in" points="20,7 180,7 190,24 180,41 20,41 9,24"/>
        </svg>
        <span><svg class="bolt" viewBox="0 0 24 24" aria-hidden="true"><polygon points="13.6,1 4,13.4 10.4,13.4 8.6,23 18.6,10.2 12.2,10.2"/></svg>SPECIAL</span>
      </button>
      <div id="af-atk" class="pad" role="group" aria-label="attack wheel">
        <svg viewBox="0 0 200 200" aria-hidden="true">
          ${sheenDefs('af-g-atk')}
          <g class="wedges">${wedgeSvg}</g>
          <g class="facets">${facetSvg}</g>
          <polygon class="sheen" fill="url(#af-g-atk)" points="${poly(6, HEX_START, WHEEL.r)}"/>
          <polygon class="rim" style="fill:none" points="${poly(6, HEX_START, WHEEL.r)}"/>
          ${rivets(6, HEX_START, WHEEL.r - 9)}
          <polygon class="hub" points="${poly(8, OCT_START, WHEEL.hubR)}"/>
          <polygon class="hub-in" points="${poly(8, OCT_START, WHEEL.hubR - 7)}"/>
          ${glyphSvg}
        </svg>
      </div>
    </div>
    <button id="af-pause" aria-label="match menu">❚❚ MENU</button>
    <div id="af-menu" class="hidden">
      <div class="card">
        <h2>MATCH MENU</h2>
        <button class="resume">RESUME</button>
        <button class="quit">QUIT MATCH</button>
      </div>
    </div>`;
  document.body.appendChild(root);

  const pad = root.querySelector('#af-pad') as HTMLElement;
  const stick = pad.querySelector('.stick') as HTMLElement;
  const atk = root.querySelector('#af-atk') as HTMLElement;
  const menu = root.querySelector('#af-menu') as HTMLElement;
  const pauseBtn = root.querySelector('#af-pause') as HTMLElement;
  const specialBtn = root.querySelector('#af-special') as HTMLElement;
  // The plate and its glyph light up together — see the `.gl.on` rules, which
  // invert the glyph rather than just brightening the plate under it.
  const glEls = Array.from(atk.querySelectorAll('.gl')) as SVGElement[];
  const wedgeEls = WEDGES.map((_, i) => {
    const plate = atk.querySelector(`[data-wedge="${i}"]`) as SVGElement;
    const gl = glEls[i];
    return {
      lit: (on: boolean): void => {
        plate?.classList.toggle('on', on);
        gl?.classList.toggle('on', on);
      },
    };
  });

  // ---- pointer tracking (multi-touch) ------------------------------------
  type Track = { kind: 'pad' } | { kind: 'atk'; wedge: number };
  const pointers = new Map<number, Track>();
  const padDirs = new Set<string>();

  const clearPad = (): void => {
    for (const c of padDirs) release(c);
    padDirs.clear();
    stick.style.transform = 'translate(-50%,-50%)';
  };

  // ---- attack wheel ------------------------------------------------------
  /** Is any pointer OTHER than `except` still parked on this wedge? */
  const wedgeHeld = (wedge: number, except: number): boolean => {
    for (const [id, t] of pointers) if (id !== except && t.kind === 'atk' && t.wedge === wedge) return true;
    return false;
  };

  /**
   * Point `id` at `wedge`, releasing whatever it held before. Sliding a thumb
   * across the seams therefore plays a chain (LP→MP→HP) as clean press/release
   * pairs, while a second thumb elsewhere on the disc keeps its own button
   * down — that pair of behaviours is the whole reason for the wheel.
   */
  const setWedge = (id: number, wedge: number): void => {
    const prev = pointers.get(id);
    const had = prev?.kind === 'atk' ? prev.wedge : -1;
    if (had === wedge) return;
    pointers.set(id, { kind: 'atk', wedge });
    if (had >= 0 && !wedgeHeld(had, id)) {
      release(WEDGES[had]!.code);
      wedgeEls[had]?.lit(false);
    }
    press(WEDGES[wedge]!.code);
    wedgeEls[wedge]?.lit(true);
  };

  /** Lift pointer `id` off the wheel (nothing happens if it wasn't on it). */
  const dropWedge = (id: number): void => {
    const t = pointers.get(id);
    if (t?.kind !== 'atk') return;
    if (!wedgeHeld(t.wedge, id)) {
      release(WEDGES[t.wedge]!.code);
      wedgeEls[t.wedge]?.lit(false);
    }
  };

  /** Wedge under a client-space point, measured from the wheel's live rect. */
  const wedgeFor = (clientX: number, clientY: number): number => {
    const r = atk.getBoundingClientRect();
    return wedgeAt(clientX - (r.left + r.width / 2), clientY - (r.top + r.height / 2));
  };

  /** Panic-release the wheel (menu opened, screen changed, app backgrounded). */
  const clearAtk = (): void => {
    for (const [, t] of pointers) if (t.kind === 'atk') release(WEDGES[t.wedge]!.code);
    for (const el of wedgeEls) el?.lit(false);
    specialBtn.classList.remove('on');
  };

  /**
   * Full stop: drop every control and every held key. Used everywhere a hold
   * could otherwise be stranded (menu, screen change, backgrounding) — a stuck
   * direction or attack outlives the overlay and is felt as "the game froze".
   */
  const resetControls = (): void => {
    clearAtk();
    clearPad();
    pointers.clear();
    releaseAll();
  };

  // ---- match menu --------------------------------------------------------
  // NOTE: this does NOT freeze the simulation. Matches are server-verified
  // (ADR 0003) and a local pause would desync the running match, so this is
  // an overlay menu, not a true pause — the fight continues underneath it.
  const setMenu = (open: boolean): void => {
    menu.classList.toggle('hidden', !open);
    if (open) resetControls(); // never strand a held key behind the menu
  };
  pauseBtn.addEventListener('pointerdown', (e) => {
    e.preventDefault(); e.stopPropagation(); audio.blip(); setMenu(true);
  });

  // ---- SPECIAL -----------------------------------------------------------
  // Same action the brand badge over the timer fires on desktop: it queues the
  // Auto Special macro, which then drives the pad for a few ticks (inputs only,
  // so the server's re-sim still agrees — see autospecial.ts). Routed through
  // the client's `afTap` hook so there is exactly ONE code path for 'special',
  // rather than the overlay reaching into the sim behind main.ts's back.
  specialBtn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    audio.blip();
    specialBtn.classList.add('on');
    (globalThis as { afTap?: (action: string) => void }).afTap?.('special');
  });
  const specialUp = (): void => specialBtn.classList.remove('on');
  specialBtn.addEventListener('pointerup', specialUp);
  specialBtn.addEventListener('pointercancel', specialUp);
  specialBtn.addEventListener('pointerleave', specialUp);
  menu.querySelector('.resume')!.addEventListener('pointerdown', (e) => {
    e.preventDefault(); e.stopPropagation(); audio.blip(); setMenu(false);
  });
  menu.querySelector('.quit')!.addEventListener('pointerdown', (e) => {
    e.preventDefault(); e.stopPropagation(); audio.blip();
    setMenu(false);
    // Escape is already what the fight screen treats as "leave the match".
    press(K.back); release(K.back);
  });

  const updatePad = (clientX: number, clientY: number): void => {
    const r = pad.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const rad = r.width / 2;
    let dx = (clientX - cx) / rad, dy = (clientY - cy) / rad;
    const mag = Math.hypot(dx, dy) || 1;
    if (mag > 1) { dx /= mag; dy /= mag; } // clamp thumb inside the ring
    const DEAD = 0.32; // per-axis deadzone → clean 8-way with a neutral center
    const want = new Set<string>();
    if (dx < -DEAD) want.add(K.left); else if (dx > DEAD) want.add(K.right);
    if (dy < -DEAD) want.add(K.up); else if (dy > DEAD) want.add(K.down);
    for (const c of padDirs) if (!want.has(c)) release(c);
    for (const c of want) press(c);
    padDirs.clear(); for (const c of want) padDirs.add(c);
    stick.style.transform = `translate(calc(-50% + ${dx * rad * 0.6}px),calc(-50% + ${dy * rad * 0.6}px))`;
  };

  root.addEventListener('pointerdown', (e) => {
    const el = e.target as HTMLElement;
    if (el.closest('#af-atk')) {
      setWedge(e.pointerId, wedgeFor(e.clientX, e.clientY));
      e.preventDefault();
      return;
    }
    if (el.closest('#af-pad')) {
      pointers.set(e.pointerId, { kind: 'pad' });
      updatePad(e.clientX, e.clientY);
      e.preventDefault();
    }
  }, { passive: false });

  root.addEventListener('pointermove', (e) => {
    const t = pointers.get(e.pointerId);
    if (t?.kind === 'pad') { updatePad(e.clientX, e.clientY); e.preventDefault(); }
    else if (t?.kind === 'atk') { setWedge(e.pointerId, wedgeFor(e.clientX, e.clientY)); e.preventDefault(); }
  }, { passive: false });

  const endPointer = (e: PointerEvent): void => {
    const t = pointers.get(e.pointerId);
    if (!t) return;
    if (t.kind === 'atk') {
      dropWedge(e.pointerId);
      pointers.delete(e.pointerId);
    } else {
      pointers.delete(e.pointerId);
      clearPad();
    }
  };
  root.addEventListener('pointerup', endPointer);
  root.addEventListener('pointercancel', endPointer);
  // A pointer lost outside the element (e.g. dragged off-screen) must still release.
  window.addEventListener('pointerup', endPointer);
  window.addEventListener('pointercancel', endPointer);

  // Kill iOS long-press callout / context menu / double-tap zoom on the pad.
  root.addEventListener('contextmenu', (e) => e.preventDefault());
  root.addEventListener('dblclick', (e) => e.preventDefault());

  // ---- visibility: the arcade controls belong to the MATCH only ----------
  // Everywhere else (title, fighter/stage select, leaderboard, results) the
  // canvas UI is directly tappable — see ui.ts tapZone / main.ts tapAt — so two
  // sticks and a SPECIAL button would just be clutter over the art.
  // Edge-triggered off the screen main.ts pushes each frame — no per-frame DOM
  // writes, and leaving a match always drops any key still held down.
  let wasFight = false;
  let wasCharged = false;
  applyScreen = (screen: string): void => {
    const fighting = screen === 'fight';
    if (fighting === wasFight) return;
    wasFight = fighting;
    root.classList.toggle('hidden', !fighting);
    if (!fighting) {
      resetControls();
      setMenu(false);
      // Next match starts from an empty meter as far as the button knows —
      // otherwise a stale `wasCharged` swallows the first real push.
      wasCharged = false;
      specialBtn.classList.remove('ready');
    }
  };
  root.classList.add('hidden'); // boots on the title screen — nothing to show yet

  // SPECIAL appears only while the meter can pay for it. Edge-triggered so the
  // per-frame push from main.ts costs nothing when the state hasn't moved.
  applyCharged = (charged: boolean): void => {
    if (charged === wasCharged) return;
    wasCharged = charged;
    specialBtn.classList.toggle('ready', charged);
    if (!charged) specialBtn.classList.remove('on');
  };

  // Release everything if the app is backgrounded mid-hold (avoids stuck keys).
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) resetControls();
  });
};
