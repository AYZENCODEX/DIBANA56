/**
 * lib/policy/sod/index.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 13 (Separation of Duties).
 *
 * Barrel — re-exports everything Phase 13 shipped. No Drizzle/DB provider
 * here, for the same reason `assurance/index.ts` / `risk/index.ts` have
 * none: this phase introduces no new persistence at all — it reuses
 * `ResourceRef.ownerId` (already on every request, Phase 01) and Phase 04's
 * existing `RelationshipProvider`/`resolveRelations()` resolver, never a
 * new schema or a new storage read of its own.
 */

export * from "./types";
export * from "./separation-of-duties-rule";
