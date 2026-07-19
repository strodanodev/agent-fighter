-- Agent Fighter — energy-drink EQUIP slots (ADR 0007 final shape).
-- Run AFTER 0015.
--
-- Players equip up to 3 drinks in the vending-machine screen; the server
-- reads the equipped loadout at queue time (the client no longer nominates
-- an item), pins all three into the match, and — because consumption is now
-- settled from the verified re-sim — only the cans actually DRUNK stay
-- consumed. equipped_slot: 0..2, null = in the stash. Enforcement of "one
-- item per slot" is by the service-role server (single writer), not a DB
-- constraint — a partial unique index on (profile_id, equipped_slot) would
-- fight the swap-two-slots update order for no real-world gain.

alter table items add column if not exists equipped_slot smallint
  check (equipped_slot is null or equipped_slot between 0 and 2);

create index if not exists items_equipped_idx
  on items (profile_id, equipped_slot) where equipped_slot is not null;
