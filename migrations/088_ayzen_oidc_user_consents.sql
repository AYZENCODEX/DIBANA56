-- 088_ayzen_oidc_user_consents.sql
-- OIDC Roadmap — Season 4, Phase 7a: Consent Data Model.
-- Run this once in Supabase SQL Editor. Run AFTER 087.
--
-- Season 1-3 never needed this table because every client that could ever
-- reach `/oidc/authorize` was first-party (Sylo/Ryft/Wisp/Verve/Zynth,
-- `oidc_clients.is_first_party = true`, migration 079/scripts/src/
-- seed-oidc-clients.ts) — AYZEN itself controls those apps, so there was
-- never a "does the USER trust this client" question to ask, only "is
-- this user signed in." Season 4's Phase 8 (Dynamic Client Registration,
-- later in this Season) is what first lets a THIRD-PARTY client register
-- itself (`is_first_party = false` always, per 8b's own hardcoded rule).
-- This table is what a signed-in user's decision about one such client —
-- "yes, `<client>` may have `<these scopes>`" — is durably recorded as,
-- so `/oidc/authorize` (Phase 7c, later) never has to ask a user twice
-- for the same grant, and so Phase 7d can list/revoke it later.
--
-- Scope discipline (this migration is 7a's storage half, not 7b/7c/7d/7e):
--   - Storage ONLY, exactly the roadmap's 7a column list: user_id,
--     client_id, granted_scopes, granted_at, revoked_at. No
--     "already-has-valid-consent" query, no consent-screen rendering, no
--     `/oidc/authorize` wiring, no revoke-triggered token invalidation —
--     those are 7b/7c/7d/10c, layered on top of this table once it exists,
--     the same "migration ships alone, lib file(s) built on top of it in
--     the same or a later phase" split every earlier OIDC migration in
--     this roadmap (079-087) already uses.
--   - `revoked_at` is a nullable TIMESTAMP, not a DELETE — 7a's own text
--     is explicit about why ("soft-revoke, hard delete না, যাতে audit
--     trail থাকে"). This is the same "reject a row whose state no longer
--     validates via a nullable timestamp column, never destroy the row"
--     precedent `oidc_refresh_tokens.revoked_at` (migration 082) and
--     `oidc_clients`' own soft-state columns already use in this schema —
--     not a new convention introduced here.
--   - `granted_scopes` is a JSONB array, identical shape/rationale to
--     `oidc_clients.allowed_scopes` / `oidc_authorization_codes.scopes` /
--     `oidc_refresh_tokens.scopes` (migrations 079/080/082) — this
--     roadmap's one established "scope set" column shape, not a fourth
--     variant.
--   - No FOREIGN KEY to `oidc_clients.client_id`: same precedent as
--     `oidc_authorization_codes.client_id` / `oidc_refresh_tokens.client_id`
--     (migrations 080/082, neither FK's `oidc_clients` either) — `client_id`
--     is the public identifier looked up through `lib/oidc-clients.ts`'s
--     own read path, not a relationship this schema enforces at the DB
--     layer.
--
-- WHY ONE ROW PER (user_id, client_id), NOT PER GRANT EVENT
-- 7a's own text is explicit: "একটা user-client জোড়ার জন্য একটাই active
-- consent row; নতুন/বড় scope চাইলে এটা UPDATE হয়, নতুন row না." A user's
-- consent to a given client is a single current STATE ("here is
-- everything this client may currently do on my behalf"), not a log of
-- historical grant events — `granted_scopes` on the one existing row is
-- simply replaced (widened) when Phase 7e detects a client asking for
-- scopes beyond what was already granted. The `(user_id, client_id)`
-- UNIQUE index below is what makes "UPDATE this row" (via
-- `INSERT ... ON CONFLICT (user_id, client_id) DO UPDATE`, the same
-- idiom `scripts/src/seed-oidc-clients.ts` already uses for its own
-- natural-key upserts) the only way a second grant to the same client
-- can ever be recorded, rather than accumulating duplicate rows a future
-- reader would have to de-duplicate itself.
CREATE TABLE IF NOT EXISTS oidc_user_consents (
  id SERIAL PRIMARY KEY,

  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,  -- the consenting user
  client_id TEXT NOT NULL,                          -- oidc_clients.client_id — the client this consent covers

  granted_scopes JSONB NOT NULL DEFAULT '[]'::jsonb, -- scopes this user has actually granted this client, same shape as oidc_clients.allowed_scopes

  granted_at TIMESTAMP NOT NULL DEFAULT NOW(),       -- last time this row was granted/widened (INSERT time, or the moment a 7e re-prompt was accepted)
  revoked_at TIMESTAMP,                              -- nullable; NULL = active. Set by Phase 7d's revoke action (see that phase's own header) — nothing in 7a writes to this column
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- 7a's own unique-constraint requirement: one active consent row per
-- (user_id, client_id) pair. Also the natural conflict target for the
-- "UPDATE, not new row" upsert described above.
CREATE UNIQUE INDEX IF NOT EXISTS oidc_user_consents_user_client_idx ON oidc_user_consents(user_id, client_id);

-- Supports Phase 7d's "list this user's active consents" read
-- (`WHERE user_id = $1 AND revoked_at IS NULL`) without a full table
-- scan — added now because the column already exists per 7a's own
-- requirements, same "cheap to add alongside the columns it indexes,
-- costs nothing on an empty table" precedent as every other OIDC
-- migration's trailing index in this roadmap (e.g. migration 080's
-- `oidc_authorization_codes_expires_at_idx`). Not read by any code
-- shipped in 7a itself.
CREATE INDEX IF NOT EXISTS oidc_user_consents_user_id_active_idx ON oidc_user_consents(user_id) WHERE revoked_at IS NULL;
