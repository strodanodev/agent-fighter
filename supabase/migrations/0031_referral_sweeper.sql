-- Agent Fighter — REFERRAL PAYOUT SWEEPER + pending counter. Run AFTER 0005.
--
-- Incident (2026-08-04): a player used their DARE LINK, the friend redeemed it
-- and took the invitee +25, and the inviter was never credited. Nothing was
-- broken — the inviter payout is gated on the invitee finishing a first
-- DECIDED match (0005_referrals.sql), and the friend had entered the arcade
-- once and abandoned it without ever settling a match. The payout was PENDING,
-- correctly, and no surface anywhere said so.
--
-- Two structural gaps that incident exposed:
--
--   1. NO RETRY PATH BUT THE INVITEE. `release_referral` is called from exactly
--      one place — match settlement, for the players in that match
--      (packages/server/src/server.ts). So a pending payout only ever retries
--      when THAT invitee plays again. If they churn, the inviter's credits are
--      stranded forever. This bites hardest on the rolling-week cap: a payout
--      the cap refused returns 0 WITHOUT stamping inviter_credited_at, so an
--      inviter who lands 15 friends in a week permanently loses 5 payouts
--      unless those exact 5 friends come back. Escrow (0003) and items (0018)
--      both have sweepers for the same class of bug; referrals did not.
--
--   2. `release_referral` LIED ON RETRY. It returned 25 even when the ledger
--      insert hit unique_violation (already paid), so the server logged
--      "inviter of X paid +25" for a retry that moved nothing. The credit
--      itself was always safe — credit_ledger's unique (profile_id, reason,
--      match_id) is what makes the whole thing idempotent — but the log and
--      the sweeper's own count were wrong.
--
-- SAFE TO APPLY ANY TIME, unlike 0020: this adds two new functions and
-- replaces one function BODY. No signature changes, so no PostgREST schema
-- cache window and no deploy-then-migrate cutover — an old server keeps
-- working against it unchanged.

-- ------------------------------------------------------- release_referral v2
-- Behaviour is otherwise IDENTICAL to 0005: pays once, gated on a decided
-- match, capped at 10 payouts per inviter per rolling 7 days, and it still
-- stamps inviter_credited_at after a unique_violation so a genuinely-paid
-- referral stops being retried forever. The only change is the RETURN VALUE:
-- 0 now means "no credits moved", which is what the caller logs on.
create or replace function release_referral(_invitee text) returns integer
language plpgsql security definer set search_path = public as $$
declare
  ref referrals%rowtype;
  recent integer;
  paid integer := 0;
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
    paid := 25;
  exception when unique_violation then
    paid := 0; -- already paid on an earlier attempt — stamp below, stop trying
  end;
  update referrals r set inviter_credited_at = now() where r.invitee_id = _invitee;
  return paid;
end $$;

-- -------------------------------------------------- sweep_pending_referrals
-- The missing retry path (gap 1). Walks every uncredited referral and offers
-- it to release_referral, which re-applies the SAME gates — this sweeper can
-- never pay something settlement would not have paid. Oldest first, so a
-- cap-constrained inviter drains its backlog in the order friends joined
-- rather than newest-wins.
--
-- Returns the number of referrals actually CREDITED (not the number examined),
-- which is why release_referral's honest return value above matters.
create or replace function sweep_pending_referrals() returns integer
language plpgsql security definer set search_path = public as $$
declare
  r record;
  paid integer := 0;
begin
  for r in select invitee_id from referrals
            where inviter_credited_at is null
            order by created_at
  loop
    if release_referral(r.invitee_id) > 0 then paid := paid + 1; end if;
  end loop;
  return paid;
end $$;

-- --------------------------------------------------------- dares_pending
-- Inviter-side counter for the in-game invite screen: friends who redeemed
-- this player's code but whose payout has NOT been released yet.
--
-- A SEPARATE rpc rather than a tenth column on get_account, for exactly the
-- reason 0020_tickets.sql gave for ticket_count: get_account is the daily-bonus
-- AND referral-redemption path, its return type cannot change without a
-- drop/recreate, and a drop/recreate on a live money DB to add one display
-- counter is real risk for no benefit.
create or replace function dares_pending(_profile text) returns integer
language sql stable security definer set search_path = public as $$
  select count(*)::integer from referrals r
   where r.inviter_id = _profile and r.inviter_credited_at is null;
$$;

revoke execute on function release_referral        from public, anon, authenticated;
revoke execute on function sweep_pending_referrals from public, anon, authenticated;
revoke execute on function dares_pending           from public, anon, authenticated;
