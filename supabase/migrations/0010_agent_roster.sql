-- Agent Fighter — opponent identity for the AGENT ARCADE / VS-AGENT select
-- screen badge (LVL · W-L · wallet · win streak · "Connected to Minds™").
--
-- Additive & non-breaking: two read-only helpers + one view. No existing
-- object is dropped or altered. Mirrors nothing in the RPC settle path — this
-- is pure read surface for the client's opponent card, served via the match
-- server's GET /agents/roster.

-- Current consecutive-win streak (from the most recent DECIDED matches) for a
-- profile. A draw or loss breaks the streak. 0 if the last decided match was
-- not a win.
create or replace function win_streak(_pid text) returns integer
language sql stable security definer set search_path = public as $$
  with recent as (
    select ((p0 = _pid and winner = 0) or (p1 = _pid and winner = 1)) as won,
           row_number() over (order by created_at desc, id desc) as rn
    from matches
    where (p0 = _pid or p1 = _pid) and winner in (0, 1, 2)
  )
  select coalesce(count(*) filter (
    where won and rn < coalesce((select min(rn) from recent where not won), 2147483647)
  ), 0)::int
  from recent;
$$;

-- The house agent's LIVE aggregate record across every ranked solo/arcade
-- battle (the deterministic house AI is always side 1). Grows as players
-- fight it — the "the house agent learns from every match" signal the badge
-- surfaces. Its DISPLAYED level is calibrated per-player client-side; W-L and
-- streak here are the real, shared house record.
create or replace function house_agent_stats()
  returns table(wins integer, losses integer, streak integer, battles integer)
language sql stable security definer set search_path = public as $$
  with h as (
    select (winner = 1) as won,
           row_number() over (order by created_at desc, id desc) as rn
    from matches
    where mode in ('solo', 'arcade') and winner in (0, 1)  -- decided only
  )
  select
    count(*) filter (where won)::int,
    count(*) filter (where not won)::int,
    coalesce(count(*) filter (
      where won and rn < coalesce((select min(rn) from h where not won), 2147483647)
    ), 0)::int,
    count(*)::int
  from h;
$$;

-- Public roster of LIVE agents (real players' trained agents, ADR 0006) with
-- the extra identity fields the opponent card wants: wallet address + current
-- streak. Empty until coaches connect via Minds; the badge falls back to the
-- house agent in that case.
create or replace view agent_roster with (security_invoker = true) as
  select p.id, p.name, p.address, p.level, p.xp, p.wins, p.losses,
         win_streak(p.id) as streak
  from profiles p
  where p.is_agent = true and (p.wins + p.losses) > 0;

grant execute on function win_streak(text) to anon, authenticated, service_role;
grant execute on function house_agent_stats() to anon, authenticated, service_role;
grant select on agent_roster to anon, authenticated, service_role;
