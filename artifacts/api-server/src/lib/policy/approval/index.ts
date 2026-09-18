/**
 * lib/policy/approval/index.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 12 (Approval Engine).
 *
 * Barrel for everything under `lib/policy/approval/*` EXCEPT
 * `drizzle-approval-request-provider.ts`. That file alone imports
 * `@workspace/db` (a real DB dependency); every other file here is DB-free
 * and side-effect-free by design (see types.ts's / approval-engine.ts's own
 * headers), which is what lets `scripts/src/test-policy-approval.ts` run
 * with nothing but an in-memory `FakeApprovalRequestProvider`. Re-exporting
 * the Drizzle provider from this same barrel would drag `@workspace/db`
 * into that DB-free guarantee for every consumer of `./approval` (and,
 * transitively, of `lib/policy`'s own top-level barrel — see ../index.ts) —
 * same reasoning `../temporary-access/index.ts`'s and every earlier phase's
 * own Drizzle-provider barrel already established. Import
 * `./approval/drizzle-approval-request-provider` directly at the one real
 * call site that actually constructs it.
 */

export * from "./types";
export * from "./errors";
export * from "./approval-engine";
export * from "./approval-gate-rule";
