/**
 * lib/policy/approval/approval-engine.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 12 (Approval Engine).
 *
 * `ApprovalEngine` is the ONE place `approval_requests` rows are ever
 * created or transitioned. It is the write-side counterpart to
 * `approval-gate-rule.ts`'s read-only `createApprovalGateRule()`: this
 * class is what a future approval-request route (e.g. `POST
 * /approvals`, `POST /approvals/:id/decide`, `POST /approvals/:id/cancel`
 * — nothing constructs `ApprovalEngine` yet, same "additive, unwired
 * surface area" posture every prior phase's engine/registry class shipped
 * with) calls to actually run the roadmap's Phase 12 workflow:
 *
 *   PENDING → exactly one of APPROVED / REJECTED / EXPIRED / CANCELLED,
 *   once.
 *
 * Enforces, in this order, on every mutation:
 *   - shape validation (`requestApproval()`: non-blank reason, a future
 *     `expiresAt`) — fail closed, before any row is written;
 *   - the CRITICAL self-decision guard (`decide()`): "Initiator must not
 *     approve their own sensitive operation" (roadmap, verbatim) —
 *     checked BEFORE anything else on the decide path, including whether
 *     the request is still `PENDING`, so a hostile initiator can never
 *     learn a request's current state (already-decided vs. still-pending)
 *     by fishing for which error comes back first;
 *   - workflow legality (a request may only leave `PENDING` once —
 *     `ApprovalAlreadyDecidedError`);
 *   - the decision-window deadline (lazy expiry — see `decide()`'s own
 *     header section below);
 *   - an audit entry for every mutation (Rule 10), written via the exact
 *     same "snapshot BEFORE calling the provider" discipline
 *     `PolicyRegistry.applyStatusChange()` documents (see that file's own
 *     header note on why this matters for a provider that mutates a row
 *     object in place).
 *
 * ── No transactional (single round-trip) guarantee across the state-write
 *    and the audit-write ─────────────────────────────────────────────────
 * Same posture `PolicyRegistry`'s own header documents for the identical
 * question — this codebase's existing Drizzle call sites are not wrapped
 * in `db.transaction()` elsewhere either, so this phase does not introduce
 * a new pattern unilaterally. A failure to write the audit row is
 * RE-THROWN, not swallowed — an unaudited approval decision is worse than
 * a decision the caller is told to retry, per Rule 10.
 *
 * ── Deliberately NOT part of this file/phase ────────────────────────────
 * - Nothing here is wired into any Express route yet (see above).
 * - No `ApprovalAdminAuthorizer`/RBAC-permission gate on WHO may call
 *   `decide()` at all (the roadmap's Phase 12 section names exactly one
 *   critical rule — the self-decision guard — not a separate "who holds
 *   the approver permission" concern; that is a natural `admin.approval.
 *   decide`-style RBAC permission a future route wires up the same way
 *   `registry/authorizer.ts` wires up `admin.policy.approve`, but nothing
 *   in this phase's own roadmap text requires it, so it is not invented
 *   here per Rule 16).
 * - No background cleanup/reminder job that walks every overdue `PENDING`
 *   row and calls `expireIfPastDeadline()` on each — `expireIfPastDeadline()`
 *   exists so a future job (or a lazy read path) CAN do this, but nothing
 *   in this phase schedules it (same "ready for a future job" posture
 *   `approval_requests_expires_idx`'s own migration comment documents).
 */

import type {
  ApprovalAuditEntry,
  ApprovalRequestProvider,
  ApprovalRequestRecord,
  ApprovalState,
  CreateApprovalRequestInput,
} from "./types";
import {
  ApprovalAlreadyDecidedError,
  ApprovalRequestExpiredError,
  ApprovalRequestNotFoundError,
  InvalidApprovalRequestError,
  NotRequestInitiatorError,
  SelfDecisionNotAllowedError,
} from "./errors";

function toAuditSnapshot(record: ApprovalRequestRecord): Record<string, unknown> {
  return { ...record } as unknown as Record<string, unknown>;
}

export class ApprovalEngine {
  constructor(private readonly provider: ApprovalRequestProvider) {}

  /**
   * Creates a brand-new `PENDING` approval request. Throws
   * `InvalidApprovalRequestError` (before any row is written) if `reason`
   * is blank or `expiresAt` is not strictly in the future relative to
   * `now` — an approval request whose decision window is already closed
   * the instant it's created could never actually be decided (see
   * `decide()`'s lazy-expiry section below), so rejecting it at creation
   * time is simply the earliest point this same invariant can be checked,
   * not a new one.
   */
  async requestApproval(input: CreateApprovalRequestInput, now: Date = new Date()): Promise<ApprovalRequestRecord> {
    if (!input.reason || input.reason.trim().length === 0) {
      throw new InvalidApprovalRequestError("reason must be a non-empty string");
    }
    if (!(input.expiresAt instanceof Date) || Number.isNaN(input.expiresAt.getTime())) {
      throw new InvalidApprovalRequestError("expiresAt must be a valid Date");
    }
    if (input.expiresAt.getTime() <= now.getTime()) {
      throw new InvalidApprovalRequestError("expiresAt must be strictly in the future");
    }

    const created = await this.provider.create(input);
    await this.provider.recordAudit({
      actorId: created.initiatorUserId,
      requestId: created.id,
      action: "approval_requested",
      before: null,
      after: toAuditSnapshot(created),
    });
    return created;
  }

  /**
   * Decides a `PENDING` request `APPROVED` or `REJECTED`. `now` defaults
   * to a fresh clock read (this is a write/mutation method, not a `PDP`
   * rule — unlike `temporary-access-rule.ts`/`approval-gate-rule.ts`,
   * which must read `request.context.timestamp` for Rule 12 determinism,
   * a real decision genuinely happens at whatever instant it happens;
   * tests pass an explicit `now` to pin down boundary behavior, same
   * pattern `scripts/src/test-policy-temporary-access.ts` uses for its own
   * fixed-clock rule tests, just applied here to a mutation instead of a
   * pure evaluation).
   *
   * Order of checks (see file header for why this exact order, in
   * particular why the self-decision guard runs first):
   *   1. request exists (`ApprovalRequestNotFoundError`)
   *   2. `actorUserId !== request.initiatorUserId` (`SelfDecisionNotAllowedError`) —
   *      THE roadmap's Phase 12 critical rule, checked before anything else.
   *   3. request is still `PENDING` (`ApprovalAlreadyDecidedError`)
   *   4. `now < request.expiresAt` — the decision window (half-open,
   *      exclusive end, same boundary semantics `temporary-access-
   *      rule.ts` documents: `now === expiresAt` already counts as
   *      closed) — otherwise the request is lazily transitioned to
   *      `EXPIRED` right here and `ApprovalRequestExpiredError` is thrown
   *      instead of ever recording an `APPROVED`/`REJECTED` decision past
   *      deadline.
   */
  async decide(
    actorUserId: number,
    requestId: number | string,
    outcome: Extract<ApprovalState, "APPROVED" | "REJECTED">,
    decisionReason?: string | null,
    now: Date = new Date(),
  ): Promise<ApprovalRequestRecord> {
    const current = await this.provider.getById(requestId);
    if (!current) {
      throw new ApprovalRequestNotFoundError(requestId);
    }

    // CRITICAL rule — checked first, before even the state check, so this
    // guard's behavior never depends on (and never leaks) whether the
    // request happens to already be decided. See file header.
    if (actorUserId === current.initiatorUserId) {
      throw new SelfDecisionNotAllowedError(actorUserId);
    }

    if (current.state !== "PENDING") {
      throw new ApprovalAlreadyDecidedError(current.id, current.state);
    }

    if (now.getTime() >= current.expiresAt.getTime()) {
      // The decision window already closed — lazily expire it rather than
      // silently recording a decision the roadmap says should no longer
      // be possible. This IS a real state transition (audited exactly
      // like `expireIfPastDeadline()`'s own), not a no-op rejection.
      await this.applyStateChange(null, current, "EXPIRED");
      throw new ApprovalRequestExpiredError(current.id);
    }

    return this.applyStateChange(actorUserId, current, outcome, decisionReason ?? null);
  }

  /**
   * Withdraws a still-`PENDING` request. Only the request's own initiator
   * may cancel it (`NotRequestInitiatorError` otherwise) — a would-be
   * approver who simply doesn't want to decide should leave the request
   * `PENDING` (to expire naturally or be decided by someone else), not
   * cancel it out from under the initiator.
   */
  async cancel(actorUserId: number, requestId: number | string): Promise<ApprovalRequestRecord> {
    const current = await this.provider.getById(requestId);
    if (!current) {
      throw new ApprovalRequestNotFoundError(requestId);
    }
    if (actorUserId !== current.initiatorUserId) {
      throw new NotRequestInitiatorError(actorUserId, current.id);
    }
    if (current.state !== "PENDING") {
      throw new ApprovalAlreadyDecidedError(current.id, current.state);
    }
    return this.applyStateChange(null, current, "CANCELLED", null, actorUserId);
  }

  /** Pure, side-effect-free check: is `request` a `PENDING` row whose
   *  decision window has already closed as of `now`? Exposed so a read
   *  path (e.g. listing a user's own pending requests) can reflect
   *  reality without necessarily paying for a write on every read — see
   *  `expireIfPastDeadline()` for the version that actually performs the
   *  transition. */
  isPastDeadline(request: ApprovalRequestRecord, now: Date = new Date()): boolean {
    return request.state === "PENDING" && now.getTime() >= request.expiresAt.getTime();
  }

  /**
   * Lazily transitions a `PENDING` row past its decision window to
   * `EXPIRED`, writing an audit entry with `actorId: null` (see
   * `types.ts`'s `ApprovalAuditEntry` header — nobody decided this, the
   * clock did). Idempotent no-op (returns the row unchanged) if the row
   * isn't actually eligible — safe to call speculatively from a read path
   * or a future cleanup job (see file header) without first checking
   * `isPastDeadline()` yourself.
   */
  async expireIfPastDeadline(requestId: number | string, now: Date = new Date()): Promise<ApprovalRequestRecord> {
    const current = await this.provider.getById(requestId);
    if (!current) {
      throw new ApprovalRequestNotFoundError(requestId);
    }
    if (!this.isPastDeadline(current, now)) return current;
    return this.applyStateChange(null, current, "EXPIRED");
  }

  /**
   * Single choke point for every state transition this engine performs.
   * Snapshots `before` BEFORE calling the provider (see file header —
   * same "an in-memory provider that mutates in place would otherwise
   * corrupt the audit record" reasoning `PolicyRegistry.applyStatusChange()`
   * documents), then writes the row update and the audit entry describing
   * it.
   *
   * `decidedBy` on the ROW itself is set only for `APPROVED`/`REJECTED` —
   * it stays `null` for `EXPIRED`/`CANCELLED` even when `auditActorId` (a
   * human, for `CANCELLED`) is non-null, matching `approval_requests`'s
   * own DB-level CHECK constraint and schema header ("decided_by ... stays
   * NULL forever for a row that ends EXPIRED/CANCELLED, since nobody ever
   * decided it") — the row's `decidedBy` answers "who approved/rejected
   * this", the audit log's `actorId` separately answers "who performed
   * THIS particular transition", and the two questions have different
   * answers for `CANCELLED`.
   */
  private async applyStateChange(
    decidedBy: number | null,
    before: ApprovalRequestRecord,
    next: ApprovalState,
    decisionReason: string | null = null,
    auditActorId: number | null = decidedBy,
  ): Promise<ApprovalRequestRecord> {
    const beforeSnapshot = toAuditSnapshot(before);
    const rowDecidedBy = next === "APPROVED" || next === "REJECTED" ? decidedBy : null;
    const updated = await this.provider.updateState(before.id, next, { decidedBy: rowDecidedBy, decisionReason });
    const auditAction = next === "CANCELLED" ? "approval_cancelled" : next === "EXPIRED" ? "approval_expired" : "approval_decided";
    await this.provider.recordAudit({
      actorId: auditActorId,
      requestId: updated.id,
      action: auditAction,
      before: beforeSnapshot,
      after: toAuditSnapshot(updated),
    });
    return updated;
  }
}
