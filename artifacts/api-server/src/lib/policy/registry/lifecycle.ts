/**
 * lib/policy/registry/lifecycle.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 07 (Policy Registry / PAP).
 *
 * The single source of truth for which `PolicyStatus` → `PolicyStatus`
 * transitions are legal. Pure data + one pure function — no DB, no
 * authorization, no audit-writing (those are policy-registry.ts's job,
 * layered on top). Kept separate so the transition graph itself can be
 * unit-tested exhaustively (every (from, to) pair) without constructing a
 * `PolicyRegistry` or any provider at all — same "the rule and its
 * enforcement are different files" split ../rbac/permission-matcher.ts
 * (the rule) vs ../rbac/rbac-rule.ts (the enforcement) already establishes.
 *
 * Roadmap's own lifecycle: `DRAFT → TESTING → APPROVED → ACTIVE →
 * DISABLED → ARCHIVED`. Read literally that is a straight line, but a
 * straight line alone can't express real operational needs the roadmap's
 * other rules already imply:
 *   - a TESTING policy that fails review must be able to go back to DRAFT
 *     for edits (not just forward or to ARCHIVED — otherwise a single
 *     rejected draft would have to be abandoned and re-created from
 *     scratch every time, which is not what "TESTING" as a distinct status
 *     from "the final answer" is for).
 *   - an ACTIVE policy must be able to go to DISABLED (an operational
 *     "turn it off without losing it, might turn it back on") — a live
 *     policy that misbehaves cannot be forced straight to the terminal
 *     ARCHIVED state as its only "make it stop" option.
 *   - a DISABLED policy must be re-activatable (DISABLED → ACTIVE) — that
 *     is the entire point of DISABLED existing as its own state distinct
 *     from ARCHIVED.
 *   - ARCHIVED is genuinely terminal — nothing transitions out of it.
 *     "Undo an archive" is deliberately not modeled: reactivating old
 *     intent is `createNewVersion()`'s job (a fresh DRAFT, reviewed again
 *     from scratch), not a shortcut back into an already-archived row's
 *     history (Rule 11: versioned, not rewritten).
 *   - every status may transition to ARCHIVED directly — "retire this,
 *     I don't want it considered anymore" must always be available
 *     regardless of where a policy currently sits in the pipeline.
 */

import type { PolicyStatus } from "./types";
import { PolicyLifecycleError } from "./errors";

/** `LIFECYCLE_TRANSITIONS[from]` = the set of `to` values legal from
 *  `from`. Read this table, do not special-case transitions inline
 *  elsewhere — see policy-registry.ts's `transitionStatus()`. */
export const LIFECYCLE_TRANSITIONS: Readonly<Record<PolicyStatus, readonly PolicyStatus[]>> = {
  DRAFT: ["TESTING", "ARCHIVED"],
  TESTING: ["APPROVED", "DRAFT", "ARCHIVED"],
  APPROVED: ["ACTIVE", "ARCHIVED"],
  ACTIVE: ["DISABLED", "ARCHIVED"],
  DISABLED: ["ACTIVE", "ARCHIVED"],
  ARCHIVED: [],
};

/** Statuses that additionally require strong authentication assurance on
 *  the acting session (Rule 13: "Sensitive operations must support
 *  stronger authentication assurance") — today, only activating a policy
 *  (making its rule content live against real traffic). Approval
 *  (TESTING → APPROVED) is gated by a SEPARATE mechanism — the
 *  `admin.policy.approve` permission plus the no-self-approval check — not
 *  assurance, since it is a distinct-actor requirement rather than a
 *  distinct-authentication-strength one. */
export const SENSITIVE_TRANSITIONS: ReadonlySet<PolicyStatus> = new Set<PolicyStatus>(["ACTIVE"]);

/** Throws `PolicyLifecycleError` if `from → to` is not in
 *  `LIFECYCLE_TRANSITIONS`. A no-op (same-status) transition is also
 *  illegal — callers who mean "nothing changed" should simply not call
 *  `transitionStatus()` at all, so every recorded audit entry represents a
 *  real change (Rule 10: auditability). */
export function assertValidTransition(from: PolicyStatus, to: PolicyStatus): void {
  const allowed = LIFECYCLE_TRANSITIONS[from];
  if (!allowed || !allowed.includes(to)) {
    throw new PolicyLifecycleError(from, to);
  }
}
