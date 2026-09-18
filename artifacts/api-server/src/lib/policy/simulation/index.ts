/**
 * lib/policy/simulation/index.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 14 (Policy Simulation).
 * Barrel. No Drizzle provider to exclude — this phase introduces no new
 * persistence at all (`policy-simulator.ts`'s optional `registryProvider`
 * reuses Phase 07's existing `PolicyRegistryProvider` interface; it does
 * not construct or require a real Drizzle-backed one).
 */

export * from "./types";
export * from "./policy-simulator";
