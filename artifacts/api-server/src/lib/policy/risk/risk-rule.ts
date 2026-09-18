/**
 * lib/policy/risk/risk-rule.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 10 (Risk-Aware
 * Authorization), sub-phase 10A.
 *
 * `createRiskRule()` builds this engine's eighth real `PolicyRule` (after
 * `rbac-rule.ts`, `ownership-rule.ts`, `explicit-grant-rule.ts`,
 * `organization-access-rule.ts`, `rebac-rule.ts`, `abac-rule.ts`,
 * `assurance/assurance-rule.ts`). It implements the roadmap's own Phase 10
 * framing verbatim:
 *
 *   "Risk Engine = calculates risk. Policy Engine = decides what to do
 *    with risk."
 *
 * `Subject.riskLevel` (`../types.ts`, added in Phase 05/ABAC — "Deliberately
 * left for the Risk Engine (Phase 10) to populate") is the CALCULATION —
 * something a future PIP-layer risk engine writes. This rule is the
 * DECISION half: it reads that already-computed value and turns it into
 * the roadmap's own 3-way outcome —
 *
 *   LOW / unset  → normal authorization (abstain — this rule has no
 *                  objection; other rules decide the actual grant)
 *   MEDIUM       → STEP_UP (a stronger authentication challenge, not an
 *                  outright block)
 *   HIGH         → DENY, unconditionally, regardless of any role/
 *                  ownership/relationship/attribute/assurance grant
 *
 * It never computes risk itself — no IP/device/velocity/anomaly logic
 * lives here (that is Phase 10's OWN later sub-phase, mirroring how 9A
 * shipped `computeAssuranceLevel()` before 9B wired real data into its
 * inputs). This file only maps an already-resolved `riskLevel` to a
 * decision, the same narrow "given the field, decide" contract 9A's
 * `createAssuranceRule()` established for assurance.
 *
 * ── "Never allow the client to choose its own risk level" ────────────────
 * The roadmap states this as its own explicit Phase 10 rule. This rule
 * enforces it by construction, not by a runtime check: it reads
 * `request.subject.riskLevel` — part of the already-validated,
 * server-constructed `Subject` (see `types.ts`'s own doc comment: "Not
 * modeled by the current schema yet ... nothing in this codebase sets it
 * yet") — never anything from `request.context.extra` or any other field
 * a caller could plausibly smuggle client input through. There is no code
 * path here that reads a risk level from the request body, a header, or
 * any other client-supplied value.
 *
 * ── HIGH risk is a GATE like assurance, but the ONE exception: it can
 *    DENY, not just STEP_UP ─────────────────────────────────────────────
 * `assurance/assurance-rule.ts`'s `createAssuranceRule()` never returns
 * ALLOW — deliberately, since meeting an assurance bar says nothing about
 * whether the action itself is permitted (see that file's own header).
 * This rule keeps that same "never ALLOWs" discipline (see
 * `RISK_MEDIUM`/`RISK_LOW` branches below — both abstain, never grant) but
 * the roadmap's own Phase 10 line item explicitly names DENY as HIGH
 * risk's outcome, not merely STEP_UP — a sufficiently risky request should
 * be refused outright, not merely asked to authenticate more strongly
 * (stronger authentication does not un-risk a request whose risk signal
 * (e.g. a known-compromised IP, an impossible-travel pattern) has nothing
 * to do with how strongly the CREDENTIAL was proven). This is the one
 * asymmetry between this rule and `createAssuranceRule()` — intentional,
 * not an oversight, and traceable directly to the roadmap's own wording.
 *
 * ── DENY short-circuits regardless of which engine runs it, same as
 *    assurance's STEP_UP ─────────────────────────────────────────────────
 * `policy-engine.ts`'s deny-overrides algorithm and `precedence-engine.ts`'s
 * tiered walk both already treat an explicit DENY as immediately
 * decisive/short-circuiting (see each file's own header) — a HIGH-risk
 * DENY from this rule can never be silently overridden by some other,
 * risk-blind ALLOW path, the same guarantee 9A's STEP_UP already has
 * against being bypassed.
 *
 * ── Which tier this belongs to in a `PrecedenceEngine` is NOT decided
 *    here — same posture `assurance-rule.ts`/`precedence-engine.ts` already
 *    established for ABAC and assurance: `precedence-tiers.ts`'s
 *    `PRECEDENCE_ORDER` (Phase 08) has no dedicated "risk" tier (the
 *    roadmap's own precedence list and risk-level list are independent
 *    axes) — whoever wires up a specific `PrecedenceEngine` instance
 *    decides where this rule's DENY should rank against
 *    EMERGENCY_SECURITY_DENY/GLOBAL_DENY/etc. A flat `PolicyEngine`
 *    doesn't need that choice at all.
 */

import { deny, stepUp } from "../authorization-decision";
import type { PolicyRule } from "../policy-engine";

/** Stable id this rule should be registered under
 *  (`engine.registerRule(RISK_POLICY_ID, createRiskRule())` /
 *  `precedenceEngine.registerRule(RISK_POLICY_ID, tier, createRiskRule())`). */
export const RISK_POLICY_ID = "risk";

export interface RiskRuleOptions {
  /** Optional human-readable detail appended to a HIGH-risk DENY's
   *  `message`. Never put secrets/PII here — same rule as everywhere else
   *  in this engine. */
  denyMessage?: string;
  /** Optional human-readable detail appended to a MEDIUM-risk STEP_UP's
   *  `message`. */
  stepUpMessage?: string;
}

/**
 * Builds a `PolicyRule` implementing the roadmap's own LOW/MEDIUM/HIGH →
 * normal/STEP_UP/DENY mapping (see file header). `riskLevel` unset (no
 * risk engine has run yet, or it abstained) is treated the same as LOW —
 * "no risk objection on file" — rather than assumed HIGH; a missing signal
 * must never fail closed to something the roadmap didn't ask for, and
 * every other abstain-capable rule in this engine already treats an
 * absent input as "no opinion", not "deny" (see e.g. `abac-rule.ts`'s
 * "ABSTAIN when nothing matches"). Never throws.
 */
export function createRiskRule(options: RiskRuleOptions = {}): PolicyRule {
  return (request) => {
    const subject = request.subject;
    // Defensive only — see abac-rule.ts / assurance-rule.ts for why this
    // branch is unreachable in practice (policy-engine.ts already denies
    // UNAUTHENTICATED before any rule runs).
    if (!subject) return null;

    const riskLevel = subject.riskLevel;

    if (riskLevel === "high") {
      return deny(request, "HIGH_RISK_DENIED", {
        policyId: RISK_POLICY_ID,
        message: options.denyMessage ?? "subject's computed risk level is HIGH; denying regardless of any other grant",
      });
    }

    if (riskLevel === "medium") {
      return stepUp(request, {
        policyId: RISK_POLICY_ID,
        message: options.stepUpMessage ?? "subject's computed risk level is MEDIUM; stronger authentication is required before this can proceed",
      });
    }

    // "low" or unset — no risk objection on file. Abstain: this rule never
    // manufactures an ALLOW (see file header), it only ever gates.
    return null;
  };
}
