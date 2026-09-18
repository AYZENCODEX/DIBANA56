/**
 * lib/policy/resource/locked-resource-rule.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 03 (Resource / Ownership
 * Authorization), sub-phase 3A.
 *
 * `createLockedResourceRule()` implements the roadmap's "locked-resource
 * restrictions" line item. Unlike `ownership-rule.ts`, this rule DENIES
 * explicitly rather than abstaining — a locked resource is a hard stop,
 * not merely "no opinion". Deny-overrides combining (policy-engine.ts)
 * means this rule's DENY always wins over ownership-rule.ts's ALLOW (or
 * any RBAC ALLOW) regardless of registration order, which is exactly the
 * intended behavior: "this resource is locked" must be able to override
 * an owner's normal access, not just add another vote.
 *
 * ── Why this doesn't hardcode "read is always safe" ─────────────────────
 * The roadmap gives no fixed definition of which actions remain safe on a
 * locked resource, and it varies by product (a locked Sylo vault item
 * might still allow a read while a locked Ryft payment might not allow
 * even that). Rather than guess a cross-product convention, this rule
 * takes an explicit `exemptActions` allow-list at construction time — the
 * call site (one per product/domain, wiring this rule into its own
 * `PolicyEngine` instance or registration) decides what "safe while
 * locked" means for its own resource type. The default (no options) is
 * the strictest, safest behavior: EVERY action is blocked on a locked
 * resource.
 *
 * ── Scope note (see ownership-rule.ts's header for the shared rationale) ──
 * `resource.locked` is a caller-supplied fact, not something this rule
 * fetches — same trust boundary as `ownerId`.
 */

import { deny } from "../authorization-decision";
import type { PolicyRule } from "../policy-engine";

/** Stable id this rule should be registered under. */
export const LOCKED_RESOURCE_POLICY_ID = "resource-lock";

export interface LockedResourceRuleOptions {
  /** Actions that remain permitted even while the resource is locked (e.g.
   *  a read-only action for that product/resource). Compared against
   *  `request.action` verbatim — pass the exact `product.resource.action`
   *  strings (or legacy opaque action strings) this deployment considers
   *  safe. Defaults to empty: every action is blocked while locked. */
  exemptActions?: Iterable<string>;
}

export function createLockedResourceRule(options: LockedResourceRuleOptions = {}): PolicyRule {
  const exempt = new Set(options.exemptActions ?? []);

  return (request) => {
    if (request.resource.locked !== true) return null; // not locked — abstain, this rule has no opinion

    if (exempt.has(request.action)) return null; // explicitly exempted — abstain, let other rules decide

    return deny(request, "RESOURCE_LOCKED", {
      policyId: LOCKED_RESOURCE_POLICY_ID,
      message: `resource is locked; action "${request.action}" is not permitted while locked`,
    });
  };
}
