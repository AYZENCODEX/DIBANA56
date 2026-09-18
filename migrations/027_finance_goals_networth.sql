-- 027_finance_goals_networth.sql
-- Feature: financial goals tracker + monthly net worth snapshots/trend.
-- See lib/db/src/schema/finance.ts and lib/finance-networth.ts.

CREATE TABLE IF NOT EXISTS finance_goals (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  goal_type TEXT NOT NULL DEFAULT 'savings',
  target_amount REAL NOT NULL DEFAULT 0,
  current_amount REAL NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'BDT',
  target_date TIMESTAMP,
  linked_asset_id INTEGER,
  status TEXT NOT NULL DEFAULT 'active',
  notes TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS finance_goals_user_idx ON finance_goals(user_id);
CREATE INDEX IF NOT EXISTS finance_goals_linked_asset_idx ON finance_goals(linked_asset_id);

CREATE TABLE IF NOT EXISTS finance_net_worth_snapshots (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  snapshot_date TIMESTAMP NOT NULL DEFAULT NOW(),
  net_worth REAL NOT NULL DEFAULT 0,
  total_assets REAL NOT NULL DEFAULT 0,
  total_receivable REAL NOT NULL DEFAULT 0,
  total_payable REAL NOT NULL DEFAULT 0,
  total_borrowed REAL NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS finance_net_worth_snapshots_user_idx ON finance_net_worth_snapshots(user_id);
-- One snapshot per user per calendar month — a re-run (manual or cron retry)
-- within the same month updates the existing point instead of duplicating it.
CREATE UNIQUE INDEX IF NOT EXISTS finance_net_worth_snapshots_user_month_idx
  ON finance_net_worth_snapshots(user_id, date_trunc('month', snapshot_date));
