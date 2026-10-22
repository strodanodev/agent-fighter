# Deploying Agent Fighter

Since October 2026 Agent Fighter runs without a hosting bill for its match
server: the client is on Vercel and the match server ("the relay") runs on the
publisher's litnode node. Placed matches run on gauntlet servers that litnode
nodes spawn per match. There is no Railway any more. The Studio is
deliberately not deployed.

| Piece | Where | How it ships |
|---|---|---|
| Game client | Vercel project `contactstrodano-8632s-projects/agent-fighter` (www.agentfighter.wtf, agent-fighter.vercel.app) | **Push `master`.** The project is connected to GitHub; every push to `master` is a production deploy. Build: `npm run build && npm run demo && node tools/vercel-build.mjs` → `public/` |
| Relay (match server) | The publisher's litnode node, Windows scheduled task `litnode-relay` | **Restart the task.** It runs `npm run server` from the node's `AF_ROOT` checkout |
| Placed matches | Gauntlet servers on litnode nodes (ADR 0013, 0014) | litnode's server bundle (`npm run bundle:server` in litnode, registered on TitleRegistry) |
| Database | Supabase | Migrations in `supabase/migrations/`; the relay is the only writer (service role) |

## The commands

```bash
npm run deploy                 # paired: push master → Vercel, then restart the relay
npm run deploy:client          # push master and wait for Vercel's production deployment
npm run deploy:relay           # restart the litnode-relay task and wait for /health
npm run deploy -- --dry-run    # every gate and what would happen; changes nothing
```

`tools/deploy.mjs` refuses to deploy unless:

- the tree is clean (untracked files are fine);
- you are on `master`, and `master` is not behind `origin/master`.

Then, depending on the target:

- **Client.** It pushes, waits for the GitHub deployment of `HEAD` that
  Vercel reports, and reads `ENGINE_VERSION` back from the live bundle.
- **Relay.** It runs `schtasks /End` and then `/Run` on the task, waits for a
  new process on the relay port, and checks `/health` reports the same engine.

Run it on the publisher's desktop. The relay task is registered by the
litnode node's `install-task.cmd` with RunLevel Highest, so its process cannot
be stopped from an ordinary shell. `schtasks` can stop it, and the task's loop
(`run-af-relay.cmd`) frees the port when it starts.

Always use the paired `npm run deploy` when `ENGINE_VERSION` changes. A client
and relay on different engines reject every player at `hello`.

Other relay operators (the m16 standby) pull `master` and restart their own
`litnode-relay` task.

**Never `vercel deploy` from this repo.** Its `.vercel` link points at a
different, empty project, and the CLI login on the publisher's desktop cannot
see the production project. A redeploy without a new commit is done from the
Vercel dashboard ("Redeploy").

## The relay runs what is on disk

`run-af-relay.cmd` restarts the relay whenever it exits, from whatever is in
`AF_ROOT` at that moment, not from git `HEAD`. If `AF_ROOT` is the checkout you
develop in, a crash puts your uncommitted edits in front of players.

That happened on 22 Oct 2026. A half-finished engine bump went live on the
relay while the client was still on the old engine.

So:

- **Recommended:** point `AF_ROOT` (in the node's `node.env`) at a dedicated
  checkout or worktree that only moves on deploy. Then set `LITNODE_DIR` to the
  node folder when you deploy. `deploy.mjs` reads `AF_ROOT` from `node.env` and
  fast-forwards that checkout to `origin/master` before the restart. If
  `package-lock.json` changed, it tells you to run `npm ci` there.
- **Until then:** keep the development checkout clean whenever you are not
  deploying, and treat any edit in it as live.

## Relay env

`run-af-relay.cmd` loads `AF_ROOT\.env` into the relay's environment, and
`PORT` comes from the node's `RELAY_PORT` (default 8477).

| Var | Required | Notes |
|---|---|---|
| `SUPABASE_URL` | **yes** | Project URL |
| `SUPABASE_SERVICE_KEY` | **yes** | Service role. Bypasses RLS — relay only, NEVER in the client bundle |
| `PORT` | no | Set from `RELAY_PORT`; falls back to 8477 |
| `AIR_ISSUER_DID` | no | Reputation write-back (ADR 0004); off unless fully configured |
| `AIR_CREDENTIAL_ID` | no | Issuance-program id |
| `AIR_PARTNER_KEY_FILE` | no | Private PEM, default `air/partner_rs256.pem` |
| `AIR_API_URL` | no | Defaults to the sandbox |

Two env vars are load-bearing for integrity, and both fail closed on purpose:

- **`SUPABASE_URL` and `SUPABASE_SERVICE_KEY` must be set.**
  - Missing, they used to silently downgrade the relay to the in-memory
    economy, which is `dev: true`. That economy mints a name-keyed identity
    for anyone who asks, and `/me` authenticates on a bare `X-Dev-Name` header.
    Any player could wear any account and mint credits.
  - `createPersistence()` now refuses to start instead.
  - `AF_ALLOW_DEV_ECONOMY=1` opts into the throwaway economy explicitly, for
    laptops only.
- **`AF_NO_PACE_CHECK`** disables the solo wall-clock sanity check. That check
  is the only thing standing between a local-sim ranked match and
  tool-assisted slow motion. It refuses to start unless
  `AF_ALLOW_DEV_ECONOMY=1` is set alongside it.

Neither flag belongs on a public relay. Ever.

A gauntlet server never reads `.env`, holds no database and never issues AIR
credentials (ADR 0013, 0014).

## Client → relay

The relay's public address is the node's Cloudflare quick tunnel, so the
hostname changes every time the node restarts. The node announces the current
`wss://` address in its NodeDirectory entry on litVM.

`matchWsUrl()` in `packages/client/src/main.ts` resolves in this order:

1. The `?ws=` query parameter overrides everything. The LIT GAMES arcade
   passes the placed host's relay this way; it is also how you test.
2. An https page uses the relay the mesh announced. `mesh.ts` reads
   NodeDirectory and NodeStake with addresses from the arcade's
   `contracts.json`, prefers the publisher's relays, and caches the result.
3. Otherwise, the `PROD_MATCH_WS` constant. It is a dead Railway address kept
   only as a last resort, so with no chain and no cache the game honestly
   shows offline.
4. On http (local `npm run play`), `ws://<hostname>:8477`.

**To find the relay by hand** (for headless agents, see
[headless-agent.md](headless-agent.md)), use either:

- `curl <node>/health` on the publisher's node and read `wsAddr`;
- `npm run fleet -- relay --arcade` in litnode, which prints what a title
  discovers.

Browsers block `ws://` from an https origin as mixed content, so the address
is always `wss://`. Cloudflare terminates TLS, and the relay itself stays plain
`ws`.

## Shipping assets (characters + pets): `npm run ship`

For **asset** changes — a character authored in Studio, a pet and its frames —
do not run the deploy steps by hand. `tools/ship-assets.mjs` does the whole
thing and refuses to proceed when something is wrong. It verifies, builds,
commits and pushes, and then runs `tools/deploy.mjs` (the push deploys the
client; the relay restart deploys the relay).

**Which folder you are in decides which command works.**

- The repo is `AGENT FIGHTER\agent-fighter\`.
- The parent `AGENT FIGHTER\` wrapper has no `package.json`, so npm there walks
  up to a stray home-dir one and fails with a bare `Missing script: "ship"`.

Both spellings below do the identical thing:

```bash
# from the WRAPPER folder (AGENT FIGHTER\) — use the .cmd launcher:
.\ship --dry-run
.\ship
.\ship -m "add nullpup"

# from the REPO folder (AGENT FIGHTER\agent-fighter\) — npm resolves:
npm run ship -- --dry-run          # print the plan, change nothing
npm run ship                       # verify → build → commit → push → restart the relay
npm run ship -- -m "add nullpup"   # explicit commit message
npm run ship -- --no-deploy        # commit + push only (the push still deploys the client)
```

`.\ship` just `cd`s into the repo and forwards every argument, so anything
below that works with one works with the other.

It exists because every one of these has bitten us at least once:

| Guard | The failure it prevents |
|---|---|
| repo check | the parent `AGENT FIGHTER/` wrapper is a different, stray git repo |
| `rehash --check` | `versionHash` drift → online play dies with "bundle hash mismatch" |
| WIP guard | the relay runs the WORKING TREE, so an unfinished Studio character ships **selectable and broken** on the next restart |
| **pet manifest** | a `pet.json` naming a frame that is missing, or that exists but is not committed → **404 art in prod** |
| paired deploy | both tiers read these directories off disk; one-sided leaves the relay rolling a pet the client cannot draw |
| engine skew | relay `engine` ≠ client `ENGINE_VERSION` → every online match hello-rejects |

The pet manifest guard runs twice on purpose:

- **Up front:** is every referenced frame on disk?
- **After staging, immediately before the commit:** is every referenced frame
  actually going into it?

The second check is what stops a manifest and its art from drifting apart.
Frames dismissed as rejects in one session became a real animation in the
next, and the manifest started pointing at them.

After the deploy, it checks both tiers for the new assets:

- the client must serve `/pets/<id>/pet.json` **and its first frame**;
- the relay's health (on this machine) must list the pet ids (`pets` in the
  health JSON) and the full roster.

## Health

`GET /` (or `/health`) on the relay returns:

- engine and protocol;
- the character, stage and pet ids;
- live counts: `online`, `agents`, `queued`;
- whether persistence is on.

`GET /leaderboard` and `/me` are the HTTP surface. `/.well-known/jwks.json`
serves the AIR partner JWKS.

## Not deployed: the Studio

`packages/studio` is a local authoring tool. It proxies image generation with
`NVAPI_KEY` / `GEMINI_API_KEY` and has unauthenticated bundle-write CRUD. It
has no place on the public internet. Run it locally: `npm run studio`.
