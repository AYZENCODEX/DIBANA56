-- 024_finance_accounting.sql
-- Finance module upgrade — Feature: Double-entry Chart of Accounts, Journal,
-- and Loan Amortization. See lib/db/src/schema/finance.ts for the full
-- design note above financeAccountsTable.

CREATE TABLE IF NOT EXISTS finance_accounts (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  normal_balance TEXT NOT NULL DEFAULT 'debit',
  parent_id INTEGER,
  is_system INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS finance_accounts_user_idx ON finance_accounts(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS finance_accounts_user_code_idx ON finance_accounts(user_id, code);

CREATE TABLE IF NOT EXISTS finance_journal_entries (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  date TIMESTAMP NOT NULL DEFAULT NOW(),
  memo TEXT NOT NULL,
  source_ledger_entry_id INTEGER,
  is_manual INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS finance_journal_entries_user_idx ON finance_journal_entries(user_id);
CREATE INDEX IF NOT EXISTS finance_journal_entries_date_idx ON finance_journal_entries(date);
CREATE INDEX IF NOT EXISTS finance_journal_entries_source_idx ON finance_journal_entries(source_ledger_entry_id);

CREATE TABLE IF NOT EXISTS finance_journal_lines (
  id SERIAL PRIMARY KEY,
  journal_entry_id INTEGER NOT NULL,
  account_id INTEGER NOT NULL,
  debit REAL NOT NULL DEFAULT 0,
  credit REAL NOT NULL DEFAULT 0,
  notes TEXT
);
CREATE INDEX IF NOT EXISTS finance_journal_lines_entry_idx ON finance_journal_lines(journal_entry_id);
CREATE INDEX IF NOT EXISTS finance_journal_lines_account_idx ON finance_journal_lines(account_id);

CREATE TABLE IF NOT EXISTS finance_amortization (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  ledger_entry_id INTEGER NOT NULL,
  installment_no INTEGER NOT NULL,
  due_date TIMESTAMP NOT NULL,
  principal_due REAL NOT NULL DEFAULT 0,
  interest_due REAL NOT NULL DEFAULT 0,
  total_due REAL NOT NULL DEFAULT 0,
  remaining_balance REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'upcoming',
  paid_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS finance_amortization_user_idx ON finance_amortization(user_id);
CREATE INDEX IF NOT EXISTS finance_amortization_entry_idx ON finance_amortization(ledger_entry_id);
