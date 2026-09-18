/**
 * lib/policy/explain/index.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 15 (Explainability).
 *
 * Barrel — re-exports everything Phase 15 shipped. No Drizzle/DB provider
 * to exclude here: `viewer-authorization.ts` depends only on the already
 * DB-free `RbacProvider` interface (../rbac/types.ts), never on
 * `@workspace/db` directly — same posture ../rbac/rbac-rule.ts itself
 * already has (the concrete `DrizzleRbacProvider` implementation is what a
 * real call site supplies; this module, like rbac-rule.ts, only depends on
 * the interface).
 */

export * from "./types";
export * from "./explain-authorization";
export * from "./viewer-authorization";
