-- Agent Fighter — ELO RATINGS + SEASONS (ADR 0009, build step 1). Run AFTER 0020.
--
-- Adds the SKILL SPINE the seasonal leaderboard will rank on. Level/XP measure
-- playtime; credits and tickets measure economy. Neither is skill. Elo is.
--
-- WHAT IS RATED (v1, deliberately narrow):
--   a DECIDED WAGER match where BOTH sides are human hands.
-- Nothing else. Why each exclusion:
--  · arcade / solo  — the opponent is a PINNED AI (ADR 0008), not a rated
--    entity. Rating players against bots waits for the stable + defend-Elo
--    (ADR 0009 build steps 3-4), where the agent finally HAS a rating to
--    play against. Until then a bot win would inflate against nothing.
--  · friendly       — unranked by construction; never reaches record_match
--    (finishMatch guards `m.mode !== 'friendly'`).
--  · undecided / incomplete — nothing was decided, so nothing is learned.
--  · agent-involved — ADR 0009: "declared-agent matches touch the AGENT's
--    rating, never the owner's." The agent rating system does not exist yet,
--    so such a match is unrated for BOTH sides rather than half-applied.
--    Same two gates as the ticket mint in 0020 (`agent:%` sub AND the
--    `_pN_agent` connection flag), for the same reason: a coached-owner
--    headless runner plays as its owner's ordinary human profile, so the sub
--    check alone would let an owner rank up in their sleep.
--
-- TWO TRACKS (ADR 0009 — do not collapse them):
--  · `elo`        LIFETIME. Never resets. The honest all-time skill number.
--  · `season_elo` SEASONAL. Resets every season; this is what the prize
--    ladder ranks on. Season Elo plays in its own self-contained pool (both
--    sides start from ELO_BASE each season), so it is not a copy of lifetime.
-- Lifetime level/XP are untouched here and must STAY untouched: they drive
-- skillForLevel() (ADR 0006), the AIR reputation credential, and CPU
-- calibration. A seasonal reset of XP would floor every trained agent's
-- difficulty and overwrite LV38 credentials with LV1.
--
-- SEASON ROLLOVER IS LAZY. `current_season()` is arithmetic over a fixed
-- epoch — no cron, no ops, no season table to keep in sync. A profile's
-- season columns are re-based the first time it settles a match in a new
-- season. A player who skips a season simply has a stale `season` stamp and
-- does not appear on that season's ladder, which is exactly right.
--
-- APPLY ORDER — THIS ONE BITES (same as 0020). record_match's RETURN TYPE
-- changes, so it must DROP and recreate; a deployed older server calling the
-- old signature fails loudly at PostgREST rather than silently settling on
-- stale rules. NOT YET APPLIED: this must land in the same window as the
-- paired Railway + Vercel deploy that ships the matching server build.
-- (Reminder from 0017/ef753c8: after changing an RPC signature, reload
-- PostgREST's schema cache or the first callers get a 404.)
--
-- The `NULL = s` lesson from 0002 applies throughout: coalesce() every
-- comparison against the nullable `_deviator`.

-- ---------------------------------------------------------------- seasons

-- Season 1 opens 2026-07-27T00:00:00Z. 21 days is the ADR 0009 PLACEHOLDER —
-- the owner sets the real cadence before season 1 closes. Changing the length
-- later is a one-line migration, but note it re-numbers every future season,
-- so change it BEFORE a season boundary has ever been crossed in production.
create or replace function current_season()
returns smallint
language sql stable set search_path = public as $$
  select (1 + floor(
    extract(epoch from (now() - timestamptz '2026-07-27 00:00:00+00'))
    / (21 * 86400)
  ))::smallint;
$$;

-- ---------------------------------------------------------------- columns

-- ELO_BASE = 1200 (the classic anchor). `rated` counts only matches that
-- actually moved the rating, which is what the provisional K-factor and the
-- leaderboard's activity gate both key on — it is NOT wins+losses.
alter table profiles
  add column if not exists elo          integer  not null default 1200,
  add column if not exists rated        integer  not null default 0,
  add column if not exists season_elo   integer  not null default 1200,
  add column if not exists season_rated integer  not null default 0,
  add column if not exists season       smallint not null default 1;

-- ---------------------------------------------------------------- elo math

-- Standard Elo expectation. Float math is fine here: this is bookkeeping, not
-- the simulation — the determinism rules bind @af/core only (ADR 0001).
-- Rounding parity note: Postgres round() goes half-AWAY-from-zero while JS
-- Math.round() goes half-toward-+Infinity, so the persist.ts mirror could
-- differ by 1 point on an exact .5 — unreachable in practice (K is always
-- even and the expectation is irrational for every non-equal rating pair),
-- but that is the only known seam between the two implementations.
-- NOT named `elo_delta`: that is an OUT parameter name below, and plpgsql
-- would resolve the bare identifier to the variable instead of the function.
-- (Same class of trap as `tickets` in 0020 — be explicit, stay boring.)
create or replace function elo_shift(
  _mine integer, _theirs integer, _score numeric, _k integer
) returns integer
language sql immutable set search_path = public as $$
  select round(
    _k * (_score - 1.0 / (1.0 + power(10.0, (_theirs - _mine) / 400.0)))
  )::integer;
$$;

-- K-factor: fast convergence while provisional, calm at the top.
-- `_rated` is the count BEFORE this match.
create or replace function elo_k(_elo integer, _rated integer)
returns integer
language sql immutable set search_path = public as $$
  select case
    when coalesce(_rated, 0) < 10 then 40   -- provisional: find your level fast
    when coalesce(_elo, 1200) >= 2400 then 10
    else 20
  end;
$$;

revoke execute on function current_season from public, anon, authenticated;
revoke execute on function elo_shift    from public, anon, authenticated;
revoke execute on function elo_k        from public, anon, authenticated;

-- ---------------------------------------------------------------- record_match

drop function if exists record_match(
  text, text, integer, text, text, text, text, boolean, boolean,
  text, text, text, text, smallint, text, smallint, smallint,
  integer, bigint, smallint, text, integer
);

create function record_match(
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
                 credits_delta integer, credits integer,
                 ticket boolean, tickets integer,
                 elo integer, elo_delta integer,
                 season_elo integer, season_elo_delta integer)
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
  minted boolean;
  ticket_bal integer;
  prof profiles%rowtype;
  -- rating pre-pass
  cur smallint;
  is_rated boolean;
  sc0 numeric; sc1 numeric;          -- match scores (1 / 0.5 / 0)
  e0 integer; e1 integer;            -- lifetime ratings BEFORE the match
  n0 integer; n1 integer;            -- lifetime rated counts BEFORE
  se0 integer; se1 integer;          -- season ratings BEFORE
  sn0 integer; sn1 integer;          -- season rated counts BEFORE
  d0 integer; d1 integer;            -- lifetime deltas
  sd0 integer; sd1 integer;          -- season deltas
  my_d integer; my_sd integer;       -- this side's deltas, inside the loop
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

  -- SEASON ROLLOVER (lazy). Re-base anyone whose season stamp is stale BEFORE
  -- any rating is read, so a new season's first match cannot be scored against
  -- last season's numbers. Runs for every mode: a profile that only plays
  -- arcade still gets stamped into the current season with a base rating.
  -- `id in (_p0, _p1)` with a NULL side is safe — NULL never matches.
  cur := current_season();
  update profiles p
     set season_elo = 1200, season_rated = 0, season = cur, updated_at = now()
   where p.id in (_p0, _p1) and p.season <> cur;

  -- RATING PRE-PASS. Both ratings must be read BEFORE either is written —
  -- settling side 0 first and then reading side 1 would score the second
  -- player against an already-updated opponent, quietly breaking the
  -- zero-sum property that makes Elo a closed system.
  is_rated := _mode = 'wager' and not undecided
    and _p0 is not null and _p1 is not null
    and _p0 not like 'agent:%' and _p1 not like 'agent:%'
    and not coalesce(_p0_agent, false) and not coalesce(_p1_agent, false);

  d0 := 0; d1 := 0; sd0 := 0; sd1 := 0;

  if is_rated then
    -- A deviator can never win a settlement (ADR 0003/0005), so it takes the
    -- rating loss and its opponent takes the win — matching `won` below.
    if coalesce(_deviator = 0, false) then      sc0 := 0;   sc1 := 1;
    elsif coalesce(_deviator = 1, false) then   sc0 := 1;   sc1 := 0;
    elsif _winner = 2 then                      sc0 := 0.5; sc1 := 0.5;
    elsif _winner = 0 then                      sc0 := 1;   sc1 := 0;
    elsif _winner = 1 then                      sc0 := 0;   sc1 := 1;
    else is_rated := false;  -- unknown winner code: refuse to guess
    end if;
  end if;

  if is_rated then
    select p.elo, p.rated, p.season_elo, p.season_rated
      into e0, n0, se0, sn0 from profiles p where p.id = _p0;
    select p.elo, p.rated, p.season_elo, p.season_rated
      into e1, n1, se1, sn1 from profiles p where p.id = _p1;

    d0  := elo_shift(e0,  e1,  sc0, elo_k(e0,  n0));
    d1  := elo_shift(e1,  e0,  sc1, elo_k(e1,  n1));
    -- The season pool is scored against SEASON ratings, not lifetime ones —
    -- otherwise a fresh season would just re-derive the lifetime ladder.
    sd0 := elo_shift(se0, se1, sc0, elo_k(se0, sn0));
    sd1 := elo_shift(se1, se0, sc1, elo_k(se1, sn1));
  end if;

  foreach s in array array[0::smallint, 1::smallint] loop
    pid := case when s = 0 then _p0 else _p1 end;
    if pid is null then continue; end if;

    i_deviated   := coalesce(_deviator = s, false);
    opp_deviated := coalesce(_deviator = 1 - s, false);
    won  := (not i_deviated) and (not undecided)
            and (_winner = s or opp_deviated);
    draw := (not undecided) and (not won) and _winner = 2 and not i_deviated;
    lost := (not undecided) and (not won) and (not draw);
    minted := false;
    my_d  := case when s = 0 then d0 else d1 end;
    my_sd := case when s = 0 then sd0 else sd1 end;

    if undecided then
      payout := _fee; xp_delta := 0;
    elsif _mode = 'wager' then
      -- THE BURN: a decided wager returns NOTHING to either side. Only a draw
      -- (nothing decided) hands the entry back.
      payout := case when draw then _fee else 0 end;
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

    -- THE MINT. Guarded by `won`, which already excludes deviators, draws and
    -- no-contests. Agent-class stays inert. The unique(match_id) makes a
    -- second ticket structurally impossible even if this ever ran twice.
    -- HUMAN HANDS ONLY. Two independent gates, because they close different
    -- holes:
    --   · `agent:%`      — the inert account CLASS (a fleet/house bot).
    --   · `_pN_agent`    — the CONNECTION declared itself an agent. This is
    --     the one that matters: a coached-owner headless runner
    --     (AF_AGENT_KEY) plays as its owner's ordinary human profile, so the
    --     sub check alone would let an owner farm tickets in their sleep.
    --     Agent-key auth forces agent=true server-side, and the browser never
    --     sets it.
    -- coalesce() because `NULL and …` is NULL, not false (the 0002 lesson).
    --
    -- NOTE the schema qualification on every `tickets` reference in this
    -- function: `tickets` is also an OUT parameter name, and leaving it bare
    -- invites a plpgsql name-resolution surprise. Be explicit.
    if _mode = 'wager' and won and pid not like 'agent:%'
       and not coalesce(case when s = 0 then _p0_agent else _p1_agent end, false)
    then
      insert into public.tickets (profile_id, match_id)
      values (pid, _id)
      on conflict (match_id) do nothing;
      get diagnostics minted = row_count;
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

    -- Ratings ride the SAME update as XP/W-L: one write per side, and the
    -- deltas are 0 for every unrated mode so this stays a no-op there.
    -- greatest(100, …) floors the rating — a long losing run should park a
    -- player at the bottom of the ladder, never send them negative.
    update profiles p
      set xp = greatest(0, p.xp + xp_delta),
          wins = p.wins + case when won then 1 else 0 end,
          losses = p.losses + case when lost then 1 else 0 end,
          elo = greatest(100, p.elo + my_d),
          rated = p.rated + case when is_rated then 1 else 0 end,
          season_elo = greatest(100, p.season_elo + my_sd),
          season_rated = p.season_rated + case when is_rated then 1 else 0 end,
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

    select count(*)::integer into ticket_bal
      from public.tickets t where t.profile_id = pid and t.redeemed_at is null;

    side := s; gained := xp_delta; levels_up := ups;
    level := prof.level; xp := prof.xp; wins := prof.wins; losses := prof.losses;
    credits_delta := payout - _fee; credits := prof.credits;
    ticket := minted; tickets := ticket_bal;
    elo := prof.elo; elo_delta := my_d;
    season_elo := prof.season_elo; season_elo_delta := my_sd;
    return next;
  end loop;
end $$;

revoke execute on function record_match from public, anon, authenticated;
