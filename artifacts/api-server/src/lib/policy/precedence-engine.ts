/**
 * lib/policy/precedence-engine.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 08 (Policy Precedence).
 *
 * `PrecedenceEngine` is a SEPARATE, ADDITIVE class from Phase 01's
 * `PolicyEngine` — it does not modify, replace, or change the behavior of
 * `PolicyEngine.evaluate()`'s existing flat deny-overrides algorithm (every
 * Phase 1A-06 test still exercises that exact algorithm, unchanged; see
 * `CHANGES_POLICY_AUTHORIZATION_ENGINE_PHASE8.md`'s regression section).
 * Roadmap Rule 6 ("Preserve API compatibility unless migration is
 * explicitly required") is why: nothing in this codebase's tests or (once
 * a future phase wires one up) routes should be forced to migrate off the
 * simpler, order-of-registration algorithm just because a formal 8-tier
 * precedence model now also exists as an option.
 *
 * ── Why a NEW class instead of adding a `tier` param to
 *    `PolicyEngine.registerRule()` ─────────────────────────────────────────
 * `registerRule(id, rule)` already has 9 real call sites across
 * `scripts/src/test-policy-*.ts` (Phase 1A-06) plus 3 inside
 * `lib/policy/{rbac,resource,abac}/*-rule.ts`'s own test-fixture-adjacent
 * examples. Adding a required third parameter would be a breaking change
 * to every one of them for a capability most of those tests don't need
 * (they're testing ONE rule's behavior in isolation, not multi-rule
 * conflict resolution). A new, parallel class — same `PolicyRule` function
 * type, same request/decision shapes, same fail-closed/deterministic
 * guarantees — gets the new capability to callers who actually need
 * cross-tier conflict resolution without touching any existing caller.
 *
 * ── Combining algorithm ─────────────────────────────────────────────────
 * `PRECEDENCE_ORDER` (precedence-tiers.ts) lists 7 tiers, highest-precedence
 * first. `evaluate()`:
 *   1. Walks `PRECEDENCE_ORDER` in order.
 *   2. For each tier, runs every rule registered at that tier (in
 *      registration order) — the SAME per-rule fail-closed handling
 *      `PolicyEngine` already uses (a throwing rule immediately resolves
 *      the WHOLE evaluation to `POLICY_EVALUATION_ERROR`, not just that
 *      tier).
 *   3. If every rule at this tier abstains (returns null), move to the
 *      next tier — this tier had no opinion.
 *   4. If ANY rule at this tier produced a decision, this tier is
 *      DECISIVE — no lower-precedence tier is even evaluated. Within this
 *      one tier, if more than one rule produced a decision and they
 *      disagree, the SAME deny-overrides tiebreak `PolicyEngine` already
 *      uses applies (a DENY/STEP_UP/APPROVAL_REQUIRED at this tier beats
 *      an ALLOW at this same tier; the first ALLOW is kept if nothing at
 *      this tier ever denies). This is a deliberate, narrow reuse of
 *      Phase 1A's own algorithm as an intra-tier tiebreaker — cross-tier,
 *      precedence rank always wins regardless of effect; deny-overrides
 *      only ever adjudicates rules that share a rank.
 *   5. If every tier is exhausted with no decisive tier at all, `evaluate()`
 *      returns `NO_MATCHING_POLICY` — Phase 01's "default deny" (roadmap's
 *      own unlisted 8th tier — see precedence-tiers.ts's header).
 *
 * This is a STRICT priority order, not a weighted/scored one — deliberate,
 * per the roadmap's own Phase 08 framing ("Make conflicts deterministic")
 * and Rule 12 (deterministic evaluation): a tier-1 (emergency) rule always
 * wins over a tier-7 (role grant) rule's opposite verdict, with no numeric
 * threshold or configuration that could make that outcome ambiguous.
 *
 * ── Tier assignment is a REGISTRATION-time choice, not inferred from a
 *    decision's `reason` code ────────────────────────────────────────────
 * `registerRule(id, tier, rule)` takes the tier explicitly. This engine
 * never inspects `decision.reason`/`policyId` to guess which tier a
 * decision "really" belongs to — the same `PolicyRule` function (e.g. a
 * compiled ABAC policy) can legitimately belong at different tiers
 * depending on what its author intended it to mean (see
 * precedence-tiers.ts's header on why ABAC isn't hardcoded to one tier).
 * Whoever wires up a `PrecedenceEngine` instance is the one place that
 * intent is expressed.
 *
 * Fail-closed and deterministic guarantees are otherwise identical to
 * `PolicyEngine` — see that file's own header; `resolveRequestOrEarlyDecision()`
 * (policy-engine.ts) is reused verbatim here so "invalid context" /
 * "unauthenticated" behave byte-for-byte the same in both engines.
 */

import { resolveRequestOrEarlyDecision, type PolicyRule } from "./policy-engine";
import type { BuildAuthorizationRequestInput } from "./authorization-request";
import { deny } from "./authorization-decision";
import { PolicyEvaluationError } from "./policy-errors";
import { PRECEDENCE_ORDER, assertValidPrecedenceTier, type PrecedenceTier } from "./precedence-tiers";
import type { AuthorizationDecision } from "./types";

interface TieredPolicyRule {
  id: string;
  tier: PrecedenceTier;
  rule: PolicyRule;
}

/** One tier's outcome for a single evaluation — returned by
 *  `PrecedenceEngine`'s (optional) `onTierEvaluated` hook, primarily so
 *  `scripts/src/test-policy-precedence.ts`'s conflict-matrix tests can
 *  assert not just the FINAL decision but WHICH tier decided it, without
 *  the engine needing to expose any other internal state. */
export interface TierEvaluationTrace {
  tier: PrecedenceTier;
  /** Every non-abstaining decision produced by a rule registered at this
   *  tier, in registration order. Empty if every rule at this tier
   *  abstained (in which case this tier is never decisive). */
  decisions: AuthorizationDecision[];
}

/**
 * Phase 14 (Policy Simulation): one registered rule's contribution to a
 * single `evaluateWithTrace()` call, in tier-then-registration order —
 * every rule this engine actually invoked, INCLUDING abstentions
 * (`decision: null`), unlike `TierEvaluationTrace` above (which only ever
 * carries non-abstaining decisions, and only for the one DECISIVE tier).
 * See `lib/policy/simulation/policy-simulator.ts`'s `simulatePrecedence()`
 * for the actual dry-run surface built on top of this.
 */
export interface PrecedenceRuleTrace {
  id: string;
  tier: PrecedenceTier;
  decision: AuthorizationDecision | null;
}

export interface PrecedenceEngineOptions {
  /** Optional trace hook — called once per tier that had at least one
   *  registered rule actually invoked (tiers with zero registered rules
   *  are skipped without a call, same as `PolicyEngine.listRuleIds()`
   *  never lists a tier's absence). Never awaited, never allowed to affect
   *  the decision or add latency — same posture `PolicyEngine`'s
   *  `onDecision` hook already establishes (policy-engine.ts's Phase 1C
   *  section). Diagnostic-only. */
  onTierEvaluated?: (trace: TierEvaluationTrace) => void;
}

export class PrecedenceEngine {
  private readonly rulesByTier: Map<PrecedenceTier, TieredPolicyRule[]> = new Map(
    PRECEDENCE_ORDER.map((tier) => [tier, []]),
  );
  private readonly onTierEvaluated?: (trace: TierEvaluationTrace) => void;

  constructor(options: PrecedenceEngineOptions = {}) {
    this.onTierEvaluated = options.onTierEvaluated;
  }

  /** Registers `rule` under `tier` (must be one of `PRECEDENCE_ORDER`'s 7
   *  values — throws immediately otherwise, per this file's header on
   *  failing loudly at registration time). Registering the same `id`
   *  twice — even under a different tier — replaces the earlier
   *  registration at its original tier/position, mirroring
   *  `PolicyEngine.registerRule()`'s own hot-swap semantics. */
  registerRule(id: string, tier: string, rule: PolicyRule): void {
    if (!id || id.trim().length === 0) {
      throw new Error("policy id must be a non-empty string");
    }
    assertValidPrecedenceTier(tier);
    this.unregisterRule(id);
    this.rulesByTier.get(tier)!.push({ id, tier, rule });
  }

  unregisterRule(id: string): void {
    for (const rules of this.rulesByTier.values()) {
      const index = rules.findIndex((r) => r.id === id);
      if (index >= 0) {
        rules.splice(index, 1);
        return; // an id is unique across all tiers by construction
      }
    }
  }

  /** Read-only snapshot of `{ id, tier }` for every currently-registered
   *  rule, in `PRECEDENCE_ORDER` order and then registration order within
   *  each tier. Exposed for tests/audit, same posture as
   *  `PolicyEngine.listRuleIds()`. */
  listRules(): Array<{ id: string; tier: PrecedenceTier }> {
    const out: Array<{ id: string; tier: PrecedenceTier }> = [];
    for (const tier of PRECEDENCE_ORDER) {
      for (const { id } of this.rulesByTier.get(tier)!) out.push({ id, tier });
    }
    return out;
  }

  /** Same contract as `PolicyEngine.evaluate()`: never throws, always
   *  resolves to an `AuthorizationDecision`. See file header for the
   *  tiered combining algorithm. Thin wrapper around `evaluateCore()` (see
   *  that method for the actual loop) that discards the Phase 14 trace —
   *  behavior is byte-for-byte identical to before `evaluateCore()` was
   *  extracted. */
  async evaluate(input: BuildAuthorizationRequestInput): Promise<AuthorizationDecision> {
    const { decision } = await this.evaluateCore(input);
    return decision;
  }

  /**
   * Phase 14 (Policy Simulation): identical evaluation to `evaluate()` —
   * same tiered, deny-overrides-within-a-tier combining algorithm, same
   * `onTierEvaluated` hook firing at the same points — but also returns
   * every rule this call actually invoked, across every tier reached
   * before short-circuiting, INCLUDING abstentions. See
   * `PrecedenceRuleTrace`'s own doc comment above for how this differs
   * from `onTierEvaluated`'s `TierEvaluationTrace`, and
   * `lib/policy/simulation/policy-simulator.ts`'s `simulatePrecedence()`
   * for the dry-run surface built on top of this. Calls nothing beyond the
   * registered `PolicyRule` functions themselves — no business action is
   * reachable from here.
   */
  async evaluateWithTrace(
    input: BuildAuthorizationRequestInput,
  ): Promise<{ decision: AuthorizationDecision; trace: PrecedenceRuleTrace[] }> {
    return this.evaluateCore(input);
  }

  private async evaluateCore(
    input: BuildAuthorizationRequestInput,
  ): Promise<{ decision: AuthorizationDecision; trace: PrecedenceRuleTrace[] }> {
    const resolved = resolveRequestOrEarlyDecision(input);
    if (resolved.earlyDecision) {
      // No rule ever ran (invalid context / unauthenticated short-circuits
      // before any tier is reached) — trace is empty, same posture
      // `PolicyEngine.evaluateCore()`'s own early-decision branch takes.
      return { decision: resolved.earlyDecision, trace: [] };
    }
    const request = resolved.request;
    const trace: PrecedenceRuleTrace[] = [];

    for (const tier of PRECEDENCE_ORDER) {
      const tieredRules = this.rulesByTier.get(tier)!;
      if (tieredRules.length === 0) continue; // nothing registered at this tier — try the next

      const decisions: AuthorizationDecision[] = [];
      let firstAllow: AuthorizationDecision | null = null;

      for (const { id, rule } of tieredRules) {
        let decision: AuthorizationDecision | null;
        try {
          decision = await rule(request);
        } catch (cause) {
          // Fail-closed, exactly like PolicyEngine: a throwing rule at ANY
          // tier immediately resolves the whole evaluation to deny — it
          // does not just remove that one rule's opinion from this tier's
          // tiebreak.
          const wrapped = new PolicyEvaluationError(`Policy "${id}" threw during evaluation`, id, cause);
          const denyDecision = deny(request, "POLICY_EVALUATION_ERROR", { message: wrapped.message, policyId: id });
          trace.push({ id, tier, decision: denyDecision });
          return { decision: denyDecision, trace };
        }

        trace.push({ id, tier, decision });

        if (decision === null) continue; // abstain
        decisions.push(decision);

        if (decision.effect === "DENY" || decision.effect === "STEP_UP" || decision.effect === "APPROVAL_REQUIRED") {
          // Deny-overrides within this tier (see file header) — this tier
          // is decisive and this is its outcome. Still fire the trace hook
          // for this tier before returning, so a caller/test can see every
          // decision this tier actually produced, not just the winner.
          this.notifyTier(tier, decisions);
          return { decision, trace };
        }

        if (decision.effect === "ALLOW" && firstAllow === null) {
          firstAllow = decision;
          // Keep scanning the REST of this tier — a later rule at the SAME
          // tier may still produce DENY, which must override this ALLOW.
        }
      }

      if (decisions.length > 0) {
        // This tier had at least one opinion and none of them denied —
        // it is decisive with the first ALLOW seen. No lower tier runs.
        this.notifyTier(tier, decisions);
        return { decision: firstAllow!, trace };
      }
      // Every rule at this tier abstained — this tier had no opinion at
      // all (decisions.length === 0); note NO trace hook fires for a tier
      // where every rule abstained, since "ran but said nothing" is not
      // meaningfully different from "had nothing registered" for trace
      // purposes — only a DECISIVE tier is traced. (The Phase 14 `trace`
      // array above still recorded each abstention, independent of this
      // hook.)
    }

    return {
      decision: deny(request, "NO_MATCHING_POLICY", {
        message: "No registered policy (at any precedence tier) allowed this request",
      }),
      trace,
    };
  }

  private notifyTier(tier: PrecedenceTier, decisions: AuthorizationDecision[]): void {
    if (!this.onTierEvaluated) return;
    try {
      this.onTierEvaluated({ tier, decisions });
    } catch {
      // Swallowed intentionally — diagnostic-only, same posture
      // PolicyEngine's onDecision hook already establishes.
    }
  }
}
