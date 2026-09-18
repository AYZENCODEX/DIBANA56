/**
 * lib/policy/test-framework/types.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 21A (Policy Test
 * Framework — declarative model).
 *
 * Pure types. No DB, no Express — same discipline every other lib/policy/*
 * types.ts already follows (see e.g. ../assurance/types.ts's header).
 *
 * The roadmap's own Phase 21 section, verbatim:
 *
 *   "Declarative test model:
 *    GIVEN subject + resource + context
 *    WHEN action
 *    THEN decision
 *
 *    Every policy should have:
 *    - happy path
 *    - negative path
 *    - boundary cases
 *    - privilege escalation case
 *    - tenant isolation case"
 *
 * This sub-phase (21A) is the framework itself — the GIVEN/WHEN/THEN case
 * shape, the five-category vocabulary, and (./runner.ts) a runner that
 * evaluates a case against a real engine and reports pass/fail plus
 * category-coverage gaps. It does NOT yet rewrite every existing
 * `scripts/src/test-policy-*.ts` suite (RBAC, ownership, ReBAC, ABAC,
 * assurance, risk, temporary access, approval, SoD) into this declarative
 * shape with full five-category coverage — that is Phase 21B's work,
 * applying this framework across every already-shipped policy rule, one
 * rule at a time, each getting its own coverage review. Shipping the
 * framework and immediately claiming every rule is "covered" without
 * actually writing those cases would be exactly the kind of premature
 * completion Rule 16 (do not implement future phases prematurely) warns
 * against — this file only makes writing that coverage possible.
 *
 * ── `PolicyTestGiven`/`PolicyTestWhen` are `BuildAuthorizationRequestInput`,
 *    split at the roadmap's own GIVEN/WHEN seam ─────────────────────────
 * Same "never a second request shape" discipline
 * ../simulation/types.ts's own header already establishes for
 * `SimulationInput`: a declarative test case must ask the PDP the exact
 * same question `PolicyEngine.evaluate()`/`PrecedenceEngine.evaluate()`
 * already accept (`BuildAuthorizationRequestInput` —
 * ../authorization-request.ts), never a parallel, test-only shape that
 * could quietly drift from what real authorization calls actually build.
 * The roadmap phrases the model as "GIVEN subject + resource + context,
 * WHEN action" — `PolicyTestCase.given` holds `subject`/`resource`/
 * `context` and `PolicyTestCase.when` holds `action`, but together they
 * are still nothing more than `BuildAuthorizationRequestInput`'s own four
 * fields, split at that exact seam for declarative readability.
 *
 * ── `PolicyTestExpectation` matches on whatever the case cares about,
 *    nothing more ────────────────────────────────────────────────────────
 * Every field is optional except `effect` — a case asserting "this must
 * ALLOW" need not also pin down `policyId`/`reason`/`requiredAssurance`
 * if it doesn't care which rule fired, matching how every existing
 * `scripts/src/test-policy-*.ts` suite already asserts (`assert.equal`
 * on exactly the fields a given test cares about, never a full deep-equal
 * against the whole `AuthorizationDecision`). See ./runner.ts's own
 * header for exactly how each optional field is checked when present.
 *
 * ── The five categories are a closed, roadmap-verbatim vocabulary ────────
 * `PolicyTestCategory` is deliberately closed (not an arbitrary string) so
 * `./runner.ts`'s coverage check can be exhaustive: "does this suite have
 * at least one case in every required category" is only a meaningful
 * question against a fixed, known list. Adding a category later is a
 * breaking change to this type, same as `DecisionReasonCode`
 * (../decision-reasons.ts) being a closed union for the identical reason.
 */

import type { PolicyContext, ResourceRef, Subject, DecisionEffect } from "../types";
import type { DecisionReasonCode } from "../decision-reasons";
import type { CreatePolicyContextInput } from "../policy-context";

/** The roadmap's own "GIVEN subject + resource + context". `context` may
 *  be a fully-built `PolicyContext` or the `createPolicyContext()` input
 *  shape — identical flexibility `BuildAuthorizationRequestInput.context`
 *  (../authorization-request.ts) already offers, so a case author never
 *  has to hand-stamp `requestId`/`timestamp` just to write a test. Omit
 *  entirely for a fresh, auto-generated context (the common case — most
 *  policy rules do not key on context fields at all). */
export interface PolicyTestGiven {
  subject: Subject | null;
  resource: ResourceRef;
  context?: PolicyContext | CreatePolicyContextInput;
}

/** The roadmap's own "WHEN action". Kept as its own one-field interface,
 *  not folded into `PolicyTestGiven`, so a declarative case reads exactly
 *  like the roadmap's own GIVEN/WHEN/THEN prose when laid out — see any
 *  example in ./runner.ts's own header or the Phase 21A self-test. */
export interface PolicyTestWhen {
  action: string;
}

/**
 * The roadmap's own five verbatim coverage categories. `./runner.ts`'s
 * `runPolicyTestSuite()` reports which of these a suite is missing, so a
 * gap is a structured, checkable fact rather than something only a
 * careful reviewer might notice was never written.
 */
export type PolicyTestCategory =
  | "happy_path"
  | "negative_path"
  | "boundary"
  | "privilege_escalation"
  | "tenant_isolation";

/**
 * The roadmap's own "THEN decision" — but expectations, not a full
 * decision. `effect` is required (every case must say what it expects to
 * happen); every other field is an optional, exact-match assertion — see
 * file header's "matches on whatever the case cares about" note.
 */
export interface PolicyTestExpectation {
  effect: DecisionEffect;
  reason?: DecisionReasonCode;
  /** Which registered rule is expected to have decided this — checked
   *  against `decision.policyId` verbatim. Omit for cases that only care
   *  about the effect/reason, not which specific rule produced it. */
  policyId?: string;
  /** Checked against `decision.requiredAssurance` verbatim — meaningful
   *  only for `effect: "STEP_UP"` cases; harmless (simply won't match) if
   *  set on a case expecting a different effect. */
  requiredAssurance?: string;
}

/** One declarative GIVEN/WHEN/THEN case. `name` and `category` are both
 *  required — an anonymous or uncategorized case would defeat the whole
 *  point of this framework (readable intent, checkable coverage). */
export interface PolicyTestCase {
  name: string;
  category: PolicyTestCategory;
  given: PolicyTestGiven;
  when: PolicyTestWhen;
  then: PolicyTestExpectation;
}

/**
 * A named group of cases exercising ONE policy/rule (or one closely
 * related family of rules registered on the same engine) — `policyId` is
 * a free-form label for reporting (e.g. `"rbac"`, `"resource-ownership"`,
 * `"assurance-gate"`), not required to match any single case's own
 * `then.policyId`. `./runner.ts`'s coverage check runs per-suite: a
 * codebase with N policies is expected to eventually have N suites, each
 * independently checked for all five categories — never one giant
 * suite whose aggregate category coverage hides which specific policy
 * is actually missing, say, its own privilege-escalation case.
 */
export interface PolicyTestSuite {
  policyId: string;
  cases: PolicyTestCase[];
}
