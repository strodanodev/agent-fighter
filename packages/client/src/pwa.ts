/**
 * Progressive-web-app glue: registers the service worker and shows a one-time
 * "install" prompt on the landing screen.
 *
 *  - Chromium (Android/desktop): captures `beforeinstallprompt` and offers a
 *    native install via a custom banner button.
 *  - iOS/iPadOS Safari: no install event exists, so we show the manual
 *    "Share → Add to Home Screen" hint instead.
 *
 * The banner appears only on the first visit (per-browser `localStorage` flag)
 * and never when the app is already running installed (standalone display mode).
 */

const SEEN_KEY = 'af_pwa_prompt_seen';

interface BipEvent extends Event { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }>; }

const isStandalone = (): boolean =>
  (typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches)
  || matchMedia('(display-mode: fullscreen)').matches
  || (navigator as unknown as { standalone?: boolean }).standalone === true;

const isIos = (): boolean => {
  const ua = navigator.userAgent || '';
  return /iPhone|iPad|iPod/i.test(ua)
    || (/Macintosh/.test(ua) && 'ontouchend' in document);
};

const showBanner = (mode: 'install' | 'ios', onInstall?: () => void): void => {
  if (document.getElementById('af-pwa')) return;
  const style = document.createElement('style');
  style.textContent = `
    #af-pwa{position:fixed;left:50%;bottom:max(3vmin,env(safe-area-inset-bottom));
      transform:translateX(-50%);z-index:120;max-width:min(92vw,440px);
      display:flex;gap:14px;align-items:center;padding:14px 16px;border-radius:16px;
      background:#0a0616f2;border:2px solid #d9a44177;color:#f7e0a3;
      box-shadow:0 10px 40px #000c;font-family:"Courier New",monospace;
      animation:afpwaIn .35s ease-out}
    @keyframes afpwaIn{from{opacity:0;transform:translate(-50%,16px)}to{opacity:1;transform:translate(-50%,0)}}
    #af-pwa img{width:52px;height:52px;border-radius:12px;flex:0 0 auto}
    #af-pwa .txt{flex:1 1 auto;font-size:13px;line-height:1.35}
    #af-pwa .txt b{color:#ffd166;font-size:14px}
    #af-pwa .row{display:flex;gap:8px;margin-top:8px}
    #af-pwa button{border:0;border-radius:9px;font-family:inherit;font-weight:700;
      font-size:13px;padding:8px 14px;cursor:pointer}
    #af-pwa .go{background:linear-gradient(#ffd166,#d9a441);color:#0a0616}
    #af-pwa .no{background:#ffffff14;color:#ffffffb0}
    #af-pwa .x{position:absolute;top:6px;right:10px;background:none;color:#ffffff66;font-size:18px;padding:2px 6px}
  `;
  document.head.appendChild(style);
  const el = document.createElement('div');
  el.id = 'af-pwa';
  const dismiss = (): void => { try { localStorage.setItem(SEEN_KEY, '1'); } catch { /* private mode */ } el.remove(); };
  if (mode === 'install') {
    el.innerHTML = `
      <img src="/assets/icons/icon-192.png" alt="">
      <div class="txt"><b>Install Agent Fighter</b><br>Add it to your home screen for full-screen, offline play.
        <div class="row"><button class="go">Install</button><button class="no">Not now</button></div></div>
      <button class="x" aria-label="close">×</button>`;
    el.querySelector('.go')!.addEventListener('click', () => { el.remove(); onInstall?.(); });
  } else {
    el.innerHTML = `
      <img src="/assets/icons/icon-192.png" alt="">
      <div class="txt"><b>Install Agent Fighter</b><br>Tap the Share button, then <b>Add to Home Screen</b> for full-screen play.
        <div class="row"><button class="no">Got it</button></div></div>
      <button class="x" aria-label="close">×</button>`;
  }
  el.querySelector('.no')?.addEventListener('click', dismiss);
  el.querySelector('.x')!.addEventListener('click', dismiss);
  document.body.appendChild(el);
};

/** Register the SW and, on a first mobile visit, offer to install. */
export const initPwa = (): void => {
  if ('serviceWorker' in navigator) {
    // Register after load so it never competes with first-paint asset fetches.
    addEventListener('load', () => { void navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {}); });
  }

  if (isStandalone()) return; // already installed — nothing to offer
  // Read the flag live rather than caching it: dismissing writes it, and
  // Chromium may re-fire beforeinstallprompt within the same page session.
  const seen = (): boolean => {
    try { return localStorage.getItem(SEEN_KEY) === '1'; } catch { return false; /* private mode */ }
  };

  let deferred: BipEvent | null = null;
  addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();            // suppress the mini-infobar; we drive our own
    deferred = e as BipEvent;
    if (!seen()) showBanner('install', () => { void deferred?.prompt(); deferred = null; });
  });

  addEventListener('appinstalled', () => {
    try { localStorage.setItem(SEEN_KEY, '1'); } catch { /* private mode */ }
    document.getElementById('af-pwa')?.remove();
  });

  // iOS never fires beforeinstallprompt → show the manual hint shortly after
  // landing (once), giving the page a moment to settle first.
  if (isIos() && !seen()) setTimeout(() => { if (!isStandalone() && !seen()) showBanner('ios'); }, 2500);
};
