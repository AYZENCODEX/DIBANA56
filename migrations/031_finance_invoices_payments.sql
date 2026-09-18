-- 031_finance_invoices_payments.sql
-- Phase 5 — Invoices + peer payment gateway (bKash/Nagad/Rocket/bank/USDT,
-- manual — no gateway API integration) + passkey-witnessed Payment
-- Agreements. See lib/db/src/schema/finance.ts for the full design note.
--
-- Flow: creditor sends an invoice (email/Telegram) linking a public "Repay"
-- page → debtor picks a method + submits a reference/txn ID → debtor signs
-- a Payment Agreement with their own AYZEN passkey (IP + device captured as
-- evidence) → creditor verifies, which auto-posts a real repayment against
-- the linked ledger entry.

CREATE TABLE IF NOT EXISTS finance_payment_methods (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  method_type TEXT NOT NULL,
  label TEXT,
  account_number TEXT,
  bank_name TEXT,
  bank_account_name TEXT,
  bank_account_number TEXT,
  bank_routing_number TEXT,
  usdt_address TEXT,
  usdt_network TEXT DEFAULT 'TRC20',
  is_default INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS finance_payment_methods_user_idx ON finance_payment_methods(user_id);

CREATE TABLE IF NOT EXISTS finance_invoices (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  entry_id INTEGER,
  book_id INTEGER,
  debtor_name TEXT NOT NULL,
  debtor_email TEXT,
  debtor_telegram_chat_id TEXT,
  amount REAL NOT NULL,
  currency TEXT NOT NULL DEFAULT 'BDT',
  due_date TIMESTAMP,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'sent',
  invoice_token TEXT NOT NULL,
  sent_via_email INTEGER NOT NULL DEFAULT 0,
  sent_via_telegram INTEGER NOT NULL DEFAULT 0,
  last_sent_at TIMESTAMP,
  cancelled_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS finance_invoices_token_idx ON finance_invoices(invoice_token);
CREATE INDEX IF NOT EXISTS finance_invoices_user_idx ON finance_invoices(user_id);
CREATE INDEX IF NOT EXISTS finance_invoices_entry_idx ON finance_invoices(entry_id);
CREATE INDEX IF NOT EXISTS finance_invoices_status_idx ON finance_invoices(status);

CREATE TABLE IF NOT EXISTS finance_invoice_events (
  id SERIAL PRIMARY KEY,
  invoice_id INTEGER NOT NULL REFERENCES finance_invoices(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  meta TEXT,
  ip_address TEXT,
  user_agent TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS finance_invoice_events_invoice_idx ON finance_invoice_events(invoice_id);

CREATE TABLE IF NOT EXISTS finance_payment_agreements (
  id SERIAL PRIMARY KEY,
  invoice_id INTEGER NOT NULL REFERENCES finance_invoices(id) ON DELETE CASCADE,
  payer_user_id INTEGER,
  method_type TEXT NOT NULL,
  reference_id TEXT,
  amount REAL NOT NULL,
  submitted_at TIMESTAMP,
  passkey_credential_id INTEGER,
  confirmed_at TIMESTAMP,
  ip_address TEXT,
  user_agent TEXT,
  status TEXT NOT NULL DEFAULT 'submitted',
  agreement_token TEXT NOT NULL,
  creditor_verified_at TIMESTAMP,
  creditor_verified_by INTEGER,
  creditor_notes TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS finance_payment_agreements_token_idx ON finance_payment_agreements(agreement_token);
CREATE INDEX IF NOT EXISTS finance_payment_agreements_invoice_idx ON finance_payment_agreements(invoice_id);
CREATE INDEX IF NOT EXISTS finance_payment_agreements_payer_idx ON finance_payment_agreements(payer_user_id);
