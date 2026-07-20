/**
 * AIR Kit session-token verification (ADR 0003, Phase B).
 *
 * The client hands the server its AIR session JWT in `hello.auth`; the server
 * verifies the signature against AIR's public JWKS and extracts the identity:
 * `sub` (the AIR user UUID — our stable account key) and the smart-account
 * address. The client is never trusted about who it is.
 *
 * Zero dependencies: AIR signs with ES256 (P-256) — see
 * https://static.air3.com/.well-known/jwks.json — and node:crypto verifies
 * that natively (JWS uses the raw R||S "ieee-p1363" signature encoding, NOT
 * ASN.1/DER — the classic footgun).
 *
 * Verification failure is soft by design: the player stays connected as
 * anonymous. Identity gates progression, never the queue.
 */
import { createPublicKey, verify as cryptoVerify } from 'node:crypto';
import type { KeyObject } from 'node:crypto';

/**
 * AIR publishes SEPARATE signing keys per environment; a token minted by the
 * sandbox (Moca testnet — what BUILD_ENV.SANDBOX logins produce) verifies
 * only against the sandbox JWKS. Default to trying BOTH so a server works
 * against either environment; AIR_JWKS_URL overrides (comma-separated).
 */
export const DEFAULT_JWKS_URL = 'https://static.air3.com/.well-known/jwks.json,'
  + 'https://static.sandbox.air3.com/.well-known/jwks.json';

export interface AirIdentity {
  /** AIR user UUID (`sub`) — the primary key for profiles. */
  sub: string;
  /** ERC-4337 smart-account address, when present in the token. */
  address?: string;
  partnerId?: string;
}

interface Jwk {
  kty: string;
  kid?: string;
  alg?: string;
  crv?: string;
  [k: string]: unknown;
}

const b64urlJson = (part: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;

/** alg → node:crypto (hash, verify options). Only asymmetric algs — no HS*. */
const ALG: Record<string, { hash: string; opts: (key: KeyObject) => object }> = {
  ES256: { hash: 'sha256', opts: (key) => ({ key, dsaEncoding: 'ieee-p1363' }) },
  ES384: { hash: 'sha384', opts: (key) => ({ key, dsaEncoding: 'ieee-p1363' }) },
  RS256: { hash: 'sha256', opts: (key) => ({ key }) },
};

/**
 * Verify a JWT against a set of JWKs. Pure + injectable (tests sign with
 * their own throwaway keypair). Returns the payload or throws.
 */
export const verifyJwtWithKeys = (
  token: string,
  keys: Jwk[],
  nowSec = Math.floor(Date.now() / 1000),
): Record<string, unknown> => {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('not a JWT');
  const header = b64urlJson(parts[0]!);
  const alg = String(header.alg ?? '');
  const spec = ALG[alg];
  if (!spec) throw new Error(`disallowed alg "${alg}"`);

  const kid = header.kid as string | undefined;
  const candidates = keys.filter((k) => !kid || !k.kid || k.kid === kid);
  if (candidates.length === 0) throw new Error(`no JWK for kid "${kid}"`);

  const data = Buffer.from(`${parts[0]}.${parts[1]}`);
  const sig = Buffer.from(parts[2]!, 'base64url');
  const ok = candidates.some((jwk) => {
    try {
      const key = createPublicKey({ key: jwk as never, format: 'jwk' });
      return cryptoVerify(spec.hash, data, spec.opts(key) as never, sig);
    } catch {
      return false;
    }
  });
  if (!ok) throw new Error('bad signature');

  const payload = b64urlJson(parts[1]!);
  // exp is REQUIRED (audit 2026-07-18 H4): a token with no exp otherwise never
  // expires — a permanent bearer credential if it ever leaks. AIR session
  // tokens always carry it.
  const exp = Number(payload.exp);
  if (!Number.isFinite(exp) || exp <= 0) throw new Error('missing exp — refusing a non-expiring token');
  if (exp < nowSec) throw new Error('expired');
  const nbf = Number(payload.nbf ?? 0);
  if (nbf > 0 && nbf > nowSec + 60) throw new Error('not yet valid');
  return payload;
};

// JWKS cache: refetched at most every 10 min, and once eagerly when a token
// arrives with an unknown kid (key rotation without a restart).
const JWKS_TTL_MS = 10 * 60 * 1000;
let cachedKeys: Jwk[] = [];
let cachedAt = 0;
let cachedUrl = '';

/** Fetch + merge every JWKS in a comma-separated URL list (one may be down). */
const fetchJwks = async (urls: string): Promise<Jwk[]> => {
  const results = await Promise.allSettled(urls.split(',').map(async (url) => {
    const res = await fetch(url.trim());
    if (!res.ok) throw new Error(`JWKS fetch ${res.status}`);
    const body = (await res.json()) as { keys?: Jwk[] };
    if (!Array.isArray(body.keys)) throw new Error('JWKS has no keys');
    return body.keys;
  }));
  const keys = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
  if (keys.length === 0) {
    throw new Error(`no JWKS reachable: ${results.map((r) => (r.status === 'rejected' ? String(r.reason) : 'ok')).join(' | ')}`);
  }
  return keys;
};

/**
 * Verify an AIR session token → identity, or null (soft failure — the caller
 * logs and continues anonymous). Network errors, bad signatures, and expired
 * tokens all land on the same null.
 */
export const verifyAirToken = async (
  token: string,
  jwksUrl = process.env.AIR_JWKS_URL || DEFAULT_JWKS_URL,
): Promise<AirIdentity | null> => {
  try {
    if (jwksUrl !== cachedUrl || Date.now() - cachedAt > JWKS_TTL_MS) {
      cachedKeys = await fetchJwks(jwksUrl);
      cachedAt = Date.now();
      cachedUrl = jwksUrl;
    }
    let payload: Record<string, unknown>;
    try {
      payload = verifyJwtWithKeys(token, cachedKeys);
    } catch (e) {
      // One eager refetch for kid rotation, then give up.
      if (!String(e).includes('no JWK')) throw e;
      cachedKeys = await fetchJwks(jwksUrl);
      cachedAt = Date.now();
      payload = verifyJwtWithKeys(token, cachedKeys);
    }
    const sub = String(payload.sub ?? '');
    if (!sub) return null;
    const partnerId = typeof payload.partnerId === 'string' ? payload.partnerId : undefined;
    // Cross-app token replay guard (audit 2026-07-18 H4): any token AIR's JWKS
    // signed — including one minted for a DIFFERENT partner app — verifies here.
    // Enforce our own partnerId when it is configured. Env-gated so it stays a
    // no-op until AIR_PARTNER_ID is set to the correct value (never lock out
    // real tokens by guessing it).
    const required = process.env.AIR_PARTNER_ID;
    if (required && partnerId !== required) {
      console.log(`[auth] token rejected: partnerId "${partnerId ?? ''}" != "${required}"`);
      return null;
    }
    return {
      sub,
      address: typeof payload.abstractAccountAddress === 'string' ? payload.abstractAccountAddress : undefined,
      partnerId,
    };
  } catch (e) {
    console.log(`[auth] token rejected: ${String((e as Error).message ?? e)}`);
    return null;
  }
};
