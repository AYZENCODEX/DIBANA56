/**
 * lib/policy/rbac/index.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 02 (RBAC).
 *
 * Barrel for everything under `lib/policy/rbac/*` EXCEPT
 * `drizzle-rbac-provider.ts`. That file alone imports `@workspace/db` (a
 * real DB dependency); every other file here is DB-free and side-effect-free
 * by design (see permission-matcher.ts / role-resolver.ts / rbac-rule.ts /
 * legacy-role-map.ts headers), which is what lets
 * `scripts/src/test-policy-rbac.ts` run with nothing but an in-memory
 * `FakeRbacProvider`. Re-exporting the Drizzle provider from this same
 * barrel would drag `@workspace/db` into that DB-free guarantee for every
 * consumer of `./rbac` (and, transitively, of `lib/policy`'s own top-level
 * barrel — see ../index.ts) — so it is deliberately left out. Import
 * `./rbac/drizzle-rbac-provider` directly at the one real call site that
 * actually constructs it.
 */

export * from "./types";
export * from "./permission-matcher";
export * from "./role-resolver";
export * from "./legacy-role-map";
export * from "./rbac-rule";
export * from "./any-permission-rule";
