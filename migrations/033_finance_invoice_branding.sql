-- 033_finance_invoice_branding.sql
-- Phase 5 follow-up #2 — invoice branding (logo/theme, shown on both the PDF
-- and the public repay page) + itemized line items (replacing the single
-- finance_invoices.amount as something the creditor types directly; amount
-- is now a computed total kept in sync from the lines, so every existing
-- reader of invoice.amount — reminders, late fees, partial-payment math,
-- the ledger link — keeps working unchanged).

-- ── Per-user invoice branding (Q&A: lives on the user, reused on every
--    invoice they send, not overridden per-invoice) ──
ALTER TABLE users ADD COLUMN IF NOT EXISTS finance_invoice_logo_url TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS finance_invoice_theme_color TEXT NOT NULL DEFAULT '#00a89f';
ALTER TABLE users ADD COLUMN IF NOT EXISTS finance_invoice_business_name TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS finance_invoice_business_address TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS finance_invoice_footer_note TEXT;

-- ── Line items ──
-- amount on finance_invoices becomes a denormalized total = SUM(quantity *
-- unit_price) across these rows, recomputed by lib/finance-invoice.ts
-- whenever lines are written. Standalone invoices (no linked entry) as well
-- as recurring-rule auto-invoices both get a single line item at creation
-- so every invoice has at least one row here.
CREATE TABLE IF NOT EXISTS finance_invoice_line_items (
  id SERIAL PRIMARY KEY,
  invoice_id INTEGER NOT NULL,
  description TEXT NOT NULL,
  quantity REAL NOT NULL DEFAULT 1,
  unit_price REAL NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS finance_invoice_line_items_invoice_idx ON finance_invoice_line_items(invoice_id);
