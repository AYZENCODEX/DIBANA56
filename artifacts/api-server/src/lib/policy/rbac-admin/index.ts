/**
 * lib/policy/rbac-admin/index.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 23C (Admin Policy
 * Console — Roles, Permissions & Assignments sections).
 *
 * Barrel for everything under `lib/policy/rbac-admin/*` EXCEPT
 * `drizzle-rbac-admin-provider.ts` — that file alone imports
 * `@workspace/db`; every other file here is DB-free by design (see that
 * file's own header, and ../rbac/index.ts's identical precedent for
 * Phase 02). Import `./rbac-admin/drizzle-rbac-admin-provider` directly at
 * the one real call site that constructs it (`lib/rbac-admin-console.ts`).
 */

export * from "./types";
export * from "./errors";
export * from "./authorizer";
export * from "./rbac-admin-registry";
