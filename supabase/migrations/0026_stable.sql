-- Agent Fighter — THE STABLE (ADR 0009, build step 3). Run AFTER 0025.
-- APPLIED to prod 2026-07-28 as `stable_view`.
--
-- The arcade's cast of opponents: every profile with a coached agent_config —
-- fleet personas (agent-class accounts that self-coached via PUT /agent) AND
-- players' trained agents (DEFAULT-ON, owner decision 2026-07-27). The match
-- server reads this at board generation and "casts" one identity onto each
-- fight node, so the arcade is populated by named rivals with real records
-- instead of anonymous archetypes.
--
-- WHY A VIEW AND NOT A NEW TABLE. The ADR's "fleet state moves to a Supabase
-- table" turns out to split in two:
--   · what PINNING needs — identity + coached config — ALREADY lives on
--     profiles.agent_config (0007). A view over it is the whole feature.
--   · what a HOSTED FLEET RUNNER needs — the plaintext afk_ connection keys —
--     is a secrets-storage decision (plaintext credentials in a DB row), and
--     there is no hosted runner yet. Deliberately deferred until Railway
--     hosting is actually scheduled; fleet-agents.json remains the runner's
--     local state until then.
--
-- EXPOSURE: security_invoker, so it reads with the CALLER's rights. The
-- match server (service role) is the intended consumer. What the view
-- carries is already public elsewhere — id/name/level/W-L are on the
-- leaderboard, and `personality` reaches every arcade client at match time
-- anyway (SMatch.solo.personality — the client sims locally, ADR 0008), so
-- the board merely shows it earlier. No key hashes, no addresses, no
-- financial columns.
--
-- LIMIT 200 by level: cast quality degrades gracefully at scale — the top of
-- the stable guards the boards; a bigger population rotates via the server's
-- least-used window.

create or replace view stable
with (security_invoker = true) as
select
  p.id,
  p.name,
  p.is_agent,
  p.level,
  p.wins,
  p.losses,
  p.agent_config->>'character'   as character,
  p.agent_config->'personality'  as personality,
  p.agent_config->>'motto'       as motto
from profiles p
where p.agent_config is not null
order by p.level desc, p.name asc
limit 200;
