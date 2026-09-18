-- 015_digest_frequency.sql
-- Adds per-user vault/dashboard digest delivery preference.
-- The health scan itself now runs every 6h (see vault-health-cron.ts /
-- VAULT_HEALTH_SCAN_CRON default change) so flags stay fresh regardless;
-- these columns only gate how often the user actually gets pinged
-- (Telegram + email) so a "daily" or "weekly" user isn't messaged every 6h.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS digest_frequency text NOT NULL DEFAULT 'daily',
  ADD COLUMN IF NOT EXISTS last_digest_sent_at timestamp;

-- No DB-level CHECK constraint (kept idempotent for the startup-migration
-- array in index.ts, which applies this same statement automatically on
-- every boot). Valid values ("daily" | "weekly" | "monthly") are enforced
-- in routes/digest-settings.ts instead.
