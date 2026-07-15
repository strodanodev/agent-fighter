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
    /* motion stick */
    #af-pad{position:fixed;left:max(3.5vmin,env(safe-area-inset-left));
      bottom:max(4vmin,env(safe-area-inset-bottom));
      width:34vmin;height:34vmin;max-width:210px;max-height:210px;border-radius:50%;
      background:radial-gradient(circle at 50% 42%,#1c1730cc,#0a0616e6);
      border:2px solid #d9a44166;box-shadow:0 6px 22px #000a,inset 0 0 18px #0008}
    #af-pad .stick{position:absolute;left:50%;top:50%;width:42%;height:42%;
      border-radius:50%;transform:translate(-50%,-50%);
      background:radial-gradient(circle at 42% 38%,#ffd166,#d9a441);
      box-shadow:0 2px 10px #000a,inset 0 -3px 6px #0006;transition:transform .04s linear}
    #af-pad .ring{position:absolute;inset:14%;border-radius:50%;border:1px dashed #ffffff1a}
    /* attack cluster */
    #af-atk{position:fixed;right:max(3vmin,env(safe-area-inset-right));
      bottom:max(4vmin,env(safe-area-inset-bottom));
      display:grid;grid-template-columns:repeat(3,1fr);gap:1.6vmin}
    #af-atk button{width:13.5vmin;height:13.5vmin;max-width:88px;max-height:88px;
      border-radius:50%;border:2px solid #ffffff26;color:#0a0616;font-weight:700;
      font-size:4.4vmin;line-height:1;display:flex;align-items:center;justify-content:center;
      box-shadow:0 4px 14px #0009,inset 0 -3px 6px #0004;transition:transform .05s,filter .05s}
    #af-atk button:active,#af-atk button.on{transform:scale(.9);filter:brightness(1.25)}
    #af-atk .p{background:radial-gradient(circle at 40% 35%,#ff6b8b,#e94560)}
    #af-atk .k{background:radial-gradient(circle at 40% 35%,#66d9ff,#2b8fd9)}
    /* menu utility buttons */
    #af-util{position:fixed;top:max(2vmin,env(safe-area-inset-top));
      right:max(3vmin,env(safe-area-inset-right));display:flex;gap:1.4vmin}
    #af-util button{min-width:15vmin;height:8vmin;max-height:46px;padding:0 3vmin;
      border-radius:10px;border:2px solid #d9a44166;background:#0a0616cc;color:#f7e0a3;
      font-weight:700;font-size:3.4vmin;letter-spacing:1px}
    #af-util button:active{filter:brightness(1.4)}
    @media (max-width:520px){#af-atk button{font-size:5vmin}#af-util button{font-size:4vmin}}
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
    <div id="af-util">
      <button data-code="${K.back}">BACK</button>
      <button data-code="${K.start}">START</button>
    </div>`;
  document.body.appendChild(root);

  const pad = root.querySelector('#af-pad') as HTMLElement;
  const stick = pad.querySelector('.stick') as HTMLElement;

  // ---- pointer tracking (multi-touch) ------------------------------------
  type Track = { kind: 'btn'; code: string } | { kind: 'pad' };
  const pointers = new Map<number, Track>();
  const padDirs = new Set<string>();

  const clearPad = (): void => {
    for (const c of padDirs) release(c);
    padDirs.clear();
    stick.style.transform = 'translate(-50%,-50%)';
  };

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

  // ---- visibility: hide during the loading + online-lobby screens --------
  const af = globalThis as unknown as { afScreen?: () => string };
  const sync = (): void => {
    const screen = af.afScreen?.() ?? 'loading';
    const show = screen !== 'loading' && screen !== 'online';
    root.classList.toggle('hidden', !show);
    if (!show && (padDirs.size || pointers.size)) { clearPad(); pointers.clear(); for (const c of [...down]) release(c); }
    requestAnimationFrame(sync);
  };
  requestAnimationFrame(sync);

  // Release everything if the app is backgrounded mid-hold (avoids stuck keys).
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { clearPad(); pointers.clear(); for (const c of [...down]) release(c); }
  });
};
