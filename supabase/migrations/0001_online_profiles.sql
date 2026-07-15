-- Agent Fighter — online profiles, match history, XP (ADR 0003, Phase B).
--
-- Run this in the Supabase SQL editor (or `supabase db push`). Design rules:
--   · ALL writes go through the match server with the service-role key.
--     RLS allows public SELECT only — there is no client write path at all,
--     so a hacked client cannot touch progression (input-authority model).
--   · record_match() is ATOMIC and IDEMPOTENT BY MATCH ID: the INSERT into
--     matches is the guard — a retry (server restart, double callback)
--     conflicts on the primary key and awards nothing the second time.
--   · XP math mirrors packages/client/src/progress.ts exactly:
--     win 60 / loss 20 / draw 30, xp_for_next(level) = 80 + level*45, cap 40.
--     (Damage/combo bonuses stay client-local flavor for offline play; the
--     server awards the flat, unfakeable part.)

create table if not exists profiles (
  id         text primary key,            -- AIR user UUID (JWT `sub`)
  address    text,                        -- AIR smart-account address
  name       text not null default 'anon',
  is_agent   boolean not null default false,
  xp         integer not null default 0,
  level      integer not null default 1,
  wins       integer not null default 0,
  losses     integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists matches (
  id         text primary key,            -- server match id — the idempotency key
  p0         text references profiles(id),-- null = anonymous player
  p1         text references profiles(id),
  p0_name    text not null,
  p1_name    text not null,
  p0_agent   boolean not null default false,
  p1_agent   boolean not null default false,
  p0_char    text not null default '',
  p1_char    text not null default '',
  winner     smallint not null,           -- -1 undecided, 0/1 side, 2 draw
  reason     text not null,               -- verified | forfeit | incomplete
  rounds0    smallint not null default 0,
  rounds1    smallint not null default 0,
  end_tick   integer not null default 0,
  state_hash bigint not null default 0,   -- server re-sim hash (unsigned 32-bit)
  deviator   smallint,                    -- desync forensics: side that diverged
  engine     text not null default '',
  created_at timestamptz not null default now()
);

create index if not exists matches_p0_idx on matches (p0, created_at desc);
create index if not exists matches_p1_idx on matches (p1, created_at desc);

-- Public leaderboard (Phase C UI reads this as-is).
create or replace view leaderboard as
  select id, name, is_agent, level, xp, wins, losses,
         rank() over (order by level desc, xp desc, wins desc) as rank
  from profiles
  where wins + losses > 0
  order by rank
  limit 100;

-- RLS: world-readable, service-role-writable (service role bypasses RLS).
alter table profiles enable row level security;
alter table matches  enable row level security;
drop policy if exists "public read profiles" on profiles;
create policy "public read profiles" on profiles for select using (true);
drop policy if exists "public read matches" on matches;
create policy "public read matches" on matches for select using (true);

create or replace function xp_for_next(lvl integer) returns integer
language sql immutable as $$ select 80 + lvl * 45 $$;

-- Record a verified match and award XP/W-L — atomically, once.
-- Returns one row per AUTHENTICATED side with the post-award profile
-- (the server relays it to the player as the in-game XP banner).
create or replace function record_match(
  _id text,
  _p0 text, _p1 text,                    -- profile ids or null (anonymous)
  _p0_name text, _p1_name text,
  _p0_agent boolean, _p1_agent boolean,
  _p0_char text, _p1_char text,
  _p0_address text, _p1_address text,
  _winner smallint, _reason text,
  _rounds0 smallint, _rounds1 smallint,
  _end_tick integer, _state_hash bigint, _deviator smallint,
  _engine text
) returns table (side smallint, gained integer, levels_up integer,
                 level integer, xp integer, wins integer, losses integer)
language plpgsql security definer set search_path = public as $$
declare
  inserted boolean;
  s smallint;
  pid text;
  won boolean;
  lost boolean;
  gain integer;
  ups integer;
  prof profiles%rowtype;
begin
  -- Profiles must exist before the matches FK; harmless on repeat calls.
  if _p0 is not null then
    insert into profiles (id, name, is_agent, address)
    values (_p0, _p0_name, _p0_agent, _p0_address)
    on conflict (id) do update
      set name = excluded.name, is_agent = excluded.is_agent,
          address = coalesce(excluded.address, profiles.address),
          updated_at = now();
  end if;
  if _p1 is not null then
    insert into profiles (id, name, is_agent, address)
    values (_p1, _p1_name, _p1_agent, _p1_address)
    on conflict (id) do update
      set name = excluded.name, is_agent = excluded.is_agent,
          address = coalesce(excluded.address, profiles.address),
          updated_at = now();
  end if;

  -- THE idempotency guard: first insert wins, retries award nothing.
  insert into matches (id, p0, p1, p0_name, p1_name, p0_agent, p1_agent,
                       p0_char, p1_char, winner, reason, rounds0, rounds1,
                       end_tick, state_hash, deviator, engine)
  values (_id, _p0, _p1, _p0_name, _p1_name, _p0_agent, _p1_agent,
          _p0_char, _p1_char, _winner, _reason, _rounds0, _rounds1,
          _end_tick, _state_hash, _deviator, _engine)
  on conflict (id) do nothing;
  get diagnostics inserted = row_count;
  if not inserted then return; end if;

  -- Only decided, server-verified outcomes progress accounts. A deviating
  -- (cheating/desynced) side forfeits its award; its opponent still gets one.
  if _winner < 0 or _reason = 'incomplete' then return; end if;

  foreach s in array array[0::smallint, 1::smallint] loop
    pid := case when s = 0 then _p0 else _p1 end;
    if pid is null or _deviator = s then continue; end if;
    won  := _winner = s;
    lost := _winner = 1 - s;
    gain := case when won then 60 when lost then 20 else 30 end;
    update profiles p
      set xp = p.xp + gain,
          wins = p.wins + case when won then 1 else 0 end,
          losses = p.losses + case when lost then 1 else 0 end,
          updated_at = now()
      where p.id = pid
      returning * into prof;
    ups := 0;
    while prof.level < 40 and prof.xp >= xp_for_next(prof.level) loop
      prof.xp := prof.xp - xp_for_next(prof.level);
      prof.level := prof.level + 1;
      ups := ups + 1;
    end loop;
    if ups > 0 then
      update profiles p set xp = prof.xp, level = prof.level, updated_at = now()
        where p.id = pid;
    end if;
    side := s; gained := gain; levels_up := ups;
    level := prof.level; xp := prof.xp; wins := prof.wins; losses := prof.losses;
    return next;
  end loop;
end $$;

-- The service role calls this via PostgREST; nobody else can.
revoke execute on function record_match from public, anon, authenticated;
