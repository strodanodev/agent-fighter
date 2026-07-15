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
  try { await ensureService(); } catch { /* SDK missing/offline — stay out */ }
};

/** Interactive login (AIR's dialog: Google / email / wallet). */
export const authLogin = async (): Promise<void> => {
  if (auth.status === 'busy' || auth.status === 'in') return;
  auth.status = 'busy';
  auth.error = '';
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
  try { await service?.logout(); } catch { /* session already gone */ }
  auth.status = 'out';
  auth.id = ''; auth.address = ''; auth.email = ''; auth.token = '';
};

/** A fresh session token (they expire) — call right before connecting. */
export const authToken = async (): Promise<string | undefined> => {
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
