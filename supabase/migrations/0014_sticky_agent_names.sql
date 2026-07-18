-- Agent Fighter — sticky display names for agent-class accounts.
--
-- Bug: record_match upserted profiles.name from the match participant label
-- (hello.name). A stale fleet-agents.json reconnecting as "IRONCLAD" then
-- overwrote unique renames, so the AGENTS leaderboard showed duplicate
-- display names for different agent:<uuid> rows.
--
-- Fix: once an agent:* profile exists, keep its name; only humans (and
-- first insert) take the match-provided label. Signup remains the place
-- agent names are minted (create_agent_account).

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
  _engine text,
  _payout integer default 0
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
    on conflict (id) do update set
      name = case
        when profiles.id like 'agent:%' then profiles.name
        else excluded.name
      end,
      updated_at = now();
  end if;
  if _p1 is not null then
    insert into profiles (id, name, is_agent, address)
    values (_p1, _p1_name, _p1_agent, _p1_address)
    on conflict (id) do update set
      name = case
        when profiles.id like 'agent:%' then profiles.name
        else excluded.name
      end,
      updated_at = now();
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

    i_deviated   := coalesce(_deviator = s, false);
    opp_deviated := coalesce(_deviator = 1 - s, false);
    won  := (not i_deviated) and (not undecided)
            and (_winner = s or opp_deviated);
    draw := (not undecided) and (not won) and _winner = 2 and not i_deviated;
    lost := (not undecided) and (not won) and (not draw);

    if undecided then
      payout := _fee; xp_delta := 0;
    elsif _mode = 'wager' then
      payout := case when won then _fee * 2 when draw then _fee else 0 end;
      xp_delta := case when i_deviated then 0
                       when won then 60 when draw then 30 else 20 end;
    elsif _mode = 'arcade' then
      payout := case when won then coalesce(_payout, 0)
                     when draw then _fee else 0 end;
      xp_delta := case when i_deviated then 0
                       when won then 60 when draw then 0 else -15 end;
    else
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

revoke execute on function record_match from public, anon, authenticated;
