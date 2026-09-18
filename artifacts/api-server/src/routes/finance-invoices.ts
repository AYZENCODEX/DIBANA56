/**
 * routes/finance-invoices.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Peer-to-peer Finance invoicing + payment-agreement evidence layer. See
 * lib/finance-invoice.ts for the design note and token/URL helpers.
 *
 *  Payment methods (creditor's own receiving destinations — informational,
 *  no gateway API integration):
 *    GET/POST   /finance/payment-methods
 *    PUT/DELETE /finance/payment-methods/:id
 *
 *  Invoices (creditor, authenticated):
 *    GET    /finance/invoices                — list, optional ?entryId=
 *    POST   /finance/invoices                — create
 *    GET    /finance/invoices/:id            — detail incl. events + agreements
 *    POST   /finance/invoices/:id/send       — email/Telegram the "Repay" link
 *    DELETE /finance/invoices/:id            — cancel
 *
 *  Public "Repay" page (token-gated, no login to view):
 *    GET  /finance/invoices/public/:token
 *    POST /finance/invoices/public/:token/submit-payment   — requires login
 *
 *  Public "Payment Agreement" page (token-gated):
 *    GET  /finance/payment-agreements/public/:token
 *    POST /finance/payment-agreements/public/:token/passkey/options — requires login (must be the payer)
 *    POST /finance/payment-agreements/public/:token/passkey/verify  — requires login (must be the payer)
 *    GET  /finance/payment-agreements/public/:token/evidence-pdf    — token-gated, no login
 *
 *  Creditor review:
 *    POST /finance/payment-agreements/:id/verify — posts the real repayment
 */
import { Router } from "express";
import type { Request, Response } from "express";
import {
  db,
  financePaymentMethodsTable,
  financeInvoicesTable,
  financeInvoiceEventsTable,
  financePaymentAgreementsTable,
  financeLedgerEntriesTable,
  financeRepaymentsTable,
  usersTable,
  passkeyCredentialsTable,
} from "@workspace/db";
import { eq, and, desc, sql } from "drizzle-orm";
import {
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import { requireAuth, getRequestUser, pepDecisionObserver } from "../middlewares/auth";
import { requireOwnership, requirePublicAudit } from "../lib/policy/pep/middleware";
import { authorize } from "../lib/policy/pep";
import type { ResourceRefBuilder } from "../lib/policy/pep/types";
import { PolicyEngine } from "../lib/policy/policy-engine";
import { createResourceOwnershipRule } from "../lib/policy/resource";
import { getWebAuthnConfig, newChallengeKey, storeChallenge, consumeChallenge } from "../lib/passkey";
import { postRepaymentJournal, resolveBookId, REPAYABLE_KINDS } from "../lib/finance-accounting";
import {
  generateInvoiceToken,
  generateAgreementToken,
  financeInvoiceUrl,
  financePaymentAgreementUrl,
  logInvoiceEvent,
  getClientIpLocal,
  listActivePaymentMethods,
  getInvoiceByToken,
  getInvoiceLineItems,
  replaceInvoiceLineItems,
  generateInvoicePayLinkQrDataUrl,
  PAYMENT_METHOD_LABELS,
  formatInvoiceNumber,
  computeInvoiceTotals,
  type InvoiceLineItemInput,
} from "../lib/finance-invoice";
import { sendInvoiceEmail, sendPaymentAgreementEmail, sendPaymentAgreementReadyEmail, sendPaymentDisputedEmail } from "../lib/email";
import { sendToUser, sendToUserWithButton } from "../lib/telegram";
import { createNotification } from "./notifications";
import { streamFantasticReceiptPdf } from "../lib/receipt-theme";
import { streamInvoicePdf, type InvoiceBranding } from "../lib/invoice-pdf";

const router = Router();

function paramString(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}
function iso(d: Date | string | null | undefined) {
  if (!d) return null;
  return typeof d === "string" ? d : d.toISOString();
}
function money(currency: string, amount: number): string {
  return `${currency} ${amount.toLocaleString()}`;
}

/**
 * Accepts either the new `lineItems: [{description, quantity, unitPrice}]`
 * shape or the legacy single `amount` (kept working as a one-line invoice
 * named after the notes/a generic label, so old integrations and the
 * recurring-rule auto-invoice path don't need to change).
 */
function parseLineItemsFromBody(body: Record<string, any>): InvoiceLineItemInput[] {
  if (Array.isArray(body.lineItems) && body.lineItems.length > 0) {
    return body.lineItems.map((l: any) => ({
      description: String(l.description ?? "").trim(),
      quantity: Number(l.quantity) || 1,
      unitPrice: Number(l.unitPrice) || 0,
    }));
  }
  if (body.amount) {
    return [{ description: "Invoice total", quantity: 1, unitPrice: Number(body.amount) }];
  }
  return [];
}

function brandingFromUser(u: {
  financeInvoiceLogoUrl: string | null;
  financeInvoiceThemeColor: string | null;
  financeInvoiceBusinessName: string | null;
  financeInvoiceBusinessAddress: string | null;
  financeInvoiceFooterNote: string | null;
  financeInvoiceTaxId?: string | null;
  financeInvoiceBusinessEmail?: string | null;
  financeInvoiceBusinessPhone?: string | null;
  financeInvoiceWebsite?: string | null;
  financeInvoiceTerms?: string | null;
} | undefined): InvoiceBranding {
  return {
    logoUrl: u?.financeInvoiceLogoUrl ?? null,
    themeColor: u?.financeInvoiceThemeColor ?? null,
    businessName: u?.financeInvoiceBusinessName ?? null,
    businessAddress: u?.financeInvoiceBusinessAddress ?? null,
    footerNote: u?.financeInvoiceFooterNote ?? null,
    taxId: u?.financeInvoiceTaxId ?? null,
    businessEmail: u?.financeInvoiceBusinessEmail ?? null,
    businessPhone: u?.financeInvoiceBusinessPhone ?? null,
    website: u?.financeInvoiceWebsite ?? null,
    termsText: u?.financeInvoiceTerms ?? null,
  };
}

/**
 * Shared by the creditor-authenticated and the public token-gated PDF
 * routes below — same branded, itemized document either way, just reached
 * two different ways. Loads the creditor's branding + default payment
 * method QR + the invoice's own pay-link QR (Q&A: both QR codes appear).
 */
async function sendInvoicePdf(res: import("express").Response, invoice: typeof financeInvoicesTable.$inferSelect, creditorUserId: number): Promise<void> {
  const [creditor] = await db.select().from(usersTable).where(eq(usersTable.id, creditorUserId));
  const lineItems = await getInvoiceLineItems(invoice.id);
  const methods = await listActivePaymentMethods(creditorUserId);
  const defaultMethod = methods.find(m => m.isDefault) ?? methods[0] ?? null;
  const payLinkQrDataUrl = await generateInvoicePayLinkQrDataUrl(financeInvoiceUrl(invoice.invoiceToken));
  const totals = computeInvoiceTotals(
    lineItems.map(l => ({ description: l.description, quantity: l.quantity, unitPrice: l.unitPrice })),
    { discountType: invoice.discountType, discountValue: invoice.discountValue, taxRate: invoice.taxRate },
  );

  await streamInvoicePdf(res, {
    invoiceId: invoice.id,
    invoiceNumber: invoice.invoiceNumber || formatInvoiceNumber(creditor?.financeInvoiceNumberPrefix, invoice.id, invoice.createdAt),
    poNumber: invoice.poNumber,
    creditorName: creditor?.username ?? "AYZEN user",
    debtorName: invoice.debtorName,
    debtorEmail: invoice.debtorEmail,
    currency: invoice.currency,
    lineItems: lineItems.map(l => ({ description: l.description, quantity: l.quantity, unitPrice: l.unitPrice })),
    subtotal: totals.subtotal,
    discountType: invoice.discountType,
    discountValue: invoice.discountValue,
    discountAmount: totals.discountAmount,
    taxRate: invoice.taxRate,
    taxLabel: invoice.taxLabel,
    taxAmount: totals.taxAmount,
    amount: invoice.amount,
    paidAmount: invoice.paidAmount,
    issueDate: invoice.createdAt,
    dueDate: invoice.dueDate,
    notes: invoice.notes,
    terms: invoice.terms || creditor?.financeInvoiceTerms || null,
    status: invoice.status,
    branding: brandingFromUser(creditor),
    payLinkQrDataUrl,
    paymentMethodQrDataUrl: defaultMethod?.qrDataUrl ?? null,
    paymentMethodLabel: defaultMethod ? (defaultMethod.label || PAYMENT_METHOD_LABELS[defaultMethod.methodType]) : null,
  });
}

// ─── Payment methods ──────────────────────────────────────────────────────────

// ─── Route Integration Roadmap — Season C, Phase C3 (mechanical sweep, batch 3) ──
// Flagged in Phase C1's own "still to do" list ("finance-invoices.ts (988
// lines) — big, deserves its own batch") and left untouched through C1/C2.
// This file has FOUR distinct hand-rolled ownership questions, not one:
//  1. does this payment method belong to me (payment-methods :id)
//  2. does this invoice belong to me, the creditor (invoices :id, and the
//     invoiceId a payment agreement points at)
//  3. does this payment agreement belong to me, the PAYER (the public
//     Payment Agreement passkey flow — a different ownerId column,
//     payerUserId, on the very same table Q2 above cares about via a
//     different column, userId-of-the-linked-invoice)
//  4. does this in-memory passkey challenge belong to me (same shape as
//     Phase C2's passkey.ts register/verify challenge check)
// None of these have an admin bypass anywhere in this file (unlike Phase
// C1's support.ts/tasks.ts) — every one is "owner, full stop", same as
// Phase C2's passkey.ts/vault-reauth.ts. So `createResourceOwnershipRule()`
// alone is enough throughout; `createRoleOverrideRule()` is not needed here
// and is not registered.
//
// ── Two call shapes, same split Phase C1/C2 already established ──────────
// Where the existing hand-rolled check is the FIRST thing a handler does
// after auth (no validation, no other resource's existence check ahead of
// it), the router-level `requireOwnership()` middleware (Phase B1's
// finance.ts pattern) is used directly — `GET/POST/.../:id`-shaped routes
// below. Where something else already runs first — a body-shape validation
// (400), a DIFFERENT resource's existence check (404), or a side-effecting
// write that happens regardless of :id ownership (the payment-method
// `isDefault` reset) — moving the check to router-level middleware would
// run it BEFORE that existing step and change which response/side-effect a
// non-owner sees first, exactly the ordering hazard Phase C1/C2 already
// worked out for support.ts/tasks.ts/passkey.ts. Those routes use inline
// `authorize()` instead, at the exact point ownership was already being
// decided, same as those two phases.
//
// ── Resource lookup, not request-supplied ownerId — same as B1/C1/C2 ─────
// Every ResourceRefBuilder/inline lookup below re-reads the REAL owner
// from the DB by :id (or reuses an already-fetched row's own DB-sourced
// column, e.g. `agreement.payerUserId`) — never a client-supplied id.
// `FINANCE_INVOICE_OWNER_SENTINEL_NONE` (never a real user id —
// `usersTable.id` is a positive serial) plays the same role
// `FINANCE_OWNER_SENTINEL_NONE`/`PASSKEY_OWNER_SENTINEL_NONE`/
// `VAULT_REAUTH_OWNER_SENTINEL_NONE` already play in finance.ts/passkey.ts/
// vault-reauth.ts: a missing row still reaches the PDP as a normal,
// auditable DENY (`NO_MATCHING_POLICY`), not a 500 — and `onDeny`/the
// inline gate below renders the exact same error body these routes always
// returned for "doesn't exist" as well as "exists but isn't yours".
const FINANCE_INVOICE_OWNER_SENTINEL_NONE = -1;

const financePaymentMethodResource: ResourceRefBuilder = async (req: Request) => {
  const id = parseInt(paramString(req.params.id), 10);
  if (!Number.isFinite(id)) return { type: "finance.payment_method", id: req.params.id, ownerId: FINANCE_INVOICE_OWNER_SENTINEL_NONE };
  const [row] = await db.select({ userId: financePaymentMethodsTable.userId }).from(financePaymentMethodsTable)
    .where(eq(financePaymentMethodsTable.id, id)).limit(1);
  return { type: "finance.payment_method", id, ownerId: row?.userId ?? FINANCE_INVOICE_OWNER_SENTINEL_NONE };
};

const financeInvoiceResource: ResourceRefBuilder = async (req: Request) => {
  const id = parseInt(paramString(req.params.id), 10);
  if (!Number.isFinite(id)) return { type: "finance.invoice", id: req.params.id, ownerId: FINANCE_INVOICE_OWNER_SENTINEL_NONE };
  const [row] = await db.select({ userId: financeInvoicesTable.userId }).from(financeInvoicesTable)
    .where(eq(financeInvoicesTable.id, id)).limit(1);
  return { type: "finance.invoice", id, ownerId: row?.userId ?? FINANCE_INVOICE_OWNER_SENTINEL_NONE };
};

function requireFinancePaymentMethodOwnership(action: string) {
  return requireOwnership(action, financePaymentMethodResource, {
    onDecision: pepDecisionObserver,
    onDeny: (_req: Request, res: Response) => { res.status(404).json({ error: "Payment method not found" }); },
  });
}

function requireFinanceInvoiceOwnership(action: string) {
  return requireOwnership(action, financeInvoiceResource, {
    onDecision: pepDecisionObserver,
    onDeny: (_req: Request, res: Response) => { res.status(404).json({ error: "Invoice not found" }); },
  });
}

// Shared by every INLINE `authorize()` call below (the "something else runs
// first" routes) — one engine, module-load-time, cheap/stateless, same
// single-engine-per-file posture Phase C2's `passkeyOwnershipEngine` already
// established for a file with more than one resource type/action on it.
const financeInvoicesOwnershipEngine = new PolicyEngine({ onDecision: pepDecisionObserver });
financeInvoicesOwnershipEngine.registerRule("resource-ownership", createResourceOwnershipRule());

router.get("/finance/payment-methods", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const rows = await db.select().from(financePaymentMethodsTable)
    .where(eq(financePaymentMethodsTable.userId, authUser.userId))
    .orderBy(desc(financePaymentMethodsTable.isDefault), desc(financePaymentMethodsTable.createdAt));
  res.json(rows.map(r => ({ ...r, createdAt: iso(r.createdAt), updatedAt: iso(r.updatedAt) })));
});

router.post("/finance/payment-methods", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const body = req.body as Record<string, any>;
  if (!body.methodType) { res.status(400).json({ error: "methodType is required" }); return; }

  if (body.isDefault) {
    await db.update(financePaymentMethodsTable).set({ isDefault: 0 }).where(eq(financePaymentMethodsTable.userId, authUser.userId));
  }

  const [row] = await db.insert(financePaymentMethodsTable).values({
    userId: authUser.userId,
    methodType: body.methodType,
    label: body.label ?? null,
    accountNumber: body.accountNumber ?? null,
    bankName: body.bankName ?? null,
    bankAccountName: body.bankAccountName ?? null,
    bankAccountNumber: body.bankAccountNumber ?? null,
    bankRoutingNumber: body.bankRoutingNumber ?? null,
    usdtAddress: body.usdtAddress ?? null,
    usdtNetwork: body.usdtNetwork ?? "TRC20",
    isDefault: body.isDefault ? 1 : 0,
    active: 1,
  }).returning();
  res.status(201).json({ ...row, createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt) });
});

router.put("/finance/payment-methods/:id", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const id = parseInt(paramString(req.params.id), 10);
  const body = req.body as Record<string, any>;

  if (body.isDefault) {
    await db.update(financePaymentMethodsTable).set({ isDefault: 0 }).where(eq(financePaymentMethodsTable.userId, authUser.userId));
  }

  // Phase C3: PDP-routed ownership check, placed AFTER the isDefault reset
  // above on purpose — that reset already ran unconditionally regardless of
  // whether :id belongs to this user (existing behavior, unchanged; this
  // phase doesn't touch it, per Rule: don't remove a working system). Using
  // router-level `requireOwnership()` middleware instead would run ahead of
  // that reset, which is exactly the ordering hazard Phase C1/C2 already
  // worked out for support.ts/tasks.ts/passkey.ts.
  const [pmOwnerRow] = await db.select({ userId: financePaymentMethodsTable.userId })
    .from(financePaymentMethodsTable).where(eq(financePaymentMethodsTable.id, id)).limit(1);
  const pmOwnership = await authorize({
    req, engine: financeInvoicesOwnershipEngine, action: "finance.payment_method.update",
    resource: { type: "finance.payment_method", id, ownerId: pmOwnerRow?.userId ?? FINANCE_INVOICE_OWNER_SENTINEL_NONE },
  });
  if (pmOwnership.decision.effect !== "ALLOW") { res.status(404).json({ error: "Payment method not found" }); return; }

  const { id: _id, userId: _uid, createdAt: _ca, ...patch } = body;
  const [row] = await db.update(financePaymentMethodsTable)
    .set({ ...patch, isDefault: body.isDefault ? 1 : (body.isDefault === false ? 0 : undefined), updatedAt: new Date() })
    .where(and(eq(financePaymentMethodsTable.id, id), eq(financePaymentMethodsTable.userId, authUser.userId)))
    .returning();
  if (!row) { res.status(404).json({ error: "Payment method not found" }); return; } // unreachable given ALLOW above, kept as defensive/unchanged
  res.json({ ...row, createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt) });
});

router.delete("/finance/payment-methods/:id", requireAuth, requireFinancePaymentMethodOwnership("finance.payment_method.delete"), async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const id = parseInt(paramString(req.params.id), 10);
  const deleted = await db.delete(financePaymentMethodsTable)
    .where(and(eq(financePaymentMethodsTable.id, id), eq(financePaymentMethodsTable.userId, authUser.userId)))
    .returning();
  if (!deleted.length) { res.status(404).json({ error: "Payment method not found" }); return; }
  res.json({ success: true });
});

// ─── Invoices (creditor side) ─────────────────────────────────────────────────

router.get("/finance/invoices", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const entryId = req.query.entryId ? parseInt(paramString(req.query.entryId as any), 10) : undefined;

  const conditions = [eq(financeInvoicesTable.userId, authUser.userId)];
  if (entryId) conditions.push(eq(financeInvoicesTable.entryId, entryId));

  const rows = await db.select().from(financeInvoicesTable)
    .where(and(...conditions))
    .orderBy(desc(financeInvoicesTable.createdAt));
  res.json(rows.map(r => ({
    ...r, dueDate: iso(r.dueDate), lastSentAt: iso(r.lastSentAt), cancelledAt: iso(r.cancelledAt),
    createdAt: iso(r.createdAt), updatedAt: iso(r.updatedAt),
  })));
});

router.post("/finance/invoices", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const body = req.body as Record<string, any>;
  const lineItems = parseLineItemsFromBody(body);
  if (!body.debtorName || lineItems.filter(l => l.description).length === 0) {
    res.status(400).json({ error: "debtorName and at least one line item (description + amount) are required" }); return;
  }
  if (!body.debtorEmail && !body.debtorTelegramChatId) {
    res.status(400).json({ error: "Provide at least a debtorEmail or debtorTelegramChatId to send the invoice to" }); return;
  }

  // If linked to an existing entry, confirm ownership so an invoice can't be
  // minted against someone else's ledger row. Also confirm the entry's kind
  // actually supports repayments — the payment-agreement verify flow below
  // posts a real repayment against invoice.entryId once the payer confirms,
  // and lib/finance-accounting.ts's KIND_REPAYMENT_POSTING has no mapping
  // for 'expense'/'income' (immediate cash transactions, nothing "owed"),
  // so allowing an invoice to link there would let a payer "pay off" an
  // entry that silently never posts to the double-entry books.
  if (body.entryId) {
    const [entry] = await db.select({ id: financeLedgerEntriesTable.id, kind: financeLedgerEntriesTable.kind }).from(financeLedgerEntriesTable)
      .where(and(eq(financeLedgerEntriesTable.id, body.entryId), eq(financeLedgerEntriesTable.userId, authUser.userId)));
    if (!entry) { res.status(404).json({ error: "Linked entry not found" }); return; }
    if (!REPAYABLE_KINDS.has(entry.kind)) {
      res.status(400).json({ error: `Invoices can't be linked to '${entry.kind}' entries — they're recorded as fully settled at creation.` });
      return;
    }
  }

  const bookId = await resolveBookId(authUser.userId, body.bookId ?? null);
  const discountType = body.discountType === "flat" || body.discountType === "percent" ? body.discountType : null;
  const discountValue = discountType ? (Number(body.discountValue) || 0) : 0;
  const taxRate = Number(body.taxRate) > 0 ? Math.min(Number(body.taxRate), 100) : 0;
  const totals = computeInvoiceTotals(lineItems, { discountType, discountValue, taxRate });

  const [row] = await db.insert(financeInvoicesTable).values({
    userId: authUser.userId,
    entryId: body.entryId ?? null,
    bookId,
    debtorName: body.debtorName,
    debtorEmail: body.debtorEmail ?? null,
    debtorTelegramChatId: body.debtorTelegramChatId ?? null,
    amount: totals.total,
    currency: body.currency ?? "BDT",
    dueDate: body.dueDate ? new Date(body.dueDate) : null,
    notes: body.notes ?? null,
    poNumber: body.poNumber ?? null,
    discountType, discountValue, taxRate,
    taxLabel: body.taxLabel ?? "Tax",
    terms: body.terms ?? null,
    invoiceToken: generateInvoiceToken(),
  }).returning();

  const [creditorForNumber] = await db.select({ prefix: usersTable.financeInvoiceNumberPrefix }).from(usersTable).where(eq(usersTable.id, authUser.userId));
  const invoiceNumber = formatInvoiceNumber(creditorForNumber?.prefix, row.id, row.createdAt);
  const [numbered] = await db.update(financeInvoicesTable).set({ invoiceNumber }).where(eq(financeInvoicesTable.id, row.id)).returning();

  await replaceInvoiceLineItems(row.id, lineItems);

  res.status(201).json({
    ...numbered, dueDate: iso(numbered.dueDate), createdAt: iso(numbered.createdAt), updatedAt: iso(numbered.updatedAt),
    lineItems: await getInvoiceLineItems(row.id),
  });
});

// Replaces every line item on an invoice and recomputes its total — blocked
// once money has actually moved against it (a payment claim submitted or
// verified), same as the rest of this file protects a settled invoice from
// being quietly edited out from under a debtor who already paid.
router.put("/finance/invoices/:id/line-items", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const id = parseInt(paramString(req.params.id), 10);
  const body = req.body as Record<string, any>;
  const { lineItems } = body as { lineItems?: any[] };
  if (!Array.isArray(lineItems) || lineItems.length === 0) { res.status(400).json({ error: "lineItems must be a non-empty array" }); return; }

  // Phase C3: PDP-routed ownership check, placed AFTER the lineItems
  // shape validation above (unchanged — a malformed body still gets 400
  // before ownership is even considered, same order as before this phase).
  const [liInvoiceOwnerRow] = await db.select({ userId: financeInvoicesTable.userId })
    .from(financeInvoicesTable).where(eq(financeInvoicesTable.id, id)).limit(1);
  const liOwnership = await authorize({
    req, engine: financeInvoicesOwnershipEngine, action: "finance.invoice.line_items.update",
    resource: { type: "finance.invoice", id, ownerId: liInvoiceOwnerRow?.userId ?? FINANCE_INVOICE_OWNER_SENTINEL_NONE },
  });
  if (liOwnership.decision.effect !== "ALLOW") { res.status(404).json({ error: "Invoice not found" }); return; }

  const [invoice] = await db.select().from(financeInvoicesTable)
    .where(and(eq(financeInvoicesTable.id, id), eq(financeInvoicesTable.userId, authUser.userId)));
  if (!invoice) { res.status(404).json({ error: "Invoice not found" }); return; } // unreachable given ALLOW above, kept as defensive/unchanged
  if (invoice.paidAmount > 0 || !["sent", "viewed"].includes(invoice.status)) {
    res.status(400).json({ error: "This invoice already has a payment claim on it — cancel it and create a new one instead of editing the lines." }); return;
  }

  const parsed = parseLineItemsFromBody({ lineItems });
  await replaceInvoiceLineItems(id, parsed);

  const discountType = "discountType" in body ? (body.discountType === "flat" || body.discountType === "percent" ? body.discountType : null) : invoice.discountType;
  const discountValue = "discountValue" in body ? (Number(body.discountValue) || 0) : invoice.discountValue;
  const taxRate = "taxRate" in body ? Math.min(Math.max(Number(body.taxRate) || 0, 0), 100) : invoice.taxRate;
  const totals = computeInvoiceTotals(parsed, { discountType, discountValue, taxRate });

  const patch: Record<string, any> = { amount: totals.total, discountType, discountValue, taxRate, updatedAt: new Date() };
  if ("poNumber" in body) patch.poNumber = body.poNumber || null;
  if ("terms" in body) patch.terms = body.terms || null;
  if ("taxLabel" in body) patch.taxLabel = body.taxLabel || "Tax";

  const [row] = await db.update(financeInvoicesTable).set(patch)
    .where(eq(financeInvoicesTable.id, id)).returning();

  res.json({ ...row, dueDate: iso(row.dueDate), createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt), lineItems: await getInvoiceLineItems(id) });
});

router.get("/finance/invoices/:id", requireAuth, requireFinanceInvoiceOwnership("finance.invoice.read"), async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const id = parseInt(paramString(req.params.id), 10);
  const [invoice] = await db.select().from(financeInvoicesTable)
    .where(and(eq(financeInvoicesTable.id, id), eq(financeInvoicesTable.userId, authUser.userId)));
  if (!invoice) { res.status(404).json({ error: "Invoice not found" }); return; }

  const events = await db.select().from(financeInvoiceEventsTable)
    .where(eq(financeInvoiceEventsTable.invoiceId, id)).orderBy(desc(financeInvoiceEventsTable.createdAt));
  const agreements = await db.select().from(financePaymentAgreementsTable)
    .where(eq(financePaymentAgreementsTable.invoiceId, id)).orderBy(desc(financePaymentAgreementsTable.createdAt));
  const lineItems = await getInvoiceLineItems(id);

  res.json({
    ...invoice, dueDate: iso(invoice.dueDate), lastSentAt: iso(invoice.lastSentAt),
    cancelledAt: iso(invoice.cancelledAt), createdAt: iso(invoice.createdAt), updatedAt: iso(invoice.updatedAt),
    lineItems,
    events: events.map(e => ({ ...e, createdAt: iso(e.createdAt) })),
    agreements: agreements.map(a => ({
      ...a, submittedAt: iso(a.submittedAt), confirmedAt: iso(a.confirmedAt),
      creditorVerifiedAt: iso(a.creditorVerifiedAt), createdAt: iso(a.createdAt), updatedAt: iso(a.updatedAt),
    })),
  });
});

// Creditor's own branded, itemized copy of the invoice — same renderer and
// same branding fields as the public download below, just authenticated
// and addressed by invoice id instead of token.
router.get("/finance/invoices/:id/pdf", requireAuth, requireFinanceInvoiceOwnership("finance.invoice.read_pdf"), async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const id = parseInt(paramString(req.params.id), 10);
  const [invoice] = await db.select().from(financeInvoicesTable)
    .where(and(eq(financeInvoicesTable.id, id), eq(financeInvoicesTable.userId, authUser.userId)));
  if (!invoice) { res.status(404).json({ error: "Invoice not found" }); return; }
  await sendInvoicePdf(res, invoice, authUser.userId);
});

router.post("/finance/invoices/:id/send", requireAuth, requireFinanceInvoiceOwnership("finance.invoice.send"), async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const id = parseInt(paramString(req.params.id), 10);
  const { channels } = req.body as { channels?: string[] };
  const wantEmail = !channels || channels.includes("email");
  const wantTelegram = !channels || channels.includes("telegram");

  const [invoice] = await db.select().from(financeInvoicesTable)
    .where(and(eq(financeInvoicesTable.id, id), eq(financeInvoicesTable.userId, authUser.userId)));
  if (!invoice) { res.status(404).json({ error: "Invoice not found" }); return; }

  const [creditor] = await db.select({ username: usersTable.username }).from(usersTable).where(eq(usersTable.id, authUser.userId));
  const creditorName = creditor?.username ?? "Someone on AYZEN";
  const url = financeInvoiceUrl(invoice.invoiceToken);
  const amountStr = money(invoice.currency, invoice.amount);

  let sentEmail = false, sentTelegram = false;

  if (wantEmail && invoice.debtorEmail) {
    const result = await sendInvoiceEmail(invoice.debtorEmail, {
      debtorName: invoice.debtorName, creditorName, title: `Invoice #${invoice.id}`, amount: amountStr,
      dueDate: invoice.dueDate ? new Date(invoice.dueDate).toLocaleDateString() : null, notes: invoice.notes, url,
    });
    sentEmail = result.success;
  }
  if (wantTelegram && invoice.debtorTelegramChatId) {
    await sendToUserWithButton(
      invoice.debtorTelegramChatId,
      `📄 *Invoice from ${creditorName}*\n\nAmount: *${amountStr}*\n\nTap below to see payment details and repay.`,
      "💳 Repay Now",
      url,
    );
    sentTelegram = true;
  }

  await db.update(financeInvoicesTable).set({
    status: invoice.status === "sent" || invoice.status === "viewed" ? "sent" : invoice.status,
    sentViaEmail: sentEmail ? 1 : invoice.sentViaEmail,
    sentViaTelegram: sentTelegram ? 1 : invoice.sentViaTelegram,
    lastSentAt: new Date(), updatedAt: new Date(),
  }).where(eq(financeInvoicesTable.id, id));

  logInvoiceEvent(id, sentEmail && sentTelegram ? "sent_email_telegram" : sentEmail ? "sent_email" : sentTelegram ? "sent_telegram" : "send_failed", req)
    .catch(() => {});

  res.json({ sentEmail, sentTelegram, url });
});

router.delete("/finance/invoices/:id", requireAuth, requireFinanceInvoiceOwnership("finance.invoice.cancel"), async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const id = parseInt(paramString(req.params.id), 10);
  const [row] = await db.update(financeInvoicesTable)
    .set({ status: "cancelled", cancelledAt: new Date(), updatedAt: new Date() })
    .where(and(eq(financeInvoicesTable.id, id), eq(financeInvoicesTable.userId, authUser.userId)))
    .returning();
  if (!row) { res.status(404).json({ error: "Invoice not found" }); return; }
  res.json({ success: true });
});

// ─── Public "Repay" page ──────────────────────────────────────────────────────

router.get("/finance/invoices/public/:token", requirePublicAudit("finance_invoice_public.view", { onDecision: pepDecisionObserver }), async (req, res): Promise<void> => {
  const token = paramString(req.params.token);
  const invoice = await getInvoiceByToken(token);
  if (!invoice || invoice.status === "cancelled") { res.status(404).json({ error: "This invoice link is invalid or has been cancelled." }); return; }

  const [creditor] = await db.select().from(usersTable).where(eq(usersTable.id, invoice.userId));
  const paymentMethods = await listActivePaymentMethods(invoice.userId);
  const lineItems = await getInvoiceLineItems(invoice.id);
  const payLinkQrDataUrl = await generateInvoicePayLinkQrDataUrl(financeInvoiceUrl(invoice.invoiceToken));

  if (invoice.status === "sent") {
    await db.update(financeInvoicesTable).set({ status: "viewed", updatedAt: new Date() }).where(eq(financeInvoicesTable.id, invoice.id));
    logInvoiceEvent(invoice.id, "viewed", req).catch(() => {});
  }

  const totals = computeInvoiceTotals(
    lineItems.map(l => ({ description: l.description, quantity: l.quantity, unitPrice: l.unitPrice })),
    { discountType: invoice.discountType, discountValue: invoice.discountValue, taxRate: invoice.taxRate },
  );

  res.json({
    id: invoice.id,
    invoiceNumber: invoice.invoiceNumber || formatInvoiceNumber(creditor?.financeInvoiceNumberPrefix, invoice.id, invoice.createdAt),
    poNumber: invoice.poNumber,
    creditorName: creditor?.username ?? "AYZEN user",
    debtorName: invoice.debtorName,
    amount: invoice.amount,
    currency: invoice.currency,
    subtotal: totals.subtotal,
    discountType: invoice.discountType,
    discountValue: invoice.discountValue,
    discountAmount: totals.discountAmount,
    taxRate: invoice.taxRate,
    taxLabel: invoice.taxLabel,
    taxAmount: totals.taxAmount,
    issueDate: iso(invoice.createdAt),
    dueDate: iso(invoice.dueDate),
    notes: invoice.notes,
    terms: invoice.terms || creditor?.financeInvoiceTerms || null,
    status: invoice.status,
    paidAmount: invoice.paidAmount,
    remainingAmount: Math.max(0, invoice.amount - invoice.paidAmount),
    lineItems,
    branding: brandingFromUser(creditor),
    payLinkQrDataUrl,
    paymentMethods,
  });
});

// Same branded, itemized PDF as the authenticated creditor copy above, but
// reached by anyone holding the invoice token — no login, matching every
// other public/:token surface in this file (e.g. the evidence PDF below).
router.get("/finance/invoices/public/:token/pdf", requirePublicAudit("finance_invoice_public.pdf", { onDecision: pepDecisionObserver }), async (req, res): Promise<void> => {
  const token = paramString(req.params.token);
  const invoice = await getInvoiceByToken(token);
  if (!invoice || invoice.status === "cancelled") { res.status(404).json({ error: "This invoice link is invalid or has been cancelled." }); return; }
  await sendInvoicePdf(res, invoice, invoice.userId);
});

// ─── Invoice branding (per-user logo/theme, reused on every invoice) ─────────

const BRANDING_COLUMNS = {
  logoUrl: usersTable.financeInvoiceLogoUrl,
  themeColor: usersTable.financeInvoiceThemeColor,
  businessName: usersTable.financeInvoiceBusinessName,
  businessAddress: usersTable.financeInvoiceBusinessAddress,
  footerNote: usersTable.financeInvoiceFooterNote,
  taxId: usersTable.financeInvoiceTaxId,
  businessEmail: usersTable.financeInvoiceBusinessEmail,
  businessPhone: usersTable.financeInvoiceBusinessPhone,
  website: usersTable.financeInvoiceWebsite,
  termsText: usersTable.financeInvoiceTerms,
  numberPrefix: usersTable.financeInvoiceNumberPrefix,
};

router.get("/finance/invoice-branding", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const [row] = await db.select(BRANDING_COLUMNS).from(usersTable).where(eq(usersTable.id, authUser.userId));
  res.json(row ?? {
    logoUrl: null, themeColor: "#00a89f", businessName: null, businessAddress: null, footerNote: null,
    taxId: null, businessEmail: null, businessPhone: null, website: null, termsText: null, numberPrefix: "INV",
  });
});

router.put("/finance/invoice-branding", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const body = req.body as Record<string, any>;
  if (body.themeColor && !/^#[0-9a-fA-F]{6}$/.test(body.themeColor)) {
    res.status(400).json({ error: "themeColor must be a 6-digit hex color, e.g. #00a89f" }); return;
  }

  const patch: Record<string, any> = {};
  if ("logoUrl" in body) patch.financeInvoiceLogoUrl = body.logoUrl || null;
  if ("themeColor" in body) patch.financeInvoiceThemeColor = body.themeColor || "#00a89f";
  if ("businessName" in body) patch.financeInvoiceBusinessName = body.businessName || null;
  if ("businessAddress" in body) patch.financeInvoiceBusinessAddress = body.businessAddress || null;
  if ("footerNote" in body) patch.financeInvoiceFooterNote = body.footerNote || null;
  if ("taxId" in body) patch.financeInvoiceTaxId = body.taxId || null;
  if ("businessEmail" in body) patch.financeInvoiceBusinessEmail = body.businessEmail || null;
  if ("businessPhone" in body) patch.financeInvoiceBusinessPhone = body.businessPhone || null;
  if ("website" in body) patch.financeInvoiceWebsite = body.website || null;
  if ("termsText" in body) patch.financeInvoiceTerms = body.termsText || null;
  if ("numberPrefix" in body) patch.financeInvoiceNumberPrefix = (body.numberPrefix || "INV").toString().trim().toUpperCase().replace(/[^A-Z0-9]/g, "") || "INV";

  const [row] = await db.update(usersTable).set(patch).where(eq(usersTable.id, authUser.userId)).returning(BRANDING_COLUMNS);
  res.json(row);
});

router.post("/finance/invoices/public/:token/submit-payment", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const token = paramString(req.params.token);
  const { methodType, referenceId, amount } = req.body as { methodType?: string; referenceId?: string; amount?: number };
  if (!methodType) { res.status(400).json({ error: "methodType is required" }); return; }

  const invoice = await getInvoiceByToken(token);
  if (!invoice || invoice.status === "cancelled") { res.status(404).json({ error: "This invoice link is invalid or has been cancelled." }); return; }
  if (invoice.status === "paid" || invoice.status === "creditor_verified") { res.status(400).json({ error: "This invoice is already fully paid." }); return; }
  if (invoice.status === "disputed") { res.status(400).json({ error: "This invoice's last payment claim was disputed. Contact the creditor before submitting a new one." }); return; }

  const remaining = Math.max(0, invoice.amount - invoice.paidAmount);
  const claimAmount = amount ?? remaining;
  if (claimAmount > remaining + 0.01) { res.status(400).json({ error: `Amount exceeds the remaining balance of ${invoice.currency} ${remaining.toLocaleString()}.` }); return; }

  const [agreement] = await db.insert(financePaymentAgreementsTable).values({
    invoiceId: invoice.id,
    payerUserId: authUser.userId,
    methodType,
    referenceId: referenceId ?? null,
    amount: claimAmount,
    submittedAt: new Date(),
    agreementToken: generateAgreementToken(),
  }).returning();

  await db.update(financeInvoicesTable).set({ status: "payment_submitted", updatedAt: new Date() }).where(eq(financeInvoicesTable.id, invoice.id));
  logInvoiceEvent(invoice.id, "payment_submitted", req, { methodType, referenceId, amount: claimAmount }).catch(() => {});

  // Notify the creditor a claim came in.
  createNotification(invoice.userId, "finance_payment_submitted", "Payment submitted",
    `${invoice.debtorName} says they paid ${money(invoice.currency, agreement.amount)} via ${PAYMENT_METHOD_LABELS[methodType] ?? methodType}.`,
    { invoiceId: invoice.id, agreementId: agreement.id }).catch(() => {});

  // Send the payer their own "Confirm Payment" template — same button-based
  // pattern as the invoice email, this time leading to the Payment
  // Agreement / passkey-confirm page.
  const agreementUrl = financePaymentAgreementUrl(agreement.agreementToken);
  const [payer] = await db.select({ email: usersTable.email, username: usersTable.username, telegramChatId: usersTable.telegramChatId })
    .from(usersTable).where(eq(usersTable.id, authUser.userId));
  const [creditor] = await db.select({ username: usersTable.username }).from(usersTable).where(eq(usersTable.id, invoice.userId));
  const creditorName = creditor?.username ?? "the creditor";
  if (payer?.email) {
    sendPaymentAgreementEmail(payer.email, {
      debtorName: payer.username ?? invoice.debtorName, creditorName, title: `Invoice #${invoice.id}`,
      amount: money(invoice.currency, agreement.amount), methodLabel: PAYMENT_METHOD_LABELS[methodType] ?? methodType, url: agreementUrl,
    }).catch(() => {});
  }
  if (payer?.telegramChatId) {
    sendToUserWithButton(
      payer.telegramChatId,
      `✅ *Payment noted*\n\nYou said you paid ${money(invoice.currency, agreement.amount)} to ${creditorName}. Confirm it with your passkey to keep it as evidence.`,
      "🔏 Confirm Payment",
      agreementUrl,
    ).catch(() => {});
  }

  res.status(201).json({ agreementToken: agreement.agreementToken, agreementUrl });
});

// ─── Public "Payment Agreement" page ─────────────────────────────────────────

router.get("/finance/payment-agreements/public/:token", requirePublicAudit("finance_payment_agreement_public.view", { onDecision: pepDecisionObserver }), async (req, res): Promise<void> => {
  const token = paramString(req.params.token);
  const [agreement] = await db.select().from(financePaymentAgreementsTable).where(eq(financePaymentAgreementsTable.agreementToken, token));
  if (!agreement) { res.status(404).json({ error: "This payment agreement link is invalid." }); return; }

  const [invoice] = await db.select().from(financeInvoicesTable).where(eq(financeInvoicesTable.id, agreement.invoiceId));
  const [creditor] = invoice ? await db.select({ username: usersTable.username }).from(usersTable).where(eq(usersTable.id, invoice.userId)) : [null];

  res.json({
    id: agreement.id,
    status: agreement.status,
    methodType: agreement.methodType,
    referenceId: agreement.referenceId,
    amount: agreement.amount,
    submittedAt: iso(agreement.submittedAt),
    confirmedAt: iso(agreement.confirmedAt),
    creditorVerifiedAt: iso(agreement.creditorVerifiedAt),
    disputedAt: iso(agreement.disputedAt),
    disputeReason: agreement.disputeReason,
    invoiceTitle: invoice ? `Invoice #${invoice.id}` : null,
    currency: invoice?.currency ?? "BDT",
    creditorName: creditor?.username ?? null,
    debtorName: invoice?.debtorName ?? null,
    evidenceAvailable: agreement.status === "passkey_confirmed" || agreement.status === "creditor_verified",
  });
});

router.post("/finance/payment-agreements/public/:token/passkey/options", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const token = paramString(req.params.token);
  const [agreement] = await db.select().from(financePaymentAgreementsTable).where(eq(financePaymentAgreementsTable.agreementToken, token));
  if (!agreement) { res.status(404).json({ error: "This payment agreement link is invalid." }); return; }
  // Phase C3: PDP-routed, replacing the hand-rolled `!==` directly — same
  // shape `vault-reauth.ts`'s Phase C2 check used (a real, DB-sourced
  // column already fetched above, no new query needed; the comparison
  // gates what happens next, it isn't itself a "final enforcement" DB
  // write the way passkey.ts's PATCH/DELETE were, so there's no ordering
  // reason to keep a separate hand-rolled copy around this one).
  const payerOwnership = await authorize({
    req, engine: financeInvoicesOwnershipEngine, action: "finance.payment_agreement.passkey_options",
    resource: { type: "finance.payment_agreement", id: agreement.id, ownerId: agreement.payerUserId ?? FINANCE_INVOICE_OWNER_SENTINEL_NONE },
  });
  if (payerOwnership.decision.effect !== "ALLOW") { res.status(403).json({ error: "This payment agreement doesn't belong to your account." }); return; }
  if (agreement.status !== "submitted") { res.status(400).json({ error: `This agreement is already ${agreement.status}.` }); return; }

  const creds = await db.select().from(passkeyCredentialsTable).where(eq(passkeyCredentialsTable.userId, authUser.userId));
  if (creds.length === 0) { res.status(400).json({ error: "No passkey registered on your account yet. Add one in Settings → Security before confirming." }); return; }

  const webAuthn = getWebAuthnConfig(req);
  const options = await generateAuthenticationOptions({
    rpID: webAuthn.rpID,
    allowCredentials: creds.map((c) => ({ id: c.credentialId, transports: c.transports ? (c.transports.split(",") as any[]) : undefined })),
    userVerification: "preferred",
  });

  const challengeKey = newChallengeKey();
  storeChallenge(challengeKey, options.challenge, authUser.userId);
  res.json({ options, challengeKey });
});

router.post("/finance/payment-agreements/public/:token/passkey/verify", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const token = paramString(req.params.token);
  const { challengeKey, response } = req.body as { challengeKey?: string; response?: any };
  if (!challengeKey || !response) { res.status(400).json({ error: "challengeKey and response are required" }); return; }

  const [agreement] = await db.select().from(financePaymentAgreementsTable).where(eq(financePaymentAgreementsTable.agreementToken, token));
  if (!agreement) { res.status(404).json({ error: "This payment agreement link is invalid." }); return; }
  // Phase C3: same payer-ownership check as passkey/options above, PDP-routed.
  const payerOwnership = await authorize({
    req, engine: financeInvoicesOwnershipEngine, action: "finance.payment_agreement.passkey_verify",
    resource: { type: "finance.payment_agreement", id: agreement.id, ownerId: agreement.payerUserId ?? FINANCE_INVOICE_OWNER_SENTINEL_NONE },
  });
  if (payerOwnership.decision.effect !== "ALLOW") { res.status(403).json({ error: "This payment agreement doesn't belong to your account." }); return; }
  if (agreement.status !== "submitted") { res.status(400).json({ error: `This agreement is already ${agreement.status}.` }); return; }

  // Phase C3: a SECOND, distinct ownership question — the in-memory
  // WebAuthn challenge's own userId, same shape as Phase C2's
  // `passkey.ts` register/verify challenge check. `!entry` (expired/
  // unknown challengeKey) stays hand-rolled — existence, not ownership,
  // same split Phase C1/C2 already draw. Only the ownership half
  // (`entry.userId !== authUser.userId`) goes through the PDP; same
  // combined "Challenge expired or invalid. Try again." response either
  // way, byte-for-byte.
  const entry = consumeChallenge(challengeKey);
  if (!entry) { res.status(400).json({ error: "Challenge expired or invalid. Try again." }); return; }
  const challengeOwnership = await authorize({
    req, engine: financeInvoicesOwnershipEngine, action: "finance.payment_agreement.passkey_challenge.verify",
    resource: { type: "finance.payment_agreement_passkey_challenge", id: challengeKey, ownerId: entry.userId ?? FINANCE_INVOICE_OWNER_SENTINEL_NONE },
  });
  if (challengeOwnership.decision.effect !== "ALLOW") { res.status(400).json({ error: "Challenge expired or invalid. Try again." }); return; }

  const credentialId: string | undefined = response.id;
  if (!credentialId) { res.status(400).json({ error: "Malformed passkey response" }); return; }
  const [cred] = await db.select().from(passkeyCredentialsTable)
    .where(and(eq(passkeyCredentialsTable.credentialId, credentialId), eq(passkeyCredentialsTable.userId, authUser.userId)));
  if (!cred) { res.status(401).json({ error: "This passkey is not registered on your account" }); return; }

  try {
    const webAuthn = getWebAuthnConfig(req);
    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: entry.challenge,
      expectedOrigin: webAuthn.origin,
      expectedRPID: webAuthn.rpID,
      credential: {
        id: cred.credentialId,
        publicKey: new Uint8Array(Buffer.from(cred.publicKey, "base64url")),
        counter: cred.counter,
        transports: cred.transports ? (cred.transports.split(",") as any[]) : undefined,
      },
    });
    if (!verification.verified) { res.status(401).json({ error: "Passkey verification failed" }); return; }

    await db.update(passkeyCredentialsTable)
      .set({ counter: verification.authenticationInfo.newCounter, lastUsedAt: new Date() })
      .where(eq(passkeyCredentialsTable.id, cred.id));

    const ip = getClientIpLocal(req);
    const userAgent = (req.headers["user-agent"] as string) || null;

    const [updated] = await db.update(financePaymentAgreementsTable).set({
      status: "passkey_confirmed", confirmedAt: new Date(), passkeyCredentialId: cred.id,
      ipAddress: ip, userAgent, updatedAt: new Date(),
    }).where(eq(financePaymentAgreementsTable.id, agreement.id)).returning();

    logInvoiceEvent(agreement.invoiceId, "agreement_confirmed", req, { agreementId: agreement.id, passkeyCredentialId: cred.id }).catch(() => {});

    // Tell the creditor it's ready to verify.
    const [invoice] = await db.select().from(financeInvoicesTable).where(eq(financeInvoicesTable.id, agreement.invoiceId));
    if (invoice) {
      const [payer] = await db.select({ username: usersTable.username }).from(usersTable).where(eq(usersTable.id, authUser.userId));
      const [creditor] = await db.select({ username: usersTable.username, email: usersTable.email, telegramChatId: usersTable.telegramChatId })
        .from(usersTable).where(eq(usersTable.id, invoice.userId));
      const payerName = payer?.username ?? invoice.debtorName;
      createNotification(invoice.userId, "finance_payment_confirmed", "Payment confirmed with passkey",
        `${payerName} signed a Payment Agreement for ${money(invoice.currency, updated.amount)}. Review and verify to mark it repaid.`,
        { invoiceId: invoice.id, agreementId: agreement.id }).catch(() => {});
      const reviewUrl = `${process.env.APP_URL ?? "https://ayzen.replit.app"}/finance/invoices`;
      if (creditor?.email) {
        sendPaymentAgreementReadyEmail(creditor.email, {
          creditorName: creditor.username ?? "there", debtorName: payerName, title: `Invoice #${invoice.id}`,
          amount: money(invoice.currency, updated.amount), url: reviewUrl,
        }).catch(() => {});
      }
      if (creditor?.telegramChatId) {
        sendToUser(creditor.telegramChatId, `🔏 *${payerName}* signed a Payment Agreement for *${money(invoice.currency, updated.amount)}* — review it in Finance → Invoices.`).catch(() => {});
      }
    }

    res.json({
      verified: true,
      evidencePdfUrl: `${process.env.APP_URL ?? "https://ayzen.replit.app"}/api/finance/payment-agreements/public/${token}/evidence-pdf`,
    });
  } catch (err: any) {
    res.status(401).json({ error: err.message || "Passkey verification failed" });
  }
});

router.get("/finance/payment-agreements/public/:token/evidence-pdf", requirePublicAudit("finance_payment_agreement_public.evidence_pdf", { onDecision: pepDecisionObserver }), async (req, res): Promise<void> => {
  const token = paramString(req.params.token);
  const [agreement] = await db.select().from(financePaymentAgreementsTable).where(eq(financePaymentAgreementsTable.agreementToken, token));
  if (!agreement || (agreement.status !== "passkey_confirmed" && agreement.status !== "creditor_verified")) {
    res.status(404).json({ error: "This evidence document isn't available yet." }); return;
  }
  const [invoice] = await db.select().from(financeInvoicesTable).where(eq(financeInvoicesTable.id, agreement.invoiceId));
  const [creditor] = invoice ? await db.select({ username: usersTable.username }).from(usersTable).where(eq(usersTable.id, invoice.userId)) : [null];
  const [payer] = agreement.payerUserId
    ? await db.select({ username: usersTable.username }).from(usersTable).where(eq(usersTable.id, agreement.payerUserId))
    : [null];

  streamFantasticReceiptPdf(res, {
    kicker: "Payment Agreement",
    title: `${payer?.username ?? invoice?.debtorName ?? "Payer"} → ${creditor?.username ?? "Creditor"}`,
    subtitle: invoice ? `Invoice #${invoice.id}` : undefined,
    avatarLetter: (payer?.username ?? invoice?.debtorName ?? "P").charAt(0).toUpperCase(),
    heroValue: money(invoice?.currency ?? "BDT", agreement.amount),
    heroLabel: "Amount Confirmed Paid",
    heroPositive: true,
    stats: [
      { label: "Method", value: PAYMENT_METHOD_LABELS[agreement.methodType] ?? agreement.methodType },
      { label: "Reference / Txn ID", value: agreement.referenceId ?? "—" },
      { label: "Submitted", value: agreement.submittedAt ? new Date(agreement.submittedAt).toLocaleString() : "—" },
      { label: "Passkey-confirmed", value: agreement.confirmedAt ? new Date(agreement.confirmedAt).toLocaleString() : "—" },
      { label: "IP address", value: agreement.ipAddress ?? "—" },
      { label: "Device", value: agreement.userAgent ?? "—" },
      { label: "Status", value: agreement.status === "creditor_verified" ? "Verified by creditor" : "Confirmed by payer (awaiting creditor review)" },
    ],
    notes: "Digitally signed by the payer using their AYZEN account passkey (WebAuthn). The IP address and device above were captured at the moment of signing as evidence of payment.",
    receiptId: agreement.id,
    issuedBy: creditor?.username ?? null,
    filenamePrefix: "payment-agreement",
  });
});

// ─── Creditor review ──────────────────────────────────────────────────────────

router.post("/finance/payment-agreements/:id/verify", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const id = parseInt(paramString(req.params.id), 10);
  const { notes } = req.body as { notes?: string };

  const [agreement] = await db.select().from(financePaymentAgreementsTable).where(eq(financePaymentAgreementsTable.id, id));
  if (!agreement) { res.status(404).json({ error: "Payment agreement not found" }); return; }

  // Phase C3: PDP-routed ownership check ahead of the existing filtered
  // lookup below (kept, unchanged — this phase adds a second,
  // observable layer, same "don't remove a working system" posture Phase
  // B1/C1/C2 already established). Ownership here is on the INVOICE the
  // agreement points at, the creditor side — a different question from
  // the payer-ownership checks above.
  const [verifyInvoiceOwnerRow] = await db.select({ userId: financeInvoicesTable.userId })
    .from(financeInvoicesTable).where(eq(financeInvoicesTable.id, agreement.invoiceId)).limit(1);
  const verifyInvoiceOwnership = await authorize({
    req, engine: financeInvoicesOwnershipEngine, action: "finance.payment_agreement.verify",
    resource: { type: "finance.invoice", id: agreement.invoiceId, ownerId: verifyInvoiceOwnerRow?.userId ?? FINANCE_INVOICE_OWNER_SENTINEL_NONE },
  });
  if (verifyInvoiceOwnership.decision.effect !== "ALLOW") { res.status(404).json({ error: "Invoice not found" }); return; }

  const [invoice] = await db.select().from(financeInvoicesTable)
    .where(and(eq(financeInvoicesTable.id, agreement.invoiceId), eq(financeInvoicesTable.userId, authUser.userId)));
  if (!invoice) { res.status(404).json({ error: "Invoice not found" }); return; } // unreachable given ALLOW above, kept as defensive/unchanged
  if (agreement.status !== "passkey_confirmed") { res.status(400).json({ error: "This agreement hasn't been passkey-confirmed by the payer yet." }); return; }

  // If the invoice is linked to a real ledger entry, post an actual
  // repayment against it — same accounting path as a manual repayment
  // (routes/finance.ts POST /finance/entries/:id/repayments). Mirrors that
  // endpoint exactly: `amount` tracks what's still outstanding, so it must
  // be reduced by the repayment here too — not just have status flipped —
  // or entry.amount goes stale (the late-fee cron reads it as "still
  // outstanding") and a second verified agreement on the same invoice would
  // compare a fresh cumulative repayment total against an amount that was
  // never brought down by the first one.
  if (invoice.entryId) {
    const [entry] = await db.select().from(financeLedgerEntriesTable)
      .where(and(eq(financeLedgerEntriesTable.id, invoice.entryId), eq(financeLedgerEntriesTable.userId, authUser.userId)));
    // Defensive re-check (POST /finance/invoices now blocks linking to a
    // non-repayable kind at creation time, but invoices created before that
    // guard existed could still have an entryId pointing to one) — skip
    // posting a repayment against it rather than silently desyncing
    // entry.amount from the journal the way this used to.
    if (entry && REPAYABLE_KINDS.has(entry.kind)) {
      await db.insert(financeRepaymentsTable).values({
        entryId: entry.id, amount: agreement.amount, isInterest: 0,
        notes: `Verified from Payment Agreement #${agreement.id} (${PAYMENT_METHOD_LABELS[agreement.methodType] ?? agreement.methodType}${agreement.referenceId ? `, ref ${agreement.referenceId}` : ""}).`,
        paidAt: agreement.submittedAt ?? new Date(),
      });
      // BUG FIX: same non-atomic read-then-write race as the manual
      // repayment endpoint (routes/finance.ts) — `entry.amount` was read
      // once at the top of this handler, so two agreements on the same
      // invoice verified back-to-back could both compute their decrement
      // from the same stale value and one repayment's effect on the
      // outstanding balance would be lost. Do the subtraction atomically
      // in SQL instead.
      const [updatedEntry] = await db.update(financeLedgerEntriesTable)
        .set({ amount: sql`GREATEST(0, ${financeLedgerEntriesTable.amount} - ${agreement.amount})`, updatedAt: new Date() })
        .where(eq(financeLedgerEntriesTable.id, entry.id))
        .returning({ amount: financeLedgerEntriesTable.amount });
      const newStatus = (updatedEntry?.amount ?? 0) <= 0.01 ? "paid" : "partial";
      await db.update(financeLedgerEntriesTable).set({ status: newStatus }).where(eq(financeLedgerEntriesTable.id, entry.id));
      postRepaymentJournal(entry, agreement.amount, false).catch(() => {});
    }
  }

  const [updatedAgreement] = await db.update(financePaymentAgreementsTable).set({
    status: "creditor_verified", creditorVerifiedAt: new Date(), creditorVerifiedBy: authUser.userId,
    creditorNotes: notes ?? null, updatedAt: new Date(),
  }).where(eq(financePaymentAgreementsTable.id, id)).returning();

  // Running total across every verified agreement on this invoice — lets an
  // invoice be settled via several partial payments before it's fully paid.
  //
  // BUG FIX: this used to compute `invoice.paidAmount + agreement.amount`
  // from the `invoice` row fetched at the top of the handler, then write
  // that back — same non-atomic read-then-write race already fixed for
  // `entry.amount` a few lines up. Two payment agreements on the same
  // invoice verified at roughly the same time both read the same stale
  // `invoice.paidAmount`, so whichever UPDATE lands second overwrites the
  // first's contribution — that agreement's money is marked verified
  // (creditor_verified) yet never actually counted toward the invoice
  // being paid off, and the invoice can get stuck at "partially_paid"
  // forever even once every agreement against it has been verified.
  // Increment atomically in SQL and derive invoiceStatus from what the
  // database actually holds after the write, not from a value read before
  // the other request's write.
  const [updatedInvoice] = await db.update(financeInvoicesTable)
    .set({ paidAmount: sql`${financeInvoicesTable.paidAmount} + ${agreement.amount}`, updatedAt: new Date() })
    .where(eq(financeInvoicesTable.id, invoice.id))
    .returning({ paidAmount: financeInvoicesTable.paidAmount });
  const newPaidAmount = updatedInvoice?.paidAmount ?? invoice.paidAmount + agreement.amount;
  const invoiceStatus = newPaidAmount >= invoice.amount - 0.01 ? "paid" : "partially_paid";
  await db.update(financeInvoicesTable).set({ status: invoiceStatus, updatedAt: new Date() }).where(eq(financeInvoicesTable.id, invoice.id));
  logInvoiceEvent(invoice.id, invoiceStatus === "paid" ? "creditor_verified" : "partially_verified", req, { agreementId: id, amount: agreement.amount, paidAmount: newPaidAmount }).catch(() => {});

  res.json({ ...updatedAgreement, confirmedAt: iso(updatedAgreement.confirmedAt), creditorVerifiedAt: iso(updatedAgreement.creditorVerifiedAt) });
});

// Creditor rejects a passkey-confirmed claim instead of verifying it — e.g.
// the reference/txn ID doesn't match what actually landed in their account.
// Does NOT touch paidAmount or post anything; the payer can submit a fresh
// claim afterward since the invoice returns to payment_submitted (not a
// terminal disputed state) unless the creditor wants the whole invoice
// paused, in which case they cancel it separately.
router.post("/finance/payment-agreements/:id/dispute", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const id = parseInt(paramString(req.params.id), 10);
  const { reason } = req.body as { reason?: string };
  if (!reason || !reason.trim()) { res.status(400).json({ error: "A reason is required to dispute a payment claim." }); return; }

  const [agreement] = await db.select().from(financePaymentAgreementsTable).where(eq(financePaymentAgreementsTable.id, id));
  if (!agreement) { res.status(404).json({ error: "Payment agreement not found" }); return; }

  // Phase C3: same PDP-routed ownership check as /verify above, ahead of
  // the existing filtered lookup below (kept, unchanged).
  const [disputeInvoiceOwnerRow] = await db.select({ userId: financeInvoicesTable.userId })
    .from(financeInvoicesTable).where(eq(financeInvoicesTable.id, agreement.invoiceId)).limit(1);
  const disputeInvoiceOwnership = await authorize({
    req, engine: financeInvoicesOwnershipEngine, action: "finance.payment_agreement.dispute",
    resource: { type: "finance.invoice", id: agreement.invoiceId, ownerId: disputeInvoiceOwnerRow?.userId ?? FINANCE_INVOICE_OWNER_SENTINEL_NONE },
  });
  if (disputeInvoiceOwnership.decision.effect !== "ALLOW") { res.status(404).json({ error: "Invoice not found" }); return; }

  const [invoice] = await db.select().from(financeInvoicesTable)
    .where(and(eq(financeInvoicesTable.id, agreement.invoiceId), eq(financeInvoicesTable.userId, authUser.userId)));
  if (!invoice) { res.status(404).json({ error: "Invoice not found" }); return; } // unreachable given ALLOW above, kept as defensive/unchanged
  if (agreement.status === "creditor_verified") { res.status(400).json({ error: "This agreement was already verified — it can't be disputed." }); return; }
  if (agreement.status === "disputed") { res.status(400).json({ error: "This agreement is already disputed." }); return; }

  const [updatedAgreement] = await db.update(financePaymentAgreementsTable).set({
    status: "disputed", disputedAt: new Date(), disputedBy: authUser.userId,
    disputeReason: reason.trim(), updatedAt: new Date(),
  }).where(eq(financePaymentAgreementsTable.id, id)).returning();

  await db.update(financeInvoicesTable).set({ status: "disputed", updatedAt: new Date() }).where(eq(financeInvoicesTable.id, invoice.id));
  logInvoiceEvent(invoice.id, "agreement_disputed", req, { agreementId: id, reason: reason.trim() }).catch(() => {});

  if (agreement.payerUserId) {
    const [payer] = await db.select({ email: usersTable.email, username: usersTable.username, telegramChatId: usersTable.telegramChatId })
      .from(usersTable).where(eq(usersTable.id, agreement.payerUserId));
    const [creditor] = await db.select({ username: usersTable.username }).from(usersTable).where(eq(usersTable.id, invoice.userId));
    const creditorName = creditor?.username ?? "the creditor";
    const url = financeInvoiceUrl(invoice.invoiceToken);
    const amountStr = money(invoice.currency, agreement.amount);

    createNotification(agreement.payerUserId, "finance_payment_disputed", "Payment disputed",
      `${creditorName} disputed your payment claim of ${amountStr}: ${reason.trim()}`,
      { invoiceId: invoice.id, agreementId: id }).catch(() => {});
    if (payer?.email) {
      sendPaymentDisputedEmail(payer.email, {
        debtorName: payer.username ?? invoice.debtorName, creditorName, title: `Invoice #${invoice.id}`,
        amount: amountStr, reason: reason.trim(), url,
      }).catch(() => {});
    }
    if (payer?.telegramChatId) {
      sendToUser(payer.telegramChatId, `⚠️ *Payment disputed*\n\n${creditorName} disputed your claim of ${amountStr}:\n"${reason.trim()}"`).catch(() => {});
    }
  }

  res.json({ ...updatedAgreement, disputedAt: iso(updatedAgreement.disputedAt) });
});

// Creditor's counterpart to dispute(): the dispute handler above sets the
// invoice to a real "disputed" status (not the "payment_submitted" its own
// comment claims) — and the public submit-payment route explicitly refuses
// a fresh claim while status is "disputed", and the frontend's own
// alreadySubmitted check refuses one for "payment_submitted"/
// "agreement_confirmed" too. Put together, nothing ever moved a disputed
// invoice back out of that status, so once disputed it was permanently
// stuck: the payer blocked from submitting again, and the creditor with no
// action to unblock them either. This gives the creditor that action.
router.post("/finance/invoices/:id/reopen", requireAuth, requireFinanceInvoiceOwnership("finance.invoice.reopen"), async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const id = parseInt(paramString(req.params.id), 10);

  const [invoice] = await db.select().from(financeInvoicesTable)
    .where(and(eq(financeInvoicesTable.id, id), eq(financeInvoicesTable.userId, authUser.userId)));
  if (!invoice) { res.status(404).json({ error: "Invoice not found" }); return; }
  if (invoice.status !== "disputed") { res.status(400).json({ error: "Only a disputed invoice can be reopened." }); return; }

  // Land back on whichever non-terminal status reflects reality: if a
  // prior verified agreement already paid some of it, "partially_paid"
  // (still allows a fresh claim for the remainder); otherwise "viewed" so
  // the payer sees the normal payment form again.
  const newStatus = invoice.paidAmount > 0 ? "partially_paid" : "viewed";
  const [row] = await db.update(financeInvoicesTable).set({ status: newStatus, updatedAt: new Date() })
    .where(eq(financeInvoicesTable.id, id)).returning();

  logInvoiceEvent(invoice.id, "reopened_after_dispute", req).catch(() => {});
  res.json({ ...row, dueDate: iso(row.dueDate), createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt) });
});

export default router;
