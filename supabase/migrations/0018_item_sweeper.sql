-- Agent Fighter — orphaned-ITEM sweeper (ADR 0007 known gap). Run AFTER
-- 0013_items.sql. Mirrored by persist.ts memoryPersistence.sweepOrphanedItems
-- — keep both in sync.
--
-- The hole: energy drinks are claimed for a match at pair time
-- (consumed_match_id stamped by claim_equipped/consume_item) and handed back
-- by settle_items/release_items at settlement. If the SERVER PROCESS dies
-- between those two points (crash; deploys now drain gracefully), no
-- settlement ever runs and the cans are locked forever: consumed_match_id
-- points at a match that does not exist.
--
-- The sweep: any claim older than the cutoff whose match id has NO matches
-- row is a ghost — release the can back to the stash (equipped_slot is
-- untouched, so it re-arms for the next fight, same as an undrunk can at a
-- normal settlement). Real settlements always HAVE a matches row, so
-- legitimately drunk cans are never resurrected. The synthetic no-contest
-- rows the ESCROW sweeper plants (engine = 'escrow-sweeper') don't count as
-- settled here: release_items never ran for those ghosts either, whichever
-- sweep claims the match first. Idempotent by construction: a released row
-- no longer matches the filter.

create or replace function sweep_orphaned_items(_older_than_minutes integer default 30)
returns integer
language plpgsql security definer set search_path = public as $$
declare
  released integer;
begin
  update items i
  set consumed_match_id = null, consumed_at = null
  where i.consumed_match_id is not null
    and i.consumed_at < now() - make_interval(mins => _older_than_minutes)
    and not exists (select 1 from matches m
                    where m.id = i.consumed_match_id
                      and m.engine <> 'escrow-sweeper');
  get diagnostics released = row_count;
  return released;
end $$;

revoke execute on function sweep_orphaned_items from public, anon, authenticated;
