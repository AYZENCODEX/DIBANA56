-- 012_otp_codes.sql
-- Run this once in Supabase SQL Editor.
--
-- Fixes: email verification / login / reset codes always coming back
-- "invalid or expired" even immediately after receiving them and after
-- resending, because codes were kept in an in-memory Map that doesn't
-- survive across the app's multiple autoscale instances. See
-- lib/otp-store.ts and lib/db/src/schema/otp-codes.ts for the full story.

CREATE TABLE IF NOT EXISTS otp_codes (
  id          SERIAL PRIMARY KEY,
  key         TEXT NOT NULL UNIQUE,
  code_hash   TEXT NOT NULL,
  expires_at  TIMESTAMP NOT NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS otp_codes_expires_at_idx ON otp_codes(expires_at);
