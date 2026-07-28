-- Agent Fighter — ECONOMY GAUGE (ADR 0009, build step 5). Run AFTER 0026.
-- APPLIED to prod 2026-07-29 as `economy_daily_view`.
--
-- The instrument next to the faucet valve. ADR 0009 locked "steer the economy
-- with PAYOUT TABLES, not difficulty" — this is the gauge you read before
-- touching any payout number, and after. One row per UTC day per ledger
-- reason: what was minted, what was burned, net flow.
--
-- Reading it (reasons as of 2026-07-29):
--   faucets: daily (login grant) · payout (match/solo wins, arcade draws)
--            · refund (no-contests) · referral · arcade_extract (bank runs)
--   sinks:   fee (wager/solo entries — post-tickets, DECIDED wager fees stay
--            burned: fee rows with no matching payout) · arcade (run entry)
--            · gacha (vending pulls)
--
-- The two numbers that matter weekly:
--   1. net flow trending positive fast = inflation → trim exit payouts/board
--      loot (precedent: migration 0018), never fight difficulty.
--   2. burned('fee') vs minted('payout'): the wager burn's bite. If wager
--      volume collapses after the ticket cutover, it shows here first.
--
-- NOT a dashboard. This is the "run it in the SQL editor when deciding
-- whether to touch the lever" query, per the ADR's no-dashboard stance. If a
-- /house page ever exists, it reads this view; nothing else should.

create or replace view economy_daily
with (security_invoker = true) as
select
  date_trunc('day', l.created_at)::date as day,
  l.reason,
  count(*)::integer as rows,
  sum(case when l.delta > 0 then l.delta else 0 end)::integer  as minted,
  sum(case when l.delta < 0 then -l.delta else 0 end)::integer as burned,
  sum(l.delta)::integer as net
from credit_ledger l
group by 1, 2
order by day desc, net asc;
