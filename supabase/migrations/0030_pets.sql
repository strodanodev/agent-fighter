-- Agent Fighter — PETS (ADR 0011). Run AFTER 0029.
--
-- STATUS: NOT YET APPLIED to the production project. Safe to apply AHEAD of
-- the deploy — it only ADDS a table and a function, so no deployed caller
-- changes behaviour (migrations/README.md case 2). Nothing reads `pets` until
-- the af-core-8 / protocol-9 server ships.
--
-- Smoke-test the money path on real Postgres before trusting it (README rule
-- 4): the TS mirror in persist.ts cannot catch a SQL-only bug.
--
-- A pet is an account-bound companion with a rolled AURA. The MATCH SERVER
-- rolls both the pet and its aura at purchase time (rarity odds + ranges live
-- in @af/core pets.ts, the roll itself in server.ts — never in the sim, never
-- on a client); buy_pet just records it ATOMICALLY: debit PET_COST credits +
-- grant the row.
--
-- Idempotent by the client-supplied nonce, two layers deep, exactly like
-- buy_item (0013):
--   · pets unique (profile_id, nonce) — a replayed purchase returns the
--     already-granted pet instead of rolling a second one;
--   · credit_ledger reason 'pet' with match_id = nonce — the standard
--     unique (profile, reason, match) guard. This widens the reason set
--     (daily|fee|payout|refund|referral|gacha|arcade|pet); reason is free
--     text, no CHECK constraint to migrate.
--
-- ACCOUNT BOUND is enforced by ABSENCE: profile_id is written once, here, and
-- NOTHING in this schema or in the server ever updates it. There is no
-- transfer RPC, no gift endpoint, no admin reassign. That is the only kind of
-- binding a leaked key cannot work around.
--
-- (Mirrored in packages/server/src/persist.ts memoryPersistence buyPet /
-- listPets / setEquippedPet / equippedPet — keep both in sync or the dev
-- economy lies about production. The 0002 lesson.)

create table if not exists pets (
  id           bigint generated always as identity primary key,
  profile_id   text not null references profiles(id),
  pet_id       text not null,            -- PetDef id (pets/<id>/pet.json)
  rarity       smallint not null check (rarity between 1 and 3),
  -- The rolled aura, per-mille, one column per line (@af/core PetAura).
  -- 0 = this pet did not roll that line. Bounded here as well as in the
  -- server and in the sim: bound data at every boundary.
  aura_atk           smallint not null default 0 check (aura_atk between 0 and 80),
  aura_def           smallint not null default 0 check (aura_def between 0 and 80),
  aura_hp_regen      smallint not null default 0 check (aura_hp_regen between 0 and 80),
  aura_crit          smallint not null default 0 check (aura_crit between 0 and 80),
  aura_energy_regen  smallint not null default 0 check (aura_energy_regen between 0 and 80),
  nickname     text,                     -- reserved; not settable yet
  equipped     boolean not null default false,
  nonce        text not null,            -- client purchase nonce (idempotency)
  created_at   timestamptz not null default now(),
  unique (profile_id, nonce)
);

create index if not exists pets_profile_idx on pets (profile_id, created_at desc);
-- At most one equipped pet per account. Unlike the drinks' 3 slots there is
-- no swap-order problem here, so the constraint is worth having in the DB.
create unique index if not exists pets_equipped_idx
  on pets (profile_id) where equipped;

-- Service-role only. RLS enabled with NO policies = default-deny to anon —
-- an inventory is private (the items/ask_leads pattern; the 2026-07-18 audit
-- showed `using (true)` SELECT policies leak more than a curated view should).
alter table pets enable row level security;

create or replace function buy_pet(
  _profile text, _cost integer, _pet text, _rarity smallint,
  _atk smallint, _def smallint, _hp smallint, _crit smallint, _energy smallint,
  _nonce text
) returns table (row_id bigint, granted_pet text, granted_rarity smallint,
                 atk smallint, def smallint, hp_regen smallint,
                 crit smallint, energy_regen smallint,
                 credits integer, duplicate boolean)
language plpgsql security definer set search_path = public as $$
declare
  bal integer;
  existing pets%rowtype;
  new_row pets%rowtype;
begin
  -- Idempotent replay: this nonce already adopted something → return it,
  -- charge nothing, roll nothing. A dropped response can never re-roll.
  select p.* into existing from pets p
    where p.profile_id = _profile and p.nonce = _nonce;
  if found then
    select pr.credits into bal from profiles pr where pr.id = _profile;
    row_id := existing.id; granted_pet := existing.pet_id;
    granted_rarity := existing.rarity;
    atk := existing.aura_atk; def := existing.aura_def;
    hp_regen := existing.aura_hp_regen; crit := existing.aura_crit;
    energy_regen := existing.aura_energy_regen;
    credits := coalesce(bal, 0); duplicate := true;
    return next; return;
  end if;

  select pr.credits into bal from profiles pr where pr.id = _profile for update;
  if bal is null then raise exception 'NO_PROFILE'; end if;
  -- Same surface escrow_match and buy_item raise — the server maps it to a
  -- clean 402 {code:'credits'}.
  if bal < _cost then raise exception 'INSUFFICIENT:0'; end if;

  -- Audit row FIRST (buy_item order): the (profile, reason, match) unique
  -- index is the second idempotency layer, so a concurrent double-submit of
  -- the same nonce fails here rather than after the debit.
  insert into credit_ledger (profile_id, delta, reason, match_id)
  values (_profile, -_cost, 'pet', _nonce);
  update profiles pr set credits = pr.credits - _cost, updated_at = now()
    where pr.id = _profile returning pr.credits into bal;

  insert into pets (profile_id, pet_id, rarity, aura_atk, aura_def,
                    aura_hp_regen, aura_crit, aura_energy_regen, nonce)
  values (_profile, _pet, _rarity,
          least(greatest(coalesce(_atk, 0), 0), 80),
          least(greatest(coalesce(_def, 0), 0), 80),
          least(greatest(coalesce(_hp, 0), 0), 80),
          least(greatest(coalesce(_crit, 0), 0), 80),
          least(greatest(coalesce(_energy, 0), 0), 80),
          _nonce)
  returning * into new_row;

  row_id := new_row.id; granted_pet := new_row.pet_id;
  granted_rarity := new_row.rarity;
  atk := new_row.aura_atk; def := new_row.aura_def;
  hp_regen := new_row.aura_hp_regen; crit := new_row.aura_crit;
  energy_regen := new_row.aura_energy_regen;
  credits := bal; duplicate := false;
  return next;
end $$;

-- Definer RPCs are service-role only (the 0019 rule — a SECURITY DEFINER
-- function anon may EXECUTE is a privilege ladder). Explicit service_role
-- grants survive a revoke from public, so the match server is unaffected.
revoke execute on function buy_pet from public, anon, authenticated;

-- PostgREST caches the schema: without this the brand-new `pets` table and
-- `buy_pet` RPC 404 for the first callers even though both exist (the
-- 0017/ef753c8 lesson — README rule 3).
notify pgrst, 'reload schema';
