-- Agent Fighter — trained agents + durable agent keys (ADR 0006).
--
--   · agent_config: the coached strategy blob {character, personality, motto}.
--     Style only — the server CLAMPS personality to core AI_PERSONALITY_RANGES
--     before it ever reaches this column, and skill/stats are never stored:
--     skill is always re-derived from the owner's level at match time.
--   · agent_key_hash: sha256 (hex) of the durable agent key (ADR 0003 Phase
--     B "agent tokens"). The plaintext key is shown once at mint and never
--     stored. Possession of the key = coach/agent authority for the profile
--     (config read/write, agent queueing) — NOT credit spending beyond match
--     fees, and never account deletion/transfer.
--   · All writes stay service-role-only (same trust model as every RPC here:
--     the match server is the sole writer; RLS gives the world SELECT on
--     profiles, and agent_key_hash must NEVER ride a public view).

alter table profiles
  add column if not exists agent_config jsonb,
  add column if not exists agent_key_hash text,
  add column if not exists agent_key_created_at timestamptz;

create unique index if not exists profiles_agent_key_hash_key
  on profiles (agent_key_hash) where agent_key_hash is not null;

-- Rotate (or revoke with null) the agent key. Profile must already exist —
-- keys are minted from a signed-in session, which upserted the profile.
create or replace function set_agent_key(_id text, _hash text) returns boolean
language plpgsql security definer set search_path = public as $$
declare updated boolean;
begin
  update profiles
    set agent_key_hash = _hash,
        agent_key_created_at = case when _hash is null then null else now() end,
        updated_at = now()
    where id = _id;
  get diagnostics updated = row_count;
  return updated;
end $$;

create or replace function set_agent_config(_id text, _config jsonb) returns boolean
language plpgsql security definer set search_path = public as $$
declare updated boolean;
begin
  update profiles
    set agent_config = _config, updated_at = now()
    where id = _id;
  get diagnostics updated = row_count;
  return updated;
end $$;

create or replace function get_agent(_id text)
returns table (config jsonb, key_created_at timestamptz,
               name text, level integer, xp integer,
               wins integer, losses integer)
language sql security definer set search_path = public as $$
  select p.agent_config, p.agent_key_created_at,
         p.name, p.level, p.xp, p.wins, p.losses
  from profiles p where p.id = _id
$$;

-- Key → profile. The hash is the credential; only the service role may ask.
create or replace function find_by_agent_key(_hash text)
returns table (id text, name text)
language sql security definer set search_path = public as $$
  select p.id, p.name from profiles p
  where p.agent_key_hash = _hash and _hash is not null
$$;

revoke execute on function set_agent_key   from public, anon, authenticated;
revoke execute on function set_agent_config from public, anon, authenticated;
revoke execute on function get_agent        from public, anon, authenticated;
revoke execute on function find_by_agent_key from public, anon, authenticated;
