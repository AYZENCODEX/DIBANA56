-- 021_finance_receipt.sql
-- Finance module upgrade — Feature: public, shareable receipt per ledger
-- entry (view page + downloadable PDF). See lib/db/src/schema/finance.ts
-- for the full design note on finance_ledger_entries.receipt_token.

ALTER TABLE finance_ledger_entries ADD COLUMN IF NOT EXISTS receipt_token TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS finance_ledger_entries_receipt_token_idx
  ON finance_ledger_entries(receipt_token)
  WHERE receipt_token IS NOT NULL;
