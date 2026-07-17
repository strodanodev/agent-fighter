-- Protect fighter display names on the leaderboard.
--
-- Bug: /me called without ?name= used identity.sub.slice(0,12) (a UUID prefix)
-- as the upsert name, overwriting the real fighter name after matches had
-- already recorded CONTACT.* etc. Standings then showed raw UUID stubs and
-- looked "stuck" / fake even though W-L came from real matches.
--
-- Fix: never overwrite a real name with an empty or UUID-looking stub.
-- Also repair existing rows from the latest match display name.

create or replace function is_uuid_stub(_name text, _id text)
returns boolean
language sql immutable set search_path = public as $$
  select
    coalesce(nullif(trim(_name), ''), '') = ''
    or lower(trim(_name)) = lower(left(_id, 12))
    or trim(_name) ~* '^[0-9a-f]{8}-[0-9a-f]{0,4}$'
$$;

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
  safe_name text;
begin
  safe_name := nullif(trim(_name), '');
  if safe_name is null or is_uuid_stub(safe_name, _id) then
    safe_name := null; -- keep existing on conflict; fall back on insert
  end if;

  insert into profiles (id, name, is_agent, address)
  values (_id, coalesce(safe_name, left(_id, 12)), _agent, _address)
  on conflict (id) do update
    set name = case
          when safe_name is null then profiles.name
          else safe_name
        end,
        is_agent = excluded.is_agent,
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

  if _ref is not null and _ref <> '' then
    select * into inviter from profiles p where p.ref_code = upper(trim(_ref));
    if found
       and inviter.id <> _id
       and not exists (select 1 from referrals r where r.invitee_id = _id)
       and not exists (select 1 from matches m where m.p0 = _id or m.p1 = _id)
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
        ref_bonus := 0;
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

-- Repair stubs from the newest match-side display name.
update profiles p
set name = m.nm,
    updated_at = now()
from (
  select distinct on (src.id) src.id, src.nm
  from (
    select p0 as id, p0_name as nm, created_at from matches
      where p0 is not null and p0_name is not null
    union all
    select p1 as id, p1_name as nm, created_at from matches
      where p1 is not null and p1_name is not null
  ) src
  where not is_uuid_stub(src.nm, src.id)
  order by src.id, src.created_at desc
) m
where p.id = m.id
  and is_uuid_stub(p.name, p.id);
