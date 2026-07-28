# Migrations — numbering and apply rules

**The file number is a REPO ORDERING HINT, not the applied identity.** Supabase
tracks migrations by timestamp + snake_case name (`list_migrations` / the
`supabase_migrations` table); the `00NN_` prefix exists only so humans read the
directory in order. Every file's header records the name(s) it was applied
under when they differ.

## Before picking a number

`ls` this directory first. Concurrent sessions have collided three times
(0017×2, 0018×2, and 0022/0023 both taken while 0024 was being authored as
0022 — renumbered on merge). Numbers may be duplicated in history — do NOT
renumber old files to "fix" it; applied names are what production knows, and
rewriting them breaks the paper trail.

## Before applying anything that touches `record_match` (or any live RPC)

1. **Does the ARGUMENT LIST change?** Then deployed callers 404/fail → it
   ships only inside the paired Railway+Vercel window (the 0020 case: it also
   changed what money DOES).
2. **Only the return table gains columns / body changes rules-neutrally?**
   Safe to apply ahead of any deploy — `persist.ts` maps columns by name and
   no caller does `select=*` on `profiles` (verified 2026-07-27, the 0021
   case). Confirm both properties again before assuming.
3. **Either way:** `notify pgrst, 'reload schema';` after a signature change,
   or the first callers get a 404 (the 0017/ef753c8 lesson).
4. **Smoke-test money/rating rules on real Postgres** — a TS mirror cannot
   catch a SQL-only bug (`NULL = s`, 0002). Reusable scripts live in
   `../smoke/`; namespace throwaway rows (`smoke:*`) and delete them.

## View rules

- `leaderboard` may only GAIN trailing columns (`create or replace view`
  appends only), and its ORDER BY is load-bearing: `player_stats.rank` is a
  scalar subquery over it and the landing site reads that. The Elo ladder is
  the separate `season_board` view — do not merge them.
- New views: `with (security_invoker = true)` (advisor hardening, 2026-07-16).
