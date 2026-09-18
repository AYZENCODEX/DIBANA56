-- 034_finance_invoice_enterprise.sql
-- Phase 5 follow-up #3 — enterprise-grade invoice template. Adds the fields
-- a business invoice normally carries beyond "amount + notes": a proper
-- sequential invoice number, PO/reference number, tax + discount at the
-- invoice level, and the extra business identity fields (tax/VAT ID,
-- contact email/phone, website, default terms & conditions) that the PDF
-- header and footer now render alongside the existing logo/theme/name/
-- address/footer-note branding from migration 033.
--
-- amount stays the grand total (subtotal − discount + tax), same meaning
-- it always had, so every existing reader (reminders, late fees, partial-
-- payment math, the ledger link) keeps working unchanged — tax_rate/
-- discount_* are just how that total now gets built, computed once at
-- create/edit time by lib/finance-invoice.ts's computeInvoiceTotals().

-- ── Per-user business identity, reused on every invoice ──
ALTER TABLE users ADD COLUMN IF NOT EXISTS finance_invoice_tax_id TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS finance_invoice_business_email TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS finance_invoice_business_phone TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS finance_invoice_website TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS finance_invoice_terms TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS finance_invoice_number_prefix TEXT NOT NULL DEFAULT 'INV';

-- ── Per-invoice enterprise fields ──
ALTER TABLE finance_invoices ADD COLUMN IF NOT EXISTS invoice_number TEXT;
ALTER TABLE finance_invoices ADD COLUMN IF NOT EXISTS po_number TEXT;
-- discount_type: 'flat' | 'percent' | NULL (no discount)
ALTER TABLE finance_invoices ADD COLUMN IF NOT EXISTS discount_type TEXT;
ALTER TABLE finance_invoices ADD COLUMN IF NOT EXISTS discount_value REAL NOT NULL DEFAULT 0;
-- tax_rate is a percentage (e.g. 15 = 15%), applied to (subtotal − discount)
ALTER TABLE finance_invoices ADD COLUMN IF NOT EXISTS tax_rate REAL NOT NULL DEFAULT 0;
ALTER TABLE finance_invoices ADD COLUMN IF NOT EXISTS tax_label TEXT NOT NULL DEFAULT 'Tax';
-- Per-invoice override of the user's default terms & conditions text.
ALTER TABLE finance_invoices ADD COLUMN IF NOT EXISTS terms TEXT;

-- Backfill a human invoice number for every pre-existing row, so the PDF
-- template never has to fall back to the raw numeric id for old invoices.
-- Format matches what new invoices get: <PREFIX>-<year>-<5-digit id>.
UPDATE finance_invoices
SET invoice_number = 'INV-' || EXTRACT(YEAR FROM created_at)::text || '-' || LPAD(id::text, 5, '0')
WHERE invoice_number IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS finance_invoices_number_idx ON finance_invoices(invoice_number);
