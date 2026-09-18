// Vault entity performance-score formula.
// ─────────────────────────────────────────────────────────────────────────────
// This is the single source of truth for turning an entity's raw signals —
// PnL, Progress, Risk — into the one 0-10 "performance score" that drives the
// rank badge (see src/lib/entity-rank.tsx) shown on the entity/vault card.
//
// Keeping this isolated from the UI means the weights (or the normalization
// curves) can be retuned here without touching vault.tsx, the entity dashboard,
// or the badge component itself — anything downstream just calls
// computeEntityPerformanceScore() / computePerformanceScore() and re-renders.
//
// ─── The three factors ────────────────────────────────────────────────────
//   PnL       — profit % relative to buy value (computeEntityProfitPct). How
//               much money this entity has made or lost.
//   Progress  — % of enrolled project tasks/projects completed. How far along
//               the entity's active work is.
//   Risk      — the entity's existing 0-10 health/quality score (see
//               computeAutoScore on the server + the manual "score" field).
//               This is already framed as *health* (higher = safer), so it
//               plugs in directly as the inverse of risk.
//
// Each factor is normalized onto a common 0-10 scale, then combined with
// configurable weights. Default weights are equal (1/3 each) — a reasonable
// starting point until real usage data suggests a factor should count more.

export interface PerformanceWeights {
  pnl: number;
  progress: number;
  risk: number;
}

/** Equal weighting to start — tune here, nowhere else, to change how much
 *  each factor moves the badge. Weights are normalized (don't need to sum to 1). */
export const DEFAULT_PERFORMANCE_WEIGHTS: PerformanceWeights = {
  pnl: 1 / 3,
  progress: 1 / 3,
  risk: 1 / 3,
};

export interface PerformanceInputs {
  /** Profit % relative to buy value, e.g. computeEntityProfitPct(entry). Null/undefined when there's no buy value to compare against (treated as neutral). */
  pnlPct: number | null | undefined;
  /** 0-100 project/task completion percentage. */
  progressPct: number | null | undefined;
  /** 0-10 health/quality score (higher = healthier = lower risk). */
  riskScore: number | null | undefined;
}

const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));

// ─── Per-factor normalization (each maps its raw input onto 0-10) ──────────

/** PnL: -50% or worse -> 0, breakeven (0%) -> 5, +50% or better -> 10.
 *  Linear in between. Unknown/undefined PnL (e.g. no buy value recorded)
 *  is treated as neutral (5) rather than penalizing the entity. */
export function normalizePnl(pnlPct: number | null | undefined): number {
  if (pnlPct === null || pnlPct === undefined || Number.isNaN(pnlPct)) return 5;
  return clamp((pnlPct + 50) / 10, 0, 10);
}

/** Progress: straight 0-100% -> 0-10 scale. No enrollment yet is treated as 0. */
export function normalizeProgress(progressPct: number | null | undefined): number {
  if (progressPct === null || progressPct === undefined || Number.isNaN(progressPct)) return 0;
  return clamp(progressPct, 0, 100) / 10;
}

/** Risk: the entity's health score is already 0-10 with higher = safer, so
 *  it's used as-is (just clamped/defaulted). */
export function normalizeRisk(riskScore: number | null | undefined): number {
  if (riskScore === null || riskScore === undefined || Number.isNaN(riskScore)) return 5;
  return clamp(riskScore, 0, 10);
}

/**
 * Combine the three normalized factors into one 0-10 performance score using
 * the given weights (defaults to equal weighting). This is the number that
 * should be handed to getEntityRank()/RankBadge to pick the badge tier.
 */
export function computePerformanceScore(
  inputs: PerformanceInputs,
  weights: PerformanceWeights = DEFAULT_PERFORMANCE_WEIGHTS
): number {
  const pnl = normalizePnl(inputs.pnlPct);
  const progress = normalizeProgress(inputs.progressPct);
  const risk = normalizeRisk(inputs.riskScore);

  const totalWeight = weights.pnl + weights.progress + weights.risk;
  if (totalWeight <= 0) return 5; // degenerate weights — fall back to neutral

  const weighted = (pnl * weights.pnl + progress * weights.progress + risk * weights.risk) / totalWeight;
  return clamp(Math.round(weighted * 10) / 10, 0, 10);
}

// ─── Convenience wrapper for vault entries ──────────────────────────────────
// Bundles the raw-signal extraction (PnL from entity-worth, progress from the
// per-entity project leaderboard row, risk from entry.score) so call sites in
// the UI stay a one-liner.

import { computeEntityProfitPct, type EntryAny } from "@/lib/entity-worth";

export interface EntityLeaderboardRow {
  vaultEntryId: number;
  totalProjects?: number;
  completedProjects?: number;
  // Phase 18 — per-status enrollment breakdown (Phase 5's disqualify/ban/
  // cancel-enrollment statuses), used for the vault card/quick-view status
  // flags + "Enrolled in N projects, M active" summary.
  activeProjects?: number;
  disqualifiedProjects?: number;
  bannedProjects?: number;
  cancelledProjects?: number;
}

/** completedProjects / totalProjects as a 0-100 percentage. 0 when the
 *  entity isn't enrolled in any projects yet. */
export function progressPctFromLeaderboardRow(row: EntityLeaderboardRow | null | undefined): number {
  if (!row || !row.totalProjects) return 0;
  return clamp((100 * (row.completedProjects ?? 0)) / row.totalProjects, 0, 100);
}

/**
 * One-call helper: given a vault entry and its (optional) leaderboard row,
 * returns the 0-10 performance score that should drive its badge.
 */
export function computeEntityPerformanceScore(
  entry: EntryAny,
  leaderboardRow?: EntityLeaderboardRow | null,
  weights: PerformanceWeights = DEFAULT_PERFORMANCE_WEIGHTS
): number {
  return computePerformanceScore(
    {
      pnlPct: computeEntityProfitPct(entry),
      progressPct: progressPctFromLeaderboardRow(leaderboardRow),
      riskScore: (entry as any)?.score,
    },
    weights
  );
}
