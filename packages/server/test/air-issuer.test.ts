/**
 * AIR reputation write-back (ADR 0004) — the Partner JWT must verify against
 * our own generated JWKS (the same check AIR's servers run against the
 * registered JWKS URL), and issuance must coalesce bursts per profile.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateKeyPairSync } from 'node:crypto';
import { createAirIssuer, signPartnerJwt } from '../src/air-issuer.js';
import type { AirIssuerConfig, ReputationSubject } from '../src/air-issuer.js';
import { verifyJwtWithKeys } from '../src/airjwt.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

const cfg: AirIssuerConfig = {
  issuerDid: 'did:air:test:issuer',
  credentialId: 'af-reputation-test',
  partnerId: 'partner-123',
  kid: 'partner-123',
  apiUrl: 'https://air.example/v1',
  privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
};

const jwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
const jwks = [{ ...jwk, kid: cfg.kid, alg: 'RS256', use: 'sig' } as never];

const subject = (wins: number): ReputationSubject => ({
  level: 2, xp: 40, wins, losses: 1, credits: 19, is_agent: false, engine: 'af-core-1',
});

test('partner JWT: RS256-signed, kid in header, documented claims, 5-min expiry', () => {
  const token = signPartnerJwt(cfg, { email: 'player@example.com', scope: 'issue' }, 1_000_000);
  const header = JSON.parse(Buffer.from(token.split('.')[0]!, 'base64url').toString()) as Record<string, unknown>;
  assert.equal(header.alg, 'RS256');
  assert.equal(header.typ, 'JWT');
  assert.equal(header.kid, cfg.kid);
  // The exact verification AIR performs: signature against the JWKS by kid.
  const payload = verifyJwtWithKeys(token, jwks, 1_000_100);
  assert.equal(payload.partnerId, cfg.partnerId);
  assert.equal(payload.scope, 'issue');
  assert.equal(payload.email, 'player@example.com');
  assert.equal(payload.exp, 1_000_300); // +300s, the documented recommendation
  // And it must be REJECTED once expired.
  assert.throws(() => verifyJwtWithKeys(token, jwks, 1_000_301), /expired/);
});

test('issuance: correct request shape; bursts coalesce to first + trailing-latest', async () => {
  const calls: Array<{ url: string; auth: string; body: Record<string, unknown> }> = [];
  const fetchMock = (async (url: unknown, init?: RequestInit) => {
    calls.push({
      url: String(url),
      auth: String((init?.headers as Record<string, string>)['x-partner-auth']),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    return new Response(JSON.stringify({ coreClaimHash: 'h1', credentialId: cfg.credentialId, userUuid: 'u1' }), { status: 200 });
  }) as typeof fetch;

  const issuer = createAirIssuer(cfg, fetchMock, 200); // 200ms cooldown for the test
  issuer.queueReputation('air-sub-1', 'p1@example.com', subject(1));
  issuer.queueReputation('air-sub-1', 'p1@example.com', subject(2)); // burst…
  issuer.queueReputation('air-sub-1', 'p1@example.com', subject(3)); // …latest wins
  issuer.queueReputation('air-sub-2', 'p2@example.com', subject(9)); // other profile: independent

  await new Promise((r) => setTimeout(r, 60));
  assert.equal(calls.length, 2); // sub-1 first write + sub-2 — burst held back
  await new Promise((r) => setTimeout(r, 350));
  assert.equal(calls.length, 3); // trailing write carried the LATEST stats

  const first = calls.find((c) => (c.body.credentialSubject as ReputationSubject).wins === 1)!;
  assert.equal(first.url, `${cfg.apiUrl}/credentials/issue-on-behalf`);
  assert.equal(first.body.issuerDid, cfg.issuerDid);
  assert.equal(first.body.credentialId, cfg.credentialId);
  assert.equal(first.body.onDuplicate, 'revoke');
  // The auth JWT verifies against our JWKS and targets the recipient.
  const p = verifyJwtWithKeys(first.auth, jwks);
  assert.equal(p.email, 'p1@example.com');

  const trailing = calls[2]!;
  assert.equal((trailing.body.credentialSubject as ReputationSubject).wins, 3);
  assert.equal(JSON.parse(Buffer.from(trailing.auth.split('.')[1]!, 'base64url').toString()).email, 'p1@example.com');
});

test('issuance failures never throw into the caller', async () => {
  const fetchMock = (async () => new Response('{"error":"schema not allowed"}', { status: 403 })) as typeof fetch;
  const issuer = createAirIssuer(cfg, fetchMock, 10);
  issuer.queueReputation('air-sub-3', 'p3@example.com', subject(1)); // logs, must not reject
  await new Promise((r) => setTimeout(r, 50));
});
