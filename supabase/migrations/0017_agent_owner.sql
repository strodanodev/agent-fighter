-- Agent Fighter — agent-class accounts owned by an AIR operator.
-- Run AFTER 0016 (and after 0011's 3-arg create_agent_account).
--
-- Before: POST /agent/signup was unauthenticated (anyone could mint).
-- After: signup requires a signed-in owner; profiles.owner_sub links the
-- inert agent:<uuid> row to that AIR (or dev:) sub. Caps become per-owner.
-- Server code: createAgentAccount(..., ownerSub) + countOwnedAgents.
--
-- Rollout: keep the 3-arg overload so a not-yet-redeployed match server
-- can still call RPC (auth gate lives in server.ts). After the owner-auth
-- server is live, drop create_agent_account(text,text,text).

alter table profiles add column if not exists owner_sub text;

create index if not exists profiles_owner_sub_idx
  on profiles (owner_sub) where owner_sub is not null;

-- 4-arg (new server) — requires owner_sub
create or replace function create_agent_account(
  _id text, _name text, _hash text, _owner text
) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if _id not like 'agent:%' then
    return false;
  end if;
  if _owner is null or length(trim(_owner)) = 0 then
    return false;
  end if;
  if _owner like 'agent:%' then
    return false; -- agent-class keys cannot mint more agents
  end if;
  insert into profiles (id, name, is_agent, credits, last_daily,
                        agent_key_hash, agent_key_created_at, owner_sub)
  values (_id, _name, true, 0, '9999-12-31'::date, _hash, now(), trim(_owner))
  on conflict (id) do nothing;
  return found;
end $$;

-- 3-arg (legacy match server until redeploy) — no owner link
create or replace function create_agent_account(
  _id text, _name text, _hash text
) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if _id not like 'agent:%' then
    return false;
  end if;
  insert into profiles (id, name, is_agent, credits, last_daily,
                        agent_key_hash, agent_key_created_at)
  values (_id, _name, true, 0, '9999-12-31'::date, _hash, now())
  on conflict (id) do nothing;
  return found;
end $$;

create or replace function count_owned_agents(_owner text)
returns integer
language sql stable security definer set search_path = public as $$
  select count(*)::integer from profiles
  where owner_sub = trim(_owner) and id like 'agent:%';
$$;

revoke execute on function create_agent_account(text, text, text, text) from public, anon, authenticated;
revoke execute on function create_agent_account(text, text, text) from public, anon, authenticated;
revoke execute on function count_owned_agents(text) from public, anon, authenticated;
