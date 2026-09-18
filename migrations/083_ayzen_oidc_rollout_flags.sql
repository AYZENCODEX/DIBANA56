-- 083_ayzen_oidc_rollout_flags.sql
-- OIDC Roadmap — Season 3, Phase 5c-a: Rollout Flag Storage.
-- Run this once in Supabase SQL Editor. Run AFTER 082.
--
-- Phase 5a/5b (migrations up to 082's neighbors, no new table of their own)
-- built the OIDC client library and Sylo's login/callback wiring, but every
-- unauthenticated hit on an in-scope subdomain still falls straight to the
-- old credential-form login — nothing decides, per app_id, whether OIDC is
-- actually the active login path yet. This table is that decision, stored
-- durably so it survives a restart/redeploy and is shared across every
-- running instance (not a per-process env var or in-memory flag).
--
-- Scope discipline (this migration is 5c-a, not 5c-b/5c-c/5c-d/5c-e or 5d/5e):
--   - This is storage/schema ONLY. No app code reads or writes this table
--     yet — lib/oidc-client-rollout.ts (5c-a/5c-b, same pass) is what
--     actually does, and routes/oidc-rollout-flag.ts /
--     routes/admin-oidc-rollout.ts (5c-a/5c-c) are what expose it over HTTP.
--   - `oidc_enabled` defaults to FALSE both here and in
--     lib/oidc-client-rollout.ts's own in-code fail-safe — a DB hiccup, a
--     missing row, or an unrecognized app_id must all collapse to "use the
--     old path", never "use OIDC", the same "fail-safe, not fail-open"
--     reasoning jwt_signing_keys (migration 078) and encryption_keys
--     (migration 067) each apply to their own single-active-row invariants.
--
-- One row per app_id — `sylo`, and later Ryft/Wisp/Verve/Zynth as each gets
-- its own cutover phase (see lib/oidc-cutover-gate.ts's own
-- CUTOVER_SCOPED_APP_IDS for the current, Sylo-only scope). Unlike
-- jwt_signing_keys or encryption_keys, there is no "exactly one enabled at a
-- time" invariant to enforce here — multiple app_ids can each independently
-- be `true` or `false`, since each one migrates on its own schedule.
CREATE TABLE IF NOT EXISTS oidc_client_rollout_flags (
  id SERIAL PRIMARY KEY,

  app_id TEXT NOT NULL UNIQUE,          -- e.g. "sylo" — matches oidc_clients.client_id, but no FK (see schema file's own header)
  oidc_enabled BOOLEAN NOT NULL DEFAULT FALSE,

  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- No separate CREATE INDEX on app_id — the UNIQUE constraint above already
-- creates one implicitly, and every read (routes/oidc-rollout-flag.ts's
-- public GET, on the hot path of every unauthenticated hit on an in-scope
-- subdomain) is a single equality lookup on it.
