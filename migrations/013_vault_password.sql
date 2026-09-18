-- 013_vault_password.sql
-- Run this once in Supabase SQL Editor.
--
-- Adds a dedicated Vault Auth Password — separate from the account login
-- password, same pattern as the existing vault_pin_hash / entity_pin_hash /
-- vault_two_fa_secret columns. Configured on /vault/security; checked by
-- POST /vault/reauth/verify (routes/vault-reauth.ts) instead of the account
-- password once set. NULL (the default) means "not configured yet", and
-- the reauth route falls back to the account password in that case, so this
-- is backward compatible for every existing user.

ALTER TABLE vault_security ADD COLUMN IF NOT EXISTS vault_password_hash TEXT;
