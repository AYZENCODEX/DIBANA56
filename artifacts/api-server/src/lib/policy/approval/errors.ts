/**
 * lib/policy/approval/errors.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 12 (Approval Engine).
 *
 * Distinct error classes so a caller (a future approval-request route —
 * nothing calls `ApprovalEngine` yet, see approval-engine.ts's header) can
 * tell WHY a mutation was rejected without parsing a message string — same
 * posture `registry/errors.ts` already established for the PAP side.
 */

export class ApprovalRequestNotFoundError extends Error {
  constructor(id: number | string) {
    super(`No approval request found with id "${id}".`);
    this.name = "ApprovalRequestNotFoundError";
  }
}

/** CRITICAL rule (roadmap Phase 12, verbatim): "Initiator must not approve
 *  their own sensitive operation." Thrown by `ApprovalEngine.decide()`
 *  the instant `actorUserId === request.initiatorUserId`, before any other
 *  check (including whether the request is even still `PENDING`) — see
 *  that method's own header for why this check runs first. */
export class SelfDecisionNotAllowedError extends Error {
  constructor(userId: number) {
    super(`User ${userId} initiated this approval request and may not also decide it.`);
    this.name = "SelfDecisionNotAllowedError";
  }
}

/** Thrown when `decide()`/`cancel()` targets a request whose `state` is no
 *  longer `PENDING` — a request's whole point is that exactly ONE of
 *  APPROVED/REJECTED/EXPIRED/CANCELLED ever happens to it (see schema file
 *  header). Carries the request's actual current state so a caller can
 *  distinguish "someone already approved this" from "this already
 *  expired" without re-fetching the row. */
export class ApprovalAlreadyDecidedError extends Error {
  constructor(
    readonly requestId: number | string,
    readonly currentState: string,
  ) {
    super(`Approval request ${requestId} is already ${currentState}; it can no longer be decided or cancelled.`);
    this.name = "ApprovalAlreadyDecidedError";
  }
}

/** Thrown by `decide()` when `context`'s decision instant is at or past
 *  the request's `expiresAt` — the decision window has already closed
 *  (half-open interval, same exclusive-end boundary semantics
 *  `temporary-access-rule.ts` documents for its own `expiresAt`; see
 *  approval-engine.ts's header). The request is lazily transitioned to
 *  `EXPIRED` as a side effect of this call, same as if a cleanup job had
 *  already caught it — a decider is never allowed to "beat the clock" by
 *  deciding a request whose window has technically closed. */
export class ApprovalRequestExpiredError extends Error {
  constructor(readonly requestId: number | string) {
    super(`Approval request ${requestId}'s decision window has already closed; it has been marked EXPIRED.`);
    this.name = "ApprovalRequestExpiredError";
  }
}

/** Thrown by `cancel()` when `actorUserId` is not the request's own
 *  initiator — only the person who asked for the sensitive operation may
 *  withdraw their own request. Distinguished from `SelfDecisionNotAllowedError`
 *  (which fires for the OPPOSITE reason — the actor IS the initiator — on
 *  the decide() path) so audit logs/callers never confuse the two guards. */
export class NotRequestInitiatorError extends Error {
  constructor(
    readonly userId: number,
    readonly requestId: number | string,
  ) {
    super(`User ${userId} did not initiate approval request ${requestId} and may not cancel it.`);
    this.name = "NotRequestInitiatorError";
  }
}

/** Thrown when `requestApproval()`'s input fails basic shape validation
 *  (blank reason, non-future `expiresAt`) before any row is ever written —
 *  fail closed (Rule 8), same posture `buildAuthorizationRequest()`
 *  (../authorization-request.ts) already takes for the PDP side. */
export class InvalidApprovalRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidApprovalRequestError";
  }
}
