/**
 * lib/policy/simulation/types.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 14 (Policy Simulation).
 *
 * Pure types. No DB, no Express — same discipline every other lib/policy/*
 * types.ts already follows (see e.g. ../assurance/types.ts's header).
 *
 * The roadmap's own Phase 14 section, verbatim:
 *
 *   "Add dry-run mode.
 *    Input: subject, action, resource, context.
 *    Output: decision, policy, version, matched rules, reason, required
 *    assurance.
 *    Simulation must NEVER execute the business action."
 *
 * `SimulationInput` is deliberately just `BuildAuthorizationRequestInput`
 * (../authorization-request.ts) — the exact same subject/action/resource/
 * context shape `PolicyEngine.evaluate()`/`PrecedenceEngine.evaluate()`
 * already accept — so a caller never has to build a second,
 * simulation-specific request shape, and so "simulating X" and "actually
 * authorizing X" are guaranteed to be asking the PDP the identical
 * question (see policy-simulator.ts's header for why this matters more
 * than it might first appear).
 *
 * `PolicySimulationResult` is a strict superset of a normal
 * `AuthorizationDecision`: every field the roadmap names (decision, policy,
 * version, matched rules, reason, required assurance) plus the underlying
 * `decision` itself, so a caller that only wants the real decision can
 * still get it without re-deriving it from the simulation-specific fields.
 */

import type { AuthorizationDecision } from "../types";
import type { BuildAuthorizationRequestInput } from "../authorization-request";
import type { PrecedenceTier } from "../precedence-tiers";

/** Input to a policy simulation — identical shape to what
 *  `PolicyEngine.evaluate()`/`PrecedenceEngine.evaluate()` already accept.
 *  See file header. */
export type SimulationInput = BuildAuthorizationRequestInput;

/**
 * One rule's contribution to a simulated decision, in evaluation order.
 * `decision` is `null` when that rule abstained (had no opinion on this
 * request) — the same `PolicyRule` abstention contract every rule in this
 * engine already honors (see ../policy-engine.ts's `PolicyRule` doc
 * comment). Kept even for abstentions (not filtered out here) so a
 * caller can distinguish "this rule was consulted and had nothing to say"
 * from "this rule was never reached at all" (e.g. because an earlier rule
 * already short-circuited evaluation via deny-overrides) — see
 * `PolicySimulationResult.matchedRules`'s own doc comment for the
 * "matched" vs "consulted" distinction this preserves.
 *
 * `tier` is present only when this trace entry came from a
 * `PrecedenceEngine` simulation (`simulatePrecedence()`) — a flat
 * `PolicyEngine` simulation (`simulatePolicy()`) has no tier concept, same
 * as `PolicyEngine.registerRule()` itself takes no tier argument.
 */
export interface MatchedRuleTrace {
  policyId: string;
  tier?: PrecedenceTier;
  decision: AuthorizationDecision | null;
}

/** One precedence tier's own (non-abstaining-only) contribution — present
 *  only on the result of `simulatePrecedence()`. Mirrors
 *  `PrecedenceEngine`'s own `TierEvaluationTrace` (../precedence-engine.ts)
 *  field-for-field, so a caller already familiar with that engine's own
 *  `onTierEvaluated` hook sees the same shape here. */
export interface MatchedTierTrace {
  tier: PrecedenceTier;
  decisions: AuthorizationDecision[];
}

/**
 * Full dry-run output — the roadmap's own Phase 14 field list ("decision,
 * policy, version, matched rules, reason, required assurance"), verbatim:
 *
 *   - decision            → `decision` (the full AuthorizationDecision) and
 *                            `effect` (its own `effect` field, surfaced at
 *                            the top level as a convenience alias)
 *   - policy               → `policyId`
 *   - version               → `policyVersion`
 *   - matched rules        → `matchedRules` (and, for a `PrecedenceEngine`
 *                             simulation, `matchedTiers` too)
 *   - reason               → `reason`
 *   - required assurance   → `requiredAssurance`
 *
 * Every "convenience alias" field here (`effect`, `reason`,
 * `requiredAssurance`, `policyId`) is copied verbatim from `decision`
 * itself — never independently computed — so there is exactly one source
 * of truth for what this simulation actually decided; the aliases exist
 * only so a caller/UI can read the roadmap's own named fields without
 * reaching into `decision.*` for each one.
 */
export interface PolicySimulationResult {
  /** The exact `AuthorizationDecision` a real (non-simulated) `evaluate()`
   *  call would have produced for this same input — see
   *  policy-simulator.ts's header for why this is guaranteed, not merely
   *  intended. */
  decision: AuthorizationDecision;
  effect: AuthorizationDecision["effect"];
  reason: AuthorizationDecision["reason"];
  /** Copied from `decision.requiredAssurance` — see ../types.ts's own doc
   *  comment on that field for which rules populate it (today: only
   *  ../assurance/assurance-rule.ts's STEP_UP). `undefined` for any
   *  decision not gated on a named assurance level. */
  requiredAssurance?: string;
  /** Which registered rule (or, for a `PrecedenceEngine` simulation, which
   *  rule at whichever tier) decided this simulation, if any — copied from
   *  `decision.policyId`. `undefined` only for the engine's own built-in
   *  `NO_MATCHING_POLICY`/`INVALID_AUTHORIZATION_CONTEXT`/`UNAUTHENTICATED`
   *  fallbacks, which are not produced by any registered rule. */
  policyId?: string;
  /** Populated only when BOTH (a) a `PolicyRegistryProvider` was supplied
   *  to `simulatePolicy()`/`simulatePrecedence()`, AND (b) the decisive
   *  `policyId` happens to match a real Phase 07 registry `policyId` with
   *  an ACTIVE version on file. See policy-simulator.ts's header for why
   *  this is commonly `undefined` in this codebase today: most rules
   *  currently registered against either engine (RBAC, ownership, ReBAC,
   *  assurance, risk, separation-of-duties, ...) are hand-constructed
   *  `PolicyRule` functions from their own phase's module, not Phase 07
   *  registry rows — nothing in this codebase yet loads registry policies
   *  into either engine as rules (see registry/policy-registry.ts's own
   *  header: "Nothing here feeds an ACTIVE policy's compiled rule into the
   *  PDP's PolicyEngine at evaluation time"). This field exists so that,
   *  once a future phase DOES wire registry-backed policies into either
   *  engine, simulation results for THOSE policies immediately gain a real
   *  version number with no further change to this module. */
  policyVersion?: number;
  /** Every rule this simulation actually invoked, in evaluation order,
   *  INCLUDING abstentions. The narrower "rules that produced an opinion"
   *  reading of the roadmap's own "matched rules" wording is
   *  `matchedRules.filter(r => r.decision !== null)`; the full list is
   *  kept as the field itself so an admin/debug caller can also see which
   *  rules were consulted at all (useful for "why didn't policy X apply
   *  here" questions, where the answer is "it never even ran" rather than
   *  "it ran and abstained"). */
  matchedRules: MatchedRuleTrace[];
  /** Populated only on the result of `simulatePrecedence()` — the same
   *  tier-grouped view `PrecedenceEngine`'s own `onTierEvaluated` hook
   *  would have seen for this request. */
  matchedTiers?: MatchedTierTrace[];
  /** Copied from `decision.requestId` — the same correlation ID a real
   *  evaluate() call for this input would have stamped. */
  requestId: string;
  /** Copied from `decision.evaluatedAt`. */
  evaluatedAt: Date;
}
