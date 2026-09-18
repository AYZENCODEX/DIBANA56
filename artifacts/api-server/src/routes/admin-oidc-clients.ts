/**
 * routes/admin-oidc-clients.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 5, Phase 9a (admin client list view) + Phase 9b
 * (admin client detail/edit) + Phase 9c (admin client create/delete,
 * first-party path).
 *
 * `GET /admin/oidc-clients` (9a) — every `oidc_clients` row, for an
 * operator to see the whole registry at a glance: `client_id`,
 * `client_name`, `is_first_party`, `registration_status`, and
 * (best-effort — see below) when a token was last issued for it. This
 * was Phase 9's own first sub-phase, deliberately READ-ONLY — see the
 * roadmap's own "কেন এই order" note: "Read (9a) সবার আগে — কিছু এডিট
 * করার আগে দেখা দরকার কী আছে" (read first — you need to see what exists
 * before editing anything).
 *
 * `PATCH /admin/oidc-clients/:clientId` (9b) — edits `redirectUris`,
 * `allowedScopes`, `backchannelLogoutUri` on an EXISTING row (any row,
 * first-party or not — 9b's own roadmap text draws no first-party-only
 * line the way 9c's create/delete does: "migration/seed script ছাড়াই...
 * এই gap বন্ধ করে প্রথম-পার্টি client-এর জন্যও," closing a gap that
 * previously affected first-party clients specifically, not narrowing
 * WHO can be edited). Composed from
 * `validateOidcAdminClientUpdateRequest()` (`lib/oidc-client-admin-request.ts`)
 * + `updateOidcClientAdmin()` (`lib/oidc-client-admin.ts`), same
 * "route composes, one lib validates, one lib persists" split 9a's own
 * composition (below) and every other OIDC route in this roadmap use.
 *
 * `POST /admin/oidc-clients` (9c) — the ONLY code path in this codebase
 * whose INSERT sets `is_first_party = TRUE` (see
 * `lib/oidc-client-admin.ts`'s own header for why that is a structural
 * guarantee, not a runtime check) — and
 * `DELETE /admin/oidc-clients/:clientId` (9c) — scoped to
 * `is_first_party = TRUE` rows only (see `deleteOidcClientAdmin()`'s own
 * doc comment for the full reasoning on why delete is narrower than
 * create's "first-party path" subtitle might suggest at a glance).
 *
 * UPDATE — Season 5, Phase 9d (Approval/Suspension Workflow) + Phase 9e
 * (Audit Log). Both added below, after 9a/9b/9c's original content (left
 * otherwise unchanged):
 *
 * `PATCH /admin/oidc-clients/:clientId/status` (9d) — the ONLY route in
 * this file that ever writes `registration_status`. Composed the same
 * "route composes, one lib validates, one lib persists" way as 9b/9c:
 * `validateOidcAdminClientStatusRequest()` (`lib/oidc-client-admin-request.ts`)
 * proves the request named a legal DESTINATION (`'approved'` or
 * `'suspended'`), `updateOidcClientStatusAdmin()` (`lib/oidc-client-admin.ts`)
 * checks whether the client's CURRENT status may legally move there and
 * persists the change if so. See that lib function's own header for why it
 * does NOT call any token-revocation function on suspend — a documented
 * Phase 10 dependency, not an oversight.
 *
 * `GET /admin/oidc-clients/:clientId/audit-log` (9e) — read-only, backed
 * entirely by `listOidcClientAdminAuditLog()` (`lib/oidc-client-admin-audit.ts`).
 *
 * 9e's OWN AUDIT WRITE IS NOW WIRED INTO ALL FOUR WRITE ROUTES IN THIS
 * FILE (9b's PATCH, 9c's POST and DELETE, and 9d's new status PATCH) — one
 * `logOidcClientAdminAudit()` call per handler, right after that handler's
 * own persistence call already returned `ok: true`, exactly 9e's own
 * roadmap text ("প্রতিটা 9b/9c/9d action-এ একটা রো"). Every one of those
 * calls happens here, in the route — never inside `lib/oidc-client-admin.ts`'s
 * own persistence functions — same "route composes several effects, lib
 * persists one thing" split `lib/oidc-client-admin-audit.ts`'s own header
 * documents for this exact choice. `before`/`after` snapshots passed to it
 * are always `serializeOidcClientForAdmin()`'s output (or `null`), never a
 * raw `OidcClient` — that projection already omits `clientSecretHash`/
 * `registrationAccessTokenHash`, so the audit table can never leak either
 * hash even if a future reader queries it directly.
 *
 * Composition, same "route composes, libs do one thing each" split every
 * other OIDC route in this roadmap uses:
 *   1. `listAllOidcClients()` / `getOidcClientById()` (`lib/oidc-clients.ts`)
 *      — read paths, all three handlers below use one or the other.
 *   2. `getOidcLastTokenIssuedAt()` (`lib/oidc-login-attempts.ts`) — 9a's
 *      own reuse of that file's EXISTING per-app-id in-memory stats,
 *      exactly as the roadmap's own text asks ("oidc-login-attempts.ts-এর
 *      existing per-app stats পুনর্ব্যবহার করে") — unchanged by this pass,
 *      9b/9c's own responses do not include this field (see
 *      `serializeOidcClientForAdmin()`'s own doc comment for why the
 *      detail/edit shape and the list-row shape are deliberately
 *      different projections).
 *   3. `validateOidcAdminClientUpdateRequest()` / `validateOidcAdminClientCreateRequest()`
 *      (`lib/oidc-client-admin-request.ts`, this pass's own addition) —
 *      pure request validation for 9b/9c respectively.
 *   4. `updateOidcClientAdmin()` / `createOidcClientAdmin()` /
 *      `deleteOidcClientAdmin()` (`lib/oidc-client-admin.ts`, this pass's
 *      own addition) — the corresponding persistence for 9b/9c.
 *
 * WHY `lastTokenIssuedAt` MAY BE `null` FOR A CLIENT THAT HAS ACTUALLY
 * ISSUED TOKENS: `getOidcLastTokenIssuedAt()`'s own doc comment is
 * explicit about this, worth repeating here since it's 9a's own response
 * field an operator will be looking at directly —
 * `lib/oidc-login-attempts.ts`'s tracking is in-memory, per-process. A
 * server restart resets it to empty. `null` in that response therefore
 * means "no token issuance recorded since this process last started,"
 * not a durable "this client has never issued a token" guarantee. A
 * REAL persisted history (surviving restarts, queryable historically) is
 * Phase 9e's audit-log job — a genuinely different, DB-backed mechanism —
 * not something this phase's read reuses or approximates further.
 *
 * `client_secret_hash` and `registration_access_token_hash` are NEVER
 * included in ANY response below (9a, 9b, or 9c) — same "never expose a
 * hash, only the plaintext-once-and-only-once secret at issuance"
 * discipline every OIDC secret-issuing code path in this codebase
 * already follows (see `lib/oidc-client-registration.ts`'s own
 * file-header note on this). An admin surface has no legitimate need to
 * see either hash; showing them would only widen the blast radius of a
 * compromised admin session for zero operational benefit. 9c's own
 * create path issues no secret at all in the first place — see
 * `lib/oidc-client-admin.ts`'s header for why.
 *
 * AUTH: `requireDev` on every route below (GET, PATCH, POST, DELETE alike)
 * — same tier as `admin-oidc-rollout.ts` and
 * `admin-oidc-backchannel-logout.ts`, both cited directly by 9a's own
 * roadmap text as the precedent to match ("existing
 * admin-oidc-rollout.ts/admin-oidc-backchannel-logout.ts-এর ঠিক একই
 * tier"). An internal operator surface, never called by an OIDC client
 * or a logged-out visitor.
 *
 * MOUNTING: through `routes/index.ts`, same tier/aggregator as those two
 * files — NOT bare-origin like `routes/oidc-register.ts`. See 9a's own
 * note in `routes/index.ts` for the exact mount point; 9b/9c add no new
 * mount, since they're new methods on this SAME router/path family
 * (`/admin/oidc-clients[/:clientId]`), not a new file to import.
 */
import { Router, type IRouter } from "express";
import { requireDev } from "../middlewares/auth";
import { listAllOidcClients, getOidcClientById, serializeOidcClientForAdmin } from "../lib/oidc-clients";
import { getOidcLastTokenIssuedAt } from "../lib/oidc-login-attempts";
import {
  validateOidcAdminClientUpdateRequest,
  validateOidcAdminClientCreateRequest,
  validateOidcAdminClientStatusRequest,
} from "../lib/oidc-client-admin-request";
import {
  updateOidcClientAdmin,
  createOidcClientAdmin,
  deleteOidcClientAdmin,
  updateOidcClientStatusAdmin,
} from "../lib/oidc-client-admin";
import { logOidcClientAdminAudit, listOidcClientAdminAuditLog } from "../lib/oidc-client-admin-audit";
// Season 5, Phase 10d: the two client-wide cascade call sites this file's
// own suspend (9d) and delete (9c) handlers document, by name, as a
// dependency on Phase 10 — see lib/oidc-client-admin.ts's own "THE Phase
// 10 GAP" note for the full history of why neither handler called either
// of these before this pass.
import { revokeAllTokensForClient } from "../lib/oidc-token-revocation";
import { listActiveUserIdsForClient } from "../lib/oidc-refresh-tokens";
import { dispatchBackchannelLogoutForUserAndClient } from "../lib/oidc-logout-propagation";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// ── GET /admin/oidc-clients — 9a: list every client, registry-wide ─────────
router.get("/admin/oidc-clients", requireDev, async (_req, res): Promise<void> => {
  const clients = await listAllOidcClients();

  const rows = clients.map((client) => ({
    clientId: client.clientId,
    clientName: client.clientName,
    isFirstParty: client.isFirstParty,
    registrationStatus: client.registrationStatus,
    // Best-effort, in-memory, resets on restart — see this file's own
    // header for the exact caveat an operator reading this field should
    // keep in mind.
    lastTokenIssuedAt: getOidcLastTokenIssuedAt(client.clientId),
    createdAt: client.createdAt.toISOString(),
  }));

  res.json({ clients: rows });
});

// ── GET /admin/oidc-clients/:clientId — 9b: single-client detail read ──────
// Not itself named as a separate sub-phase in the roadmap's 9b task list
// (which only names the PATCH), but a detail/edit UI needs a way to fetch
// the current full row BEFORE editing it — the same "you need to see
// what exists before editing anything" reasoning 9a's own header already
// gives for why 9a came before 9b at the list level applies here too, one
// level down, at the single-client level. Reuses `getOidcClientById()`
// (`lib/oidc-clients.ts`, Phase 2A-c) — no new read helper needed.
router.get("/admin/oidc-clients/:clientId", requireDev, async (req, res): Promise<void> => {
  const clientId = String(req.params.clientId ?? "").trim();
  if (!clientId) {
    res.status(400).json({ error: "clientId is required" });
    return;
  }

  const client = await getOidcClientById(clientId);
  if (!client) {
    res.status(404).json({ error: "client not found" });
    return;
  }

  res.json({ client: serializeOidcClientForAdmin(client) });
});

// ── PATCH /admin/oidc-clients/:clientId — 9b: edit an existing client ──────
router.patch("/admin/oidc-clients/:clientId", requireDev, async (req, res): Promise<void> => {
  const clientId = String(req.params.clientId ?? "").trim();
  if (!clientId) {
    res.status(400).json({ error: "clientId is required" });
    return;
  }

  const validation = validateOidcAdminClientUpdateRequest(req.body);
  if (!validation.ok) {
    res.status(400).json({ error: validation.error, field: validation.field });
    return;
  }

  // 9e: snapshot BEFORE the write — see this file's header for why this is
  // fetched at the route level (an extra read) rather than having
  // updateOidcClientAdmin() itself return it.
  const before = await getOidcClientById(clientId);

  const result = await updateOidcClientAdmin(clientId, validation.updates);
  if (!result.ok) {
    res.status(result.error === "not_found" ? 404 : 500).json({ error: result.error });
    return;
  }

  logger.info(
    { clientId, actorId: req.user?.userId, fields: Object.keys(validation.updates) },
    "oidc.client.admin_updated",
  );

  await logOidcClientAdminAudit({
    actorId: req.user?.userId ?? null,
    clientId,
    action: "client_updated",
    before: before ? serializeOidcClientForAdmin(before) : null,
    after: serializeOidcClientForAdmin(result.client),
  });

  res.json({ client: serializeOidcClientForAdmin(result.client) });
});

// ── POST /admin/oidc-clients — 9c: create a new first-party client ────────
router.post("/admin/oidc-clients", requireDev, async (req, res): Promise<void> => {
  const validation = validateOidcAdminClientCreateRequest(req.body);
  if (!validation.ok) {
    res.status(400).json({ error: validation.error, field: validation.field });
    return;
  }

  const result = await createOidcClientAdmin(validation);
  if (!result.ok) {
    res.status(result.error === "conflict" ? 409 : 500).json({ error: result.error });
    return;
  }

  logger.info({ clientId: result.client.clientId, actorId: req.user?.userId }, "oidc.client.admin_created");

  await logOidcClientAdminAudit({
    actorId: req.user?.userId ?? null,
    clientId: result.client.clientId,
    action: "client_created",
    before: null, // nothing existed yet
    after: serializeOidcClientForAdmin(result.client),
  });

  res.status(201).json({ client: serializeOidcClientForAdmin(result.client) });
});

// ── DELETE /admin/oidc-clients/:clientId — 9c: delete a first-party client ─
router.delete("/admin/oidc-clients/:clientId", requireDev, async (req, res): Promise<void> => {
  const clientId = String(req.params.clientId ?? "").trim();
  if (!clientId) {
    res.status(400).json({ error: "clientId is required" });
    return;
  }

  // 9e: snapshot BEFORE the delete — the only chance to ever capture what
  // this row looked like, since deleteOidcClientAdmin() itself returns
  // nothing but ok:true on success.
  const before = await getOidcClientById(clientId);

  // 10d: capture WHO holds a live token for this client before it's gone
  // — see lib/oidc-refresh-tokens.ts's own `listActiveUserIdsForClient()`
  // header for why this has to be read before the cascade revoke below,
  // not derived from it.
  const affectedUserIds = await listActiveUserIdsForClient(clientId);

  const result = await deleteOidcClientAdmin(clientId);
  if (!result.ok) {
    const status = result.error === "not_found" ? 404 : result.error === "not_first_party" ? 409 : 500;
    res.status(status).json({ error: result.error });
    return;
  }

  // 10d: close the Phase 10 gap this handler's own persistence layer
  // (lib/oidc-client-admin.ts's deleteOidcClientAdmin()) already documents
  // by name — a deleted client's previously-issued tokens must not keep
  // verifying. See lib/oidc-token-revocation.ts's own header for why this
  // is, in practice, refresh-token-only.
  const revokedTokenCount = await revokeAllTokensForClient(clientId);
  for (const affectedUserId of affectedUserIds) {
    void dispatchBackchannelLogoutForUserAndClient(affectedUserId, clientId);
  }

  logger.info(
    { clientId, actorId: req.user?.userId, revokedTokenCount, affectedUserCount: affectedUserIds.length },
    "oidc.client.admin_deleted",
  );

  await logOidcClientAdminAudit({
    actorId: req.user?.userId ?? null,
    clientId,
    action: "client_deleted",
    before: before ? serializeOidcClientForAdmin(before) : null,
    after: null, // nothing exists anymore
  });

  res.status(204).end();
});

// ── PATCH /admin/oidc-clients/:clientId/status — 9d: approve/suspend ──────
router.patch("/admin/oidc-clients/:clientId/status", requireDev, async (req, res): Promise<void> => {
  const clientId = String(req.params.clientId ?? "").trim();
  if (!clientId) {
    res.status(400).json({ error: "clientId is required" });
    return;
  }

  const validation = validateOidcAdminClientStatusRequest(req.body);
  if (!validation.ok) {
    res.status(400).json({ error: validation.error, field: validation.field });
    return;
  }

  // 9e: snapshot BEFORE the status change.
  const before = await getOidcClientById(clientId);

  // 10d: capture WHO holds a live token for this client before a
  // suspend-triggered cascade revokes them — see
  // lib/oidc-refresh-tokens.ts's own `listActiveUserIdsForClient()` header.
  // Only meaningful for a transition TO 'suspended' (below); read
  // unconditionally here anyway since it's a cheap, harmless no-op for
  // an 'approved' transition that never uses this value.
  const affectedUserIds =
    validation.targetStatus === "suspended" ? await listActiveUserIdsForClient(clientId) : [];

  const result = await updateOidcClientStatusAdmin(clientId, validation.targetStatus);
  if (!result.ok) {
    const status = result.error === "not_found" ? 404 : result.error === "invalid_transition" ? 409 : 500;
    res.status(status).json({ error: result.error });
    return;
  }

  // 10d: close the Phase 10 gap `updateOidcClientStatusAdmin()`'s own
  // header already names — "suspending a client... does NOT invalidate
  // any access/refresh token that client already holds," making the
  // suspension cosmetic without this. Only on a transition TO
  // 'suspended' — approving a pending client has no tokens to revoke.
  let revokedTokenCount = 0;
  if (validation.targetStatus === "suspended") {
    revokedTokenCount = await revokeAllTokensForClient(clientId);
    for (const affectedUserId of affectedUserIds) {
      void dispatchBackchannelLogoutForUserAndClient(affectedUserId, clientId);
    }
  }

  logger.info(
    {
      clientId,
      actorId: req.user?.userId,
      targetStatus: validation.targetStatus,
      revokedTokenCount,
      affectedUserCount: affectedUserIds.length,
    },
    "oidc.client.admin_status_changed",
  );

  await logOidcClientAdminAudit({
    actorId: req.user?.userId ?? null,
    clientId,
    action: "client_status_changed",
    before: before ? serializeOidcClientForAdmin(before) : null,
    after: serializeOidcClientForAdmin(result.client),
  });

  res.json({ client: serializeOidcClientForAdmin(result.client) });
});

// ── GET /admin/oidc-clients/:clientId/audit-log — 9e: this client's history ─
router.get("/admin/oidc-clients/:clientId/audit-log", requireDev, async (req, res): Promise<void> => {
  const clientId = String(req.params.clientId ?? "").trim();
  if (!clientId) {
    res.status(400).json({ error: "clientId is required" });
    return;
  }

  const entries = await listOidcClientAdminAuditLog(clientId);
  res.json({
    entries: entries.map((entry) => ({
      id: entry.id,
      actorId: entry.actorId,
      clientId: entry.clientId,
      action: entry.action,
      before: entry.before,
      after: entry.after,
      at: entry.at.toISOString(),
    })),
  });
});

export default router;
