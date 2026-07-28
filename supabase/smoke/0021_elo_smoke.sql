-- SMOKE TEST for 0021_elo.sql — run in the Supabase SQL editor.
--
-- STATUS: RAN AGAINST PROD 2026-07-27 (owner-authorized, via MCP) — ALL FIVE
-- CHECKS PASSED and the cleanup left zero rows (34 real profiles untouched).
-- Highlight: the deviator case settled 1220→1198 / 1180→1202 with the
-- ticket minted by the deviator's OPPONENT — the one case a TS mirror
-- cannot prove. Kept as a reusable regression script: re-run after ANY
-- future record_match change.
--
-- WHY THIS EXISTS AS A FILE: the house rule from 0002 is "always smoke-test
-- SQL on real Postgres" — a TypeScript mirror cannot catch a SQL-only bug
-- (that lesson cost a settlement where `NULL = s` made BOTH sides losers).
-- It writes, so it needs an explicitly authorized run.
--
-- It is SELF-CLEANING: every row it creates is removed by the final block,
-- and every id is namespaced `smoke:elo:*` / `smoke-elo-*` so the cleanup
-- cannot touch a real player. Run the whole file top to bottom.
--
-- EXPECTED RESULTS are asserted inline — each check raises an exception if
-- the value is wrong, so a clean run means every claim held.

do $$
declare
  r record;
  a_elo integer; b_elo integer;
  a_rated integer;
begin
  -- 1. A DECIDED HUMAN-VS-HUMAN WAGER: zero-sum ±20 from equal bases.
  perform record_match(
    'smoke-elo-1','wager',10,
    'smoke:elo:a','smoke:elo:b','SMOKEA','SMOKEB',false,false,
    'analog','vector',null,null,
    0::smallint,'verified',2::smallint,0::smallint,
    3000,1::bigint,null,'af-core-7',0);

  select elo, rated into a_elo, a_rated from profiles where id = 'smoke:elo:a';
  select elo into b_elo from profiles where id = 'smoke:elo:b';
  if a_elo <> 1220 then raise exception 'winner elo: expected 1220, got %', a_elo; end if;
  if b_elo <> 1180 then raise exception 'loser elo: expected 1180, got %', b_elo; end if;
  if (a_elo - 1200) + (b_elo - 1200) <> 0 then raise exception 'NOT zero-sum'; end if;
  if a_rated <> 1 then raise exception 'rated: expected 1, got %', a_rated; end if;
  raise notice 'OK 1: decided wager rates zero-sum (1220 / 1180)';

  -- The ticket must still mint (0020 regression check).
  if not exists (select 1 from tickets where match_id = 'smoke-elo-1'
                   and profile_id = 'smoke:elo:a') then
    raise exception 'winner did not mint a ticket';
  end if;
  -- And a decided wager must leave ZERO payout rows (the burn).
  if exists (select 1 from credit_ledger
              where match_id = 'smoke-elo-1' and reason = 'payout') then
    raise exception 'a decided wager paid out — the burn is broken';
  end if;
  raise notice 'OK 2: ticket minted, pot burned (no payout rows)';

  -- 3. ARCADE must not move a rating.
  perform record_match(
    'smoke-elo-2','arcade',0,
    'smoke:elo:a',null,'SMOKEA','HOUSE',false,false,
    'analog','vector',null,null,
    0::smallint,'verified',2::smallint,0::smallint,
    3000,1::bigint,null,'af-core-7',0);
  select elo, rated into a_elo, a_rated from profiles where id = 'smoke:elo:a';
  if a_elo <> 1220 then raise exception 'arcade moved a rating to %', a_elo; end if;
  if a_rated <> 1 then raise exception 'arcade advanced `rated` to %', a_rated; end if;
  raise notice 'OK 3: arcade is unrated (elo and rated both unchanged)';

  -- 4. A DECLARED AGENT makes the wager unrated for BOTH sides.
  perform record_match(
    'smoke-elo-3','wager',10,
    'smoke:elo:a','smoke:elo:b','SMOKEA','SMOKEB',true,false,
    'analog','vector',null,null,
    0::smallint,'verified',2::smallint,0::smallint,
    3000,1::bigint,null,'af-core-7',0);
  select elo into a_elo from profiles where id = 'smoke:elo:a';
  select elo into b_elo from profiles where id = 'smoke:elo:b';
  if a_elo <> 1220 or b_elo <> 1180 then
    raise exception 'an agent-involved wager moved a rating (% / %)', a_elo, b_elo;
  end if;
  raise notice 'OK 4: agent-involved wager is unrated for both sides';

  -- 5. THE DEVIATOR takes the loss even though the sim says it won.
  perform record_match(
    'smoke-elo-4','wager',10,
    'smoke:elo:a','smoke:elo:b','SMOKEA','SMOKEB',false,false,
    'analog','vector',null,null,
    0::smallint,'verified',2::smallint,0::smallint,
    3000,1::bigint,0::smallint,'af-core-7',0);
  select elo into a_elo from profiles where id = 'smoke:elo:a';
  if a_elo >= 1220 then
    raise exception 'the deviator GAINED rating (now %) — desync would farm rank', a_elo;
  end if;
  raise notice 'OK 5: deviator took the rating loss (now %)', a_elo;

  raise notice 'ALL CHECKS PASSED';
end $$;

-- Inspect before cleaning, if you want to eyeball it.
select id, elo, rated, season_elo, season_rated, season, wins, losses
  from profiles where id like 'smoke:elo:%' order by id;

-- CLEANUP — child rows first (FKs point at profiles).
delete from tickets       where match_id like 'smoke-elo-%';
delete from credit_ledger where match_id like 'smoke-elo-%';
delete from matches       where id       like 'smoke-elo-%';
delete from profiles      where id       like 'smoke:elo:%';

-- Must return zero rows.
select count(*) as leftover_profiles from profiles where id like 'smoke:elo:%';
