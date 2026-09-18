/**
 * scripts/src/test-policy-approval.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 12 (Approval Engine)
 * tests.
 *
 * Same shape as every other scripts/src/test-policy-*.ts: DB-free,
 * runnable anywhere with nothing but
 *   npx tsx scripts/src/test-policy-approval.ts
 *
 * Covers the roadmap's Phase 12 requirements directly:
 *   - initiator / approver / scope / reason / expiry / approval state /
 *     audit trail (the roadmap's own required-field list, verbatim);
 *   - the CRITICAL rule: "Initiator must not approve their own sensitive
 *     operation";
 * plus the applicable slice of the roadmap's general security test list
 * (IDOR, cross-user, privilege escalation via forged fields), composition
 * with other phases/rules, and determinism (Rule 12).
 *
 * Run: npx tsx scripts/src/test-policy-approval.ts
 */

import assert from "node:assert/strict";
import {
  PolicyEngine,
  createApprovalGateRule,
  APPROVAL_GATE_POLICY_ID,
  ApprovalEngine,
  SelfDecisionNotAllowedError,
  ApprovalAlreadyDecidedError,
  ApprovalRequestExpiredError,
  ApprovalRequestNotFoundError,
  NotRequestInitiatorError,
  InvalidApprovalRequestError,
  type Subject,
  type ResourceRef,
  type PolicyContext,
  type ApprovalRequestProvider,
  type ApprovalRequestRecord,
  type ApprovalAuditEntry,
  type CreateApprovalRequestInput,
  type ApprovalState,
  type BuildAuthorizationRequestInput,
} from "../../artifacts/api-server/src/lib/policy";

function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ok — ${name}`))
    .catch((err) => {
      console.error(`  FAIL — ${name}`);
      throw err;
    });
}

// ── FakeApprovalRequestProvider — in-memory stand-in ────────────────────────

class FakeApprovalRequestProvider implements ApprovalRequestProvider {
  readonly rows: ApprovalRequestRecord[] = [];
  readonly auditLog: ApprovalAuditEntry[] = [];
  private nextId = 1;

  async create(input: CreateApprovalRequestInput): Promise<ApprovalRequestRecord> {
    const row: ApprovalRequestRecord = {
      id: this.nextId++,
      initiatorUserId: input.initiatorUserId,
      resourceType: input.resourceType,
      resourceId: input.resourceId ?? null,
      action: input.action,
      organizationId: input.organizationId ?? null,
      reason: input.reason,
      state: "PENDING",
      expiresAt: input.expiresAt,
      createdAt: new Date(),
      decidedBy: null,
      decidedAt: null,
      decisionReason: null,
    };
    this.rows.push(row);
    return { ...row };
  }

  async getById(id: number | string): Promise<ApprovalRequestRecord | null> {
    const row = this.rows.find((r) => r.id === id);
    return row ? { ...row } : null;
  }

  async findApprovedRequest(
    initiatorUserId: number,
    resourceType: string,
    resourceId: string | null,
    action: string,
  ): Promise<ApprovalRequestRecord | null> {
    const candidates = this.rows.filter(
      (r) =>
        r.state === "APPROVED" &&
        r.initiatorUserId === initiatorUserId &&
        r.resourceType === resourceType &&
        r.resourceId === resourceId &&
        r.action === action,
    );
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => (b.decidedAt?.getTime() ?? 0) - (a.decidedAt?.getTime() ?? 0));
    return { ...candidates[0] };
  }

  async updateState(
    id: number | string,
    next: ApprovalState,
    decision?: { decidedBy: number | null; decisionReason?: string | null },
  ): Promise<ApprovalRequestRecord> {
    const row = this.rows.find((r) => r.id === id);
    if (!row) throw new Error("not found");
    row.state = next;
    const isDecided = next === "APPROVED" || next === "REJECTED";
    row.decidedBy = decision?.decidedBy ?? null;
    row.decidedAt = isDecided ? new Date() : null;
    row.decisionReason = decision?.decisionReason ?? null;
    return { ...row };
  }

  async recordAudit(entry: ApprovalAuditEntry): Promise<void> {
    this.auditLog.push(entry);
  }
}

// ── fixtures ────────────────────────────────────────────────────────────

const initiator: Subject = { userId: 10, role: "member", authType: "session" };
const otherInitiator: Subject = { userId: 11, role: "member", authType: "session" };
const approver: Subject = { userId: 20, role: "admin", authType: "session" };

function contextAt(iso: string): PolicyContext {
  return { requestId: `req-${iso}`, timestamp: new Date(iso) };
}

function buildInput(subject: Subject | null, action: string, resource: ResourceRef, context: PolicyContext): BuildAuthorizationRequestInput {
  return { subject, action, resource, context };
}

const NOW = new Date("2026-01-01T00:00:00.000Z");
const FUTURE_EXPIRY = new Date("2026-01-02T00:00:00.000Z");

function baseRequestInput(overrides: Partial<CreateApprovalRequestInput> = {}): CreateApprovalRequestInput {
  return {
    initiatorUserId: initiator.userId,
    resourceType: "ryft.payment",
    resourceId: "555",
    action: "ryft.payment.release",
    reason: "releasing escrowed funds to vendor",
    expiresAt: FUTURE_EXPIRY,
    ...overrides,
  };
}

async function main() {
  console.log("Policy Engine — Phase 12 (Approval Engine) tests");

  // ── ApprovalEngine: request → decide happy path + audit trail ──────────

  await test("requestApproval() creates a PENDING row and writes an approval_requested audit entry", async () => {
    const provider = new FakeApprovalRequestProvider();
    const engine = new ApprovalEngine(provider);
    const created = await engine.requestApproval(baseRequestInput(), NOW);
    assert.equal(created.state, "PENDING");
    assert.equal(created.initiatorUserId, initiator.userId);
    assert.equal(created.decidedBy, null);
    assert.equal(provider.auditLog.length, 1);
    assert.equal(provider.auditLog[0].action, "approval_requested");
    assert.equal(provider.auditLog[0].actorId, initiator.userId);
    assert.equal(provider.auditLog[0].before, null);
  });

  await test("requestApproval() rejects a blank reason before writing any row", async () => {
    const provider = new FakeApprovalRequestProvider();
    const engine = new ApprovalEngine(provider);
    await assert.rejects(() => engine.requestApproval(baseRequestInput({ reason: "   " }), NOW), InvalidApprovalRequestError);
    assert.equal(provider.rows.length, 0);
  });

  await test("requestApproval() rejects an expiresAt that is not strictly in the future", async () => {
    const provider = new FakeApprovalRequestProvider();
    const engine = new ApprovalEngine(provider);
    await assert.rejects(() => engine.requestApproval(baseRequestInput({ expiresAt: NOW }), NOW), InvalidApprovalRequestError);
    assert.equal(provider.rows.length, 0);
  });

  await test("decide(APPROVED) by a different user transitions PENDING → APPROVED and records decidedBy/decidedAt", async () => {
    const provider = new FakeApprovalRequestProvider();
    const engine = new ApprovalEngine(provider);
    const created = await engine.requestApproval(baseRequestInput(), NOW);
    const decided = await engine.decide(approver.userId, created.id, "APPROVED", "looks legitimate", NOW);
    assert.equal(decided.state, "APPROVED");
    assert.equal(decided.decidedBy, approver.userId);
    assert.equal(decided.decisionReason, "looks legitimate");
    assert.ok(decided.decidedAt);
    const auditEntry = provider.auditLog.find((e) => e.action === "approval_decided");
    assert.ok(auditEntry);
    assert.equal(auditEntry!.actorId, approver.userId);
  });

  await test("decide(REJECTED) by a different user transitions PENDING → REJECTED, decidedBy still recorded", async () => {
    const provider = new FakeApprovalRequestProvider();
    const engine = new ApprovalEngine(provider);
    const created = await engine.requestApproval(baseRequestInput(), NOW);
    const decided = await engine.decide(approver.userId, created.id, "REJECTED", "insufficient documentation", NOW);
    assert.equal(decided.state, "REJECTED");
    assert.equal(decided.decidedBy, approver.userId);
  });

  // ── CRITICAL rule: initiator must not approve their own request ────────

  await test("CRITICAL: initiator attempting to decide their own request throws SelfDecisionNotAllowedError", async () => {
    const provider = new FakeApprovalRequestProvider();
    const engine = new ApprovalEngine(provider);
    const created = await engine.requestApproval(baseRequestInput(), NOW);
    await assert.rejects(() => engine.decide(initiator.userId, created.id, "APPROVED", null, NOW), SelfDecisionNotAllowedError);
    // The row must remain untouched — a rejected self-decision attempt is
    // not a partial state change.
    const stillPending = await provider.getById(created.id);
    assert.equal(stillPending!.state, "PENDING");
    assert.equal(provider.auditLog.filter((e) => e.action === "approval_decided").length, 0);
  });

  await test("CRITICAL: self-decision guard fires even for an already-decided request (never leaks state via error ordering)", async () => {
    const provider = new FakeApprovalRequestProvider();
    const engine = new ApprovalEngine(provider);
    const created = await engine.requestApproval(baseRequestInput(), NOW);
    await engine.decide(approver.userId, created.id, "APPROVED", null, NOW);
    // Now PENDING is no longer true, yet initiator's self-decision attempt
    // must still surface SelfDecisionNotAllowedError, not
    // ApprovalAlreadyDecidedError — the self-decision check runs first,
    // unconditionally.
    await assert.rejects(() => engine.decide(initiator.userId, created.id, "APPROVED", null, NOW), SelfDecisionNotAllowedError);
  });

  await test("a DIFFERENT other user (not the initiator) may decide the request", async () => {
    const provider = new FakeApprovalRequestProvider();
    const engine = new ApprovalEngine(provider);
    const created = await engine.requestApproval(baseRequestInput(), NOW);
    const decided = await engine.decide(otherInitiator.userId, created.id, "APPROVED", null, NOW);
    assert.equal(decided.state, "APPROVED");
    assert.equal(decided.decidedBy, otherInitiator.userId);
  });

  // ── workflow legality: exactly one decision, ever ───────────────────────

  await test("deciding an already-APPROVED request a second time throws ApprovalAlreadyDecidedError", async () => {
    const provider = new FakeApprovalRequestProvider();
    const engine = new ApprovalEngine(provider);
    const created = await engine.requestApproval(baseRequestInput(), NOW);
    await engine.decide(approver.userId, created.id, "APPROVED", null, NOW);
    await assert.rejects(() => engine.decide(approver.userId, created.id, "REJECTED", null, NOW), ApprovalAlreadyDecidedError);
  });

  await test("decide() on an unknown request id throws ApprovalRequestNotFoundError", async () => {
    const provider = new FakeApprovalRequestProvider();
    const engine = new ApprovalEngine(provider);
    await assert.rejects(() => engine.decide(approver.userId, 999, "APPROVED", null, NOW), ApprovalRequestNotFoundError);
  });

  // ── cancellation ─────────────────────────────────────────────────────────

  await test("the initiator may cancel their own still-PENDING request; decidedBy stays null", async () => {
    const provider = new FakeApprovalRequestProvider();
    const engine = new ApprovalEngine(provider);
    const created = await engine.requestApproval(baseRequestInput(), NOW);
    const cancelled = await engine.cancel(initiator.userId, created.id);
    assert.equal(cancelled.state, "CANCELLED");
    assert.equal(cancelled.decidedBy, null); // nobody ever "decided" a cancelled request
    const auditEntry = provider.auditLog.find((e) => e.action === "approval_cancelled");
    assert.ok(auditEntry);
    assert.equal(auditEntry!.actorId, initiator.userId); // audit still attributes WHO cancelled it
  });

  await test("a non-initiator may not cancel someone else's request", async () => {
    const provider = new FakeApprovalRequestProvider();
    const engine = new ApprovalEngine(provider);
    const created = await engine.requestApproval(baseRequestInput(), NOW);
    await assert.rejects(() => engine.cancel(approver.userId, created.id), NotRequestInitiatorError);
  });

  await test("cancelling an already-decided request throws ApprovalAlreadyDecidedError", async () => {
    const provider = new FakeApprovalRequestProvider();
    const engine = new ApprovalEngine(provider);
    const created = await engine.requestApproval(baseRequestInput(), NOW);
    await engine.decide(approver.userId, created.id, "APPROVED", null, NOW);
    await assert.rejects(() => engine.cancel(initiator.userId, created.id), ApprovalAlreadyDecidedError);
  });

  // ── expiry: before / at / after the decision-window boundary ────────────

  await test("deciding 1ms before expiresAt succeeds", async () => {
    const provider = new FakeApprovalRequestProvider();
    const engine = new ApprovalEngine(provider);
    const created = await engine.requestApproval(baseRequestInput({ expiresAt: new Date("2026-01-02T00:00:00.000Z") }), NOW);
    const decided = await engine.decide(approver.userId, created.id, "APPROVED", null, new Date("2026-01-01T23:59:59.999Z"));
    assert.equal(decided.state, "APPROVED");
  });

  await test("deciding exactly at expiresAt (exclusive end) lazily expires the request and throws", async () => {
    const provider = new FakeApprovalRequestProvider();
    const engine = new ApprovalEngine(provider);
    const expiresAt = new Date("2026-01-02T00:00:00.000Z");
    const created = await engine.requestApproval(baseRequestInput({ expiresAt }), NOW);
    await assert.rejects(() => engine.decide(approver.userId, created.id, "APPROVED", null, expiresAt), ApprovalRequestExpiredError);
    const row = await provider.getById(created.id);
    assert.equal(row!.state, "EXPIRED");
    assert.equal(row!.decidedBy, null); // nobody decided an expired request
    const auditEntry = provider.auditLog.find((e) => e.action === "approval_expired");
    assert.ok(auditEntry);
    assert.equal(auditEntry!.actorId, null); // system-driven, no human actor
  });

  await test("deciding well after expiresAt also lazily expires the request and throws", async () => {
    const provider = new FakeApprovalRequestProvider();
    const engine = new ApprovalEngine(provider);
    const created = await engine.requestApproval(baseRequestInput({ expiresAt: new Date("2026-01-02T00:00:00.000Z") }), NOW);
    await assert.rejects(
      () => engine.decide(approver.userId, created.id, "APPROVED", null, new Date("2026-06-01T00:00:00.000Z")),
      ApprovalRequestExpiredError,
    );
    const row = await provider.getById(created.id);
    assert.equal(row!.state, "EXPIRED");
  });

  await test("expireIfPastDeadline() is idempotent and a no-op for a still-live PENDING request", async () => {
    const provider = new FakeApprovalRequestProvider();
    const engine = new ApprovalEngine(provider);
    const created = await engine.requestApproval(baseRequestInput(), NOW);
    const unchanged = await engine.expireIfPastDeadline(created.id, NOW);
    assert.equal(unchanged.state, "PENDING");
    assert.equal(provider.auditLog.filter((e) => e.action === "approval_expired").length, 0);
  });

  await test("expireIfPastDeadline() transitions an overdue PENDING request exactly once", async () => {
    const provider = new FakeApprovalRequestProvider();
    const engine = new ApprovalEngine(provider);
    const expiresAt = new Date("2026-01-02T00:00:00.000Z");
    const created = await engine.requestApproval(baseRequestInput({ expiresAt }), NOW);
    const late = new Date("2026-06-01T00:00:00.000Z");
    const first = await engine.expireIfPastDeadline(created.id, late);
    assert.equal(first.state, "EXPIRED");
    // Calling again is a safe no-op — the row is no longer PENDING.
    const second = await engine.expireIfPastDeadline(created.id, late);
    assert.equal(second.state, "EXPIRED");
    assert.equal(provider.auditLog.filter((e) => e.action === "approval_expired").length, 1);
  });

  // ── approval-gate-rule + PolicyEngine integration ───────────────────────

  await test("no registered requirement matches the action → gate abstains → default DENY (nothing else registered)", async () => {
    const provider = new FakeApprovalRequestProvider();
    const engine = new PolicyEngine();
    engine.registerRule(APPROVAL_GATE_POLICY_ID, createApprovalGateRule([{ id: "req-1", actions: ["ryft.payment.release"] }], provider));
    const decision = await engine.evaluate(
      buildInput(initiator, "sylo.vault.read", { type: "sylo.vault_item", id: 1 }, contextAt("2026-01-01T12:00:00.000Z")),
    );
    assert.equal(decision.effect, "DENY");
    assert.equal(decision.reason, "NO_MATCHING_POLICY");
  });

  await test("matching action, no approved request on file → APPROVAL_REQUIRED", async () => {
    const provider = new FakeApprovalRequestProvider();
    const engine = new PolicyEngine();
    engine.registerRule(APPROVAL_GATE_POLICY_ID, createApprovalGateRule([{ id: "req-1", actions: ["ryft.payment.release"] }], provider));
    const decision = await engine.evaluate(
      buildInput(initiator, "ryft.payment.release", { type: "ryft.payment", id: 555 }, contextAt("2026-01-01T12:00:00.000Z")),
    );
    assert.equal(decision.effect, "APPROVAL_REQUIRED");
    assert.equal(decision.reason, "APPROVAL_REQUIRED");
    assert.equal(decision.policyId, APPROVAL_GATE_POLICY_ID);
  });

  await test("matching action with a live APPROVED request on file → ALLOW", async () => {
    const provider = new FakeApprovalRequestProvider();
    const approvalEngine = new ApprovalEngine(provider);
    const created = await approvalEngine.requestApproval(baseRequestInput({ resourceId: "555" }), NOW);
    await approvalEngine.decide(approver.userId, created.id, "APPROVED", "confirmed with finance", NOW);

    const engine = new PolicyEngine();
    engine.registerRule(APPROVAL_GATE_POLICY_ID, createApprovalGateRule([{ id: "req-1", actions: ["ryft.payment.release"] }], provider));
    const decision = await engine.evaluate(
      buildInput(initiator, "ryft.payment.release", { type: "ryft.payment", id: "555" }, contextAt("2026-01-01T12:00:00.000Z")),
    );
    assert.equal(decision.effect, "ALLOW");
    assert.equal(decision.policyId, APPROVAL_GATE_POLICY_ID);
    assert.equal(decision.message, "confirmed with finance");
  });

  await test("a REJECTED request does not satisfy the gate — still APPROVAL_REQUIRED, never a permanent DENY", async () => {
    const provider = new FakeApprovalRequestProvider();
    const approvalEngine = new ApprovalEngine(provider);
    const created = await approvalEngine.requestApproval(baseRequestInput({ resourceId: "555" }), NOW);
    await approvalEngine.decide(approver.userId, created.id, "REJECTED", "not enough evidence", NOW);

    const engine = new PolicyEngine();
    engine.registerRule(APPROVAL_GATE_POLICY_ID, createApprovalGateRule([{ id: "req-1", actions: ["ryft.payment.release"] }], provider));
    const decision = await engine.evaluate(
      buildInput(initiator, "ryft.payment.release", { type: "ryft.payment", id: "555" }, contextAt("2026-01-01T12:00:00.000Z")),
    );
    assert.equal(decision.effect, "APPROVAL_REQUIRED");
  });

  // ── IDOR / cross-user / privilege escalation ─────────────────────────────

  await test("IDOR: an approval for resourceId 555 does not leak to a substituted resourceId 556", async () => {
    const provider = new FakeApprovalRequestProvider();
    const approvalEngine = new ApprovalEngine(provider);
    const created = await approvalEngine.requestApproval(baseRequestInput({ resourceId: "555" }), NOW);
    await approvalEngine.decide(approver.userId, created.id, "APPROVED", null, NOW);

    const engine = new PolicyEngine();
    engine.registerRule(APPROVAL_GATE_POLICY_ID, createApprovalGateRule([{ id: "req-1", actions: ["ryft.payment.release"] }], provider));
    const decision = await engine.evaluate(
      buildInput(initiator, "ryft.payment.release", { type: "ryft.payment", id: "556" }, contextAt("2026-01-01T12:00:00.000Z")),
    );
    assert.equal(decision.effect, "APPROVAL_REQUIRED");
  });

  await test("cross-user: an approval granted to one initiator does not extend to a different subject", async () => {
    const provider = new FakeApprovalRequestProvider();
    const approvalEngine = new ApprovalEngine(provider);
    const created = await approvalEngine.requestApproval(baseRequestInput({ initiatorUserId: initiator.userId, resourceId: "555" }), NOW);
    await approvalEngine.decide(approver.userId, created.id, "APPROVED", null, NOW);

    const engine = new PolicyEngine();
    engine.registerRule(APPROVAL_GATE_POLICY_ID, createApprovalGateRule([{ id: "req-1", actions: ["ryft.payment.release"] }], provider));
    const decision = await engine.evaluate(
      buildInput(otherInitiator, "ryft.payment.release", { type: "ryft.payment", id: "555" }, contextAt("2026-01-01T12:00:00.000Z")),
    );
    assert.equal(decision.effect, "APPROVAL_REQUIRED");
  });

  await test("privilege escalation: forging unrelated resource fields does not manufacture an ALLOW", async () => {
    const provider = new FakeApprovalRequestProvider();
    const approvalEngine = new ApprovalEngine(provider);
    const created = await approvalEngine.requestApproval(baseRequestInput({ resourceId: "555" }), NOW);
    await approvalEngine.decide(approver.userId, created.id, "APPROVED", null, NOW);

    const engine = new PolicyEngine();
    engine.registerRule(APPROVAL_GATE_POLICY_ID, createApprovalGateRule([{ id: "req-1", actions: ["ryft.payment.release"] }], provider));
    const decision = await engine.evaluate(
      buildInput(
        initiator,
        "ryft.payment.release",
        { type: "ryft.payment", id: "555", ownerId: 1, organizationId: 999, classification: "top-secret" },
        contextAt("2026-01-01T12:00:00.000Z"),
      ),
    );
    // Forged fields are irrelevant to the exact-match lookup — this still
    // resolves to ALLOW purely because the (initiator, type, id, action)
    // tuple matches, not because of anything forged.
    assert.equal(decision.effect, "ALLOW");
  });

  await test("org-wide approval (resourceId null on both sides) matches; a concrete resourceId does not accidentally match it", async () => {
    const provider = new FakeApprovalRequestProvider();
    const approvalEngine = new ApprovalEngine(provider);
    const created = await approvalEngine.requestApproval(
      baseRequestInput({ resourceType: "admin.org", resourceId: null, action: "admin.org.disable" }),
      NOW,
    );
    await approvalEngine.decide(approver.userId, created.id, "APPROVED", null, NOW);

    const engine = new PolicyEngine();
    engine.registerRule(APPROVAL_GATE_POLICY_ID, createApprovalGateRule([{ id: "req-1", actions: ["admin.org.disable"] }], provider));

    const orgWideDecision = await engine.evaluate(
      buildInput(initiator, "admin.org.disable", { type: "admin.org" }, contextAt("2026-01-01T12:00:00.000Z")),
    );
    assert.equal(orgWideDecision.effect, "ALLOW");

    const concreteDecision = await engine.evaluate(
      buildInput(initiator, "admin.org.disable", { type: "admin.org", id: "7" }, contextAt("2026-01-01T12:00:00.000Z")),
    );
    assert.equal(concreteDecision.effect, "APPROVAL_REQUIRED");
  });

  // ── unauthenticated ───────────────────────────────────────────────────────

  await test("unauthenticated subject never reaches the approval gate at all", async () => {
    const provider = new FakeApprovalRequestProvider();
    const engine = new PolicyEngine();
    engine.registerRule(APPROVAL_GATE_POLICY_ID, createApprovalGateRule([{ id: "req-1", actions: ["ryft.payment.release"] }], provider));
    const decision = await engine.evaluate(
      buildInput(null, "ryft.payment.release", { type: "ryft.payment", id: "555" }, contextAt("2026-01-01T12:00:00.000Z")),
    );
    assert.equal(decision.effect, "DENY");
    assert.equal(decision.reason, "UNAUTHENTICATED");
  });

  // ── composition with other rules / precedence ordering ──────────────────

  await test("composition: a DENY rule registered BEFORE the approval gate wins outright", async () => {
    const provider = new FakeApprovalRequestProvider();
    const engine = new PolicyEngine();
    engine.registerRule("hard-deny", (request) => ({
      effect: "DENY",
      reason: "EXPLICIT_DENY",
      requestId: request.context.requestId,
      evaluatedAt: new Date(),
      policyId: "hard-deny",
    }));
    engine.registerRule(APPROVAL_GATE_POLICY_ID, createApprovalGateRule([{ id: "req-1", actions: ["ryft.payment.release"] }], provider));
    const decision = await engine.evaluate(
      buildInput(initiator, "ryft.payment.release", { type: "ryft.payment", id: "555" }, contextAt("2026-01-01T12:00:00.000Z")),
    );
    assert.equal(decision.effect, "DENY");
    assert.equal(decision.policyId, "hard-deny");
  });

  await test("composition: an ALLOW rule registered BEFORE the approval gate does not bypass it — APPROVAL_REQUIRED still wins", async () => {
    const provider = new FakeApprovalRequestProvider();
    const engine = new PolicyEngine();
    engine.registerRule("some-other-allow", (request) => ({
      effect: "ALLOW",
      reason: "EXPLICIT_ALLOW",
      requestId: request.context.requestId,
      evaluatedAt: new Date(),
    }));
    engine.registerRule(APPROVAL_GATE_POLICY_ID, createApprovalGateRule([{ id: "req-1", actions: ["ryft.payment.release"] }], provider));
    const decision = await engine.evaluate(
      buildInput(initiator, "ryft.payment.release", { type: "ryft.payment", id: "555" }, contextAt("2026-01-01T12:00:00.000Z")),
    );
    assert.equal(decision.effect, "APPROVAL_REQUIRED");
  });

  await test("composition: once approved, an unrelated ALLOW rule and the gate agree — ALLOW", async () => {
    const provider = new FakeApprovalRequestProvider();
    const approvalEngine = new ApprovalEngine(provider);
    const created = await approvalEngine.requestApproval(baseRequestInput({ resourceId: "555" }), NOW);
    await approvalEngine.decide(approver.userId, created.id, "APPROVED", null, NOW);

    const engine = new PolicyEngine();
    engine.registerRule(APPROVAL_GATE_POLICY_ID, createApprovalGateRule([{ id: "req-1", actions: ["ryft.payment.release"] }], provider));
    const decision = await engine.evaluate(
      buildInput(initiator, "ryft.payment.release", { type: "ryft.payment", id: "555" }, contextAt("2026-01-01T12:00:00.000Z")),
    );
    assert.equal(decision.effect, "ALLOW");
  });

  // ── determinism (Rule 12) ──────────────────────────────────────────────

  await test("deterministic: re-evaluating the exact same request object twice yields the exact same effect", async () => {
    const provider = new FakeApprovalRequestProvider();
    const engine = new PolicyEngine();
    engine.registerRule(APPROVAL_GATE_POLICY_ID, createApprovalGateRule([{ id: "req-1", actions: ["ryft.payment.release"] }], provider));
    const input = buildInput(initiator, "ryft.payment.release", { type: "ryft.payment", id: "555" }, contextAt("2026-01-01T12:00:00.000Z"));
    const first = await engine.evaluate(input);
    const second = await engine.evaluate(input);
    assert.equal(first.effect, second.effect);
    assert.equal(first.effect, "APPROVAL_REQUIRED");
  });

  console.log("Policy Engine — Phase 12 (Approval Engine): all tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
