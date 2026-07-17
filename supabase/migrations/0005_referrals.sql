-- Agent Fighter — REFERRAL DARES ("I dare you to beat me"). Run AFTER 0004.
--
-- Every profile gets a shareable REF CODE (NAME-XXXX). The landing site
-- serves agent-fighter-web.vercel.app/dare/<code>; a friend who accepts and
-- signs in with AIR gets credited, and the inviter gets credited once the
-- friend finishes a first match. Mirrors packages/server/src/persist.ts
-- memoryPersistence — keep both in sync or the dev economy lies.
--
-- Economy rules:
--   invitee  +25 credits at first authenticated contact carrying ?ref=
--            (only ever once, only if they have NO recorded matches yet)
--   inviter  +25 credits when that invitee finishes a first DECIDED match
--            (capped: max 10 inviter payouts per rolling 7 days — pending
--            payouts simply wait for the window to free up)
--   no self-referral; everything service-role-only and idempotent via the
--   credit_ledger's unique (profile_id, reason, match_id).

-- ------------------------------------------------------------------ ref codes
alter table profiles add column if not exists ref_code text;
create unique index if not exists profiles_ref_code_key on profiles (ref_code);

-- NAME-XXXX, uppercase, url-safe. Hash comes from the immutable profile id so
-- a code survives renames; _len widens on collision.
create or replace function make_ref_code(_id text, _name text, _len integer default 4)
returns text language sql immutable set search_path = public as $$
  select left(coalesce(nullif(upper(regexp_replace(coalesce(_name, ''), '[^A-Za-z0-9]', '', 'g')), ''), 'FIGHTER'), 10)
         || '-' || upper(left(md5(_id), _len))
$$;

create or replace function ensure_ref_code(_id text) returns text
language plpgsql security definer set search_path = public as $$
declare
  code text;
  len integer := 4;
begin
  select p.ref_code into code from profiles p where p.id = _id;
  if code is not null then return code; end if;
  loop
    code := make_ref_code(_id, (select p.name from profiles p where p.id = _id), len);
    begin
      update profiles p set ref_code = code, updated_at = now() where p.id = _id;
      return code;
    exception when unique_violation then
      len := len + 2;
      if len > 32 then raise; end if; -- md5 exhausted: something is deeply wrong
    end;
  end loop;
end $$;

-- Backfill existing profiles one by one (collision-safe via ensure_ref_code).
do $$
declare r record;
begin
  for r in select id from profiles where ref_code is null loop
    perform ensure_ref_code(r.id);
  end loop;
end $$;

-- ------------------------------------------------------------------ referrals
create table if not exists referrals (
  invitee_id          text primary key references profiles(id),  -- one referral per account, ever
  inviter_id          text not null references profiles(id),
  ref_code            text not null,
  created_at          timestamptz not null default now(),
  inviter_credited_at timestamptz                                 -- null = inviter payout pending
);
create index if not exists referrals_inviter_idx on referrals (inviter_id, inviter_credited_at desc);

-- Who invited whom stays private: RLS on, no select policy (service role only).
alter table referrals enable row level security;

-- --------------------------------------------------------------- get_account
-- v3: also ensures/returns the ref code and (optionally) redeems a referral
-- for a brand-new account. Signature change → drop the old function first.
drop function if exists get_account(text, text, boolean, text);

create or replace function get_account(
  _id text, _name text, _agent boolean, _address text, _ref text default null
) returns table (credits integer, level integer, xp integer,
                 wins integer, losses integer, daily_granted boolean,
                 ref_code text, referral_granted integer)
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
  return next;
end $$;

-- ----------------------------------------------------------- release_referral
-- Inviter payout, called by the match server AFTER record_match settles a
-- match involving _invitee. Pays once (ledger-guarded), only after the
-- invitee has a DECIDED match on record, throttled to 10 payouts per
-- inviter per rolling 7 days (pending payouts retry on later matches).
-- Returns credits granted to the inviter (0 = nothing due).
create or replace function release_referral(_invitee text) returns integer
language plpgsql security definer set search_path = public as $$
declare
  ref referrals%rowtype;
  recent integer;
begin
  select * into ref from referrals r
    where r.invitee_id = _invitee and r.inviter_credited_at is null
    for update;
  if not found then return 0; end if;

  if not exists (select 1 from matches m
                 where (m.p0 = _invitee or m.p1 = _invitee)
                   and m.winner >= 0 and m.reason <> 'incomplete') then
    return 0;
  end if;

  select count(*) into recent from referrals r
    where r.inviter_id = ref.inviter_id
      and r.inviter_credited_at > now() - interval '7 days';
  if recent >= 10 then return 0; end if; -- cap hit — stays pending

  begin
    insert into credit_ledger (profile_id, delta, reason, match_id)
    values (ref.inviter_id, 25, 'referral', 'ref:' || _invitee);
    update profiles p set credits = p.credits + 25, updated_at = now()
      where p.id = ref.inviter_id;
  exception when unique_violation then
    null; -- already paid (retry) — still stamp below so we stop trying
  end;
  update referrals r set inviter_credited_at = now() where r.invitee_id = _invitee;
  return 25;
end $$;

-- ---------------------------------------------------------------- player_stats
-- Public per-player lookup for the landing /dare/<code> page + OG image.
-- The leaderboard view is top-100 only; dare pages need ANY player by code.
-- Exposes nothing profiles' public-read RLS doesn't already allow.
create or replace view player_stats with (security_invoker = true) as
  select p.id, p.ref_code, p.name, p.is_agent, p.level, p.xp, p.wins, p.losses,
         p.created_at,
         (select case when m.p0 = p.id then m.p0_char else m.p1_char end
            from matches m
           where m.p0 = p.id or m.p1 = p.id
           group by 1
           order by count(*) desc
           limit 1) as main_char,
         (select l.rank from leaderboard l where l.id = p.id) as rank
  from profiles p
  where p.ref_code is not null;

revoke execute on function get_account      from public, anon, authenticated;
revoke execute on function release_referral from public, anon, authenticated;
revoke execute on function ensure_ref_code  from public, anon, authenticated;
