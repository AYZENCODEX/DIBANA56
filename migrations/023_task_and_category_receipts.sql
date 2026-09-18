-- 023_task_and_category_receipts.sql
-- Public, shareable "receipt" links — same pattern as
-- migrations/021_finance_receipt.sql / 022_entity_receipts.sql —
-- extended to two more surfaces:
--   1. Task Submission (task_submissions) → task name/project/task number/cost/profit card
--   2. Vault Category   (per user, per category) → count/avg age/avg follower/PnL aggregate card
-- See artifacts/api-server/src/routes/tasks.ts, routes/local-accounts.ts,
-- and artifacts/api-server/src/lib/receipt-theme.ts.

ALTER TABLE task_submissions ADD COLUMN IF NOT EXISTS receipt_token TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS task_submissions_receipt_token_idx
  ON task_submissions(receipt_token)
  WHERE receipt_token IS NOT NULL;

-- Vault Category receipts aren't a column on one row — they're an aggregate
-- snapshot of a (user, category) pair across every local_accounts row in
-- that category, so they get their own small table instead of an ALTER.
-- One active token per (user_id, category); minting again while one exists
-- returns the same token (mirrors the idempotent mint behaviour on the
-- other receipt types) until it's revoked (row deleted).
CREATE TABLE IF NOT EXISTS vault_category_receipts (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  category TEXT NOT NULL,
  receipt_token TEXT NOT NULL UNIQUE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS vault_category_receipts_user_category_idx
  ON vault_category_receipts(user_id, category);
