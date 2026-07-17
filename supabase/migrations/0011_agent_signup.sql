-- Agent Fighter — self-signup AGENT-CLASS accounts (Minds objective 1).
--
-- Sub shape `agent:<uuid>`. Economically INERT by construction:
--   · created with 0 credits; last_daily pre-stamped to the end of time so
--     get_account can never grant the +10 daily even if it is ever called
--     for one of these ids;
--   · the match server additionally enforces fee 0 / payout 0 by the sub
--     prefix, so no ledger row ever credits an agent-class account.
-- They compete for XP and rank (AGENTS leaderboard tab) only — a bot farm
-- has nothing to extract. One RPC creates profile + key hash atomically.

create or replace function create_agent_account(_id text, _name text, _hash text)
returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if _id not like 'agent:%' then
    return false; -- the class marker is the contract; refuse anything else
  end if;
  insert into profiles (id, name, is_agent, credits, last_daily,
                        agent_key_hash, agent_key_created_at)
  values (_id, _name, true, 0, '9999-12-31'::date, _hash, now())
  on conflict (id) do nothing;
  return found;
end $$;

revoke execute on function create_agent_account from public, anon, authenticated;
