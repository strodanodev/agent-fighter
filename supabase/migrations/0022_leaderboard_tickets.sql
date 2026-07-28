-- Agent Fighter — TICKETS on the leaderboard. Run AFTER 0021 (elo).
--
-- Numbering note: this was authored as 0021 concurrently with the ELO work
-- and renumbered to 0022 on merge. Applied to prod as
-- `leaderboard_tickets_column`, AFTER `elo_ratings_and_seasons_*`. ELO
-- deliberately left the leaderboard view alone ("ratings are additive and
-- invisible until the rank views ship"), so appending `tickets` here clobbers
-- nothing — but whoever ships the seasonal rank view must fold BOTH in.
--
-- Owner decision 2026-07-27, CONSOLIDATED: tickets are a **COSMETIC
-- COLLECTIBLE IN PHASE A** — no redemption catalog, no prize, no cash-out
-- today; the reward for winning a wager is a number next to your name. That
-- simplifies everything the ADR worried about *for now*: with nothing to
-- redeem, farming buys only bragging rights and the legal posture is a plain
-- skill contest with a credit sink.
--
-- PHASE B (intended, unscheduled) makes tickets REDEEMABLE for esports
-- qualification seats and other non-cash prizes. This migration is unaffected
-- either way — it adds a display column — but note that the farming defences
-- this file calls unnecessary (mint cap, Elo banding) become load-bearing
-- again the moment a catalog opens. An earlier draft of this note said
-- cosmetic "ever"; see ADR 0009's consolidated amendment.
--
-- TICKETS DO NOT AFFECT RANK. The window function's ORDER BY is untouched
-- (level, xp, wins) — this is a DISPLAY column only. Currency is not status:
-- rank stays a measure of play, or the ladder becomes "who wagered most".
--
-- `create or replace view` may only APPEND columns, so `tickets` lands after
-- `rank` rather than in a prettier spot. The client reads by key, so the
-- column order in the JSON is irrelevant.
--
-- NOTE ON security_invoker (kept from the advisor hardening): the count is
-- exact for SERVICE-ROLE readers, which is the only real consumer — the match
-- server's GET /leaderboard. `tickets` is RLS default-deny, so a hypothetical
-- ANON reader of this view gets 0 for everyone rather than an error. That is
-- deliberate: exposing the raw tickets table to anon would repeat the
-- 2026-07-18 audit finding (a `using(true)` policy leaks whole rows, and a
-- view is not column security). If an anon consumer is ever needed, add a
-- SECURITY DEFINER counter and grant EXECUTE on it — the `win_streak`
-- pattern that `agent_roster` already uses — rather than opening the table.

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
  coalesce(t.tickets, 0)::integer as tickets
from profiles p
left join (
  select tk.profile_id, count(*)::integer as tickets
  from tickets tk
  where tk.redeemed_at is null
  group by tk.profile_id
) t on t.profile_id = p.id
where (p.wins + p.losses) > 0
order by rank
limit 100;

notify pgrst, 'reload schema';
