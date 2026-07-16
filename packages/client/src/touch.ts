/**
 * On-screen touch controls for phones/tablets. Auto-detects iOS/Android (or any
 * coarse-pointer device) and, when present, overlays an MvC-style pad: an 8-way
 * motion stick on the left (so quarter-circle / dragon-punch motions roll
 * naturally) and the six attack buttons on the right, plus START/BACK for menus.
 *
 * It is deliberately DECOUPLED from the game's input code: each control simply
 * dispatches synthetic `KeyboardEvent`s for Player-0's existing key bindings, so
 * the sim, audio-unlock, and menu handling all run through the exact same path
 * as a physical keyboard. Nothing in the deterministic core is touched.
 *
 * Multi-touch is fully supported (throws = LP+LK, super = 2 punches, etc.) via
 * global pointer tracking keyed by pointerId.
 */

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

/** Install the overlay. No-op on desktop or if already installed. */
export const initTouchControls = (): void => {
  if (!isMobileDevice()) return;
  if (document.getElementById('af-touch')) return;

  // ---- key dispatch (single code path with the physical keyboard) --------
  const down = new Set<string>();
  const press = (code: string): void => {
    if (down.has(code)) return; // keydown fires once per hold, like a real key
    down.add(code);
    window.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true }));
  };
  const release = (code: string): void => {
    if (!down.has(code)) return;
    down.delete(code);
    window.dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true }));
  };
  /** Drop every held key — used when the overlay hides, backgrounds, or opens a menu. */
  const releaseAll = (): void => { for (const c of [...down]) release(c); };

  // ---- styles ------------------------------------------------------------
  const style = document.createElement('style');
  style.textContent = `
    #af-touch{position:fixed;inset:0;z-index:50;pointer-events:none;
      touch-action:none;-webkit-user-select:none;user-select:none;
      -webkit-tap-highlight-color:transparent;font-family:"Courier New",monospace}
    #af-touch.hidden{display:none}
    #af-touch .zone{position:absolute;bottom:0;pointer-events:none}
    #af-touch button,#af-touch .pad{pointer-events:auto;touch-action:none;
      -webkit-user-select:none;user-select:none;-webkit-tap-highlight-color:transparent}
    /* Frosted translucent white throughout — the controls must read clearly
       over both the bright stage art and a dark KO screen without ever
       becoming the thing you look at. Glass, not paint. */
    /* motion stick */
    #af-pad{position:fixed;left:max(3.5vmin,env(safe-area-inset-left));
      bottom:max(4vmin,env(safe-area-inset-bottom));
      width:34vmin;height:34vmin;max-width:210px;max-height:210px;border-radius:50%;
      background:rgba(255,255,255,0.08);border:2px solid rgba(255,255,255,0.28);
      -webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px);
      box-shadow:0 4px 18px rgba(0,0,0,0.28),inset 0 0 22px rgba(255,255,255,0.06)}
    #af-pad .stick{position:absolute;left:50%;top:50%;width:44%;height:44%;
      border-radius:50%;transform:translate(-50%,-50%);
      background:rgba(255,255,255,0.30);border:2px solid rgba(255,255,255,0.55);
      box-shadow:0 2px 10px rgba(0,0,0,0.30);transition:transform .04s linear}
    #af-pad .ring{position:absolute;inset:14%;border-radius:50%;border:1px dashed rgba(255,255,255,0.16)}
    /* attack cluster */
    #af-atk{position:fixed;right:max(3vmin,env(safe-area-inset-right));
      bottom:max(4vmin,env(safe-area-inset-bottom));
      display:grid;grid-template-columns:repeat(3,1fr);gap:1.6vmin}
    #af-atk button{width:13.5vmin;height:13.5vmin;max-width:88px;max-height:88px;
      border-radius:50%;border:2px solid rgba(255,255,255,0.34);
      background:rgba(255,255,255,0.12);color:rgba(255,255,255,0.92);
      -webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px);
      font-weight:700;font-size:4.4vmin;line-height:1;letter-spacing:0.5px;
      text-shadow:0 1px 3px rgba(0,0,0,0.55);
      display:flex;align-items:center;justify-content:center;
      box-shadow:0 3px 12px rgba(0,0,0,0.30);transition:transform .05s,background .05s}
    #af-atk button:active,#af-atk button.on{transform:scale(.9);
      background:rgba(255,255,255,0.42);border-color:rgba(255,255,255,0.85)}
    /* Punch row reads slightly brighter than kicks — a hairline of hierarchy
       without reintroducing colour. */
    #af-atk .p{background:rgba(255,255,255,0.17)}
    #af-atk .k{background:rgba(255,255,255,0.10)}
    /* in-match menu button (upper LEFT) + its popup */
    #af-pause{position:fixed;top:max(2vmin,env(safe-area-inset-top));
      left:max(2vmin,env(safe-area-inset-left));
      min-width:11vmin;height:7.5vmin;max-height:44px;padding:0 2.4vmin;border-radius:10px;
      border:2px solid rgba(255,255,255,0.30);background:rgba(255,255,255,0.12);
      -webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px);
      color:rgba(255,255,255,0.92);font-weight:700;font-size:3.2vmin;letter-spacing:1px;
      text-shadow:0 1px 3px rgba(0,0,0,0.55)}
    #af-pause:active{background:rgba(255,255,255,0.34)}
    #af-menu{position:fixed;inset:0;z-index:60;display:flex;align-items:center;
      justify-content:center;background:rgba(7,5,13,0.62);
      -webkit-backdrop-filter:blur(5px);backdrop-filter:blur(5px);pointer-events:auto}
    #af-menu.hidden{display:none}
    #af-menu .card{display:flex;flex-direction:column;gap:2vmin;padding:4vmin 5vmin;
      border-radius:16px;border:2px solid rgba(255,255,255,0.26);
      background:rgba(255,255,255,0.10);text-align:center}
    #af-menu h2{margin:0 0 1vmin;color:rgba(255,255,255,0.95);font-size:4vmin;letter-spacing:2px}
    #af-menu button{min-width:44vmin;padding:2.4vmin 4vmin;border-radius:12px;
      border:2px solid rgba(255,255,255,0.34);background:rgba(255,255,255,0.14);
      color:rgba(255,255,255,0.95);font-family:inherit;font-weight:700;font-size:3.4vmin;
      letter-spacing:1px}
    #af-menu button:active{background:rgba(255,255,255,0.4)}
    @media (max-width:520px){#af-atk button{font-size:5vmin}#af-pause{font-size:4vmin}}
  `;
  document.head.appendChild(style);

  // ---- DOM ---------------------------------------------------------------
  const root = document.createElement('div');
  root.id = 'af-touch';
  root.innerHTML = `
    <div id="af-pad" class="pad"><div class="ring"></div><div class="stick"></div></div>
    <div id="af-atk">
      <button class="p" data-code="${K.lp}">LP</button>
      <button class="p" data-code="${K.mp}">MP</button>
      <button class="p" data-code="${K.hp}">HP</button>
      <button class="k" data-code="${K.lk}">LK</button>
      <button class="k" data-code="${K.mk}">MK</button>
      <button class="k" data-code="${K.hk}">HK</button>
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
  const menu = root.querySelector('#af-menu') as HTMLElement;
  const pauseBtn = root.querySelector('#af-pause') as HTMLElement;

  // ---- pointer tracking (multi-touch) ------------------------------------
  type Track = { kind: 'btn'; code: string } | { kind: 'pad' };
  const pointers = new Map<number, Track>();
  const padDirs = new Set<string>();

  const clearPad = (): void => {
    for (const c of padDirs) release(c);
    padDirs.clear();
    stick.style.transform = 'translate(-50%,-50%)';
  };

  // ---- match menu --------------------------------------------------------
  // NOTE: this does NOT freeze the simulation. Matches are server-verified
  // (ADR 0003) and a local pause would desync the running match, so this is
  // an overlay menu, not a true pause — the fight continues underneath it.
  const setMenu = (open: boolean): void => {
    menu.classList.toggle('hidden', !open);
    if (open) { clearPad(); pointers.clear(); releaseAll(); } // never strand a held key behind the menu
  };
  pauseBtn.addEventListener('pointerdown', (e) => {
    e.preventDefault(); e.stopPropagation(); setMenu(true);
  });
  menu.querySelector('.resume')!.addEventListener('pointerdown', (e) => {
    e.preventDefault(); e.stopPropagation(); setMenu(false);
  });
  menu.querySelector('.quit')!.addEventListener('pointerdown', (e) => {
    e.preventDefault(); e.stopPropagation();
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
    const btn = (e.target as HTMLElement).closest('[data-code]') as HTMLElement | null;
    if (btn) {
      const code = btn.dataset.code!;
      pointers.set(e.pointerId, { kind: 'btn', code });
      btn.classList.add('on');
      press(code);
      e.preventDefault();
      return;
    }
    if ((e.target as HTMLElement).closest('#af-pad')) {
      pointers.set(e.pointerId, { kind: 'pad' });
      updatePad(e.clientX, e.clientY);
      e.preventDefault();
    }
  }, { passive: false });

  root.addEventListener('pointermove', (e) => {
    const t = pointers.get(e.pointerId);
    if (t?.kind === 'pad') { updatePad(e.clientX, e.clientY); e.preventDefault(); }
  }, { passive: false });

  const endPointer = (e: PointerEvent): void => {
    const t = pointers.get(e.pointerId);
    if (!t) return;
    pointers.delete(e.pointerId);
    if (t.kind === 'btn') {
      release(t.code);
      // clear the .on highlight if no other pointer holds this code
      const stillHeld = [...pointers.values()].some((p) => p.kind === 'btn' && p.code === t.code);
      if (!stillHeld) root.querySelectorAll(`[data-code="${t.code}"]`).forEach((el) => el.classList.remove('on'));
    } else {
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
  // canvas UI is directly tappable — see ui.ts tapZone / main.ts tapAt — so a
  // stick and six buttons would just be clutter over the art.
  // Edge-triggered off the screen main.ts pushes each frame — no per-frame DOM
  // writes, and leaving a match always drops any key still held down.
  let wasFight = false;
  applyScreen = (screen: string): void => {
    const fighting = screen === 'fight';
    if (fighting === wasFight) return;
    wasFight = fighting;
    root.classList.toggle('hidden', !fighting);
    if (!fighting) { clearPad(); pointers.clear(); releaseAll(); setMenu(false); }
  };
  root.classList.add('hidden'); // boots on the title screen — nothing to show yet

  // Release everything if the app is backgrounded mid-hold (avoids stuck keys).
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { clearPad(); pointers.clear(); releaseAll(); }
  });
};
