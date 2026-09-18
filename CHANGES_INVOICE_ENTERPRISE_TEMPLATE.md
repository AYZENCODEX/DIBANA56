# Enterprise-grade Invoice Template

Migration: `034_finance_invoice_enterprise.sql`

## What changed

The Finance invoice PDF (`lib/invoice-pdf.ts`) and the whole invoicing path
around it were upgraded from a simple itemized bill to a proper
enterprise-style invoice.

### New on the PDF
- **Human invoice number** (`INV-2026-00042` style) shown everywhere instead
  of the raw numeric id, via `formatInvoiceNumber()`.
- **PO / reference number** field, shown in a meta strip under the header.
- **Business identity**: tax/VAT ID, business email, phone, and website,
  shown in the header alongside the existing logo/name/address.
- **Status chip** in the header (PAID / OVERDUE / DISPUTED / etc.), computed
  the same way the frontend's `INVOICE_STATUS_*` maps do.
- **Subtotal → Discount → Tax → Total** breakdown instead of a single total,
  plus an **amount-in-words** line under it (`amountInWords()`).
- **Terms & Conditions** section, separate from the free-text Notes —
  per-invoice, falling back to the creditor's saved default.
- **Pagination**: the line-item table, totals, notes, terms, and QR codes
  all now flow across multiple pages for long itemized invoices, repeating
  the table header on each continuation page, with a "Page N of M" footer
  on every page (`bufferPages` + `bufferedPageRange()`).
- Light zebra striping on the line-item table for readability.

### Schema (migration 034)
- `users`: `finance_invoice_tax_id`, `finance_invoice_business_email`,
  `finance_invoice_business_phone`, `finance_invoice_website`,
  `finance_invoice_terms`, `finance_invoice_number_prefix` (default `INV`).
- `finance_invoices`: `invoice_number` (unique, backfilled for existing
  rows), `po_number`, `discount_type` (`flat`|`percent`|null),
  `discount_value`, `tax_rate`, `tax_label`, `terms`.
- `amount` keeps its existing meaning — the grand total — it's just now
  composed as `subtotal − discount + tax` via
  `finance-invoice.ts`'s `computeInvoiceTotals()`, so every existing reader
  (overdue reminders, late fees, partial-payment math, the ledger link)
  keeps working unchanged.

### API
- `POST /finance/invoices` and `PUT /finance/invoices/:id/line-items` now
  accept `poNumber`, `discountType`, `discountValue`, `taxRate`,
  `taxLabel`, `terms`, and mint/keep the invoice's `invoiceNumber`.
- `GET/PUT /finance/invoice-branding` now read/write the new business
  identity fields and `numberPrefix`.
- The public `GET /finance/invoices/public/:token` response now includes
  `invoiceNumber`, `poNumber`, `subtotal`, `discountAmount`, `taxAmount`,
  `terms`, etc. so the repay page can show the same breakdown as the PDF.

### Frontend
- `pages/user/finance/invoices.tsx`: the New Invoice dialog gets PO
  number, discount, tax rate/label, and terms inputs with a live totals
  preview; the Branding dialog gets the new business identity + terms +
  invoice-number-prefix fields; the invoice list shows the invoice number
  and a discount/tax/PO summary per row.
- `pages/finance/invoice-public.tsx`: the repay page shows the invoice
  number, PO number, subtotal/discount/tax breakdown, issue date, and
  terms & conditions.

## Not changed
- `components/finance/finance-invoice-lines.tsx` and the ledger-entry
  itemization it edits (`finance_invoice_lines` / the receipt PDF path)
  are a separate, older feature and were left untouched.
