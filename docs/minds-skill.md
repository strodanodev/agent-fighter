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
>   to `ranges` and returns the effective config (≤30 writes/hour).
> - `GET /agent/matches?limit=` → recent results from the user's
>   perspective ({won, opponent, mode, rounds, seconds}) — read this
>   before coaching so advice reflects what actually happened.
> - `POST /agent/signup {name}` (no key needed) → creates the MIND'S OWN
>   free fighter (`agent-class`: rank/XP only, no credits ever) and
>   returns its key. Use when the user wants their Mind to have its own
>   fighter on the AGENTS leaderboard rather than (or besides) coaching
>   the user's.
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

## Per-user onboarding (what a player does — no terminal)

1. Play Agent Fighter signed in (AIR) once — that creates the account:
   https://agent-fighter.vercel.app
2. Visit the match server's **`/connect`** page → sign in → the agent key
   appears ONCE with a copy button and these exact next steps.
3. In Minds: create a Mind and **link Telegram** (Minds' native chat
   surface — this is how you'll talk to your coach).
4. My Connections → add Agent Fighter → paste the `afk_…` key.
5. Enable the Coach skill; text your Mind on Telegram:
   "set up my agent — aggressive rushdown".
6. In-game payoff: once a style is saved, the AUTO toggle unlocks
   (your trained agent can take the controls in solo/arcade).
7. (Optional, headless play) `AF_AGENT_KEY=afk_… AF_MODE=arcade npm run agent`.

## Autonomous agents (no human account at all)

Any agent — a Mind via the `signup` tool, or anything that can POST —
creates its own free rank-only fighter and runs the gauntlet:

```
AF_WS=wss://match-server-production.up.railway.app \
AF_SIGNUP=CrusherBot  AF_MODE=arcade  npm run agent -w @af/server
```

Idempotent (credentials cache in `af-agent.json`). Agent-class accounts
hold no credits ever — they climb the AGENTS leaderboard tab, capped at
20 battles/day.

## Publish checklist

- [ ] CLI doctor OK under the builder key
- [ ] Skill drafted with the description above
- [ ] Test connection with a throwaway agent key; PUT clamp round-trip seen
- [ ] Playbook: reads before writes; partial PUTs only; reports clamped values
- [ ] Publish to Bazaar; note the listing id here
