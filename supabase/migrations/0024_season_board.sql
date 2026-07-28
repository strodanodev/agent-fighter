-- Agent Fighter — THE RANK VIEW (ADR 0009, build step 2). Run AFTER 0022.
--
-- Numbering note: authored as 0022 concurrently with another session's
-- `0022_leaderboard_tickets` and `0023_match_ledgers`, and renumbered to 0024
-- on merge. Applied to prod as `season_board_rank_view`.
--
-- FOLDS IN 0022's TICKETS COLUMN, as that migration asked whoever shipped the
-- seasonal rank view to do: the `leaderboard` recreate below carries `tickets`
-- AND the rating columns. Dropping either would silently un-ship the other.
--
-- ADR 0009: "the formula lives in ONE SQL view." This is that view. Reweighting
-- the ladder is then a migration, never a paired client+server deploy, and the
-- three surfaces that show standings (in-game ranks screen, landing page,
-- roster badge) cannot drift apart because none of them do rank arithmetic.
--
-- WHY A NEW VIEW INSTEAD OF RE-SORTING `leaderboard`:
-- `player_stats.rank` is a scalar subquery over `leaderboard`, and the landing
-- page reads it. Re-ordering `leaderboard` would silently re-point that column
-- at a different meaning. The two boards genuinely measure different things
-- and both are worth having:
--   · `leaderboard`  — PROGRESSION. Level/XP/W-L. "How much have you played?"
--   · `season_board` — SKILL, this season. Elo. "How good are you right now?"
-- `leaderboard` keeps its exact ordering here; it only GAINS rating columns
-- for display (create or replace view can append columns, and appending is
-- what keeps the player_stats dependency valid).
--
-- WHAT QUALIFIES. Elo is meaningless until it has converged, so a profile is
-- RANKED only after ELO_PROVISIONAL (10) rated matches this season. Everyone
-- else is still LISTED — below the ranked block, marked provisional, with a
-- NULL rank. Nobody vanishes from their own leaderboard for being new; they
-- just do not hold a position that a prize could key on.
--
-- WHY THERE IS NO IDLE DECAY (the ADR left this open; closing it here):
-- decay exists to stop an inactive player squatting a rating they can no
-- longer defend. A 21-day season that resets `season_elo` to base already
-- does exactly that, on a shorter clock than any sane decay curve. Adding
-- decay on top would also split the DISPLAYED rating from the STORED one —
-- you would watch 1300 decay to 1250, win, and jump to 1320 as the next
-- match scored off the stored value. The season reset IS the decay.
-- Revisit only if seasons ever get long.
--
-- Views inherit the caller's rights, so `security_invoker = true` keeps the
-- 2026-07-16 advisor hardening intact: this view must not become a way to
-- read `profiles` columns that RLS would otherwise withhold. It exposes the
-- same public-standing columns `leaderboard` already does — no agent_key_hash,
-- no address beyond what the roster already shows, no financial history.

create or replace view season_board
with (security_invoker = true) as
select
  p.id,
  p.name,
  p.is_agent,
  p.season                                    as season,
  p.season_elo                                as elo,
  p.season_rated                              as rated,
  p.elo                                       as lifetime_elo,
  p.level,
  p.wins,
  p.losses,
  (p.season_rated >= 10)                      as qualified,
  -- Rank WITHIN the qualified block only: `partition by` restarts the
  -- numbering for provisional rows, and the case-wrap throws that second
  -- sequence away as NULL. A provisional player has no rank, rather than a
  -- misleading one computed from an unconverged rating.
  case when p.season_rated >= 10 then
    rank() over (
      partition by (p.season_rated >= 10)
      order by p.season_elo desc, p.level desc, p.xp desc, p.wins desc
    )
  end                                         as rank
from profiles p
-- Only this season's participants. A profile carrying a stale `season` stamp
-- simply did not play this season and is not on this season's ladder — which
-- is what makes the lazy rollover in record_match sufficient (no cron).
where p.season = current_season()
  and (p.wins + p.losses) > 0
order by
  (p.season_rated >= 10) desc,
  p.season_elo desc, p.level desc, p.xp desc, p.wins desc
limit 100;

-- `leaderboard` KEEPS its ordering (progression) and only gains the rating
-- columns for display. Appending at the end is required: player_stats depends
-- on this view, and create-or-replace may only add trailing columns.
create or replace view leaderboard
with (security_invoker = true) as
select
  p.id,
  p.name,
  p.is_agent,
  p.level,
  p.xp,
  p.wins,
  p.losses,
  rank() over (order by p.level desc, p.xp desc, p.wins desc) as rank,
  coalesce(t.tickets, 0) as tickets,
  p.elo,
  p.season_elo,
  p.rated,
  p.season_rated
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
