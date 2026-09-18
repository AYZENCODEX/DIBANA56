-- 035_ayzen_email_verification.sql
-- Bug fix: POST /ayzen-email/claim (routes/email-routing.ts) treated Cloudflare
-- as optional — if the Cloudflare API call failed, or was never configured, the
-- username@ayzen.tech address was still saved to users.ayzen_email as if it
-- worked ("soft failure"). Worse, even when the Cloudflare call *succeeded*,
-- Cloudflare Email Routing rules that forward to an unverified destination
-- address stay silently disabled until that address is verified by email —
-- so "claimed" addresses often never actually delivered mail.
--
-- The fixed claim flow now: reads Cloudflare credentials from the admin
-- "Cloudflare Email" plugin config (routes/plugins.ts) instead of only
-- CLOUDFLARE_API_KEY, hard-fails the claim (no DB write) if the Cloudflare
-- rule can't be created, and creates/checks the account-level destination
-- address so real verification state is tracked instead of assumed.
ALTER TABLE users ADD COLUMN IF NOT EXISTS ayzen_email_verified BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS ayzen_email_forward_to TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS ayzen_email_cf_rule_id TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS ayzen_email_cf_address_id TEXT;
