/**
 * lib/policy/observability/index.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 24 (Observability).
 *
 * Barrel for everything under `lib/policy/observability/*`. Every file
 * here is DB-free and side-effect-free at import time (the singletons in
 * `./runtime-registries.ts` are plain in-memory objects, not open
 * connections/timers — same "safe to barrel" bar `./decision-observer.ts`
 * and every other Phase 1C+ observer file already clears), so unlike
 * `../rbac/index.ts`/`../registry/index.ts`/etc. there is no Drizzle
 * provider to exclude here.
 */

export * from "./metrics-registry";
export * from "./metrics-observer";
export * from "./access-pattern-registry";
export * from "./access-pattern-observer";
export * from "./dashboards";
export * from "./runtime-registries";
