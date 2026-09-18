-- 079_ayzen_oidc_clients.sql
-- OIDC Roadmap — Season 1, Phase 2A: Client registry table design + migration.
-- Run this once in Supabase SQL Editor. Run AFTER 078.
--
-- Phase 1 (1a-1e, migrations up to 078) built the crypto foundation — RS256
-- signing, key rotation, JWKS, OIDC discovery. None of that is usable for an
-- actual Authorization Code + PKCE flow without a trusted registry of WHO is
-- allowed to ask for a token: which client_ids exist, which redirect_uris
-- each one may send a user back to, and which scopes each one may request.
-- Today there is no such registry — every first-party app (Sylo, Ryft, Wisp,
-- Verve, Zynth) rides the old shared httpOnly cookie across *.ayzen.tech
-- instead. This table is the first piece of replacing that: pure storage,
-- no login flow, no validation logic yet.
--
-- Scope discipline (this migration is Phase 2A, not 2B/2C/2D/2E):
--   - This is storage/schema ONLY. No seed rows (2B seeds Sylo/Ryft/Wisp/
--     Verve/Zynth as first-party clients), no repository/data-access layer
--     (2A-c), no client/redirect-uri validation (2C), no scope validation
--     (2D), no unified validator (2E). /oidc/authorize does not read this
--     table yet.
--   - Confidential vs. public clients: `client_secret_hash` is nullable.
--     A first-party client using Authorization Code + PKCE (required for
--     all first-party clients per the roadmap's global security
--     requirements) does not strictly need a client secret — PKCE is the
--     proof of possession. Leaving the column nullable lets 2B seed either
--     kind without a schema change; it does not decide which kind Sylo etc.
--     will actually be — that's a 2B decision.
--   - `redirect_uris` and `allowed_scopes` are stored as JSONB arrays, not
--     native Postgres arrays (`TEXT[]`) — matching the existing
--     `api_keys.scopes` precedent (migration for that table) rather than
--     introducing a new array-typed column style into this codebase.
CREATE TABLE IF NOT EXISTS oidc_clients (
  id SERIAL PRIMARY KEY,

  client_id TEXT NOT NULL,                 -- public identifier, e.g. "sylo"
  client_secret_hash TEXT,                 -- NULL for public/PKCE-only clients; hashed, never plaintext

  redirect_uris JSONB NOT NULL DEFAULT '[]'::jsonb,   -- exact-match allow-list, validated starting Phase 2C
  allowed_scopes JSONB NOT NULL DEFAULT '[]'::jsonb,  -- validated starting Phase 2D

  is_first_party BOOLEAN NOT NULL DEFAULT FALSE,

  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- client_id is the lookup key every future authorize/token request will use
-- (2C's "reject unknown client_id"); it must be unique the same way
-- jwt_signing_keys.kid is unique (migration 078's analogous natural key).
CREATE UNIQUE INDEX IF NOT EXISTS oidc_clients_client_id_idx ON oidc_clients(client_id);
