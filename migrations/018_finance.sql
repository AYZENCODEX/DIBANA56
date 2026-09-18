-- 018_finance.sql
-- Finance module: Receivables/Payables/Borrowed/Lending/Investments/Assets.
-- See lib/db/src/schema/finance.ts for the full design note.

CREATE TABLE IF NOT EXISTS finance_parties (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  contact TEXT,
  notes TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS finance_parties_user_idx ON finance_parties(user_id);

CREATE TABLE IF NOT EXISTS finance_ledger_entries (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  amount REAL NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'BDT',
  party_id INTEGER,
  project_id INTEGER,
  category TEXT,
  interest_rate REAL,
  interest_paid REAL NOT NULL DEFAULT 0,
  due_date TIMESTAMP,
  occurred_date TIMESTAMP NOT NULL DEFAULT NOW(),
  status TEXT NOT NULL DEFAULT 'pending',
  notes TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS finance_ledger_user_idx ON finance_ledger_entries(user_id);
CREATE INDEX IF NOT EXISTS finance_ledger_kind_idx ON finance_ledger_entries(kind);
CREATE INDEX IF NOT EXISTS finance_ledger_project_idx ON finance_ledger_entries(project_id);
CREATE INDEX IF NOT EXISTS finance_ledger_due_idx ON finance_ledger_entries(due_date);

CREATE TABLE IF NOT EXISTS finance_repayments (
  id SERIAL PRIMARY KEY,
  entry_id INTEGER NOT NULL,
  amount REAL NOT NULL,
  is_interest INTEGER NOT NULL DEFAULT 0,
  paid_at TIMESTAMP NOT NULL DEFAULT NOW(),
  notes TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS finance_repayments_entry_idx ON finance_repayments(entry_id);

CREATE TABLE IF NOT EXISTS finance_assets (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  asset_type TEXT NOT NULL,
  name TEXT NOT NULL,
  provider TEXT,
  total_value REAL NOT NULL DEFAULT 0,
  purchased_value REAL,
  interest_rate REAL,
  purchase_date TIMESTAMP,
  maturity_date TIMESTAMP,
  liquidity TEXT,
  notes TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS finance_assets_user_idx ON finance_assets(user_id);
CREATE INDEX IF NOT EXISTS finance_assets_type_idx ON finance_assets(asset_type);

CREATE TABLE IF NOT EXISTS finance_asset_owners (
  id SERIAL PRIMARY KEY,
  asset_id INTEGER NOT NULL,
  party_id INTEGER,
  owner_name TEXT NOT NULL,
  ownership_percent REAL NOT NULL DEFAULT 100,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS finance_asset_owners_asset_idx ON finance_asset_owners(asset_id);
