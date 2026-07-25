-- Agent Fighter — AGENT ARCADE v2 EXTRACTION PAYOUT (ADR 0008). Run AFTER 0016.
--
-- The arcade economy inverts here: wins stop paying credits entirely, and
-- ALL credits come from board pickups banked by reaching an exit alive.
-- This function is that bank.
--
-- Three things it has to get right, all of them money:
--
-- 1. IDEMPOTENCY. `_key` is the run token. A retried extract (dropped
--    response, PWA relaunch, double-tap) must pay exactly once — the
--    standard credit_ledger unique (profile_id, reason, match_id) guard,
--    with reason 'arcade_extract'. NOTE that reason is deliberately NOT
--    'fee': the 0003 escrow sweeper's ghost query looks for 'fee' rows with
--    no matches row, and an extraction has no match of its own.
--
-- 2. DIMINISHING RETURNS. A deep run pays ~30 credits for ~22 minutes, so
--    an uncapped faucet is a grind machine. Run 1 of the UTC day pays 100%,
--    then 75%, 50%, and 25% forever after. Counted off the ENTRY debits
--    (reason 'arcade', written by debit_credits from POST /arcade/enter) —
--    no new counter table, and it counts runs ENTERED rather than runs
--    survived so that dying does not reset the ladder.
--
-- 3. THE DRINK VALVE. A drink is worth ITEM_COST (5) credits, so unscaled
--    drink extraction would route straight around the credit multiplier.
--    This function does not grant drinks itself — it returns how many the
--    caller may still grant today (`drink_budget`), and the server grants
--    them through the existing buy_item path at cost 0 with a deterministic
--    'xtr:<token>:<i>' nonce (exactly the level-up free-pull pattern). The
--    count reads those same nonces back out of the ledger, so the cap is
--    durable across deploys rather than living in server memory.
--
-- (Mirrored in packages/server/src/persist.ts memoryPersistence
-- arcadeExtract — keep both in sync or the dev economy lies.)

create or replace function arcade_extract(
  _profile text, _key text, _credits integer
) returns table (credits integer, granted integer, multiplier_pct integer,
                 drink_budget integer, duplicate boolean)
language plpgsql security definer set search_path = public as $$
declare
  bal integer;
  runs_today integer;
  drinks_today integer;
  pct integer;
  pay integer;
  today date := (now() at time zone 'utc')::date;
begin
  -- Replay: this run already extracted → pay nothing, report the balance.
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

  -- Runs ENTERED today (the non-refundable 1-credit entries).
  select count(*) into runs_today from credit_ledger l
    where l.profile_id = _profile and l.reason = 'arcade'
      and (l.created_at at time zone 'utc')::date = today;

  pct := case
    when runs_today <= 1 then 100
    when runs_today = 2 then 75
    when runs_today = 3 then 50
    else 25
  end;

  -- Floor, never round: the house never rounds a payout up.
  pay := greatest(0, (greatest(0, _credits) * pct) / 100);

  if pay > 0 then
    insert into credit_ledger (profile_id, delta, reason, match_id)
    values (_profile, pay, 'arcade_extract', _key);
    update profiles p set credits = p.credits + pay, updated_at = now()
      where p.id = _profile returning p.credits into bal;
  else
    -- Still stamp the ledger so a zero-value extraction can't be replayed
    -- into a paying one later (e.g. after a support credit adjustment).
    insert into credit_ledger (profile_id, delta, reason, match_id)
    values (_profile, 0, 'arcade_extract', _key);
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
  -- The literal 3 mirrors ARCADE_DRINK_DAY_CAP in persist.ts, and the 100/75/
  -- 50/25 ladder above mirrors ARCADE_DR_PCT. SQL cannot import the TS
  -- constants, so these are the two numbers that MUST be changed in both
  -- places at once — the whole reason this file documents its twin.
  drink_budget := greatest(0, 3 - drinks_today);
  duplicate := false;
  return next;
end $$;

revoke execute on function arcade_extract from public, anon, authenticated;
