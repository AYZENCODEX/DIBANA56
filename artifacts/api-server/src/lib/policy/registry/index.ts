/**
 * lib/policy/registry/index.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 07 (Policy Registry / PAP).
 *
 * Barrel for everything under `lib/policy/registry/*` EXCEPT
 * `drizzle-policy-registry-provider.ts`. That file alone imports
 * `@workspace/db`; every other file here (types.ts, errors.ts, lifecycle.ts,
 * authorizer.ts, policy-registry.ts) is DB-free by design (see
 * drizzle-policy-registry-provider.ts's own header), which is what lets
 * `scripts/src/test-policy-registry.ts` run with nothing but an in-memory
 * `FakePolicyRegistryProvider`. Same reasoning `../rbac/index.ts` and
 * `../rebac/index.ts` already give for their own Drizzle providers. Import
 * `./registry/drizzle-policy-registry-provider` directly at the one real
 * call site that actually constructs it.
 *
 * Phase 16 (Policy Versioning) added `registry-rule-loader.ts`
 * (`createRegistryPolicyRule()`/`createRegistryPolicyRules()`) and
 * `reproducibility.ts` (`getDecisionPolicySnapshot()`) — both DB-free (see
 * each file's own header), so they join this same barrel rather than
 * needing one of their own; `assertVersionSlotFree()` itself lives inside
 * `policy-registry.ts` (already re-exported below), not a separate file.
 */

export * from "./types";
export * from "./errors";
export * from "./lifecycle";
export * from "./authorizer";
export * from "./policy-registry";
export * from "./registry-rule-loader";
export * from "./reproducibility";
