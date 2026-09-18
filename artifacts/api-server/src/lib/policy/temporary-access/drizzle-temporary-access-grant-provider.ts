/**
 * lib/policy/temporary-access/drizzle-temporary-access-grant-provider.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 11 (Temporary / Expiring
 * Access).
 *
 * The real, `@workspace/db`-backed `TemporaryAccessGrantProvider` (see
 * ./types.ts for the interface). Same posture as
 * `resource/drizzle-resource-grant-provider.ts`: this is the one file in
 * `lib/policy/temporary-access/*` that imports `@workspace/db`, so it is
 * deliberately excluded from `./temporary-access/index.ts`'s barrel (see
 * that file's header) — import it directly at the one real call site that
 * constructs it.
 *
 * Nothing in the app constructs `DrizzleTemporaryAccessGrantProvider` yet —
 * like every provider this roadmap has shipped so far, this is additive,
 * unwired surface area. It cannot be executed against a real database in
 * this sandbox either (no network to a real Postgres instance) — included,
 * reviewed, and typed now so a future pass only has to wire it up, not
 * design it.
 *
 * Deliberately does NOT filter by time window in the query — returns every
 * row for this (subject, resourceType, action) regardless of
 * startsAt/expiresAt. See ./types.ts's `TemporaryAccessGrantProvider`
 * header and ./temporary-access-rule.ts's header for why: the RULE compares
 * against `request.context.timestamp` (fixed at request-build time), not
 * whatever the database considers "now" at query time — keeping the
 * decision deterministic with respect to the request object, not the clock
 * at query execution.
 */

import { db, temporaryAccessGrantsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import type { TemporaryAccessGrant, TemporaryAccessGrantProvider } from "./types";

export class DrizzleTemporaryAccessGrantProvider implements TemporaryAccessGrantProvider {
  async getTemporaryAccessGrants(
    subjectUserId: number,
    resourceType: string,
    action: string,
  ): Promise<TemporaryAccessGrant[]> {
    const rows = await db
      .select()
      .from(temporaryAccessGrantsTable)
      .where(
        and(
          eq(temporaryAccessGrantsTable.subjectUserId, subjectUserId),
          eq(temporaryAccessGrantsTable.resourceType, resourceType),
          eq(temporaryAccessGrantsTable.action, action),
        ),
      );

    const grants: TemporaryAccessGrant[] = [];
    for (const row of rows) {
      // The DB columns are plain TEXT/INTEGER (see the schema file's own
      // note on why insert-time validation, not a DB enum type, is
      // authoritative) — narrow `scope` here rather than widen
      // `TemporaryAccessGrant`'s type, so a malformed row (neither
      // "resource" nor "resource_type", which the insert schema and the
      // migration's CHECK constraint should both have prevented) fails
      // closed by being skipped, instead of being trusted.
      if (row.scope !== "resource" && row.scope !== "resource_type") continue;

      grants.push({
        id: row.id,
        scope: row.scope,
        resourceId: row.resourceId,
        organizationId: row.organizationId,
        startsAt: row.startsAt,
        expiresAt: row.expiresAt,
        grantedBy: row.grantedBy,
        reason: row.reason,
      });
    }
    return grants;
  }
}
