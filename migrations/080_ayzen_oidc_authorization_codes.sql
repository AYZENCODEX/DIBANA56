-- 080_ayzen_oidc_authorization_codes.sql
-- OIDC Roadmap — Season 2, Phase 3b-e: Code Persistence.
-- Run this once in Supabase SQL Editor. Run AFTER 079.
--
-- Phase 3a (migrations up to 079, no new migration of its own) validates an
-- `/oidc/authorize` REQUEST is well-formed. Phase 3b is the first phase that
-- needs to remember anything about a specific request across two HTTP
-- round-trips: the user gets sent to `/login` (3b-b) and comes back later
-- (3b-c) — by then the original query string is gone, so whatever gets
-- redeemed at the token endpoint (Phase 3c) has to be looked up from
-- something durable, not re-derived from a request that no longer exists.
-- This table is that record.
--
-- Scope discipline (this migration is 3b-e, not 3b-d/3c):
--   - Storage ONLY. Code GENERATION (3b-d, crypto-random) lives in
--     lib/oidc-authorization-codes.ts, not here. This table only defines
--     what a generated code gets bound to.
--   - Columns are exactly the roadmap's 3b-e list — "client; redirect URI;
--     user; scope; PKCE challenge; nonce; expiry" — nothing more. In
--     particular, there is deliberately NO "consumed"/"redeemed" column
--     yet: 3b-e's own bullet list does not include single-use tracking —
--     that is explicitly Phase 3c-e's job ("Atomically consume the code"),
--     which gets to decide HOW a code is invalidated (a status column vs.
--     deleting the row vs. something else) once it's the phase actually
--     implementing that behavior, rather than this phase guessing ahead of
--     it. Compare migration 078 (Phase 1C), which DID front-load its full
--     `status` enum in one shot — that was appropriate there because all of
--     1C's OWN states were what 1C was asked to model; here, single-use
--     consumption is a *different* sub-phase's (3c-e's) concern, so it is
--     left out on the same "no speculative implementation of future
--     phases" principle (roadmap section 1.4).
--
-- `code_hash`, not the raw code, is what's stored — same principle as
-- `api_keys.key_hash` (lib/api-key-crypto.ts) and `oidc_clients.client_secret_hash`:
-- the plaintext code is handed to the client exactly once (in the 3b-f
-- callback redirect) and never persisted anywhere. If this table were ever
-- read by anyone who shouldn't have it, they'd get unusable hashes, not a
-- live 60-second bearer credential for every in-flight login.
--
-- `redirect_uri` is stored again here (even though it's also on
-- `oidc_clients.redirect_uris`) because the roadmap's global Authorization
-- Code security rules (section 3.4) require the code to be independently
-- "bound to redirect URI" — i.e. verified again at token-exchange time
-- (Phase 3c-d) against exactly the redirect_uri THIS code was issued for,
-- not just "some URI this client has registered." Storing it on the row is
-- what makes that per-code (not just per-client) binding possible.
CREATE TABLE IF NOT EXISTS oidc_authorization_codes (
  id SERIAL PRIMARY KEY,

  code_hash TEXT NOT NULL,                 -- SHA-256 hex of the raw code; raw code is never stored

  client_id TEXT NOT NULL,                 -- oidc_clients.client_id (public identifier, e.g. "sylo") — bound client
  redirect_uri TEXT NOT NULL,              -- exact redirect_uri this code was issued for — re-checked at 3c-d, not just "any of the client's registered URIs"
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,  -- bound user — the code is meaningless without one

  scopes JSONB NOT NULL DEFAULT '[]'::jsonb,        -- validated scopes (Phase 2D) this code grants
  code_challenge TEXT NOT NULL,                     -- PKCE binding (3a-f validated format; RFC 7636 verifier check happens at 3d)
  code_challenge_method TEXT NOT NULL DEFAULT 'S256',
  nonce TEXT,                                       -- nullable — OIDC nonce binding (3a-e accepted it, this is where it's persisted); carried through to the ID token in Phase 4b

  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMP NOT NULL             -- short-lived; see lib/oidc-authorization-codes.ts for the TTL and 3b-g's expiry check
);

-- code_hash is the lookup key the (future, Phase 3c) token endpoint uses —
-- must be unique the same way jwt_signing_keys.kid / oidc_clients.client_id
-- are unique (migrations 078/079's analogous natural keys).
CREATE UNIQUE INDEX IF NOT EXISTS oidc_authorization_codes_code_hash_idx ON oidc_authorization_codes(code_hash);

-- Supports a future cleanup job (delete rows past expiry) without a full
-- table scan. Not read by any code added in this phase — added now because
-- it costs nothing on an empty table and the column it indexes already
-- exists per 3b-e's own requirements, unlike a speculative new column would.
CREATE INDEX IF NOT EXISTS oidc_authorization_codes_expires_at_idx ON oidc_authorization_codes(expires_at);
