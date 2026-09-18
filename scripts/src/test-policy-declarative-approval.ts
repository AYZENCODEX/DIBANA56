/**
 * scripts/src/test-policy-declarative-approval.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 21B (Policy Test
 * Framework — coverage), Approval Engine (Phase 12).
 *
 * Declarative five-category coverage for `createApprovalGateRule()` in
 * isolation. Unlike `assurance-rule.ts`/`risk-rule.ts`, this rule CAN
 * return ALLOW on its own (a live `APPROVED` row IS the grant — see
 * approval-gate-rule.ts's own header), so no companion ownership rule is
 * needed here the way the assurance/locked-resource/risk suites need one.
 *
 *   - happy_path: a registered requirement matches the action, and a live
 *     `APPROVED` request covers this exact
 *     `(initiator, resourceType, resourceId, action)` tuple → ALLOW.
 *   - negative_path: the same requirement matches, but no approval row
 *     exists at all → `APPROVAL_REQUIRED`.
 *   - boundary: an approval row exists for this tuple but in `REJECTED`
 *     state (not `APPROVED`) — treated identically to "never requested at
 *     all" per the rule's own header ("a REJECTED or EXPIRED prior
 *     request simply means no live APPROVED row exists yet") — still
 *     `APPROVAL_REQUIRED`, never a permanent DENY.
 *   - privilege_escalation: an `APPROVED` row exists for subject 1 on
 *     resource "1"; subject 2 (no approval of their own on file) requests
 *     the identical action on the identical resource — `findApprovedRequest`
 *     is keyed on `initiatorUserId` as part of the exact-match tuple, so
 *     one subject's approval never grants a different subject's request.
 *   - tenant_isolation: this rule has no organizational dimension at all
 *     (`organizationId` is "carried for audit/context only — never
 *     matched against", per approval/types.ts's own header) — a
 *     same-organization subject with no approval on file still gets
 *     `APPROVAL_REQUIRED` exactly as any other subject would.
 *
 * Run: npx tsx scripts/src/test-policy-declarative-approval.ts
 */

import {
  PolicyEngine,
  createApprovalGateRule,
  assertPolicyTestSuitePassed,
  runPolicyTestSuite,
  type ApprovalRequestProvider,
  type ApprovalRequestRecord,
  type ApprovalAuditEntry,
  type ApprovalState,
  type CreateApprovalRequestInput,
  type PolicyTestSuite,
} from "../../artifacts/api-server/src/lib/policy";

class FakeApprovalRequestProvider implements ApprovalRequestProvider {
  private readonly rows: ApprovalRequestRecord[] = [];
  private nextId = 1;

  seed(
    initiatorUserId: number,
    resourceType: string,
    resourceId: string | null,
    action: string,
    state: ApprovalState,
  ): void {
    this.rows.push({
      id: this.nextId++,
      initiatorUserId,
      resourceType,
      resourceId,
      action,
      organizationId: null,
      reason: "test fixture",
      state,
      expiresAt: new Date("2099-01-01T00:00:00.000Z"),
      createdAt: new Date(),
      decidedBy: state === "APPROVED" || state === "REJECTED" ? 999 : null,
      decidedAt: state === "APPROVED" || state === "REJECTED" ? new Date() : null,
      decisionReason: state === "APPROVED" ? "approved by security lead" : null,
    });
  }

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
    const row = this.rows.find(
      (r) =>
        r.state === "APPROVED" &&
        r.initiatorUserId === initiatorUserId &&
        r.resourceType === resourceType &&
        r.resourceId === resourceId &&
        r.action === action,
    );
    return row ? { ...row } : null;
  }

  async updateState(
    id: number | string,
    next: ApprovalState,
    decision?: { decidedBy: number | null; decisionReason?: string | null },
  ): Promise<ApprovalRequestRecord> {
    const row = this.rows.find((r) => r.id === id);
    if (!row) throw new Error("not found");
    row.state = next;
    if (decision) {
      row.decidedBy = decision.decidedBy;
      row.decisionReason = decision.decisionReason ?? null;
      row.decidedAt = new Date();
    }
    return { ...row };
  }

  async recordAudit(_entry: ApprovalAuditEntry): Promise<void> {
    // no-op — audit trail is ApprovalEngine's own concern, not this rule's.
  }
}

async function main() {
  console.log("Policy Test Framework — Phase 21B declarative coverage: approval gate");

  const provider = new FakeApprovalRequestProvider();
  provider.seed(1, "sylo.vault_item", "1", "sylo.vault.delete", "APPROVED");
  provider.seed(3, "sylo.vault_item", "3", "sylo.vault.delete", "REJECTED");

  const engine = new PolicyEngine();
  engine.registerRule(
    "approval-gate",
    createApprovalGateRule([{ id: "vault-delete-approval", actions: ["sylo.vault.delete"] }], provider),
  );

  const subject = (userId: number, organizationId: number | null = null) => ({
    userId,
    role: "member",
    authType: "session" as const,
    organizationId,
  });

  const suite: PolicyTestSuite = {
    policyId: "approval-gate",
    cases: [
      {
        name: "a live APPROVED request covering the exact tuple grants the action",
        category: "happy_path",
        given: { subject: subject(1), resource: { type: "sylo.vault_item", id: "1" } },
        when: { action: "sylo.vault.delete" },
        then: { effect: "ALLOW", reason: "EXPLICIT_ALLOW", policyId: "approval-gate" },
      },
      {
        name: "an action requiring approval with no approval row on file at all → APPROVAL_REQUIRED",
        category: "negative_path",
        given: { subject: subject(2), resource: { type: "sylo.vault_item", id: "2" } },
        when: { action: "sylo.vault.delete" },
        then: { effect: "APPROVAL_REQUIRED", reason: "APPROVAL_REQUIRED", policyId: "approval-gate" },
      },
      {
        name: "a REJECTED prior request is treated the same as never having requested at all — still APPROVAL_REQUIRED, not a permanent DENY",
        category: "boundary",
        given: { subject: subject(3), resource: { type: "sylo.vault_item", id: "3" } },
        when: { action: "sylo.vault.delete" },
        then: { effect: "APPROVAL_REQUIRED", reason: "APPROVAL_REQUIRED", policyId: "approval-gate" },
      },
      {
        name: "subject 1's APPROVED request on resource 1 does not grant subject 2 the identical action on the identical resource",
        category: "privilege_escalation",
        given: { subject: subject(2), resource: { type: "sylo.vault_item", id: "1" } },
        when: { action: "sylo.vault.delete" },
        then: { effect: "APPROVAL_REQUIRED", reason: "APPROVAL_REQUIRED", policyId: "approval-gate" },
      },
      {
        name: "organizationId is never matched against — a same-organization subject with no approval on file still gets APPROVAL_REQUIRED",
        category: "tenant_isolation",
        given: {
          subject: subject(4, 100),
          resource: { type: "sylo.vault_item", id: "4", organizationId: 100 },
        },
        when: { action: "sylo.vault.delete" },
        then: { effect: "APPROVAL_REQUIRED", reason: "APPROVAL_REQUIRED", policyId: "approval-gate" },
      },
    ],
  };

  const result = await runPolicyTestSuite(engine, suite);
  assertPolicyTestSuitePassed(result);

  console.log("\nAll Phase 21B approval-gate declarative coverage tests passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
