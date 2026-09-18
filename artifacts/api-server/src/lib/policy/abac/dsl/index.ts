/**
 * lib/policy/abac/dsl/index.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 06 (Policy DSL).
 *
 * Barrel for `lib/policy/abac/dsl/*`. Every file here is DB-free and
 * side-effect-free (a pure text → `AbacCondition` compiler), same posture
 * as the rest of `abac/*` — nothing new to exclude.
 */

export * from "./errors";
export * from "./tokenizer";
export * from "./parser";
export * from "./compile-policy";
