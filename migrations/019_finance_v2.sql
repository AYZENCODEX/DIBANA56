-- 019_finance_v2.sql
-- Finance module v2: Recurring engine, Budgets, Multi-currency, Due-date reminders.
-- See lib/db/src/schema/finance.ts for the full design note.

ALTER TABLE finance_ledger_entries ADD COLUMN IF NOT EXISTS reminded_at TIMESTAMP;
ALTER TABLE finance_ledger_entries ADD COLUMN IF NOT EXISTS recurring_rule_id INTEGER;
CREATE INDEX IF NOT EXISTS finance_ledger_recurring_idx ON finance_ledger_entries(recurring_rule_id);

CREATE TABLE IF NOT EXISTS finance_recurring_rules (
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
  frequency TEXT NOT NULL DEFAULT 'monthly',
  interval_count INTEGER NOT NULL DEFAULT 1,
  start_date TIMESTAMP NOT NULL DEFAULT NOW(),
  next_run_date TIMESTAMP NOT NULL DEFAULT NOW(),
  end_date TIMESTAMP,
  active INTEGER NOT NULL DEFAULT 1,
  last_run_at TIMESTAMP,
  notes TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS finance_recurring_user_idx ON finance_recurring_rules(user_id);
CREATE INDEX IF NOT EXISTS finance_recurring_next_run_idx ON finance_recurring_rules(next_run_date);

CREATE TABLE IF NOT EXISTS finance_budgets (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  category TEXT NOT NULL,
  monthly_limit REAL NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS finance_budgets_user_idx ON finance_budgets(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS finance_budgets_user_category_idx ON finance_budgets(user_id, category);

CREATE TABLE IF NOT EXISTS finance_currency_rates (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  currency TEXT NOT NULL,
  rate_to_base REAL NOT NULL DEFAULT 1,
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS finance_currency_rates_user_currency_idx ON finance_currency_rates(user_id, currency);
