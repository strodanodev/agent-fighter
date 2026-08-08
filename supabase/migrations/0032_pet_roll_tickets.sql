-- Agent Fighter — PET GACHA: roll a pet with TICKETS (ADR 0009 phase B,
-- extending ADR 0011). Run AFTER 0031.
--
-- STATUS: NOT YET APPLIED to production. Additive only (one new function),
-- safe ahead of the deploy — nothing calls it until the gacha server ships.
--
-- THE FIRST REAL TICKET SINK. 0020 minted wager tickets as pure cosmetics
-- with `redeemed_at`/`redeemed_for` reserved "for a later ops phase" — this
-- is that phase, for pets: 5 tickets buy one pet roll (PET_ROLL_TICKETS in
-- @af/core pets.ts; the credits price lives in buy_pet's _cost argument).
--
-- Shape mirrors buy_pet (0030) exactly — the SERVER rolls pet + aura and
-- passes fixed integers in; this function only records atomically:
--   · idempotent by pets(profile_id, nonce): a replayed roll returns the
--     stored grant, redeems nothing, re-rolls nothing;
--   · redemption marks the _count OLDEST unredeemed tickets
--     (redeemed_at = now(), redeemed_for = 'pet:'||nonce) — every count
--     surface already filters `redeemed_at is null` (0020/0022), so the
--     wallet and leaderboard columns decrement without any change there;
--   · INSUFFICIENT:0 is the same surface buy_pet/escrow_match raise; the
--     server maps it to a clean 402 {code:'tickets'}.
--
-- (Mirrored in packages/server/src/persist.ts memoryPersistence
-- redeemTicketsForPet — keep both in sync or the dev economy lies.)

create or replace function redeem_tickets_for_pet(
  _profile text, _count integer, _pet text, _rarity smallint,
  _atk smallint, _def smallint, _hp smallint, _crit smallint, _energy smallint,
  _nonce text
) returns table (row_id bigint, granted_pet text, granted_rarity smallint,
                 atk smallint, def smallint, hp_regen smallint,
                 crit smallint, energy_regen smallint,
                 tickets integer, duplicate boolean)
language plpgsql security definer set search_path = public as $$
declare
  existing pets%rowtype;
  new_row pets%rowtype;
  unredeemed integer;
  marked integer;
begin
  -- Idempotent replay: this nonce already rolled → return it, redeem nothing.
  select p.* into existing from pets p
    where p.profile_id = _profile and p.nonce = _nonce;
  if found then
    select count(*)::integer into unredeemed from tickets t
      where t.profile_id = _profile and t.redeemed_at is null;
    row_id := existing.id; granted_pet := existing.pet_id;
    granted_rarity := existing.rarity;
    atk := existing.aura_atk; def := existing.aura_def;
    hp_regen := existing.aura_hp_regen; crit := existing.aura_crit;
    energy_regen := existing.aura_energy_regen;
    tickets := unredeemed; duplicate := true;
    return next; return;
  end if;

  -- Redeem the _count oldest unredeemed tickets, atomically. FOR UPDATE
  -- SKIP LOCKED is deliberately NOT used: two concurrent rolls from one
  -- profile should serialize, not each grab a disjoint five.
  with picked as (
    select t.id from tickets t
     where t.profile_id = _profile and t.redeemed_at is null
     order by t.created_at asc, t.id asc
     limit _count
     for update
  )
  update tickets t set redeemed_at = now(), redeemed_for = 'pet:' || _nonce
    from picked where t.id = picked.id;
  get diagnostics marked = row_count;
  if marked < _count then
    -- Nothing committed — the whole function is one transaction.
    raise exception 'INSUFFICIENT:0';
  end if;

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

  select count(*)::integer into unredeemed from tickets t
    where t.profile_id = _profile and t.redeemed_at is null;

  row_id := new_row.id; granted_pet := new_row.pet_id;
  granted_rarity := new_row.rarity;
  atk := new_row.aura_atk; def := new_row.aura_def;
  hp_regen := new_row.aura_hp_regen; crit := new_row.aura_crit;
  energy_regen := new_row.aura_energy_regen;
  tickets := unredeemed; duplicate := false;
  return next;
end $$;

-- Definer RPCs are service-role only (the 0019 rule).
revoke execute on function redeem_tickets_for_pet from public, anon, authenticated;

-- New function → PostgREST schema cache must reload or the first caller 404s
-- (the 0017 lesson).
notify pgrst, 'reload schema';
