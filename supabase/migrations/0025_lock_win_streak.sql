-- Agent Fighter — close the last anon-executable SECURITY DEFINER function.
-- Run AFTER 0024. APPLIED to prod 2026-07-27 as `lock_win_streak_definer`.
--
-- Finishes the job 0019_lock_definer_rpcs.sql started. That migration locked
-- house_agent_stats() and rls_auto_enable() but DELIBERATELY left
-- win_streak(text) open, with a written condition for closing it later:
--
--   "It is invoked INSIDE the `agent_roster` view (0010), which is granted
--    SELECT to anon. Because win_streak is SECURITY DEFINER, a revoke of anon
--    EXECUTE would make an anon `select * from agent_roster` fail with
--    permission denied. Leave it until the roster view's access path is
--    confirmed unused by any anon client, then revoke."
--
-- THAT CONDITION IS NOW CONFIRMED (2026-07-27):
--  · win_streak's ONLY caller anywhere is the agent_roster view.
--  · agent_roster's ONLY reader is packages/server/src/persist.ts, which
--    calls PostgREST with the SERVICE-ROLE key.
--  · the anon-key consumers are the landing site (landing/lib/*), and they
--    read exactly three relations — ask_leads, leaderboard, player_stats.
--    None of them reaches agent_roster, and none of them calls win_streak.
--    (The in-game standings screen does NOT count: it goes through the match
--    server's own HTTP endpoints, never Supabase directly.)
-- So there is no anon path left to break.
--
-- WHY REVOKE RATHER THAN CONVERT TO SECURITY INVOKER (0019 offered both):
-- win_streak reads `matches`, which is not anon-readable. Converting to
-- INVOKER would leave the function callable but always failing for anon —
-- a worse outcome than an honest permission error, and it would keep the
-- function on the exposed API surface for no benefit.
--
-- service_role keeps EXECUTE: explicit grants survive a revoke from public.
-- Verified after applying: agent_roster still resolves for the service role,
-- and the advisor's 0028/0029 warnings for this function are gone.
--
-- Guarded so re-running (or running against a DB that lacks the helper)
-- never errors — same stance as 0019.

do $$
begin
  if to_regprocedure('public.win_streak(text)') is not null then
    revoke execute on function public.win_streak(text) from public, anon, authenticated;
  end if;
end $$;
