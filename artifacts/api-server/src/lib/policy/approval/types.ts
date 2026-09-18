/**
 * lib/policy/approval/types.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 12 (Approval Engine).
 *
 * The interface `ApprovalEngine` (approval-engine.ts) and
 * `createApprovalGateRule()` (approval-gate-rule.ts) are both written
 * against — same "one shared interface, real Drizzle provider + fake
 * provider both honor it" shape every prior phase's `*Provider` interface
 * already establishes (see e.g. `registry/types.ts`'s `PolicyRegistryProvider`,
 * `temporary-access/types.ts`'s `TemporaryAccessGrantProvider`).
 *
 * ── `ApprovalRequestRecord` mirrors `approval_requests` row-for-row ────────
 * See `lib/db/src/schema/approval-requests.ts`'s header for the full
 * design rationale behind each field — in particular why this row is
 * MUTABLE (unlike every other Phase 03/07/11 grant/registry table), why
 * `resourceId` is nullable, and why `decidedBy`/`decidedAt` stay `null`
 * forever for a row that ends EXPIRED/CANCELLED.
 *
 * ── Why this module has its OWN `ApprovalState` union, not a re-export of
 *    the schema file's inline `APPROVAL_STATES` const ──────────────────────
 * `lib/db/src/schema/approval-requests.ts` is a `lib/db`-layer file;
 * everything under `lib/policy/*` must stay importable without dragging in
 * `@workspace/db` (see `drizzle-approval-request-provider.ts`'s own header
 * for the one exception, and every other phase's identical boundary). This
 * union is therefore hand-kept in sync with that file's `APPROVAL_STATES`
 * array — the same "two independent, deliberately duplicated small
 * vocabularies, one per layer" precedent `temporary-access/types.ts`'s
 * `scope` field already establishes relative to its own schema file.
 */

/** Roadmap's own workflow: `PENDING` → exactly one of `APPROVED` /
 *  `REJECTED` / `EXPIRED` / `CANCELLED`, once. See
 *  `approval-engine.ts`'s `ApprovalEngine` for the only code that ever
 *  transitions a row out of `PENDING`. */
export type ApprovalState = "PENDING" | "APPROVED" | "REJECTED" | "EXPIRED" | "CANCELLED";

/** One `approval_requests` row. Every field is fixed at insert time EXCEPT
 *  `state`/`decidedBy`/`decidedAt`/`decisionReason` — the narrow, explicit
 *  set of mutable columns `ApprovalEngine` alone ever writes (see that
 *  file's header). */
export interface ApprovalRequestRecord {
  id: number | string;
  /** WHO is asking for the sensitive operation to proceed. */
  initiatorUserId: number;
  resourceType: string;
  /** Nullable — not every approval-gated action targets one concrete
   *  resource (e.g. an org-wide or system-wide action). See schema file
   *  header. */
  resourceId: string | null;
  action: string;
  /** Carried for audit/context only — never matched against by
   *  `approval-gate-rule.ts`. See schema file header. */
  organizationId: number | null;
  /** The initiator's justification — required. */
  reason: string;
  state: ApprovalState;
  /** Request stops being decidable at (inclusive of) this instant — see
   *  `approval-engine.ts`'s `decide()` for the exact boundary semantics
   *  (same half-open-interval posture `temporary-access/temporary-access-
   *  rule.ts` already documents for its own `expiresAt`, applied here to a
   *  *decision window* instead of an *access window* — see schema file
   *  header). */
  expiresAt: Date;
  createdAt: Date;
  /** `null` while `PENDING`, and stays `null` forever for a row that ends
   *  `EXPIRED`/`CANCELLED` (nobody ever decided it) — set only by
   *  `ApprovalEngine.decide()`'s `APPROVED`/`REJECTED` transitions. */
  decidedBy: number | null;
  decidedAt: Date | null;
  decisionReason: string | null;
}

/** Input to `ApprovalEngine.requestApproval()`. Always produces a brand
 *  new `PENDING` row. */
export interface CreateApprovalRequestInput {
  initiatorUserId: number;
  resourceType: string;
  resourceId?: string | null;
  action: string;
  organizationId?: number | null;
  reason: string;
  expiresAt: Date;
}

export type ApprovalAuditAction = "approval_requested" | "approval_decided" | "approval_cancelled" | "approval_expired";

/** One row `ApprovalEngine` writes to `approval_audit_log` — see schema
 *  file header for the table this mirrors. `actorId` is `null` only for
 *  the one entry a lazy system-driven expiry transition writes (see
 *  `approval-engine.ts`'s `expireIfPastDeadline()`) — every other action
 *  here always has a human actor (the initiator, for `approval_requested`/
 *  `approval_cancelled`; the approver, for `approval_decided`). */
export interface ApprovalAuditEntry {
  actorId: number | null;
  requestId: number | string;
  action: ApprovalAuditAction;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

/**
 * Everything `ApprovalEngine` and `createApprovalGateRule()` need from
 * storage. `DrizzleApprovalRequestProvider`
 * (drizzle-approval-request-provider.ts) is the real, `@workspace/db`-
 * backed implementation; a `FakeApprovalRequestProvider`
 * (scripts/src/test-policy-approval.ts) is the in-memory stand-in tests
 * use.
 *
 * Contract every implementation must honor:
 *   - `getById`/`findApprovedRequest` never throw for "not found" — same
 *     "empty/null, not an exception" contract every other `*Provider`
 *     interface in `lib/policy/*` already establishes.
 *   - `create`/`updateState` never enforce workflow legality themselves
 *     (self-decision guard, "already decided", expiry) — that is entirely
 *     `ApprovalEngine`'s job; the provider is a dumb store, same posture
 *     `PolicyRegistryProvider`/`TemporaryAccessGrantProvider` already take
 *     relative to `PolicyRegistry`/`createTemporaryAccessRule()`.
 *   - `updateState` updates ONLY `state`/`decidedBy`/`decidedAt`/
 *     `decisionReason` on an existing row. Never touches any other column.
 *   - `findApprovedRequest` returns the live `APPROVED` row (if any) for
 *     the EXACT `(initiatorUserId, resourceType, resourceId, action)`
 *     tuple `approval-gate-rule.ts` asks about — no wildcard/pattern
 *     matching at the storage layer (see that file's header for why exact
 *     match is the right granularity here, same reasoning
 *     `resource_grants`/`temporary_access_grants`'s own exact-match rows
 *     already establish).
 *   - `recordAudit` never throws in a way that unwinds a caller's own
 *     already-committed write — same posture `PolicyRegistryProvider.
 *     recordAudit()`'s own header documents; `ApprovalEngine` still lets a
 *     failure here propagate (see that file's header) rather than
 *     silently swallowing it, per Rule 10.
 */
export interface ApprovalRequestProvider {
  create(input: CreateApprovalRequestInput): Promise<ApprovalRequestRecord>;
  getById(id: number | string): Promise<ApprovalRequestRecord | null>;
  /** `resourceId === null` matches only rows whose own `resourceId` is
   *  also `null` (an org-wide/system-wide approval) — it is never a
   *  wildcard for "any resourceId". */
  findApprovedRequest(
    initiatorUserId: number,
    resourceType: string,
    resourceId: string | null,
    action: string,
  ): Promise<ApprovalRequestRecord | null>;
  updateState(
    id: number | string,
    next: ApprovalState,
    decision?: { decidedBy: number | null; decisionReason?: string | null },
  ): Promise<ApprovalRequestRecord>;
  recordAudit(entry: ApprovalAuditEntry): Promise<void>;
}
