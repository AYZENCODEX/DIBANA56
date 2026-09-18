/**
 * lib/policy/policy-engine.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 01 (Foundation / PDP Core).
 * Sub-phase 1A shipped the engine itself; sub-phase 1C added an optional
 * decision-observability hook (`onDecision`). Phase 17 (Authorization
 * Audit, this revision) adds one more small, additive piece: `evaluate()`/
 * `evaluateWithTrace()` now time their own `evaluateCore()` call and stamp
 * the elapsed milliseconds onto the returned decision as `latencyMs` (see
 * `stampLatency()` below and `types.ts`'s own doc comment on that field) —
 * the "latency" field the roadmap's Phase 17 section names, measured where
 * it's actually accurate (inside the engine, wrapping real rule/PIP/
 * registry work) rather than reconstructed later by whatever eventually
 * reads `onDecision`. Nothing about `evaluateCore()`'s own combining logic
 * changes — see the "Phase 1C" markers below for the rest of what's
 * already here.
 *
 * This is the PDP (Policy Decision Point) core described by the roadmap's
 * target architecture:
 *
 *   Identity → PIP → PDP/Policy Engine → Decision → PEP → Business Action → Audit
 *
 * Phase 1A/1B shipped this box and its immediate inputs/outputs (types,
 * request/decision construction, reason codes, errors, PIP adapters) —
 * nothing downstream (PEP: enforcing a decision in an actual route) is
 * implemented yet, and no concrete policy RULES are registered anywhere in
 * the app. That is intentional per roadmap Rule 16 ("do not implement
 * future phases prematurely") — Phase 02 (RBAC) is the first phase that
 * will actually register rules against this engine.
 *
 * Combining algorithm (how multiple registered rules resolve to one
 * decision): DENY-OVERRIDES.
 *   - Any rule returning DENY → engine returns that DENY immediately
 *     (short-circuits remaining rules; rule order is otherwise irrelevant to
 *     the final effect, only to *which* DENY is reported first).
 *   - No DENY, but at least one rule returned ALLOW → engine returns that
 *     ALLOW (the first one seen, since rules run in registration order).
 *   - No rule returned ALLOW or DENY (every rule abstained by returning
 *     null, or zero rules are registered at all) → DENY with reason
 *     NO_MATCHING_POLICY. This is Rule 7 (default-deny) made concrete.
 *   - STEP_UP / APPROVAL_REQUIRED are treated as their own outcome and
 *     returned immediately when produced — Phase 1A does not attempt to
 *     combine them with ALLOW/DENY from other rules (no rule produces them
 *     yet, so this branch is exercised only once later phases add one).
 *
 * Fail-closed (Rule 8): if request validation throws, or a rule throws
 * during evaluation, evaluate() catches it and returns a DENY — it never
 * lets an exception propagate out to the caller, and never falls back to
 * whatever the failing rule might otherwise have decided.
 *
 * Deterministic (Rule 12): evaluate() is a pure function of
 * (the AuthorizationRequest, the engine's currently-registered rule list).
 * Given the same inputs it always returns the same effect+reason — no
 * randomness, no hidden mutable state read during evaluation. (Timestamps
 * on the returned decision naturally differ call to call; that is metadata
 * about *when* the decision was made, not part of the decision itself.)
 *
 * ── Phase 1C: decision-observability hook ──────────────────────────────────
 * `PolicyEngine` may optionally be constructed with an `onDecision` callback
 * (see `PolicyEngineOptions` below). If provided, it is invoked with every
 * `AuthorizationDecision` this engine produces (from every return path:
 * invalid context, unauthenticated, explicit allow/deny/step-up/approval,
 * evaluation error, and default-deny), *after* the decision has already
 * been finalized. This is purely an observation seam:
 *   - The hook cannot change, delay, or veto the decision — it is called
 *     with a decision that has already been returned in every sense that
 *     matters; `evaluate()`'s return value is identical whether or not a
 *     hook is registered.
 *   - The hook is never awaited before evaluate() resolves. It is invoked
 *     synchronously against the resolved decision but any promise it
 *     returns is intentionally not part of evaluate()'s own promise chain
 *     — a slow or hung observer must never add latency to an authorization
 *     decision.
 *   - If the hook throws (or its returned promise rejects), that failure is
 *     swallowed here and never surfaces to the caller and never changes the
 *     decision. An observer is diagnostic-only; it must never become a new
 *     way for authorization to fail (that would violate fail-closed in
 *     spirit, by making a logging bug into an availability bug).
 * No engine construction anywhere in the app passes `onDecision` yet (see
 * CHANGES_POLICY_AUTHORIZATION_ENGINE_PHASE1C.md) — this is purely additive,
 * dormant surface area for Phase 17 (Authorization Audit) and earlier
 * ad-hoc debugging/observability needs to build on later, without another
 * change to this file's core evaluation logic.
 */

import { buildAuthorizationRequest, type BuildAuthorizationRequestInput } from "./authorization-request";
import { deny } from "./authorization-decision";
import { InvalidAuthorizationContextError, PolicyEvaluationError } from "./policy-errors";
import { withTimeout } from "./hardening/timeout";
import type { AuthorizationDecision, AuthorizationRequest } from "./types";

/**
 * A single registered policy. Return:
 *   - an AuthorizationDecision to render a verdict (ALLOW/DENY/STEP_UP/APPROVAL_REQUIRED)
 *   - null to abstain (this rule has no opinion on this request; the engine
 *     moves on to the next rule)
 *
 * Throwing is treated as "this rule failed to evaluate" and always resolves
 * to DENY (fail-closed) — a rule should never throw to mean "deny", it
 * should return an explicit deny() decision instead so the reason is
 * accurate in logs/audit.
 */
export type PolicyRule = (
  request: AuthorizationRequest,
) => AuthorizationDecision | null | Promise<AuthorizationDecision | null>;

export interface RegisteredPolicyRule {
  id: string;
  rule: PolicyRule;
}

/**
 * Phase 14 (Policy Simulation): one registered rule's contribution to a
 * single `evaluateWithTrace()` call, in evaluation order. `decision` is
 * `null` when that rule abstained — the exact same `PolicyRule` contract
 * `evaluate()` itself already honors (see `PolicyRule`'s own doc comment
 * above), just observed rather than only combined. See
 * `lib/policy/simulation/policy-simulator.ts` for the actual dry-run
 * surface built on top of this.
 */
export interface RuleEvaluationTrace {
  id: string;
  decision: AuthorizationDecision | null;
}

/**
 * Phase 1C: called with every finalized decision this engine produces, and
 * (when available) the request that produced it. `request` is omitted only
 * for the one path where a request could not be built at all (invalid
 * context before validation completes) — see evaluate()'s catch branch.
 * Must never throw; if it does, evaluate() swallows it (see file header).
 */
export type PolicyDecisionObserver = (
  decision: AuthorizationDecision,
  request: AuthorizationRequest | undefined,
) => void | Promise<void>;

export interface PolicyEngineOptions {
  /** Optional decision-observability hook. See file header's "Phase 1C"
   *  section for the exact contract. Omit for the exact same behavior as
   *  Phase 1A/1B (no observation, no overhead beyond one no-op check). */
  onDecision?: PolicyDecisionObserver;
  /**
   * Phase 25 (Production Hardening): a per-rule time budget, in
   * milliseconds, enforced via `./hardening/timeout.ts`'s `withTimeout()`
   * around every registered `PolicyRule` invocation in `evaluateCore()`'s
   * loop below. A rule that exceeds this budget rejects with an
   * `AuthorizationTimeoutError`, which the loop's existing try/catch
   * already converts to a `POLICY_EVALUATION_ERROR` DENY — the exact same
   * fail-closed path a throwing rule has always taken (no new reason code
   * needed; the timeout's own message, e.g. `Authorization rule "rbac"
   * exceeded its 500ms time budget`, is what ends up in that DENY's
   * `message`). Omit (or pass `undefined`/`0`/negative) to keep the
   * pre-Phase-25 unbounded wait, byte-for-byte — see `withTimeout()`'s own
   * "opt-in, zero-behavior-change-by-default" doc comment.
   */
  ruleTimeoutMs?: number;
}

/**
 * Phase 08: extracted, verbatim, from what was previously the first ~25
 * lines of `evaluateCore()` below — building the request and handling the
 * two "no rule ever got a chance to run" outcomes (invalid context,
 * unauthenticated). `PolicyEngine.evaluateCore()` and
 * `./precedence-engine.ts`'s `PrecedenceEngine.evaluateCore()` both call
 * this, so "what does an invalid/unauthenticated request look like" is
 * governed by exactly one implementation regardless of which combining
 * algorithm (flat deny-overrides vs. tiered precedence) runs afterward.
 * Pure refactor — no behavioral change to `PolicyEngine` (see
 * CHANGES_POLICY_AUTHORIZATION_ENGINE_PHASE8.md's own note on this).
 */
export function resolveRequestOrEarlyDecision(
  input: BuildAuthorizationRequestInput,
): { request: AuthorizationRequest; earlyDecision: null } | { request: undefined; earlyDecision: AuthorizationDecision } {
  let request: AuthorizationRequest;
  try {
    request = buildAuthorizationRequest(input);
  } catch (err) {
    // No valid request means no requestId to stamp onto the decision
    // either — synthesize a minimal one so the decision is still usable
    // for logging/audit (Rule 10) even though the input was rejected.
    const requestId =
      input.context && typeof input.context === "object" && "requestId" in input.context && typeof input.context.requestId === "string"
        ? input.context.requestId
        : "unresolved";
    return {
      request: undefined,
      earlyDecision: {
        effect: "DENY",
        reason: "INVALID_AUTHORIZATION_CONTEXT",
        message: err instanceof Error ? err.message : "Invalid authorization context",
        requestId,
        evaluatedAt: new Date(),
      },
    };
  }

  if (request.subject === null) {
    return { request: undefined, earlyDecision: deny(request, "UNAUTHENTICATED", { message: "No authenticated subject present" }) };
  }

  return { request, earlyDecision: null };
}

/**
 * Phase 17 (Authorization Audit): returns `decision` with `latencyMs` set
 * to the elapsed time since `startedAt` (a `Date.now()` reading taken by
 * the caller before `evaluateCore()` ran) — never mutates `decision`
 * in place (every decision producer in this engine builds plain, already-
 * returned-elsewhere object literals via allow()/deny()/stepUp()/
 * approvalRequired(); mutating one after the fact would be surprising to
 * any caller holding an earlier reference to the same object, e.g. a
 * Phase 14 trace entry). If `decision.latencyMs` is somehow already set
 * (never happens today — no decision producer in this codebase sets it),
 * this does NOT overwrite it, so a decision that already carries a
 * meaningful latency reading from elsewhere is never silently replaced.
 */
function stampLatency(decision: AuthorizationDecision, startedAt: number): AuthorizationDecision {
  if (decision.latencyMs !== undefined) return decision;
  return { ...decision, latencyMs: Date.now() - startedAt };
}

export class PolicyEngine {
  private readonly rules: RegisteredPolicyRule[] = [];
  private readonly onDecision?: PolicyDecisionObserver;
  private readonly ruleTimeoutMs?: number;

  constructor(options: PolicyEngineOptions = {}) {
    this.onDecision = options.onDecision;
    this.ruleTimeoutMs = options.ruleTimeoutMs;
  }

  /** Registers a rule under a stable id (shows up as `policyId` on any
   *  decision it produces). Registering the same id twice replaces the
   *  earlier rule at its original position — later phases will use this to
   *  hot-swap a rule's implementation without reordering the chain. */
  registerRule(id: string, rule: PolicyRule): void {
    if (!id || id.trim().length === 0) {
      throw new InvalidAuthorizationContextError("policy id must be a non-empty string");
    }
    const existingIndex = this.rules.findIndex((r) => r.id === id);
    if (existingIndex >= 0) {
      this.rules[existingIndex] = { id, rule };
    } else {
      this.rules.push({ id, rule });
    }
  }

  unregisterRule(id: string): void {
    const index = this.rules.findIndex((r) => r.id === id);
    if (index >= 0) this.rules.splice(index, 1);
  }

  /** Read-only snapshot of currently-registered rule ids, in evaluation
   *  order. Exposed for tests/audit — evaluate() itself is what matters for
   *  actual decisions. */
  listRuleIds(): string[] {
    return this.rules.map((r) => r.id);
  }

  /**
   * Builds and validates an AuthorizationRequest, then evaluates it against
   * every registered rule using the deny-overrides algorithm described in
   * this file's header. Never throws — always resolves to an
   * AuthorizationDecision.
   *
   * Phase 1C: this is now a thin wrapper around `evaluateCore()` that also
   * fires the optional `onDecision` observer. `evaluateCore()` holds the
   * exact same logic Phase 1A shipped, unchanged, so this wrapper cannot
   * alter what decision is reached — only whether/how it is observed.
   */
  async evaluate(input: BuildAuthorizationRequestInput): Promise<AuthorizationDecision> {
    const startedAt = Date.now();
    const { decision, request } = await this.evaluateCore(input);
    const stamped = stampLatency(decision, startedAt);
    this.notifyObserver(stamped, request);
    return stamped;
  }

  /**
   * Phase 14 (Policy Simulation): identical evaluation to `evaluate()` —
   * runs `evaluateCore()`, the exact same deny-overrides algorithm, and
   * fires the exact same `onDecision` observer — but ALSO returns the
   * per-rule trace `evaluateCore()` already builds internally. `evaluate()`
   * itself is deliberately left untouched (still discards the trace) so
   * every existing caller's return shape is byte-for-byte unchanged; this
   * is a purely additive new method, not a replacement.
   *
   * This is the ONLY thing Phase 14 needs from this engine: a real
   * evaluation (never a second, simplified copy of the combining logic)
   * that also reports which rules it consulted. Nothing here executes a
   * business action — this method calls registered `PolicyRule` functions
   * (pure authorization checks, per this file's own `PolicyRule` doc
   * comment) and nothing else.
   */
  async evaluateWithTrace(
    input: BuildAuthorizationRequestInput,
  ): Promise<{ decision: AuthorizationDecision; trace: RuleEvaluationTrace[]; request: AuthorizationRequest | undefined }> {
    const startedAt = Date.now();
    const { decision, request, trace } = await this.evaluateCore(input);
    const stamped = stampLatency(decision, startedAt);
    this.notifyObserver(stamped, request);
    return { decision: stamped, trace, request };
  }

  /** Fires the Phase 1C decision observer, if one was configured. Never
   *  throws and never delays the caller: failures (sync throw or rejected
   *  promise) are caught and dropped. Deliberately not awaited into
   *  evaluate()'s own return — see file header. */
  private notifyObserver(decision: AuthorizationDecision, request: AuthorizationRequest | undefined): void {
    if (!this.onDecision) return;
    try {
      const result = this.onDecision(decision, request);
      if (result && typeof (result as Promise<void>).catch === "function") {
        (result as Promise<void>).catch(() => {
          // Swallowed intentionally — see PolicyDecisionObserver's doc comment.
        });
      }
    } catch {
      // Swallowed intentionally — see PolicyDecisionObserver's doc comment.
    }
  }

  /**
   * Behavior unchanged from Phase 1A/1C — the "build request / handle
   * invalid-context / handle unauthenticated" preamble now delegates to
   * the Phase 08-extracted `resolveRequestOrEarlyDecision()` (see that
   * function's own header) instead of inlining the same three branches;
   * everything past that point (the deny-overrides loop) is untouched.
   */
  private async evaluateCore(
    input: BuildAuthorizationRequestInput,
  ): Promise<{ decision: AuthorizationDecision; request: AuthorizationRequest | undefined; trace: RuleEvaluationTrace[] }> {
    const resolved = resolveRequestOrEarlyDecision(input);
    if (resolved.earlyDecision) {
      // No rule ever ran (invalid context / unauthenticated short-circuits
      // before the loop below) — trace is empty, not missing, so a Phase
      // 14 caller can tell "nothing was consulted" apart from "consulted
      // rules but none had an opinion" (NO_MATCHING_POLICY, below).
      return { decision: resolved.earlyDecision, request: resolved.request, trace: [] };
    }
    const request = resolved.request;

    // Phase 14: every rule actually invoked is recorded here, in order,
    // INCLUDING abstentions (decision: null) — built unconditionally (not
    // only when a trace is requested) so `evaluate()` and
    // `evaluateWithTrace()` are guaranteed to observe the identical
    // execution, never two subtly different runs of the same loop.
    const trace: RuleEvaluationTrace[] = [];
    let firstAllow: AuthorizationDecision | null = null;

    for (const { id, rule } of this.rules) {
      let decision: AuthorizationDecision | null;
      try {
        // Phase 25: bounded by ruleTimeoutMs when the engine was
        // constructed with one — see PolicyEngineOptions.ruleTimeoutMs's
        // own doc comment. A timed-out rule rejects with
        // AuthorizationTimeoutError, landing in the same catch below as
        // any other throw, so it fails closed the exact same way.
        decision = await withTimeout(() => Promise.resolve(rule(request)), this.ruleTimeoutMs, `rule "${id}"`);
      } catch (cause) {
        // Fail-closed: a throwing rule always resolves the WHOLE evaluation
        // to deny, immediately — it does not just get skipped like an
        // abstention (null) would.
        const wrapped = new PolicyEvaluationError(
          `Policy "${id}" threw during evaluation`,
          id,
          cause,
        );
        const denyDecision = deny(request, "POLICY_EVALUATION_ERROR", { message: wrapped.message, policyId: id });
        trace.push({ id, decision: denyDecision });
        return { decision: denyDecision, request, trace };
      }

      trace.push({ id, decision });

      if (decision === null) continue; // abstain

      if (decision.effect === "DENY") {
        return { decision, request, trace }; // deny-overrides: short-circuit immediately
      }

      if (decision.effect === "STEP_UP" || decision.effect === "APPROVAL_REQUIRED") {
        return { decision, request, trace };
      }

      if (decision.effect === "ALLOW" && firstAllow === null) {
        firstAllow = decision;
        // Keep scanning — a later rule may still produce DENY, which must
        // override this ALLOW per the combining algorithm.
      }
    }

    if (firstAllow !== null) return { decision: firstAllow, request, trace };

    return {
      decision: deny(request, "NO_MATCHING_POLICY", {
        message: "No registered policy allowed this request",
      }),
      request,
      trace,
    };
  }
}
