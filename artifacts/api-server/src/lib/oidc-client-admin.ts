/**
 * lib/oidc-client-admin.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 5, Phase 9b (admin client detail/edit) + Phase 9c
 * (admin client create/delete, first-party path) — persistence half.
 *
 * Takes already-validated `lib/oidc-client-admin-request.ts` output and
 * turns it into real `oidc_clients` writes. `routes/admin-oidc-clients.ts`
 * is the one caller; this file does no request parsing of its own — same
 * "lib persists, sibling lib validates" split `lib/oidc-client-registration.ts`
 * uses for Phase 8a/8e's self-service registration path. This is that
 * pair's admin-side twin: same shape, deliberately its own file (see
 * `lib/oidc-client-admin-request.ts`'s own header for why the two paths
 * are not folded together).
 *
 * Scope discipline (this is 9b/9c, not 9d/9e):
 *   - `updateOidcClientAdmin()` (9b) only ever writes the three columns
 *     9b's own roadmap text names — `redirect_uris`, `allowed_scopes`,
 *     `backchannel_logout_uri` — because that is the only shape
 *     `lib/oidc-client-admin-request.ts`'s `OidcAdminClientUpdateValidationResult`
 *     can produce; there is no `registration_status` or `is_first_party`
 *     key this function could even receive. Approval/suspension writes to
 *     `registration_status` are Phase 9d's own, separate function
 *     (`PATCH /admin/oidc-clients/:clientId/status`, not yet built) — NOT
 *     a code path added here, even though both would technically be
 *     `UPDATE oidc_clients ... WHERE client_id = $n`. Keeping them as two
 *     separate functions (rather than one generic "patch any column"
 *     helper) means a future audit-log hook (9e) can wrap 9b's function
 *     and 9d's function with two different action labels
 *     (`"client_updated"` vs `"client_status_changed"`) without either
 *     one having to first figure out which columns the caller actually
 *     touched.
 *   - `createOidcClientAdmin()` (9c) HARDCODES `is_first_party = TRUE` and
 *     `registration_status = 'approved'` in the INSERT — never parameters,
 *     never read from a caller-supplied object — the exact same
 *     "a security-relevant column's value should be visible in the INSERT
 *     statement itself" discipline `lib/oidc-client-registration.ts`'s own
 *     header states for ITS hardcoded `is_first_party = FALSE`. This is
 *     the roadmap's own named guarantee for 9c ("is_first_party = true
 *     সেট করার একমাত্র উপায়") made structurally true: there is no other
 *     function in this codebase whose INSERT sets `is_first_party = TRUE`.
 *   - `client_secret_hash` and `registration_access_token_hash` are both
 *     left `NULL` on create — an admin-created first-party client is
 *     public/PKCE-only, the same posture `scripts/src/seed-oidc-clients.ts`
 *     already documents for every first-party client ("PKCE — mandatory
 *     for first-party clients per the roadmap's global security section
 *     3.2 — is the proof of possession instead"), and has no
 *     self-management bearer token (that mechanism, migration 092's own
 *     header says, is for dynamically-registered clients managing
 *     themselves — "first-party clients are managed by Phase 9's ...
 *     admin UI, not by this bearer-token path"). 9c's own roadmap text
 *     names no secret-issuance step, so none is added here.
 *   - `deleteOidcClientAdmin()` is scoped to `is_first_party = TRUE` rows
 *     ONLY (see its own doc comment below for the full reasoning) — this
 *     is a deliberate, documented narrowing of 9c's own roadmap text
 *     ("Admin client create/delete (first-party path)"), not an
 *     accidental omission of a "delete any client" capability.
 *   - No audit-log write here — that is Phase 9e's own, separate table
 *     (`oidc_client_admin_audit_log`) and its own wrapping layer, not
 *     something this file's writes call directly.
 *
 * UPDATE — Season 5, Phase 9d: Approval/Suspension Workflow.
 *
 * `updateOidcClientStatusAdmin()` below is 9d's own persistence function,
 * added after 9b/9c's original content (left otherwise unchanged — every
 * function above this note is exactly what 9b/9c shipped). Deliberately
 * its OWN function, not a third caller of 9b's generic-looking `UPDATE
 * oidc_clients SET ... WHERE client_id = $n` shape, for the exact reason
 * this file's own original header already gave for keeping them apart:
 * "a future audit-log hook (9e) can wrap 9b's function and 9d's function
 * with two different action labels... without either one having to first
 * figure out which columns the caller actually touched." That future is
 * now — `routes/admin-oidc-clients.ts`'s status handler calls THIS
 * function and logs `"client_status_changed"`; its PATCH handler calls
 * `updateOidcClientAdmin()` above and logs `"client_updated"`.
 *
 * TRANSITION ENFORCEMENT LIVES HERE, NOT IN THE VALIDATOR — see
 * `lib/oidc-client-admin-request.ts`'s own UPDATE note for why
 * `validateOidcAdminClientStatusRequest()` only proves the request named
 * `'approved'` or `'suspended'` as a destination, never whether THIS
 * client's CURRENT state may legally move there. This function is what
 * actually enforces 9d's own roadmap text ("`'pending' -> 'approved'` বা
 * যেকোনো অবস্থা থেকে `'suspended়ে`"): reads the current row first,
 * refuses `'approved'` unless the current status is exactly `'pending'`,
 * and allows `'suspended'` unconditionally from any current status
 * (including an already-`'suspended'` client — idempotent, not an error).
 *
 * THE Phase 10 GAP, NAMED AGAIN HERE FOR THE SAME REASON
 * `deleteOidcClientAdmin()`'s OWN COMMENT ALREADY NAMES IT: suspending a
 * client here flips `registration_status` to `'suspended'` — which
 * `lib/oidc-client-validation.ts`'s existing `validateOidcClientId()`
 * choke point already causes to reject any FUTURE `/oidc/authorize` or
 * `/oidc/token` call for this client — but it does NOT invalidate any
 * access/refresh token that client already holds. 9d's own roadmap text is
 * explicit that this matters ("suspend করার সময় তার হাতে থাকা টোকেনও অবশ্যই
 * মরে যেতে হবে, নাহলে suspend-টা কসমেটিক" — a suspended client's
 * already-issued tokens must also die, or the suspension is cosmetic) and
 * names the fix by name: Phase 10's `revokeAllTokensForClient()}`, "not yet
 * built" — the identical phrase this file's own `deleteOidcClientAdmin()`
 * already uses for the identical gap on the delete path, and the identical
 * gap `lib/oidc-user-consents.ts`'s own header names for Phase 7d's
 * consent-revoke. This function does not fake, stub, or partially
 * implement that call.
 *
 * UPDATE — Season 5, Phase 10d: the gap named above is now closed, but
 * NOT inside this function. `revokeAllTokensForClient()`
 * (`lib/oidc-token-revocation.ts`, Phase 10c) is real now, and
 * `routes/admin-oidc-clients.ts`'s status handler DOES compose it — right
 * after this function returns `ok: true` for a `'suspended'` transition,
 * alongside a per-affected-user `dispatchBackchannelLogoutForUserAndClient()`
 * dispatch (`lib/oidc-logout-propagation.ts`). This function itself is
 * deliberately left untouched: it still only checks/persists the status
 * transition, same "lib persists one thing, route composes several
 * effects" split this file's own original header already established for
 * `updateOidcClientAdmin()` vs. 9e's audit-log call — the cascade and the
 * status write are two different effects with two different failure
 * modes, composed at the route layer, not merged into one function here.
 */

import { pool } from "@workspace/db";
import { logger } from "./logger";
import { getOidcClientById, type OidcClient } from "./oidc-clients";

/** 9b: consistent success/failure shape for `updateOidcClientAdmin()`. */
export type OidcAdminClientUpdateResult =
  | { ok: true; client: OidcClient }
  | { ok: false; error: "not_found" | "server_error" };

/**
 * 9b: persistence half of `PATCH /admin/oidc-clients/:clientId`. `updates`
 * is exactly the already-validated fields
 * `validateOidcAdminClientUpdateRequest()` produces — this function does
 * no re-validation of its own, same discipline as
 * `lib/oidc-client-registration.ts`'s `updateOidcClientRegistration()`.
 *
 * Partial by construction, identical `!== undefined` idiom that sibling
 * function already uses: only keys actually present in `updates` are
 * written. `backchannelLogoutUri` is the one field where `undefined`
 * (leave alone) and `null` (explicitly clear it) are both meaningful and
 * must stay distinguishable — `!== undefined` is what makes that
 * distinction survive into the SQL, same as `updateOidcClientRegistration()`
 * already relies on for its own optional string fields.
 *
 * Distinguishes "no such client_id" (`not_found`, 404-worthy) from a
 * genuine persistence failure (`server_error`, 500-worthy) — a sharper
 * contract than `updateOidcClientRegistration()`'s own "null means either"
 * shape, because THIS caller (an admin operator looking at a specific
 * client_id from 9a's own list view) benefits from knowing which one
 * happened, in a way an anonymous `PUT /oidc/register/:client_id` caller
 * (already required to prove it via a bearer token before reaching this
 * deep) does not gain as much from.
 */
export async function updateOidcClientAdmin(
  clientId: string,
  updates: { redirectUris?: string[]; allowedScopes?: string[]; backchannelLogoutUri?: string | null },
): Promise<OidcAdminClientUpdateResult> {
  const sets: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 1;

  if (updates.redirectUris !== undefined) {
    sets.push(`redirect_uris = $${paramIndex++}::jsonb`);
    values.push(JSON.stringify(updates.redirectUris));
  }
  if (updates.allowedScopes !== undefined) {
    sets.push(`allowed_scopes = $${paramIndex++}::jsonb`);
    values.push(JSON.stringify(updates.allowedScopes));
  }
  if (updates.backchannelLogoutUri !== undefined) {
    sets.push(`backchannel_logout_uri = $${paramIndex++}`);
    values.push(updates.backchannelLogoutUri);
  }

  if (sets.length === 0) {
    // lib/oidc-client-admin-request.ts's own "at least one field required"
    // check means this should never happen in practice — same "caller bug,
    // not something this function guards against beyond returning the
    // current row" posture updateOidcClientRegistration() already takes.
    logger.warn({ clientId }, "[oidc-client-admin] updateOidcClientAdmin called with no fields to update");
    const current = await getOidcClientById(clientId);
    return current ? { ok: true, client: current } : { ok: false, error: "not_found" };
  }
  sets.push(`updated_at = now()`);
  values.push(clientId);

  try {
    const result = await pool.query(
      `UPDATE oidc_clients SET ${sets.join(", ")} WHERE client_id = $${paramIndex} RETURNING id`,
      values,
    );
    if (result.rows.length === 0) {
      logger.warn({ clientId }, "[oidc-client-admin] update targeted an unknown client_id");
      return { ok: false, error: "not_found" };
    }
    const updated = await getOidcClientById(clientId);
    if (!updated) {
      // Row was just updated by client_id above; a read-after-write miss
      // here means the read itself failed, not that the row vanished —
      // still surfaced as server_error rather than a false not_found.
      logger.warn({ clientId }, "[oidc-client-admin] read-after-write failed following update");
      return { ok: false, error: "server_error" };
    }
    logger.info({ clientId }, "oidc.client.admin_updated");
    return { ok: true, client: updated };
  } catch (err) {
    logger.warn({ err, clientId }, "[oidc-client-admin] failed to update client");
    return { ok: false, error: "server_error" };
  }
}

/** 9c: consistent success/failure shape for `createOidcClientAdmin()`. */
export type OidcAdminClientCreateResult =
  | { ok: true; client: OidcClient }
  | { ok: false; error: "conflict" | "server_error" };

/**
 * 9c: create a new first-party client. Every field is exactly what
 * `validateOidcAdminClientCreateRequest()` already produced — no
 * re-validation here, same discipline as `createOidcClient()` (8a).
 *
 * Unlike 8a's `createOidcClient()` (which GENERATES a random `client_id`
 * and retries on collision, because the caller never supplies one), this
 * function takes an ADMIN-CHOSEN `clientId` and treats a collision as a
 * genuine caller error, not a transient retry case: `INSERT ... ON
 * CONFLICT (client_id) DO NOTHING` (the same unique index, migration 079,
 * both paths share) plus checking `RETURNING`'s row count — zero rows
 * back means the admin's requested `client_id` is already taken, surfaced
 * as `"conflict"` so the route can return `409` rather than silently
 * overwriting an existing row (unlike
 * `scripts/src/seed-oidc-clients.ts`'s own `ON CONFLICT ... DO UPDATE`,
 * which is deliberately idempotent for its own re-run-the-same-seed use
 * case — an admin `POST` is a one-shot "create this new thing" request,
 * not a reseed, so silently updating an unrelated existing client of the
 * same name would be the wrong behavior here).
 *
 * `is_first_party = TRUE` and `registration_status = 'approved'` are
 * hardcoded in the INSERT itself — see this file's own header for why.
 * `client_secret_hash` / `registration_access_token_hash` are both `NULL`
 * — see this file's own header for why no secret-issuance step exists on
 * this path.
 */
export async function createOidcClientAdmin(input: {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  postLogoutRedirectUris: string[];
  allowedScopes: string[];
  backchannelLogoutUri: string | null;
}): Promise<OidcAdminClientCreateResult> {
  try {
    const result = await pool.query(
      `INSERT INTO oidc_clients (client_id, client_secret_hash, client_name, registration_status, redirect_uris, post_logout_redirect_uris, backchannel_logout_uri, allowed_scopes, is_first_party, registration_access_token_hash)
       VALUES ($1, NULL, $2, 'approved', $3::jsonb, $4::jsonb, $5, $6::jsonb, TRUE, NULL)
       ON CONFLICT (client_id) DO NOTHING
       RETURNING id`,
      [
        input.clientId,
        input.clientName,
        JSON.stringify(input.redirectUris),
        JSON.stringify(input.postLogoutRedirectUris),
        input.backchannelLogoutUri,
        JSON.stringify(input.allowedScopes),
      ],
    );
    if (result.rows.length === 0) {
      logger.warn({ clientId: input.clientId }, "[oidc-client-admin] client_id already exists, refusing to create");
      return { ok: false, error: "conflict" };
    }
    const created = await getOidcClientById(input.clientId);
    if (!created) {
      logger.warn({ clientId: input.clientId }, "[oidc-client-admin] read-after-write failed following create");
      return { ok: false, error: "server_error" };
    }
    logger.info({ clientId: input.clientId }, "oidc.client.admin_created");
    return { ok: true, client: created };
  } catch (err) {
    logger.warn({ err, clientId: input.clientId }, "[oidc-client-admin] failed to create client");
    return { ok: false, error: "server_error" };
  }
}

/** 9c: consistent success/failure shape for `deleteOidcClientAdmin()`. */
export type OidcAdminClientDeleteResult =
  | { ok: true }
  | { ok: false; error: "not_found" | "not_first_party" | "server_error" };

/**
 * 9c: delete a first-party client. DELIBERATELY scoped to
 * `is_first_party = TRUE` rows only (`WHERE client_id = $1 AND
 * is_first_party = TRUE`) — a dynamically-registered (third-party) client
 * is never deletable through this endpoint, even though nothing about the
 * SQL below would stop it otherwise. This is a narrower reading of 9c's
 * own roadmap subtitle, "Admin client create/delete (**first-party
 * path**)," than "delete any row in the table":
 *   - A third-party client already has its own admin-actionable lifecycle
 *     endpoint, Phase 9d's approval/suspension workflow — "suspend" is
 *     the correct operator action for a misbehaving or unwanted
 *     dynamically-registered client, not "delete." Suspension is
 *     reversible and auditable (9e); a hard DELETE here is neither.
 *   - `oidc_user_consents.client_id` and `oidc_refresh_tokens.client_id`
 *     (migrations 088/082) are BOTH deliberately NOT foreign keys into
 *     this table — see migration 088's own header for the precedent this
 *     follows. That means a hard delete of a client that a real user has
 *     active consent/refresh-token rows for leaves those rows pointing at
 *     a `client_id` that no longer resolves to anything — silently
 *     orphaned data, not a constraint violation. A first-party client an
 *     admin is deleting is presumed to be a decommissioned internal app
 *     (no path any current user is still actively consenting to, since
 *     first-party clients skip the consent screen entirely — Phase 7c),
 *     so this risk is real but low; it would NOT be low for an arbitrary
 *     third-party client with real end-user consents on file, which is
 *     this function's second, independent reason to refuse those.
 *   - This function itself does NOT revoke any outstanding tokens for the
 *     deleted client — that composition lives at the route layer, same
 *     "lib persists, route composes" split as the 9d note above.
 *     UPDATE — Season 5, Phase 10d: `routes/admin-oidc-clients.ts`'s
 *     DELETE handler now calls `revokeAllTokensForClient()` (10c) and
 *     dispatches a per-affected-user backchannel logout right after this
 *     function returns `ok: true`, the identical wiring 9d's status
 *     handler now does on suspend — see that route file's own DELETE
 *     handler for the exact order (affected-user list captured before
 *     the delete, cascade run after it succeeds).
 *
 * Returns `"not_found"` when the row simply doesn't exist, and
 * `"not_first_party"` when it exists but fails the `is_first_party` guard
 * — kept as two distinct reasons (rather than collapsing both into a
 * generic 404) because this is an internal, `requireDev`-gated admin
 * surface where the caller already saw the client's true
 * `is_first_party` value via 9a's own list view; there is no
 * information-disclosure concern in telling an already-authenticated
 * operator WHY their delete didn't happen, the same reasoning
 * `routes/admin-oidc-rollout.ts`'s own `NON_SYLO_APP_ID` 403 already
 * applies to explaining a refused write in detail on this same admin
 * tier.
 */
export async function deleteOidcClientAdmin(clientId: string): Promise<OidcAdminClientDeleteResult> {
  try {
    const existing = await getOidcClientById(clientId);
    if (!existing) {
      logger.warn({ clientId }, "[oidc-client-admin] delete targeted an unknown client_id");
      return { ok: false, error: "not_found" };
    }
    if (!existing.isFirstParty) {
      logger.warn({ clientId }, "[oidc-client-admin] refusing to delete a non-first-party client via this endpoint");
      return { ok: false, error: "not_first_party" };
    }

    const result = await pool.query(
      `DELETE FROM oidc_clients WHERE client_id = $1 AND is_first_party = TRUE RETURNING id`,
      [clientId],
    );
    if (result.rows.length === 0) {
      // Lost a race with a concurrent change between the read above and
      // this DELETE (e.g. another admin flipped is_first_party in the
      // meantime, or deleted it first) — surfaced as not_found, the
      // correct end state either way ("this client_id is not a
      // first-party row this endpoint can act on right now").
      logger.warn({ clientId }, "[oidc-client-admin] delete affected no rows (lost a race)");
      return { ok: false, error: "not_found" };
    }
    logger.info({ clientId }, "oidc.client.admin_deleted");
    return { ok: true };
  } catch (err) {
    logger.warn({ err, clientId }, "[oidc-client-admin] failed to delete client");
    return { ok: false, error: "server_error" };
  }
}

/** 9d: consistent success/failure shape for `updateOidcClientStatusAdmin()`. */
export type OidcAdminClientStatusUpdateResult =
  | { ok: true; client: OidcClient }
  | { ok: false; error: "not_found" | "invalid_transition" | "server_error" };

/**
 * 9d: persistence half of `PATCH /admin/oidc-clients/:clientId/status`.
 * `targetStatus` is exactly what `validateOidcAdminClientStatusRequest()`
 * already proved is `'approved'` or `'suspended'` — this function's own
 * job (see this file's UPDATE header note) is checking whether THIS
 * client's CURRENT status may legally move there:
 *   - `targetStatus === 'approved'` is only legal when the current row is
 *     `'pending'` — a `'suspended'` client is never re-approved through
 *     this function (9d's own roadmap text names no such transition; see
 *     this file's header for the full reasoning already given for why
 *     `'pending'` is never even an accepted request value, the mirror
 *     image of this same narrowing).
 *   - `targetStatus === 'suspended'` is legal from ANY current status,
 *     including a client that is already `'suspended'` — an idempotent
 *     no-op write (still returns `ok: true` with the unchanged row), never
 *     `invalid_transition`, because "suspend an already-suspended client"
 *     is a normal, harmless thing for an operator to click twice, not a
 *     caller error the way requesting an unreachable `'approved'` is.
 *
 * Does NOT call any token-revocation function on a transition to
 * `'suspended'` — see this file's own UPDATE header note, "THE Phase 10
 * GAP," for why none exists yet to call.
 *
 * Distinguishes `not_found` (no such `client_id`) from `invalid_transition`
 * (the client exists, but its current status forbids this target) from
 * `server_error` (a genuine write/read failure) — three different HTTP
 * statuses (`404`/`409`/`500`) the route below maps this to, the same
 * "give an already-authenticated internal operator the real reason, don't
 * collapse distinct failures into one generic code" posture
 * `deleteOidcClientAdmin()`'s own `not_found`/`not_first_party` split
 * already takes on this same admin tier.
 */
export async function updateOidcClientStatusAdmin(
  clientId: string,
  targetStatus: "approved" | "suspended",
): Promise<OidcAdminClientStatusUpdateResult> {
  try {
    const existing = await getOidcClientById(clientId);
    if (!existing) {
      logger.warn({ clientId }, "[oidc-client-admin] status change targeted an unknown client_id");
      return { ok: false, error: "not_found" };
    }

    if (targetStatus === "approved" && existing.registrationStatus !== "pending") {
      logger.warn(
        { clientId, currentStatus: existing.registrationStatus },
        "[oidc-client-admin] refusing to approve a client that isn't pending",
      );
      return { ok: false, error: "invalid_transition" };
    }

    const result = await pool.query(
      `UPDATE oidc_clients SET registration_status = $1, updated_at = now() WHERE client_id = $2 RETURNING id`,
      [targetStatus, clientId],
    );
    if (result.rows.length === 0) {
      // Lost a race with a concurrent delete between the read above and
      // this UPDATE — same "surfaced as not_found, the correct end state
      // either way" reasoning deleteOidcClientAdmin() already documents
      // for its own identical race.
      logger.warn({ clientId }, "[oidc-client-admin] status update affected no rows (lost a race)");
      return { ok: false, error: "not_found" };
    }
    const updated = await getOidcClientById(clientId);
    if (!updated) {
      logger.warn({ clientId }, "[oidc-client-admin] read-after-write failed following status update");
      return { ok: false, error: "server_error" };
    }
    logger.info({ clientId, targetStatus }, "oidc.client.admin_status_changed");
    return { ok: true, client: updated };
  } catch (err) {
    logger.warn({ err, clientId, targetStatus }, "[oidc-client-admin] failed to update client status");
    return { ok: false, error: "server_error" };
  }
}
