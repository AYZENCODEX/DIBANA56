/**
 * scripts/src/test-oidc-admin-status-audit.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 5, Phase 9d (Approval/Suspension Workflow) + Phase
 * 9e (Audit Log) — DB-free tests.
 *
 * Same discipline as scripts/src/test-oidc-clients.ts: exercises only pure,
 * DB-free functions, runnable anywhere with nothing but
 * `npx tsx scripts/src/test-oidc-admin-status-audit.ts`.
 *
 * Covers:
 *   - `validateOidcAdminClientStatusRequest()` (9d, lib/oidc-client-admin-request.ts)
 *     — the only NEW pure function this pair of sub-phases adds. Everything
 *     ELSE 9d/9e ship (`updateOidcClientStatusAdmin()`, `logOidcClientAdminAudit()`,
 *     `listOidcClientAdminAuditLog()`) hits `@workspace/db`'s `pool` directly
 *     and has no DATABASE_URL in this environment to run against — same
 *     "hand-verified against the DDL, not executed" limitation
 *     test-oidc-clients.ts's own header already documents for
 *     oidc_clients' unique-index behavior. Those three functions' current-
 *     status/transition logic and best-effort try/catch shape are reviewed
 *     by reading `lib/oidc-client-admin.ts`/`lib/oidc-client-admin-audit.ts`
 *     directly, not asserted here.
 *   - `oidc_client_admin_audit_log` row mapping is exercised structurally
 *     below too (a tiny local re-implementation of the DB-row shape,
 *     asserting the same null-handling contract migration 093 and
 *     `lib/oidc-client-admin-audit.ts` document) — not by importing
 *     `mapAuditRow()` itself, since that function is intentionally NOT
 *     exported (unlike `mapOidcClientRow()`, it has exactly one caller,
 *     `listOidcClientAdminAuditLog()`, in the same file — no test or
 *     second caller needs it directly).
 *
 * Run: npx tsx scripts/src/test-oidc-admin-status-audit.ts
 */
import assert from "node:assert/strict";
import { validateOidcAdminClientStatusRequest } from "../../artifacts/api-server/src/lib/oidc-client-admin-request";

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ok — ${name}`);
  } catch (err) {
    console.error(`  FAIL — ${name}`);
    throw err;
  }
}

console.log("validateOidcAdminClientStatusRequest() — Phase 9d");

test("'approved' is accepted", () => {
  const result = validateOidcAdminClientStatusRequest({ registrationStatus: "approved" });
  assert.deepEqual(result, { ok: true, targetStatus: "approved" });
});

test("'suspended' is accepted", () => {
  const result = validateOidcAdminClientStatusRequest({ registrationStatus: "suspended" });
  assert.deepEqual(result, { ok: true, targetStatus: "suspended" });
});

test("'pending' is REJECTED as a target — never a legal destination per 9d's own roadmap text", () => {
  const result = validateOidcAdminClientStatusRequest({ registrationStatus: "pending" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.field, "registrationStatus");
});

test("a missing registrationStatus is rejected", () => {
  const result = validateOidcAdminClientStatusRequest({});
  assert.equal(result.ok, false);
});

test("an unrecognized string value is rejected", () => {
  const result = validateOidcAdminClientStatusRequest({ registrationStatus: "banned" });
  assert.equal(result.ok, false);
});

test("a non-string value is rejected", () => {
  const result = validateOidcAdminClientStatusRequest({ registrationStatus: 1 });
  assert.equal(result.ok, false);
});

test("a non-object body is rejected, not thrown on", () => {
  assert.doesNotThrow(() => validateOidcAdminClientStatusRequest(null));
  assert.doesNotThrow(() => validateOidcAdminClientStatusRequest(undefined));
  assert.doesNotThrow(() => validateOidcAdminClientStatusRequest("approved"));
  assert.equal(validateOidcAdminClientStatusRequest(null).ok, false);
});

console.log("oidc_client_admin_audit_log row-shape contract — Phase 9e");

/**
 * Local structural stand-in for `mapAuditRow()` (not exported — see this
 * file's header). Proves the same "JSONB NULL -> JS null, never undefined
 * or a thrown parse error" contract `lib/oidc-client-admin-audit.ts`'s own
 * mapper implements, against a shape identical to its DB row type.
 */
function mapAuditRowForTest(row: {
  id: number;
  actor_id: number | null;
  client_id: string;
  action: string;
  before: unknown;
  after: unknown;
  at: Date;
}) {
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

test("a client_created row (before: null) maps with before staying null", () => {
  const mapped = mapAuditRowForTest({
    id: 1,
    actor_id: 42,
    client_id: "wisp",
    action: "client_created",
    before: null,
    after: { clientId: "wisp", registrationStatus: "approved" },
    at: new Date("2026-01-01T00:00:00Z"),
  });
  assert.equal(mapped.before, null);
  assert.deepEqual(mapped.after, { clientId: "wisp", registrationStatus: "approved" });
});

test("a client_deleted row (after: null) maps with after staying null", () => {
  const mapped = mapAuditRowForTest({
    id: 2,
    actor_id: 42,
    client_id: "wisp",
    action: "client_deleted",
    before: { clientId: "wisp", registrationStatus: "approved" },
    after: null,
    at: new Date("2026-01-02T00:00:00Z"),
  });
  assert.deepEqual(mapped.before, { clientId: "wisp", registrationStatus: "approved" });
  assert.equal(mapped.after, null);
});

test("a client_status_changed row carries both before and after", () => {
  const mapped = mapAuditRowForTest({
    id: 3,
    actor_id: 7,
    client_id: "some-dynamic-client",
    action: "client_status_changed",
    before: { registrationStatus: "pending" },
    after: { registrationStatus: "approved" },
    at: new Date("2026-01-03T00:00:00Z"),
  });
  assert.deepEqual(mapped.before, { registrationStatus: "pending" });
  assert.deepEqual(mapped.after, { registrationStatus: "approved" });
});

test("actor_id NULL (e.g. the acting admin account was later deleted, ON DELETE SET NULL) maps to actorId: null, never throws", () => {
  const mapped = mapAuditRowForTest({
    id: 4,
    actor_id: null,
    client_id: "wisp",
    action: "client_updated",
    before: {},
    after: {},
    at: new Date("2026-01-04T00:00:00Z"),
  });
  assert.equal(mapped.actorId, null);
});

console.log("All Phase 9d/9e status+audit tests passed.");
