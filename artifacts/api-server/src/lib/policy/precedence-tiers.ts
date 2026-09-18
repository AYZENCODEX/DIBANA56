/**
 * lib/policy/precedence-tiers.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 08 (Policy Precedence).
 *
 * The roadmap's own Phase 08 section names 8 precedence tiers, in order:
 *
 *   1. Emergency security deny
 *   2. Global deny
 *   3. Tenant/org deny
 *   4. Resource deny
 *   5. Risk restriction
 *   6. Explicit grant
 *   7. Role grant
 *   8. Default deny
 *
 * This file is the ONE place that vocabulary is spelled out as data
 * (`PRECEDENCE_ORDER`) — `precedence-engine.ts`'s `PrecedenceEngine` reads
 * this array to decide which registered rules' decisions take priority over
 * which others; nothing computes or guesses tier order anywhere else.
 *
 * ── Tier 8 (Default deny) is NOT a rule tier ───────────────────────────────
 * `PRECEDENCE_ORDER` below lists only tiers 1-7 — every one of them is
 * something a `TieredPolicyRule` can be registered under. "Default deny" is
 * the Phase 01 engine's own built-in fallback (`NO_MATCHING_POLICY`) when
 * every registered tier abstains — it was already correct
 * (`policy-engine.ts`'s `NO_MATCHING_POLICY` path, Rule 7) before this
 * phase and needs no new code, only to remain last in the effective
 * ordering. `PrecedenceEngine.evaluate()` (precedence-engine.ts) falls back
 * to it automatically once every tier in `PRECEDENCE_ORDER` has been tried.
 *
 * ── Which of today's existing rules maps to which tier ─────────────────────
 * Phase 08 does NOT invent new rules for the tiers no phase has built yet
 * (Rule 16 — "do not implement future phases prematurely"). Tiers 1
 * (emergency security deny), 2 (global deny), and 5 (risk restriction) are
 * RESERVED — declared here, priority-ordered correctly, but nothing is
 * registered under them today because no phase has shipped a rule that
 * belongs there yet (a kill-switch/incident-deny rule and Phase 10's risk
 * engine are future work). Tier 3 (tenant/org deny) is likewise reserved
 * for a DENY-producing org-boundary rule — Phase 03/04's own
 * `organization-access-rule.ts` deliberately never denies (see that file's
 * header: an explicit `deny()` there would wrongly foreclose other rules'
 * chance to allow a cross-org case some other grant legitimately covers),
 * so it does not occupy this tier; a Phase 06/07-authored ABAC/DSL policy
 * whose author explicitly intends a hard tenant-boundary deny is the
 * intended occupant, registered at this tier BY WHOEVER WIRES IT UP (see
 * `precedence-engine.ts`'s header for why tier assignment is a
 * registration-time choice, not something inferred from a decision's
 * `reason` code). Every EXISTING rule from Phases 02-06 maps cleanly to one
 * of the four tiers that already have real occupants:
 *
 *   | Tier                  | Existing rule(s) that belong here                                    |
 *   |------------------------|-----------------------------------------------------------------------|
 *   | 4. Resource deny       | `resource/locked-resource-rule.ts` (RESOURCE_LOCKED); the DENY half   |
 *   |                        | of `resource/explicit-grant-rule.ts` (RESOURCE_GRANT_DENIED)          |
 *   | 6. Explicit grant      | `resource/ownership-rule.ts`; the ALLOW half of                       |
 *   |                        | `resource/explicit-grant-rule.ts`; `rebac/rebac-rule.ts`              |
 *   | 7. Role grant          | `rbac/rbac-rule.ts`                                                   |
 *
 * ABAC (`abac/abac-rule.ts`) is deliberately NOT listed in that table —
 * unlike every other Phase 02-05 rule, a single ABAC/DSL policy's intended
 * tier depends entirely on what its author wrote it to mean (a
 * `subject.organization == resource.organization`-style policy belongs at
 * tier 3; a policy scoped to one resource's own state belongs at tier 4;
 * a broad attribute-based grant belongs at tier 6). Phase 08 does not
 * hardcode ABAC to one tier — see `precedence-engine.ts`'s header for how a
 * caller assigns the right tier to a specific compiled ABAC policy at
 * registration time. `scripts/src/test-policy-precedence.ts` demonstrates
 * this directly by registering one DSL-compiled policy at tier 3.
 */

/** Ordered highest-precedence-first. Index 0 wins over every later index
 *  when both have an opinion — see `precedence-engine.ts`'s
 *  `PrecedenceEngine.evaluateCore()` for exactly how ties within the SAME
 *  tier are broken (deny-overrides, same algorithm Phase 1A already uses
 *  across an unteired rule list). */
export const PRECEDENCE_ORDER = [
  "EMERGENCY_SECURITY_DENY",
  "GLOBAL_DENY",
  "TENANT_ORG_DENY",
  "RESOURCE_DENY",
  "RISK_RESTRICTION",
  "EXPLICIT_GRANT",
  "ROLE_GRANT",
] as const;

export type PrecedenceTier = (typeof PRECEDENCE_ORDER)[number];

/** `PRECEDENCE_ORDER[i]`'s 1-based roadmap-numbered rank, for logging/audit
 *  messages that want to say "tier 3" rather than the tier's own
 *  identifier. Derived, not hand-maintained, so it can never drift out of
 *  sync with `PRECEDENCE_ORDER`'s actual array order. */
export const PRECEDENCE_RANK: Readonly<Record<PrecedenceTier, number>> = Object.fromEntries(
  PRECEDENCE_ORDER.map((tier, index) => [tier, index + 1]),
) as Record<PrecedenceTier, number>;

/** Human-readable label matching the roadmap's own wording verbatim —
 *  used only for logging/documentation, never for comparison logic
 *  (`PRECEDENCE_ORDER`'s array position is the only thing that matters
 *  for actual precedence). */
export const PRECEDENCE_TIER_LABELS: Readonly<Record<PrecedenceTier, string>> = {
  EMERGENCY_SECURITY_DENY: "Emergency security deny",
  GLOBAL_DENY: "Global deny",
  TENANT_ORG_DENY: "Tenant/org deny",
  RESOURCE_DENY: "Resource deny",
  RISK_RESTRICTION: "Risk restriction",
  EXPLICIT_GRANT: "Explicit grant",
  ROLE_GRANT: "Role grant",
};

function isPrecedenceTier(value: string): value is PrecedenceTier {
  return (PRECEDENCE_ORDER as readonly string[]).includes(value);
}

/** Throws if `tier` is not one of `PRECEDENCE_ORDER`'s 7 values — used by
 *  `PrecedenceEngine.registerRule()` (precedence-engine.ts) so a typo'd
 *  tier string fails loudly at registration time instead of silently
 *  sorting to the wrong place (or nowhere) at evaluation time. */
export function assertValidPrecedenceTier(tier: string): asserts tier is PrecedenceTier {
  if (!isPrecedenceTier(tier)) {
    throw new Error(`"${tier}" is not a valid precedence tier. Valid tiers: ${PRECEDENCE_ORDER.join(", ")}.`);
  }
}
