-- 011_passkeys.sql
-- Run this once in Supabase SQL Editor. Adds passkey (WebAuthn) login support.

CREATE TABLE IF NOT EXISTS passkey_credentials (
  id            SERIAL PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL,
  public_key    TEXT NOT NULL,
  counter       INTEGER NOT NULL DEFAULT 0,
  device_type   TEXT NOT NULL DEFAULT 'singleDevice',
  backed_up     BOOLEAN NOT NULL DEFAULT FALSE,
  transports    TEXT,
  name          TEXT NOT NULL DEFAULT 'Passkey',
  last_used_at  TIMESTAMP,
  created_at    TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS passkey_credentials_user_id_idx ON passkey_credentials(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS passkey_credentials_credential_id_idx ON passkey_credentials(credential_id);
