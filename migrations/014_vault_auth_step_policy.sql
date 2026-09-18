-- 014_vault_auth_step_policy.sql
-- Run this once in Supabase SQL Editor.
--
-- Adds auth_step_policy to vault_security: governs how many of the three
-- Vault re-auth steps (1: passkey, 2: Vault PIN/password + Vault 2FA,
-- 3: email code + Vault PIN failover) must succeed to unlock Vault.
-- 'any' (default) preserves existing behavior — passing any one step
-- unlocks. 'step12' requires steps 1+2, 'step123' requires all three.
-- See routes/vault-reauth.ts and schema/vault-security.ts.

ALTER TABLE vault_security ADD COLUMN IF NOT EXISTS auth_step_policy TEXT NOT NULL DEFAULT 'any';
