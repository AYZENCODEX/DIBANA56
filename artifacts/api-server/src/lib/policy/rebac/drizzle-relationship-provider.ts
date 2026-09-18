/**
 * lib/policy/rebac/drizzle-relationship-provider.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 04 (ReBAC).
 *
 * The real, `@workspace/db`-backed `RelationshipProvider` (see ./types.ts
 * for the interface). Same posture as `rbac/drizzle-rbac-provider.ts` and
 * `resource/drizzle-resource-grant-provider.ts`: this is the only file in
 * `lib/policy/rebac/*` that imports `@workspace/db`, so it is deliberately
 * excluded from `./rebac/index.ts`'s barrel (see that file's header).
 * Import it directly at the one real call site that constructs it.
 *
 * Nothing in the app constructs `DrizzleRelationshipProvider` yet — like
 * every other Drizzle-backed provider this roadmap has shipped so far,
 * this is additive, unwired surface area (see the Phase 04 CHANGES doc's
 * "not done" section). It cannot be executed against a real database in
 * this sandbox either (no network to a real Postgres instance); it is
 * included, reviewed, and typed now so a future pass only has to wire it
 * up, not design it.
 */

import { db, relationshipsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import type { RelationshipProvider } from "./types";

export class DrizzleRelationshipProvider implements RelationshipProvider {
  async getRelations(subjectUserId: number, resourceType: string, resourceId: string): Promise<string[]> {
    const rows = await db
      .select({ relation: relationshipsTable.relation })
      .from(relationshipsTable)
      .where(
        and(
          eq(relationshipsTable.subjectUserId, subjectUserId),
          eq(relationshipsTable.resourceType, resourceType),
          eq(relationshipsTable.resourceId, resourceId),
        ),
      );
    return rows.map((r: { relation: string }) => r.relation);
  }
}
