/**
 * lib/policy/pip/login-security-risk-provider.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 10 (Risk-Aware
 * Authorization), sub-phase 10B.
 *
 * The real, `lib/login-security.ts` + `@workspace/db`-backed
 * `RiskLevelProvider` (see risk-level-adapter.ts for the interface this
 * implements). This is the only file in this pair that imports either —
 * same split `pip/drizzle-verification-level-provider.ts` (9B) already
 * established for its own provider: `risk-level-adapter.ts` stays DB-free
 * and unit-testable, this file is excluded from `lib/policy/index.ts`'s
 * barrel (same RBAC/Resource/ReBAC/Registry/9B precedent) — import it
 * directly where actually needed.
 *
 * ── The failed-login-burst query, and why raw SQL against `pool` ─────────
 * `login_history` is a raw-SQL table (see `lib/login-security.ts`'s own
 * header: "Storage follows the same 'raw SQL, migrated via the
 * MIGRATIONS array in index.ts' convention as vault_shares /
 * user_backup_codes elsewhere in this codebase, rather than a Drizzle
 * schema file") — there is no Drizzle table object for it to query
 * through `db.select()`, so this provider reaches for the same `pool`
 * `lib/login-security.ts` itself already uses, rather than inventing a
 * parallel Drizzle schema for a table that deliberately doesn't have one.
 * `idx_login_history_user_status` (`login_history(user_id, status)`,
 * `lib/schema-migrations.ts`) already covers this exact query's
 * `WHERE user_id = $1 AND status = 'failed'` filter.
 */

import { pool } from "@workspace/db";
import { isAnomalousIp } from "../../login-security";
import type { RiskLevelProvider, RiskSignal } from "./risk-level-adapter";

/** How far back to look for a failed-login burst — long enough to catch a
 *  sustained guessing attempt spread over several minutes, short enough
 *  that a genuine mistyped-password moment from days ago never
 *  contributes to today's risk assessment. */
const FAILED_LOGIN_LOOKBACK_MINUTES = 30;

export class LoginSecurityRiskProvider implements RiskLevelProvider {
  async getRiskSignal(userId: number, ip: string | undefined): Promise<RiskSignal> {
    // No IP on this request's context (see risk-level-adapter.ts's own
    // header for why context.ip, not login-time IP) — nothing to check
    // against login history's IP column, so this half of the signal
    // fails closed to "not anomalous" (the WEAKER reading) rather than
    // throwing or guessing. The failed-login-burst half below still runs
    // regardless — it doesn't depend on `ip` at all.
    const anomalousIp = ip ? await isAnomalousIp(userId, ip) : false;

    const r = await pool.query(
      `SELECT COUNT(*)::int AS count FROM login_history
       WHERE user_id = $1 AND status = 'failed' AND created_at > NOW() - ($2 * INTERVAL '1 minute')`,
      [userId, FAILED_LOGIN_LOOKBACK_MINUTES],
    );
    const recentFailedLogins = r.rows[0]?.count ?? 0;

    return { anomalousIp, recentFailedLogins };
  }
}
