/**
 * lib/policy/pip/drizzle-verification-level-provider.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 09 (Authentication
 * Assurance), sub-phase 9B.
 *
 * The real, `@workspace/db`-backed `VerificationLevelProvider` (see
 * verification-level-adapter.ts for the interface this implements). This
 * is the only file in this pair that imports `@workspace/db` — same split
 * `rbac/drizzle-rbac-provider.ts` already established for Phase 02:
 * `verification-level-adapter.ts` stays DB-free (unit-testable without a
 * database — see scripts/src/test-policy-verification-level.ts), and this
 * file is excluded from `lib/policy/index.ts`'s barrel (see that file's
 * own Phase 02/03/04/07 precedent for why) — import it directly where
 * actually needed.
 *
 * Reads exactly the three columns `mapAccountStandingToVerificationLevel()`
 * needs, nothing else — no `SELECT *`, so this stays correct even if
 * `usersTable` grows new columns later (see `lib/db/src/schema/users.ts`
 * for the full row shape this deliberately does not read all of).
 *
 * Nothing in the app constructs `DrizzleVerificationLevelProvider` yet —
 * same additive, unwired posture every other Drizzle provider in this
 * engine already has (see `drizzle-rbac-provider.ts`'s own header). It
 * cannot be executed against a real database in this sandbox either (no
 * network) — included, reviewed, and typed now so a future PEP-wiring
 * pass only has to call it, not design it.
 */

import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import type { AccountVerificationStanding, VerificationLevelProvider } from "./verification-level-adapter";

export class DrizzleVerificationLevelProvider implements VerificationLevelProvider {
  async getAccountVerificationStanding(userId: number): Promise<AccountVerificationStanding> {
    const [row] = await db
      .select({
        emailVerified: usersTable.emailVerified,
        kycVerified: usersTable.kycVerified,
        kycLevel: usersTable.kycLevel,
      })
      .from(usersTable)
      .where(eq(usersTable.id, userId))
      .limit(1);

    // No such user row (shouldn't happen for an already-authenticated
    // Subject — policy-engine.ts only ever reaches a rule with a verified
    // caller — but this provider fails closed to the weakest standing
    // rather than throwing, same "unknown key contributes nothing" posture
    // every other *Provider in this engine documents, e.g.
    // RbacProvider.getRole() returning null for an unknown role key).
    if (!row) return { emailVerified: false, kycVerified: false, kycLevel: 0 };

    return {
      emailVerified: row.emailVerified,
      kycVerified: row.kycVerified,
      kycLevel: row.kycLevel,
    };
  }
}
