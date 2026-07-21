-- Agent Fighter — lock down public EXECUTE on standalone SECURITY DEFINER
-- stat RPCs (audit 2026-07-22; Supabase security advisor lints 0028/0029
-- "Public/Signed-In Users Can Execute SECURITY DEFINER Function").
--
-- A SECURITY DEFINER function that anon/authenticated may EXECUTE runs with the
-- definer's privileges for any unauthenticated PostgREST caller. Postgres grants
-- EXECUTE to PUBLIC by default on function creation, so this closes both the
-- default grant and the explicit anon/authenticated grants from 0010.
--
-- ONLY the functions with no app-facing caller are locked here:
--   · house_agent_stats() — called ONLY server-side with the service_role key
--     (packages/server/src/persist.ts:847). Nothing anon depends on it.
--   · rls_auto_enable()    — an admin/maintenance helper; no app code calls it.
-- service_role keeps EXECUTE (explicit grants survive a revoke from public), so
-- the server is unaffected.
--
-- DELIBERATELY NOT TOUCHED: win_streak(text). It is invoked INSIDE the
-- `agent_roster` view (0010), which is granted SELECT to anon. Because
-- win_streak is SECURITY DEFINER, a revoke of anon EXECUTE would make an anon
-- `select * from agent_roster` fail with permission denied. Leave it until the
-- roster view's access path is confirmed unused by any anon client, then revoke
-- (or convert win_streak to SECURITY INVOKER) in a follow-up.
--
-- Guarded + idempotent: only revokes functions that exist in this environment,
-- so re-running (or running against a DB that lacks a helper) never errors.

do $$
begin
  if to_regprocedure('public.house_agent_stats()') is not null then
    revoke execute on function public.house_agent_stats() from public, anon, authenticated;
  end if;
  if to_regprocedure('public.rls_auto_enable()') is not null then
    revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
  end if;
end $$;
