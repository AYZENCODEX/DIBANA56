/**
 * lib/policy/pip/drizzle-session-context-provider.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 18 (PIP / Attribute
 * Providers).
 *
 * The real `SessionContextProvider` (see session-context-adapter.ts for the
 * interface this implements), backed by `user_sessions` — the same table
 * `lib/sessions.ts` writes to on every login and reads from for
 * `isSessionRevoked()`/`touchSession()`.
 *
 * ── Raw SQL against `pool`, not Drizzle, and why ──────────────────────────
 * `user_sessions` is a raw-SQL table (`lib/schema-migrations.ts`'s
 * `MIGRATIONS` array — see `lib/sessions.ts`'s own header) with no Drizzle
 * schema object — same situation `login-security-risk-provider.ts` (10B)
 * already documents for `login_history`. This provider reaches for the same
 * `pool` `lib/sessions.ts` itself uses, rather than inventing a parallel
 * Drizzle schema for a table that deliberately doesn't have one.
 * `idx_user_sessions_jti` (unique, `lib/schema-migrations.ts`) already
 * covers this exact query's `WHERE jti = $1` filter.
 *
 * ── Fails closed the same way `isSessionRevoked()` reads "not found" ─────
 * Only returns a record for a session that is BOTH un-revoked and
 * unexpired — a revoked/expired/unknown `jti` all return `null`
 * (`session-context-adapter.ts#withSessionAge()`'s no-op case), never a
 * stale age computed from a session that no longer counts as active. This
 * mirrors `isSessionRevoked()`'s own `revoked_at IS NOT NULL OR expires_at
 * < NOW()` check, just phrased as the positive ("still valid") condition a
 * `SELECT ... WHERE` needs.
 *
 * Nothing in the app constructs `DrizzleSessionContextProvider` yet — same
 * additive, unwired posture every other Drizzle/DB-backed provider in this
 * engine already has. Deliberately excluded from `lib/policy/index.ts`'s
 * barrel (same precedent every other DB-touching provider in this
 * directory establishes) — import it directly where actually needed.
 */

import { pool } from "@workspace/db";
import type { SessionContextProvider, SessionRecord } from "./session-context-adapter";

export class DrizzleSessionContextProvider implements SessionContextProvider {
  async getSessionRecord(jti: string): Promise<SessionRecord | null> {
    const r = await pool.query(
      `SELECT created_at FROM user_sessions
       WHERE jti = $1 AND revoked_at IS NULL AND expires_at > NOW()`,
      [jti],
    );
    if (r.rows.length === 0) return null;
    return { createdAt: new Date(r.rows[0].created_at) };
  }
}
