-- Agent Fighter — NON-REFUNDABLE direct debit (ADR 0007 credits rework).
-- Run AFTER 0014.
--
-- The arcade entry fee moves from escrow_match (refundable: record_match
-- refunds undecided fees, the 0003 sweeper refunds crash-stranded ones) to
-- an upfront, consented, NON-refundable debit taken by POST /arcade/enter
-- BEFORE character select. No matches row is ever expected for it, and the
-- sweeper must never touch it — hence a reason ('arcade' — NOT 'fee') that
-- the sweeper's ghost query (0003: reason = 'fee') doesn't match.
--
-- Idempotent by (profile, reason, key): the standard credit_ledger unique
-- (profile_id, reason, match_id) guard, with the client nonce as match_id —
-- the same pattern buy_item uses for gacha pulls. A replayed call charges
-- nothing and reports duplicate = true.
--
-- (Mirrored in packages/server/src/persist.ts memoryPersistence
-- debitCredits — keep both in sync or the dev economy lies.)

create or replace function debit_credits(
  _profile text, _amount integer, _reason text, _key text
) returns table (credits integer, duplicate boolean)
language plpgsql security definer set search_path = public as $$
declare
  bal integer;
begin
  -- Replay: this (reason, key) already debited → charge nothing.
  if exists (
    select 1 from credit_ledger l
    where l.profile_id = _profile and l.reason = _reason and l.match_id = _key
  ) then
    select p.credits into bal from profiles p where p.id = _profile;
    credits := coalesce(bal, 0); duplicate := true;
    return next; return;
  end if;

  select p.credits into bal from profiles p where p.id = _profile for update;
  if bal is null then raise exception 'NO_PROFILE'; end if;
  -- Same surface escrow_match raises — the server maps it to a clean 402.
  if bal < _amount then raise exception 'INSUFFICIENT:0'; end if;

  insert into credit_ledger (profile_id, delta, reason, match_id)
  values (_profile, -_amount, _reason, _key);
  update profiles p set credits = p.credits - _amount, updated_at = now()
    where p.id = _profile returning p.credits into bal;

  credits := bal; duplicate := false;
  return next;
end $$;

revoke execute on function debit_credits from public, anon, authenticated;
