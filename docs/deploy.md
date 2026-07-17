# Deploying Agent Fighter

Three pieces, three homes. The Studio is deliberately not one of them.

| Piece | Host | What it is |
|---|---|---|
| Game client | Vercel | Static bundle: `npm run build && npm run demo && node tools/vercel-build.mjs` → `public/` |
| Match server | Railway | Long-lived Node process: matchmaking, WS relay, input ledger, verification, escrow |
| Database | Supabase | `profiles` / `matches` / `credit_ledger`, service-role only, RLS read-only for clients |

## Why the match server can't live on Vercel

It is a stateful `ws` server. Matches are in-process objects — input ledgers,
forfeit timers, the pairing queue — held across the life of a WebSocket
connection. Vercel's functions are request-scoped and die between invocations,
so there is nowhere for a match to exist. It needs a process that stays up:
Railway (what we use), Fly.io, or Render.

It also reads `characters/<id>/character.json` and `stages/` off disk at
`REPO_ROOT` to re-simulate ledgers, so it needs the repo layout, not a
compiled bundle.

## Match server env

| Var | Required | Notes |
|---|---|---|
| `SUPABASE_URL` | **yes** | Project URL |
| `SUPABASE_SERVICE_KEY` | **yes** | Service role. Bypasses RLS — server only, NEVER in the client bundle |
| `PORT` | no | Railway injects it; falls back to 8477 |
| `AIR_ISSUER_DID` | no | Reputation write-back (ADR 0004); off unless fully configured |
| `AIR_CREDENTIAL_ID` | no | Issuance-program id |
| `AIR_PARTNER_KEY_FILE` | no | Private PEM, default `air/partner_rs256.pem` |
| `AIR_API_URL` | no | Defaults to the sandbox |

Two env vars are load-bearing for integrity, and both fail closed on purpose:

- **Missing Supabase vars used to silently downgrade** to the in-memory
  economy, which is `dev: true` — the server mints a name-keyed identity for
  anyone who asks and `/me` authenticates on a bare `X-Dev-Name` header. Any
  player could wear any account and mint credits. `createPersistence()` now
  refuses to start instead; `AF_ALLOW_DEV_ECONOMY=1` opts into the throwaway
  economy explicitly, for laptops only.
- **`AF_NO_PACE_CHECK`** disables the solo wall-clock sanity check, which is
  the only thing standing between a local-sim ranked match and tool-assisted
  slow-motion. It now refuses to start unless `AF_ALLOW_DEV_ECONOMY=1` is set
  alongside it.

Neither flag belongs on a public host. Ever.

## Client → match server

`matchWsUrl()` in `packages/client/src/main.ts` resolves in this order:

1. `?ws=` query param — overrides everything (dev, staging, testing).
2. https page → `PROD_MATCH_WS` (the Railway wss:// origin).
3. otherwise → `ws://<hostname>:8477` (local `npm run play` beside the server).

Rule 2 exists because **browsers block `ws://` from an https origin** as mixed
content. The production default must be `wss://` or online play is dead before
a packet moves. Railway terminates TLS, so the server itself stays plain `ws`.

## Deploying the match server

```bash
railway login
railway init            # once — creates the project
railway variables --set SUPABASE_URL=... --set SUPABASE_SERVICE_KEY=...
railway up
railway domain          # get the public host → PROD_MATCH_WS
```

Then set `PROD_MATCH_WS` in `packages/client/src/main.ts` to
`wss://<that-host>` and redeploy the client (`vercel deploy --prod --yes`).

Health check: `GET /` returns engine/protocol/character/stage counts and
whether persistence is on. `GET /leaderboard` and `/me` are the HTTP surface;
`/.well-known/jwks.json` serves the AIR partner JWKS.

## Not deployed: the Studio

`packages/studio` is a local authoring tool. It proxies image generation with
`NVAPI_KEY` / `GEMINI_API_KEY` and has unauthenticated bundle-write CRUD. It
has no place on the public internet. Run it locally: `npm run studio`.
