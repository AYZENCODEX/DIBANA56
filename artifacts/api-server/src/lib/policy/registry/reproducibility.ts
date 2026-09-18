/**
 * lib/policy/registry/reproducibility.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 16 (Policy Versioning).
 *
 * `getDecisionPolicySnapshot()` is the roadmap's own Phase 16 line, made
 * concrete: "Historical decisions must remain reproducible." A decision
 * produced by `registry-rule-loader.ts`'s `createRegistryPolicyRule()`
 * carries `policyId`/`policyVersion` (../types.ts) stamped from the EXACT
 * `PolicyRecord` that decided it. This function is the read half of that
 * guarantee: given those two fields, look the exact original row back up
 * — by `(policyId, version)`, a specific immutable row, NEVER by
 * `getActivePolicy(policyId)` (which returns whatever is active NOW,
 * possibly a different, later version that has since superseded the one
 * that actually produced this decision).
 *
 * ── Why this can't just be `provider.getPolicy()` inlined at each call site ──
 * Two things a caller must get right every time, that a shared helper gets
 * right once:
 *   1. `decision.policyId`/`decision.policyVersion` are both OPTIONAL
 *      (undefined for any decision not produced by a registry-backed rule
 *      — every Phase 02-13 rule factory, see types.ts's own doc comment on
 *      `policyVersion`). A caller that forgets to guard for `undefined`
 *      before calling `provider.getPolicy(id, version)` risks passing
 *      `undefined` as a version, which — per `PolicyRegistryProvider.getPolicy()`'s
 *      own contract (registry/types.ts) — means "give me the HIGHEST
 *      version", silently returning the wrong (possibly much newer,
 *      possibly not even the same content) row instead of failing loudly.
 *   2. `getPolicy()` already returns `null` for "not found" rather than
 *      throwing (registry/types.ts's own provider contract) — this
 *      function preserves that "empty/null, not an exception" posture
 *      rather than wrapping it in a try/catch a caller has to remember to
 *      add.
 *
 * Read-only, side-effect-free, and — like every other function in this
 * engine that only reads already-durable state — never mutates anything
 * (Rule 11's "immutable after creation" is what makes this whole guarantee
 * possible in the first place: if `insertVersion` ever mutated an existing
 * row in place instead of always inserting a new one, this lookup could
 * return content that has silently changed since the decision was made).
 */

import type { PolicyRecord, PolicyRegistryProvider } from "./types";

/**
 * Resolves the EXACT `PolicyRecord` that produced `decision`, by its
 * stamped `(policyId, policyVersion)` pair — never by "whatever is active
 * now". Returns `null` when:
 *   - `decision.policyId` or `decision.policyVersion` is `undefined`
 *     (the decision was not produced by a registry-backed rule at all —
 *     there is nothing to look up); or
 *   - the `(policyId, version)` pair does not resolve to any row on file
 *     (an unknown/never-existed pair).
 * Never throws — mirrors `PolicyRegistryProvider.getPolicy()`'s own
 * "empty/null, not an exception" contract (registry/types.ts).
 */
export async function getDecisionPolicySnapshot(
  decision: { policyId?: string; policyVersion?: number },
  provider: PolicyRegistryProvider,
): Promise<PolicyRecord | null> {
  if (decision.policyId === undefined || decision.policyVersion === undefined) {
    return null;
  }
  return provider.getPolicy(decision.policyId, decision.policyVersion);
}
