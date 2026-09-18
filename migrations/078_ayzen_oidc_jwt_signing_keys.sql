-- 078_ayzen_oidc_jwt_signing_keys.sql
-- OIDC Roadmap — Season 1, Phase 1C: Multi-key storage/schema.
-- Run this once in Supabase SQL Editor. Run AFTER 077.
--
-- Phase 1A/1B (lib/jwt-keys.ts, lib/jwt.ts) moved session-token signing from
-- HS256 to RS256 against a SINGLE active keypair resolved from
-- AYZEN_JWT_PRIVATE_KEY / AYZEN_JWT_PUBLIC_KEY / AYZEN_JWT_KID — there was no
-- durable record of any key beyond "whatever's in the env right now". That's
-- fine for signing (there's only ever one signer) but breaks the moment a
-- keypair rotates: any token signed under the OLD kid becomes unverifiable
-- the instant the env var flips, logging out every in-flight session rather
-- than letting them expire naturally (up to 7d, see lib/jwt.ts).
--
-- This table is that durable record — PUBLIC keys only, one row per kid,
-- so a rotation can keep retiring keys around for a grace window instead of
-- dropping verification ability the moment a new key goes active. The
-- PRIVATE key is deliberately never stored here (or anywhere in the DB) —
-- it stays a single active env var, same as today; this table only ever
-- holds what's needed to *verify*, never to *sign*.
--
-- Scope discipline (this migration is 1C, not 1D):
--   - This is storage/schema ONLY. No rotation trigger, no rotation policy
--     (how long a "retiring" key stays valid before removal), and no app
--     code reads or writes this table yet — lib/jwt-keys.ts's
--     getActiveKeypair() is untouched, still env-var-only. All of that is
--     Phase 1D (getVerificationKeys(kid?) and the rotation trigger itself).
--   - This is also NOT the JWKS/.well-known publishing endpoint — that's
--     Phase 1E, and it will read from this table once 1D is wiring writes
--     into it.
--
-- `status` models the overlap window a rotation needs:
--   'active'   — the key currently signing new tokens. Exactly one at a
--                time (enforced below) — must always match AYZEN_JWT_KID.
--   'retiring' — no longer signs anything new, but still valid for
--                verification so tokens already issued under it don't
--                break. Phase 1D decides how long a key stays here.
--   'retired'  — no longer valid for verification either. Row is kept
--                (never deleted) purely as an audit trail of what existed.
CREATE TABLE IF NOT EXISTS jwt_signing_keys (
  id SERIAL PRIMARY KEY,

  kid TEXT NOT NULL UNIQUE,        -- matches the JWT header's `kid` claim
  public_key TEXT NOT NULL,        -- PEM, SPKI — verification only, never a private key
  algorithm TEXT NOT NULL DEFAULT 'RS256',

  status TEXT NOT NULL DEFAULT 'active',

  retiring_at TIMESTAMP,           -- set when the key stops signing new tokens
  retired_at TIMESTAMP,            -- set when the key stops verifying tokens too

  created_at TIMESTAMP NOT NULL DEFAULT NOW(),

  CONSTRAINT jwt_signing_keys_status_ck
    CHECK (status IN ('active', 'retiring', 'retired')),

  -- State timestamps must be consistent with status — can't be "retiring"
  -- without a retiring_at, can't be "retired" without a retired_at, and an
  -- "active" key hasn't retired at all yet.
  CONSTRAINT jwt_signing_keys_retiring_at_ck
    CHECK ((status = 'active') = (retiring_at IS NULL)),
  CONSTRAINT jwt_signing_keys_retired_at_ck
    CHECK ((status = 'retired') = (retired_at IS NOT NULL))
);

-- Verification-path lookups (Phase 1D) filter by status ("give me every
-- active+retiring key") far more often than they look up a single kid.
CREATE INDEX IF NOT EXISTS jwt_signing_keys_status_idx ON jwt_signing_keys(status);

-- Exactly one row can be 'active' at a time — that's the one AYZEN_JWT_KID
-- must match. Same "single active row" guarantee encryption_keys has per
-- namespace (migration 067's neighbor constraint, enforced there via
-- loadKeyManager()'s UPDATE-then-INSERT instead of a DB constraint since
-- that table is scoped by namespace); here there's only one signer overall,
-- so a partial unique index enforces it outright rather than relying on
-- Phase 1D's write path to always get the UPDATE-before-INSERT order right.
CREATE UNIQUE INDEX IF NOT EXISTS jwt_signing_keys_single_active
  ON jwt_signing_keys ((true))
  WHERE status = 'active';

-- Same append-only discipline as encryption_keys (migration 067) and
-- vault_backup_audit_log (migration 073): a retained-key history that can
-- be deleted defeats the point of keeping it. Status moves forward
-- (active -> retiring -> retired) via UPDATE, which trigger allows; only
-- DELETE is blocked.
CREATE OR REPLACE FUNCTION prevent_jwt_signing_keys_delete()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'jwt_signing_keys rows are never deleted — kid=% may still be needed to verify in-flight tokens or as rotation history. See migration 078.', OLD.kid;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_prevent_jwt_signing_keys_delete ON jwt_signing_keys;
CREATE TRIGGER trg_prevent_jwt_signing_keys_delete
  BEFORE DELETE ON jwt_signing_keys
  FOR EACH ROW
  EXECUTE FUNCTION prevent_jwt_signing_keys_delete();
