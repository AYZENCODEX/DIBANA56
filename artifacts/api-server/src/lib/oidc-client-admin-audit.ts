/**
 * lib/oidc-client-admin-audit.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 5, Phase 9e: Audit Log.
 *
 * Read/write layer over `oidc_client_admin_audit_log` (migration 093) — see
 * that migration's own header for the full "why this shape, why not a
 * Drizzle schema, why `client_id` isn't an FK" reasoning. This file is the
 * one and only writer/reader of that table.
 *
 * `logOidcClientAdminAudit()` is `routes/admin-oidc-clients.ts`'s own new
 * caller on EVERY 9b/9c/9d write (`PATCH .../:clientId`, `POST
 * /admin/oidc-clients`, `DELETE .../:clientId`, `PATCH .../:clientId/status`)
 * — exactly 9e's own roadmap text ("প্রতিটা 9b/9c/9d action-এ একটা রো"). It
 * is NOT called from `lib/oidc-client-admin.ts`'s own persistence
 * functions themselves — same "route composes several effects, lib
 * persists one thing" split this roadmap's every earlier OIDC route/lib
 * pair already uses (see `lib/oidc-user-consents.ts`'s own header for the
 * closest precedent: `revokeConsent()` doesn't dispatch backchannel logout
 * either, its caller route does). Composing "did the write succeed, THEN
 * also audit-log it" is the route's job, not this file's or
 * `lib/oidc-client-admin.ts`'s.
 *
 * BEST-EFFORT, NEVER THROWS — same discipline `lib/vault-backup-audit.ts`'s
 * `logBackupAudit()` already establishes for this codebase's other
 * dedicated audit trail: an audit-log write failing must never fail, delay,
 * or roll back the admin action that triggered it. A dropped audit row on a
 * transient DB hiccup is a (logged) gap in the trail, not an outage in the
 * admin UI.
 *
 * `before`/`after` snapshots passed in by the route are expected to already
 * be sanitized (i.e. `serializeOidcClientForAdmin()`'s own projection,
 * which already omits `clientSecretHash`/`registrationAccessTokenHash` —
 * see that function's own header) — this file does not itself strip
 * anything from what it's handed, the same "trusts its caller's already-
 * validated input" posture `grantConsent()` (`lib/oidc-user-consents.ts`)
 * takes for ITS caller's already-validated scopes. There is exactly one
 * caller of this function in this codebase (`routes/admin-oidc-clients.ts`)
 * and it is responsible for never handing this a raw, unsanitized
 * `OidcClient`.
 */
import { pool } from "@workspace/db";
import { logger } from "./logger";

/**
 * The complete, closed vocabulary of actions this table records — one
 * entry per 9b/9c/9d write path this Season's admin surface has. This
 * union, not a DB CHECK constraint (see migration 093's own header on this
 * exact choice), is authoritative: adding a new admin write path in a
 * future phase means adding a new member here, not a migration.
 */
export type OidcClientAdminAuditAction = "client_created" | "client_updated" | "client_deleted" | "client_status_changed";

export interface LogOidcClientAdminAuditInput {
  /** `req.user?.userId` at the call site — `null` only in the (should-never-happen on a `requireDev` route) case that's missing. */
  actorId: number | null;
  clientId: string;
  action: OidcClientAdminAuditAction;
  /** Sanitized snapshot before the action, or `null` for `client_created` (nothing existed yet). */
  before?: Record<string, unknown> | null;
  /** Sanitized snapshot after the action, or `null` for `client_deleted` (nothing exists anymore). */
  after?: Record<string, unknown> | null;
}

export async function logOidcClientAdminAudit(input: LogOidcClientAdminAuditInput): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO oidc_client_admin_audit_log (actor_id, client_id, action, before, after)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)`,
      [
        input.actorId,
        input.clientId,
        input.action,
        input.before === undefined || input.before === null ? null : JSON.stringify(input.before),
        input.after === undefined || input.after === null ? null : JSON.stringify(input.after),
      ],
    );
  } catch (err) {
    // Best-effort, same as lib/vault-backup-audit.ts's own logBackupAudit()
    // — an audit-log write failure must never fail the calling admin
    // request, which has already succeeded by the time this is called.
    logger.warn({ err, clientId: input.clientId, action: input.action }, "[oidc-client-admin-audit] failed to write audit log entry");
  }
}

/** One row of `oidc_client_admin_audit_log`, as read back for `GET /admin/oidc-clients/:clientId/audit-log`. */
export interface StoredOidcClientAdminAuditEntry {
  id: number;
  actorId: number | null;
  clientId: string;
  action: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  at: Date;
}

interface StoredOidcClientAdminAuditDbRow {
  id: number;
  actor_id: number | null;
  client_id: string;
  action: string;
  before: unknown;
  after: unknown;
  at: Date;
}

function mapAuditRow(row: StoredOidcClientAdminAuditDbRow): StoredOidcClientAdminAuditEntry {
  return {
    id: row.id,
    actorId: row.actor_id,
    clientId: row.client_id,
    action: row.action,
    before: (row.before ?? null) as Record<string, unknown> | null,
    after: (row.after ?? null) as Record<string, unknown> | null,
    at: row.at,
  };
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

/**
 * 9e read path: one client's admin-action history, newest first — the
 * `GET /admin/oidc-clients/:clientId/audit-log` handler's only data source.
 * Uses migration 093's own `oidc_client_admin_audit_log_client_id_at_idx`
 * (`client_id, at DESC`), the exact shape this query needs.
 *
 * Returns `[]` (never throws) on a DB read failure — same "a transient
 * failure must never look like a 500 thrown up through an admin route"
 * contract every other reader in this OIDC roadmap (`getOidcClientById()`,
 * `listActiveConsentsForUser()`) already uses.
 */
export async function listOidcClientAdminAuditLog(clientId: string, limit = DEFAULT_LIMIT): Promise<StoredOidcClientAdminAuditEntry[]> {
  const boundedLimit = Math.min(Math.max(limit, 1), MAX_LIMIT);
  try {
    const result = await pool.query(
      `SELECT id, actor_id, client_id, action, before, after, at
       FROM oidc_client_admin_audit_log
       WHERE client_id = $1
       ORDER BY at DESC
       LIMIT $2`,
      [clientId, boundedLimit],
    );
    return (result.rows as StoredOidcClientAdminAuditDbRow[]).map(mapAuditRow);
  } catch (err) {
    logger.warn({ err, clientId }, "[oidc-client-admin-audit] failed to list audit log for client");
    return [];
  }
}
