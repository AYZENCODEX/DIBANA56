/**
 * lib/policy/rebac/index.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 04 (ReBAC).
 *
 * Barrel for everything under `lib/policy/rebac/*` EXCEPT
 * `drizzle-relationship-provider.ts`. That file alone imports
 * `@workspace/db` (a real DB dependency); every other file here is DB-free
 * and side-effect-free by design (see types.ts / relation-action-map.ts /
 * relationship-resolver.ts / rebac-rule.ts headers), which is what lets
 * `scripts/src/test-policy-rebac.ts` run with nothing but an in-memory
 * `FakeRelationshipProvider`. Re-exporting the Drizzle provider from this
 * same barrel would drag `@workspace/db` into that DB-free guarantee for
 * every consumer of `./rebac` (and, transitively, of `lib/policy`'s own
 * top-level barrel — see ../index.ts) — same reasoning `../rbac/index.ts`'s
 * and `../resource/index.ts`'s own headers give for their respective
 * Drizzle providers. Import `./rebac/drizzle-relationship-provider`
 * directly at the one real call site that actually constructs it.
 */

export * from "./types";
export * from "./relation-action-map";
export * from "./relationship-resolver";
export * from "./rebac-rule";
