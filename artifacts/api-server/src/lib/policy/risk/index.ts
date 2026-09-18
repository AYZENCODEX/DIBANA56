/**
 * lib/policy/risk/index.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 10 (Risk-Aware
 * Authorization), sub-phase 10A.
 *
 * Barrel — re-exports everything 10A shipped. No Drizzle/DB provider here
 * either, for the same reason `assurance/index.ts` has none: 10A reads
 * `Subject.riskLevel`, a field this engine already has and something
 * else (a future risk-calculation sub-phase, or a future PIP adapter)
 * populates — this module never queries a database itself.
 */

export * from "./risk-rule";
