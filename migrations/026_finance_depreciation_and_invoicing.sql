-- 026_finance_depreciation_and_invoicing.sql
-- Feature: fixed-asset depreciation schedules (mirrors finance_amortization)
-- + invoicing line items on top of 'receivable' entries (reuses the existing
-- receipt token/PDF pipeline). See lib/db/src/schema/finance.ts.

ALTER TABLE finance_assets
  ADD COLUMN IF NOT EXISTS depreciation_method TEXT,
  ADD COLUMN IF NOT EXISTS useful_life_months INTEGER,
  ADD COLUMN IF NOT EXISTS salvage_value REAL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS depreciation_start_date TIMESTAMP;

CREATE TABLE IF NOT EXISTS finance_depreciation (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  asset_id INTEGER NOT NULL,
  period_no INTEGER NOT NULL,
  period_date TIMESTAMP NOT NULL,
  depreciation_amount REAL NOT NULL DEFAULT 0,
  accumulated_depreciation REAL NOT NULL DEFAULT 0,
  book_value REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'upcoming',
  posted_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS finance_depreciation_user_idx ON finance_depreciation(user_id);
CREATE INDEX IF NOT EXISTS finance_depreciation_asset_idx ON finance_depreciation(asset_id);

CREATE TABLE IF NOT EXISTS finance_invoice_lines (
  id SERIAL PRIMARY KEY,
  entry_id INTEGER NOT NULL,
  description TEXT NOT NULL,
  quantity REAL NOT NULL DEFAULT 1,
  unit_price REAL NOT NULL DEFAULT 0,
  tax_percent REAL NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS finance_invoice_lines_entry_idx ON finance_invoice_lines(entry_id);
