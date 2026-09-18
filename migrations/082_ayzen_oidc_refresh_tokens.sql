-- 082_ayzen_oidc_refresh_tokens.sql
-- OIDC Roadmap — Season 2, Phase 3e-a/3e-b: Refresh Token Model + Expiry
-- Policy.
-- Run this once in Supabase SQL Editor. Run AFTER 081.
--
-- Scope discipline (this is 3e-a/3e-b's storage half, not 3c/3d and not
-- 3e's own "future scope" carve-out):
--   - Same "code_hash, not the raw secret" precedent as migration 080's
--     oidc_authorization_codes.code_hash and oidc_clients.client_secret_hash
--     — a refresh token is a long-lived bearer credential, so the raw value
--     is handed to the client exactly once (in the 3c/3e-c token response)
--     and never itself persisted.
--   - Bound to client_id/user_id/scopes — the same three of
--     AuthorizationCodeBinding's six bullets that still apply once a code
--     has already been exchanged; redirect_uri/code_challenge/nonce were
--     transaction-specific to the authorize step and have no equivalent
--     meaning for a token that outlives that transaction.
--   - No `consumed_at` / single-use column: unlike an authorization code
--     (3c-e, single-use by design), a refresh token is meant to be
--     presented repeatedly until it expires — 3e's own "baseline" scope
--     note ("full refresh-token rotation/introspection/revocation remains
--     future scope") is exactly the roadmap saying rotation-on-use is NOT
--     this sub-phase's job. A `revoked_at` column is included below only
--     because "reject a token whose row no longer validates" is table-
--     stakes for ANY bearer-credential table this codebase has ever
--     modeled (encryption_keys, jwt_signing_keys, api_keys all have some
--     form of it) — it is not populated by any code this phase adds, and
--     rotation logic that would set it is explicitly out of scope here.
--
-- WHY A TIMESTAMP EXPIRY, NOT A STATUS ENUM
-- Same reasoning migration 081 already gave for oidc_authorization_codes:
-- a nullable TIMESTAMP for `revoked_at` (NULL vs. NOT NULL is the only
-- state this phase's own code touches) plus a NOT NULL `expires_at` for
-- the 3e-b lifetime policy — not a `status` enum, since nothing here has
-- three or more meaningfully different states the way jwt_signing_keys did.
CREATE TABLE IF NOT EXISTS oidc_refresh_tokens (
  id SERIAL PRIMARY KEY,

  token_hash TEXT NOT NULL,                -- SHA-256 hex of the raw refresh token; raw value is never stored

  client_id TEXT NOT NULL,                 -- oidc_clients.client_id — bound client, same as the authorization code it was issued alongside
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,  -- bound user
  scopes JSONB NOT NULL DEFAULT '[]'::jsonb,        -- scopes this refresh token may be exchanged for (3e's own baseline never re-narrows this; a future refresh grant is what would enforce "no more than these scopes")

  expires_at TIMESTAMP NOT NULL,           -- 3e-b lifetime policy; see lib/oidc-refresh-tokens.ts for the TTL value and rationale
  revoked_at TIMESTAMP,                    -- nullable; see file header — not written by anything in 3e, reserved for a future revocation sub-phase
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- token_hash is the lookup key a future redemption/revocation path would
-- use — same uniqueness precedent as oidc_authorization_codes.code_hash
-- (migration 080).
CREATE UNIQUE INDEX IF NOT EXISTS oidc_refresh_tokens_token_hash_idx ON oidc_refresh_tokens(token_hash);

-- Supports a future cleanup job (delete/ignore rows past expiry), same
-- precedent as oidc_authorization_codes_expires_at_idx (migration 080).
CREATE INDEX IF NOT EXISTS oidc_refresh_tokens_expires_at_idx ON oidc_refresh_tokens(expires_at);
