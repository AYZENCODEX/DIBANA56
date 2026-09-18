/**
 * lib/policy/test-framework/index.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 21A (Policy Test
 * Framework — declarative model).
 *
 * Barrel for everything under `lib/policy/test-framework/*`. No Drizzle
 * provider to exclude here (same posture ../pep/index.ts's own header
 * establishes for that directory) — this whole directory is pure types
 * plus an in-memory runner; the only thing it ever touches is a caller-
 * supplied `PolicyEngine`/`PrecedenceEngine`, never a database directly.
 */

export * from "./types";
export * from "./runner";
