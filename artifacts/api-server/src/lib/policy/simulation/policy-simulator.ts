/**
 * lib/policy/simulation/policy-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 14 (Policy Simulation).
 *
 * `simulatePolicy()` / `simulatePrecedence()` are this phase's whole
 * surface: a dry-run entry point for a `PolicyEngine` / `PrecedenceEngine`
 * respectively, returning the roadmap's own named output fields
 * ("decision, policy, version, matched rules, reason, required assurance"
 * — see ./types.ts's header for the exact mapping).
 *
 * ── "Simulation must NEVER execute the business action" — by construction,
 *    not by a flag ──────────────────────────────────────────────────────
 * Both functions do exactly two things: (1) call the target engine's own
 * `evaluateWithTrace()` (Phase 14's additive addition to
 * ../policy-engine.ts / ../precedence-engine.ts — see each file's own
 * header), and (2) optionally look up a version number from a
 * `PolicyRegistryProvider`, a read-only lookup. Neither step accepts, nor
 * could accept, anything resembling "the business action to run" as an
 * argument — there is no such parameter on either function's signature,
 * and no code path here calls anything other than those two read-only
 * operations. A caller cannot misuse this module into performing the
 * operation it is simulating; the only way to actually DO the thing an
 * ALLOW decision would permit is to go write a PEP call site that invokes
 * the real business service directly (a distinct, later concern — Phase
 * 19) and separately decides whether to call `evaluate()` or
 * `simulatePolicy()`. This module simply never has the capability that
 * would need restraining.
 *
 * ── Simulating is evaluating — the SAME code path, not a parallel one ────
 * Every prior phase's rule (RBAC, ownership, ReBAC, ABAC, assurance, risk,
 * temporary access, approval, separation-of-duties, ...) is an ordinary
 * `PolicyRule` function with no notion of "this is a dry run" — nothing
 * about how a rule executes changes when it is invoked from
 * `simulatePolicy()` instead of a real `evaluate()` call, because BOTH
 * ultimately run through the exact same `PolicyEngine.evaluateCore()` /
 * `PrecedenceEngine.evaluateCore()` loop (see each engine file's own
 * header on `evaluateWithTrace()`). This is deliberate and important: a
 * simulation result that could diverge from what a real authorization
 * check would decide (e.g. a hand-maintained second copy of the combining
 * algorithm) would be worse than useless — an admin trusting a simulated
 * ALLOW that a real request would actually DENY is a security bug, not a
 * UX inconvenience. Reusing the real engines' own trace-returning method
 * makes that divergence structurally impossible rather than merely
 * "tested against".
 *
 * ── Registry version enrichment is best-effort and additive-only ─────────
 * `options.registryProvider` (either engine variant) is entirely optional.
 * When supplied, this module tries to resolve the decisive rule's
 * `policyId` against `PolicyRegistryProvider.getActivePolicy()` (Phase 07)
 * and reports that record's `version` as `policyVersion`. A lookup miss
 * (no registry policy with that id — true for every hand-registered rule
 * id in this codebase today, e.g. "rbac"/"assurance"/"risk"/"sod") or a
 * lookup failure (provider throws) both resolve to `policyVersion:
 * undefined`, never to an error thrown out of `simulatePolicy()`/
 * `simulatePrecedence()` themselves — an enrichment step must never turn a
 * successful simulation into a failed one (same "diagnostic surface must
 * never become a new failure mode" posture ../policy-engine.ts's
 * `onDecision` hook and ../precedence-engine.ts's `onTierEvaluated` hook
 * both already establish for their own optional, best-effort callbacks).
 */

import type { PolicyEngine, RuleEvaluationTrace } from "../policy-engine";
import type { PrecedenceEngine, PrecedenceRuleTrace } from "../precedence-engine";
import type { PolicyRegistryProvider } from "../registry/types";
import type { AuthorizationDecision } from "../types";
import type { MatchedRuleTrace, MatchedTierTrace, PolicySimulationResult, SimulationInput } from "./types";

export interface SimulationOptions {
  /** Optional Phase 07 registry lookup for `policyVersion` enrichment —
   *  see file header. Omit for a simulation with `policyVersion` always
   *  `undefined` (still a fully valid, complete simulation result — every
   *  other Phase 14 output field is unaffected). */
  registryProvider?: PolicyRegistryProvider;
}

/** Best-effort, read-only, never-throwing lookup — see file header's
 *  "Registry version enrichment" section for why every failure mode here
 *  resolves to `undefined` rather than propagating. */
async function resolvePolicyVersion(
  decision: AuthorizationDecision,
  registryProvider: PolicyRegistryProvider | undefined,
): Promise<number | undefined> {
  if (!registryProvider || !decision.policyId) return undefined;
  try {
    const active = await registryProvider.getActivePolicy(decision.policyId);
    return active?.version;
  } catch {
    return undefined;
  }
}

function buildResult(
  decision: AuthorizationDecision,
  matchedRules: MatchedRuleTrace[],
  matchedTiers: MatchedTierTrace[] | undefined,
  policyVersion: number | undefined,
): PolicySimulationResult {
  return {
    decision,
    effect: decision.effect,
    reason: decision.reason,
    requiredAssurance: decision.requiredAssurance,
    policyId: decision.policyId,
    policyVersion,
    matchedRules,
    matchedTiers,
    requestId: decision.requestId,
    evaluatedAt: decision.evaluatedAt,
  };
}

function toMatchedRules(trace: RuleEvaluationTrace[]): MatchedRuleTrace[] {
  return trace.map(({ id, decision }) => ({ policyId: id, decision }));
}

/**
 * Dry-run `input` against a flat `PolicyEngine`. See file header for what
 * "dry-run" guarantees here (never a parallel/simplified copy of the
 * combining algorithm, never able to trigger a business action).
 */
export async function simulatePolicy(
  engine: Pick<PolicyEngine, "evaluateWithTrace">,
  input: SimulationInput,
  options: SimulationOptions = {},
): Promise<PolicySimulationResult> {
  const { decision, trace } = await engine.evaluateWithTrace(input);
  const matchedRules = toMatchedRules(trace);
  const policyVersion = await resolvePolicyVersion(decision, options.registryProvider);
  return buildResult(decision, matchedRules, undefined, policyVersion);
}

/**
 * Dry-run `input` against a tiered `PrecedenceEngine`. Same guarantees as
 * `simulatePolicy()` (see file header) — additionally reports
 * `matchedTiers`, the tier-grouped (non-abstaining-only) view
 * `PrecedenceEngine`'s own `onTierEvaluated` hook would have seen for this
 * exact request.
 */
export async function simulatePrecedence(
  engine: Pick<PrecedenceEngine, "evaluateWithTrace">,
  input: SimulationInput,
  options: SimulationOptions = {},
): Promise<PolicySimulationResult> {
  const { decision, trace } = await engine.evaluateWithTrace(input);
  const matchedRules: MatchedRuleTrace[] = trace.map(({ id, tier, decision: ruleDecision }) => ({
    policyId: id,
    tier,
    decision: ruleDecision,
  }));
  const matchedTiers = groupByTier(trace);
  const policyVersion = await resolvePolicyVersion(decision, options.registryProvider);
  return buildResult(decision, matchedRules, matchedTiers, policyVersion);
}

/** Mirrors `PrecedenceEngine`'s own internal `onTierEvaluated` grouping
 *  exactly: only non-abstaining decisions, grouped by the tier that
 *  produced them, in the order those tiers were actually reached. A tier
 *  where every rule abstained contributes nothing here — same "ran but
 *  said nothing is not meaningfully different from nothing registered"
 *  posture ../precedence-engine.ts's own header documents for
 *  `onTierEvaluated`. */
function groupByTier(trace: PrecedenceRuleTrace[]): MatchedTierTrace[] {
  const order: MatchedTierTrace[] = [];
  const byTier = new Map<string, AuthorizationDecision[]>();
  for (const entry of trace) {
    if (entry.decision === null) continue;
    let bucket = byTier.get(entry.tier);
    if (!bucket) {
      bucket = [];
      byTier.set(entry.tier, bucket);
      order.push({ tier: entry.tier, decisions: bucket });
    }
    bucket.push(entry.decision);
  }
  return order;
}
