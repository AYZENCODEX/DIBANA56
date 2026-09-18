/**
 * lib/policy/assurance/index.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 09 (Authentication
 * Assurance), sub-phase 9A.
 *
 * Barrel — re-exports everything 9A shipped. No Drizzle/DB provider exists
 * for this module (unlike `rbac/index.ts`, `resource/index.ts`,
 * `rebac/index.ts`, `registry/index.ts`, each of which excludes their own
 * `drizzle-*-provider.ts`) because 9A introduces no persistence at all —
 * `AssuranceRequirement[]` is passed in by whatever code registers
 * `createAssuranceRule()`, the same in-memory, caller-constructed posture
 * `abac/index.ts` already established for `AbacPolicyDefinition[]`.
 */

export * from "./types";
export * from "./assurance-level";
export * from "./assurance-rule";
