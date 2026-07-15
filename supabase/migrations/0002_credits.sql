-- Agent Fighter — CREDITS economy (M5). Run AFTER 0001_online_profiles.sql.
--
-- Rules (mirrored in packages/server/src/persist.ts memoryPersistence — keep
-- both in sync or the dev economy lies about production):
--   daily login bonus  +10 once per UTC day (idempotent by (profile, day))
--   solo  (vs house agent)  fee 1  → win: +2 back (net +1), +60 XP
--                                    loss: fee burned, −15 XP (no de-level)
--                                    draw/incomplete: refund
--   wager (online)          fee 10 → winner takes the 20 pot (net +10)
--                                    draw/undecided/incomplete: refund both
--                                    deviator forfeits the pot to the opponent
--   XP (wager): win 60 / loss 20 / draw 30
--
-- Everything is service-role-only; RLS keeps clients read-only. The credit
-- ledger is append-only and every mutation writes a row — full audit trail.

alter table profiles add column if not exists credits integer not null default 0;
alter table profiles add column if not exists last_daily date;

create table if not exists credit_ledger (
  id         bigint generated always as identity primary key,
  profile_id text not null references profiles(id),
  delta      integer not null,
  reason     text not null,       -- daily | fee | payout | refund
  match_id   text,                -- null for daily
  created_at timestamptz not null default now(),
  -- Idempotency guards: one daily per day, one fee/payout/refund per match.
  unique (profile_id, reason, match_id)
);
create index if not exists credit_ledger_profile_idx on credit_ledger (profile_id, created_at desc);

alter table credit_ledger enable row level security;
drop policy if exists "public read ledger" on credit_ledger;
create policy "public read ledger" on credit_ledger for select using (true);

alter table matches add column if not exists mode text not null default 'wager';
alter table matches add column if not exists fee integer not null default 0;

-- ---------------------------------------------------------------- get_account
-- Upsert the profile, grant the daily bonus if due, return the account.
create or replace function get_account(
  _id text, _name text, _agent boolean, _address text
) returns table (credits integer, level integer, xp integer,
                 wins integer, losses integer, daily_granted boolean)
language plpgsql security definer set search_path = public as $$
declare
  prof profiles%rowtype;
  granted boolean := false;
begin
  insert into profiles (id, name, is_agent, address)
  values (_id, _name, _agent, _address)
  on conflict (id) do update
    set name = excluded.name, is_agent = excluded.is_agent,
        address = coalesce(excluded.address, profiles.address),
        updated_at = now();

  select * into prof from profiles p where p.id = _id for update;
  if prof.last_daily is distinct from (now() at time zone 'utc')::date then
    -- The ledger row is the idempotency guard (unique per profile/day reason).
    begin
      insert into credit_ledger (profile_id, delta, reason, match_id)
      values (_id, 10, 'daily', to_char((now() at time zone 'utc')::date, 'YYYY-MM-DD'));
      update profiles p set credits = p.credits + 10,
        last_daily = (now() at time zone 'utc')::date, updated_at = now()
        where p.id = _id returning * into prof;
      granted := true;
    exception when unique_violation then
      granted := false;
    end;
  end if;

  credits := prof.credits; level := prof.level; xp := prof.xp;
  wins := prof.wins; losses := prof.losses; daily_granted := granted;
  return next;
end $$;

-- --------------------------------------------------------------- escrow_match
-- Charge the fee to every authenticated side, atomically (all or none).
-- Raises 'INSUFFICIENT:<side>' when a side can't cover it.
create or replace function escrow_match(
  _match text, _p0 text, _p1 text, _fee integer
) returns void
language plpgsql security definer set search_path = public as $$
declare
  s integer;
  pid text;
  bal integer;
begin
  for s in 0..1 loop
    pid := case when s = 0 then _p0 else _p1 end;
    if pid is null then continue; end if;
    -- Skip sides already escrowed for this match (retry safety).
    if exists (select 1 from credit_ledger
               where profile_id = pid and reason = 'fee' and match_id = _match) then
      continue;
    end if;
    select credits into bal from profiles where id = pid for update;
    if bal is null or bal < _fee then
      raise exception 'INSUFFICIENT:%', s;
    end if;
  end loop;
  for s in 0..1 loop
    pid := case when s = 0 then _p0 else _p1 end;
    if pid is null then continue; end if;
    begin
      insert into credit_ledger (profile_id, delta, reason, match_id)
      values (pid, -_fee, 'fee', _match);
      update profiles p set credits = p.credits - _fee, updated_at = now()
        where p.id = pid;
    exception when unique_violation then
      null; -- already escrowed (retry)
    end;
  end loop;
end $$;

-- --------------------------------------------------------------- record_match
-- v2: settle credits (pot / solo payout / refunds) + XP in one atomic,
-- idempotent-by-match-id transaction. Replaces the Phase B signature.
drop function if exists record_match(text, text, text, text, text, boolean, boolean,
  text, text, text, text, smallint, text, smallint, smallint, integer, bigint, smallint, text);

create or replace function record_match(
  _id text, _mode text, _fee integer,
  _p0 text, _p1 text,
  _p0_name text, _p1_name text,
  _p0_agent boolean, _p1_agent boolean,
  _p0_char text, _p1_char text,
  _p0_address text, _p1_address text,
  _winner smallint, _reason text,
  _rounds0 smallint, _rounds1 smallint,
  _end_tick integer, _state_hash bigint, _deviator smallint,
  _engine text
) returns table (side smallint, gained integer, levels_up integer,
                 level integer, xp integer, wins integer, losses integer,
                 credits_delta integer, credits integer)
language plpgsql security definer set search_path = public as $$
declare
  inserted boolean;
  s smallint;
  pid text;
  undecided boolean;
  i_deviated boolean;
  opp_deviated boolean;
  won boolean;
  lost boolean;
  draw boolean;
  payout integer;
  xp_delta integer;
  ups integer;
  prof profiles%rowtype;
begin
  if _p0 is not null then
    insert into profiles (id, name, is_agent, address)
    values (_p0, _p0_name, _p0_agent, _p0_address)
    on conflict (id) do update set name = excluded.name, updated_at = now();
  end if;
  if _p1 is not null then
    insert into profiles (id, name, is_agent, address)
    values (_p1, _p1_name, _p1_agent, _p1_address)
    on conflict (id) do update set name = excluded.name, updated_at = now();
  end if;

  insert into matches (id, mode, fee, p0, p1, p0_name, p1_name, p0_agent, p1_agent,
                       p0_char, p1_char, winner, reason, rounds0, rounds1,
                       end_tick, state_hash, deviator, engine)
  values (_id, _mode, _fee, _p0, _p1, _p0_name, _p1_name, _p0_agent, _p1_agent,
          _p0_char, _p1_char, _winner, _reason, _rounds0, _rounds1,
          _end_tick, _state_hash, _deviator, _engine)
  on conflict (id) do nothing;
  get diagnostics inserted = row_count;
  if not inserted then return; end if;

  undecided := _winner < 0 or _reason = 'incomplete';

  foreach s in array array[0::smallint, 1::smallint] loop
    pid := case when s = 0 then _p0 else _p1 end;
    if pid is null then continue; end if;

    i_deviated   := _deviator = s;
    opp_deviated := _deviator = 1 - s;
    won  := (not i_deviated) and (not undecided)
            and (_winner = s or opp_deviated);
    draw := (not undecided) and (not won) and _winner = 2 and not i_deviated;
    lost := (not undecided) and (not won) and (not draw);

    if undecided then
      payout := _fee; xp_delta := 0;                      -- refund
    elsif _mode = 'wager' then
      payout := case when won then _fee * 2 when draw then _fee else 0 end;
      xp_delta := case when i_deviated then 0
                       when won then 60 when draw then 30 else 20 end;
    else                                                  -- solo (vs house)
      payout := case when won then _fee + 1 when draw then _fee else 0 end;
      xp_delta := case when i_deviated then 0
                       when won then 60 when draw then 0 else -15 end;
    end if;

    if payout <> 0 then
      begin
        insert into credit_ledger (profile_id, delta, reason, match_id)
        values (pid, payout, case when undecided then 'refund' else 'payout' end, _id);
        update profiles p set credits = p.credits + payout, updated_at = now()
          where p.id = pid;
      exception when unique_violation then
        null;
      end;
    end if;

    update profiles p
      set xp = greatest(0, p.xp + xp_delta),
          wins = p.wins + case when won then 1 else 0 end,
          losses = p.losses + case when lost then 1 else 0 end,
          updated_at = now()
      where p.id = pid
      returning * into prof;

    ups := 0;
    if xp_delta > 0 then
      while prof.level < 40 and prof.xp >= xp_for_next(prof.level) loop
        prof.xp := prof.xp - xp_for_next(prof.level);
        prof.level := prof.level + 1;
        ups := ups + 1;
      end loop;
      if ups > 0 then
        update profiles p set xp = prof.xp, level = prof.level, updated_at = now()
          where p.id = pid;
      end if;
    end if;

    side := s; gained := xp_delta; levels_up := ups;
    level := prof.level; xp := prof.xp; wins := prof.wins; losses := prof.losses;
    credits_delta := payout - _fee; credits := prof.credits;
    return next;
  end loop;
end $$;

revoke execute on function get_account   from public, anon, authenticated;
revoke execute on function escrow_match  from public, anon, authenticated;
revoke execute on function record_match  from public, anon, authenticated;
