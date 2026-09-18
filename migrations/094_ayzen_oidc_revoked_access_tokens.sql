-- 094_ayzen_oidc_revoked_access_tokens.sql
-- OIDC Roadmap — Season 5, Phase 10b: Revocation Endpoint (RFC
-- 7009-scoped-down) — access-token half.
-- Run this once in Supabase SQL Editor. Run AFTER 093.
--
-- WHY THIS TABLE HAS TO EXIST AT ALL
-- An OIDC access token (`lib/oidc-access-token.ts`) is a self-contained,
-- stateless RS256 JWT — nothing about it is persisted anywhere at issuance
-- time (unlike a refresh token, migration 082, which is a DB row from the
-- moment it's minted). `verifyOidcAccessToken()` (Phase 4c-a) proves a
-- presented token is genuinely ours, unexpired, and correctly signed
-- PURELY from the JWT's own bytes — no DB read. That is exactly why
-- `POST /oidc/revoke` (10b) cannot "delete" an access token the way
-- `revokeRefreshTokenByHash()` (this Season, `lib/oidc-refresh-tokens.ts`)
-- deletes/updates a refresh token's row: there is no row. The only way to
-- make a still-cryptographically-valid access token stop verifying as
-- active is a DENYLIST — record that this specific token's hash must now
-- be treated as revoked, and have every live verification path consult it.
--
-- `token_hash`, NOT THE RAW TOKEN — same "never persist the bearer secret
-- itself" precedent `oidc_refresh_tokens.token_hash` (082) and
-- `oidc_authorization_codes.code_hash` (080) already established. SHA-256
-- hex, same algorithm, computed by `hashOidcAccessToken()`
-- (`lib/oidc-token-revocation.ts`, this pass) — a NEW hash helper, not
-- `hashRefreshToken()` reused, for the same "one small helper per file,
-- scoped to the one secret that file owns" precedent every earlier
-- hash-a-bearer-secret file in this roadmap already follows
-- (`hashRefreshToken()`, `hashAuthorizationCode()`, `hashClientSecret()`).
--
-- `expires_at` IS THE ACCESS TOKEN'S OWN `exp` CLAIM, NOT "when this row
-- expires from being written" — copied straight from the token being
-- revoked (`verifyOidcAccessToken()`'s already-decoded `exp`, Phase 10a's
-- own addition to `VerifiedOidcAccessToken`) at the moment `/oidc/revoke`
-- writes this row. This bounds the denylist's USEFUL lifetime to exactly
-- the token's own remaining 60-minute (`ACCESS_TOKEN_TTL_SECONDS`) TTL —
-- once real time passes `expires_at`, `verifyOidcAccessToken()` itself
-- already rejects the token as `"expired"` before any denylist lookup
-- would even run, so a row past its own `expires_at` is provably dead
-- weight. Supports a future cleanup job (delete rows past `expires_at`),
-- same precedent `oidc_refresh_tokens_expires_at_idx` (082) and
-- `oidc_authorization_codes_expires_at_idx` (080) already set — no such
-- job is added in this pass, same "index now, sweep later" posture those
-- two tables already took before Phase 6e-c's queue-sweep pattern existed
-- for anything else in this roadmap.
--
-- `client_id`/`user_id` ARE NOT THE LOOKUP KEY (`token_hash` is, alone) —
-- they're carried only as denormalized audit/debugging context (same
-- role `oidc_client_admin_audit_log`'s `before`/`after` columns play:
-- useful to a human reading the table, never consulted by the one real
-- read path, `isAccessTokenRevoked()`'s `WHERE token_hash = $1`).
-- `client_id` is deliberately NOT a foreign key into `oidc_clients` — same
-- precedent `oidc_authorization_codes`/`oidc_refresh_tokens`/
-- `oidc_user_consents`/`oidc_client_admin_audit_log` (080/082/088/093)
-- already establish, for the identical reason 093's own header gives: a
-- revoked-token row for a since-deleted client (Phase 9c) must still be
-- writable and readable. `user_id` IS a real FK (`users(id) ON DELETE
-- CASCADE`) — same choice `oidc_refresh_tokens.user_id` already makes,
-- for the identical reason: a deleted user's own revoked-token rows have
-- no remaining purpose (there's no account left to protect), unlike a
-- deleted-client row (a `client_id` we may still want to reason about
-- after the fact, per 093's own audit-log argument above).
--
-- NO `revoked_at IS NULL` PARTIAL/SOFT-DELETE SHAPE — unlike
-- `oidc_refresh_tokens.revoked_at` (nullable, "is this row still live")
-- this table's own `revoked_at` is NOT NULL DEFAULT NOW(): a row's mere
-- EXISTENCE is the revocation (this table has no other state a row could
-- be in — nothing here is ever un-revoked). `revoked_at` is kept anyway,
-- NOT NULL, purely as a "when did this happen" audit timestamp, the same
-- role `created_at` plays on every other table in this roadmap.
CREATE TABLE IF NOT EXISTS oidc_revoked_access_tokens (
  id SERIAL PRIMARY KEY,

  token_hash TEXT NOT NULL,                -- SHA-256 hex of the raw access token JWT; raw value is never stored

  client_id TEXT NOT NULL,                 -- oidc_clients.client_id the revoked token was minted for — audit context only, see header for why this is NOT an FK
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,  -- the token's own `sub` — audit context only, not part of the lookup key

  expires_at TIMESTAMP NOT NULL,           -- copied from the revoked token's own `exp` claim, see header
  revoked_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- The one real read path (`isAccessTokenRevoked()`) and the one real
-- write path (`persistRevokedAccessToken()`'s `ON CONFLICT (token_hash)
-- DO NOTHING`, `lib/oidc-token-revocation.ts`) both key on `token_hash`
-- alone — same uniqueness precedent as `oidc_refresh_tokens_token_hash_idx`
-- (082) and `oidc_authorization_codes_code_hash_idx` (080).
CREATE UNIQUE INDEX IF NOT EXISTS oidc_revoked_access_tokens_token_hash_idx ON oidc_revoked_access_tokens(token_hash);

-- Supports a future cleanup job — see header's `expires_at` note.
CREATE INDEX IF NOT EXISTS oidc_revoked_access_tokens_expires_at_idx ON oidc_revoked_access_tokens(expires_at);
