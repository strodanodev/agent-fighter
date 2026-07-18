-- Agent Fighter — reject self-matches at escrow (defense in depth).
--
-- The exploit (audit 2026-07-18, server finding 1): tryPair could pair two
-- sockets of the SAME profile against each other. escrow_match's ledger
-- idempotency guard `unique (profile_id, reason, match_id)` then swallowed
-- the second fee row as a retry duplicate — only ONE fee collected — while
-- record_match paid the winner fee*2: net +fee minted per self-match.
-- The server now refuses to pair identical subs; this migration makes the
-- money path itself reject them, so no future pairing bug can reopen the
-- mint. Mirrored in packages/server/src/persist.ts memoryPersistence
-- (which previously charged a self-pair TWICE — the dev mirror could never
-- reproduce the production bug; both now reject).

create or replace function escrow_match(
  _match text, _p0 text, _p1 text, _fee integer
) returns void
language plpgsql security definer set search_path = public as $$
declare
  s integer;
  pid text;
  bal integer;
begin
  if _p0 is not null and _p0 = _p1 then
    raise exception 'SELF_MATCH';
  end if;
  for s in 0..1 loop
    pid := case when s = 0 then _p0 else _p1 end;
    if pid is null then continue; end if;
    -- Skip sides already escrowed for this match (retry safety).
    if exists (select 1 from credit_ledger
               where profile_id = pid and reason = 'fee' and match_id = _match) then
      continue;
    end if;
    select credits into bal from profiles where id = pid for update;
    if bal is null or bal < _fee then
      raise exception 'INSUFFICIENT:%', s;
    end if;
  end loop;
  for s in 0..1 loop
    pid := case when s = 0 then _p0 else _p1 end;
    if pid is null then continue; end if;
    begin
      insert into credit_ledger (profile_id, delta, reason, match_id)
      values (pid, -_fee, 'fee', _match);
      update profiles p set credits = p.credits - _fee, updated_at = now()
        where p.id = pid;
    exception when unique_violation then
      null; -- already escrowed (retry)
    end;
  end loop;
end $$;

revoke execute on function escrow_match from public, anon, authenticated;
