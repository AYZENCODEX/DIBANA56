-- 107_ayzen_credit_action_pricing.sql
-- AYZEN Credits — Phase 5 admin credit console.
-- Run this once in Supabase SQL Editor. Run AFTER 106.
--
-- IDEMPOTENT — every statement is safe to re-run (IF NOT EXISTS /
-- ON CONFLICT DO NOTHING), matching every other migration in this
-- directory.
--
-- What this adds, and why it's small:
-- `services/credit-meter.ts`'s METERED_ACTIONS map already holds every
-- metered action's key/app/label/default cost as a code constant — that
-- doesn't move to the database. This migration adds only the admin
-- console's override layer on top of it (routes/admin-credit-console.ts):
--
--  1. `credit_action_pricing` — one row per action an admin has actually
--     repriced or toggled. An action with no row here just uses its code
--     default; nothing has to be pre-seeded.
--  2. `credit_transactions.action_key` — nullable column so usage debits/
--     refunds written by chargeCredits()/refundCredits() record which
--     metered action they belong to, letting the admin console's usage
--     view (GET /admin/credits/usage) aggregate real spend per action
--     without parsing the free-text `notes` column.

CREATE TABLE IF NOT EXISTS credit_action_pricing (
  id           SERIAL PRIMARY KEY,
  action_key   TEXT NOT NULL UNIQUE,
  cost         INTEGER,                          -- NULL = use the code default
  enabled      BOOLEAN NOT NULL DEFAULT true,     -- false = fee waived (cost treated as 0); never gates the action itself
  updated_by   INTEGER,                           -- admin user id who last changed this row
  created_at   TIMESTAMP NOT NULL DEFAULT now(),
  updated_at   TIMESTAMP NOT NULL DEFAULT now()
);

ALTER TABLE credit_transactions
  ADD COLUMN IF NOT EXISTS action_key TEXT;

-- Speeds up the admin console's per-action usage aggregation
-- (GROUP BY action_key WHERE type = 'usage_debit').
CREATE INDEX IF NOT EXISTS idx_credit_transactions_action_key
  ON credit_transactions (action_key)
  WHERE action_key IS NOT NULL;
