/**
 * lib/policy/rebac/relationship-resolver.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 04 (ReBAC).
 *
 * `resolveRelations()` is the one place a `RelationshipProvider` is ever
 * queried. This is the concrete shape of the roadmap's explicit
 * instruction: "Create a relationship resolver abstraction. Do not
 * scatter relationship queries through routes." — `rebac-rule.ts` (the
 * only caller today) goes through this function instead of calling
 * `provider.getRelations()` directly, exactly as `rbac-rule.ts` goes
 * through `role-resolver.ts`'s `resolveEffectivePermissions()` instead of
 * walking `RbacProvider` itself. A future route/service that ever needs
 * "what relations does this user have on this resource" for something
 * other than a `PolicyRule` (e.g. an admin console screen — Phase 23)
 * calls this same function, not a fresh DB query.
 *
 * ── Why this needs a resolver at all, unlike ownership/org-access ────────
 * Ownership and organization-access (3A/3C) compare two fields already on
 * hand — no storage read, so no resolver was needed. RBAC's role graph
 * needs a bounded traversal (role-resolver.ts). Relationships need
 * neither traversal nor field comparison, but they DO need one thing
 * ownership/org-access don't: narrowing untrusted storage rows down to
 * the closed `RelationKind` vocabulary before anything downstream trusts
 * them (see `RelationshipProvider`'s contract in types.ts) — that
 * narrowing is this file's entire job.
 *
 * ── Fails closed on anything storage returns that isn't a known relation ──
 * A malformed/legacy/future-renamed relation string in the `relationships`
 * table (e.g. a row written by a schema version this code doesn't know
 * about yet) is silently DROPPED here, not thrown — same "fail closed by
 * discarding rather than trusting" posture
 * `drizzle-resource-grant-provider.ts` documents for a malformed `effect`
 * column. Dropping an unrecognized relation can only ever result in FEWER
 * relations being considered (a strictly safer outcome), never more.
 */

import { isRelationKind, type RelationKind, type RelationshipProvider } from "./types";

/**
 * Every relation `subjectUserId` holds on `(resourceType, resourceId)`,
 * narrowed to the closed `RelationKind` vocabulary. Never throws — an
 * unknown subject/resource simply contributes `[]`, per
 * `RelationshipProvider`'s own contract (see types.ts).
 */
export async function resolveRelations(
  provider: RelationshipProvider,
  subjectUserId: number,
  resourceType: string,
  resourceId: string,
): Promise<RelationKind[]> {
  const raw = await provider.getRelations(subjectUserId, resourceType, resourceId);
  const relations: RelationKind[] = [];
  for (const value of raw) {
    if (typeof value === "string" && isRelationKind(value) && !relations.includes(value)) {
      relations.push(value);
    }
  }
  return relations;
}
