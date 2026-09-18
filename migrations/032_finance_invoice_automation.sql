-- 032_finance_invoice_automation.sql
-- Phase 5 follow-up — automation on top of finance_invoices/finance_payment_agreements
-- (migration 031): overdue reminder cron, recurring auto-invoice (rent/EMI style),
-- late fee / interest auto-calc, partial payment tracking across multiple payment
-- agreements per invoice, and the dispute flow the finance_payment_agreements.status
-- comment already anticipated ('disputed') but never got a route for.

-- ── Invoices: overdue reminder dedup + running paid total for partial payments ──
ALTER TABLE finance_invoices ADD COLUMN IF NOT EXISTS last_reminder_at TIMESTAMP;
ALTER TABLE finance_invoices ADD COLUMN IF NOT EXISTS reminder_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE finance_invoices ADD COLUMN IF NOT EXISTS paid_amount REAL NOT NULL DEFAULT 0;
ALTER TABLE finance_invoices ADD COLUMN IF NOT EXISTS recurring_rule_id INTEGER;
-- status gains: 'partially_paid' | 'paid' | 'disputed' alongside the existing
-- sent/viewed/payment_submitted/agreement_confirmed/creditor_verified/cancelled

-- ── Payment agreements: dispute reason (status already supports 'disputed') ──
ALTER TABLE finance_payment_agreements ADD COLUMN IF NOT EXISTS disputed_at TIMESTAMP;
ALTER TABLE finance_payment_agreements ADD COLUMN IF NOT EXISTS dispute_reason TEXT;
ALTER TABLE finance_payment_agreements ADD COLUMN IF NOT EXISTS disputed_by INTEGER;

-- ── Recurring rules: optional auto-invoice on materialize (rent/loan EMI style) ──
ALTER TABLE finance_recurring_rules ADD COLUMN IF NOT EXISTS auto_invoice INTEGER NOT NULL DEFAULT 0;
ALTER TABLE finance_recurring_rules ADD COLUMN IF NOT EXISTS invoice_debtor_name TEXT;
ALTER TABLE finance_recurring_rules ADD COLUMN IF NOT EXISTS invoice_debtor_email TEXT;
ALTER TABLE finance_recurring_rules ADD COLUMN IF NOT EXISTS invoice_debtor_telegram_chat_id TEXT;
ALTER TABLE finance_recurring_rules ADD COLUMN IF NOT EXISTS invoice_due_days INTEGER NOT NULL DEFAULT 7;

-- ── Ledger entries: late fee / overdue interest auto-calc ──
-- late_fee_type: 'flat' | 'daily_percent' | 'monthly_percent' | NULL (disabled)
ALTER TABLE finance_ledger_entries ADD COLUMN IF NOT EXISTS late_fee_type TEXT;
ALTER TABLE finance_ledger_entries ADD COLUMN IF NOT EXISTS late_fee_rate REAL;
ALTER TABLE finance_ledger_entries ADD COLUMN IF NOT EXISTS late_fee_grace_days INTEGER NOT NULL DEFAULT 0;
ALTER TABLE finance_ledger_entries ADD COLUMN IF NOT EXISTS late_fee_accrued REAL NOT NULL DEFAULT 0;
ALTER TABLE finance_ledger_entries ADD COLUMN IF NOT EXISTS late_fee_last_calc_at TIMESTAMP;

CREATE INDEX IF NOT EXISTS finance_invoices_due_date_idx ON finance_invoices(due_date);
CREATE INDEX IF NOT EXISTS finance_ledger_entries_late_fee_idx ON finance_ledger_entries(late_fee_type) WHERE late_fee_type IS NOT NULL;
