/**
 * AIR reputation write-back (ADR 0004): after a settled ranked/wager match,
 * the match server issues (or re-issues) an "Agent Fighter Reputation"
 * credential to the player's AIR account via the Issue-on-Behalf REST API —
 * level, XP, W-L, credits, attested by us as the verifying game server.
 *
 * Auth model (docs.moca.network/airkit/usage/credential/issue-on-behalf-api):
 * every call carries `x-partner-auth`, a short-lived Partner JWT WE sign with
 * the RS256 key from tools/air-keygen.mjs. AIR validates it against the
 * public JWKS registered in the dashboard (served at /.well-known/jwks.json).
 * The JWT's `email` claim targets the RECIPIENT — resolved per player from
 * their session (never a static/admin address, per the docs).
 *
 * Config (.env / env — issuance is OFF until all of these exist):
 *   AIR_ISSUER_DID        issuer DID from Dashboard → Issuer
 *   AIR_CREDENTIAL_ID     issuance-program id whose schema matches
 *                         ReputationSubject below
 *   AIR_PARTNER_KEY_FILE  path to the private PEM (default air/partner_rs256.pem)
 *   AIR_PARTNER_ID        JWT partnerId claim (defaults to the public testnet id)
 *   AIR_KID               JWKS kid (defaults to AIR_PARTNER_ID)
 *   AIR_API_URL           default sandbox https://api.sandbox.mocachain.org/v1
 *
 * Issuance is fire-and-forget with a per-player cooldown: a burst of matches
 * coalesces into one trailing re-issue carrying the LATEST stats (the
 * credential is a snapshot, so only the last write matters — onDuplicate:
 * 'revoke' replaces the previous one).
 */
import { createSign } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_AIR_API = 'https://api.sandbox.mocachain.org/v1';
const DEFAULT_PARTNER_ID = 'cdbfc9c4-62db-4947-b0de-c28932887132';
/** Min ms between issuances per profile (trailing re-issue keeps it fresh). */
const COOLDOWN_MS = 60_000;

export interface ReputationSubject {
  level: number;
  xp: number;
  wins: number;
  losses: number;
  credits: number;
  is_agent: boolean;
  engine: string;
  [k: string]: string | number | boolean; // schema allows primitive k/v
}

export interface AirIssuerConfig {
  issuerDid: string;
  credentialId: string;
  partnerId: string;
  kid: string;
  apiUrl: string;
  privateKeyPem: string;
}

const b64url = (b: Buffer | string): string =>
  (typeof b === 'string' ? Buffer.from(b) : b).toString('base64url');

/**
 * Sign a Partner JWT (RS256, 5-min expiry — the documented recommendation).
 * `email` targets the individual recipient for issue-on-behalf.
 */
export const signPartnerJwt = (
  cfg: Pick<AirIssuerConfig, 'partnerId' | 'kid' | 'privateKeyPem'>,
  claims: { email: string; scope: string },
  nowSec = Math.floor(Date.now() / 1000),
): string => {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: cfg.kid }));
  const payload = b64url(JSON.stringify({
    partnerId: cfg.partnerId,
    scope: claims.scope,
    email: claims.email,
    iat: nowSec,
    exp: nowSec + 300,
  }));
  const signer = createSign('sha256');
  signer.update(`${header}.${payload}`);
  const sig = signer.sign(cfg.privateKeyPem);
  return `${header}.${payload}.${b64url(sig)}`;
};

/** Load config from env; null (issuance off) unless fully configured. */
export const loadIssuerConfig = (root: string): AirIssuerConfig | null => {
  const issuerDid = process.env.AIR_ISSUER_DID;
  const credentialId = process.env.AIR_CREDENTIAL_ID;
  if (!issuerDid || !credentialId) return null;
  const keyFile = process.env.AIR_PARTNER_KEY_FILE ?? join(root, 'air', 'partner_rs256.pem');
  if (!existsSync(keyFile)) {
    console.log(`[air] AIR_ISSUER_DID set but no key at ${keyFile} — run: node tools/air-keygen.mjs`);
    return null;
  }
  const partnerId = process.env.AIR_PARTNER_ID ?? DEFAULT_PARTNER_ID;
  return {
    issuerDid,
    credentialId,
    partnerId,
    kid: process.env.AIR_KID ?? partnerId,
    apiUrl: (process.env.AIR_API_URL ?? DEFAULT_AIR_API).replace(/\/+$/, ''),
    privateKeyPem: readFileSync(keyFile, 'utf8'),
  };
};

export interface AirIssuer {
  /**
   * Queue a reputation write for this player. Coalesces bursts: at most one
   * in-flight + one trailing issuance per profile per COOLDOWN_MS, always
   * carrying the latest subject. Never throws — attestation is best-effort
   * and must not touch match settlement.
   */
  queueReputation: (profileId: string, email: string, subject: ReputationSubject) => void;
}

export const createAirIssuer = (
  cfg: AirIssuerConfig,
  fetchImpl: typeof fetch = fetch,
  cooldownMs = COOLDOWN_MS,
): AirIssuer => {
  interface Entry { lastAt: number; pending: { email: string; subject: ReputationSubject } | null; timer: NodeJS.Timeout | null }
  const perProfile = new Map<string, Entry>();

  const post = async (profileId: string, email: string, subject: ReputationSubject): Promise<void> => {
    const token = signPartnerJwt(cfg, { email, scope: 'issue' });
    const res = await fetchImpl(`${cfg.apiUrl}/credentials/issue-on-behalf`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-partner-auth': token },
      body: JSON.stringify({
        issuerDid: cfg.issuerDid,
        credentialId: cfg.credentialId,
        credentialSubject: subject,
        onDuplicate: 'revoke', // the credential is a snapshot — replace, don't stack
      }),
    });
    const body = await res.text();
    if (!res.ok) throw new Error(`${res.status}: ${body.slice(0, 160)}`);
    const out = JSON.parse(body) as { coreClaimHash?: string };
    console.log(`[air] reputation issued for ${profileId} (LV ${subject.level}, ${subject.wins}W ${subject.losses}L) · claim ${out.coreClaimHash ?? '?'}`);
  };

  const run = (profileId: string, email: string, subject: ReputationSubject): void => {
    const e = perProfile.get(profileId) ?? { lastAt: 0, pending: null, timer: null };
    perProfile.set(profileId, e);
    const now = Date.now();
    if (now - e.lastAt < cooldownMs) {
      // Inside the cooldown: remember the freshest stats and schedule one
      // trailing write at the window's edge.
      e.pending = { email, subject };
      e.timer ??= setTimeout(() => {
        e.timer = null;
        const p = e.pending;
        e.pending = null;
        if (p) run(profileId, p.email, p.subject);
      }, cooldownMs - (now - e.lastAt) + 50);
      e.timer.unref?.();
      return;
    }
    e.lastAt = now;
    void post(profileId, email, subject).catch((err) => {
      console.log(`[air] issuance failed for ${profileId}: ${String((err as Error).message ?? err)}`);
    });
  };

  return { queueReputation: run };
};
