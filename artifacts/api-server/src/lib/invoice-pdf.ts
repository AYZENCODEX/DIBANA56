/**
 * lib/invoice-pdf.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Enterprise-grade, itemized, branded PDF for a Finance invoice
 * (routes/finance-invoices.ts GET /finance/invoices/:id/pdf and the public
 * .../public/:token/pdf). Distinct from lib/receipt-theme.ts's single-stat-
 * card template — an invoice needs a proper line-item table, subtotal/
 * discount/tax breakdown, per-user branding (logo + theme color + business
 * identity, see users.financeInvoice* columns) and pagination for long
 * itemized bills, rather than one hero number.
 *
 * Sections, top to bottom:
 *  1. Duotone header band — logo, business identity (name, address, email,
 *     phone, tax/VAT ID), "INVOICE" title, invoice number, status chip.
 *  2. Meta strip — issue date, due date, PO/reference number.
 *  3. Bill-to card.
 *  4. Line-item table — paginates automatically, repeating the column
 *     header on every new page, for invoices with many lines.
 *  5. Totals block — Subtotal, Discount, Tax, Total, Paid, Balance Due —
 *     plus an amount-in-words line, the way a bank or auditor expects.
 *  6. Notes and Terms & Conditions (kept separate: notes are per-invoice
 *     context, terms are the standing payment/legal terms).
 *  7. Two QR codes side by side above the footer:
 *      - the "pay this invoice" link (generateInvoicePayLinkQrDataUrl) —
 *        always shown when a payUrl is passed, since it's the one link
 *        that gets the debtor to the repay page regardless of method.
 *      - the creditor's selected/default payment method QR
 *        (generatePaymentQrDataUrl from finance-invoice.ts) — shown when
 *        passed, so a printed copy (no click-through) can scan-to-pay.
 *  8. Footer — footer note + "Page N of M" on every page.
 */
import PDFDocument from "pdfkit";
import axios from "axios";
import type { Response } from "express";

export interface InvoiceBranding {
  logoUrl: string | null;
  themeColor: string | null;
  businessName: string | null;
  businessAddress: string | null;
  footerNote: string | null;
  /** Tax/VAT/company registration number, shown under the business address. */
  taxId: string | null;
  businessEmail: string | null;
  businessPhone: string | null;
  website: string | null;
  /** Default Terms & Conditions text, used when the invoice itself has none. */
  termsText: string | null;
}

export interface InvoicePdfLineItem {
  description: string;
  quantity: number;
  unitPrice: number;
}

export interface InvoicePdfConfig {
  invoiceId: number | string;
  /** Human, sequential-looking number (e.g. INV-2026-00042) shown instead of the raw id. */
  invoiceNumber?: string | null;
  /** Purchase-order / reference number the debtor's own accounting expects on the invoice. */
  poNumber?: string | null;
  creditorName: string;
  debtorName: string;
  debtorEmail?: string | null;
  currency: string;
  lineItems: InvoicePdfLineItem[];
  /** Raw sum of quantity × unit price, before discount/tax. */
  subtotal: number;
  discountType?: string | null; // 'flat' | 'percent' | null
  discountValue?: number | null;
  discountAmount?: number;
  taxRate?: number | null; // percent
  taxLabel?: string | null;
  taxAmount?: number;
  /** Grand total — subtotal − discountAmount + taxAmount. What's actually owed. */
  amount: number;
  paidAmount: number;
  issueDate?: string | Date | null;
  dueDate?: string | Date | null;
  notes?: string | null;
  /** Terms & Conditions — per-invoice override of the creditor's default. */
  terms?: string | null;
  status: string;
  branding: InvoiceBranding;
  /** data: URL — the "scan to open this invoice" QR. */
  payLinkQrDataUrl?: string | null;
  /** data: URL — the creditor's chosen payment-method QR, if any. */
  paymentMethodQrDataUrl?: string | null;
  paymentMethodLabel?: string | null;
}

const INK = "#12181c";
const MUTED = "#8a97a0";
const LINE = "#e4e9eb";
const CARD_BG = "#f6f9f9";
const GREEN = "#0f9d58";
const AMBER = "#c9852b";
const RED = "#d64545";

const PAGE_MARGIN_X = 48;
const PAGE_MARGIN_TOP = 0;
const FOOTER_RESERVE = 60; // space reserved at the bottom of every page for the footer

function money(currency: string, amount: number): string {
  return `${currency} ${(amount || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten",
  "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

function threeDigitsToWords(n: number): string {
  const parts: string[] = [];
  if (n >= 100) { parts.push(`${ONES[Math.floor(n / 100)]} Hundred`); n %= 100; }
  if (n >= 20) { parts.push(TENS[Math.floor(n / 10)]); n %= 10; if (n) parts.push(ONES[n]); }
  else if (n > 0) { parts.push(ONES[n]); }
  return parts.join(" ");
}

/** Whole-number-to-words, international scale — good enough for an invoice footer line. */
function integerToWords(n: number): string {
  if (n === 0) return "Zero";
  const scales: [number, string][] = [[1_000_000_000, "Billion"], [1_000_000, "Million"], [1_000, "Thousand"], [1, ""]];
  const parts: string[] = [];
  for (const [scale, label] of scales) {
    if (n >= scale) {
      const chunk = Math.floor(n / scale);
      n %= scale;
      parts.push(label ? `${threeDigitsToWords(chunk)} ${label}` : threeDigitsToWords(chunk));
    }
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

/** "BDT Twelve Thousand and 50/100 Only" — never throws; falls back to the plain number. */
function amountInWords(currency: string, amount: number): string {
  try {
    const safe = Math.max(0, amount || 0);
    const whole = Math.floor(safe);
    const cents = Math.round((safe - whole) * 100);
    return `${currency} ${integerToWords(whole)}${cents > 0 ? ` and ${String(cents).padStart(2, "0")}/100` : ""} Only`;
  } catch {
    return money(currency, amount);
  }
}

/** Fetches a logo as a Buffer PDFKit can embed — supports data: URLs (pasted/base64 logos) and http(s) URLs. Never throws; a broken logo just means no logo on the PDF. */
async function fetchLogoBuffer(logoUrl: string | null): Promise<Buffer | null> {
  if (!logoUrl) return null;
  try {
    if (logoUrl.startsWith("data:")) {
      const base64 = logoUrl.split(",")[1];
      return base64 ? Buffer.from(base64, "base64") : null;
    }
    const res = await axios.get<ArrayBuffer>(logoUrl, { responseType: "arraybuffer", timeout: 5000 });
    return Buffer.from(res.data);
  } catch {
    return null;
  }
}

function hexOrDefault(color: string | null | undefined, fallback: string): string {
  return color && /^#[0-9a-fA-F]{6}$/.test(color) ? color : fallback;
}

/** Darkens a hex color by mixing it toward black, for the two-tone header band (mirrors receipt-theme.ts's BRAND/BRAND_DARK pairing but derived from one user-chosen color instead of two fixed ones). */
function darken(hex: string, amount = 0.35): string {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.round(((n >> 16) & 0xff) * (1 - amount));
  const g = Math.round(((n >> 8) & 0xff) * (1 - amount));
  const b = Math.round((n & 0xff) * (1 - amount));
  return `#${[r, g, b].map(v => v.toString(16).padStart(2, "0")).join("")}`;
}

/** Status → (label, background, foreground) for the header chip. Mirrors config/finance.ts's INVOICE_STATUS_* maps on the frontend, kept in sync manually since this file has no shared import path to the client config. */
function statusChip(status: string): { label: string; bg: string; fg: string } {
  switch (status) {
    case "paid": case "creditor_verified": return { label: "PAID", bg: GREEN, fg: "#ffffff" };
    case "partially_paid": return { label: "PARTIALLY PAID", bg: AMBER, fg: "#ffffff" };
    case "payment_submitted": return { label: "PAYMENT SUBMITTED", bg: AMBER, fg: "#ffffff" };
    case "agreement_confirmed": return { label: "AWAITING VERIFICATION", bg: AMBER, fg: "#ffffff" };
    case "disputed": return { label: "DISPUTED", bg: RED, fg: "#ffffff" };
    case "cancelled": return { label: "CANCELLED", bg: RED, fg: "#ffffff" };
    case "viewed": return { label: "VIEWED", bg: "#ffffff", fg: INK };
    default: return { label: "SENT", bg: "#ffffff", fg: INK };
  }
}

export async function streamInvoicePdf(res: Response, cfg: InvoicePdfConfig): Promise<void> {
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="ayzen-invoice-${cfg.invoiceNumber || cfg.invoiceId}.pdf"`);

  const brand = hexOrDefault(cfg.branding.themeColor, "#00a89f");
  const brandDark = darken(brand);
  const logoBuffer = await fetchLogoBuffer(cfg.branding.logoUrl);
  const displayNumber = cfg.invoiceNumber || `#${cfg.invoiceId}`;
  const isOverdue = cfg.dueDate && new Date(cfg.dueDate).getTime() < Date.now() && Math.max(0, cfg.amount - cfg.paidAmount) > 0
    && !["paid", "creditor_verified", "cancelled"].includes(cfg.status);
  const chip = isOverdue ? { label: "OVERDUE", bg: RED, fg: "#ffffff" } : statusChip(cfg.status);

  const doc = new PDFDocument({ margin: 0, size: "A4", bufferPages: true });
  doc.pipe(res);

  const pageWidth = doc.page.width;
  const pageHeight = doc.page.height;
  const marginX = PAGE_MARGIN_X;
  const contentWidth = pageWidth - marginX * 2;

  // ── Header band (drawn once per page it appears on — see newPage()) ──────
  function drawHeaderBand(): void {
    doc.rect(0, 0, pageWidth, 150).fill(brandDark);
    doc.rect(0, 100, pageWidth, 50).fill(brand);

    if (logoBuffer) {
      try { doc.image(logoBuffer, marginX, 30, { fit: [56, 56] }); } catch { /* corrupt/unsupported image format — skip it */ }
    }
    const titleX = marginX + (logoBuffer ? 68 : 0);
    const titleWidth = contentWidth - (titleX - marginX) - 170;
    doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(16).text(cfg.branding.businessName || cfg.creditorName, titleX, 26, { width: titleWidth });

    let contactY = 46;
    if (cfg.branding.businessAddress) {
      doc.font("Helvetica").fontSize(8).fillColor("#e8fbf9").text(cfg.branding.businessAddress, titleX, contactY, { width: titleWidth });
      contactY += doc.heightOfString(cfg.branding.businessAddress, { width: titleWidth }) + 2;
    }
    const contactBits = [cfg.branding.businessEmail, cfg.branding.businessPhone, cfg.branding.website].filter(Boolean).join("  ·  ");
    if (contactBits) {
      doc.font("Helvetica").fontSize(8).fillColor("#e8fbf9").text(contactBits, titleX, contactY, { width: titleWidth });
      contactY += 11;
    }
    if (cfg.branding.taxId) {
      doc.font("Helvetica").fontSize(8).fillColor("#e8fbf9").text(`Tax/VAT ID: ${cfg.branding.taxId}`, titleX, contactY, { width: titleWidth });
    }

    // Status chip, top-right
    const chipW = doc.font("Helvetica-Bold").fontSize(9).widthOfString(chip.label) + 20;
    const chipX = marginX + contentWidth - chipW;
    doc.roundedRect(chipX, 26, chipW, 20, 10).fill(chip.bg);
    doc.font("Helvetica-Bold").fontSize(9).fillColor(chip.fg).text(chip.label, chipX, 32, { width: chipW, align: "center" });

    doc.font("Helvetica-Bold").fontSize(20).fillColor("#ffffff").text("INVOICE", marginX, 112, { width: contentWidth - 170 });
    doc.font("Helvetica-Bold").fontSize(11).fillColor("#eafffb").text(displayNumber, marginX + contentWidth - 170, 116, { width: 170, align: "right" });
  }

  drawHeaderBand();

  // ── Meta strip: issue date / due date / PO number ─────────────────────────
  let y = 168;
  const metaItems: { label: string; value: string }[] = [
    { label: "ISSUE DATE", value: new Date(cfg.issueDate ?? new Date()).toLocaleDateString() },
    { label: "DUE DATE", value: cfg.dueDate ? new Date(cfg.dueDate).toLocaleDateString() : "On receipt" },
  ];
  if (cfg.poNumber) metaItems.push({ label: "PO / REFERENCE", value: cfg.poNumber });
  const metaColWidth = contentWidth / metaItems.length;
  metaItems.forEach((m, i) => {
    const mx = marginX + i * metaColWidth;
    doc.font("Helvetica-Bold").fontSize(7.5).fillColor(MUTED).text(m.label, mx, y, { characterSpacing: 0.8 });
    doc.font("Helvetica-Bold").fontSize(10.5).fillColor(INK).text(m.value, mx, y + 12);
  });
  y += 40;

  // ── Bill-to card ─────────────────────────────────────────────────────────
  doc.roundedRect(marginX, y, contentWidth, 62, 10).fillAndStroke(CARD_BG, LINE);
  doc.font("Helvetica").fontSize(8.5).fillColor(MUTED).text("BILL TO", marginX + 18, y + 12, { characterSpacing: 1 });
  doc.font("Helvetica-Bold").fontSize(13).fillColor(INK).text(cfg.debtorName, marginX + 18, y + 26);
  if (cfg.debtorEmail) doc.font("Helvetica").fontSize(9.5).fillColor(MUTED).text(cfg.debtorEmail, marginX + 18, y + 44);

  y += 62 + 24;

  // ── Line items table (paginated) ────────────────────────────────────────
  const colDesc = marginX;
  const colQty = marginX + contentWidth - 260;
  const colUnit = marginX + contentWidth - 180;
  const colTotal = marginX + contentWidth - 90;
  const rowH = 24;
  const tableTopMargin = 108; // top of a continuation page, below its own header band

  function drawTableHeader(atY: number): number {
    doc.font("Helvetica-Bold").fontSize(8.5).fillColor(MUTED);
    doc.text("DESCRIPTION", colDesc, atY, { characterSpacing: 0.6 });
    doc.text("QTY", colQty, atY, { width: 60, align: "right", characterSpacing: 0.6 });
    doc.text("UNIT PRICE", colUnit, atY, { width: 80, align: "right", characterSpacing: 0.6 });
    doc.text("AMOUNT", colTotal, atY, { width: 90, align: "right", characterSpacing: 0.6 });
    let ny = atY + 16;
    doc.moveTo(marginX, ny).lineTo(marginX + contentWidth, ny).strokeColor(LINE).stroke();
    return ny + 8;
  }

  function newContinuationPage(): number {
    doc.addPage();
    doc.rect(0, 0, pageWidth, 60).fill(brandDark);
    doc.font("Helvetica-Bold").fontSize(11).fillColor("#ffffff").text(`INVOICE ${displayNumber} (continued)`, marginX, 22, { width: contentWidth });
    return drawTableHeader(tableTopMargin);
  }

  y = drawTableHeader(y);

  doc.font("Helvetica").fontSize(10).fillColor(INK);
  let rowIndex = 0;
  for (const line of cfg.lineItems) {
    rowIndex += 1;
    const lineTotal = (line.quantity || 0) * (line.unitPrice || 0);
    const descHeight = doc.heightOfString(line.description, { width: colQty - colDesc - 12 });
    const thisRowH = Math.max(rowH, descHeight + 8);

    if (y + thisRowH > pageHeight - FOOTER_RESERVE) {
      y = newContinuationPage();
      doc.font("Helvetica").fontSize(10).fillColor(INK);
    }

    // Subtle zebra striping for readability on long itemized invoices.
    if (rowIndex % 2 === 0) doc.rect(marginX, y - 4, contentWidth, thisRowH).fill("#fbfdfd");
    doc.fillColor(INK);
    doc.text(line.description, colDesc, y, { width: colQty - colDesc - 12 });
    doc.text(String(line.quantity), colQty, y, { width: 60, align: "right" });
    doc.text(money(cfg.currency, line.unitPrice), colUnit, y, { width: 80, align: "right" });
    doc.text(money(cfg.currency, lineTotal), colTotal, y, { width: 90, align: "right" });
    y += thisRowH;
    doc.moveTo(marginX, y).lineTo(marginX + contentWidth, y).strokeColor(LINE).stroke();
    y += 8;
  }

  // ── Totals block ─────────────────────────────────────────────────────────
  const subtotal = cfg.subtotal ?? cfg.lineItems.reduce((s, l) => s + (l.quantity || 0) * (l.unitPrice || 0), 0);
  const discountAmount = cfg.discountAmount ?? 0;
  const taxAmount = cfg.taxAmount ?? 0;
  const remaining = Math.max(0, cfg.amount - cfg.paidAmount);

  const totalsBlockHeight = 24 /* subtotal */
    + (discountAmount > 0 ? 18 : 0)
    + (taxAmount > 0 || (cfg.taxRate ?? 0) > 0 ? 18 : 0)
    + 22 /* total */
    + (cfg.paidAmount > 0 ? 40 : 0)
    + 30; /* amount in words */
  if (y + totalsBlockHeight > pageHeight - FOOTER_RESERVE) y = newContinuationPage();

  y += 8;
  const totalsX = marginX + contentWidth - 240;
  const totalRow = (label: string, value: string, opts: { bold?: boolean; color?: string } = {}) => {
    doc.font(opts.bold ? "Helvetica-Bold" : "Helvetica").fontSize(opts.bold ? 12 : 10).fillColor(opts.color ?? INK);
    doc.text(label, totalsX, y, { width: 140 });
    doc.text(value, totalsX + 140, y, { width: 100, align: "right" });
    y += opts.bold ? 22 : 18;
  };

  totalRow("Subtotal", money(cfg.currency, subtotal));
  if (discountAmount > 0) {
    const label = cfg.discountType === "percent" ? `Discount (${cfg.discountValue}%)` : "Discount";
    totalRow(label, `− ${money(cfg.currency, discountAmount)}`, { color: GREEN });
  }
  if (taxAmount > 0 || (cfg.taxRate ?? 0) > 0) {
    totalRow(`${cfg.taxLabel || "Tax"}${cfg.taxRate ? ` (${cfg.taxRate}%)` : ""}`, money(cfg.currency, taxAmount));
  }
  totalRow("Total", money(cfg.currency, cfg.amount), { bold: true });
  if (cfg.paidAmount > 0) {
    totalRow("Paid", money(cfg.currency, cfg.paidAmount), { color: GREEN });
    totalRow("Balance due", money(cfg.currency, remaining), { bold: true, color: remaining > 0 ? AMBER : GREEN });
  }

  y += 6;
  doc.font("Helvetica-Oblique").fontSize(8.5).fillColor(MUTED)
    .text(amountInWords(cfg.currency, cfg.amount), marginX, y, { width: contentWidth });
  y = doc.y + 16;

  // ── Notes ────────────────────────────────────────────────────────────────
  if (cfg.notes) {
    if (y + 40 > pageHeight - FOOTER_RESERVE) y = newContinuationPage();
    doc.font("Helvetica-Bold").fontSize(9).fillColor(MUTED).text("NOTES", marginX, y, { characterSpacing: 1 });
    y += 14;
    doc.font("Helvetica").fontSize(10).fillColor(INK).text(cfg.notes, marginX, y, { width: contentWidth });
    y = doc.y + 18;
  }

  // ── Terms & Conditions ───────────────────────────────────────────────────
  const terms = cfg.terms || cfg.branding.termsText;
  if (terms) {
    if (y + 40 > pageHeight - FOOTER_RESERVE) y = newContinuationPage();
    doc.font("Helvetica-Bold").fontSize(9).fillColor(MUTED).text("TERMS & CONDITIONS", marginX, y, { characterSpacing: 1 });
    y += 14;
    doc.font("Helvetica").fontSize(9).fillColor(INK).text(terms, marginX, y, { width: contentWidth });
    y = doc.y + 18;
  }

  // ── QR codes ─────────────────────────────────────────────────────────────
  const qrEntries: { dataUrl: string; caption: string }[] = [];
  if (cfg.payLinkQrDataUrl) qrEntries.push({ dataUrl: cfg.payLinkQrDataUrl, caption: "Scan to open & pay this invoice" });
  if (cfg.paymentMethodQrDataUrl) qrEntries.push({ dataUrl: cfg.paymentMethodQrDataUrl, caption: cfg.paymentMethodLabel ? `Scan to pay via ${cfg.paymentMethodLabel}` : "Scan to pay" });

  if (qrEntries.length > 0) {
    const qrSize = 88;
    const qrGap = 24;
    if (y + qrSize + 24 > pageHeight - FOOTER_RESERVE) y = newContinuationPage();
    let qx = marginX;
    for (const q of qrEntries) {
      try {
        const base64 = q.dataUrl.split(",")[1];
        if (base64) {
          doc.image(Buffer.from(base64, "base64"), qx, y, { fit: [qrSize, qrSize] });
          doc.font("Helvetica").fontSize(8).fillColor(MUTED).text(q.caption, qx, y + qrSize + 4, { width: qrSize + 40 });
        }
      } catch { /* QR image render failure shouldn't block the rest of the PDF */ }
      qx += qrSize + qrGap;
    }
    y += qrSize + 24;
  }

  // ── Footer on every page: footer note + "Page N of M" ─────────────────────
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const footerY = pageHeight - 44;
    doc.moveTo(marginX, footerY).lineTo(marginX + contentWidth, footerY).strokeColor(LINE).stroke();
    doc.font("Helvetica").fontSize(8).fillColor(MUTED).text(
      cfg.branding.footerNote || "Generated by AYZEN. Anyone holding this invoice's link can view and pay it — nothing else in the account is reachable from here.",
      marginX, footerY + 10, { width: contentWidth - 90 },
    );
    doc.font("Helvetica").fontSize(8).fillColor(MUTED).text(
      `Page ${i - range.start + 1} of ${range.count}`, marginX + contentWidth - 90, footerY + 10, { width: 90, align: "right" },
    );
  }

  doc.end();
}
