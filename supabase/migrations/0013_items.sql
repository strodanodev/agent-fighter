-- Agent Fighter — CONSUMABLE ITEMS Phase 1 (ADR 0007). Run AFTER 0012.
--
-- Vending-machine gacha: the MATCH SERVER rolls the item (tier odds live in
-- @af/core items.ts, roll in server.ts — never in the sim); buy_item just
-- records the purchase ATOMICALLY: debit ITEM_COST credits + grant the row.
-- Idempotent by the client-supplied purchase nonce, two layers deep:
--   · items unique (profile_id, nonce) — a replayed purchase returns the
--     already-granted item instead of rolling twice;
--   · credit_ledger reason 'gacha' with match_id = nonce — the standard
--     unique (profile, reason, match) guard, same pattern as the daily
--     grant's date key. NOTE this widens the ledger reason set
--     (daily|fee|payout|refund|referral|gacha) — reason is free text, no
--     CHECK constraint to migrate.
-- (Mirrored in packages/server/src/persist.ts memoryPersistence buyItem —
-- keep both in sync or the dev economy lies about production.)

create table if not exists items (
  id                bigint generated always as identity primary key,
  profile_id        text not null references profiles(id),
  item_id           text not null,          -- ItemDef id (@af/core items.ts)
  tier              smallint not null check (tier between 1 and 3),
  nonce             text not null,          -- client purchase nonce (idempotency)
  created_at        timestamptz not null default now(),
  -- Phase 2: set when the item is carried into a match (consumed at pair
  -- time like fees; cleared if the match refunds as a no-contest).
  consumed_match_id text,
  consumed_at       timestamptz,
  unique (profile_id, nonce)
);
create index if not exists items_profile_idx on items (profile_id, created_at desc);

-- Service-role only. RLS enabled with NO policies = default-deny to anon —
-- inventories are private (the ask_leads/referrals no-select pattern; the
-- audit showed `using (true)` SELECT policies leak more than views should).
alter table items enable row level security;

create or replace function buy_item(
  _profile text, _cost integer, _item text, _tier smallint, _nonce text
) returns table (row_id bigint, granted_item text, granted_tier smallint,
                 credits integer, duplicate boolean)
language plpgsql security definer set search_path = public as $$
declare
  bal integer;
  existing items%rowtype;
  new_row items%rowtype;
begin
  -- Idempotent replay: this nonce already bought something → return it,
  -- charge nothing, roll nothing.
  select i.* into existing from items i
    where i.profile_id = _profile and i.nonce = _nonce;
  if found then
    select p.credits into bal from profiles p where p.id = _profile;
    row_id := existing.id; granted_item := existing.item_id;
    granted_tier := existing.tier; credits := coalesce(bal, 0);
    duplicate := true;
    return next; return;
  end if;

  select p.credits into bal from profiles p where p.id = _profile for update;
  if bal is null then raise exception 'NO_PROFILE'; end if;
  -- Same surface escrow_match raises — the server maps it to a clean 402.
  if bal < _cost then raise exception 'INSUFFICIENT:0'; end if;

  insert into credit_ledger (profile_id, delta, reason, match_id)
  values (_profile, -_cost, 'gacha', _nonce);
  update profiles p set credits = p.credits - _cost, updated_at = now()
    where p.id = _profile returning p.credits into bal;

  insert into items (profile_id, item_id, tier, nonce)
  values (_profile, _item, _tier, _nonce) returning * into new_row;

  row_id := new_row.id; granted_item := new_row.item_id;
  granted_tier := new_row.tier; credits := bal; duplicate := false;
  return next;
end $$;

revoke execute on function buy_item from public, anon, authenticated;
