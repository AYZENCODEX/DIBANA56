/**
 * lib/policy/rebac/types.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 04 (ReBAC).
 *
 * The relation vocabulary and the one interface every other rebac/* file is
 * written against — `relationship-resolver.ts`, `relation-action-map.ts`,
 * `rebac-rule.ts`, and `drizzle-relationship-provider.ts` all import
 * `RelationKind`/`RelationshipProvider` from here, and none of them import
 * `@workspace/db` directly except `drizzle-relationship-provider.ts` (see
 * that file's header). `scripts/src/test-policy-rebac.ts`'s in-memory
 * `FakeRelationshipProvider` implements this exact same interface, which is
 * what lets the whole ReBAC rule chain be unit-tested without a database —
 * same posture `rbac/types.ts` and `resource/types.ts` already established.
 */

/**
 * The seven relation kinds the roadmap's Phase 04 section names, verbatim.
 * A closed vocabulary (not an open string) so every consumer — the
 * relation→action-verb map, the resolver's defensive filtering, tests —
 * shares one authoritative list instead of each re-deriving it.
 */
export const RELATION_KINDS = [
  "owner",
  "member",
  "manager",
  "viewer",
  "editor",
  "approver",
  "auditor",
] as const;

export type RelationKind = (typeof RELATION_KINDS)[number];

/** True for any string that is one of `RELATION_KINDS` — the one place
 *  that check happens, so a malformed/unknown value read back from
 *  storage (see relationship-resolver.ts) is recognized consistently
 *  everywhere else in this module. */
export function isRelationKind(value: string): value is RelationKind {
  return (RELATION_KINDS as readonly string[]).includes(value);
}

/**
 * Everything the ReBAC `PolicyRule` (rebac-rule.ts) needs from storage —
 * "the relationship resolver abstraction" the roadmap's Phase 04 section
 * explicitly calls for ("Create a relationship resolver abstraction. Do
 * not scatter relationship queries through routes."). `DrizzleRelationship
 * Provider` (drizzle-relationship-provider.ts) is the real,
 * `@workspace/db`-backed implementation; `FakeRelationshipProvider`
 * (test-policy-rebac.ts) is the in-memory stand-in tests use.
 *
 * Contract every implementation must honor:
 *   - Never throw for "not found" — no matching rows means `[]`, exactly
 *     like `RbacProvider`'s "unknown key contributes nothing" contract.
 *   - Read-only. No method here ever mutates state (writing a relationship
 *     is a future org/team-management-feature concern — see the Phase 04
 *     CHANGES doc's "not done" section).
 *   - Return raw strings, not `RelationKind` — a storage row is untrusted
 *     input (see relationship-resolver.ts, which is the one place that
 *     narrows/filters this return value with `isRelationKind()` before
 *     anything else in this module trusts it). This mirrors
 *     `drizzle-resource-grant-provider.ts`'s own "narrow at the boundary,
 *     fail closed on a malformed row" posture for `effect`.
 */
export interface RelationshipProvider {
  /** Every relation `subjectUserId` holds on the exact resource
   *  `(resourceType, resourceId)` — e.g. `["member", "manager"]` if the
   *  subject is both (see relationships.ts's schema-file header for why a
   *  subject can hold more than one relation on the same resource). Exact
   *  match only, same trust boundary `ResourceGrantProvider.getResourceGrant`
   *  documents: this rule never fetches "everything this subject can
   *  reach", only the one resource the caller asked about. */
  getRelations(subjectUserId: number, resourceType: string, resourceId: string): Promise<string[]>;
}
