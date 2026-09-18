/**
 * lib/policy/assurance/assurance-rule.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 09 (Authentication
 * Assurance), sub-phase 9A.
 *
 * `createAssuranceRule()` builds this engine's seventh real `PolicyRule`
 * (after `rbac-rule.ts`, `ownership-rule.ts`, `explicit-grant-rule.ts`,
 * `organization-access-rule.ts`, `rebac-rule.ts`, `abac-rule.ts`). It
 * answers a narrower question than any of those: "does this action require
 * MORE assurance than this subject currently has?" — never "is this
 * subject allowed to do this at all".
 *
 * ── A GATE, not a grant path — this rule NEVER returns ALLOW ─────────────
 * Every other rule in this engine either allows-or-abstains
 * (`ownership-rule.ts`, `organization-access-rule.ts`, `rebac-rule.ts`) or
 * can allow/deny/abstain (`rbac-rule.ts`, `explicit-grant-rule.ts`,
 * `abac-rule.ts`). `createAssuranceRule()` can only ever STEP_UP or
 * abstain — meeting an assurance requirement is necessary but never
 * sufficient for access; it says nothing about role/ownership/relationship/
 * attributes, so it must never manufacture an ALLOW those other rules
 * didn't themselves produce. This mirrors the roadmap's own framing
 * exactly: "Sensitive operations can require minimum assurance" is a
 * REQUIREMENT layered onto an otherwise-authorized action, not an
 * independent grant path — the same relationship Phase 10's risk engine
 * will have to authorization ("Risk Engine = calculates risk; Policy
 * Engine = decides what to do with risk" — this rule is the "what to do"
 * half of that same shape, applied to assurance instead of risk).
 *
 * ── STEP_UP short-circuits regardless of which engine runs it ─────────────
 * `policy-engine.ts`'s `evaluateCore()` and `precedence-engine.ts`'s
 * `evaluate()` both treat `STEP_UP`/`APPROVAL_REQUIRED` as an immediate,
 * non-combinable outcome (see each file's own header) — the moment this
 * rule returns `stepUp()`, evaluation stops right there, before any lower-
 * priority rule (in `PolicyEngine`) or lower-tier rule (in
 * `PrecedenceEngine`) gets a chance to ALLOW. This is deliberate: a
 * subject who lacks the required assurance for a sensitive action should
 * never be silently allowed through by some OTHER, assurance-blind grant
 * path that happens to also cover the same action.
 *
 * ── Which tier this belongs to in a `PrecedenceEngine` is NOT decided
 *    here ─────────────────────────────────────────────────────────────────
 * `precedence-tiers.ts`'s `PRECEDENCE_ORDER` (Phase 08) has no dedicated
 * "assurance" tier — the roadmap's own Phase 08 precedence list and Phase
 * 09 assurance-level list are two independent axes, and nothing in either
 * roadmap section says how they nest. Same posture `precedence-engine.ts`'s
 * header already established for ABAC: tier assignment is a registration-
 * time choice made by whoever wires up a specific `PrecedenceEngine`
 * instance, not something this file or `precedence-tiers.ts` hardcodes.
 * A caller using the flat `PolicyEngine` instead doesn't need to make that
 * choice at all — `registerRule()` there has no tier concept.
 *
 * ── Action matching reuses RBAC's grammar, not a new one ──────────────────
 * Same reuse `abac-rule.ts` already established for its own `actions`
 * field: `AssuranceRequirement.actions` (when present) is matched with
 * `rbac/permission-matcher.ts#permissionMatches()` — one "product.
 * resource.action" / trailing-wildcard grammar for "which actions does
 * this apply to" across the whole engine, not a second one invented here.
 *
 * ── Highest-requirement-wins when more than one requirement matches ──────
 * If two registered `AssuranceRequirement`s both apply to the same action
 * (e.g. a broad `"ryft.payment.*"` rule at L3 and a narrower
 * `"ryft.payment.approve"` rule at L4), this rule evaluates the subject
 * against the STRICTEST (highest) matching minimum, not merely the first
 * one found in list order — a caller should never be able to satisfy a
 * demanding requirement by having a looser, also-matching one happen to be
 * registered earlier. If the subject's actual level clears every matching
 * requirement, the rule abstains; the reported STEP_UP failure message
 * always names the single requirement that was actually unmet (the
 * strictest one), never a vaguer "something didn't match".
 */

import { stepUp } from "../authorization-decision";
import type { PolicyRule } from "../policy-engine";
import { permissionMatches } from "../rbac/permission-matcher";
import { assuranceLevelMeetsMinimum, computeAssuranceLevel } from "./assurance-level";
import { ASSURANCE_LEVEL_LABELS, ASSURANCE_RANK, assertValidAssuranceLevel, type AssuranceLevel } from "./types";

/** Stable id this rule should be registered under
 *  (`engine.registerRule(ASSURANCE_POLICY_ID, createAssuranceRule(reqs))` /
 *  `precedenceEngine.registerRule(ASSURANCE_POLICY_ID, tier, createAssuranceRule(reqs))`). */
export const ASSURANCE_POLICY_ID = "assurance";

/**
 * One "this action needs at least this much assurance" statement, as
 * `createAssuranceRule()` consumes it. Deliberately NOT persisted/
 * versioned/administered anywhere — same in-memory, caller-constructed
 * posture `AbacPolicyDefinition` (abac/types.ts) already established for
 * Phase 05; a future Phase 07-style registry entry could compile down to
 * this shape the same way a DSL-compiled `AbacPolicyDefinition` does, but
 * nothing in 9A builds that bridge (Rule 16).
 */
export interface AssuranceRequirement {
  /** Stable identifier for this individual statement (distinct from the
   *  rule's own registration id). Surfaced in the decision's `message` for
   *  audit/debugging, same role `AbacPolicyDefinition.id` plays. */
  id: string;
  /** The minimum `AssuranceLevel` this action requires. Must be one of
   *  `ASSURANCE_LEVEL_ORDER`'s 6 values — `createAssuranceRule()` throws
   *  immediately at construction if not (see file's `assertValidAssuranceLevel`
   *  import), same fail-loud-at-registration posture
   *  `PrecedenceEngine.registerRule()` established for tier strings. */
  minimumLevel: AssuranceLevel;
  /** Optional action pattern(s) this requirement applies to, using
   *  `permissionMatches()`'s grammar (e.g. `["ryft.payment.approve"]`).
   *  Omit to apply to every action regardless of what it is — same
   *  "no actions list means every action" default `abac-rule.ts`'s
   *  `policyAppliesToAction()` already uses. */
  actions?: string[];
  /** Optional human-readable detail surfaced on a resulting STEP_UP
   *  decision's `message`. Never put secrets/PII here — same rule as
   *  everywhere else in this engine. */
  message?: string;
}

function requirementAppliesToAction(requirement: AssuranceRequirement, action: string): boolean {
  if (!requirement.actions || requirement.actions.length === 0) return true;
  return requirement.actions.some((pattern) => permissionMatches(pattern, action));
}

/** The single strictest (highest-`minimumLevel`) requirement among those
 *  that apply to `action`, or `undefined` if none do. Ties (two matching
 *  requirements naming the identical `minimumLevel`) keep whichever was
 *  registered first — their required level is the same either way, so
 *  which one's `id`/`message` ends up on the decision is immaterial to the
 *  actual gate, only to the audit trail's wording. */
function strictestMatchingRequirement(
  requirements: readonly AssuranceRequirement[],
  action: string,
): AssuranceRequirement | undefined {
  let strictest: AssuranceRequirement | undefined;
  for (const requirement of requirements) {
    if (!requirementAppliesToAction(requirement, action)) continue;
    if (!strictest || ASSURANCE_RANK[requirement.minimumLevel] > ASSURANCE_RANK[strictest.minimumLevel]) {
      strictest = requirement;
    }
  }
  return strictest;
}

/**
 * Builds a `PolicyRule` that STEP_UPs when `action` matches a registered
 * `AssuranceRequirement` the subject's computed `AssuranceLevel`
 * (`computeAssuranceLevel()`) doesn't meet, and otherwise abstains (see
 * file header — this rule never produces ALLOW). Throws immediately, at
 * construction time, if any `requirement.minimumLevel` is not a real
 * `AssuranceLevel` — a typo must fail loudly before this rule is ever
 * registered, not silently compare against `undefined` on every request.
 */
export function createAssuranceRule(requirements: readonly AssuranceRequirement[]): PolicyRule {
  for (const requirement of requirements) {
    assertValidAssuranceLevel(requirement.minimumLevel);
  }

  return (request) => {
    const subject = request.subject;
    // Defensive only — see abac-rule.ts / rbac-rule.ts for why this branch
    // is unreachable in practice (policy-engine.ts already denies
    // UNAUTHENTICATED before any rule runs).
    if (!subject) return null;

    if (requirements.length === 0) return null; // nothing registered — abstain, not a decision

    const requirement = strictestMatchingRequirement(requirements, request.action);
    if (!requirement) return null; // no requirement covers this action — abstain

    const actualLevel = computeAssuranceLevel(subject, request.context);
    if (assuranceLevelMeetsMinimum(actualLevel, requirement.minimumLevel)) {
      return null; // requirement satisfied — this rule has nothing further to add, abstain
    }

    return stepUp(request, {
      policyId: ASSURANCE_POLICY_ID,
      // Phase 14 (Policy Simulation): surface the actual unmet minimum as a
      // structured field, not only inside `message`'s free-form text — see
      // ../authorization-decision.ts's `stepUp()` / ../types.ts's
      // `AuthorizationDecision.requiredAssurance` doc comments.
      requiredAssurance: requirement.minimumLevel,
      message:
        requirement.message ??
        `action "${request.action}" requires assurance level ${requirement.minimumLevel} ` +
          `(${ASSURANCE_LEVEL_LABELS[requirement.minimumLevel]}); subject is at ${actualLevel} ` +
          `(${ASSURANCE_LEVEL_LABELS[actualLevel]})`,
    });
  };
}
