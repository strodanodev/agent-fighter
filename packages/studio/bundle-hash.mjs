import { createHash } from 'node:crypto';

/**
 * Canonical SIM-ONLY view of a character bundle for the online version pin
 * (spec §3.1, ADR 0003). This is EVERYTHING the deterministic sim + the match
 * verifier read, and NOTHING cosmetic.
 *
 * Why a projection and not "hash the whole file": a Studio art pass (sprite
 * regen, portrait recrop, atlas repack, description edits) rewrites `meta` and
 * per-step `sprite` names but touches no frame data. Hashing those bumped
 * `versionHash` on every cosmetic save, and because the game host (static) and
 * the match server deploy independently, any brief skew between them then
 * failed the handshake with "bundle hash mismatch" for every refreshed
 * character — ranked play offline for cosmetic reasons (2026-07-21 outage).
 *
 * DENYLIST, not allowlist: default-include, strip only known-cosmetic fields.
 * That way a NEW sim field added to the bundle is covered by the pin
 * automatically (fail-safe for anti-cheat); the only maintenance cost is
 * remembering to strip a future cosmetic field here (fail-annoying, not
 * fail-open). Keep this list in sync with what the sim actually ignores —
 * `MoveStep.sprite` and the whole `meta` block are marked "cosmetic / never
 * read by the sim" in packages/core/src/data.ts.
 */
export const simBundleView = (bundle) => {
  const b = structuredClone(bundle);
  delete b.versionHash; // the hash field itself
  delete b.meta;        // Studio-only: portrait framing, atlas/palette refs, desc, disabled flag
  if (Array.isArray(b.moves)) {
    for (const mv of b.moves) {
      if (Array.isArray(mv?.steps)) for (const s of mv.steps) delete s.sprite; // cosmetic atlas key
    }
  }
  return b;
};

/** sha256 (first 16 hex chars) of the canonical sim view — the pinned `versionHash`. */
export const bundleHash = (bundle) =>
  createHash('sha256').update(JSON.stringify(simBundleView(bundle))).digest('hex').slice(0, 16);
