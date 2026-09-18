/**
 * lib/policy/pip/drizzle-organization-provider.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Workspace — Phase 8 (Organization Accounts), completing Phase 18's
 * `OrganizationProvider` interface (../pip/organization-provider.ts).
 *
 * That file shipped deliberately unimplemented — its own header explains
 * why: "AYZEN has no organizations table (confirmed against
 * lib/db/src/schema/*)". Migration 109 (Phase 8) added one. This is the
 * `DrizzleOrganizationProvider` that file's own doc comment said a future
 * organizations feature would need "an authoritative shape to implement
 * against" — this is that implementation, against the real shape.
 *
 * Honors the interface's contract exactly:
 *  - Never throws for "no memberships" — returns `[]`.
 *  - Read-only — no method here mutates state.
 *  - Only ACTIVE memberships count ('pending' invites are not yet real
 *    membership for authorization purposes — same status vocabulary
 *    `organization_members.status` already uses, and the same posture
 *    `teams.ts`'s own pending-vs-active distinction takes for the farming-
 *    team product).
 *
 * ── Still "additive, unwired into the live request path" ──────────────────
 * Same posture `organization-access-rule.ts` and `organization-provider.ts`
 * shipped with, restated honestly here: nothing in `routes/*.ts` constructs
 * a `PolicyInformationPoint` with this provider wired in yet (see
 * `pip/policy-information-point.ts`'s own header — "nothing in the app
 * constructs a PolicyInformationPoint yet"), so `Subject.organizationId`
 * is still `undefined` on every live `authorize()` call today, and
 * `organization-access-rule.ts` still abstains on every real request. This
 * file makes the provider real and testable; wiring it into a live PEP
 * call site (so a route can actually grant same-org access via the PDP,
 * rather than routes/organizations.ts's own direct membership checks,
 * which is what actually gates org routes in this phase) is a follow-up,
 * not invented here — see this phase's CHANGES doc.
 */

import { db, organizationMembersTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import type { OrganizationMembership, OrganizationProvider } from "./organization-provider";

export class DrizzleOrganizationProvider implements OrganizationProvider {
  async getMemberships(userId: number): Promise<OrganizationMembership[]> {
    try {
      const rows = await db
        .select({ organizationId: organizationMembersTable.organizationId, role: organizationMembersTable.role })
        .from(organizationMembersTable)
        .where(and(eq(organizationMembersTable.userId, userId), eq(organizationMembersTable.status, "active")));
      return rows.map((r) => ({ organizationId: r.organizationId, role: r.role }));
    } catch {
      // Same "unknown key contributes nothing" posture every other
      // *Provider in this engine documents — a DB error here should
      // degrade to "no organization facts", never throw into the PDP.
      return [];
    }
  }
}
