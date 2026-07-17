-- Agent Fighter — orphaned-escrow sweeper (ADR 0005 known gap). Run AFTER
-- 0002_credits.sql. Mirrored by persist.ts memoryPersistence.sweepOrphanedEscrow
-- — keep both in sync.
--
-- The hole: fees are escrowed at pair time and refunded by record_match on an
-- undecided outcome. If the SERVER PROCESS dies between those two points
-- (crash, deploy restart), no settlement ever runs and the credits are frozen
-- forever: a 'fee' ledger row with no matching 'payout'/'refund'.
--
-- The sweep: any fee row older than the cutoff whose match_id has NO matches
-- row is a ghost — no legitimate match outlives 30 minutes (idle forfeit caps
-- silence at 30s; the solo pace guard caps wall time at ~3× sim). Each ghost
-- is SETTLED as a no-contest first (a synthetic matches row), so a late
-- record_match finds the id taken and awards nothing — refund-then-payout
-- double-spends are structurally impossible. Then every fee row of the match
-- is refunded, guarded by the unique (profile, reason, match) ledger row so a
-- concurrent/second sweep can't refund twice.

create or replace function sweep_orphaned_escrow(_older_than_minutes integer default 30)
returns integer
language plpgsql security definer set search_path = public as $$
declare
  mrec record;
  frec record;
  claimed boolean;
  refunded integer := 0;
begin
  for mrec in
    select distinct l.match_id
    from credit_ledger l
    where l.reason = 'fee'
      and l.match_id is not null
      and l.created_at < now() - make_interval(mins => _older_than_minutes)
      and not exists (select 1 from matches m where m.id = l.match_id)
  loop
    -- Claim the ghost as a settled no-contest. If a concurrent settlement
    -- (or another sweeper) beat us to the insert, leave it entirely alone.
    insert into matches (id, mode, fee, p0_name, p1_name, winner, reason, engine)
    values (mrec.match_id, 'wager', 0, 'SWEPT', 'SWEPT', -1, 'incomplete', 'escrow-sweeper')
    on conflict (id) do nothing;
    get diagnostics claimed = row_count;
    if not claimed then continue; end if;

    for frec in
      select l.profile_id, -l.delta as fee
      from credit_ledger l
      where l.reason = 'fee' and l.match_id = mrec.match_id
    loop
      begin
        insert into credit_ledger (profile_id, delta, reason, match_id)
        values (frec.profile_id, frec.fee, 'refund', mrec.match_id);
        update profiles p set credits = p.credits + frec.fee, updated_at = now()
          where p.id = frec.profile_id;
        refunded := refunded + 1;
      exception when unique_violation then
        null; -- this side was already refunded
      end;
    end loop;
  end loop;
  return refunded;
end $$;

revoke execute on function sweep_orphaned_escrow from public, anon, authenticated;
