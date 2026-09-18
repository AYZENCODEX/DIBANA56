/**
 * lib/policy/approval/drizzle-approval-request-provider.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 12 (Approval Engine).
 *
 * The real, `@workspace/db`-backed `ApprovalRequestProvider` (see
 * ./types.ts for the interface). Same posture as
 * `temporary-access/drizzle-temporary-access-grant-provider.ts`: this is
 * the one file in `lib/policy/approval/*` that imports `@workspace/db`, so
 * it is deliberately excluded from `./approval/index.ts`'s barrel (see
 * that file's header) — import it directly at the one real call site that
 * constructs it (a future approval-request route's `ApprovalEngine`
 * construction).
 *
 * Nothing in the app constructs `DrizzleApprovalRequestProvider` yet —
 * like every provider this roadmap has shipped so far, this is additive,
 * unwired surface area. It cannot be executed against a real database in
 * this sandbox either (no network to a real Postgres instance) — included,
 * reviewed, and typed now so a future pass only has to wire it up, not
 * design it.
 *
 * ── `findApprovedRequest()` — exact-match, live rows only ─────────────────
 * Filters by `state = 'APPROVED'` directly in the query (unlike
 * `DrizzleTemporaryAccessGrantProvider.getTemporaryAccessGrants()`, which
 * deliberately returns every candidate row regardless of time window so
 * the RULE can compare against `request.context.timestamp` for
 * determinism — see that file's header). There is no equivalent
 * determinism concern here: `state` is not a clock-derived property the
 * way "is `now` inside `[startsAt, expiresAt)`" is — an `APPROVED` row
 * either is or isn't `APPROVED` at query time, full stop, so filtering in
 * SQL costs nothing `approval-gate-rule.ts` would otherwise have needed to
 * recompute itself.
 *
 * When more than one `APPROVED` row somehow matches the same exact tuple
 * (should not happen under normal `ApprovalEngine` usage, since a fresh
 * `requestApproval()` call for the same tuple while an approved one is
 * already on file is still a perfectly legal NEW request — nothing in
 * this phase enforces "at most one live approval per tuple" the way
 * migration 099's partial unique index enforces "at most one ACTIVE
 * policy version"), the most recently decided one wins — `ORDER BY
 * decided_at DESC LIMIT 1`.
 */

import { db, approvalRequestsTable, approvalAuditLogTable } from "@workspace/db";
import { and, desc, eq, isNull } from "drizzle-orm";
import type {
  ApprovalAuditEntry,
  ApprovalRequestProvider,
  ApprovalRequestRecord,
  ApprovalState,
  CreateApprovalRequestInput,
} from "./types";

const VALID_STATES: ReadonlySet<string> = new Set(["PENDING", "APPROVED", "REJECTED", "EXPIRED", "CANCELLED"]);

/** Narrows a raw DB row's `state` column, failing closed (throwing) if it
 *  is somehow neither one of the five known states — the insert schema's
 *  Zod refinement and the migration's CHECK constraint should both
 *  already prevent this, but a provider must never silently hand a
 *  malformed row to `ApprovalEngine`/`approval-gate-rule.ts` as if it were
 *  well-typed. Unlike `DrizzleTemporaryAccessGrantProvider`'s analogous
 *  `scope` guard (which SKIPS a malformed row, since that provider returns
 *  arrays it can simply omit an entry from), a single-row read has no
 *  "just omit it" option that preserves the method's own contract — so
 *  this throws rather than silently returning `null` for a row that does,
 *  in fact, exist. */
function toRecord(row: typeof approvalRequestsTable.$inferSelect): ApprovalRequestRecord {
  if (!VALID_STATES.has(row.state)) {
    throw new Error(`approval_requests row ${row.id} has an invalid state "${row.state}".`);
  }
  return {
    id: row.id,
    initiatorUserId: row.initiatorUserId,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    action: row.action,
    organizationId: row.organizationId,
    reason: row.reason,
    state: row.state as ApprovalState,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    decidedBy: row.decidedBy,
    decidedAt: row.decidedAt,
    decisionReason: row.decisionReason,
  };
}

export class DrizzleApprovalRequestProvider implements ApprovalRequestProvider {
  async create(input: CreateApprovalRequestInput): Promise<ApprovalRequestRecord> {
    const [row] = await db
      .insert(approvalRequestsTable)
      .values({
        initiatorUserId: input.initiatorUserId,
        resourceType: input.resourceType,
        resourceId: input.resourceId ?? null,
        action: input.action,
        organizationId: input.organizationId ?? null,
        reason: input.reason,
        state: "PENDING",
        expiresAt: input.expiresAt,
      })
      .returning();
    return toRecord(row);
  }

  async getById(id: number | string): Promise<ApprovalRequestRecord | null> {
    const numericId = typeof id === "string" ? Number(id) : id;
    const [row] = await db.select().from(approvalRequestsTable).where(eq(approvalRequestsTable.id, numericId));
    return row ? toRecord(row) : null;
  }

  async findApprovedRequest(
    initiatorUserId: number,
    resourceType: string,
    resourceId: string | null,
    action: string,
  ): Promise<ApprovalRequestRecord | null> {
    const [row] = await db
      .select()
      .from(approvalRequestsTable)
      .where(
        and(
          eq(approvalRequestsTable.initiatorUserId, initiatorUserId),
          eq(approvalRequestsTable.resourceType, resourceType),
          resourceId === null ? isNull(approvalRequestsTable.resourceId) : eq(approvalRequestsTable.resourceId, resourceId),
          eq(approvalRequestsTable.action, action),
          eq(approvalRequestsTable.state, "APPROVED"),
        ),
      )
      .orderBy(desc(approvalRequestsTable.decidedAt))
      .limit(1);
    return row ? toRecord(row) : null;
  }

  async updateState(
    id: number | string,
    next: ApprovalState,
    decision?: { decidedBy: number | null; decisionReason?: string | null },
  ): Promise<ApprovalRequestRecord> {
    const numericId = typeof id === "string" ? Number(id) : id;
    const isDecided = next === "APPROVED" || next === "REJECTED";
    const [row] = await db
      .update(approvalRequestsTable)
      .set({
        state: next,
        decidedBy: decision?.decidedBy ?? null,
        decidedAt: isDecided ? new Date() : null,
        decisionReason: decision?.decisionReason ?? null,
      })
      .where(eq(approvalRequestsTable.id, numericId))
      .returning();
    return toRecord(row);
  }

  async recordAudit(entry: ApprovalAuditEntry): Promise<void> {
    const numericRequestId = typeof entry.requestId === "string" ? Number(entry.requestId) : entry.requestId;
    await db.insert(approvalAuditLogTable).values({
      actorId: entry.actorId,
      requestId: numericRequestId,
      action: entry.action,
      before: entry.before,
      after: entry.after,
    });
  }
}
