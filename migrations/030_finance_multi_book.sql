-- 030_finance_multi_book.sql
-- Phase 3 "Multi-book" — Business vs Personal separate ledgers (multiple
-- books per user), plus Phase 4 "Advanced reporting" — scheduled report
-- delivery. See lib/db/src/schema/finance.ts (financeBooksTable,
-- financeReportSchedulesTable) and lib/finance-accounting.ts.
--
-- Scoped to the three tables that define "the books" in an accounting
-- sense — Chart of Accounts, Journal, and Finance ledger entries. Assets,
-- Budgets, Recurring rules, and Goals are left as-is (per-user, shared
-- across books) — those are person-level concepts, not business-vs-personal
-- ones.

CREATE TABLE IF NOT EXISTS finance_books (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  book_type TEXT NOT NULL DEFAULT 'personal',
  currency TEXT NOT NULL DEFAULT 'BDT',
  is_default INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS finance_books_user_idx ON finance_books(user_id);

CREATE TABLE IF NOT EXISTS finance_report_schedules (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  book_id INTEGER,
  report_type TEXT NOT NULL DEFAULT 'income_statement',
  frequency TEXT NOT NULL DEFAULT 'monthly',
  day_of_month INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  last_sent_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS finance_report_schedules_user_idx ON finance_report_schedules(user_id);

ALTER TABLE finance_ledger_entries ADD COLUMN IF NOT EXISTS book_id INTEGER;
ALTER TABLE finance_accounts        ADD COLUMN IF NOT EXISTS book_id INTEGER;
ALTER TABLE finance_journal_entries ADD COLUMN IF NOT EXISTS book_id INTEGER;

CREATE INDEX IF NOT EXISTS finance_ledger_entries_book_idx ON finance_ledger_entries(book_id);
CREATE INDEX IF NOT EXISTS finance_accounts_book_idx        ON finance_accounts(book_id);
CREATE INDEX IF NOT EXISTS finance_journal_entries_book_idx ON finance_journal_entries(book_id);

-- Backfill: every existing user gets one "Personal" default book, and every
-- pre-existing account/journal-entry/ledger-entry row of theirs is assigned
-- to it — so nothing that already existed appears to "disappear" once the
-- app starts filtering by book.
INSERT INTO finance_books (user_id, name, book_type, is_default)
SELECT DISTINCT u.id, 'Personal', 'personal', 1
FROM users u
WHERE EXISTS (
  SELECT 1 FROM finance_ledger_entries WHERE user_id = u.id
  UNION ALL SELECT 1 FROM finance_accounts WHERE user_id = u.id
  UNION ALL SELECT 1 FROM finance_journal_entries WHERE user_id = u.id
)
AND NOT EXISTS (SELECT 1 FROM finance_books WHERE user_id = u.id);

UPDATE finance_ledger_entries e SET book_id = b.id
FROM finance_books b WHERE b.user_id = e.user_id AND b.is_default = 1 AND e.book_id IS NULL;

UPDATE finance_accounts a SET book_id = b.id
FROM finance_books b WHERE b.user_id = a.user_id AND b.is_default = 1 AND a.book_id IS NULL;

UPDATE finance_journal_entries j SET book_id = b.id
FROM finance_books b WHERE b.user_id = j.user_id AND b.is_default = 1 AND j.book_id IS NULL;

-- Idempotent (also folded into the startup-migration array in index.ts so
-- fresh/imported DBs pick it up automatically on boot, same convention as
-- every other migration in this project).
