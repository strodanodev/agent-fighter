/**
 * AIR session-JWT verification — pure-crypto tests with a throwaway P-256
 * keypair (same alg/curve as AIR's real JWKS). No network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { acceptedPartners, partnerAccepted, verifyJwtWithKeys } from '../src/airjwt.js';

const b64url = (buf: Buffer): string => buf.toString('base64url');

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const jwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
const KEYS = [{ ...jwk, kty: 'EC', alg: 'ES256', kid: 'test-key' }];

const signJwt = (payload: Record<string, unknown>, header: Record<string, unknown> = {}): string => {
  const h = b64url(Buffer.from(JSON.stringify({ alg: 'ES256', kid: 'test-key', ...header })));
  const p = b64url(Buffer.from(JSON.stringify(payload)));
  const sig = cryptoSign('sha256', Buffer.from(`${h}.${p}`), { key: privateKey, dsaEncoding: 'ieee-p1363' });
  return `${h}.${p}.${b64url(sig)}`;
};

const NOW = 1_800_000_000;

test('valid ES256 token verifies and yields the payload', () => {
  const token = signJwt({
    sub: 'user-uuid-1', abstractAccountAddress: '0xAbCd', partnerId: 'p1', exp: NOW + 3600,
  });
  const payload = verifyJwtWithKeys(token, KEYS, NOW);
  assert.equal(payload.sub, 'user-uuid-1');
  assert.equal(payload.abstractAccountAddress, '0xAbCd');
});

test('tampered payload is rejected', () => {
  const token = signJwt({ sub: 'honest', exp: NOW + 3600 });
  const [h, , s] = token.split('.');
  const forged = `${h}.${b64url(Buffer.from(JSON.stringify({ sub: 'attacker', exp: NOW + 3600 })))}.${s}`;
  assert.throws(() => verifyJwtWithKeys(forged, KEYS, NOW), /bad signature/);
});

test('expired token is rejected', () => {
  const token = signJwt({ sub: 'user', exp: NOW - 10 });
  assert.throws(() => verifyJwtWithKeys(token, KEYS, NOW), /expired/);
});

test('a token with NO exp is rejected (no permanent bearer credentials)', () => {
  const token = signJwt({ sub: 'user' }); // valid signature, but no exp claim
  assert.throws(() => verifyJwtWithKeys(token, KEYS, NOW), /missing exp/);
});

test('alg:none and HMAC are disallowed (no downgrade attacks)', () => {
  const none = `${b64url(Buffer.from('{"alg":"none"}'))}.${b64url(Buffer.from('{"sub":"x"}'))}.`;
  assert.throws(() => verifyJwtWithKeys(none, KEYS, NOW), /disallowed alg/);
  const hs = `${b64url(Buffer.from('{"alg":"HS256"}'))}.${b64url(Buffer.from('{"sub":"x"}'))}.${b64url(Buffer.from('sig'))}`;
  assert.throws(() => verifyJwtWithKeys(hs, KEYS, NOW), /disallowed alg/);
});

test('unknown kid is rejected (triggers the JWKS refetch path upstream)', () => {
  const token = signJwt({ sub: 'user', exp: NOW + 3600 }, { kid: 'rotated-away' });
  assert.throws(() => verifyJwtWithKeys(token, KEYS, NOW), /no JWK/);
});

test('signature from a DIFFERENT key is rejected', () => {
  const other = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const h = b64url(Buffer.from(JSON.stringify({ alg: 'ES256', kid: 'test-key' })));
  const p = b64url(Buffer.from(JSON.stringify({ sub: 'user', exp: NOW + 3600 })));
  const sig = cryptoSign('sha256', Buffer.from(`${h}.${p}`), { key: other.privateKey, dsaEncoding: 'ieee-p1363' });
  assert.throws(() => verifyJwtWithKeys(`${h}.${p}.${b64url(sig)}`, KEYS, NOW), /bad signature/);
});

// ── partner allowlist (audit 2026-07-18 H4: a token any AIR partner app minted verifies above) ──
const SITE = 'cdbfc9c4-62db-4947-b0de-c28932887132'; // agentfighter.wtf
const ARCADE = '62e01755-138f-4e58-9cdc-fab71e037afd'; // the litVM arcade (universal login)

test('AIR_PARTNER_IDS accepts every listed partner and nothing else', () => {
  const accepted = acceptedPartners({ AIR_PARTNER_IDS: `${SITE}, ${ARCADE}` });
  assert.deepEqual(accepted, [SITE, ARCADE]);
  assert.ok(partnerAccepted(SITE, accepted));
  assert.ok(partnerAccepted(ARCADE, accepted));
  assert.ok(!partnerAccepted('some-other-app', accepted));
  assert.ok(!partnerAccepted(undefined, accepted), 'a token with no partnerId is not on any allowlist');
});

test("AIR_PARTNER_IDS wins over an inherited AIR_PARTNER_ID (the node.env leak that 401'd the site)", () => {
  const accepted = acceptedPartners({ AIR_PARTNER_ID: ARCADE, AIR_PARTNER_IDS: `${SITE},${ARCADE}` });
  assert.ok(partnerAccepted(SITE, accepted));
});

test('a lone AIR_PARTNER_ID is still enforced', () => {
  const accepted = acceptedPartners({ AIR_PARTNER_ID: SITE });
  assert.ok(partnerAccepted(SITE, accepted));
  assert.ok(!partnerAccepted(ARCADE, accepted));
});

test('no partner configured accepts any partner (env-gated, never guessed)', () => {
  const accepted = acceptedPartners({});
  assert.deepEqual(accepted, []);
  assert.ok(partnerAccepted('anything', accepted));
  assert.ok(partnerAccepted(undefined, accepted));
});
