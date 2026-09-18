/**
 * lib/finance-invoice.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Peer-to-peer invoicing + payment-agreement evidence layer, on top of the
 * existing Finance ledger. Three tokens, three public pages:
 *
 *  1. invoiceToken   → GET /finance/invoices/public/:token — the "Repay" page
 *     a debtor opens from an emailed/Telegrammed invoice. Shows the amount
 *     and the creditor's published payment methods (bKash/Nagad/Rocket/bank/
 *     USDT — informational only, no gateway API). Debtor sends money outside
 *     AYZEN, then submits a method + reference/txn ID here.
 *
 *  2. agreementToken → GET /finance/payment-agreements/public/:token — the
 *     "Payment Agreement" page. The debtor signs their submitted claim with
 *     their own AYZEN passkey (routes/passkey.ts's WebAuthn credentials,
 *     reused as-is); the server stamps IP + device at that moment. This is
 *     the evidentiary artifact the payer asked to keep — "I confirm, as
 *     evidence, that I sent this money."
 *
 *  3. Once the creditor reviews and verifies the agreement, it auto-posts a
 *     real repayment (financeRepaymentsTable + postRepaymentJournal) against
 *     the linked ledger entry — same accounting path as a manual repayment.
 *
 * Two people can be looking at "an invoice" in this module: the creditor
 * (AYZEN account, sees it in Finance → Invoices) and the debtor (may or may
 * not have an AYZEN account yet — the public pages work either way, but
 * submitting a payment claim and signing the agreement both require the
 * debtor to be logged in, since a payment agreement without an accountable
 * identity behind it isn't much of an evidence trail).
 */
import crypto from "crypto";
import QRCode from "qrcode";
import {
  db, financeInvoicesTable, financeInvoiceEventsTable, financePaymentMethodsTable,
  financeInvoiceLineItemsTable, usersTable,
  type FinanceInvoice, type FinanceRecurringRule, type FinanceInvoiceLineItem,
} from "@workspace/db";
import { eq, asc } from "drizzle-orm";
import type { Request } from "express";
import { resolveBookId } from "./finance-accounting";
import { sendInvoiceEmail } from "./email";
import { sendToUserWithButton } from "./telegram";

export function generateInvoiceToken(): string {
  return crypto.randomBytes(20).toString("base64url");
}

export function generateAgreementToken(): string {
  return crypto.randomBytes(20).toString("base64url");
}

function appUrl(): string {
  return process.env.APP_URL ?? "https://ayzen.replit.app";
}

export function financeInvoiceUrl(token: string): string {
  return `${appUrl()}/finance/invoice/${token}`;
}

export function financePaymentAgreementUrl(token: string): string {
  return `${appUrl()}/finance/payment-agreement/${token}`;
}

/** Best-effort append-only trail row — never throws, so a logging failure never blocks the action it's logging. */
export async function logInvoiceEvent(
  invoiceId: number,
  eventType: string,
  req?: Request,
  meta?: Record<string, unknown>,
): Promise<void> {
  try {
    await db.insert(financeInvoiceEventsTable).values({
      invoiceId,
      eventType,
      meta: meta ? JSON.stringify(meta) : null,
      ipAddress: req ? getClientIpLocal(req) : null,
      userAgent: req ? ((req.headers["user-agent"] as string) || null) : null,
    });
  } catch { /* evidence logging is best-effort, never blocking */ }
}

// Local copy of the same IP-extraction logic as lib/login-security.ts's
// getClientIp — kept here rather than importing across modules that aren't
// otherwise related, so this file has no dependency on the login/step-up
// stack.
export function getClientIpLocal(req: Request): string {
  return (req.ip || (req.socket && req.socket.remoteAddress) || "unknown").replace(/^::ffff:/, "");
}

export const PAYMENT_METHOD_LABELS: Record<string, string> = {
  bkash: "bKash", nagad: "Nagad", rocket: "Rocket", bank: "Bank Transfer", usdt: "USDT",
};

// Mobile-money apps (bKash/Nagad/Rocket) have no public deep-link scheme for
// scan-to-pay, so the QR just encodes a plain human-readable "send here"
// block — scanning it saves the debtor mistyping a long number, which is
// the actual friction point, without pretending to be a real payment-app
// QR standard. Bank/USDT get the raw account number / address instead,
// since those are what a banking app or wallet actually wants scanned.
function qrPayload(m: { methodType: string; label: string | null; accountNumber: string | null; bankAccountNumber: string | null; usdtAddress: string | null }): string | null {
  switch (m.methodType) {
    case "bkash": case "nagad": case "rocket":
      return m.accountNumber ? `${PAYMENT_METHOD_LABELS[m.methodType]}\nSend to: ${m.accountNumber}${m.label ? `\n(${m.label})` : ""}` : null;
    case "bank":
      return m.bankAccountNumber ?? null;
    case "usdt":
      return m.usdtAddress ?? null;
    default:
      return null;
  }
}

/** Renders a scan-to-pay QR as a data: URL for one payment method, or null if there's nothing to encode. Never throws — a QR render failure shouldn't break the repay page. */
export async function generatePaymentQrDataUrl(m: { methodType: string; label: string | null; accountNumber: string | null; bankAccountNumber: string | null; usdtAddress: string | null }): Promise<string | null> {
  const payload = qrPayload(m);
  if (!payload) return null;
  try {
    return await QRCode.toDataURL(payload, { margin: 1, width: 240 });
  } catch {
    return null;
  }
}

/** Public-safe view of a user's payment method — no internal IDs beyond what's needed to select one. */
export interface PublicPaymentMethod {
  id: number;
  methodType: string;
  label: string | null;
  accountNumber: string | null;
  bankName: string | null;
  bankAccountName: string | null;
  bankAccountNumber: string | null;
  bankRoutingNumber: string | null;
  usdtAddress: string | null;
  usdtNetwork: string | null;
  isDefault: boolean;
  qrDataUrl: string | null;
}

export async function listActivePaymentMethods(userId: number): Promise<PublicPaymentMethod[]> {
  const rows = await db.select().from(financePaymentMethodsTable)
    .where(eq(financePaymentMethodsTable.userId, userId));
  return Promise.all(rows.filter(r => r.active === 1).map(async r => ({
    id: r.id, methodType: r.methodType, label: r.label,
    accountNumber: r.accountNumber, bankName: r.bankName,
    bankAccountName: r.bankAccountName, bankAccountNumber: r.bankAccountNumber,
    bankRoutingNumber: r.bankRoutingNumber, usdtAddress: r.usdtAddress, usdtNetwork: r.usdtNetwork,
    isDefault: r.isDefault === 1,
    qrDataUrl: await generatePaymentQrDataUrl(r),
  })));
}

export async function getInvoiceByToken(token: string): Promise<FinanceInvoice | null> {
  const [row] = await db.select().from(financeInvoicesTable).where(eq(financeInvoicesTable.invoiceToken, token)).limit(1);
  return row ?? null;
}

// ── Line items ──────────────────────────────────────────────────────────────
// finance_invoices.amount stays as a denormalized total so every existing
// reader (reminders, late fees, partial-payment math, the linked-ledger
// path) keeps working unchanged — these helpers are the one place that
// total gets computed and kept in sync with the itemized lines.

export interface InvoiceLineItemInput {
  description: string;
  quantity: number;
  unitPrice: number;
}

export function computeLineItemsTotal(lines: InvoiceLineItemInput[]): number {
  return Math.round(lines.reduce((sum, l) => sum + (l.quantity || 0) * (l.unitPrice || 0), 0) * 100) / 100;
}

/** Human, sequential-looking invoice number — <prefix>-<year>-<5-digit id>, e.g. INV-2026-00042. Minted once at invoice creation and never changes even if the year rolls over while it's still unpaid. */
export function formatInvoiceNumber(prefix: string | null | undefined, id: number, createdAt: Date = new Date()): string {
  const p = (prefix || "INV").trim().toUpperCase().replace(/[^A-Z0-9]/g, "") || "INV";
  return `${p}-${createdAt.getFullYear()}-${String(id).padStart(5, "0")}`;
}

export interface InvoiceTaxDiscountInput {
  discountType?: string | null;   // 'flat' | 'percent' | null
  discountValue?: number | null;
  taxRate?: number | null;        // percent
}

export interface InvoiceTotals {
  subtotal: number;
  discountAmount: number;
  taxableAmount: number;
  taxAmount: number;
  total: number;
}

/**
 * The one place an invoice's grand total gets composed from its line items
 * plus its (optional) discount and tax rate. Order: subtotal → discount →
 * tax-on-the-discounted-amount → total. `amount` on finance_invoices is
 * always this `total`, so reminders/late-fees/partial-payment math never
 * need to know about tax/discount — they just keep reading `amount`.
 */
export function computeInvoiceTotals(lines: InvoiceLineItemInput[], cfg: InvoiceTaxDiscountInput = {}): InvoiceTotals {
  const subtotal = computeLineItemsTotal(lines);
  const round2 = (n: number) => Math.round(n * 100) / 100;

  let discountAmount = 0;
  if (cfg.discountType === "percent") {
    discountAmount = round2(subtotal * Math.min(Math.max(cfg.discountValue || 0, 0), 100) / 100);
  } else if (cfg.discountType === "flat") {
    discountAmount = round2(Math.min(Math.max(cfg.discountValue || 0, 0), subtotal));
  }

  const taxableAmount = round2(subtotal - discountAmount);
  const taxAmount = round2(taxableAmount * Math.max(cfg.taxRate || 0, 0) / 100);
  const total = round2(taxableAmount + taxAmount);

  return { subtotal, discountAmount, taxableAmount, taxAmount, total };
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

/** Whole-number-to-words, international scale (Thousand/Million/Billion) — good enough for an invoice footer; not meant for lakh/crore-style grouping. */
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

/** "BDT Twelve Thousand and 50/100 Only" — the amount-in-words line under an enterprise invoice's totals block. Never throws; falls back to the plain number if anything about the input is unusable. */
export function amountInWords(currency: string, amount: number): string {
  try {
    const safe = Math.max(0, amount || 0);
    const whole = Math.floor(safe);
    const cents = Math.round((safe - whole) * 100);
    const words = integerToWords(whole);
    return `${currency} ${words}${cents > 0 ? ` and ${String(cents).padStart(2, "0")}/100` : ""} Only`;
  } catch {
    return `${currency} ${amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
}

export async function getInvoiceLineItems(invoiceId: number): Promise<FinanceInvoiceLineItem[]> {
  return db.select().from(financeInvoiceLineItemsTable)
    .where(eq(financeInvoiceLineItemsTable.invoiceId, invoiceId))
    .orderBy(asc(financeInvoiceLineItemsTable.sortOrder), asc(financeInvoiceLineItemsTable.id));
}

/** Replaces every line item on an invoice and returns the new computed total. Falls back to a single "Invoice total" line if the caller passes none, so every invoice keeps at least one row. */
export async function replaceInvoiceLineItems(invoiceId: number, lines: InvoiceLineItemInput[]): Promise<number> {
  const clean = (lines ?? []).filter(l => l.description?.trim());
  const effective = clean.length > 0 ? clean : [{ description: "Invoice total", quantity: 1, unitPrice: 0 }];

  await db.delete(financeInvoiceLineItemsTable).where(eq(financeInvoiceLineItemsTable.invoiceId, invoiceId));
  await db.insert(financeInvoiceLineItemsTable).values(
    effective.map((l, i) => ({
      invoiceId,
      description: l.description.trim(),
      quantity: l.quantity || 1,
      unitPrice: l.unitPrice || 0,
      sortOrder: i,
    })),
  );
  return computeLineItemsTotal(effective);
}

/** Renders a scan-to-pay QR for the public invoice link itself (distinct from the per-payment-method QR in generatePaymentQrDataUrl). Never throws. */
export async function generateInvoicePayLinkQrDataUrl(url: string): Promise<string | null> {
  try {
    return await QRCode.toDataURL(url, { margin: 1, width: 240 });
  } catch {
    return null;
  }
}

/**
 * Mints + auto-sends an invoice for a just-materialized recurring entry
 * (lib/finance-recurring-cron.ts, rule.autoInvoice) — same create+send path
 * as the manual routes/finance-invoices.ts POST /finance/invoices +
 * POST /finance/invoices/:id/send, collapsed into one call since there's no
 * request/response round trip here. Never throws — a failed auto-invoice
 * shouldn't take down the recurring sweep that's creating real ledger entries.
 */
export async function createAndSendRuleInvoice(
  entry: { id: number; userId: number; bookId: number | null; amount: number; currency: string; occurredDate: Date; title: string },
  rule: Pick<FinanceRecurringRule, "id" | "invoiceDebtorName" | "invoiceDebtorEmail" | "invoiceDebtorTelegramChatId" | "invoiceDueDays">,
): Promise<void> {
  try {
    if (!rule.invoiceDebtorName || (!rule.invoiceDebtorEmail && !rule.invoiceDebtorTelegramChatId)) return;
    const bookId = await resolveBookId(entry.userId, entry.bookId);
    const dueDate = new Date(entry.occurredDate);
    dueDate.setDate(dueDate.getDate() + (rule.invoiceDueDays ?? 7));

    const [invoice] = await db.insert(financeInvoicesTable).values({
      userId: entry.userId,
      entryId: entry.id,
      bookId,
      debtorName: rule.invoiceDebtorName,
      debtorEmail: rule.invoiceDebtorEmail ?? null,
      debtorTelegramChatId: rule.invoiceDebtorTelegramChatId ?? null,
      amount: entry.amount,
      currency: entry.currency,
      dueDate,
      notes: `Auto-generated from recurring rule #${rule.id}`,
      invoiceToken: generateInvoiceToken(),
      recurringRuleId: rule.id,
    }).returning();

    await replaceInvoiceLineItems(invoice.id, [{ description: entry.title, quantity: 1, unitPrice: entry.amount }]);

    const [creditorForNumber] = await db.select({ prefix: usersTable.financeInvoiceNumberPrefix }).from(usersTable).where(eq(usersTable.id, entry.userId));
    await db.update(financeInvoicesTable)
      .set({ invoiceNumber: formatInvoiceNumber(creditorForNumber?.prefix, invoice.id, invoice.createdAt) })
      .where(eq(financeInvoicesTable.id, invoice.id));

    const [creditor] = await db.select({ username: usersTable.username }).from(usersTable).where(eq(usersTable.id, entry.userId));
    const creditorName = creditor?.username ?? "Someone on AYZEN";
    const url = financeInvoiceUrl(invoice.invoiceToken);
    const amountStr = `${invoice.currency} ${invoice.amount.toLocaleString()}`;

    let sentEmail = false, sentTelegram = false;
    if (invoice.debtorEmail) {
      const result = await sendInvoiceEmail(invoice.debtorEmail, {
        debtorName: invoice.debtorName, creditorName, title: entry.title, amount: amountStr,
        dueDate: dueDate.toLocaleDateString(), notes: invoice.notes, url,
      });
      sentEmail = result.success;
    }
    if (invoice.debtorTelegramChatId) {
      await sendToUserWithButton(
        invoice.debtorTelegramChatId,
        `📄 *Invoice from ${creditorName}*\n\nAmount: *${amountStr}*\n\nTap below to see payment details and repay.`,
        "💳 Repay Now",
        url,
      );
      sentTelegram = true;
    }

    await db.update(financeInvoicesTable).set({
      sentViaEmail: sentEmail ? 1 : 0, sentViaTelegram: sentTelegram ? 1 : 0,
      lastSentAt: new Date(), updatedAt: new Date(),
    }).where(eq(financeInvoicesTable.id, invoice.id));

    logInvoiceEvent(invoice.id, sentEmail && sentTelegram ? "sent_email_telegram" : sentEmail ? "sent_email" : sentTelegram ? "sent_telegram" : "send_failed");
  } catch { /* recurring sweep must never fail because auto-invoicing failed */ }
}
