# "Agent Fighter Coach" — Minds Bazaar skill setup

How to stand up the TRAIN MY AGENT coach as an Animoca Minds skill.
The API it drives is documented in [`agent-api.md`](agent-api.md).

## One-time (you, the builder)

1. Account per https://build.hellominds.ai/docs/get-started/account-setup:
   create a Mind, then issue a Builder API key → already stored as
   `MINDS_BUILDER_API_KEY` in the repo `.env` (gitignored).
2. Sanity-check the CLI (JSON out, needs the env var):
   ```bash
   npx -y @animocabrands/minds-cli@latest doctor --pretty
   npx -y @animocabrands/minds-cli@latest list --pretty
   ```
3. Build the skill per https://build.hellominds.ai/docs/guides/building-skills:
   describe it to your Mind in natural language (Telegram/email or console);
   the platform generates the registry offering, app manifest, tool schemas
   and playbook. Use the description below as the seed. Connect the app with
   a TEST agent key first (mint one on a throwaway account), run the flow,
   inspect, then Publish to the Bazaar.

## Skill description (paste this as the seed)

> **Agent Fighter Coach.** Connects to the Agent Fighter match server
> (base URL `https://match-server-production.up.railway.app`, auth header
> `X-Agent-Key`, key provided by the user via My Connections).
>
> The user owns a fighting-game agent — a saved strategy profile with a
> `character` and six style knobs (`aggression`, `jumpiness`, `zoner`,
> `throwHappy`, `pushblocker`, `patience`). This skill lets the user TRAIN
> their agent by talking to you like a coach.
>
> Tools:
> - `GET /agent` → the agent's config plus its owner's read-only record
>   (name, level, xp, wins, losses) and the legal `ranges` per knob.
> - `PUT /agent` with any subset of `{character, personality, motto}` —
>   partial personality writes merge with what's saved; the server clamps
>   to `ranges` and returns the effective config.
>
> Behavior: when the user asks how their agent is doing, read `GET /agent`
> and summarize the record and current style in fight-coach language. When
> the user gives style direction ("more rushdown", "stop jumping", "lame
> them out", "play patient and punish"), translate it into knob nudges and
> apply with a partial PUT, then read back what actually saved (values may
> clamp) and say what changed. Suggest a motto if they don't have one.
> NEVER promise stat or skill changes — skill comes from the owner's level,
> which is earned by playing; if asked, explain that and suggest playing
> ranked matches (`AF_MODE=solo`) to level up.

## Per-user onboarding (what a player does)

1. Play Agent Fighter signed in (AIR) once — that creates the account:
   https://agent-fighter.vercel.app
2. Mint the agent key (shown once):
   `POST /agent/key` with their AIR session bearer — in-game MY AGENT
   screen once it ships; until then the owner can mint from the browser
   console on the game page (signed in):
   ```js
   fetch(MATCH_HTTP + '/agent/key', { method: 'POST',
     headers: { Authorization: 'Bearer ' + (await afAuth().token) } })
     .then(r => r.json()).then(console.log)
   ```
3. In Minds: My Connections → add Agent Fighter → paste the `afk_…` key.
4. Enable the Coach skill; start talking.
5. (Optional, headless play) `AF_AGENT_KEY=afk_… AF_MODE=solo npm run agent`.

## Publish checklist

- [ ] CLI doctor OK under the builder key
- [ ] Skill drafted with the description above
- [ ] Test connection with a throwaway agent key; PUT clamp round-trip seen
- [ ] Playbook: reads before writes; partial PUTs only; reports clamped values
- [ ] Publish to Bazaar; note the listing id here
