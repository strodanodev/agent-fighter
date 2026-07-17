-- Agent Fighter — REFERRAL STATS for the in-game invite screen. Run AFTER 0005.
--
-- get_account v4: also returns the caller's INVITER-side dare stats so the
-- game can render the bounty counter without a second endpoint:
--   dares_accepted   friends who ever redeemed this player's code
--   dares_paid_week  inviter payouts credited in the rolling 7-day window
--                    (release_referral caps these at 10 — surfacing the
--                    count lets the client show "X/10 BOUNTIES LEFT")
-- Mirrors packages/server/src/persist.ts memoryPersistence — keep in sync.
-- Signature is unchanged but the OUT columns differ → drop first (as 0005).

drop function if exists get_account(text, text, boolean, text, text);

create or replace function get_account(
  _id text, _name text, _agent boolean, _address text, _ref text default null
) returns table (credits integer, level integer, xp integer,
                 wins integer, losses integer, daily_granted boolean,
                 ref_code text, referral_granted integer,
                 dares_accepted integer, dares_paid_week integer)
language plpgsql security definer set search_path = public as $$
declare
  prof profiles%rowtype;
  granted boolean := false;
  ref_bonus integer := 0;
  inviter profiles%rowtype;
begin
  insert into profiles (id, name, is_agent, address)
  values (_id, _name, _agent, _address)
  on conflict (id) do update
    set name = excluded.name, is_agent = excluded.is_agent,
        address = coalesce(excluded.address, profiles.address),
        updated_at = now();

  perform ensure_ref_code(_id);

  select * into prof from profiles p where p.id = _id for update;
  if prof.last_daily is distinct from (now() at time zone 'utc')::date then
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

  -- Referral redemption (invitee side). Best-effort by design: a bad or
  -- stale code must NEVER break login — it just grants nothing.
  if _ref is not null and _ref <> '' then
    select * into inviter from profiles p where p.ref_code = upper(trim(_ref));
    if found
       and inviter.id <> _id                                        -- no self-dares
       and not exists (select 1 from referrals r where r.invitee_id = _id)
       and not exists (select 1 from matches m where m.p0 = _id or m.p1 = _id)  -- new accounts only
    then
      begin
        insert into referrals (invitee_id, inviter_id, ref_code)
        values (_id, inviter.id, inviter.ref_code);
        insert into credit_ledger (profile_id, delta, reason, match_id)
        values (_id, 25, 'referral', 'ref:accepted');
        update profiles p set credits = p.credits + 25, updated_at = now()
          where p.id = _id returning * into prof;
        ref_bonus := 25;
      exception when unique_violation then
        ref_bonus := 0; -- raced with itself (double hello) — first one won
      end;
    end if;
  end if;

  credits := prof.credits; level := prof.level; xp := prof.xp;
  wins := prof.wins; losses := prof.losses; daily_granted := granted;
  ref_code := prof.ref_code; referral_granted := ref_bonus;
  dares_accepted := (select count(*) from referrals r where r.inviter_id = _id);
  dares_paid_week := (select count(*) from referrals r
                       where r.inviter_id = _id
                         and r.inviter_credited_at > now() - interval '7 days');
  return next;
end $$;

revoke execute on function get_account from public, anon, authenticated;
