/**
 * lib/policy/temporary-access/index.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 11 (Temporary / Expiring
 * Access).
 *
 * Barrel for everything under `lib/policy/temporary-access/*` EXCEPT
 * `drizzle-temporary-access-grant-provider.ts`. That file alone imports
 * `@workspace/db` (a real DB dependency); every other file here is DB-free
 * and side-effect-free by design (see temporary-access-rule.ts's / types.ts's
 * headers), which is what lets `scripts/src/test-policy-temporary-access.ts`
 * run with nothing but an in-memory fake. Re-exporting the Drizzle provider
 * from this same barrel would drag `@workspace/db` into that DB-free
 * guarantee for every consumer of `./temporary-access` (and, transitively,
 * of `lib/policy`'s own top-level barrel — see ../index.ts) — same
 * reasoning `../resource/index.ts`'s own header gives for its own Drizzle
 * provider. Import `./temporary-access/drizzle-temporary-access-grant-provider`
 * directly at the one real call site that actually constructs it.
 */

export * from "./types";
export * from "./temporary-access-rule";
