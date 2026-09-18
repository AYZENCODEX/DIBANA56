/**
 * lib/policy/abac/index.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 05 (ABAC).
 *
 * Barrel for everything under `lib/policy/abac/*`. Unlike `rbac/index.ts`,
 * `resource/index.ts`, and `rebac/index.ts`, there is no Drizzle-backed
 * provider to exclude here — Phase 05 introduces no new DB table or
 * provider interface at all (every attribute an `AbacCondition` reads is
 * already present on `Subject`/`ResourceRef`/`PolicyContext` — see
 * attribute-resolver.ts's header). Every file in this directory is DB-free
 * and side-effect-free by design, which is what lets
 * `scripts/src/test-policy-abac.ts` run with nothing but in-memory
 * `AbacPolicyDefinition[]` literals.
 *
 * Phase 06 added `./dsl` — a text-to-`AbacCondition` compiler, re-exported
 * here too. It remains entirely DB-free and side-effect-free (a pure
 * tokenizer/parser), so the same "nothing to exclude" posture holds.
 */

export * from "./types";
export * from "./operators";
export * from "./attribute-resolver";
export * from "./condition-evaluator";
export * from "./abac-rule";
export * from "./dsl";
