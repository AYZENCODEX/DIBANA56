/**
 * lib/policy/audit/index.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 17 (Authorization Audit).
 *
 * Barrel for everything under `lib/policy/audit/*` EXCEPT
 * `drizzle-audit-writer.ts`. That file alone imports `@workspace/db`;
 * every other file here (types.ts, to-audit-entry.ts, audit-observer.ts)
 * is DB-free by design (see drizzle-audit-writer.ts's own header), which
 * is what lets `scripts/src/test-policy-audit.ts` run with nothing but an
 * in-memory fake `AuthorizationAuditWriter`. Same reasoning
 * `../registry/index.ts`, `../rbac/index.ts`, and every other Drizzle-
 * backed phase's own barrel already gives for its own provider. Import
 * `./audit/drizzle-audit-writer` directly at the one real call site that
 * actually constructs it.
 */

export * from "./types";
export * from "./to-audit-entry";
export * from "./audit-observer";
