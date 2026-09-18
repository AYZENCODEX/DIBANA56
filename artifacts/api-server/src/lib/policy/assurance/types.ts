/**
 * lib/policy/assurance/types.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 09 (Authentication
 * Assurance), sub-phase 9A.
 *
 * The roadmap's own Phase 09 section names 6 levels, in order:
 *
 *   L0  unauthenticated
 *   L1  normal authenticated session
 *   L2  verified authentication
 *   L3  MFA
 *   L4  passkey
 *   L5  fresh high-assurance authentication
 *
 * This file is the ONE place that vocabulary is spelled out as data
 * (`ASSURANCE_LEVEL_ORDER`) — `assurance-level.ts`'s `computeAssuranceLevel()`
 * and `assurance-rule.ts`'s `createAssuranceRule()` both read this array (via
 * `ASSURANCE_RANK`) to decide "is level X at least as strong as requirement
 * Y" — nothing computes or guesses level order anywhere else. Same posture
 * `precedence-tiers.ts` (Phase 08) already established for tier order: one
 * ordered array, one rank lookup derived from it, everything else reads
 * from there rather than re-encoding the ordering.
 *
 * ── Why a total order over 6 discrete levels, not a bitset/capability set ──
 * The roadmap frames these as levels ("Sensitive operations can require
 * minimum assurance"), i.e. "at least L3", not "has capability {totp,
 * passkey}". A caller wanting a bitset-like richer model (e.g. "requires
 * TOTP specifically, passkey doesn't substitute") is better served
 * reasoning over `Subject.assuranceMethods` directly via an ABAC condition
 * (`abac/abac-rule.ts` already supports `subject.assuranceMethods in [...]`)
 * — this module's job is only the roadmap's own simpler "minimum level"
 * gate, the same way `precedence-tiers.ts` only models the roadmap's own
 * "which tier wins" question and leaves anything richer to ABAC/DSL.
 *
 * ── L5 is a MODIFIER, not a stronger method ─────────────────────────────
 * L4 ("passkey") names a specific credential type; L5 ("fresh high-
 * assurance authentication") names a RECENCY property that can apply to
 * *any* already-strong authentication event (a password re-entry, an OTP,
 * a passkey — see `Subject`'s own `authenticationFreshnessSeconds` doc
 * comment in ../types.ts: "distinct from sessionAgeSeconds ... a session
 * can be old while its last strong-auth moment was recent, e.g. a step-up
 * just completed"). `assurance-level.ts`'s header explains exactly how
 * `computeAssuranceLevel()` reconciles a method-derived base level with a
 * recency-derived L5 upgrade — this file only fixes L5's RANK (the
 * strongest), not how it's reached.
 */

/** Ordered weakest-first. Index 0 (`L0`) is the roadmap's own "no
 *  authentication at all" floor; index 5 (`L5`) is its ceiling. See
 *  `assurance-level.ts`'s `computeAssuranceLevel()` for exactly how a
 *  `Subject`/`PolicyContext` pair resolves to one of these. */
export const ASSURANCE_LEVEL_ORDER = ["L0", "L1", "L2", "L3", "L4", "L5"] as const;

export type AssuranceLevel = (typeof ASSURANCE_LEVEL_ORDER)[number];

/** `ASSURANCE_LEVEL_ORDER[i]`'s own rank — a plain integer so
 *  `assuranceLevelMeetsMinimum()` (assurance-level.ts) can compare two
 *  levels with `>=` instead of an array `indexOf()` at every call site.
 *  Derived, not hand-maintained, so it can never drift out of sync with
 *  `ASSURANCE_LEVEL_ORDER`'s actual array order — same pattern
 *  `precedence-tiers.ts`'s `PRECEDENCE_RANK` already established. */
export const ASSURANCE_RANK: Readonly<Record<AssuranceLevel, number>> = Object.fromEntries(
  ASSURANCE_LEVEL_ORDER.map((level, index) => [level, index]),
) as Record<AssuranceLevel, number>;

/** Human-readable label matching the roadmap's own wording verbatim — used
 *  only for logging/documentation/decision messages, never for comparison
 *  logic (`ASSURANCE_RANK` is the only thing that matters for actual
 *  comparisons). */
export const ASSURANCE_LEVEL_LABELS: Readonly<Record<AssuranceLevel, string>> = {
  L0: "Unauthenticated",
  L1: "Normal authenticated session",
  L2: "Verified authentication",
  L3: "MFA",
  L4: "Passkey",
  L5: "Fresh high-assurance authentication",
};

function isAssuranceLevel(value: string): value is AssuranceLevel {
  return (ASSURANCE_LEVEL_ORDER as readonly string[]).includes(value);
}

/** Throws if `level` is not one of `ASSURANCE_LEVEL_ORDER`'s 6 values —
 *  used by `createAssuranceRule()` (assurance-rule.ts) so a typo'd minimum-
 *  assurance string fails loudly at registration time instead of silently
 *  comparing against `undefined` (which `ASSURANCE_RANK[bad as never]`
 *  would otherwise do) at evaluation time. Same posture
 *  `assertValidPrecedenceTier()` (precedence-tiers.ts) already established
 *  for tier strings. */
export function assertValidAssuranceLevel(level: string): asserts level is AssuranceLevel {
  if (!isAssuranceLevel(level)) {
    throw new Error(`"${level}" is not a valid assurance level. Valid levels: ${ASSURANCE_LEVEL_ORDER.join(", ")}.`);
  }
}
