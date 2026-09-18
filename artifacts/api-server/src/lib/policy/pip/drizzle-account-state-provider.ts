/**
 * lib/policy/pip/drizzle-account-state-provider.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 18 (PIP / Attribute
 * Providers).
 *
 * The real, `@workspace/db`-backed `AccountStateProvider` (see
 * account-state-adapter.ts for the interface this implements). Same split
 * `drizzle-verification-level-provider.ts` already established: the
 * interface file stays DB-free; this is the one file in the pair that
 * imports `@workspace/db` — deliberately excluded from `lib/policy/index.ts`'s
 * barrel (see that file's own Phase 02/03/04/07/09B precedent) — import it
 * directly where actually needed.
 *
 * Reads exactly the one column this module needs (`users.status`) — no
 * `SELECT *` — same restraint `drizzle-verification-level-provider.ts`
 * documents for its own three columns.
 */

import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import type { AccountStateProvider } from "./account-state-adapter";

/** Returned when no matching user row exists — should not happen for an
 *  already-authenticated `Subject` (policy-engine.ts only ever reaches a
 *  rule with a verified caller), but this provider fails closed to a value
 *  that is deliberately NOT `users.status`'s own `"active"` default, so a
 *  future condition written as `subject.accountState == "active"` never
 *  passes on missing/unknown data — same "unknown key contributes nothing,
 *  never guesses the permissive answer" posture every other *Provider in
 *  this engine documents (e.g. `RbacProvider.getRole()` returning `null`
 *  for an unknown role key). */
const UNKNOWN_ACCOUNT_STATE = "unknown";

export class DrizzleAccountStateProvider implements AccountStateProvider {
  async getAccountState(userId: number): Promise<string> {
    const [row] = await db
      .select({ status: usersTable.status })
      .from(usersTable)
      .where(eq(usersTable.id, userId))
      .limit(1);

    return row?.status ?? UNKNOWN_ACCOUNT_STATE;
  }
}
