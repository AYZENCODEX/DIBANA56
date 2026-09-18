-- 029_finance_sms_webhook.sql
-- Shared per-user token for the bank/mobile-wallet SMS auto-entry webhook.
ALTER TABLE users ADD COLUMN IF NOT EXISTS finance_sms_webhook_token TEXT UNIQUE;