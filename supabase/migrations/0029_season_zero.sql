-- Agent Fighter — SEASON 0: OPEN BETA (owner decision 2026-07-29). Run AFTER 0028.
-- APPLIED to prod 2026-07-29 as `season_zero_open_beta`.
--
-- The owner will pick season 1's start date AFTER 2026-08-17. Until then the
-- current period is "SEASON 0 · OPEN BETA", and the season clock is FROZEN:
-- current_season() returns 0 unconditionally.
--
-- This is not only messaging. 0021's 21-day placeholder arithmetic would have
-- rolled season 1 → 2 on Aug 17 and the lazy rollover would have RESET every
-- accrued season rating mid-beta — a season boundary nobody decided. Freezing
-- the clock makes "when does season 1 start?" an explicit owner decision (a
-- later migration restores epoch arithmetic anchored at the chosen date,
-- returning >= 1; the lazy rollover in record_match then re-bases everyone on
-- their first match of season 1, exactly as designed).
--
-- Everything accrued SO FAR happened in the beta, so existing season stamps
-- (written as 1 under the placeholder) are RENUMBERED to 0 — ratings and
-- rated counts are PRESERVED, only the stamp changes. Without this, the
-- rollover would see stamp 1 ≠ current 0 and wipe the beta ladder on the
-- next match. Beta-minted tickets are season-0 tickets for the same reason.

create or replace function current_season()
returns smallint
language sql stable set search_path = public as $$
  select 0::smallint;
$$;

update profiles set season = 0 where season = 1;
update tickets  set season = 0 where season = 1;
