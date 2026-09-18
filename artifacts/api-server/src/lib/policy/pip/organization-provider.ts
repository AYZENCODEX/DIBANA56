/**
 * lib/policy/pip/organization-provider.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 18 (PIP / Attribute
 * Providers).
 *
 * The roadmap's Phase 18 section names an `OrganizationProvider` alongside
 * `SubjectProvider`/`SessionProvider`/etc. This file gives that vocabulary a
 * concrete shape. It deliberately ships NO real implementation — AYZEN has
 * no `organizations` table (confirmed against `lib/db/src/schema/*` for
 * this phase; there is no organizations/orgs/teams schema file anywhere in
 * this codebase). This has been noted, unchanged, since Phase 01:
 * `subject-adapter.ts`'s own header ("AYZEN has no organizations table
 * yet") and `../types.ts`'s `Subject.organizationId`/`ResourceRef.
 * organizationId` doc comments ("Not modeled by the current schema yet").
 *
 * Shipping any implementation today — even one that always returns an
 * empty list — would misleadingly suggest organization membership is a
 * modeled concept in this codebase when it is not, and would give a future
 * ABAC/ReBAC condition referencing `subject.organizationId` false
 * confidence that SOMETHING populates it. That is exactly the "convert
 * mock functionality into production functionality without real backend
 * support" Rule 18 forbids — see `resource-attribute-provider.ts`'s own
 * header for the identical reasoning applied to `ResourceProvider`.
 *
 * This interface exists so that once an actual organizations/teams feature
 * ships (a real product decision, not a Phase 18 concern — Rule 16), a
 * `DrizzleOrganizationProvider` has an authoritative shape to implement
 * against from day one, rather than each future organization-aware
 * route/rule inventing its own ad hoc membership query.
 *
 * UPDATE — Phase 8 (Organization Accounts): AYZEN now has an
 * `organizations`/`organization_members` table (migration 109), and
 * `./drizzle-organization-provider.ts`'s `DrizzleOrganizationProvider` is a
 * real implementation of this interface. See that file's own header for
 * what is (and, honestly, is not yet) wired up. This interface itself is
 * unchanged by that — it was already the correct shape to implement
 * against.
 */

/** One (user, organization) membership fact a future implementation would
 *  read from an eventual `organizations`/`organization_members` table. */
export interface OrganizationMembership {
  organizationId: number;
  /** Membership-scoped role, if orgs ever have their own role vocabulary
   *  distinct from the platform-wide `Subject.role` (Phase 02's RBAC role)
   *  — left optional/unspecified since no such vocabulary exists yet. */
  role?: string;
}

/**
 * Everything a future organization-aware PIP adapter would need. Contract a
 * future implementation must honor:
 *   - Never throw for "no memberships" — return `[]`, same "unknown key
 *     contributes nothing" posture every other *Provider in this engine
 *     documents (e.g. `RelationshipProvider.getRelations()`).
 *   - Read-only. No method here mutates state.
 */
export interface OrganizationProvider {
  getMemberships(userId: number): Promise<OrganizationMembership[]>;
}
