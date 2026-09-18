/**
 * lib/policy/resource/drizzle-resource-grant-provider.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 03 (Resource / Ownership
 * Authorization), sub-phase 3B.
 *
 * The real, `@workspace/db`-backed `ResourceGrantProvider` (see ./types.ts
 * for the interface). Same posture as `rbac/drizzle-rbac-provider.ts`: this
 * is the one file in `lib/policy/resource/*` that imports `@workspace/db`,
 * so it is deliberately excluded from `./resource/index.ts`'s barrel (see
 * that file's header) — import it directly at the one real call site that
 * constructs it.
 *
 * Nothing in the app constructs `DrizzleResourceGrantProvider` yet — like
 * every file this roadmap has shipped so far, this is additive, unwired
 * surface area (see the Phase 3B CHANGES doc's "not done" section). It
 * cannot be executed against a real database in this sandbox either (no
 * network to a real Postgres instance — only to package registries); it is
 * included, reviewed, and typed now so a future pass only has to wire it
 * up, not design it.
 */

import { db, resourceGrantsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import type { ResourceGrantEntry, ResourceGrantProvider } from "./types";

export class DrizzleResourceGrantProvider implements ResourceGrantProvider {
  async getResourceGrant(
    subjectUserId: number,
    resourceType: string,
    resourceId: string,
    action: string,
  ): Promise<ResourceGrantEntry | null> {
    const [row] = await db
      .select({ effect: resourceGrantsTable.effect, reason: resourceGrantsTable.reason })
      .from(resourceGrantsTable)
      .where(
        and(
          eq(resourceGrantsTable.subjectUserId, subjectUserId),
          eq(resourceGrantsTable.resourceType, resourceType),
          eq(resourceGrantsTable.resourceId, resourceId),
          eq(resourceGrantsTable.action, action),
        ),
      );
    if (!row) return null;
    // The DB column is a plain TEXT (see resource-grants.ts's insert-schema
    // note) — narrow it here rather than widen ResourceGrantEntry's type,
    // so a malformed row (neither "allow" nor "deny", which the insert
    // schema should have prevented) fails closed instead of being trusted.
    if (row.effect !== "allow" && row.effect !== "deny") return null;
    return { effect: row.effect, reason: row.reason ?? undefined };
  }
}
