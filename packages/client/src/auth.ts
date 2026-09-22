/**
 * AIR Kit auth (ADR 0003, Phase B): wallet/Google/email login → a session JWT
 * the match server verifies against AIR's JWKS. Login is OPTIONAL — it gates
 * persistent XP/W-L and the leaderboard, never the queue.
 *
 * The SDK ships as a UMD bundle (global `Airkit`) which bundle.mjs copies to
 * demo/vendor/airkit.umd.js. It is script-injected LAZILY on the first login
 * attempt (or rehydration probe) so offline play never loads it. Types below
 * are minimal structural mirrors of @mocanetwork/airkit — the concat bundler
 * strips imports, so the npm package is a build-time asset only, never an
 * import target.
 *
 * The partner id is a PUBLIC client identifier (like a Firebase app id) —
 * committing it is fine; the secretless client can do nothing privileged
 * with it. Override with ?partner= / ?airenv= for other environments.
 *
 * Universal login: framed by the litVM arcade (arcade.litvm.games), the
 * client does NOT load AIR Kit. The arcade already holds the player's AIR
 * session, and lends it over postMessage (litnode cabinet/app.js):
 *   game → arcade  { type:'cabinet:air', id, token?:true } · { type:'cabinet:air-login', id } · { type:'cabinet:air-logout', id }
 *   arcade → game  { type:'cabinet:air', re?, signedIn, user:{id,email,address,name}|null, token?, error? }
 * Sign in inside the arcade opens the ARCADE's dialog; the token is the
 * arcade partner's (same AIR developer account → the same `sub`, so the same
 * progression rows). On agentfighter.wtf itself nothing changes. When the
 * arcade does not answer (an older arcade build) the client falls back to
 * its own AIR Kit, as before.
 */

interface AirLoginLite {
  isLoggedIn: boolean;
  id: string;
  abstractAccountAddress?: string;
  token: string;
}
interface AirServiceLite {
  isLoggedIn: boolean;
  loginResult: AirLoginLite | null;
  init(cfg: { buildEnv?: string; enableLogging?: boolean }): Promise<AirLoginLite | null>;
  login(): Promise<AirLoginLite>;
  logout(): Promise<void>;
  getUserInfo(): Promise<{ user: { id: string; email?: string; abstractAccountAddress?: string } }>;
  getAccessToken(): Promise<{ token: string }>;
}
declare const Airkit: {
  AirService: new (cfg: { partnerId: string }) => AirServiceLite;
  BUILD_ENV: Record<string, string>;
};

const AIR_PARTNER_ID = 'cdbfc9c4-62db-4947-b0de-c28932887132'; // testnet (sandbox) partner
const AIR_ENV_DEFAULT = 'sandbox'; // = Moca Chain Testnet

export type AuthStatus = 'out' | 'busy' | 'in' | 'error';

export interface AuthState {
  status: AuthStatus;
  /** AIR user UUID — the account key the server persists progression under. */
  id: string;
  address: string;
  email: string;
  /** Session JWT — sent in the net hello; server-verified via JWKS. */
  token: string;
  error: string;
}

export const auth: AuthState = { status: 'out', id: '', address: '', email: '', token: '', error: '' };

// ── universal login: the arcade's session, when the arcade frames us ─────────
const ARCADE_AUTH_ORIGINS = ['https://arcade.litvm.games', 'https://litvm.games', 'https://www.litvm.games'];
const ARCADE_AUTH_PROBE_MS = 8000;
const ARCADE_AUTH_TOKEN_MS = 15_000;
const ARCADE_AUTH_LOGIN_MS = 10 * 60_000; // a person choosing an account, typing an email code

interface ArcadeAirMsg {
  type: 'cabinet:air';
  re?: string | null;
  signedIn?: boolean;
  user?: { id?: string | null; email?: string | null; address?: string | null } | null;
  token?: string | null;
  error?: string;
}

/** The arcade origin framing this page, else null. ancestorOrigins names the
 *  parent exactly (Chromium, Safari); Firefox falls back to the referrer. A
 *  wrong guess is harmless: nothing posted to it reaches another origin, and
 *  replies are checked against it. ?arcade= adds one (a local arcade). */
const arcadeAuthOrigin = (): string | null => {
  if (window.parent === window) return null;
  const extra = new URLSearchParams(location.search).get('arcade');
  const allowed = new Set([...ARCADE_AUTH_ORIGINS, ...(extra ? [extra] : [])]);
  const anc = (location as Location & { ancestorOrigins?: DOMStringList }).ancestorOrigins;
  let parent: string | null = null;
  if (anc) parent = anc.length > 0 ? anc[0]! : null;
  else { try { parent = document.referrer ? new URL(document.referrer).origin : null; } catch { parent = null; } }
  return parent && allowed.has(parent) ? parent : null;
};

const arcadeAuth = { origin: null as string | null, on: false, seq: 0, pending: new Map<string, (m: ArcadeAirMsg) => void>() };
let arcadeAuthReady: Promise<boolean> | null = null;

const arcadeApply = (m: ArcadeAirMsg): void => {
  if (m.signedIn && m.user?.id) {
    auth.status = 'in';
    auth.id = m.user.id;
    auth.email = m.user.email ?? '';
    auth.address = m.user.address ?? '';
    auth.error = '';
  } else if (auth.status !== 'busy') {
    auth.status = 'out';
    auth.id = ''; auth.address = ''; auth.email = ''; auth.token = '';
  }
};

const arcadeAsk = (type: string, ms: number, extra: Record<string, unknown> = {}): Promise<ArcadeAirMsg | null> =>
  new Promise((resolve) => {
    const id = `af-${Date.now().toString(36)}-${++arcadeAuth.seq}`;
    const timer = setTimeout(() => { arcadeAuth.pending.delete(id); resolve(null); }, ms);
    arcadeAuth.pending.set(id, (m) => { clearTimeout(timer); resolve(m); });
    window.parent.postMessage({ type, id, ...extra }, arcadeAuth.origin!);
  });

/** Decided once: is the arcade lending us its sign-in? */
const arcadeAuthStart = (): Promise<boolean> => {
  arcadeAuthReady ??= (async () => {
    arcadeAuth.origin = arcadeAuthOrigin();
    if (!arcadeAuth.origin) return false;
    window.addEventListener('message', (e: MessageEvent) => {
      if (e.source !== window.parent || e.origin !== arcadeAuth.origin) return;
      const m = e.data as ArcadeAirMsg | null;
      if (!m || m.type !== 'cabinet:air') return;
      const answer = m.re ? arcadeAuth.pending.get(m.re) : undefined;
      if (m.re && answer) { arcadeAuth.pending.delete(m.re); answer(m); }
      if (arcadeAuth.on || answer) arcadeApply(m);
    });
    const first = await arcadeAsk('cabinet:air', ARCADE_AUTH_PROBE_MS);
    arcadeAuth.on = !!first;
    if (!first) console.warn(`[auth] framed by ${arcadeAuth.origin}, which did not answer; using AIR Kit here`);
    return arcadeAuth.on;
  })();
  return arcadeAuthReady;
};

let service: AirServiceLite | null = null;
let sdkLoading: Promise<void> | null = null;
let rehydratedIn = false; // did init() restore a previous session?

const loadSdk = (): Promise<void> => {
  if (typeof (globalThis as Record<string, unknown>).Airkit !== 'undefined') return Promise.resolve();
  sdkLoading ??= new Promise<void>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'vendor/airkit.umd.js';
    s.onload = () => resolve();
    s.onerror = () => { sdkLoading = null; reject(new Error('AIR Kit SDK not found (rebuild: npm run demo)')); };
    document.head.appendChild(s);
  });
  return sdkLoading;
};

const applyLogin = async (r: AirLoginLite | null): Promise<boolean> => {
  if (!r?.isLoggedIn) return false;
  auth.status = 'in';
  auth.id = r.id;
  auth.address = r.abstractAccountAddress ?? '';
  auth.token = r.token;
  try {
    const info = await service!.getUserInfo();
    auth.email = info.user.email ?? '';
    auth.address ||= info.user.abstractAccountAddress ?? '';
  } catch { /* email is cosmetic */ }
  return true;
};

const ensureService = async (): Promise<AirServiceLite> => {
  await loadSdk();
  if (!service) {
    const q = new URLSearchParams(location.search);
    service = new Airkit.AirService({ partnerId: q.get('partner') ?? AIR_PARTNER_ID });
    // init() rehydrates a previous session (AIR keeps logins for ~30 days).
    const rehydrated = await service.init({ buildEnv: q.get('airenv') ?? AIR_ENV_DEFAULT });
    rehydratedIn = await applyLogin(rehydrated);
  }
  return service;
};

/** Silent boot probe: restores a previous session without any UI. */
export const authRehydrate = async (): Promise<void> => {
  if (await arcadeAuthStart()) return; // the arcade's session (applied as it answers)
  try { await ensureService(); } catch { /* SDK missing/offline — stay out */ }
};

/** Interactive login (AIR's dialog: Google / email / wallet). */
export const authLogin = async (): Promise<void> => {
  if (auth.status === 'busy' || auth.status === 'in') return;
  auth.status = 'busy';
  auth.error = '';
  if (await arcadeAuthStart()) {
    // The arcade opens ITS dialog: the click that got us here lends it the gesture.
    const r = await arcadeAsk('cabinet:air-login', ARCADE_AUTH_LOGIN_MS);
    if (r) arcadeApply(r); // 'in' when it worked; a cancel leaves us busy
    if ((auth.status as AuthStatus) === 'busy') { auth.status = 'out'; auth.error = r?.error ?? ''; }
    return;
  }
  try {
    const svc = await ensureService();
    // ensureService may already have rehydrated us into 'in'.
    const ok = rehydratedIn || svc.isLoggedIn
      ? await applyLogin(svc.loginResult)
      : await applyLogin(await svc.login());
    if (!ok) auth.status = 'out';
  } catch (e) {
    auth.status = 'error';
    auth.error = (e as Error).message || 'login failed';
  }
};

export const authLogout = async (): Promise<void> => {
  if (arcadeAuth.on) await arcadeAsk('cabinet:air-logout', ARCADE_AUTH_TOKEN_MS); // one session: the arcade signs out too
  try { await service?.logout(); } catch { /* session already gone */ }
  auth.status = 'out';
  auth.id = ''; auth.address = ''; auth.email = ''; auth.token = '';
};

/** A fresh session token (they expire) — call right before connecting. */
export const authToken = async (): Promise<string | undefined> => {
  if (arcadeAuth.on) {
    const r = await arcadeAsk('cabinet:air', ARCADE_AUTH_TOKEN_MS, { token: true });
    if (r?.signedIn && typeof r.token === 'string' && r.token) { auth.token = r.token; return r.token; }
    return undefined;
  }
  if (auth.status !== 'in' || !service) return undefined;
  try {
    const { token } = await service.getAccessToken();
    auth.token = token;
    return token;
  } catch {
    return auth.token || undefined;
  }
};

/** Short display handle: email user, else 0xAB…CDEF, else null. */
export const authName = (): string | null => {
  if (auth.status !== 'in') return null;
  if (auth.email) return auth.email.split('@')[0]!.slice(0, 16).toUpperCase();
  if (auth.address) return `${auth.address.slice(0, 6)}…${auth.address.slice(-4)}`;
  return auth.id.slice(0, 8).toUpperCase();
};

// Console/automation hooks.
Object.assign(globalThis, {
  afAuth: () => ({ ...auth }),
  afLogin: () => authLogin(),
  afLogout: () => authLogout(),
});
