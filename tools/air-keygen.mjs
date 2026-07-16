/**
 * Generate the AIR partner signing keypair (RS256) — run ONCE:
 *
 *   node tools/air-keygen.mjs
 *
 * Writes:
 *   air/partner_rs256.pem  — PRIVATE key (gitignored; the match server signs
 *                            Partner JWTs with it — treat like a password)
 *   air/jwks.json          — PUBLIC JWKS (committed; served at
 *                            /.well-known/jwks.json by the match server and
 *                            the Vercel deploy)
 *
 * Then register the public URL in the AIR Developer Dashboard:
 *   Account → General Settings → "JWKS URL"
 *   e.g. https://<your-vercel-domain>/.well-known/jwks.json
 *
 * Re-running refuses to overwrite an existing private key (rotating the key
 * invalidates the registered JWKS — delete air/partner_rs256.pem first if
 * you really mean it, then re-register the new JWKS URL contents).
 */
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'air');
const pemFile = join(dir, 'partner_rs256.pem');
const jwksFile = join(dir, 'jwks.json');

if (existsSync(pemFile)) {
  console.error(`refusing to overwrite ${pemFile} — delete it first to rotate keys`);
  process.exit(1);
}

// kid defaults to the (public) partner id so the JWT header ↔ JWKS match is
// self-evident; override with AIR_KID if you ever host multiple keys.
const kid = process.env.AIR_KID ?? 'cdbfc9c4-62db-4947-b0de-c28932887132';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = publicKey.export({ format: 'jwk' });

mkdirSync(dir, { recursive: true });
writeFileSync(pemFile, privateKey.export({ type: 'pkcs8', format: 'pem' }));
writeFileSync(jwksFile, JSON.stringify({
  keys: [{ kty: jwk.kty, kid, use: 'sig', alg: 'RS256', n: jwk.n, e: jwk.e }],
}, null, 2));

console.log(`private key → ${pemFile}  (GITIGNORED — never commit)`);
console.log(`public JWKS → ${jwksFile}  (committed; register its public URL in the AIR dashboard)`);
