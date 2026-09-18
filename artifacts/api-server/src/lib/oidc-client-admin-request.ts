/**
 * lib/oidc-client-admin-request.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 5, Phase 9b (admin client detail/edit) + Phase 9c
 * (admin client create/delete, first-party path) — request-validation half.
 *
 * Pure, DB-free validation of `PATCH /admin/oidc-clients/:clientId` (9b)
 * and `POST /admin/oidc-clients` (9c) request bodies, same
 * "route composes, this validates, `lib/oidc-client-admin.ts` persists"
 * split `lib/oidc-client-registration-request.ts` +
 * `lib/oidc-client-registration.ts` already use for Phase 8a/8e's own
 * self-service registration paths. This is the ADMIN twin of that pair —
 * same shape, deliberately a separate file rather than added functions on
 * the 8a/8e file, because the two paths answer to different trust models
 * (see "WHY NOT REUSE 8a/8d's VALIDATION" below).
 *
 * Only imports `KNOWN_OIDC_SCOPES` from the already-pure
 * `oidc-scope-validation.ts` — no `@workspace/db`, no Express types, same
 * "2C/2D-style validator" discipline every sibling file in this family
 * follows.
 *
 * WHY NOT REUSE 8a/8d's VALIDATION (`lib/oidc-client-registration-request.ts`)
 * That file's `validateRedirectUris()` also runs every candidate URI
 * through Phase 8d's `isDynamicClientRedirectUriAllowed()` — https-only
 * (with a localhost dev exception), no wildcard, no fragment. That policy
 * exists specifically because a THIRD-PARTY, self-registered client is
 * unverified by construction (8d's own roadmap text: "Dynamically-
 * registered client-এর জন্য বাড়তি নিয়ম"). An admin editing or creating a
 * FIRST-PARTY client through this file is a different trust boundary
 * entirely — the roadmap's own Phase 8d text says so explicitly:
 * "First-party client-এর জন্য existing exact-match validation (Phase 2c)
 * যথেষ্ট ছিল কারণ AYZEN নিজেই সেগুলো সেট করে" (exact-match validation was
 * already enough for first-party, because AYZEN itself sets them). This
 * file's own `validateRedirectUris()` below is that Phase-2c-level check
 * only — well-formed URL, nothing about scheme or fragments — never 8d's
 * stricter policy. Importing/reusing 8a's validator here would silently
 * import a policy this phase's own roadmap text says does not apply to
 * this trust boundary.
 *
 * FIELD SCOPE DISCIPLINE (this is 9b/9c, not 9d/9e)
 *   - 9b's update validator (`validateOidcAdminClientUpdateRequest`) reads
 *     exactly the three fields 9b's own roadmap text names as now
 *     admin-editable — `redirectUris`, `allowedScopes`,
 *     `backchannelLogoutUri` — nothing else. `clientName` and
 *     `postLogoutRedirectUris` are deliberately NOT accepted here even
 *     though they live on the same row: 9b's task list doesn't name them,
 *     and this roadmap's own established discipline (see e.g. 8e's
 *     `validateOidcClientRegistrationUpdateRequest()`, which never even
 *     reads `scope`) is "a validator should not read a field its own
 *     phase wasn't asked to expose," not "read everything and hope a
 *     later check narrows it back down."
 *   - 9c's create validator does not read or accept `registrationStatus`
 *     or `isFirstParty` — both are hardcoded by `lib/oidc-client-admin.ts`
 *     at the INSERT layer (`is_first_party = TRUE`, `registration_status
 *     = 'approved'`), same "never even look at the key" defense-in-depth
 *     8a's own registration validator already established for
 *     `is_first_party` (see that file's own header). A caller cannot
 *     create a `'pending'`/`'suspended'` first-party client through this
 *     endpoint even by trying — there is no code path here that reads a
 *     value into that decision at all.
 *   - Audit logging (9e) is not this file's concern at all — it has no
 *     validation step, only a write triggered by the ROUTE after 9b/9c/9d's
 *     own validation+persistence already succeeded.
 *
 * UPDATE — Season 5, Phase 9d: Approval/Suspension Workflow.
 *
 * `validateOidcAdminClientStatusRequest()` below is 9d's own request
 * validator, added after 9b/9c's original content (left otherwise
 * unchanged). Same "is this body well-formed, never should this transition
 * be allowed" scope line the rest of this file's header already draws —
 * WHICH transitions are legal (`pending -> approved`, any -> `suspended`)
 * is `lib/oidc-client-admin.ts`'s `updateOidcClientStatusAdmin()`'s own
 * job, because answering that question requires knowing the client's
 * CURRENT `registrationStatus`, a DB read this pure, DB-free file
 * deliberately never performs (same reason `validateOidcAdminClientCreateRequest()`
 * above never checks whether a `clientId` already exists — that's
 * `createOidcClientAdmin()`'s `ON CONFLICT` to discover, not this file's).
 * This validator only proves the request NAMED one of the two states this
 * endpoint can ever transition a client TO — `'pending'` is deliberately
 * not among them (see the function's own comment for why).
 */

import { KNOWN_OIDC_SCOPES } from "./oidc-scope-validation";
import { logger } from "./logger";

/** Generous ceiling for an admin-managed first-party client's redirect_uris — bigger than 8a's dynamic-client MAX_REDIRECT_URIS (10), since a long-lived first-party app legitimately accumulates prod + staging + per-developer localhost callbacks over time, and an admin (not an anonymous caller) is the one adding them. */
const MAX_REDIRECT_URIS = 20;

/** `client_id` here is an admin-chosen, memorable slug (e.g. "sylo", "ryft-staging") — NOT the random 32-hex-char identifier `lib/oidc-client-registration.ts`'s `generateClientId()` mints for a dynamically-registered client. Lowercase letters/digits/hyphens only, must start and end with an alphanumeric — this both keeps it URL/log-safe (client_id appears in callback URLs, discovery responses, and log lines throughout this codebase) and keeps it visually distinct from a dynamically-registered client's hex identifier, so an operator glancing at a client_id in `lib/vault-backup-audit.ts`-style audit output has a decent chance of guessing which registration path created it without looking anything up. */
const CLIENT_ID_PATTERN = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/;
const MAX_CLIENT_NAME_LENGTH = 200;

type RedirectUrisValidation = { ok: true; redirectUris: string[] } | { ok: false };

/**
 * Phase-2c-level redirect_uri validation: non-empty array (capped at
 * `MAX_REDIRECT_URIS`), every entry a string that parses as a well-formed
 * URL. Deliberately does NOT run Phase 8d's `isDynamicClientRedirectUriAllowed()`
 * — see this file's own header for why that policy is out of scope here.
 * Duplicates are de-duplicated, first-seen order preserved, same instinct
 * `lib/oidc-client-registration-request.ts`'s own `validateRedirectUris()`
 * already applies to a harmless redundancy.
 */
function validateRedirectUris(raw: unknown): RedirectUrisValidation {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_REDIRECT_URIS) return { ok: false };
  const seen = new Set<string>();
  const redirectUris: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") return { ok: false };
    try {
      // eslint-disable-next-line no-new -- parse-only, just proving it's a well-formed URL
      new URL(entry);
    } catch {
      return { ok: false };
    }
    if (!seen.has(entry)) {
      seen.add(entry);
      redirectUris.push(entry);
    }
  }
  return { ok: true, redirectUris };
}

/**
 * `post_logout_redirect_uris` (9c create only — RP-Initiated Logout's own
 * registered list, migration 084) — same Phase-2c-level well-formed-URL
 * check as `validateRedirectUris()` above, but OPTIONAL and permitted to
 * be an empty array: unlike the OAuth callback list, a client with no
 * registered post-logout target simply never gets one offered (existing
 * behavior for every client seeded before migration 084), not a broken
 * client.
 */
function validatePostLogoutRedirectUris(raw: unknown): RedirectUrisValidation {
  if (raw === undefined) return { ok: true, redirectUris: [] };
  if (!Array.isArray(raw) || raw.length > MAX_REDIRECT_URIS) return { ok: false };
  const seen = new Set<string>();
  const redirectUris: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") return { ok: false };
    try {
      // eslint-disable-next-line no-new -- parse-only, just proving it's a well-formed URL
      new URL(entry);
    } catch {
      return { ok: false };
    }
    if (!seen.has(entry)) {
      seen.add(entry);
      redirectUris.push(entry);
    }
  }
  return { ok: true, redirectUris };
}

type ScopesValidation = { ok: true; scopes: string[] } | { ok: false };

/**
 * `allowed_scopes` — unlike Phase 8a's own `validateScope()` (which parses
 * a space-delimited RFC-style `scope` string, because that's the shape
 * `POST /oidc/register`'s body uses), this reads a JS array of strings
 * directly — the same shape the `oidc_clients.allowed_scopes` JSONB
 * column and this codebase's `OidcClient.allowedScopes` field already
 * use, since an admin API talking to an admin API has no RFC wire-format
 * to match. Every entry must be one of `KNOWN_OIDC_SCOPES` — same "only
 * the unknown-scope half of Phase 2D applies here, there's no separate
 * requesting client to additionally narrow against" reasoning 8a's own
 * `validateScope()` already gives, since this function is DEFINING that
 * narrower per-client allow-list, not checking a request against one.
 * An empty array is accepted — revoking every scope from a client is an
 * unusual but legitimate admin action (it will simply reject every future
 * `/oidc/authorize` scope request for that client, Phase 2D's own job to
 * enforce, not this validator's).
 */
function validateAllowedScopes(raw: unknown): ScopesValidation {
  if (!Array.isArray(raw)) return { ok: false };
  const seen = new Set<string>();
  const scopes: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string" || !(KNOWN_OIDC_SCOPES as readonly string[]).includes(entry)) return { ok: false };
    if (!seen.has(entry)) {
      seen.add(entry);
      scopes.push(entry);
    }
  }
  return { ok: true, scopes };
}

type BackchannelLogoutUriValidation = { ok: true; backchannelLogoutUri: string | null } | { ok: false };

/**
 * `backchannel_logout_uri` — nullable (explicit `null` clears it, the
 * same fail-closed default migration 085 gives every client that never
 * registers one). When present and non-null, must be a well-formed URL —
 * same Phase-2c-level check as `validateRedirectUris()`, no additional
 * scheme restriction, for the identical "first-party, admin-set, Phase 2c
 * was already enough" reasoning this file's header gives.
 */
function validateBackchannelLogoutUri(raw: unknown): BackchannelLogoutUriValidation {
  if (raw === null) return { ok: true, backchannelLogoutUri: null };
  if (typeof raw !== "string" || raw.length === 0) return { ok: false };
  try {
    // eslint-disable-next-line no-new -- parse-only, just proving it's a well-formed URL
    new URL(raw);
  } catch {
    return { ok: false };
  }
  return { ok: true, backchannelLogoutUri: raw };
}

type ClientIdValidation = { ok: true; clientId: string } | { ok: false };

function validateClientId(raw: unknown): ClientIdValidation {
  if (typeof raw !== "string") return { ok: false };
  const trimmed = raw.trim();
  if (!CLIENT_ID_PATTERN.test(trimmed)) return { ok: false };
  return { ok: true, clientId: trimmed };
}

type ClientNameValidation = { ok: true; clientName: string } | { ok: false };

function validateClientName(raw: unknown): ClientNameValidation {
  if (typeof raw !== "string") return { ok: false };
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_CLIENT_NAME_LENGTH) return { ok: false };
  return { ok: true, clientName: trimmed };
}

/**
 * 9b: consistent success/failure shape for `PATCH /admin/oidc-clients/:clientId`.
 * `updates` only ever carries keys that were actually present in the
 * request body (partial update, same `hasOwnProperty`-gated idiom 8e's
 * own `validateOidcClientRegistrationUpdateRequest()` uses) — a field the
 * caller didn't mention is left untouched by `lib/oidc-client-admin.ts`,
 * never reset to a default.
 */
export type OidcAdminClientUpdateValidationResult =
  | {
      ok: true;
      updates: { redirectUris?: string[]; allowedScopes?: string[]; backchannelLogoutUri?: string | null };
    }
  | {
      ok: false;
      error: "invalid_request";
      field: "redirectUris" | "allowedScopes" | "backchannelLogoutUri" | "none";
    };

/**
 * 9b: validates a `PATCH /admin/oidc-clients/:clientId` body. Exactly the
 * three fields 9b's own roadmap text names — see this file's own header
 * "FIELD SCOPE DISCIPLINE" note for why `clientName`/`postLogoutRedirectUris`
 * are never read here. All three are optional, but at least one must be
 * present — an empty PATCH body is a caller bug this function rejects
 * outright (`field: "none"`) rather than silently succeeding as a no-op.
 */
export function validateOidcAdminClientUpdateRequest(body: unknown): OidcAdminClientUpdateValidationResult {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const hasRedirectUris = Object.prototype.hasOwnProperty.call(b, "redirectUris");
  const hasAllowedScopes = Object.prototype.hasOwnProperty.call(b, "allowedScopes");
  const hasBackchannelLogoutUri = Object.prototype.hasOwnProperty.call(b, "backchannelLogoutUri");

  if (!hasRedirectUris && !hasAllowedScopes && !hasBackchannelLogoutUri) {
    logger.warn({}, "[oidc-client-admin-request] update request named no editable field");
    return { ok: false, error: "invalid_request", field: "none" };
  }

  const updates: { redirectUris?: string[]; allowedScopes?: string[]; backchannelLogoutUri?: string | null } = {};

  if (hasRedirectUris) {
    const result = validateRedirectUris(b.redirectUris);
    if (!result.ok) {
      logger.warn({}, "[oidc-client-admin-request] invalid redirectUris on update");
      return { ok: false, error: "invalid_request", field: "redirectUris" };
    }
    updates.redirectUris = result.redirectUris;
  }

  if (hasAllowedScopes) {
    const result = validateAllowedScopes(b.allowedScopes);
    if (!result.ok) {
      logger.warn({}, "[oidc-client-admin-request] invalid allowedScopes on update");
      return { ok: false, error: "invalid_request", field: "allowedScopes" };
    }
    updates.allowedScopes = result.scopes;
  }

  if (hasBackchannelLogoutUri) {
    const result = validateBackchannelLogoutUri(b.backchannelLogoutUri);
    if (!result.ok) {
      logger.warn({}, "[oidc-client-admin-request] invalid backchannelLogoutUri on update");
      return { ok: false, error: "invalid_request", field: "backchannelLogoutUri" };
    }
    updates.backchannelLogoutUri = result.backchannelLogoutUri;
  }

  return { ok: true, updates };
}

/** 9c: consistent success/failure shape for `POST /admin/oidc-clients`. */
export type OidcAdminClientCreateValidationResult =
  | {
      ok: true;
      clientId: string;
      clientName: string;
      redirectUris: string[];
      postLogoutRedirectUris: string[];
      allowedScopes: string[];
      backchannelLogoutUri: string | null;
    }
  | {
      ok: false;
      error: "invalid_request";
      field: "clientId" | "clientName" | "redirectUris" | "postLogoutRedirectUris" | "allowedScopes" | "backchannelLogoutUri";
    };

/**
 * 9c: validates a `POST /admin/oidc-clients` body. Field-check order is
 * `clientId` -> `clientName` -> `redirectUris` -> `postLogoutRedirectUris`
 * -> `allowedScopes` -> `backchannelLogoutUri` — same "deterministic
 * single error even when multiple fields are bad" reasoning 8a's own
 * `validateOidcClientRegistrationRequest()` documents for its own field
 * order.
 *
 * `allowedScopes` and `backchannelLogoutUri` are OPTIONAL here (default
 * `[]` / `null` respectively) — a freshly-created first-party client with
 * no scopes yet or no backchannel receiver yet is a valid, if incomplete,
 * starting point an admin can PATCH (9b) later; unlike `redirectUris`,
 * there is no flow that is immediately broken by starting from empty/null
 * on these two.
 *
 * Never reads `isFirstParty` or `registrationStatus` off the body — see
 * this file's own header for why that is a structural guarantee, not a
 * runtime check.
 */
export function validateOidcAdminClientCreateRequest(body: unknown): OidcAdminClientCreateValidationResult {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;

  const clientIdResult = validateClientId(b.clientId);
  if (!clientIdResult.ok) {
    logger.warn({}, "[oidc-client-admin-request] invalid or missing clientId");
    return { ok: false, error: "invalid_request", field: "clientId" };
  }

  const clientNameResult = validateClientName(b.clientName);
  if (!clientNameResult.ok) {
    logger.warn({}, "[oidc-client-admin-request] invalid or missing clientName");
    return { ok: false, error: "invalid_request", field: "clientName" };
  }

  const redirectUrisResult = validateRedirectUris(b.redirectUris);
  if (!redirectUrisResult.ok) {
    logger.warn({}, "[oidc-client-admin-request] invalid or missing redirectUris");
    return { ok: false, error: "invalid_request", field: "redirectUris" };
  }

  const postLogoutResult = validatePostLogoutRedirectUris(b.postLogoutRedirectUris);
  if (!postLogoutResult.ok) {
    logger.warn({}, "[oidc-client-admin-request] invalid postLogoutRedirectUris");
    return { ok: false, error: "invalid_request", field: "postLogoutRedirectUris" };
  }

  const allowedScopesResult = validateAllowedScopes(b.allowedScopes ?? []);
  if (!allowedScopesResult.ok) {
    logger.warn({}, "[oidc-client-admin-request] invalid allowedScopes");
    return { ok: false, error: "invalid_request", field: "allowedScopes" };
  }

  const backchannelResult = validateBackchannelLogoutUri(b.backchannelLogoutUri ?? null);
  if (!backchannelResult.ok) {
    logger.warn({}, "[oidc-client-admin-request] invalid backchannelLogoutUri");
    return { ok: false, error: "invalid_request", field: "backchannelLogoutUri" };
  }

  return {
    ok: true,
    clientId: clientIdResult.clientId,
    clientName: clientNameResult.clientName,
    redirectUris: redirectUrisResult.redirectUris,
    postLogoutRedirectUris: postLogoutResult.redirectUris,
    allowedScopes: allowedScopesResult.scopes,
    backchannelLogoutUri: backchannelResult.backchannelLogoutUri,
  };
}

/** 9d: consistent success/failure shape for `PATCH /admin/oidc-clients/:clientId/status`. */
export type OidcAdminClientStatusValidationResult =
  | { ok: true; targetStatus: "approved" | "suspended" }
  | { ok: false; error: "invalid_request"; field: "registrationStatus" };

/**
 * 9d: validates a `PATCH /admin/oidc-clients/:clientId/status` body. The
 * ONLY accepted `registrationStatus` values are `'approved'` and
 * `'suspended'` — `'pending'` is deliberately never a valid target here,
 * even though it's one of the three values `OidcClientRegistrationStatus`
 * allows overall: 9d's own roadmap text names exactly two transitions
 * (`'pending' -> 'approved'`, any state `-> 'suspended'`), neither of which
 * has `'pending'` as a DESTINATION — a client only ever arrives at
 * `'pending'` by being freshly created via Phase 8a's `POST /oidc/register`,
 * never by an admin action. Accepting `'pending'` here would let an admin
 * "un-approve" a client back to pending, a transition this roadmap never
 * names and this validator therefore refuses to even parse, same "don't
 * accept an unnamed value and hope a later layer narrows it back down"
 * discipline this file's own header states for `registrationStatus`/
 * `isFirstParty` on the 9c create path.
 *
 * Does NOT check the client's CURRENT status — see this file's own header
 * UPDATE note on why that's `updateOidcClientStatusAdmin()`'s job, not
 * this pure validator's.
 */
export function validateOidcAdminClientStatusRequest(body: unknown): OidcAdminClientStatusValidationResult {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const raw = b.registrationStatus;
  if (raw === "approved" || raw === "suspended") {
    return { ok: true, targetStatus: raw };
  }
  logger.warn({}, "[oidc-client-admin-request] invalid or missing registrationStatus on status update");
  return { ok: false, error: "invalid_request", field: "registrationStatus" };
}
