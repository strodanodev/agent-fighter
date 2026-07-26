-- Agent Fighter — ARCADE v2 payout RETUNE (ADR 0008). Run AFTER 0017.
--
-- 0017 shipped and was wrong in three ways that only showed up under real
-- play. On day one a live player took 8 entries and 3 extractions — including
-- a 10-fight run to the DEEP exit — and banked a net of ZERO credits:
--
--   1. The multiplier taxed the EXIT BONUS as well as the loot. The bonus is
--      the guaranteed reward for surviving the run; tapering it punished the
--      achievement instead of the farming. A deep clear paid 8 CR.
--   2. The ladder counted ENTRIES. The intent was "dying must not reset the
--      ladder"; the effect was that dying and abandoning BURNED it, so the
--      player was taxed for losing. A wipe already forfeits the whole bag —
--      that is deterrent enough on its own.
--   3. It bottomed out on the 4th run of the day. A run is 6-22 minutes, so a
--      single evening pinned the account at the floor permanently.
--
-- The fix, in one line each:
--   · the taper applies to LOOT ONLY, never to the bonus;
--   · it counts EXTRACTIONS (successful banks), not entries;
--   · three full-rate extractions per UTC day before anything bites, then
--     80/65/50 with a 50% floor — half rate, not a quarter;
--   · and a successful extraction NEVER pays literally zero.
--
-- The argument list changes (loot and bonus are now separate), so the old
-- 3-arg signature is dropped rather than overloaded — an accidental overload
-- would let a stale caller keep the broken behaviour alive silently.
--
-- (Mirrored in packages/server/src/persist.ts memoryPersistence arcadeExtract
-- + ARCADE_DR_PCT — keep both in sync or the dev economy lies.)

drop function if exists arcade_extract(text, text, integer);

create or replace function arcade_extract(
  _profile text, _key text, _loot integer, _bonus integer
) returns table (credits integer, granted integer, multiplier_pct integer,
                 drink_budget integer, duplicate boolean)
language plpgsql security definer set search_path = public as $$
declare
  bal integer;
  banks_today integer;
  drinks_today integer;
  pct integer;
  pay integer;
  safe_loot integer := greatest(0, coalesce(_loot, 0));
  safe_bonus integer := greatest(0, coalesce(_bonus, 0));
  today date := (now() at time zone 'utc')::date;
begin
  -- Replay: this run already extracted -> pay nothing, report the balance.
  if exists (
    select 1 from credit_ledger l
    where l.profile_id = _profile and l.reason = 'arcade_extract' and l.match_id = _key
  ) then
    select p.credits into bal from profiles p where p.id = _profile;
    credits := coalesce(bal, 0); granted := 0; multiplier_pct := 0;
    drink_budget := 0; duplicate := true;
    return next; return;
  end if;

  select p.credits into bal from profiles p where p.id = _profile for update;
  if bal is null then raise exception 'NO_PROFILE'; end if;

  -- EXTRACTIONS banked today (not entries) — this one is the (banks_today+1)th.
  select count(*) into banks_today from credit_ledger l
    where l.profile_id = _profile and l.reason = 'arcade_extract'
      and (l.created_at at time zone 'utc')::date = today;

  pct := case
    when banks_today <= 2 then 100  -- extractions 1-3 of the day
    when banks_today = 3 then 80    -- 4th
    when banks_today = 4 then 65    -- 5th
    else 50                         -- 6th onward, floor
  end;

  -- Taper the LOOT, floor it (the house never rounds a payout up), then add
  -- the exit bonus WHOLE. A successful extraction never comes back as zero.
  pay := (safe_loot * pct) / 100 + safe_bonus;
  if pay < 1 and safe_loot + safe_bonus > 0 then pay := 1; end if;

  insert into credit_ledger (profile_id, delta, reason, match_id)
  values (_profile, pay, 'arcade_extract', _key);
  if pay > 0 then
    update profiles p set credits = p.credits + pay, updated_at = now()
      where p.id = _profile returning p.credits into bal;
  end if;

  -- Drinks already extracted today, counted via the buy_item nonces the
  -- server uses for board drinks ('xtr:<run token>:<index>').
  select count(*) into drinks_today from credit_ledger l
    where l.profile_id = _profile and l.reason = 'gacha'
      and l.match_id like 'xtr:%'
      and (l.created_at at time zone 'utc')::date = today;

  credits := bal;
  granted := pay;
  multiplier_pct := pct;
  -- The literal 3 mirrors ARCADE_DRINK_DAY_CAP in persist.ts; the
  -- 100/100/100/80/65/50 ladder above mirrors ARCADE_DR_PCT. SQL cannot
  -- import the TS constants — change both or the dev economy lies.
  drink_budget := greatest(0, 3 - drinks_today);
  duplicate := false;
  return next;
end $$;

revoke execute on function arcade_extract from public, anon, authenticated;
