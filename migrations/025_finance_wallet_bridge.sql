-- 025_finance_wallet_bridge.sql
-- Wallet↔Finance bridge — confirmed on-chain vault deposits and outbound
-- wallet withdrawals auto-post as Finance ledger entries (which in turn
-- auto-post double-entry journal lines via lib/finance-accounting.ts).
-- See lib/finance-wallet-bridge.ts for the posting logic.

ALTER TABLE finance_ledger_entries
  ADD COLUMN IF NOT EXISTS source_chain_deposit_id INTEGER,
  ADD COLUMN IF NOT EXISTS source_wallet_tx_hash TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS finance_ledger_entries_source_deposit_idx
  ON finance_ledger_entries(source_chain_deposit_id) WHERE source_chain_deposit_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS finance_ledger_entries_source_tx_idx
  ON finance_ledger_entries(source_wallet_tx_hash) WHERE source_wallet_tx_hash IS NOT NULL;

ALTER TABLE wallets
  ADD COLUMN IF NOT EXISTS auto_finance_sync BOOLEAN NOT NULL DEFAULT TRUE;
