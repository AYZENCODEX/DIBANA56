import { Router } from "express";
import express from "express";
import type { Request, Response } from "express";
import {
  db,
  financePartiesTable,
  financeLedgerEntriesTable,
  financeRepaymentsTable,
  financeAssetsTable,
  financeAssetOwnersTable,
  financeInvoiceLinesTable,
  financeRecurringRulesTable,
  financeBudgetsTable,
  financeCurrencyRatesTable,
  financeAttachmentsTable,
  financeBooksTable,
  financeReportSchedulesTable,
  usersTable,
  projectsTable,
} from "@workspace/db";
import { eq, and, sql, isNotNull, gte, lte, desc, inArray } from "drizzle-orm";
import { requireAuth, getRequestUser, pepDecisionObserver } from "../middlewares/auth";
import { requireOwnership, requirePublicAudit } from "../lib/policy/pep/middleware";
import type { ResourceRefBuilder } from "../lib/policy/pep/types";
import { toCsv, parseCsvObjects } from "../lib/csv";
import PDFDocument from "pdfkit";
import { hasCreditBalance, chargeCredits } from "../services/credit-meter";
import { runFinanceRecurringSweep } from "../lib/finance-recurring-cron";
import {
  ensureSystemAccounts,
  postJournal,
  postEntryJournal,
  postEntryAdjustmentJournal,
  postRepaymentJournal,
  deleteJournalForEntry,
  computeAccountBalances,
  generateAmortizationSchedule,
  listAmortizationForEntry,
  generateDepreciationSchedule,
  listDepreciationForAsset,
  postDepreciationJournal,
  ensureReceiptToken,
  financeReceiptUrl,
  listBooks,
  resolveBookId,
  REPAYABLE_KINDS,
} from "../lib/finance-accounting";
import { financeAccountsTable, financeJournalEntriesTable, financeJournalLinesTable, financeAmortizationTable, financeDepreciationTable, financeGoalsTable, financeNetWorthSnapshotsTable } from "@workspace/db";
import { computeNetWorthBreakdown, snapshotNetWorth, listNetWorthHistory, syncGoalProgress } from "../lib/finance-networth";
import { notifyEntryCreated } from "../lib/finance-notify";
import { notifyRyftRepaymentPosted } from "../lib/notification-bus";
import { createNotification } from "./notifications";
import {
  parseQuickEntryText,
  findDuplicateEntry,
  detectAnomalies,
  answerFinanceQuery,
  detectRecurringCandidates,
  extractReceiptFields,
  parseBankSms,
  ensureSmsWebhookToken,
  rotateSmsWebhookToken,
  type QuickEntryDraft,
} from "../lib/finance-ai";

const router = Router();

// Attachment uploads need a bigger body than the app-wide JSON_BODY_LIMIT
// (default 1mb) allows — base64 alone adds ~33% overhead on top of
// MAX_ATTACHMENT_BYTES. Scoped to just the attachment routes, same pattern
// as routes/vault-attachments.ts.
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const uploadBodyParser = express.json({ limit: "12mb" });

function paramString(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

function iso(d: Date | string | null | undefined) {
  if (!d) return null;
  return typeof d === "string" ? d : d.toISOString();
}

function fmtEntry(e: typeof financeLedgerEntriesTable.$inferSelect) {
  return {
    ...e,
    dueDate: iso(e.dueDate),
    occurredDate: iso(e.occurredDate),
    createdAt: iso(e.createdAt),
    updatedAt: iso(e.updatedAt),
  };
}
function fmtAsset(a: typeof financeAssetsTable.$inferSelect) {
  return {
    ...a,
    purchaseDate: iso(a.purchaseDate),
    maturityDate: iso(a.maturityDate),
    createdAt: iso(a.createdAt),
    updatedAt: iso(a.updatedAt),
  };
}

// ─── Books (Phase 3 — Multi-book: Business vs Personal separate ledgers) ────
// Scoped to Accounts + Journal + Ledger entries only — see migrations/030_
// finance_multi_book.sql and lib/finance-accounting.ts (resolveBookId,
// listBooks) for what "a book" does and doesn't cover.

router.get("/finance/books", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  await resolveBookId(authUser.userId); // ensures at least one (default) book exists
  const rows = await listBooks(authUser.userId);
  res.json(rows);
});

router.post("/finance/books", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const { name, bookType, currency, notes } = req.body as { name?: string; bookType?: string; currency?: string; notes?: string };
  if (!name?.trim()) { res.status(400).json({ error: "name is required" }); return; }
  const [row] = await db.insert(financeBooksTable).values({
    userId: authUser.userId, name: name.trim(), bookType: bookType || "personal",
    currency: currency || "BDT", notes: notes ?? null, isDefault: 0,
  }).returning();
  await ensureSystemAccounts(authUser.userId, row.id); // new book starts with its own seeded Chart of Accounts
  res.status(201).json(row);
});

router.put("/finance/books/:id", requireAuth, requireFinanceBookOwnership("finance.book.update"), async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const id = parseInt(paramString(req.params.id), 10);
  const { name, bookType, currency, notes } = req.body as { name?: string; bookType?: string; currency?: string; notes?: string };
  const update: Record<string, any> = { updatedAt: new Date() };
  if (name !== undefined) update.name = name;
  if (bookType !== undefined) update.bookType = bookType;
  if (currency !== undefined) update.currency = currency;
  if (notes !== undefined) update.notes = notes;
  const [row] = await db.update(financeBooksTable).set(update)
    .where(and(eq(financeBooksTable.id, id), eq(financeBooksTable.userId, authUser.userId)))
    .returning();
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  res.json(row);
});

// Sets this book as the default (the one bookId-less requests fall back to)
// — unsets any other default for the user first, so exactly one stays true.
router.put("/finance/books/:id/set-default", requireAuth, requireFinanceBookOwnership("finance.book.set_default"), async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const id = parseInt(paramString(req.params.id), 10);
  const [book] = await db.select().from(financeBooksTable)
    .where(and(eq(financeBooksTable.id, id), eq(financeBooksTable.userId, authUser.userId)));
  if (!book) { res.status(404).json({ error: "Not found" }); return; }
  await db.update(financeBooksTable).set({ isDefault: 0 }).where(eq(financeBooksTable.userId, authUser.userId));
  const [row] = await db.update(financeBooksTable).set({ isDefault: 1, updatedAt: new Date() }).where(eq(financeBooksTable.id, id)).returning();
  res.json(row);
});

router.delete("/finance/books/:id", requireAuth, requireFinanceBookOwnership("finance.book.delete"), async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const id = parseInt(paramString(req.params.id), 10);
  const [book] = await db.select().from(financeBooksTable)
    .where(and(eq(financeBooksTable.id, id), eq(financeBooksTable.userId, authUser.userId)));
  if (!book) { res.status(404).json({ error: "Not found" }); return; }
  if (book.isDefault) { res.status(400).json({ error: "Can't delete the default book — set another book as default first" }); return; }
  const [{ count }] = await db.select({ count: sql<number>`COUNT(*)` }).from(financeLedgerEntriesTable).where(eq(financeLedgerEntriesTable.bookId, id));
  if (Number(count) > 0) { res.status(400).json({ error: "Book has entries and can't be deleted" }); return; }
  const bookJournalEntries = await db.select({ id: financeJournalEntriesTable.id }).from(financeJournalEntriesTable)
    .where(eq(financeJournalEntriesTable.bookId, id));
  const bookJournalEntryIds = bookJournalEntries.map(j => j.id);
  if (bookJournalEntryIds.length > 0) {
    await db.delete(financeJournalLinesTable).where(inArray(financeJournalLinesTable.journalEntryId, bookJournalEntryIds));
  }
  await db.delete(financeJournalEntriesTable).where(eq(financeJournalEntriesTable.bookId, id));
  await db.delete(financeAccountsTable).where(eq(financeAccountsTable.bookId, id));
  await db.delete(financeBooksTable).where(eq(financeBooksTable.id, id));
  res.json({ success: true });
});

// ─── Route Integration Roadmap — Season B, Phase B1 (Finance ownership) ─────
// `requireAuth` alone never actually protected a single Finance record from
// another authenticated user — every handler below does its own hand-rolled
// `eq(table.userId, authUser.userId)` scoping (`assertEntryOwnership()` for
// ledger entries, an inline `where` for parties). That scoping is correct
// and stays exactly as-is — this phase does not remove it (Rule: don't
// remove a working system). What it adds is a SECOND, PDP-routed ownership
// check ahead of it, via `requireOwnership()` (`lib/policy/pep/middleware.ts`,
// Phase 19) — so a Finance ownership decision now produces a real
// `AuthorizationDecision` (a `requestId`, a reason code, a durable
// `authorization_audit_log` row and a `authorization-telemetry` metric via
// the same `pepDecisionObserver` the Phase A2/A3 RBAC-PEP shim already
// wires into `middlewares/auth.ts`) instead of being invisible to the PDP
// the way it was for the RBAC-based routes before Season A even started.
//
// ── Resource lookup, not request-supplied ownerId ───────────────────────
// Each `ResourceRefBuilder` below re-reads the record's REAL owner from the
// DB by :id — never trusts a client-supplied ownerId (same boundary
// `ownership-rule.ts`'s own header draws around `ResourceRef.ownerId`
// being "only as trustworthy as the PEP call site that populated it").
//
// ── A record that doesn't exist at all is still a DENY, not a thrown
//    wiring error ─────────────────────────────────────────────────────────
// `requireOwnership()` treats an unset `ownerId` as a construction-time
// mistake (see its own header) — appropriate for a resource builder that
// forgot to populate it, wrong for "the row this :id names doesn't exist".
// `FINANCE_OWNER_SENTINEL_NONE` (never a real user id — `usersTable.id` is
// a positive serial) is used instead so a missing row still reaches the
// PDP as a normal, auditable DENY (`NO_MATCHING_POLICY` — no rule can ever
// match `ownerId === -1`), not a 500. `onDeny` below then renders the exact
// same 404 body these routes already returned for BOTH "doesn't exist" and
// "exists but isn't yours" — this phase does not change what a caller can
// observe about whether a given id exists, only how the decision that
// blocks it gets made and recorded.
const FINANCE_OWNER_SENTINEL_NONE = -1;

const financePartyResource: ResourceRefBuilder = async (req: Request) => {
  const id = parseInt(paramString(req.params.id), 10);
  if (!Number.isFinite(id)) return { type: "finance.party", id: req.params.id, ownerId: FINANCE_OWNER_SENTINEL_NONE };
  const [row] = await db.select({ userId: financePartiesTable.userId }).from(financePartiesTable)
    .where(eq(financePartiesTable.id, id)).limit(1);
  return { type: "finance.party", id, ownerId: row?.userId ?? FINANCE_OWNER_SENTINEL_NONE };
};

// Shared by both ledger-entry routes AND the repayment routes — a
// repayment's :id param names the PARENT ledger entry (see
// `POST /finance/entries/:id/repayments` below), not a repayment row of its
// own, so "who owns the entry" is the exact same ownership question either
// way.
const financeLedgerEntryResource: ResourceRefBuilder = async (req: Request) => {
  const id = parseInt(paramString(req.params.id), 10);
  if (!Number.isFinite(id)) return { type: "finance.ledger_entry", id: req.params.id, ownerId: FINANCE_OWNER_SENTINEL_NONE };
  const [row] = await db.select({ userId: financeLedgerEntriesTable.userId }).from(financeLedgerEntriesTable)
    .where(eq(financeLedgerEntriesTable.id, id)).limit(1);
  return { type: "finance.ledger_entry", id, ownerId: row?.userId ?? FINANCE_OWNER_SENTINEL_NONE };
};

// One throwaway `requireOwnership()` middleware per (resource type, action)
// pair, built ONCE at module load — same "cheap to build, build it once"
// posture `middlewares/auth.ts`'s `adminRoleCheck`/`devRoleCheck` already
// apply to their own throwaway engines. `action` is a real
// "product.resource.action" key (`finance.party.update`, ...) even though
// `requireOwnership()` itself doesn't validate the shape the way
// `requirePermission()` does — keeping the convention leaves room for a
// later phase to combine this with an RBAC rule on the same engine without
// renaming anything.
function requireFinancePartyOwnership(action: string) {
  return requireOwnership(action, financePartyResource, {
    onDecision: pepDecisionObserver,
    onDeny: (_req: Request, res: Response) => {
      res.status(404).json({ error: "Not found" });
    },
  });
}

function requireFinanceLedgerEntryOwnership(action: string) {
  return requireOwnership(action, financeLedgerEntryResource, {
    onDecision: pepDecisionObserver,
    onDeny: (_req: Request, res: Response) => {
      res.status(404).json({ error: "Entry not found" });
    },
  });
}

// ─── Route Integration Roadmap — Season E, Phase E1 (audit-only → enforcing
// promotion, book group) ────────────────────────────────────────────────────
// D7 gave this file's book/asset/goal/account/... routes an audit-only
// `authorize()` call (return value discarded, never blocks — see
// `auditFinanceOwnership()` and its own header below). That was the right
// call at the time (C27's "don't touch the SQL, just add visibility"
// posture), but it leaves these routes permanently invisible to
// `check-ownership-gate-coverage.ts` (154-route Season D baseline) even
// though every one of them already has a `ResourceRefBuilder` and a
// `PolicyEngine` sitting right there unused as an actual gate. This group
// (book: PUT .../:id, PUT .../:id/set-default, DELETE .../:id) is the first
// of that backlog promoted from audit-only to a real, blocking
// `requireOwnership()` — same `financePartyResource`/
// `financeLedgerEntryResource` router-level-middleware shape B1 already
// established above, same `onDeny` 404 body every book route already
// returned on its own pre-existing `and(eq(id), eq(userId))` miss (see each
// route below — this promotion changes WHEN the check runs and WHETHER a
// wrong-owner request reaches the handler at all, not what a caller
// observes on either outcome). `makeFinanceOwnerResource()` is defined
// further down this file as a plain hoisted `function` declaration
// (not a `const`), so calling it here — before its own textual position —
// is safe; only the *AuditEngine consts near it must NOT be reused as a
// blocking gate's engine, which is why `requireOwnership()` is used instead
// of `requirePolicy()` (it builds its own fresh single-rule engine
// internally — see that helper's own header).
const financeBookResource = makeFinanceOwnerResource("finance.book", financeBooksTable);
function requireFinanceBookOwnership(action: string) {
  return requireOwnership(action, financeBookResource, {
    onDecision: pepDecisionObserver,
    onDeny: (_req: Request, res: Response) => {
      res.status(404).json({ error: "Not found" });
    },
  });
}

// ─── Route Integration Roadmap — Season D, Phase D7 (consistency sweep,
// audit-trail wiring) ───────────────────────────────────────────────────────
// D2's triage confirmed 32 more of this file's `:id` routes are the exact
// same `and(eq(<table>.id, id), eq(<table>.userId, authUser.userId))` /
// `assertEntryOwnership()` shape B1 already covers for parties and ledger
// entries — genuinely safe, just never made it onto the PDP. Same posture
// `bulk.ts`'s Phase C27 already established for the bulk-family routes:
// this phase does NOT touch a single WHERE clause. It adds one `authorize()`
// call, purely for its audit side effect (`pepDecisionObserver` — a real,
// centrally-observable `AuthorizationDecision`), at the exact point each
// route's existing ownership check already runs. The pre-existing check is
// what actually decides the response; the PDP call's return value is
// discarded everywhere it's used below.
//
// `makeFinanceOwnerResource()` is `financePartyResource`/
// `financeLedgerEntryResource`'s own shape turned into a factory — one
// `{ id, userId }`-shaped Drizzle table in, one `ResourceRefBuilder` out.
// Re-reads the row's REAL owner fresh from the DB by :id, same "never trust
// a client-supplied ownerId" posture those two already establish (and the
// same reason this is a genuinely new query at each call site below, not a
// reuse of the route's own already-filtered check — an already-`userId`-
// filtered SELECT only ever returns "yes, mine" or "not found", which would
// make the audit trail tautological; re-reading unfiltered is what lets a
// real mismatch actually show up as a DENY, same as `bulk.ts`'s
// `auditBulkOwnership()` re-fetching candidates unfiltered for the same
// reason).
function makeFinanceOwnerResource(
  type: string,
  table: { id: any; userId: any },
): ResourceRefBuilder {
  return async (req: Request) => {
    const id = parseInt(paramString(req.params.id), 10);
    if (!Number.isFinite(id)) return { type, id: req.params.id, ownerId: FINANCE_OWNER_SENTINEL_NONE };
    const [row] = await db.select({ userId: table.userId }).from(table as any).where(eq(table.id, id)).limit(1);
    return { type, id, ownerId: row?.userId ?? FINANCE_OWNER_SENTINEL_NONE };
  };
}

// One resource builder per finance resource type — Season E, Phase E2
// promoted every route that used to hold an audit-only `*AuditEngine`
// alongside these to a real, blocking `requireOwnership()` gate (see the
// factories below), so those `*AuditEngine` consts have no remaining
// caller and have been removed rather than left as dead code (same rule
// D7/E1 already established: don't leave an unused construct behind once
// its last caller is gone).
const financeAccountResource = makeFinanceOwnerResource("finance.account", financeAccountsTable);
const financeAssetResource = makeFinanceOwnerResource("finance.asset", financeAssetsTable);
const financeGoalResource = makeFinanceOwnerResource("finance.goal", financeGoalsTable);
const financeRecurringRuleResource = makeFinanceOwnerResource("finance.recurring_rule", financeRecurringRulesTable);
const financeBudgetResource = makeFinanceOwnerResource("finance.budget", financeBudgetsTable);
const financeJournalEntryResource = makeFinanceOwnerResource("finance.journal_entry", financeJournalEntriesTable);
const financeReportScheduleResource = makeFinanceOwnerResource("finance.report_schedule", financeReportSchedulesTable);
const financeAmortizationResource = makeFinanceOwnerResource("finance.amortization", financeAmortizationTable);
const financeDepreciationResource = makeFinanceOwnerResource("finance.depreciation", financeDepreciationTable);

// ─── Route Integration Roadmap — Season E, Phase E2 (finance.ts remaining
// raw-SQL/audit-only groups, audit-only → enforcing) ────────────────────────
// Same promotion as E1's book group (see CHANGES_ROUTE_INTEGRATION_PHASE_E1.md),
// applied to every other resource family in this file that already has a
// `*Resource`/`*AuditEngine` pair declared above sitting unused as a real
// gate. No ordering trap here — every resource const these factories close
// over is declared above this point (lines ~346-380), and every route that
// uses them is registered below it, so there's no temporal-dead-zone risk
// the way the E1 book group had.
//
// Unlike the book/party factories above (fixed `onDeny`, one shared 404
// across every route of that type), several of these families have
// DIFFERENT pre-existing deny bodies per route within the same resource
// type (`finance.account`'s PUT vs DELETE; `finance.asset`'s PUT/DELETE
// "Not found" vs its depreciation sub-routes' "Asset not found") — so these
// take `onDeny` as a parameter, per OWNERSHIP_GATING_GUIDE.md's Step 3
// general template, rather than baking one in. Each call site below
// reproduces that ROUTE's own pre-existing deny body exactly — including
// the ones that silently no-op'd `{ success: true }` for a wrong-owner id
// before gating (goal/recurring/budget/report-schedule DELETE never had an
// explicit ownership-miss branch; their scoped `WHERE ... AND userId = ...`
// delete was already a no-op on a non-owned id, so the gate must reply the
// same inert way, not a new 404 — see the GUIDE's "silent no-op" deny shape).
function requireFinanceAssetOwnership(action: string, onDeny: (req: Request, res: Response) => void) {
  return requireOwnership(action, financeAssetResource, { onDecision: pepDecisionObserver, onDeny });
}
function requireFinanceGoalOwnership(action: string, onDeny: (req: Request, res: Response) => void) {
  return requireOwnership(action, financeGoalResource, { onDecision: pepDecisionObserver, onDeny });
}
function requireFinanceRecurringRuleOwnership(action: string, onDeny: (req: Request, res: Response) => void) {
  return requireOwnership(action, financeRecurringRuleResource, { onDecision: pepDecisionObserver, onDeny });
}
function requireFinanceBudgetOwnership(action: string, onDeny: (req: Request, res: Response) => void) {
  return requireOwnership(action, financeBudgetResource, { onDecision: pepDecisionObserver, onDeny });
}
function requireFinanceAccountOwnership(action: string, onDeny: (req: Request, res: Response) => void) {
  return requireOwnership(action, financeAccountResource, { onDecision: pepDecisionObserver, onDeny });
}
function requireFinanceJournalEntryOwnership(action: string) {
  return requireOwnership(action, financeJournalEntryResource, {
    onDecision: pepDecisionObserver,
    onDeny: (_req: Request, res: Response) => { res.status(404).json({ error: "Not found" }); },
  });
}
function requireFinanceReportScheduleOwnership(action: string, onDeny: (req: Request, res: Response) => void) {
  return requireOwnership(action, financeReportScheduleResource, { onDecision: pepDecisionObserver, onDeny });
}
function requireFinanceAmortizationOwnership(action: string) {
  return requireOwnership(action, financeAmortizationResource, {
    onDecision: pepDecisionObserver,
    onDeny: (_req: Request, res: Response) => { res.status(404).json({ error: "Not found" }); },
  });
}
function requireFinanceDepreciationOwnership(action: string) {
  return requireOwnership(action, financeDepreciationResource, {
    onDecision: pepDecisionObserver,
    onDeny: (_req: Request, res: Response) => { res.status(404).json({ error: "Not found" }); },
  });
}
// Shared "reply as if it already succeeded/didn't exist" deny, for the
// routes above whose pre-existing scoped delete already behaved this way.
function financeSilentSuccessDeny(_req: Request, res: Response): void {
  res.status(200).json({ success: true });
}
function financeNotFoundDeny(message: string) {
  return (_req: Request, res: Response): void => { res.status(404).json({ error: message }); };
}

// Entry-derived resources (attachments/receipt/invoice-lines) reuse
// `financeLedgerEntryResource`/`requireFinanceLedgerEntryOwnership()`
// directly — "who owns this attachment/receipt/invoice-line" IS "who owns
// the parent entry", the exact same question B1 already built a resource
// builder AND a blocking gate for. D7 originally gave this group its own
// audit-only `financeLedgerEntryAuditEngine`; Season E, Phase E1 promoted
// every entry-derived route to the real B1 gate instead (see
// `CHANGES_ROUTE_INTEGRATION_PHASE_E1.md`), so that audit-only engine has
// no remaining call sites and has been removed rather than left as dead
// code (Rule: don't leave an unused construct behind once its last caller
// is gone). `auditFinanceOwnership()` itself (D7's generic audit-only
// helper) is gone for the same reason as of Season E, Phase E2 — every
// route in this file that used to call it has been promoted to a real
// `requireOwnership()` gate above, so it had no remaining caller.

// ─── Parties ─────────────────────────────────────────────────────────────────

router.get("/finance/parties", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const rows = await db.select().from(financePartiesTable).where(eq(financePartiesTable.userId, authUser.userId));
  res.json(rows);
});

router.post("/finance/parties", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const { name, contact, notes } = req.body as { name?: string; contact?: string; notes?: string };
  if (!name?.trim()) { res.status(400).json({ error: "name is required" }); return; }
  const [row] = await db.insert(financePartiesTable).values({ userId: authUser.userId, name: name.trim(), contact, notes }).returning();
  res.status(201).json(row);
});

router.put("/finance/parties/:id", requireAuth, requireFinancePartyOwnership("finance.party.update"), async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const id = parseInt(paramString(req.params.id), 10);
  const { name, contact, notes } = req.body as { name?: string; contact?: string; notes?: string };
  const [row] = await db.update(financePartiesTable)
    .set({ name, contact, notes, updatedAt: new Date() })
    .where(and(eq(financePartiesTable.id, id), eq(financePartiesTable.userId, authUser.userId)))
    .returning();
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  res.json(row);
});

router.delete("/finance/parties/:id", requireAuth, requireFinancePartyOwnership("finance.party.delete"), async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const id = parseInt(paramString(req.params.id), 10);
  await db.delete(financePartiesTable).where(and(eq(financePartiesTable.id, id), eq(financePartiesTable.userId, authUser.userId)));
  res.json({ success: true });
});

// ─── Ledger entries (Receivable/Payable/Borrowed/Lending/Investment/Expense/Income) ──

router.get("/finance/entries", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const { kind, projectId, status, bookId } = req.query as Record<string, string>;
  const resolvedBookId = await resolveBookId(authUser.userId, bookId ? parseInt(bookId, 10) : undefined);

  const conditions = [eq(financeLedgerEntriesTable.userId, authUser.userId), eq(financeLedgerEntriesTable.bookId, resolvedBookId)];
  if (kind) conditions.push(eq(financeLedgerEntriesTable.kind, kind));
  if (projectId) conditions.push(eq(financeLedgerEntriesTable.projectId, parseInt(projectId, 10)));
  if (status) conditions.push(eq(financeLedgerEntriesTable.status, status));

  const rows = await db.select().from(financeLedgerEntriesTable)
    .where(and(...conditions))
    .orderBy(desc(financeLedgerEntriesTable.occurredDate));
  res.json(rows.map(fmtEntry));
});

router.post("/finance/entries", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const b = req.body as Record<string, any>;
  if (!b.kind || !b.title?.trim()) { res.status(400).json({ error: "kind and title are required" }); return; }
  // BUG FIX: `Number(b.amount) || 0` silently accepted negative numbers
  // (only 0/NaN/"" fell back to the default) and never rejected 0 either.
  // A negative or zero amount here creates a ledger row that
  // postEntryJournal skips posting for (it requires `entry.amount > 0`),
  // so the entry would sit in the ledger forever with no matching journal
  // entry — permanently desyncing Trial Balance / Balance Sheet from the
  // day-to-day Finance list, and a negative amount would additionally
  // corrupt every downstream sum (late-fee cron, net worth, budgets)
  // that assumes amount >= 0. POST /finance/entries/import already
  // enforces `amount > 0`; this brings the manual-create path in line.
  const amountNum = Number(b.amount);
  if (!Number.isFinite(amountNum) || amountNum <= 0) { res.status(400).json({ error: "amount must be a positive number" }); return; }
  const resolvedBookId = await resolveBookId(authUser.userId, b.bookId ?? undefined);
  const [row] = await db.insert(financeLedgerEntriesTable).values({
    userId: authUser.userId,
    bookId: resolvedBookId,
    kind: b.kind,
    title: b.title.trim(),
    amount: amountNum,
    currency: b.currency || "BDT",
    partyId: b.partyId ?? null,
    projectId: b.projectId ?? null,
    category: b.category ?? null,
    interestRate: b.interestRate ?? null,
    interestPaid: Number(b.interestPaid) || 0,
    dueDate: b.dueDate ? new Date(b.dueDate) : null,
    occurredDate: b.occurredDate ? new Date(b.occurredDate) : new Date(),
    status: b.status || "pending",
    notes: b.notes ?? null,
    lateFeeType: b.lateFeeType ?? null,
    lateFeeRate: b.lateFeeRate ?? null,
    lateFeeGraceDays: Number(b.lateFeeGraceDays) || 0,
  }).returning();
  postEntryJournal(row).catch(() => {}); // best-effort — never blocks the Finance UI
  notifyEntryCreated(row).catch(() => {}); // best-effort — mints invoice/receipt link, pushes Telegram + email
  res.status(201).json(fmtEntry(row));
});

router.put("/finance/entries/:id", requireAuth, requireFinanceLedgerEntryOwnership("finance.entry.update"), async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const id = parseInt(paramString(req.params.id), 10);
  const b = req.body as Record<string, any>;

  // Fetch the pre-update row so we can tell whether `amount` actually
  // changed — needed to keep the double-entry books (lib/finance-accounting.ts)
  // in sync with this edit.
  const [existing] = await db.select().from(financeLedgerEntriesTable)
    .where(and(eq(financeLedgerEntriesTable.id, id), eq(financeLedgerEntriesTable.userId, authUser.userId)));
  if (!existing) { res.status(404).json({ error: "Not found" }); return; }

  const update: Record<string, any> = { updatedAt: new Date() };
  for (const k of ["title", "currency", "partyId", "projectId", "category", "interestRate", "status", "notes", "lateFeeType", "lateFeeRate"]) {
    if (b[k] !== undefined) update[k] = b[k];
  }
  // Numeric fields: coerce and validate the same way POST /finance/entries
  // does. Previously these were passed through as raw `b[k]` — a
  // string/NaN/garbage value from the client would get written straight
  // into the ledger row and silently corrupt downstream arithmetic (the
  // late-fee cron's `entry.amount - entry.lateFeeAccrued`, net-worth sums,
  // trial balance) since Postgres numeric columns can end up holding a
  // non-numeric or NaN value with no error raised here.
  for (const k of ["amount", "interestPaid", "lateFeeGraceDays"] as const) {
    if (b[k] !== undefined) {
      const n = Number(b[k]);
      if (!Number.isFinite(n)) { res.status(400).json({ error: `${k} must be a valid number` }); return; }
      // BUG FIX: this validated "is it a number" but not "is it a sane
      // value" — a caller could PUT amount: -500 and it would sail
      // through, flipping the sign of what's owed without any of the
      // repayment/adjustment logic that's supposed to govern how `amount`
      // moves. Mirrors the same amount > 0 rule POST /finance/entries now
      // enforces above.
      if (k === "amount" && n <= 0) { res.status(400).json({ error: "amount must be a positive number" }); return; }
      update[k] = n;
    }
  }
  if (b.dueDate !== undefined) {
    update.dueDate = b.dueDate ? new Date(b.dueDate) : null;
    // Due date changed — allow the reminder cron to fire again for the new
    // date (mirrors routes/project-dates.ts's PATCH handler). Without this,
    // an entry that already sent a reminder once would never remind again
    // even if the due date is pushed further out.
    update.remindedAt = null;
  }
  if (b.occurredDate !== undefined) update.occurredDate = new Date(b.occurredDate);

  const [row] = await db.update(financeLedgerEntriesTable)
    .set(update)
    .where(and(eq(financeLedgerEntriesTable.id, id), eq(financeLedgerEntriesTable.userId, authUser.userId)))
    .returning();
  if (!row) { res.status(404).json({ error: "Not found" }); return; }

  // The opening journal entry was posted once at creation (postEntryJournal).
  // If this edit changed the amount, post an adjustment for just the delta
  // so Trial Balance / Balance Sheet / Income Statement stay in sync —
  // instead of deleting and reposting, which would also wipe out any
  // repayment/interest journal entries already recorded against this entry.
  if (update.amount !== undefined) {
    const delta = Number(update.amount) - existing.amount;
    postEntryAdjustmentJournal(row, delta).catch(() => {}); // best-effort — never blocks the Finance UI
  }

  res.json(fmtEntry(row));
});

router.delete("/finance/entries/:id", requireAuth, requireFinanceLedgerEntryOwnership("finance.entry.delete"), async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const id = parseInt(paramString(req.params.id), 10);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid entry id" }); return; }
  // Must confirm ownership BEFORE touching repayments/amortization/journal —
  // those deletes below are keyed only on entryId with no userId filter, so
  // without this check any authenticated user could wipe another user's
  // financial records via an arbitrary entry id (the final delete of the
  // ledger entry itself was scoped, but that alone doesn't protect the rest).
  if (!(await assertEntryOwnership(id, authUser.userId))) { res.status(404).json({ error: "Entry not found" }); return; }
  await db.delete(financeRepaymentsTable).where(eq(financeRepaymentsTable.entryId, id));
  await db.delete(financeAmortizationTable).where(eq(financeAmortizationTable.ledgerEntryId, id));
  await deleteJournalForEntry(id);
  await db.delete(financeLedgerEntriesTable).where(and(eq(financeLedgerEntriesTable.id, id), eq(financeLedgerEntriesTable.userId, authUser.userId)));
  res.json({ success: true });
});

// ─── Repayments (partial-payment history against an entry) ──────────────────

router.get("/finance/entries/:id/repayments", requireAuth, requireFinanceLedgerEntryOwnership("finance.repayment.read"), async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const id = parseInt(paramString(req.params.id), 10);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid entry id" }); return; }
  if (!(await assertEntryOwnership(id, authUser.userId))) { res.status(404).json({ error: "Entry not found" }); return; }
  const rows = await db.select().from(financeRepaymentsTable).where(eq(financeRepaymentsTable.entryId, id)).orderBy(desc(financeRepaymentsTable.paidAt));
  res.json(rows.map(r => ({ ...r, paidAt: iso(r.paidAt), createdAt: iso(r.createdAt) })));
});

router.post("/finance/entries/:id/repayments", requireAuth, requireFinanceLedgerEntryOwnership("finance.repayment.create"), async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const entryId = parseInt(paramString(req.params.id), 10);
  const { amount, isInterest, notes, paidAt } = req.body as { amount?: number; isInterest?: boolean; notes?: string; paidAt?: string };
  if (!amount || amount <= 0) { res.status(400).json({ error: "amount must be > 0" }); return; }

  const [entry] = await db.select().from(financeLedgerEntriesTable)
    .where(and(eq(financeLedgerEntriesTable.id, entryId), eq(financeLedgerEntriesTable.userId, authUser.userId)));
  if (!entry) { res.status(404).json({ error: "Entry not found" }); return; }
  // 'expense'/'income' entries are immediate cash transactions with no
  // "outstanding balance" — lib/finance-accounting.ts's KIND_REPAYMENT_POSTING
  // and KIND_INTEREST_POSTING don't map them, so a repayment here would
  // silently reduce entry.amount without any matching journal posting,
  // desyncing the double-entry books from the day-to-day ledger.
  if (!REPAYABLE_KINDS.has(entry.kind)) {
    res.status(400).json({ error: `Repayments aren't supported for '${entry.kind}' entries — they're recorded as fully settled at creation.` });
    return;
  }

  const [repayment] = await db.insert(financeRepaymentsTable).values({
    entryId, amount, isInterest: isInterest ? 1 : 0, notes, paidAt: paidAt ? new Date(paidAt) : new Date(),
  }).returning();

  // Principal repayments reduce what's actually still owed (`amount`) —
  // not just the status label. Previously `amount` never moved after a
  // repayment, which left it representing the original amount forever;
  // downstream, the late-fee cron (lib/finance-late-fee-cron.ts) reads
  // `amount` as "still outstanding" and kept accruing fees on the full
  // original principal even after most of it had been repaid. Interest
  // repayments are unaffected — they only ever tracked interestPaid,
  // separately from principal.
  //
  // BUG FIX: this used to read `entry.amount` (fetched at the top of the
  // handler) and write back `entry.amount - amount` computed in JS. Two
  // concurrent repayments against the same entry both read the same stale
  // `entry.amount`, so the second write clobbers the first's decrement —
  // one of the two repayments is silently "lost" from the outstanding
  // balance even though both rows exist in finance_repayments. Doing the
  // subtraction as an atomic SQL expression makes the decrement race-safe:
  // Postgres serializes the two UPDATEs instead of the app computing the
  // new value from a value it read before the other request's write.
  if (!isInterest) {
    const [updated] = await db.update(financeLedgerEntriesTable)
      .set({ amount: sql`GREATEST(0, ${financeLedgerEntriesTable.amount} - ${amount})`, updatedAt: new Date() })
      .where(eq(financeLedgerEntriesTable.id, entryId))
      .returning({ amount: financeLedgerEntriesTable.amount });
    const newStatus = (updated?.amount ?? 0) <= 0.01 ? "paid" : "partial";
    await db.update(financeLedgerEntriesTable).set({ status: newStatus }).where(eq(financeLedgerEntriesTable.id, entryId));
  } else {
    await db.update(financeLedgerEntriesTable)
      .set({ interestPaid: sql`${financeLedgerEntriesTable.interestPaid} + ${amount}`, updatedAt: new Date() })
      .where(eq(financeLedgerEntriesTable.id, entryId));
  }
  postRepaymentJournal(entry, amount, !!isInterest).catch(() => {}); // best-effort

  // Phase 7 — Notification Bus. Previously a repayment posted silently;
  // only entry *creation* notified (lib/finance-notify.ts's
  // notifyEntryCreated). This is the "Ryft repayment posted" event master
  // plan §6 names as the bus's own motivating example.
  notifyRyftRepaymentPosted(
    authUser.userId, entry.title, `${entry.currency} ${amount.toLocaleString()}`, !!isInterest,
  ).catch(() => {});

  res.status(201).json({ ...repayment, paidAt: iso(repayment.paidAt), createdAt: iso(repayment.createdAt) });
});

// ─── Attachments (receipts / invoices / screenshots on a ledger entry) ──────

async function assertEntryOwnership(entryId: number, userId: number): Promise<boolean> {
  const rows = await db.select({ id: financeLedgerEntriesTable.id })
    .from(financeLedgerEntriesTable)
    .where(and(eq(financeLedgerEntriesTable.id, entryId), eq(financeLedgerEntriesTable.userId, userId)))
    .limit(1);
  return rows.length > 0;
}

// GET /finance/entries/:id/attachments — list (metadata only, no file bytes)
router.get("/finance/entries/:id/attachments", requireAuth, requireFinanceLedgerEntryOwnership("finance.entry.attachments.read"), async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const entryId = parseInt(paramString(req.params.id), 10);
  if (!Number.isFinite(entryId)) { res.status(400).json({ error: "Invalid entry id" }); return; }
  if (!(await assertEntryOwnership(entryId, authUser.userId))) { res.status(404).json({ error: "Entry not found" }); return; }

  const rows = await db.select({
    id: financeAttachmentsTable.id,
    fileName: financeAttachmentsTable.fileName,
    mimeType: financeAttachmentsTable.mimeType,
    fileSizeBytes: financeAttachmentsTable.fileSizeBytes,
    note: financeAttachmentsTable.note,
    uploadedAt: financeAttachmentsTable.uploadedAt,
  }).from(financeAttachmentsTable)
    .where(and(eq(financeAttachmentsTable.entryId, entryId), eq(financeAttachmentsTable.userId, authUser.userId)))
    .orderBy(desc(financeAttachmentsTable.uploadedAt));
  res.json(rows.map(r => ({ ...r, uploadedAt: iso(r.uploadedAt) })));
});

// Whitelist of mimeTypes an attachment can be stored/served as. Receipts,
// invoices, and screenshots are always images/PDFs in practice — allowing
// anything the client claims (BUG FIX below) meant a value like
// "text/html" would be stored, and GET .../attachments/:id?raw=1 sets
// Content-Type straight from that stored value with `inline` disposition,
// so the browser would render (and execute scripts in) an attacker-chosen
// HTML/SVG payload the next time the owner previewed their own upload.
// Auth + ownership already gate that endpoint, so this is a self-XSS
// surface today — but it's exactly the kind of stored payload that turns
// into a real one the moment attachment sharing (a natural feature request
// for a receipts/invoices module) gets added later. Restricting to actual
// document/image formats at upload time closes it now rather than relying
// on every future reader of `mimeType` to re-derive this same rule.
const ALLOWED_ATTACHMENT_MIME_TYPES = new Set([
  "image/jpeg", "image/png", "image/gif", "image/webp", "image/heic", "image/heif",
  "application/pdf",
]);

// POST /finance/entries/:id/attachments — upload a receipt/invoice
// Body: { fileName, mimeType, note?, dataBase64 }
router.post("/finance/entries/:id/attachments", requireAuth, uploadBodyParser, requireFinanceLedgerEntryOwnership("finance.entry.attachments.create"), async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const entryId = parseInt(paramString(req.params.id), 10);
  if (!Number.isFinite(entryId)) { res.status(400).json({ error: "Invalid entry id" }); return; }
  if (!(await assertEntryOwnership(entryId, authUser.userId))) { res.status(404).json({ error: "Entry not found" }); return; }

  const { fileName, mimeType, note, dataBase64 } = req.body ?? {};
  if (typeof fileName !== "string" || !fileName.trim()) { res.status(400).json({ error: "fileName is required" }); return; }
  if (typeof mimeType !== "string" || !mimeType.trim()) { res.status(400).json({ error: "mimeType is required" }); return; }
  // BUG FIX: mimeType was accepted as-is (any non-empty string) and later
  // echoed back verbatim as the Content-Type header when the attachment is
  // viewed — see ALLOWED_ATTACHMENT_MIME_TYPES's comment above.
  const normalizedMimeType = mimeType.trim().toLowerCase();
  if (!ALLOWED_ATTACHMENT_MIME_TYPES.has(normalizedMimeType)) {
    res.status(400).json({ error: `Unsupported file type "${mimeType}". Only images and PDFs are allowed.` });
    return;
  }
  if (typeof dataBase64 !== "string" || !dataBase64) { res.status(400).json({ error: "dataBase64 is required" }); return; }

  // Strip a data-URL prefix if the client sent one (e.g. "data:image/jpeg;base64,...").
  const b64 = dataBase64.includes(",") && dataBase64.trim().startsWith("data:")
    ? dataBase64.slice(dataBase64.indexOf(",") + 1)
    : dataBase64;

  let raw: Buffer;
  try {
    raw = Buffer.from(b64, "base64");
  } catch {
    res.status(400).json({ error: "dataBase64 is not valid base64" }); return;
  }
  if (raw.length === 0) { res.status(400).json({ error: "File is empty" }); return; }
  if (raw.length > MAX_ATTACHMENT_BYTES) {
    res.status(413).json({
      error: "File too large",
      code: "ATTACHMENT_TOO_LARGE",
      solution: `Attachments are limited to ${Math.floor(MAX_ATTACHMENT_BYTES / (1024 * 1024))}MB.`,
    });
    return;
  }

  const [row] = await db.insert(financeAttachmentsTable).values({
    userId: authUser.userId,
    entryId,
    fileName: fileName.trim().slice(0, 255),
    mimeType: normalizedMimeType,
    fileSizeBytes: raw.length,
    note: typeof note === "string" && note.trim() ? note.trim().slice(0, 500) : null,
    contentBase64: b64,
  }).returning({
    id: financeAttachmentsTable.id,
    fileName: financeAttachmentsTable.fileName,
    mimeType: financeAttachmentsTable.mimeType,
    fileSizeBytes: financeAttachmentsTable.fileSizeBytes,
    note: financeAttachmentsTable.note,
    uploadedAt: financeAttachmentsTable.uploadedAt,
  });

  res.status(201).json({ ...row, uploadedAt: iso(row.uploadedAt) });
});

// GET /finance/entries/:id/attachments/:attachmentId — fetch one (?raw=1 for raw bytes)
router.get("/finance/entries/:id/attachments/:attachmentId", requireAuth, requireFinanceLedgerEntryOwnership("finance.entry.attachments.read_one"), async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const entryId = parseInt(paramString(req.params.id), 10);
  const attachmentId = parseInt(paramString(req.params.attachmentId), 10);
  if (!Number.isFinite(entryId) || !Number.isFinite(attachmentId)) { res.status(400).json({ error: "Invalid id" }); return; }
  if (!(await assertEntryOwnership(entryId, authUser.userId))) { res.status(404).json({ error: "Entry not found" }); return; }

  const [row] = await db.select().from(financeAttachmentsTable)
    .where(and(
      eq(financeAttachmentsTable.id, attachmentId),
      eq(financeAttachmentsTable.entryId, entryId),
      eq(financeAttachmentsTable.userId, authUser.userId),
    ))
    .limit(1);
  if (!row) { res.status(404).json({ error: "Attachment not found" }); return; }

  if (req.query.raw === "1") {
    res.setHeader("Content-Type", row.mimeType);
    res.setHeader("Content-Disposition", `inline; filename="${row.fileName.replace(/"/g, "")}"`);
    res.send(Buffer.from(row.contentBase64, "base64"));
    return;
  }

  res.json({
    id: row.id, fileName: row.fileName, mimeType: row.mimeType, fileSizeBytes: row.fileSizeBytes,
    note: row.note, uploadedAt: iso(row.uploadedAt), dataBase64: row.contentBase64,
  });
});

// DELETE /finance/entries/:id/attachments/:attachmentId
router.delete("/finance/entries/:id/attachments/:attachmentId", requireAuth, requireFinanceLedgerEntryOwnership("finance.entry.attachments.delete"), async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const entryId = parseInt(paramString(req.params.id), 10);
  const attachmentId = parseInt(paramString(req.params.attachmentId), 10);
  if (!Number.isFinite(entryId) || !Number.isFinite(attachmentId)) { res.status(400).json({ error: "Invalid id" }); return; }
  if (!(await assertEntryOwnership(entryId, authUser.userId))) { res.status(404).json({ error: "Entry not found" }); return; }

  await db.delete(financeAttachmentsTable)
    .where(and(
      eq(financeAttachmentsTable.id, attachmentId),
      eq(financeAttachmentsTable.entryId, entryId),
      eq(financeAttachmentsTable.userId, authUser.userId),
    ));
  res.json({ success: true });
});

// ─── Public receipt link ──────────────────────────────────────────────────────
// One shareable, unauthenticated link per ledger entry — "here's proof of
// this transaction" for a party who has no AYZEN account. The owner mints
// the link (idempotent — repeat calls return the same token until revoked),
// then anyone holding the link can view a read-only receipt page or download
// the same content as a PDF. Nothing else about the account (other entries,
// balances, parties list, etc.) is reachable from the token.

function receiptUrl(receiptToken: string): string {
  return financeReceiptUrl(receiptToken);
}

// Fields safe to hand to an anonymous holder of the link — no userId,
// partyId, projectId, recurringRuleId, or internal notes.
function fmtPublicReceipt(e: typeof financeLedgerEntriesTable.$inferSelect, partyName: string | null, issuedBy: string | null, lines: (typeof financeInvoiceLinesTable.$inferSelect)[] = []) {
  return {
    id: e.id,
    kind: e.kind,
    isInvoice: e.kind === "receivable" && e.status !== "paid",
    title: e.title,
    amount: e.amount,
    currency: e.currency,
    category: e.category,
    interestRate: e.interestRate,
    interestPaid: e.interestPaid,
    dueDate: iso(e.dueDate),
    occurredDate: iso(e.occurredDate),
    status: e.status,
    partyName,
    issuedBy,
    lines: lines.map(l => ({ description: l.description, quantity: l.quantity, unitPrice: l.unitPrice, taxPercent: l.taxPercent, lineTotal: l.quantity * l.unitPrice * (1 + l.taxPercent / 100) })),
    generatedAt: new Date().toISOString(),
  };
}

// POST /finance/entries/:id/receipt — mint (or fetch the existing) public link
router.post("/finance/entries/:id/receipt", requireAuth, requireFinanceLedgerEntryOwnership("finance.entry.receipt.create"), async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const id = parseInt(paramString(req.params.id), 10);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid entry id" }); return; }

  const [owned] = await db.select({ id: financeLedgerEntriesTable.id }).from(financeLedgerEntriesTable)
    .where(and(eq(financeLedgerEntriesTable.id, id), eq(financeLedgerEntriesTable.userId, authUser.userId)));
  if (!owned) { res.status(404).json({ error: "Entry not found" }); return; }

  const token = await ensureReceiptToken(id, authUser.userId);
  if (!token) { res.status(500).json({ error: "Could not generate a receipt link, please try again" }); return; }

  res.json({ token, url: receiptUrl(token) });
});

// DELETE /finance/entries/:id/receipt — revoke the public link (any
// previously shared URL stops working; a fresh POST mints a new one)
router.delete("/finance/entries/:id/receipt", requireAuth, requireFinanceLedgerEntryOwnership("finance.entry.receipt.delete"), async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const id = parseInt(paramString(req.params.id), 10);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid entry id" }); return; }
  const [row] = await db.update(financeLedgerEntriesTable)
    .set({ receiptToken: null, updatedAt: new Date() })
    .where(and(eq(financeLedgerEntriesTable.id, id), eq(financeLedgerEntriesTable.userId, authUser.userId)))
    .returning({ id: financeLedgerEntriesTable.id });
  if (!row) { res.status(404).json({ error: "Entry not found" }); return; }
  res.json({ success: true });
});

// Shared lookup used by both the JSON view and the PDF route below.
async function findByReceiptToken(token: string) {
  const [entry] = await db.select().from(financeLedgerEntriesTable)
    .where(eq(financeLedgerEntriesTable.receiptToken, token)).limit(1);
  if (!entry) return null;
  const [party] = entry.partyId
    ? await db.select({ name: financePartiesTable.name }).from(financePartiesTable).where(eq(financePartiesTable.id, entry.partyId)).limit(1)
    : [];
  const [owner] = await db.select({ username: usersTable.username }).from(usersTable).where(eq(usersTable.id, entry.userId)).limit(1);
  const lines = entry.kind === "receivable"
    ? await db.select().from(financeInvoiceLinesTable).where(eq(financeInvoiceLinesTable.entryId, entry.id)).orderBy(financeInvoiceLinesTable.sortOrder)
    : [];
  return { entry, partyName: party?.name ?? null, issuedBy: owner?.username ?? null, lines };
}

// GET /finance/receipt/:token — public, no auth: read-only receipt data
router.get("/finance/receipt/:token", requirePublicAudit("finance_receipt.view", { onDecision: pepDecisionObserver }), async (req, res): Promise<void> => {
  const token = paramString(req.params.token);
  if (!token) { res.status(400).json({ error: "Missing token" }); return; }
  const found = await findByReceiptToken(token);
  if (!found) { res.status(404).json({ error: "This receipt link is invalid or has been revoked." }); return; }
  res.json(fmtPublicReceipt(found.entry, found.partyName, found.issuedBy, found.lines));
});

// GET /finance/receipt/:token/pdf — public, no auth: the same receipt as a PDF
router.get("/finance/receipt/:token/pdf", requirePublicAudit("finance_receipt.pdf", { onDecision: pepDecisionObserver }), async (req, res): Promise<void> => {
  const token = paramString(req.params.token);
  if (!token) { res.status(400).json({ error: "Missing token" }); return; }
  const found = await findByReceiptToken(token);
  if (!found) { res.status(404).json({ error: "This receipt link is invalid or has been revoked." }); return; }
  const { entry: e, partyName, issuedBy, lines } = found;
  const isInvoice = e.kind === "receivable" && e.status !== "paid";
  const docLabel = isInvoice ? "Invoice" : "Transaction Receipt";

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="ayzen-${isInvoice ? "invoice" : "receipt"}-${e.id}.pdf"`);
  const doc = new PDFDocument({ margin: 50, size: "A4" });
  doc.pipe(res);

  doc.fontSize(20).fillColor("#00a89f").text("AYZEN", { continued: true }).fillColor("#333").fontSize(12).text(`  ·  ${docLabel}`);
  doc.moveDown(0.3);
  doc.fontSize(9).fillColor("#888").text(`${isInvoice ? "Invoice" : "Receipt"} #${isInvoice ? `INV-${e.id}` : e.id}  ·  Generated ${new Date().toLocaleString()}`);
  doc.moveDown(1.2);
  doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor("#ddd").stroke();
  doc.moveDown(1);

  const row = (label: string, value: string) => {
    doc.fontSize(10).fillColor("#888").text(label, 50, doc.y, { continued: false, width: 150 });
    doc.fontSize(12).fillColor("#111").text(value, 210, doc.y - doc.currentLineHeight(), { width: 335 });
    doc.moveDown(0.7);
  };

  row("Type", e.kind.charAt(0).toUpperCase() + e.kind.slice(1));
  row("Title", e.title);
  if (!lines.length) row("Amount", `${e.currency} ${e.amount.toLocaleString()}`);
  if (partyName) row(isInvoice ? "Bill to" : "Party", partyName);
  if (e.category) row("Category", e.category);
  row("Status", e.status.charAt(0).toUpperCase() + e.status.slice(1));
  row("Date", new Date(e.occurredDate).toLocaleDateString());
  if (e.dueDate) row("Due date", new Date(e.dueDate).toLocaleDateString());
  if (e.interestRate != null) row("Interest rate", `${e.interestRate}%`);
  if (e.interestPaid) row("Interest paid", `${e.currency} ${e.interestPaid.toLocaleString()}`);
  if (issuedBy) row("Issued by", issuedBy);

  if (lines.length) {
    doc.moveDown(0.5);
    doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor("#ddd").stroke();
    doc.moveDown(0.6);
    const colX = { desc: 50, qty: 300, price: 360, tax: 435, total: 480 };
    doc.fontSize(9).fillColor("#888")
      .text("Description", colX.desc, doc.y, { width: 240, continued: false })
      .text("Qty", colX.qty, doc.y - doc.currentLineHeight(), { width: 50 })
      .text("Price", colX.price, doc.y - doc.currentLineHeight(), { width: 65 })
      .text("Tax%", colX.tax, doc.y - doc.currentLineHeight(), { width: 45 })
      .text("Total", colX.total, doc.y - doc.currentLineHeight(), { width: 65 });
    doc.moveDown(0.4);
    doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor("#eee").stroke();
    doc.moveDown(0.3);
    let subtotal = 0, taxTotal = 0;
    for (const l of lines) {
      const lineBase = l.quantity * l.unitPrice;
      const lineTax = lineBase * (l.taxPercent / 100);
      subtotal += lineBase; taxTotal += lineTax;
      const y = doc.y;
      doc.fontSize(10).fillColor("#111")
        .text(l.description, colX.desc, y, { width: 240 })
        .text(String(l.quantity), colX.qty, y, { width: 50 })
        .text(l.unitPrice.toLocaleString(), colX.price, y, { width: 65 })
        .text(l.taxPercent ? `${l.taxPercent}%` : "—", colX.tax, y, { width: 45 })
        .text((lineBase + lineTax).toLocaleString(), colX.total, y, { width: 65 });
      doc.moveDown(0.6);
    }
    doc.moveDown(0.3);
    doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor("#eee").stroke();
    doc.moveDown(0.5);
    const totalsRow = (label: string, value: string, bold = false) => {
      doc.fontSize(bold ? 12 : 10).fillColor(bold ? "#111" : "#888").text(label, 360, doc.y, { width: 120 });
      doc.fontSize(bold ? 12 : 10).fillColor("#111").text(`${e.currency} ${value}`, colX.total, doc.y - doc.currentLineHeight(), { width: 65 });
      doc.moveDown(0.5);
    };
    totalsRow("Subtotal", subtotal.toLocaleString());
    if (taxTotal > 0) totalsRow("Tax", taxTotal.toLocaleString());
    totalsRow("Total", e.amount.toLocaleString(), true);
  }

  if (e.notes) {
    doc.moveDown(0.3);
    doc.fontSize(10).fillColor("#888").text("Notes");
    doc.fontSize(11).fillColor("#111").text(e.notes, { width: 495 });
  }

  doc.moveDown(2);
  doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor("#ddd").stroke();
  doc.moveDown(0.6);
  doc.fontSize(8).fillColor("#aaa").text(
    isInvoice
      ? "This is a system-generated invoice from AYZEN Finance. Anyone with this link can view it."
      : "This is a system-generated receipt from AYZEN Finance. Anyone with this link can view it.",
    { width: 495 },
  );

  doc.end();
});

// ─── Assets (Cash, Bank, Online Wallets, Mutual Funds, Locked Funds, Other) ──

router.get("/finance/assets", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const { assetType } = req.query as Record<string, string>;
  const conditions = [eq(financeAssetsTable.userId, authUser.userId)];
  if (assetType) conditions.push(eq(financeAssetsTable.assetType, assetType));

  const assets = await db.select().from(financeAssetsTable).where(and(...conditions)).orderBy(desc(financeAssetsTable.createdAt));
  const assetIds = assets.map(a => a.id);
  const owners = assetIds.length
    ? await db.select().from(financeAssetOwnersTable).where(sql`${financeAssetOwnersTable.assetId} IN (${sql.join(assetIds.map(id => sql`${id}`), sql`, `)})`)
    : [];

  res.json(assets.map(a => ({
    ...fmtAsset(a),
    owners: owners.filter(o => o.assetId === a.id),
  })));
});

router.post("/finance/assets", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const b = req.body as Record<string, any>;
  if (!b.assetType || !b.name?.trim()) { res.status(400).json({ error: "assetType and name are required" }); return; }

  const [asset] = await db.insert(financeAssetsTable).values({
    userId: authUser.userId,
    assetType: b.assetType,
    name: b.name.trim(),
    provider: b.provider ?? null,
    totalValue: Number(b.totalValue) || 0,
    purchasedValue: b.purchasedValue != null ? Number(b.purchasedValue) : null,
    interestRate: b.interestRate != null ? Number(b.interestRate) : null,
    purchaseDate: b.purchaseDate ? new Date(b.purchaseDate) : null,
    maturityDate: b.maturityDate ? new Date(b.maturityDate) : null,
    liquidity: b.liquidity ?? null,
    notes: b.notes ?? null,
  }).returning();

  const owners: Array<{ partyId?: number | null; ownerName: string; ownershipPercent: number }> =
    Array.isArray(b.owners) && b.owners.length ? b.owners : [{ partyId: null, ownerName: "You", ownershipPercent: 100 }];

  const ownerRows = owners.length
    ? await db.insert(financeAssetOwnersTable).values(
        owners.map(o => ({ assetId: asset.id, partyId: o.partyId ?? null, ownerName: o.ownerName, ownershipPercent: Number(o.ownershipPercent) || 0 }))
      ).returning()
    : [];

  res.status(201).json({ ...fmtAsset(asset), owners: ownerRows });
});

router.put("/finance/assets/:id", requireAuth, requireFinanceAssetOwnership("finance.asset.update", financeNotFoundDeny("Not found")), async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const id = parseInt(paramString(req.params.id), 10);
  const b = req.body as Record<string, any>;

  const update: Record<string, any> = { updatedAt: new Date() };
  for (const k of ["assetType", "name", "provider", "liquidity", "notes"]) {
    if (b[k] !== undefined) update[k] = b[k];
  }
  // BUG FIX: totalValue/purchasedValue/interestRate used to go straight
  // from `b[k]` into `update[k]` with no coercion or validation — unlike
  // POST /finance/assets, which does `Number(b.totalValue) || 0`. A
  // string, empty value, or NaN sent here would either fail at the DB
  // (real/numeric column rejecting non-numeric input) or, worse, get
  // silently coerced somewhere downstream and poison every calculation
  // that reads totalValue: net worth (computeNetWorthBreakdown), any goal
  // linked to this asset (syncGoalProgress), and the assetAllocation /
  // analytics breakdowns — all of which sum totalValue directly with no
  // further validation of their own. Validate the same way POST does.
  for (const k of ["totalValue", "purchasedValue", "interestRate"] as const) {
    if (b[k] !== undefined) {
      if (b[k] === null) {
        if (k === "totalValue") { res.status(400).json({ error: "totalValue cannot be null" }); return; } // NOT NULL column
        update[k] = null; // purchasedValue/interestRate are nullable
        continue;
      }
      const n = Number(b[k]);
      if (!Number.isFinite(n)) { res.status(400).json({ error: `${k} must be a valid number` }); return; }
      update[k] = n;
    }
  }
  if (b.purchaseDate !== undefined) update.purchaseDate = b.purchaseDate ? new Date(b.purchaseDate) : null;
  if (b.maturityDate !== undefined) update.maturityDate = b.maturityDate ? new Date(b.maturityDate) : null;

  const [asset] = await db.update(financeAssetsTable)
    .set(update)
    .where(and(eq(financeAssetsTable.id, id), eq(financeAssetsTable.userId, authUser.userId)))
    .returning();
  if (!asset) { res.status(404).json({ error: "Not found" }); return; }

  let ownerRows = await db.select().from(financeAssetOwnersTable).where(eq(financeAssetOwnersTable.assetId, id));
  if (Array.isArray(b.owners)) {
    await db.delete(financeAssetOwnersTable).where(eq(financeAssetOwnersTable.assetId, id));
    ownerRows = b.owners.length
      ? await db.insert(financeAssetOwnersTable).values(
          b.owners.map((o: any) => ({ assetId: id, partyId: o.partyId ?? null, ownerName: o.ownerName, ownershipPercent: Number(o.ownershipPercent) || 0 }))
        ).returning()
      : [];
  }

  res.json({ ...fmtAsset(asset), owners: ownerRows });
});

router.delete("/finance/assets/:id", requireAuth, requireFinanceAssetOwnership("finance.asset.delete", financeNotFoundDeny("Not found")), async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const id = parseInt(paramString(req.params.id), 10);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid asset id" }); return; }
  // BUG FIX: financeAssetOwnersTable was deleted by assetId alone, before
  // ownership of the asset itself was ever verified — the ledger entry
  // delete below the ownership check right, but by then the owners for
  // *any* asset id (not just ones this user owns) had already been wiped.
  // Any authenticated user could destroy another user's asset-ownership
  // breakdown just by guessing/enumerating asset ids, even though the
  // asset row itself would survive (the second delete is correctly
  // scoped). Confirm ownership first, same pattern DELETE
  // /finance/entries/:id already uses for its child-table deletes.
  const [owned] = await db.select({ id: financeAssetsTable.id }).from(financeAssetsTable)
    .where(and(eq(financeAssetsTable.id, id), eq(financeAssetsTable.userId, authUser.userId)));
  if (!owned) { res.status(404).json({ error: "Not found" }); return; }
  await db.delete(financeAssetOwnersTable).where(eq(financeAssetOwnersTable.assetId, id));
  await db.delete(financeAssetsTable).where(and(eq(financeAssetsTable.id, id), eq(financeAssetsTable.userId, authUser.userId)));
  res.json({ success: true });
});

// ─── Investments — per-project rollup (Invested / Spent / Earned / PnL) ─────

router.get("/finance/investments", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }

  // Grouped by project AND kind AND currency, then converted to the user's
  // base currency before being summed — same reasoning as /finance/summary
  // and /finance/projections (see getRateMap/toBase): a project funded in
  // both USD and BDT can't have its rows added together as raw numbers.
  const rates = await getRateMap(authUser.userId);
  const rows = await db.select({
    projectId: financeLedgerEntriesTable.projectId,
    kind: financeLedgerEntriesTable.kind,
    currency: financeLedgerEntriesTable.currency,
    total: sql<number>`COALESCE(SUM(${financeLedgerEntriesTable.amount}), 0)`,
    // Actual interest amount owed (investment principal × rate%), not the
    // raw interestRate percentage itself — summing interestRate directly
    // (e.g. two 10% rows -> "20") produced a meaningless number.
    interestOwed: sql<number>`COALESCE(SUM(${financeLedgerEntriesTable.amount} * COALESCE(${financeLedgerEntriesTable.interestRate}, 0) / 100.0), 0)`,
  }).from(financeLedgerEntriesTable)
    .where(and(
      eq(financeLedgerEntriesTable.userId, authUser.userId),
      isNotNull(financeLedgerEntriesTable.projectId),
      sql`${financeLedgerEntriesTable.kind} IN ('investment', 'expense', 'income')`,
    ))
    .groupBy(financeLedgerEntriesTable.projectId, financeLedgerEntriesTable.kind, financeLedgerEntriesTable.currency);

  const projectIds = [...new Set(rows.map(r => r.projectId).filter((x): x is number => x != null))];
  const projects = projectIds.length
    ? await db.select({ id: projectsTable.id, name: projectsTable.name }).from(projectsTable)
        .where(sql`${projectsTable.id} IN (${sql.join(projectIds.map(id => sql`${id}`), sql`, `)})`)
    : [];
  const nameById = new Map(projects.map(p => [p.id, p.name]));

  const byProject = new Map<number, { invested: number; spent: number; earned: number; interestOwed: number }>();
  for (const r of rows) {
    if (r.projectId == null) continue;
    const cur = byProject.get(r.projectId) ?? { invested: 0, spent: 0, earned: 0, interestOwed: 0 };
    const totalBase = toBase(r.total, r.currency, rates);
    if (r.kind === "investment") {
      cur.invested += totalBase;
      cur.interestOwed += toBase(r.interestOwed, r.currency, rates);
    }
    if (r.kind === "expense") cur.spent += totalBase;
    if (r.kind === "income") cur.earned += totalBase;
    byProject.set(r.projectId, cur);
  }

  const result = [...byProject.entries()].map(([projectId, v]) => ({
    projectId,
    projectName: nameById.get(projectId) ?? `Project #${projectId}`,
    invested: v.invested,
    spent: v.spent,
    earned: v.earned,
    interestOwed: v.interestOwed,
    netPnl: v.earned - v.spent,
    netPosition: v.invested - v.spent + v.earned,
  }));

  res.json(result);
});

// ─── Dashboard summary ───────────────────────────────────────────────────────

router.get("/finance/summary", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }

  // Grouped by kind AND currency (not just kind) so mixed-currency entries
  // can be converted to the user's base currency before being summed —
  // summing raw `amount` across currencies (e.g. USD + BDT) as if they were
  // the same unit would silently produce a meaningless total.
  const rates = await getRateMap(authUser.userId);
  const totalsByCurrency = await db.select({
    kind: financeLedgerEntriesTable.kind,
    currency: financeLedgerEntriesTable.currency,
    total: sql<number>`COALESCE(SUM(${financeLedgerEntriesTable.amount}), 0)`,
    interestPaid: sql<number>`COALESCE(SUM(${financeLedgerEntriesTable.interestPaid}), 0)`,
  }).from(financeLedgerEntriesTable)
    .where(and(eq(financeLedgerEntriesTable.userId, authUser.userId), sql`${financeLedgerEntriesTable.status} NOT IN ('paid', 'closed')`))
    .groupBy(financeLedgerEntriesTable.kind, financeLedgerEntriesTable.currency);

  const byKind: Record<string, { total: number; interestPaid: number }> = {};
  for (const t of totalsByCurrency) {
    const bucket = byKind[t.kind] ?? { total: 0, interestPaid: 0 };
    bucket.total += toBase(t.total, t.currency, rates);
    bucket.interestPaid += toBase(t.interestPaid, t.currency, rates);
    byKind[t.kind] = bucket;
  }

  const now = new Date();
  const in30 = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

  const upcoming = await db.select().from(financeLedgerEntriesTable)
    .where(and(
      eq(financeLedgerEntriesTable.userId, authUser.userId),
      isNotNull(financeLedgerEntriesTable.dueDate),
      gte(financeLedgerEntriesTable.dueDate, now),
      lte(financeLedgerEntriesTable.dueDate, in30),
      sql`${financeLedgerEntriesTable.status} NOT IN ('paid', 'closed')`,
    ))
    .orderBy(financeLedgerEntriesTable.dueDate);

  // "My share" of each asset = totalValue * (my ownership% / 100). partyId
  // null rows represent the account owner's own share. Shared with the Net
  // Worth trend/goals so the dashboard figure and the snapshot never disagree.
  const netWorthBreakdown = await computeNetWorthBreakdown(authUser.userId);
  const myAssetValue = netWorthBreakdown.totalAssets;

  const totalReceivable = byKind["receivable"]?.total ?? 0;
  const totalPayable = byKind["payable"]?.total ?? 0;
  const totalBorrowed = byKind["borrowed"]?.total ?? 0;
  const totalLending = byKind["lending"]?.total ?? 0;
  const totalExpense = byKind["expense"]?.total ?? 0;
  const totalIncome = byKind["income"]?.total ?? 0;
  const totalInvested = byKind["investment"]?.total ?? 0;

  const interestPaid = Object.values(byKind).reduce((s, k) => s + k.interestPaid, 0);
  const interestOwedRows = await db.select({
    v: financeLedgerEntriesTable.interestRate,
    amount: financeLedgerEntriesTable.amount,
    currency: financeLedgerEntriesTable.currency,
    paid: financeLedgerEntriesTable.interestPaid,
  })
    .from(financeLedgerEntriesTable)
    // BUG FIX: 'lending' (money lent out at interest) was missing from this
    // IN-list — interest.tsx's Interest Tracker page and
    // KIND_INTEREST_POSTING (lib/finance-accounting.ts) both treat 'lending'
    // exactly like 'borrowed'/'investment' for interest purposes, so
    // excluding it here silently undercounted the dashboard's
    // "Interest Owed" figure for anyone lending money at interest.
    .where(and(eq(financeLedgerEntriesTable.userId, authUser.userId), sql`${financeLedgerEntriesTable.kind} IN ('borrowed', 'lending', 'investment')`, isNotNull(financeLedgerEntriesTable.interestRate)));
  const interestOwed = interestOwedRows.reduce((s, r) => s + Math.max(0, toBase(((r.v ?? 0) / 100) * r.amount - r.paid, r.currency, rates)), 0);

  res.json({
    totalBorrowed,
    totalReceivable,
    totalPayable,
    totalLending,
    totalInvested,
    totalExpense,
    totalIncome,
    currentBalance: myAssetValue,
    netWorth: netWorthBreakdown.netWorth,
    interestPaid,
    interestOwed,
    upcoming: upcoming.map(fmtEntry),
  });
});

// ─── Net Worth (breakdown + trend snapshots) ────────────────────────────────

router.get("/finance/net-worth", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  res.json(await computeNetWorthBreakdown(authUser.userId));
});

router.get("/finance/net-worth/history", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const months = parseInt((req.query.months as string) ?? "12", 10) || 12;
  const rows = await listNetWorthHistory(authUser.userId, months);
  res.json(rows);
});

// Manual "snapshot now" button — same formula/table the monthly cron uses
// (lib/finance-networth-cron.ts), replaces the current month's point.
router.post("/finance/net-worth/snapshot", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  await snapshotNetWorth(authUser.userId);
  const rows = await listNetWorthHistory(authUser.userId, 12);
  res.status(201).json(rows[rows.length - 1] ?? null);
});

// ─── Financial Goals ─────────────────────────────────────────────────────────

router.get("/finance/goals", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const goals = await db.select().from(financeGoalsTable).where(eq(financeGoalsTable.userId, authUser.userId)).orderBy(desc(financeGoalsTable.createdAt));
  const synced = await Promise.all(goals.map(syncGoalProgress));
  res.json(synced);
});

router.post("/finance/goals", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const { title, goalType, targetAmount, currentAmount, currency, targetDate, linkedAssetId, notes } = req.body as {
    title?: string; goalType?: string; targetAmount?: number; currentAmount?: number;
    currency?: string; targetDate?: string; linkedAssetId?: number | null; notes?: string;
  };
  if (!title?.trim() || !targetAmount || targetAmount <= 0) { res.status(400).json({ error: "title and a positive targetAmount are required" }); return; }
  // Asset-linked goals mirror the asset's totalValue directly (see
  // syncGoalProgress) and assets carry no currency of their own — they're
  // always stored in the user's base currency. So an asset-linked goal must
  // be forced to base currency too, or currentAmount (base-currency asset
  // value) and targetAmount (whatever currency was requested) would silently
  // get compared/displayed as if they were the same unit.
  const resolvedCurrency = linkedAssetId != null ? "BDT" : (currency?.trim() || "BDT");
  const [row] = await db.insert(financeGoalsTable).values({
    userId: authUser.userId,
    title: title.trim(),
    goalType: goalType?.trim() || "savings",
    targetAmount,
    currentAmount: currentAmount ?? 0,
    currency: resolvedCurrency,
    targetDate: targetDate ? new Date(targetDate) : null,
    linkedAssetId: linkedAssetId ?? null,
    notes: notes?.trim() || null,
  }).returning();
  res.status(201).json(await syncGoalProgress(row));
});

router.put("/finance/goals/:id", requireAuth, requireFinanceGoalOwnership("finance.goal.update", financeNotFoundDeny("Goal not found")), async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const id = parseInt(paramString(req.params.id), 10);
  const { title, goalType, targetAmount, currentAmount, currency, targetDate, linkedAssetId, status, notes } = req.body as {
    title?: string; goalType?: string; targetAmount?: number; currentAmount?: number;
    currency?: string; targetDate?: string | null; linkedAssetId?: number | null; status?: string; notes?: string;
  };
  const [existing] = await db.select().from(financeGoalsTable).where(and(eq(financeGoalsTable.id, id), eq(financeGoalsTable.userId, authUser.userId)));
  if (!existing) { res.status(404).json({ error: "Goal not found" }); return; }
  // Same reasoning as the POST route above: whichever linkedAssetId this
  // update leaves the goal with (the new value if one was sent, otherwise
  // whatever it already had) determines whether currency must stay pinned
  // to base — an asset-linked goal can never carry a non-base currency.
  const effectiveLinkedAssetId = linkedAssetId !== undefined ? linkedAssetId : existing.linkedAssetId;
  const resolvedCurrency = effectiveLinkedAssetId != null ? "BDT" : currency;
  const [row] = await db.update(financeGoalsTable).set({
    ...(title !== undefined ? { title: title.trim() } : {}),
    ...(goalType !== undefined ? { goalType } : {}),
    ...(targetAmount !== undefined ? { targetAmount } : {}),
    ...(currentAmount !== undefined ? { currentAmount } : {}),
    ...(resolvedCurrency !== undefined ? { currency: resolvedCurrency } : {}),
    ...(targetDate !== undefined ? { targetDate: targetDate ? new Date(targetDate) : null } : {}),
    ...(linkedAssetId !== undefined ? { linkedAssetId } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(notes !== undefined ? { notes: notes?.trim() || null } : {}),
    updatedAt: new Date(),
  }).where(and(eq(financeGoalsTable.id, id), eq(financeGoalsTable.userId, authUser.userId))).returning();
  if (!row) { res.status(404).json({ error: "Goal not found" }); return; }
  res.json(await syncGoalProgress(row));
});

// Manual contribution — adds to currentAmount and auto-flags 'achieved' once
// the target is reached. Not available on goals linked to an asset, since
// their currentAmount is derived from the asset instead (see syncGoalProgress).
router.post("/finance/goals/:id/contribute", requireAuth, requireFinanceGoalOwnership("finance.goal.contribute", financeNotFoundDeny("Goal not found")), async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const id = parseInt(paramString(req.params.id), 10);
  const { amount } = req.body as { amount?: number };
  if (!amount || amount <= 0) { res.status(400).json({ error: "amount must be positive" }); return; }

  const [goal] = await db.select().from(financeGoalsTable).where(and(eq(financeGoalsTable.id, id), eq(financeGoalsTable.userId, authUser.userId)));
  if (!goal) { res.status(404).json({ error: "Goal not found" }); return; }
  if (goal.linkedAssetId != null) { res.status(400).json({ error: "This goal tracks a linked asset automatically — update the asset instead" }); return; }

  const currentAmount = goal.currentAmount + amount;
  const status = goal.status === "active" && currentAmount >= goal.targetAmount ? "achieved" : goal.status;
  const [row] = await db.update(financeGoalsTable).set({ currentAmount, status, updatedAt: new Date() })
    .where(eq(financeGoalsTable.id, id)).returning();
  res.json(row);
});

router.delete("/finance/goals/:id", requireAuth, requireFinanceGoalOwnership("finance.goal.delete", financeSilentSuccessDeny), async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const id = parseInt(paramString(req.params.id), 10);
  await db.delete(financeGoalsTable).where(and(eq(financeGoalsTable.id, id), eq(financeGoalsTable.userId, authUser.userId)));
  res.json({ success: true });
});

// ─── Projections ──────────────────────────────────────────────────────────

router.get("/finance/projections", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }

  const sixMonthsAgo = new Date();
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

  // Grouped by kind AND currency, then converted to the user's base
  // currency before summing — entries in different currencies can't be
  // added together as raw numbers (see getRateMap/toBase below).
  const rates = await getRateMap(authUser.userId);
  const rowsByCurrency = await db.select({
    kind: financeLedgerEntriesTable.kind,
    currency: financeLedgerEntriesTable.currency,
    total: sql<number>`COALESCE(SUM(${financeLedgerEntriesTable.amount}), 0)`,
  }).from(financeLedgerEntriesTable)
    .where(and(eq(financeLedgerEntriesTable.userId, authUser.userId), gte(financeLedgerEntriesTable.occurredDate, sixMonthsAgo)))
    .groupBy(financeLedgerEntriesTable.kind, financeLedgerEntriesTable.currency);

  const byKind: Record<string, number> = {};
  for (const r of rowsByCurrency) byKind[r.kind] = (byKind[r.kind] ?? 0) + toBase(r.total, r.currency, rates);
  const monthlyIncome = (byKind["income"] ?? 0) / 6;
  const monthlyExpense = (byKind["expense"] ?? 0) / 6;
  const monthlyNet = monthlyIncome - monthlyExpense;

  // Assets don't carry a currency of their own — totalValue is always
  // already stored in the user's base currency, so no conversion needed here.
  const assets = await db.select().from(financeAssetsTable).where(eq(financeAssetsTable.userId, authUser.userId));
  const currentBalance = assets.reduce((s, a) => s + a.totalValue, 0);

  const receivables = await db.select({ total: sql<number>`COALESCE(SUM(${financeLedgerEntriesTable.amount}), 0)`, currency: financeLedgerEntriesTable.currency })
    .from(financeLedgerEntriesTable)
    .where(and(eq(financeLedgerEntriesTable.userId, authUser.userId), eq(financeLedgerEntriesTable.kind, "receivable"), sql`${financeLedgerEntriesTable.status} != 'paid'`))
    .groupBy(financeLedgerEntriesTable.currency);
  const payables = await db.select({ total: sql<number>`COALESCE(SUM(${financeLedgerEntriesTable.amount}), 0)`, currency: financeLedgerEntriesTable.currency })
    .from(financeLedgerEntriesTable)
    .where(and(eq(financeLedgerEntriesTable.userId, authUser.userId), eq(financeLedgerEntriesTable.kind, "payable"), sql`${financeLedgerEntriesTable.status} != 'paid'`))
    .groupBy(financeLedgerEntriesTable.currency);

  const totalReceivable = receivables.reduce((s, r) => s + toBase(r.total, r.currency, rates), 0);
  const totalPayable = payables.reduce((s, r) => s + toBase(r.total, r.currency, rates), 0);

  const scenarios = [3, 6, 12].map(months => ({
    months,
    currentTrend: currentBalance + monthlyNet * months,
    allReceivablesCollected: currentBalance + totalReceivable + monthlyNet * months,
    allPayablesPaid: currentBalance - totalPayable + monthlyNet * months,
  }));

  res.json({ monthlyIncome, monthlyExpense, monthlyNet, currentBalance, scenarios });
});

// ─── Multi-currency helper ───────────────────────────────────────────────────
// Converts an amount into the user's base currency (BDT) using their manually
// maintained rate table. BDT always resolves to 1 even if no row exists.
async function getRateMap(userId: number): Promise<Record<string, number>> {
  const rows = await db.select().from(financeCurrencyRatesTable).where(eq(financeCurrencyRatesTable.userId, userId));
  const map: Record<string, number> = { BDT: 1 };
  for (const r of rows) map[r.currency] = r.rateToBase;
  return map;
}
function toBase(amount: number, currency: string, rates: Record<string, number>): number {
  return amount * (rates[currency] ?? 1);
}

// ─── Recurring rules ─────────────────────────────────────────────────────────

router.get("/finance/recurring", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const rows = await db.select().from(financeRecurringRulesTable)
    .where(eq(financeRecurringRulesTable.userId, authUser.userId))
    .orderBy(financeRecurringRulesTable.nextRunDate);
  res.json(rows.map(r => ({
    ...r,
    startDate: iso(r.startDate), nextRunDate: iso(r.nextRunDate), endDate: iso(r.endDate),
    lastRunAt: iso(r.lastRunAt), createdAt: iso(r.createdAt), updatedAt: iso(r.updatedAt),
    active: !!r.active,
  })));
});

router.post("/finance/recurring", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const b = req.body as Record<string, any>;
  if (!b.kind || !b.title?.trim() || !b.amount) { res.status(400).json({ error: "kind, title and amount are required" }); return; }
  const start = b.startDate ? new Date(b.startDate) : new Date();
  const [row] = await db.insert(financeRecurringRulesTable).values({
    userId: authUser.userId,
    kind: b.kind,
    title: b.title.trim(),
    amount: Number(b.amount) || 0,
    currency: b.currency || "BDT",
    partyId: b.partyId ?? null,
    projectId: b.projectId ?? null,
    category: b.category ?? null,
    interestRate: b.interestRate ?? null,
    frequency: b.frequency || "monthly",
    intervalCount: Number(b.intervalCount) || 1,
    startDate: start,
    nextRunDate: b.nextRunDate ? new Date(b.nextRunDate) : start,
    endDate: b.endDate ? new Date(b.endDate) : null,
    active: b.active === false ? 0 : 1,
    notes: b.notes ?? null,
  }).returning();
  res.status(201).json(row);
});

router.put("/finance/recurring/:id", requireAuth, requireFinanceRecurringRuleOwnership("finance.recurring_rule.update", financeNotFoundDeny("Not found")), async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const id = parseInt(paramString(req.params.id), 10);
  const b = req.body as Record<string, any>;
  const update: Record<string, any> = { updatedAt: new Date() };
  for (const k of ["title", "amount", "currency", "partyId", "projectId", "category", "interestRate", "frequency", "intervalCount", "notes"]) {
    if (b[k] !== undefined) update[k] = b[k];
  }
  if (b.active !== undefined) update.active = b.active ? 1 : 0;
  if (b.nextRunDate !== undefined) update.nextRunDate = new Date(b.nextRunDate);
  if (b.endDate !== undefined) update.endDate = b.endDate ? new Date(b.endDate) : null;

  const [row] = await db.update(financeRecurringRulesTable)
    .set(update)
    .where(and(eq(financeRecurringRulesTable.id, id), eq(financeRecurringRulesTable.userId, authUser.userId)))
    .returning();
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  res.json(row);
});

router.delete("/finance/recurring/:id", requireAuth, requireFinanceRecurringRuleOwnership("finance.recurring_rule.delete", financeSilentSuccessDeny), async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const id = parseInt(paramString(req.params.id), 10);
  await db.delete(financeRecurringRulesTable).where(and(eq(financeRecurringRulesTable.id, id), eq(financeRecurringRulesTable.userId, authUser.userId)));
  res.json({ success: true });
});

// Manual trigger — mostly for verifying a rule works right after creating it,
// instead of waiting for the next 00:15 sweep.
router.post("/finance/recurring/run-now", requireAuth, async (_req, res): Promise<void> => {
  const result = await runFinanceRecurringSweep();
  res.json(result);
});

// ─── Budgets (monthly cap per expense category) ──────────────────────────────

router.get("/finance/budgets", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }

  const budgets = await db.select().from(financeBudgetsTable).where(eq(financeBudgetsTable.userId, authUser.userId));

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  // Grouped by category AND currency, then converted to the user's base
  // currency before summing — monthlyLimit has no currency of its own (it's
  // always in base currency), so comparing it against a raw cross-currency
  // sum (e.g. USD + BDT expenses added as if the same unit) would silently
  // misreport "spent" and could show a budget as under/over its limit
  // incorrectly. Same reasoning as /finance/summary's getRateMap/toBase.
  const rates = await getRateMap(authUser.userId);
  const spentRows = await db.select({
    category: financeLedgerEntriesTable.category,
    currency: financeLedgerEntriesTable.currency,
    spent: sql<number>`COALESCE(SUM(${financeLedgerEntriesTable.amount}), 0)`,
  }).from(financeLedgerEntriesTable)
    .where(and(
      eq(financeLedgerEntriesTable.userId, authUser.userId),
      eq(financeLedgerEntriesTable.kind, "expense"),
      gte(financeLedgerEntriesTable.occurredDate, monthStart),
    ))
    .groupBy(financeLedgerEntriesTable.category, financeLedgerEntriesTable.currency);

  const spentByCategory = new Map<string, number>();
  for (const r of spentRows) {
    const key = r.category ?? "Uncategorized";
    spentByCategory.set(key, (spentByCategory.get(key) ?? 0) + toBase(r.spent, r.currency, rates));
  }

  res.json(budgets.map(b => ({
    ...b,
    spent: spentByCategory.get(b.category) ?? 0,
  })));
});

router.post("/finance/budgets", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const { category, monthlyLimit, notes } = req.body as { category?: string; monthlyLimit?: number; notes?: string };
  if (!category?.trim() || !monthlyLimit) { res.status(400).json({ error: "category and monthlyLimit are required" }); return; }
  const [row] = await db.insert(financeBudgetsTable)
    .values({ userId: authUser.userId, category: category.trim(), monthlyLimit, notes })
    .onConflictDoUpdate({
      target: [financeBudgetsTable.userId, financeBudgetsTable.category],
      set: { monthlyLimit, notes, updatedAt: new Date() },
    })
    .returning();
  res.status(201).json(row);
});

router.delete("/finance/budgets/:id", requireAuth, requireFinanceBudgetOwnership("finance.budget.delete", financeSilentSuccessDeny), async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const id = parseInt(paramString(req.params.id), 10);
  await db.delete(financeBudgetsTable).where(and(eq(financeBudgetsTable.id, id), eq(financeBudgetsTable.userId, authUser.userId)));
  res.json({ success: true });
});

// ─── Currency rates ──────────────────────────────────────────────────────────

router.get("/finance/currencies", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const rows = await db.select().from(financeCurrencyRatesTable).where(eq(financeCurrencyRatesTable.userId, authUser.userId));
  res.json([{ currency: "BDT", rateToBase: 1, updatedAt: null }, ...rows.map(r => ({ ...r, updatedAt: iso(r.updatedAt) }))]);
});

router.put("/finance/currencies/:currency", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const currency = paramString(req.params.currency).toUpperCase();
  if (currency === "BDT") { res.status(400).json({ error: "BDT is the fixed base currency (rate = 1)" }); return; }
  const { rateToBase } = req.body as { rateToBase?: number };
  if (!rateToBase || rateToBase <= 0) { res.status(400).json({ error: "rateToBase must be > 0" }); return; }
  const [row] = await db.insert(financeCurrencyRatesTable)
    .values({ userId: authUser.userId, currency, rateToBase })
    .onConflictDoUpdate({
      target: [financeCurrencyRatesTable.userId, financeCurrencyRatesTable.currency],
      set: { rateToBase, updatedAt: new Date() },
    })
    .returning();
  res.json(row);
});

// ─── Export (CSV / PDF) ───────────────────────────────────────────────────────

router.get("/finance/export", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const { kind, format = "csv" } = req.query as Record<string, string>;

  const conditions = [eq(financeLedgerEntriesTable.userId, authUser.userId)];
  if (kind) conditions.push(eq(financeLedgerEntriesTable.kind, kind));
  const rows = await db.select().from(financeLedgerEntriesTable).where(and(...conditions)).orderBy(desc(financeLedgerEntriesTable.occurredDate));

  const stamp = new Date().toISOString().slice(0, 10);

  if (format === "pdf") {
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="ayzen-finance-${kind ?? "all"}-${stamp}.pdf"`);
    const doc = new PDFDocument({ margin: 40, size: "A4" });
    doc.pipe(res);
    doc.fontSize(16).text(`AYZEN Finance Export${kind ? ` — ${kind}` : ""}`, { align: "left" });
    doc.fontSize(10).fillColor("#555").text(`Generated: ${new Date().toISOString()}`);
    doc.text(`Total entries: ${rows.length}`);
    doc.moveDown(1);
    doc.fillColor("#000");

    const colX = { date: 40, kind: 110, title: 190, amount: 400, status: 470 };
    doc.fontSize(9).font("Helvetica-Bold");
    doc.text("Date", colX.date, doc.y, { continued: false });
    doc.text("Kind", colX.kind, doc.y - doc.currentLineHeight());
    doc.text("Title", colX.title, doc.y - doc.currentLineHeight());
    doc.text("Amount", colX.amount, doc.y - doc.currentLineHeight());
    doc.text("Status", colX.status, doc.y - doc.currentLineHeight());
    doc.moveDown(0.5);
    doc.font("Helvetica");

    for (const r of rows) {
      if (doc.y > 760) doc.addPage();
      const y = doc.y;
      doc.fontSize(8);
      doc.text(r.occurredDate.toISOString().slice(0, 10), colX.date, y, { width: 65 });
      doc.text(r.kind, colX.kind, y, { width: 75 });
      doc.text(r.title.slice(0, 40), colX.title, y, { width: 200 });
      doc.text(`${r.currency} ${r.amount.toLocaleString()}`, colX.amount, y, { width: 65 });
      doc.text(r.status, colX.status, y, { width: 60 });
      doc.moveDown(0.6);
    }
    doc.end();
    return;
  }

  const csv = toCsv(
    rows.map(r => ({
      date: r.occurredDate.toISOString().slice(0, 10),
      kind: r.kind, title: r.title, amount: r.amount, currency: r.currency,
      category: r.category ?? "", dueDate: r.dueDate ? r.dueDate.toISOString().slice(0, 10) : "",
      status: r.status, interestRate: r.interestRate ?? "", notes: r.notes ?? "",
    })),
    ["date", "kind", "title", "amount", "currency", "category", "dueDate", "status", "interestRate", "notes"],
  );
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="ayzen-finance-${kind ?? "all"}-${stamp}.csv"`);
  res.send(csv);
});

// ─── Bulk import (CSV) ────────────────────────────────────────────────────────
// Expected header: kind,title,amount,currency,category,dueDate,status,interestRate,notes

router.post("/finance/entries/import", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const { csv, bookId } = req.body as { csv?: string; bookId?: number };
  if (!csv?.trim()) { res.status(400).json({ error: "csv text is required" }); return; }

  // Every entry-creation path must resolve a concrete bookId before insert
  // (see financeLedgerEntriesTable.bookId's doc comment) — GET /finance/entries
  // and virtually every other read always filters on a resolved, non-null
  // bookId. This route previously left bookId null, so imported rows landed
  // in the DB but were permanently invisible in the UI.
  const resolvedBookId = await resolveBookId(authUser.userId, bookId ?? undefined);

  const validKinds = new Set(["receivable", "payable", "borrowed", "lending", "investment", "expense", "income"]);
  const rows = parseCsvObjects(csv);

  let inserted = 0;
  const errors: string[] = [];

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const kind = (r.kind ?? "").trim().toLowerCase();
    const amount = parseFloat(r.amount ?? "");
    if (!validKinds.has(kind)) { errors.push(`Row ${i + 2}: invalid kind "${r.kind}"`); continue; }
    if (!r.title?.trim()) { errors.push(`Row ${i + 2}: missing title`); continue; }
    if (!amount || amount <= 0) { errors.push(`Row ${i + 2}: invalid amount "${r.amount}"`); continue; }
    // BUG FIX: `r.interestRate?.trim() ? parseFloat(r.interestRate) : null`
    // stored whatever parseFloat returned even when the cell was garbage
    // (e.g. "N/A", "12%") — parseFloat("N/A") is NaN, and NaN silently
    // written to a numeric column poisons every SUM()/aggregate that later
    // touches it (interestOwed on the summary, per-project interest in
    // /finance/investments, etc. all come back NaN for the whole result
    // set, not just this row). Validate it parses to a real number first
    // and reject the row otherwise, same as the amount check above.
    let interestRate: number | null = null;
    if (r.interestRate?.trim()) {
      const parsedRate = parseFloat(r.interestRate);
      if (!Number.isFinite(parsedRate)) { errors.push(`Row ${i + 2}: invalid interestRate "${r.interestRate}"`); continue; }
      interestRate = parsedRate;
    }

    const [entry] = await db.insert(financeLedgerEntriesTable).values({
      userId: authUser.userId,
      bookId: resolvedBookId,
      kind, title: r.title.trim(),
      amount, currency: r.currency?.trim() || "BDT",
      category: r.category?.trim() || null,
      dueDate: r.dueDate?.trim() ? new Date(r.dueDate.trim()) : null,
      status: r.status?.trim() || "pending",
      interestRate,
      notes: r.notes?.trim() || null,
    }).returning();
    // Every other entry-creation path (manual create, recurring sweep,
    // amortization, late-fee accrual, wallet bridge...) auto-posts an
    // opening journal entry so Trial Balance / Balance Sheet / Income
    // Statement stay accurate — this was skipped here, so imported rows
    // were also invisible to the double-entry reports even after the
    // bookId fix above.
    if (entry) postEntryJournal(entry).catch(() => {}); // best-effort — never blocks the import
    inserted++;
  }

  res.json({ inserted, failed: errors.length, errors: errors.slice(0, 20) });
});

// ─── Analytics (charts) ───────────────────────────────────────────────────────

router.get("/finance/analytics", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const rates = await getRateMap(authUser.userId);

  const twelveMonthsAgo = new Date();
  twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 11);
  twelveMonthsAgo.setDate(1);

  const rows = await db.select({
    kind: financeLedgerEntriesTable.kind,
    amount: financeLedgerEntriesTable.amount,
    currency: financeLedgerEntriesTable.currency,
    category: financeLedgerEntriesTable.category,
    occurredDate: financeLedgerEntriesTable.occurredDate,
  }).from(financeLedgerEntriesTable)
    .where(and(eq(financeLedgerEntriesTable.userId, authUser.userId), gte(financeLedgerEntriesTable.occurredDate, twelveMonthsAgo)));

  // Monthly income vs expense (line/bar chart source)
  const monthly = new Map<string, { income: number; expense: number }>();
  for (let i = 0; i < 12; i++) {
    const d = new Date(twelveMonthsAgo);
    d.setMonth(d.getMonth() + i);
    monthly.set(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`, { income: 0, expense: 0 });
  }
  for (const r of rows) {
    if (r.kind !== "income" && r.kind !== "expense") continue;
    const key = `${r.occurredDate.getFullYear()}-${String(r.occurredDate.getMonth() + 1).padStart(2, "0")}`;
    const bucket = monthly.get(key);
    if (!bucket) continue;
    const base = toBase(r.amount, r.currency, rates);
    if (r.kind === "income") bucket.income += base; else bucket.expense += base;
  }
  const monthlyTrend = [...monthly.entries()].map(([month, v]) => ({ month, ...v, net: v.income - v.expense }));

  // Expense by category (bar/pie chart source)
  const byCategory = new Map<string, number>();
  for (const r of rows) {
    if (r.kind !== "expense") continue;
    const cat = r.category?.trim() || "Uncategorized";
    byCategory.set(cat, (byCategory.get(cat) ?? 0) + toBase(r.amount, r.currency, rates));
  }
  const expenseByCategory = [...byCategory.entries()].map(([category, value]) => ({ category, value })).sort((a, b) => b.value - a.value);

  // Asset allocation (pie chart source) — my share, by asset type
  const assets = await db.select().from(financeAssetsTable).where(eq(financeAssetsTable.userId, authUser.userId));
  const assetIds = assets.map(a => a.id);
  const owners = assetIds.length
    ? await db.select().from(financeAssetOwnersTable).where(sql`${financeAssetOwnersTable.assetId} IN (${sql.join(assetIds.map(id => sql`${id}`), sql`, `)})`)
    : [];
  const byType = new Map<string, number>();
  for (const a of assets) {
    const mine = owners.filter(o => o.assetId === a.id && o.partyId == null);
    const pct = mine.length ? mine.reduce((s, o) => s + o.ownershipPercent, 0) : 100;
    byType.set(a.assetType, (byType.get(a.assetType) ?? 0) + a.totalValue * (pct / 100));
  }
  const assetAllocation = [...byType.entries()].map(([assetType, value]) => ({ assetType, value }));

  // Per-project PnL (bar chart source) — reuse the /finance/investments logic inline.
  // Grouped by projectId AND kind AND currency, then converted to base
  // currency before summing — same fix as monthlyTrend/expenseByCategory
  // above; a project with both USD and BDT expense/income entries would
  // otherwise have its raw amounts added together as if the same unit.
  const projRows = await db.select({
    projectId: financeLedgerEntriesTable.projectId,
    kind: financeLedgerEntriesTable.kind,
    currency: financeLedgerEntriesTable.currency,
    total: sql<number>`COALESCE(SUM(${financeLedgerEntriesTable.amount}), 0)`,
  }).from(financeLedgerEntriesTable)
    .where(and(eq(financeLedgerEntriesTable.userId, authUser.userId), isNotNull(financeLedgerEntriesTable.projectId), sql`${financeLedgerEntriesTable.kind} IN ('expense', 'income')`))
    .groupBy(financeLedgerEntriesTable.projectId, financeLedgerEntriesTable.kind, financeLedgerEntriesTable.currency);
  const projectIds = [...new Set(projRows.map(r => r.projectId).filter((x): x is number => x != null))];
  const projects = projectIds.length
    ? await db.select({ id: projectsTable.id, name: projectsTable.name }).from(projectsTable)
        .where(sql`${projectsTable.id} IN (${sql.join(projectIds.map(id => sql`${id}`), sql`, `)})`)
    : [];
  const nameById = new Map(projects.map(p => [p.id, p.name]));
  const projectPnlMap = new Map<number, number>();
  for (const r of projRows) {
    if (r.projectId == null) continue;
    const totalBase = toBase(r.total, r.currency, rates);
    projectPnlMap.set(r.projectId, (projectPnlMap.get(r.projectId) ?? 0) + (r.kind === "income" ? totalBase : -totalBase));
  }
  const projectPnl = [...projectPnlMap.entries()].map(([projectId, pnl]) => ({ projectId, projectName: nameById.get(projectId) ?? `Project #${projectId}`, pnl }));

  res.json({ monthlyTrend, expenseByCategory, assetAllocation, projectPnl });
});

// ─── Smart Alerts & Insights ─────────────────────────────────────────────────
// One endpoint that rolls up everything the dashboard's "at a glance" widget
// needs: overdue/upcoming alerts, budget-overrun flags, a rough cashflow
// forecast (ledger due-dates + projected recurring-rule occurrences), and a
// simple 0–100 "financial health" score. All heuristic, computed on read —
// no new tables, no background job.

const DIRECTION: Record<string, 1 | -1> = {
  receivable: 1, lending: 1, income: 1, investment: 1,
  payable: -1, borrowed: -1, expense: -1,
};

// How many times a recurring rule would fire between `from` and `to`
// (inclusive), starting from its own nextRunDate/endDate — capped so a
// misconfigured daily rule with no end date can't loop forever.
function countRecurringOccurrences(
  rule: { frequency: string; intervalCount: number; nextRunDate: Date; endDate: Date | null },
  from: Date, to: Date,
): number {
  let cursor = new Date(Math.max(rule.nextRunDate.getTime(), from.getTime()));
  const hardStop = rule.endDate && rule.endDate < to ? rule.endDate : to;
  let count = 0;
  for (let i = 0; i < 500 && cursor <= hardStop; i++) {
    count++;
    const next = new Date(cursor);
    const n = Math.max(1, rule.intervalCount || 1);
    if (rule.frequency === "daily") next.setDate(next.getDate() + n);
    else if (rule.frequency === "weekly") next.setDate(next.getDate() + n * 7);
    else if (rule.frequency === "yearly") next.setFullYear(next.getFullYear() + n);
    else next.setMonth(next.getMonth() + n); // monthly (default)
    cursor = next;
  }
  return count;
}

router.get("/finance/insights", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const rates = await getRateMap(authUser.userId);
  const now = new Date();

  const openEntries = await db.select().from(financeLedgerEntriesTable)
    .where(and(eq(financeLedgerEntriesTable.userId, authUser.userId), sql`${financeLedgerEntriesTable.status} NOT IN ('paid', 'closed')`));

  const alerts: Array<{ severity: "critical" | "warning" | "info"; title: string; detail: string; link?: string }> = [];

  // Overdue (dueDate in the past, still open).
  const overdue = openEntries.filter(e => e.dueDate && e.dueDate < now);
  if (overdue.length) {
    const total = overdue.reduce((s, e) => s + toBase(e.amount, e.currency, rates), 0);
    alerts.push({
      severity: "critical",
      title: `${overdue.length} overdue ${overdue.length === 1 ? "entry" : "entries"}`,
      detail: `Totaling ~${fmtBase(total)} past their due date — collect or settle these first.`,
      link: "/finance/ledger",
    });
  }

  // Due soon (next 7 days).
  const in7 = new Date(now.getTime() + 7 * 86400000);
  const dueSoon = openEntries.filter(e => e.dueDate && e.dueDate >= now && e.dueDate <= in7);
  if (dueSoon.length) {
    const total = dueSoon.reduce((s, e) => s + toBase(e.amount, e.currency, rates), 0);
    alerts.push({
      severity: "warning",
      title: `${dueSoon.length} due within 7 days`,
      detail: `~${fmtBase(total)} coming due this week.`,
      link: "/finance/ledger",
    });
  }

  // Budget overruns / near-limit (this calendar month).
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const budgets = await db.select().from(financeBudgetsTable).where(eq(financeBudgetsTable.userId, authUser.userId));
  // Grouped by category AND currency, then converted to the user's base
  // currency before summing — monthlyLimit is always in base currency, so a
  // raw cross-currency SUM would silently misreport "spent" and could flag
  // (or fail to flag) a budget as over its limit incorrectly. Same fix as
  // GET /finance/budgets above.
  const spentRows = await db.select({
    category: financeLedgerEntriesTable.category,
    currency: financeLedgerEntriesTable.currency,
    spent: sql<number>`COALESCE(SUM(${financeLedgerEntriesTable.amount}), 0)`,
  }).from(financeLedgerEntriesTable)
    .where(and(eq(financeLedgerEntriesTable.userId, authUser.userId), eq(financeLedgerEntriesTable.kind, "expense"), gte(financeLedgerEntriesTable.occurredDate, monthStart)))
    .groupBy(financeLedgerEntriesTable.category, financeLedgerEntriesTable.currency);
  const spentByCategory = new Map<string, number>();
  for (const r of spentRows) {
    const key = r.category ?? "Uncategorized";
    spentByCategory.set(key, (spentByCategory.get(key) ?? 0) + toBase(r.spent, r.currency, rates));
  }

  let overBudgetCount = 0, nearBudgetCount = 0;
  const budgetStatus = budgets.map(b => {
    const spent = spentByCategory.get(b.category) ?? 0;
    const pct = b.monthlyLimit > 0 ? (spent / b.monthlyLimit) * 100 : 0;
    if (pct >= 100) overBudgetCount++;
    else if (pct >= 80) nearBudgetCount++;
    return { category: b.category, spent, monthlyLimit: b.monthlyLimit, pct: Math.round(pct) };
  }).sort((a, b) => b.pct - a.pct);

  if (overBudgetCount) {
    alerts.push({
      severity: "critical",
      title: `${overBudgetCount} budget${overBudgetCount === 1 ? "" : "s"} over limit`,
      detail: "This month's spend has crossed the cap you set for that category.",
      link: "/finance/budgets",
    });
  }
  if (nearBudgetCount) {
    alerts.push({
      severity: "warning",
      title: `${nearBudgetCount} budget${nearBudgetCount === 1 ? "" : "s"} near the limit`,
      detail: "80%+ of this month's cap used already.",
      link: "/finance/budgets",
    });
  }

  // Interest owed but not yet collected/paid (info-level nudge).
  // BUG FIX: this summed each entry's interest raw, without toBase() — every
  // other total in this endpoint (overdue, dueSoon, spentByCategory,
  // cashflowForecast, totalReceivableLike/totalPayableLike below) converts
  // to the user's base currency first. A USD borrowed/investment entry's
  // interest was being added straight into what's displayed as a BDT
  // figure, so the "Unsettled interest" alert could wildly over/understate
  // the real amount for any user with mixed-currency entries.
  // BUG FIX: same missing-'lending' gap as GET /finance/summary above — a
  // 'lending' entry with an interestRate set (money lent out at interest)
  // was excluded from this alert's calc entirely, even though it accrues
  // interest owed to the user exactly like 'borrowed'/'investment' do.
  const interestOwedRows = openEntries.filter(e => e.interestRate != null && (e.kind === "borrowed" || e.kind === "lending" || e.kind === "investment"));
  const interestOwed = interestOwedRows.reduce((s, e) => s + Math.max(0, toBase(((e.interestRate ?? 0) / 100) * e.amount - e.interestPaid, e.currency, rates)), 0);
  if (interestOwed > 0) {
    alerts.push({
      severity: "info",
      title: "Unsettled interest",
      detail: `~${fmtBase(interestOwed)} of accrued interest hasn't been recorded as paid yet.`,
      link: "/finance/interest",
    });
  }

  if (!alerts.length) {
    alerts.push({ severity: "info", title: "All clear", detail: "No overdue items, budget overruns, or dues in the next 7 days." });
  }

  // Cashflow forecast — current asset value (my share) + net of open ledger
  // dues + net of projected recurring-rule occurrences, per horizon.
  const assets = await db.select().from(financeAssetsTable).where(eq(financeAssetsTable.userId, authUser.userId));
  const assetIds = assets.map(a => a.id);
  const owners = assetIds.length
    ? await db.select().from(financeAssetOwnersTable).where(sql`${financeAssetOwnersTable.assetId} IN (${sql.join(assetIds.map(id => sql`${id}`), sql`, `)})`)
    : [];
  let currentBalance = 0;
  for (const a of assets) {
    const mine = owners.filter(o => o.assetId === a.id && o.partyId == null);
    const pct = mine.length ? mine.reduce((s, o) => s + o.ownershipPercent, 0) : 100;
    // financeAssetsTable has no currency column (assets are tracked in the
    // base currency already — same assumption routes/summary + /projections
    // make), so no toBase() conversion needed here.
    currentBalance += a.totalValue * (pct / 100);
  }

  const recurringRules = await db.select().from(financeRecurringRulesTable)
    .where(and(eq(financeRecurringRulesTable.userId, authUser.userId), eq(financeRecurringRulesTable.active, 1)));

  const cashflowForecast = [30, 60, 90].map(days => {
    const horizon = new Date(now.getTime() + days * 86400000);

    const ledgerNet = openEntries
      .filter(e => e.dueDate && e.dueDate >= now && e.dueDate <= horizon)
      .reduce((s, e) => s + (DIRECTION[e.kind] ?? 0) * toBase(e.amount, e.currency, rates), 0);

    const recurringNet = recurringRules.reduce((s, r) => {
      const occurrences = countRecurringOccurrences(r, now, horizon);
      return s + occurrences * (DIRECTION[r.kind] ?? 0) * toBase(r.amount, r.currency, rates);
    }, 0);

    return {
      days,
      netChange: ledgerNet + recurringNet,
      projectedBalance: currentBalance + ledgerNet + recurringNet,
    };
  });

  // Financial health score — simple, explainable, 0–100.
  let score = 100;
  score -= Math.min(32, overdue.length * 8);
  score -= Math.min(30, overBudgetCount * 10);
  score -= Math.min(12, nearBudgetCount * 4);
  const totalReceivableLike = openEntries.filter(e => e.kind === "receivable" || e.kind === "lending").reduce((s, e) => s + toBase(e.amount, e.currency, rates), 0);
  const totalPayableLike = openEntries.filter(e => e.kind === "payable" || e.kind === "borrowed").reduce((s, e) => s + toBase(e.amount, e.currency, rates), 0);
  const netWorth = currentBalance + totalReceivableLike - totalPayableLike;
  if (netWorth < 0) score -= 15;
  score = Math.max(0, Math.min(100, Math.round(score)));
  const healthLabel = score >= 80 ? "Healthy" : score >= 60 ? "Stable" : score >= 40 ? "Needs Attention" : "At Risk";

  function fmtBase(n: number) { return `${Math.round(n).toLocaleString()} BDT`; }

  res.json({ healthScore: score, healthLabel, alerts, budgetStatus, cashflowForecast });
});

// ─── Accounting: Chart of Accounts / Journal / Reports / Amortization ───────
// See lib/finance-accounting.ts for the seeding + posting engine. Finance
// entries and repayments above already auto-post into this layer; everything
// below is the direct CRUD/reporting surface the Accounting UI talks to.

function fmtAccount(a: typeof financeAccountsTable.$inferSelect) {
  return { ...a, createdAt: iso(a.createdAt), updatedAt: iso(a.updatedAt) };
}
function fmtJournalEntry(je: typeof financeJournalEntriesTable.$inferSelect, lines: (typeof financeJournalLinesTable.$inferSelect)[]) {
  return { ...je, date: iso(je.date), createdAt: iso(je.createdAt), lines };
}

router.get("/finance/accounts", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const { bookId } = req.query as Record<string, string>;
  const resolvedBookId = await resolveBookId(authUser.userId, bookId ? parseInt(bookId, 10) : undefined);
  await ensureSystemAccounts(authUser.userId, resolvedBookId);
  const rows = await db.select().from(financeAccountsTable)
    .where(and(eq(financeAccountsTable.userId, authUser.userId), eq(financeAccountsTable.bookId, resolvedBookId)))
    .orderBy(financeAccountsTable.code);
  res.json(rows.map(fmtAccount));
});

router.post("/finance/accounts", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const { code, name, type, normalBalance, parentId, bookId } = req.body as { code?: string; name?: string; type?: string; normalBalance?: string; parentId?: number; bookId?: number };
  if (!code?.trim() || !name?.trim() || !type) { res.status(400).json({ error: "code, name and type are required" }); return; }
  const resolvedBookId = await resolveBookId(authUser.userId, bookId);
  try {
    const [row] = await db.insert(financeAccountsTable).values({
      userId: authUser.userId, bookId: resolvedBookId, code: code.trim(), name: name.trim(), type,
      normalBalance: normalBalance === "credit" ? "credit" : "debit",
      parentId: parentId ?? null, isSystem: 0,
    }).returning();
    res.status(201).json(fmtAccount(row));
  } catch (e: any) {
    res.status(400).json({ error: "Account code already exists" });
  }
});

router.put("/finance/accounts/:id", requireAuth, requireFinanceAccountOwnership("finance.account.update", financeNotFoundDeny("Not found or is a system account")), async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const id = parseInt(paramString(req.params.id), 10);
  const b = req.body as Record<string, any>;
  const update: Record<string, any> = { updatedAt: new Date() };
  for (const k of ["name", "type", "normalBalance", "parentId"]) {
    if (b[k] !== undefined) update[k] = b[k];
  }
  const [row] = await db.update(financeAccountsTable)
    .set(update)
    .where(and(eq(financeAccountsTable.id, id), eq(financeAccountsTable.userId, authUser.userId), eq(financeAccountsTable.isSystem, 0)))
    .returning();
  if (!row) { res.status(404).json({ error: "Not found or is a system account" }); return; }
  res.json(fmtAccount(row));
});

router.delete("/finance/accounts/:id", requireAuth, requireFinanceAccountOwnership("finance.account.delete", financeNotFoundDeny("Not found")), async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const id = parseInt(paramString(req.params.id), 10);
  const [account] = await db.select().from(financeAccountsTable)
    .where(and(eq(financeAccountsTable.id, id), eq(financeAccountsTable.userId, authUser.userId)));
  if (!account) { res.status(404).json({ error: "Not found" }); return; }
  if (account.isSystem) { res.status(400).json({ error: "System accounts can't be deleted" }); return; }
  const [{ count }] = await db.select({ count: sql<number>`COUNT(*)` }).from(financeJournalLinesTable).where(eq(financeJournalLinesTable.accountId, id));
  if (Number(count) > 0) { res.status(400).json({ error: "Account has journal activity and can't be deleted" }); return; }
  await db.delete(financeAccountsTable).where(eq(financeAccountsTable.id, id));
  res.json({ success: true });
});

// ─── Journal ─────────────────────────────────────────────────────────────────

router.get("/finance/journal", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const { accountId, bookId } = req.query as Record<string, string>;
  const resolvedBookId = await resolveBookId(authUser.userId, bookId ? parseInt(bookId, 10) : undefined);

  const entries = await db.select().from(financeJournalEntriesTable)
    .where(and(eq(financeJournalEntriesTable.userId, authUser.userId), eq(financeJournalEntriesTable.bookId, resolvedBookId)))
    .orderBy(desc(financeJournalEntriesTable.date));
  const entryIds = entries.map(e => e.id);
  const lines = entryIds.length > 0
    ? await db.select().from(financeJournalLinesTable).where(inArray(financeJournalLinesTable.journalEntryId, entryIds))
    : [];
  const linesByEntry = new Map<number, (typeof financeJournalLinesTable.$inferSelect)[]>();
  for (const l of lines) {
    if (!linesByEntry.has(l.journalEntryId)) linesByEntry.set(l.journalEntryId, []);
    linesByEntry.get(l.journalEntryId)!.push(l);
  }

  let result = entries.map(e => fmtJournalEntry(e, linesByEntry.get(e.id) ?? []));
  if (accountId) {
    const accId = parseInt(accountId, 10);
    result = result.filter(je => je.lines.some(l => l.accountId === accId));
  }
  res.json(result);
});

router.get("/finance/journal/:id", requireAuth, requireFinanceJournalEntryOwnership("finance.journal_entry.read"), async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const id = parseInt(paramString(req.params.id), 10);
  const [je] = await db.select().from(financeJournalEntriesTable)
    .where(and(eq(financeJournalEntriesTable.id, id), eq(financeJournalEntriesTable.userId, authUser.userId)));
  if (!je) { res.status(404).json({ error: "Not found" }); return; }
  const lines = await db.select().from(financeJournalLinesTable).where(eq(financeJournalLinesTable.journalEntryId, id));
  res.json(fmtJournalEntry(je, lines));
});

router.post("/finance/journal", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const { memo, date, lines, bookId } = req.body as { memo?: string; date?: string; lines?: { accountId: number; debit: number; credit: number }[]; bookId?: number };
  if (!memo?.trim() || !Array.isArray(lines) || lines.length < 2) { res.status(400).json({ error: "memo and at least 2 lines are required" }); return; }
  const resolvedBookId = await resolveBookId(authUser.userId, bookId);

  const accounts = await db.select().from(financeAccountsTable)
    .where(and(eq(financeAccountsTable.userId, authUser.userId), eq(financeAccountsTable.bookId, resolvedBookId)));
  const accountsById = new Map(accounts.map(a => [a.id, a]));
  const cleanLines = lines
    .filter(l => accountsById.has(l.accountId) && ((l.debit || 0) > 0 || (l.credit || 0) > 0))
    .map(l => ({ accountCode: accountsById.get(l.accountId)!.code, debit: Number(l.debit) || 0, credit: Number(l.credit) || 0 }));
  if (cleanLines.length < 2) { res.status(400).json({ error: "At least 2 valid lines are required" }); return; }
  const totalDebit = cleanLines.reduce((s, l) => s + l.debit, 0);
  const totalCredit = cleanLines.reduce((s, l) => s + l.credit, 0);
  if (Math.abs(totalDebit - totalCredit) > 0.01) { res.status(400).json({ error: "Debit and credit must balance" }); return; }

  const je = await postJournal(authUser.userId, {
    memo: memo.trim(), date: date ? new Date(date) : new Date(), lines: cleanLines, isManual: true, bookId: resolvedBookId,
  });
  if (!je) { res.status(400).json({ error: "Failed to post entry" }); return; }
  const savedLines = await db.select().from(financeJournalLinesTable).where(eq(financeJournalLinesTable.journalEntryId, je.id));
  res.status(201).json(fmtJournalEntry(je, savedLines));
});

router.delete("/finance/journal/:id", requireAuth, requireFinanceJournalEntryOwnership("finance.journal_entry.delete"), async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const id = parseInt(paramString(req.params.id), 10);
  const [je] = await db.select().from(financeJournalEntriesTable)
    .where(and(eq(financeJournalEntriesTable.id, id), eq(financeJournalEntriesTable.userId, authUser.userId)));
  if (!je) { res.status(404).json({ error: "Not found" }); return; }
  if (!je.isManual) { res.status(400).json({ error: "Only manual entries can be deleted" }); return; }
  await db.delete(financeJournalLinesTable).where(eq(financeJournalLinesTable.journalEntryId, id));
  await db.delete(financeJournalEntriesTable).where(eq(financeJournalEntriesTable.id, id));
  res.json({ success: true });
});

// ─── Reports ─────────────────────────────────────────────────────────────────

router.get("/finance/reports/trial-balance", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const { asOf, bookId } = req.query as Record<string, string>;
  const rows = await computeAccountBalances(authUser.userId, { to: asOf ? new Date(asOf) : undefined, bookId: bookId ? parseInt(bookId, 10) : undefined });
  res.json(rows);
});

router.get("/finance/reports/balance-sheet", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const { asOf, bookId } = req.query as Record<string, string>;
  const to = asOf ? new Date(asOf) : undefined;
  const rows = await computeAccountBalances(authUser.userId, { to, bookId: bookId ? parseInt(bookId, 10) : undefined });

  const assets = rows.filter(r => r.type === "asset");
  const liabilities = rows.filter(r => r.type === "liability");
  const equity = rows.filter(r => r.type === "equity");
  const income = rows.filter(r => r.type === "income");
  const expense = rows.filter(r => r.type === "expense");
  const netIncome = income.reduce((s, r) => s + r.balance, 0) - expense.reduce((s, r) => s + r.balance, 0);

  const equityRows = netIncome !== 0
    ? [...equity, { accountId: -1, code: "3900", name: "Current Earnings", type: "equity" as const, totalDebit: 0, totalCredit: 0, balance: netIncome }]
    : equity;

  const totalAssets = assets.reduce((s, r) => s + r.balance, 0);
  const totalLiabilities = liabilities.reduce((s, r) => s + r.balance, 0);
  const totalEquity = equityRows.reduce((s, r) => s + r.balance, 0);

  res.json({
    assets, liabilities, equity: equityRows,
    totalAssets, totalLiabilities, totalEquity,
    balanced: Math.abs(totalAssets - (totalLiabilities + totalEquity)) < 0.01,
  });
});

router.get("/finance/reports/income-statement", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const { from, to, bookId } = req.query as Record<string, string>;
  const resolvedBookId = bookId ? parseInt(bookId, 10) : undefined;
  const rows = await computeAccountBalances(authUser.userId, { from: from ? new Date(from) : undefined, to: to ? new Date(to) : undefined, bookId: resolvedBookId });

  const income = rows.filter(r => r.type === "income");
  const expense = rows.filter(r => r.type === "expense");
  const totalIncome = income.reduce((s, r) => s + r.balance, 0);
  const totalExpense = expense.reduce((s, r) => s + r.balance, 0);

  res.json({ income, expense, totalIncome, totalExpense, netIncome: totalIncome - totalExpense });
});

router.get("/finance/reports/cash-flow", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const { from, to, bookId } = req.query as Record<string, string>;
  const resolvedBookId = bookId ? parseInt(bookId, 10) : undefined;
  const fromDate = from ? new Date(from) : undefined;
  const toDate = to ? new Date(to) : undefined;

  // Indirect method: start from net income (period activity), add back non-cash
  // expenses, then walk balance-sheet accounts by code range —
  // 1100/2000 = operating (AR/AP), 1200/1300 = investing, 2100/3000 = financing.
  // Because a balanced-journal account's period debit/credit net equals its
  // change in balance over that period, computeAccountBalances(from,to) can
  // be read directly as "the change during the period" for every account.
  const rows = await computeAccountBalances(authUser.userId, { from: fromDate, to: toDate, bookId: resolvedBookId });
  const byCode = new Map(rows.map(r => [r.code, r]));
  const changeOf = (code: string) => byCode.get(code)?.balance ?? 0;

  const income = rows.filter(r => r.type === "income");
  const expense = rows.filter(r => r.type === "expense");
  const netIncome = income.reduce((s, r) => s + r.balance, 0) - expense.reduce((s, r) => s + r.balance, 0);
  const depreciationAddback = changeOf("5200"); // non-cash expense, add back

  const operatingActivities = [
    { label: "Net Income", amount: netIncome },
    { label: "Depreciation & Amortization", amount: depreciationAddback },
    { label: "Change in Accounts Receivable", amount: -changeOf("1100") },
    // Regular business payables (code 2000) belong in Operating, alongside
    // AR — same as any standard indirect-method cash flow statement. Only
    // actual borrowed-funds/loan-payable movement (2100) is a Financing
    // activity; conflating the two here previously overstated/understated
    // Net Operating vs Net Financing even though the total netChangeInCash
    // still balanced (so it never tripped the `reconciled` check).
    { label: "Change in Accounts Payable", amount: changeOf("2000") },
  ];
  const netOperating = operatingActivities.reduce((s, r) => s + r.amount, 0);

  const investingActivities = [
    { label: "Change in Loans Receivable (Lending)", amount: -changeOf("1200") },
    { label: "Change in Investments", amount: -changeOf("1300") },
  ];
  const netInvesting = investingActivities.reduce((s, r) => s + r.amount, 0);

  const financingActivities = [
    { label: "Change in Loans Payable (Borrowed Funds)", amount: changeOf("2100") },
    { label: "Change in Owner's Equity", amount: changeOf("3000") },
  ];
  const netFinancing = financingActivities.reduce((s, r) => s + r.amount, 0);

  const netChangeInCash = netOperating + netInvesting + netFinancing;

  const [beginningRows, endingRows] = await Promise.all([
    fromDate ? computeAccountBalances(authUser.userId, { to: fromDate, bookId: resolvedBookId }) : Promise.resolve([]),
    computeAccountBalances(authUser.userId, { to: toDate, bookId: resolvedBookId }),
  ]);
  const beginningCash = beginningRows.find(r => r.code === "1000")?.balance ?? 0;
  const endingCash = endingRows.find(r => r.code === "1000")?.balance ?? 0;

  res.json({
    from: fromDate ? fromDate.toISOString() : null,
    to: toDate ? toDate.toISOString() : new Date().toISOString(),
    operatingActivities, netOperating,
    investingActivities, netInvesting,
    financingActivities, netFinancing,
    netChangeInCash,
    beginningCash, endingCash,
    reconciled: Math.abs((endingCash - beginningCash) - netChangeInCash) < 0.01,
  });
});

// ─── Custom report builder (Phase 4 — Advanced reporting) ──────────────────
// A pivot over the ledger-entry tracker (not the double-entry Journal —
// that's what trial-balance/balance-sheet/income-statement already cover):
// pick a groupBy dimension, optional filters, get grouped totals back, in
// the user's base currency (see getRateMap/toBase above) so entries in
// different original currencies still roll up into one comparable number —
// this doubles as the "multi-currency consolidated reporting" item.
// Supports format=json (default) | csv | pdf.
const REPORT_GROUP_BY = ["kind", "category", "party", "month", "status", "currency"] as const;
type ReportGroupBy = typeof REPORT_GROUP_BY[number];

router.get("/finance/reports/custom", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const q = req.query as Record<string, string>;
  const groupBy = (REPORT_GROUP_BY as readonly string[]).includes(q.groupBy) ? (q.groupBy as ReportGroupBy) : "kind";
  const format = q.format === "csv" || q.format === "pdf" ? q.format : "json";

  // PHASE 5: metered action ryft.report_export. Only the actual export
  // formats (CSV/PDF) are metered — viewing the report as JSON in the app
  // is the "basic ledger" functionality §5 keeps free. Checked here, before
  // any work is done, so a user who can't afford it gets a 402 instead of a
  // built-then-discarded report.
  if (format !== "json") {
    const balanceCheck = await hasCreditBalance(authUser.userId, "ryft.report_export");
    if (!balanceCheck.ok) {
      res.status(402).json({
        error: "Out of credits",
        code: "OUT_OF_CREDITS",
        action: balanceCheck.action.key,
        label: balanceCheck.action.label,
        cost: balanceCheck.action.cost,
        balance: balanceCheck.balance,
        topUp: { method: "POST", url: "/api/credits/purchase" },
      });
      return;
    }
  }

  const resolvedBookId = await resolveBookId(authUser.userId, q.bookId ? parseInt(q.bookId, 10) : undefined);

  const conditions = [eq(financeLedgerEntriesTable.userId, authUser.userId), eq(financeLedgerEntriesTable.bookId, resolvedBookId)];
  if (q.from) conditions.push(gte(financeLedgerEntriesTable.occurredDate, new Date(q.from)));
  if (q.to) conditions.push(lte(financeLedgerEntriesTable.occurredDate, new Date(q.to)));
  const kinds = q.kind ? q.kind.split(",").filter(Boolean) : [];
  if (kinds.length > 0) conditions.push(inArray(financeLedgerEntriesTable.kind, kinds));
  const categories = q.category ? q.category.split(",").filter(Boolean) : [];
  if (categories.length > 0) conditions.push(inArray(financeLedgerEntriesTable.category, categories));

  const [entries, parties, rates] = await Promise.all([
    db.select().from(financeLedgerEntriesTable).where(and(...conditions)).orderBy(desc(financeLedgerEntriesTable.occurredDate)),
    db.select().from(financePartiesTable).where(eq(financePartiesTable.userId, authUser.userId)),
    getRateMap(authUser.userId),
  ]);
  const partyName = new Map(parties.map(p => [p.id, p.name]));

  const keyOf = (e: typeof financeLedgerEntriesTable.$inferSelect): string => {
    switch (groupBy) {
      case "kind": return e.kind;
      case "category": return e.category || "Uncategorized";
      case "party": return e.partyId ? (partyName.get(e.partyId) || `Party #${e.partyId}`) : "No party";
      case "month": return e.occurredDate.toISOString().slice(0, 7); // YYYY-MM
      case "status": return e.status;
      case "currency": return e.currency;
    }
  };

  const groups = new Map<string, { label: string; count: number; totalBase: number; rows: typeof entries }>();
  for (const e of entries) {
    const key = keyOf(e);
    if (!groups.has(key)) groups.set(key, { label: key, count: 0, totalBase: 0, rows: [] });
    const g = groups.get(key)!;
    g.count += 1;
    g.totalBase += toBase(e.amount, e.currency, rates);
    g.rows.push(e);
  }
  const groupRows = [...groups.values()]
    .map(g => ({ label: g.label, count: g.count, total: Math.round(g.totalBase * 100) / 100 }))
    .sort((a, b) => b.total - a.total);
  const grandTotal = Math.round(groupRows.reduce((s, g) => s + g.total, 0) * 100) / 100;

  const result = {
    groupBy, baseCurrency: "BDT", from: q.from || null, to: q.to || null,
    filters: { kind: kinds, category: categories, bookId: resolvedBookId },
    groups: groupRows, grandTotal, entryCount: entries.length,
  };

  if (format === "csv") {
    const csv = toCsv(
      groupRows.map(g => ({ [groupBy]: g.label, count: g.count, total_bdt: g.total })),
      [groupBy, "count", "total_bdt"],
    );
    // Charge-on-success: the export is actually built at this point, so the
    // user is only billed once the CSV genuinely exists — see file header
    // in services/credit-meter.ts.
    await chargeCredits(authUser.userId, "ryft.report_export");
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="finance-report-${groupBy}.csv"`);
    res.send(csv);
    return;
  }
  if (format === "pdf") {
    await chargeCredits(authUser.userId, "ryft.report_export");
    const doc = new PDFDocument({ margin: 40, size: "A4" });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="finance-report-${groupBy}.pdf"`);
    doc.pipe(res);
    renderCustomReportPdf(doc, result);
    doc.end();
    return;
  }
  res.json(result);
});

function renderCustomReportPdf(doc: PDFKit.PDFDocument, result: { groupBy: string; from: string | null; to: string | null; groups: { label: string; count: number; total: number }[]; grandTotal: number; entryCount: number }): void {
  doc.fontSize(18).text("Custom Finance Report", { align: "left" });
  doc.moveDown(0.3);
  doc.fontSize(10).fillColor("#555")
    .text(`Grouped by: ${result.groupBy}${result.from ? `  ·  From ${result.from}` : ""}${result.to ? `  ·  To ${result.to}` : ""}`);
  doc.moveDown(1);
  doc.fillColor("#000").fontSize(11);
  for (const g of result.groups) {
    doc.text(`${g.label}`, { continued: true, width: 300 });
    doc.text(`  ${g.count} entries`, { continued: true });
    doc.text(`  BDT ${g.total.toLocaleString()}`, { align: "right" });
  }
  doc.moveDown(1);
  doc.fontSize(13).text(`Grand Total: BDT ${result.grandTotal.toLocaleString()}  (${result.entryCount} entries)`);
}

// ─── Scheduled report delivery (Phase 4 — monthly P&L auto-email, formalized) ─
// The daily digest (finance-notify.ts) is a lightweight activity rollup;
// this is the "real" version — a formal PDF of an actual report (Income
// Statement / Balance Sheet / Trial Balance / Cash Flow) delivered on a
// fixed day of the month. See finance-report-schedule-cron.ts for the sweep
// that actually sends these.
router.get("/finance/report-schedules", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const rows = await db.select().from(financeReportSchedulesTable).where(eq(financeReportSchedulesTable.userId, authUser.userId));
  res.json(rows.map(r => ({ ...r, lastSentAt: iso(r.lastSentAt), createdAt: iso(r.createdAt), updatedAt: iso(r.updatedAt) })));
});

router.post("/finance/report-schedules", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const { bookId, reportType, dayOfMonth } = req.body as { bookId?: number; reportType?: string; dayOfMonth?: number };
  const validTypes = ["income_statement", "balance_sheet", "trial_balance", "cash_flow"];
  if (reportType && !validTypes.includes(reportType)) { res.status(400).json({ error: `reportType must be one of ${validTypes.join(", ")}` }); return; }
  const day = Math.min(28, Math.max(1, Number(dayOfMonth) || 1)); // capped at 28 so every month has that day
  const [row] = await db.insert(financeReportSchedulesTable).values({
    userId: authUser.userId, bookId: bookId ?? null, reportType: reportType || "income_statement",
    frequency: "monthly", dayOfMonth: day, active: 1,
  }).returning();
  res.status(201).json(row);
});

router.put("/finance/report-schedules/:id", requireAuth, requireFinanceReportScheduleOwnership("finance.report_schedule.update", financeNotFoundDeny("Not found")), async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const id = parseInt(paramString(req.params.id), 10);
  const { active, dayOfMonth } = req.body as { active?: boolean; dayOfMonth?: number };
  const update: Record<string, any> = { updatedAt: new Date() };
  if (active !== undefined) update.active = active ? 1 : 0;
  if (dayOfMonth !== undefined) update.dayOfMonth = Math.min(28, Math.max(1, Number(dayOfMonth) || 1));
  const [row] = await db.update(financeReportSchedulesTable).set(update)
    .where(and(eq(financeReportSchedulesTable.id, id), eq(financeReportSchedulesTable.userId, authUser.userId)))
    .returning();
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  res.json(row);
});

router.delete("/finance/report-schedules/:id", requireAuth, requireFinanceReportScheduleOwnership("finance.report_schedule.delete", financeSilentSuccessDeny), async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const id = parseInt(paramString(req.params.id), 10);
  await db.delete(financeReportSchedulesTable).where(and(eq(financeReportSchedulesTable.id, id), eq(financeReportSchedulesTable.userId, authUser.userId)));
  res.json({ success: true });
});

// ─── Loan Amortization ───────────────────────────────────────────────────────

router.get("/finance/entries/:id/amortization", requireAuth, requireFinanceLedgerEntryOwnership("finance.entry.amortization.read"), async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const entryId = parseInt(paramString(req.params.id), 10);
  const owned = await assertEntryOwnership(entryId, authUser.userId);
  if (!owned) { res.status(404).json({ error: "Entry not found" }); return; }
  res.json(await listAmortizationForEntry(entryId));
});

router.post("/finance/entries/:id/amortization/generate", requireAuth, requireFinanceLedgerEntryOwnership("finance.entry.amortization.generate"), async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const entryId = parseInt(paramString(req.params.id), 10);
  const { termMonths } = req.body as { termMonths?: number };
  const months = Math.floor(Number(termMonths));
  if (!months || months < 1) { res.status(400).json({ error: "termMonths must be at least 1" }); return; }

  const [entry] = await db.select().from(financeLedgerEntriesTable)
    .where(and(eq(financeLedgerEntriesTable.id, entryId), eq(financeLedgerEntriesTable.userId, authUser.userId)));
  if (!entry) { res.status(404).json({ error: "Entry not found" }); return; }
  if (entry.kind !== "borrowed" && entry.kind !== "lending") { res.status(400).json({ error: "Amortization only applies to borrowed/lending entries" }); return; }

  const rows = await generateAmortizationSchedule(entry, months);
  res.status(201).json(rows);
});

router.put("/finance/amortization/:id/pay", requireAuth, requireFinanceAmortizationOwnership("finance.amortization.pay"), async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const id = parseInt(paramString(req.params.id), 10);
  const [row] = await db.select().from(financeAmortizationTable)
    .where(and(eq(financeAmortizationTable.id, id), eq(financeAmortizationTable.userId, authUser.userId)));
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  if (row.status === "paid") { res.json({ ...row, dueDate: iso(row.dueDate), paidAt: iso(row.paidAt), createdAt: iso(row.createdAt) }); return; }

  const [entry] = await db.select().from(financeLedgerEntriesTable)
    .where(and(eq(financeLedgerEntriesTable.id, row.ledgerEntryId), eq(financeLedgerEntriesTable.userId, authUser.userId)));
  if (!entry) { res.status(404).json({ error: "Entry not found" }); return; }

  const [updated] = await db.update(financeAmortizationTable)
    .set({ status: "paid", paidAt: new Date() })
    .where(eq(financeAmortizationTable.id, id))
    .returning();

  // Record the underlying repayment(s) so the Finance entry's status/interestPaid
  // and the double-entry journal stay in sync with this installment.
  if (row.principalDue > 0) {
    await db.insert(financeRepaymentsTable).values({ entryId: entry.id, amount: row.principalDue, isInterest: 0, notes: `Amortization #${row.installmentNo}` });
    // Mirror POST /finance/entries/:id/repayments: reduce the entry's
    // outstanding `amount` by the principal just paid — not just flip a
    // status label — so the late-fee cron (lib/finance-late-fee-cron.ts,
    // which reads `amount` as "still outstanding") stops accruing fees on
    // the original full principal once a loan is being paid down through
    // its amortization schedule.
    //
    // BUG FIX: this used to read `entry.amount` (fetched once at the top
    // of the handler) and write back `entry.amount - row.principalDue`
    // computed in JS — the same non-atomic race already fixed in
    // POST /finance/entries/:id/repayments and the payment-agreement
    // verify route. Paying two installments on the same loan back-to-back
    // (or an installment pay racing a manual repayment on the same entry)
    // could have one decrement silently overwrite the other's effect on
    // the outstanding balance. Do the subtraction atomically in SQL instead.
    const [updatedEntry] = await db.update(financeLedgerEntriesTable)
      .set({ amount: sql`GREATEST(0, ${financeLedgerEntriesTable.amount} - ${row.principalDue})`, updatedAt: new Date() })
      .where(eq(financeLedgerEntriesTable.id, entry.id))
      .returning({ amount: financeLedgerEntriesTable.amount });
    const newStatus = (updatedEntry?.amount ?? 0) <= 0.01 ? "paid" : "partial";
    await db.update(financeLedgerEntriesTable).set({ status: newStatus }).where(eq(financeLedgerEntriesTable.id, entry.id));
    await postRepaymentJournal(entry, row.principalDue, false).catch(() => {});
  }
  if (row.interestDue > 0) {
    await db.insert(financeRepaymentsTable).values({ entryId: entry.id, amount: row.interestDue, isInterest: 1, notes: `Amortization #${row.installmentNo}` });
    await db.update(financeLedgerEntriesTable)
      .set({ interestPaid: sql`${financeLedgerEntriesTable.interestPaid} + ${row.interestDue}`, updatedAt: new Date() })
      .where(eq(financeLedgerEntriesTable.id, entry.id));
    await postRepaymentJournal(entry, row.interestDue, true).catch(() => {});
  }

  res.json({ ...updated, dueDate: iso(updated.dueDate), paidAt: iso(updated.paidAt), createdAt: iso(updated.createdAt) });
});

// ─── Depreciation (fixed assets) ─────────────────────────────────────────────

router.get("/finance/assets/:id/depreciation", requireAuth, requireFinanceAssetOwnership("finance.asset.depreciation.read", financeNotFoundDeny("Asset not found")), async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const assetId = parseInt(paramString(req.params.id), 10);
  const [asset] = await db.select().from(financeAssetsTable)
    .where(and(eq(financeAssetsTable.id, assetId), eq(financeAssetsTable.userId, authUser.userId)));
  if (!asset) { res.status(404).json({ error: "Asset not found" }); return; }
  res.json(await listDepreciationForAsset(assetId));
});

router.post("/finance/assets/:id/depreciation/generate", requireAuth, requireFinanceAssetOwnership("finance.asset.depreciation.generate", financeNotFoundDeny("Asset not found")), async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const assetId = parseInt(paramString(req.params.id), 10);
  const { method, usefulLifeMonths, salvageValue, startDate } = req.body as {
    method?: "straight_line" | "declining_balance"; usefulLifeMonths?: number; salvageValue?: number; startDate?: string;
  };
  if (method !== "straight_line" && method !== "declining_balance") { res.status(400).json({ error: "method must be straight_line or declining_balance" }); return; }
  const months = Math.floor(Number(usefulLifeMonths));
  if (!months || months < 1) { res.status(400).json({ error: "usefulLifeMonths must be at least 1" }); return; }

  const [asset] = await db.select().from(financeAssetsTable)
    .where(and(eq(financeAssetsTable.id, assetId), eq(financeAssetsTable.userId, authUser.userId)));
  if (!asset) { res.status(404).json({ error: "Asset not found" }); return; }

  const [updatedAsset] = await db.update(financeAssetsTable)
    .set({
      depreciationMethod: method,
      usefulLifeMonths: months,
      salvageValue: salvageValue ?? 0,
      depreciationStartDate: startDate ? new Date(startDate) : (asset.purchaseDate ?? new Date()),
      updatedAt: new Date(),
    })
    .where(eq(financeAssetsTable.id, assetId))
    .returning();

  const rows = await generateDepreciationSchedule(updatedAsset);
  res.status(201).json(rows);
});

router.put("/finance/depreciation/:id/post", requireAuth, requireFinanceDepreciationOwnership("finance.depreciation.post"), async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const id = parseInt(paramString(req.params.id), 10);
  const [row] = await db.select().from(financeDepreciationTable)
    .where(and(eq(financeDepreciationTable.id, id), eq(financeDepreciationTable.userId, authUser.userId)));
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  if (row.status === "posted") { res.json({ ...row, periodDate: iso(row.periodDate), postedAt: iso(row.postedAt), createdAt: iso(row.createdAt) }); return; }

  const [asset] = await db.select().from(financeAssetsTable)
    .where(and(eq(financeAssetsTable.id, row.assetId), eq(financeAssetsTable.userId, authUser.userId)));
  if (!asset) { res.status(404).json({ error: "Asset not found" }); return; }

  const [updated] = await db.update(financeDepreciationTable)
    .set({ status: "posted", postedAt: new Date() })
    .where(eq(financeDepreciationTable.id, id))
    .returning();

  await postDepreciationJournal(authUser.userId, asset.name, row.periodDate, row.depreciationAmount).catch(() => {});
  // Keep the asset's headline totalValue in step with its book value as periods post.
  await db.update(financeAssetsTable).set({ totalValue: row.bookValue, updatedAt: new Date() }).where(eq(financeAssetsTable.id, asset.id));

  res.json({ ...updated, periodDate: iso(updated.periodDate), postedAt: iso(updated.postedAt), createdAt: iso(updated.createdAt) });
});

// ─── Invoicing (line items on top of a 'receivable' entry) ──────────────────

async function recomputeInvoiceTotal(entryId: number): Promise<void> {
  const lines = await db.select().from(financeInvoiceLinesTable).where(eq(financeInvoiceLinesTable.entryId, entryId));
  const total = lines.reduce((sum, l) => sum + l.quantity * l.unitPrice * (1 + l.taxPercent / 100), 0);
  await db.update(financeLedgerEntriesTable).set({ amount: total, updatedAt: new Date() }).where(eq(financeLedgerEntriesTable.id, entryId));
}

router.get("/finance/entries/:id/invoice-lines", requireAuth, requireFinanceLedgerEntryOwnership("finance.entry.invoice_lines.read"), async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const entryId = parseInt(paramString(req.params.id), 10);
  const owned = await assertEntryOwnership(entryId, authUser.userId);
  if (!owned) { res.status(404).json({ error: "Entry not found" }); return; }
  const lines = await db.select().from(financeInvoiceLinesTable)
    .where(eq(financeInvoiceLinesTable.entryId, entryId))
    .orderBy(financeInvoiceLinesTable.sortOrder);
  res.json(lines.map(l => ({ ...l, createdAt: iso(l.createdAt) })));
});

// PUT replaces the full line set — simplest correct model for an invoice
// editor (add/remove/reorder lines, save once). Recomputes entry.amount and
// posts a journal adjustment for the delta (the opening journal was already
// auto-posted at creation, since this only ever applies to receivables) so
// Trial Balance / Balance Sheet stay correct after an invoice edit, without
// disturbing any repayment/interest journal entries already recorded.
router.put("/finance/entries/:id/invoice-lines", requireAuth, requireFinanceLedgerEntryOwnership("finance.entry.invoice_lines.update"), async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const entryId = parseInt(paramString(req.params.id), 10);
  const [entry] = await db.select().from(financeLedgerEntriesTable)
    .where(and(eq(financeLedgerEntriesTable.id, entryId), eq(financeLedgerEntriesTable.userId, authUser.userId)));
  if (!entry) { res.status(404).json({ error: "Entry not found" }); return; }
  if (entry.kind !== "receivable") { res.status(400).json({ error: "Invoice lines only apply to receivable entries" }); return; }

  const { lines } = req.body as { lines?: { description: string; quantity?: number; unitPrice?: number; taxPercent?: number }[] };
  if (!Array.isArray(lines) || lines.length === 0) { res.status(400).json({ error: "At least one line item is required" }); return; }

  await db.delete(financeInvoiceLinesTable).where(eq(financeInvoiceLinesTable.entryId, entryId));
  await db.insert(financeInvoiceLinesTable).values(
    lines.map((l, i) => ({
      entryId, description: l.description, quantity: l.quantity ?? 1,
      unitPrice: l.unitPrice ?? 0, taxPercent: l.taxPercent ?? 0, sortOrder: i,
    })),
  );
  await recomputeInvoiceTotal(entryId);

  // Reconcile the double-entry journal to the new total by posting an
  // adjustment for just the delta — same approach PUT /finance/entries/:id
  // uses (see postEntryAdjustmentJournal's docstring). NOT a delete-and-
  // repost: deleteJournalForEntry removes every journal entry sourced from
  // this ledger entry, which would also silently wipe out any
  // repayment/interest journal entries already recorded against it if this
  // receivable had partial payments before its invoice lines were edited.
  const [refreshed] = await db.select().from(financeLedgerEntriesTable).where(eq(financeLedgerEntriesTable.id, entryId));
  if (refreshed) {
    const delta = refreshed.amount - entry.amount;
    postEntryAdjustmentJournal(refreshed, delta).catch(() => {});
  }

  const savedLines = await db.select().from(financeInvoiceLinesTable)
    .where(eq(financeInvoiceLinesTable.entryId, entryId)).orderBy(financeInvoiceLinesTable.sortOrder);
  res.json({ entry: refreshed, lines: savedLines.map(l => ({ ...l, createdAt: iso(l.createdAt) })) });
});

// ─── AI Assist (Phase 2 — Smart Entry) ───────────────────────────────────────
// All parsing/categorization/anomaly/recurring-detection logic lives in
// lib/finance-ai.ts and is deterministic/DB-driven; Groq (if configured) is
// only ever used to phrase a sentence around numbers already computed here,
// never to invent them. See finance-quick-add.tsx for the widget these feed.

router.post("/finance/ai/quick-entry/preview", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const { text, currency } = req.body as { text?: string; currency?: string };
  if (!text?.trim()) { res.status(400).json({ error: "text is required" }); return; }

  const drafts = await parseQuickEntryText(authUser.userId, text, currency || "BDT");
  const withDuplicates = await Promise.all(drafts.map(async d => ({
    ...d,
    duplicate: d.parseOk ? await findDuplicateEntry(authUser.userId, d) : undefined,
  })));
  res.json({ drafts: withDuplicates });
});

router.post("/finance/ai/quick-entry/commit", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const { entries } = req.body as { entries?: Array<Partial<QuickEntryDraft> & { suggestedCategory?: string }> };
  if (!Array.isArray(entries) || entries.length === 0) { res.status(400).json({ error: "entries array is required" }); return; }

  // BUG FIX: this insert never resolved a bookId — every other
  // entry-creation path (manual create, CSV import, recurring sweep, the
  // wallet bridge) must resolve one before insert (see
  // financeLedgerEntriesTable.bookId's doc comment); GET /finance/entries
  // always filters on a resolved, non-null bookId. Without it, entries
  // committed from the AI quick-entry flow landed in the DB but never
  // showed up anywhere in the Finance UI.
  const resolvedBookId = await resolveBookId(authUser.userId);

  const created = [];
  for (const d of entries) {
    if (!d.title?.trim() || !(Number(d.amount) > 0) || !d.kind) continue;
    const [row] = await db.insert(financeLedgerEntriesTable).values({
      userId: authUser.userId,
      bookId: resolvedBookId,
      kind: d.kind,
      title: d.title.trim(),
      amount: Number(d.amount),
      currency: d.currency || "BDT",
      category: d.suggestedCategory || "Other",
      occurredDate: d.occurredDate ? new Date(d.occurredDate) : new Date(),
      status: "pending",
    }).returning();
    postEntryJournal(row).catch(() => {});
    notifyEntryCreated(row).catch(() => {});
    created.push(fmtEntry(row));
  }
  if (!created.length) { res.status(400).json({ error: "No valid entries to commit" }); return; }
  res.status(201).json({ created });
});

router.post("/finance/ai/query", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const { question } = req.body as { question?: string };
  if (!question?.trim()) { res.status(400).json({ error: "question is required" }); return; }
  const result = await answerFinanceQuery(authUser.userId, question);
  res.json(result);
});

router.get("/finance/ai/anomalies", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const flags = await detectAnomalies(authUser.userId);
  res.json({ flags });
});

router.get("/finance/ai/recurring-suggestions", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const candidates = await detectRecurringCandidates(authUser.userId);
  res.json({ candidates });
});

// ─── Receipt scan (Tesseract.js OCR — free, runs locally, no API key) ───────

router.post("/finance/ai/receipt-scan", requireAuth, uploadBodyParser, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const { imageBase64, currency } = req.body as { imageBase64?: string; currency?: string };
  if (!imageBase64) { res.status(400).json({ error: "imageBase64 is required" }); return; }
  if (imageBase64.length > MAX_ATTACHMENT_BYTES * 1.4) { res.status(413).json({ error: "Image too large" }); return; }

  try {
    const result = await extractReceiptFields(imageBase64, authUser.userId, currency || "BDT");
    const duplicate = result.draft ? await findDuplicateEntry(authUser.userId, result.draft) : undefined;
    res.json({ ...result, draft: result.draft ? { ...result.draft, duplicate } : null });
  } catch (err: any) {
    res.status(500).json({ error: "Couldn't read that receipt — try a clearer photo.", detail: err?.message });
  }
});

// ─── Bank / mobile-wallet SMS auto-entry (free — no SMS gateway) ────────────
// The user forwards bank/bKash/Nagad-style SMS via a free forwarding app
// (SMS Forwarder, Tasker, Macrodroid, etc.) pointed at the URL below —
// no paid SMS gateway or credit card involved anywhere in this flow.

router.get("/finance/ai/sms-webhook-token", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const token = await ensureSmsWebhookToken(authUser.userId);
  if (!token) { res.status(500).json({ error: "Couldn't generate a webhook token" }); return; }
  const base = process.env.APP_URL ?? "https://ayzen.replit.app";
  res.json({ token, url: `${base}/api/finance/ai/sms-webhook/${token}` });
});

router.post("/finance/ai/sms-webhook-token/rotate", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const token = await rotateSmsWebhookToken(authUser.userId);
  if (!token) { res.status(500).json({ error: "Couldn't rotate the webhook token" }); return; }
  const base = process.env.APP_URL ?? "https://ayzen.replit.app";
  res.json({ token, url: `${base}/api/finance/ai/sms-webhook/${token}` });
});

// Unauthenticated by design — possession of the unguessable :token in the
// URL is the only credential, same model as GET /finance/receipt/:token.
// Most SMS-forwarding apps can't attach a Bearer header, only a plain POST.
router.post("/finance/ai/sms-webhook/:token", requirePublicAudit("finance_sms_webhook.ingest", { onDecision: pepDecisionObserver }), async (req, res): Promise<void> => {
  const token = paramString(req.params.token);
  const { text } = req.body as { text?: string };
  if (!text?.trim()) { res.status(400).json({ error: "text is required" }); return; }

  const [user] = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.financeSmsWebhookToken, token));
  if (!user) { res.status(404).json({ error: "Unknown webhook token" }); return; }

  const draft = parseBankSms(text);
  if (!draft) { res.status(200).json({ created: false, reason: "Couldn't confidently parse an amount/direction from this SMS." }); return; }

  const dup = await findDuplicateEntry(user.id, draft);
  if (dup.isDuplicate) { res.status(200).json({ created: false, reason: "Looks like a duplicate of an existing entry.", duplicate: dup }); return; }

  // BUG FIX: same missing-bookId gap as the AI quick-entry commit route —
  // this insert never resolved a bookId, so SMS-forwarded auto-entries
  // were saved and journaled but never appeared in GET /finance/entries
  // (which always filters on a resolved, non-null bookId).
  const resolvedBookId = await resolveBookId(user.id);

  const [row] = await db.insert(financeLedgerEntriesTable).values({
    userId: user.id,
    bookId: resolvedBookId,
    kind: draft.kind,
    title: draft.title,
    amount: draft.amount,
    currency: draft.currency,
    category: draft.suggestedCategory,
    occurredDate: new Date(draft.occurredDate),
    status: "pending",
    notes: `Auto-created from a forwarded SMS — please verify.\n\nOriginal: ${draft.raw}`,
  }).returning();
  postEntryJournal(row).catch(() => {});

  createNotification(
    user.id,
    "finance_sms_entry_created",
    `📩 Logged from SMS — ${row.title}`,
    `${draft.kind === "income" ? "Received" : "Spent"} ${row.currency} ${row.amount.toLocaleString()}. Auto-created from a forwarded SMS — double-check it's right.`,
    { entryId: row.id },
  ).catch(() => {});

  res.status(201).json({ created: true, entry: fmtEntry(row) });
});

export default router;
