-- Agent Fighter — DEFEND-ELO (ADR 0009, build step 4). Run AFTER 0027.
-- APPLIED to prod 2026-07-29 as `defend_elo`.
--
-- An agent's rank must come from BEING FOUGHT, never from farming: grind-rank
-- measures process uptime (the fleet's 20 battles/day), not skill. So every
-- profile gains a DEFEND record — held/fell counts and a defend rating — that
-- moves ONLY when a human initiates a fight against that agent:
--   · an arcade battle on a node the agent guards (the stable cast, 0026);
--   · a dare / VS-MY-AGENT match resolved from their code (ADR 0006).
--
-- HUMAN HANDS ONLY, the same two gates as tickets (0020) and ratings (0021):
-- the challenger must be neither an `agent:%` account NOR a connection that
-- declared itself an agent. The declared-connection gate is the load-bearing
-- one — without it a headless runner could grief a rival's defend record
-- overnight (grinding wins vs their agent to tank it). The gate lives
-- server-side in finishMatch; this RPC additionally refuses self-defense.
--
-- THE CHALLENGER'S OWN RATING IS NEVER TOUCHED (owner decision 2026-07-27:
-- "your Elo means your hands"). The agent rates AGAINST the challenger's
-- lifetime elo — beating a 1400 player defends more than beating a 1200 —
-- with a flat K=24: no provisional phase, because defenses arrive slowly and
-- an agent's rating should move while it still has few.
--
-- Idempotent by MATCH: unique(match_id) on `defenses` makes a settlement
-- retry structurally unable to double-count — the tickets pattern (0020).

alter table profiles
  add column if not exists defend_elo    integer not null default 1200,
  add column if not exists defend_wins   integer not null default 0,
  add column if not exists defend_losses integer not null default 0;

create table if not exists defenses (
  id            bigint generated always as identity primary key,
  agent_id      text not null references profiles(id),
  -- One defense per match, ever — the retry guard.
  match_id      text not null unique,
  -- No FK: recorded concurrently with record_match's profile upsert, and a
  -- dev-economy challenger sub may never get a row. Data, not a reference.
  challenger_id text,
  -- Did the agent HOLD (challenger lost/deviated/ragequit)?
  won           boolean not null,
  created_at    timestamptz not null default now()
);
create index if not exists defenses_agent_idx on defenses (agent_id, created_at desc);

-- Service-role only, same default-deny stance as tickets/items/referrals.
alter table defenses enable row level security;

create or replace function record_defense(
  _agent text, _match text, _challenger text, _won boolean
) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  inserted boolean;
  a_elo integer;
  c_elo integer;
  d integer;
begin
  -- Sparring is coaching, not a defense: your own hands can't rate your agent.
  if _agent is null or _match is null or _agent = _challenger then
    return false;
  end if;
  insert into public.defenses (agent_id, match_id, challenger_id, won)
  values (_agent, _match, _challenger, _won)
  on conflict (match_id) do nothing;
  get diagnostics inserted = row_count;
  if not inserted then return false; end if;

  select p.defend_elo into a_elo from profiles p where p.id = _agent;
  select p.elo into c_elo from profiles p where p.id = _challenger;
  d := elo_shift(a_elo, coalesce(c_elo, 1200),
                 case when _won then 1.0 else 0.0 end, 24);
  update profiles p
     set defend_elo = greatest(100, p.defend_elo + d),
         defend_wins = p.defend_wins + case when _won then 1 else 0 end,
         defend_losses = p.defend_losses + case when _won then 0 else 1 end,
         updated_at = now()
   where p.id = _agent;
  return true;
end $$;

revoke execute on function record_defense from public, anon, authenticated;

-- Surface the defend record everywhere agents are shown. All three are
-- create-or-replace APPENDS (trailing columns only — the 0024 rule; the
-- leaderboard's ORDER BY stays byte-identical and player_stats stays valid).

create or replace view agent_roster
with (security_invoker = true) as
select id, name, address, level, xp, wins, losses,
       win_streak(id) as streak,
       defend_elo, defend_wins, defend_losses
from profiles p
where is_agent = true and (wins + losses) > 0;

create or replace view stable
with (security_invoker = true) as
select
  p.id, p.name, p.is_agent, p.level, p.wins, p.losses,
  p.agent_config->>'character'   as character,
  p.agent_config->'personality'  as personality,
  p.agent_config->>'motto'       as motto,
  p.defend_elo, p.defend_wins, p.defend_losses
from profiles p
where p.agent_config is not null
order by p.level desc, p.name asc
limit 200;

create or replace view leaderboard
with (security_invoker = true) as
select
  p.id, p.name, p.is_agent, p.level, p.xp, p.wins, p.losses,
  rank() over (order by p.level desc, p.xp desc, p.wins desc) as rank,
  coalesce(t.tickets, 0) as tickets,
  p.elo, p.season_elo, p.rated, p.season_rated,
  p.defend_elo, p.defend_wins, p.defend_losses
from profiles p
left join (
  select tk.profile_id, count(*)::integer as tickets
    from tickets tk
   where tk.redeemed_at is null
   group by tk.profile_id
) t on t.profile_id = p.id
where (p.wins + p.losses) > 0
order by rank() over (order by p.level desc, p.xp desc, p.wins desc)
limit 100;
