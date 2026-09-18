/**
 * lib/policy/resource-admin/index.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 23D (Admin Policy
 * Console — Resources section).
 *
 * Barrel for everything under `lib/policy/resource-admin/*` EXCEPT
 * `drizzle-resource-admin-provider.ts` — that file alone imports
 * `@workspace/db`; every other file here is DB-free by design (see that
 * file's own header, and ../rbac-admin/index.ts's identical precedent for
 * Phase 23C). Import `./resource-admin/drizzle-resource-admin-provider`
 * directly at the one real call site that constructs it
 * (`lib/resource-admin-console.ts`).
 */

export * from "./types";
export * from "./errors";
export * from "./authorizer";
export * from "./resource-admin-registry";
