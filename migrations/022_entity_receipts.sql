-- 022_entity_receipts.sql
-- Public, shareable "receipt" links — same pattern as
-- migrations/021_finance_receipt.sql (finance_ledger_entries.receipt_token)
-- — extended to three more surfaces:
--   1. Local Entity  (local_accounts)      → username/follower/age/price/PnL card
--   2. Vault Entity  (vault_entries)       → username/follower/age/worth/PnL card
--   3. Project P&L   (per user, per project) → aggregate cost/profit/ROI card
-- See artifacts/api-server/src/routes/local-accounts.ts, routes/vault.ts,
-- routes/projects.ts and artifacts/api-server/src/lib/receipt-theme.ts.

ALTER TABLE local_accounts ADD COLUMN IF NOT EXISTS receipt_token TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS local_accounts_receipt_token_idx
  ON local_accounts(receipt_token)
  WHERE receipt_token IS NOT NULL;

ALTER TABLE vault_entries ADD COLUMN IF NOT EXISTS receipt_token TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS vault_entries_receipt_token_idx
  ON vault_entries(receipt_token)
  WHERE receipt_token IS NOT NULL;

-- Project P&L receipts aren't a column on one row — they're a snapshot of a
-- (user, project) pair's aggregate ROI ledger (entity_project_roi), so they
-- get their own small table instead of an ALTER. One active token per
-- (user_id, project_id); minting again while one exists returns the same
-- token (mirrors the idempotent mint behaviour on the other two receipt
-- types) until it's revoked (row deleted).
CREATE TABLE IF NOT EXISTS project_pnl_receipts (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  project_id INTEGER NOT NULL,
  receipt_token TEXT NOT NULL UNIQUE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS project_pnl_receipts_user_project_idx
  ON project_pnl_receipts(user_id, project_id);
