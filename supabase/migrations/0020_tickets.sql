-- Agent Fighter — TICKETS (ADR 0009). Run AFTER 0019.
--
-- THE CUTOVER: a decided wager no longer moves credits between players. Both
-- entry fees BURN and the winner mints ONE non-transferable ticket, redeemable
-- later for esports qualification / merchandise / vouchers.
--
--   before:  10 in, 10 in  →  winner takes 20        (zero-sum transfer)
--   after:   10 in, 10 in  →  burned; winner gets 1 ticket   (a SINK + a prize)
--
-- Why this shape:
--  · Credits never flow player-to-player, so wager stops being peer wagering
--    and becomes a skill contest with a non-cash prize (arcade redemption /
--    tournament model). The house is an incinerator, never a counterparty.
--  · Wager becomes the game's largest credit SINK, which is what makes arcade
--    difficulty a real economic lever — the faucet finally has a drain.
--  · Sharking dies: the loser's credits went to nobody, so a strong player
--    cannot farm a weak one's balance.
--
-- LOCKED RULES (mirrored in packages/server/src/persist.ts settleSide — keep
-- both in sync or the dev economy lies about production):
--  · decided wager  → payout 0 BOTH sides (fees burn); winner mints a ticket.
--  · FORFEIT counts  → the settlement ladder already treats it as a decided
--    win for XP/W-L; a colluded ticket still costs 20 CR of capped-faucet
--    currency. (Owner decision 2026-07-26.)
--  · draw           → refund both fees, NO ticket. Nothing was decided.
--  · undecided/incomplete → refund, no ticket (unchanged no-contest path).
--  · a DEVIATOR never mints — it can never win a settlement (ADR 0003).
--  · HUMAN HANDS ONLY. Neither an agent-class (`agent:%`) sub nor a
--    connection that DECLARED itself an agent (`_pN_agent`) may mint. The
--    second gate is the load-bearing one: a coached-owner headless runner
--    plays as its owner's ordinary human profile, so the sub check alone
--    would let an owner farm tickets in their sleep. Bots fill wallets;
--    only hands fill trophy cases.
--  · NO per-account cap in v1: the 20-CR burn is the limiter, and the credit
--    faucet is already capped (+10/day + arcade extractions). Watch the
--    numbers first; add a cap when data says it is needed.
--
-- APPLY ORDER — THIS ONE BITES. The file is two halves on purpose:
--   1. `tickets` table + `ticket_count()` are INERT (nothing writes to them
--      until the new record_match exists) and were APPLIED AHEAD of the
--      deploy, on 2026-07-26, as migration `tickets_table_and_count`.
--   2. The record_match swap below is NOT YET APPLIED. Applying it while the
--      v7 server is live would make production BURN POTS IMMEDIATELY while
--      the deployed client still advertises one. It must land in the same
--      window as the paired Railway + Vercel deploy (protocol v8).
--
-- Smoke-tested on real Postgres before shipping (the `NULL = s` lesson from
-- 0002): a renamed `record_match_probe` carrying this exact body was run
-- against throwaway profiles — decided burn + mint, retry idempotency, draw
-- refund, agent-class inertness, deviator forfeit — and the ledger
-- reconciled (a decided wager leaves two `fee` rows and ZERO `payout` rows).
-- The probe and every smoke row were removed afterwards.
--
-- Tickets are NON-TRANSFERABLE, permanently. There is no transfer path here
-- and there must never be one: tradability would make the ticket
-- cash-equivalent and undo every property above. Value exits only through the
-- redemption counter (`redeemed_at`/`redeemed_for`, filled by a later ops
-- flow — redemption is deliberately NOT automated in v1).

create table if not exists tickets (
  id           bigint generated always as identity primary key,
  profile_id   text not null references profiles(id),
  -- The match that minted it. UNIQUE: one ticket per match, ever — the
  -- structural guard against a settlement retry minting a second one.
  match_id     text not null unique,
  season       smallint not null default 1,
  created_at   timestamptz not null default now(),
  -- Redemption (ops-driven in v1; the counter is a human, not an endpoint).
  redeemed_at  timestamptz,
  redeemed_for text
);
create index if not exists tickets_profile_idx on tickets (profile_id, created_at desc);

-- Service-role only. RLS enabled with NO policies = default-deny, the same
-- stance items/referrals take: a ticket balance is private, and the 2026-07-18
-- audit's lesson was that `using (true)` SELECT policies leak more than they
-- look like they do.
alter table tickets enable row level security;

-- Wallet display. A standalone RPC rather than widening get_account's return:
-- get_account is the daily-bonus + referral-redemption path and recreating it
-- to add one column is real risk on a live money DB for zero benefit. /me is
-- not a hot path.
create or replace function ticket_count(_profile text)
returns integer
language sql security definer set search_path = public as $$
  select count(*)::integer from tickets t
   where t.profile_id = _profile and t.redeemed_at is null;
$$;

revoke execute on function ticket_count from public, anon, authenticated;

-- record_match: the return type gains `ticket boolean`, so this must DROP and
-- recreate (create or replace cannot change a return type). Same approach 0008
-- took when it added _payout. The old signature is dropped by exact argument
-- list; a deployed old server calling it fails loudly at the PostgREST layer
-- rather than silently settling on stale rules — which is what we want for a
-- cutover that changes what money does.
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
                 ticket boolean, tickets integer)
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
    minted := false;

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
    --     (AF_AGENT_KEY) plays as its OWNER's profile, so its sub is a
    --     perfectly ordinary human sub. Without this gate an owner could
    --     farm tickets in their sleep. Agent-key auth forces agent=true
    --     server-side, and the browser never sets it.
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

    select count(*)::integer into ticket_bal
      from public.tickets t where t.profile_id = pid and t.redeemed_at is null;

    side := s; gained := xp_delta; levels_up := ups;
    level := prof.level; xp := prof.xp; wins := prof.wins; losses := prof.losses;
    credits_delta := payout - _fee; credits := prof.credits;
    ticket := minted; tickets := ticket_bal;
    return next;
  end loop;
end $$;

revoke execute on function record_match from public, anon, authenticated;
