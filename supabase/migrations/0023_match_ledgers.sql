-- Agent Fighter — MATCH LEDGERS (ADR 0010, Phase 0). Run AFTER 0022.
--
-- APPLIED to prod 2026-07-28 (migration `match_ledgers`), AHEAD of the paired
-- server deploy — and that is safe here, unlike 0020. This migration adds a
-- table and nothing else: no RPC signature moves, no money rule changes, and
-- an older server simply never writes to it. The reverse order is safe too —
-- `saveLedger` is fire-and-forget behind its own catch, so a server deployed
-- before this table existed would log a 404 and settle the match normally.
-- RLS verified after apply: service role reads/writes; anon gets [] on select
-- and 401 on insert.
--
-- Stores the INPUT LEDGER of a settled match so it can later be replayed,
-- and so per-match statistics can be derived by re-simulation instead of
-- being reported by a client we do not trust.
--
-- WHY THIS TABLE EXISTS AT ALL
-- Since ADR 0003 the server has decided every ranked match by re-simulating
-- the full input ledger from tick 0 and deriving the winner itself. That
-- ledger is the most valuable artefact the server produces — and until now it
-- was destroyed microseconds after use (`liveMatches.delete(m.id)`). This
-- table is the whole of "Phase 0": keep the thing we already computed.
--
-- WHAT IS AND IS NOT STORED (owner's call, ADR 0010)
-- WAGER (human PvP) only. Not arcade, not solo. That is not a technical
-- limit, it is the point:
--   · arcade is 94.6% of all matches (768 of 812 measured) and is a single
--     player against a pinned AI — the least watchable material in the game;
--   · PvP runs ~4 matches/day at ~6 KB each, i.e. UNDER 10 MB/YEAR, which
--     keeps this comfortably inside the Supabase free tier. Storing
--     everything would be ~170 MB/year today and multiples of that under any
--     growth worth having.
-- Player-requested saves ("keep this replay") can be added later without
-- schema change: they are just rows this writer chose not to skip.
--
-- ACCESS: RLS ON, NO POLICIES = default deny.
-- Deliberate. The owner's rule is that watching a replay requires signing in,
-- so the ledger must NOT be readable by the anon key the public results API
-- uses. Service role bypasses RLS, so the match server can write and (later)
-- an authenticated endpoint can read. A future public/unlisted distinction
-- belongs in a policy on this table, not in a column the API layer remembers
-- to filter on — see the 2026-07-18 audit finding about `using(true)`.
--
-- NO FOREIGN KEY to matches(id), on purpose. The ledger write and
-- record_match() are independent fire-and-forget writes racing after
-- settlement; an FK would make ledger storage depend on that ordering and
-- turn a harmless race into a lost replay. `match_id` is the primary key, so
-- duplicates are still impossible.

create table if not exists match_ledgers (
  match_id      text primary key,
  -- Both input tracks, base64url, @af/core `encodeLedger` (RLE + varint).
  ledger        text        not null,
  -- Everything needed to reconstruct the match deterministically: seed,
  -- bounds, characters + bundle hashes, input delay, pinned drink loadouts,
  -- and the solo AI pin where one applies. Stored as JSON because it is read
  -- whole, by a replayer, and never queried by field.
  pin           jsonb       not null,
  -- WHICH BUILD produced it. A ledger only reproduces on the engine that
  -- recorded it, and af-core-1 → af-core-7 happened inside a fortnight, so a
  -- replay without this is unverifiable rather than merely old.
  engine        text        not null,
  protocol      integer     not null,
  -- Parse format, independent of `engine`: an old ledger stays READABLE even
  -- when it is no longer REPRODUCIBLE.
  codec_version integer     not null,
  ticks         integer     not null default 0,
  -- Canonical sha256 over (match_id, engine, protocol, codec, ledger, pin).
  -- Nothing consumes this yet. It exists now because Merkle-anchoring match
  -- results on-chain can be applied RETROACTIVELY over all history — but only
  -- if the hashes were computed from bytes we still have. One column now
  -- keeps that option open forever; omitting it closes it permanently.
  digest        text        not null,
  created_at    timestamptz not null default now()
);

create index if not exists match_ledgers_created_idx
  on match_ledgers (created_at desc);

alter table match_ledgers enable row level security;
-- No policies: anon and authenticated get nothing. This is the access control,
-- not an oversight.

comment on table match_ledgers is
  'Input ledgers of settled PvP matches (ADR 0010). Replay source of truth. RLS default-deny: service role only.';
