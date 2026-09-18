/**
 * lib/oidc-client-registration-request.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 4, Phase 8a: Dynamic Client Registration
 * (RFC 7591-স্কোপড-ডাউন) — request-validation half.
 *
 * Pure, DB-free validation of the `POST /oidc/register` request body,
 * same "route composes, this validates, `lib/oidc-client-registration.ts`
 * persists" split every other OIDC route in this roadmap uses (compare
 * `lib/oidc-authorize-request.ts` + `lib/oidc-client-request-validation.ts`
 * for `/oidc/authorize`'s own request/persistence split). Only imports
 * `parseScopeString`/`KNOWN_OIDC_SCOPES` from the already-pure
 * `oidc-scope-validation.ts` — no `@workspace/db`, exactly like every other
 * "2C/2D-style" validator in this codebase.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * NOTE ON THIS FILE'S OWN HISTORY: this file shipped as part of Phase 8a.
 * The 8a pass itself was not part of the bundle this reconstruction pass
 * (Phase 8d/8e) had directly in hand — only 8a's OWN test suite
 * (`scripts/src/test-oidc-client-registration-request.ts`) and every OTHER
 * file that imports from here were available. This file's pre-8d shape
 * (the `validateClientName()`/`validateRedirectUris()`/`validateScope()`
 * structure, the field-check order, the exact `{ok,error,field}` result
 * shape) is reconstructed to satisfy that already-existing test suite
 * byte-for-byte — if the real 8a file differs from this reconstruction in
 * some behavior its own tests don't cover, diff against the live repo
 * before applying. Only the parts explicitly marked "8d" / "8e" below are
 * this pass's actual new work.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * UPDATE — Season 4, Phase 8d: Redirect URI নীতি.
 *
 * `validateRedirectUris()` now also runs every candidate URI through
 * `isDynamicClientRedirectUriAllowed()`
 * (`lib/oidc-dynamic-client-redirect-uri-policy.ts`) — https-only (with a
 * localhost dev exception), no wildcard/path-traversal pattern, no
 * fragment. This REPLACES 8a's own test's documented behavior ("a
 * non-https redirect_uri is accepted at THIS layer — 8d's stricter policy
 * is a separate, later phase") — that test still passes unmodified for its
 * literal `http://localhost:3000/callback` input (the dev exception covers
 * it), but its assumption ("no policy exists yet at this layer") is now
 * false; see this pass's own update to that test file for a corrected
 * comment and new negative cases (non-localhost `http://`, wildcard,
 * path-traversal, fragment).
 *
 * Failures from the 8d policy reuse the SAME `invalid_redirect_uri` /
 * `redirect_uris` result 8a's own malformed-URL case already returns — no
 * new error code, same reasoning 8c's own `lib/oidc-client-validation.ts`
 * update gives for reusing `invalid_client` rather than inventing
 * `unauthorized_client`: a caller (`routes/oidc-register.ts`) that already
 * knows how to render "your redirect_uris were rejected" for one reason
 * renders it correctly for the other with zero new branches.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * UPDATE — Season 4, Phase 8e: Client configuration management token
 * (RFC 7592-স্কোপড-ডাউন).
 *
 * New `validateOidcClientRegistrationUpdateRequest()` — validates a
 * `PUT /oidc/register/:client_id` body. Reuses this file's OWN
 * `validateClientName()`/`validateRedirectUris()` (including 8d's policy,
 * since a self-managed update MUST be held to the same redirect_uri
 * policy as initial registration — see that policy file's own header for
 * why enforcing it only at creation would make 8d cosmetic) but is its own
 * separate exported function, not a thin wrapper around
 * `validateOidcClientRegistrationRequest()`, for one deliberate reason:
 * this function never reads `body.scope` at all — not "reads it and
 * rejects if present," simply never looks at the key. That is what makes
 * 8e's own roadmap text true by construction ("নতুন scope request করা
 * যাবে না এই টোকেন দিয়ে") — an attacker who knows the registration_access_token
 * gains no code path here that could touch `allowed_scopes`, because no
 * code path here ever reads the field that would carry a scope request.
 * Both `client_name` and `redirect_uris` are OPTIONAL on this path (unlike
 * `POST /oidc/register`, where `redirect_uris` is mandatory) — a partial
 * update ("just rename the client") is a legitimate, common case RFC 7592
 * itself allows via its own PUT semantics; at least one of the two must be
 * present, or there is nothing to update.
 */

import { parseScopeString, KNOWN_OIDC_SCOPES } from "./oidc-scope-validation";
import { isDynamicClientRedirectUriAllowed } from "./oidc-dynamic-client-redirect-uri-policy";
import { logger } from "./logger";

const MAX_CLIENT_NAME_LENGTH = 200;
const MAX_REDIRECT_URIS = 10;

/** 8a: consistent success/failure shape for `POST /oidc/register`'s own request validation. */
export type OidcClientRegistrationValidationResult =
  | { ok: true; clientName: string; redirectUris: string[]; scopes: string[] }
  | {
      ok: false;
      error: "invalid_client_metadata" | "invalid_redirect_uri";
      field: "client_name" | "redirect_uris" | "scope";
    };

/**
 * 8e: consistent success/failure shape for `PUT /oidc/register/:client_id`'s
 * own request validation. Deliberately its own, narrower type — never
 * carries `scope`/`scopes` at all (see this file's own "UPDATE — Phase 8e"
 * header note for why), and both success fields are optional (a partial
 * update).
 */
export type OidcClientRegistrationUpdateValidationResult =
  | { ok: true; clientName?: string; redirectUris?: string[] }
  | {
      ok: false;
      error: "invalid_client_metadata" | "invalid_redirect_uri";
      field: "client_name" | "redirect_uris";
    };

type ClientNameValidation = { ok: true; clientName: string } | { ok: false };

function validateClientName(raw: unknown): ClientNameValidation {
  if (typeof raw !== "string") return { ok: false };
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_CLIENT_NAME_LENGTH) return { ok: false };
  return { ok: true, clientName: trimmed };
}

type RedirectUrisValidation = { ok: true; redirectUris: string[] } | { ok: false };

/**
 * Validates `redirect_uris`: must be a non-empty array (capped at
 * `MAX_REDIRECT_URIS`), every entry a string that parses as a URL AND
 * (Phase 8d) satisfies `isDynamicClientRedirectUriAllowed()`. Duplicate
 * entries are de-duplicated, first-seen order preserved — same
 * "normalize, don't reject, on a harmless redundancy" instinct
 * `parseScopeString()` already applies to a repeated scope token.
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
    // Phase 8d — see lib/oidc-dynamic-client-redirect-uri-policy.ts's own header.
    if (!isDynamicClientRedirectUriAllowed(entry)) return { ok: false };
    if (!seen.has(entry)) {
      seen.add(entry);
      redirectUris.push(entry);
    }
  }
  return { ok: true, redirectUris };
}

type ScopeValidation = { ok: true; scopes: string[] } | { ok: false };

/**
 * `scope` is optional — absent/`null`/`undefined` is a valid, empty scope
 * request (8a's own test: "scope is optional"). Every parsed token must be
 * one of `KNOWN_OIDC_SCOPES` — there is no `client` yet at registration
 * time to additionally narrow against (that's what `allowedScopes` will
 * BECOME once this request is persisted), so only the "unknown scope"
 * half of Phase 2D's two checks applies here, not the "disallowed for this
 * client" half.
 */
function validateScope(raw: unknown): ScopeValidation {
  if (raw === undefined || raw === null) return { ok: true, scopes: [] };
  if (typeof raw !== "string") return { ok: false };
  const scopes = parseScopeString(raw);
  for (const scope of scopes) {
    if (!(KNOWN_OIDC_SCOPES as readonly string[]).includes(scope)) return { ok: false };
  }
  return { ok: true, scopes };
}

/**
 * 8a: validates a `POST /oidc/register` body. Field-check order is
 * `client_name` -> `redirect_uris` -> `scope`, deliberate and tested (8a's
 * own "field-check order" test matrix) so a caller sending multiple bad
 * fields always gets the same, deterministic single error back.
 *
 * Only reads `client_name`, `redirect_uris`, `scope` off the body —
 * anything else present (`is_first_party`, `client_id`, `client_secret`,
 * `registration_status`, ...) is silently ignored, never read, never
 * echoed into the success result. See 8b's own defense-in-depth test for
 * why this matters: `lib/oidc-client-registration.ts`'s hardcoded
 * `is_first_party = FALSE` at the INSERT layer is one layer; this
 * function never even looking at the key is the other.
 */
export function validateOidcClientRegistrationRequest(body: unknown): OidcClientRegistrationValidationResult {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;

  const nameResult = validateClientName(b.client_name);
  if (!nameResult.ok) {
    logger.warn({}, "[oidc-client-registration-request] invalid or missing client_name");
    return { ok: false, error: "invalid_client_metadata", field: "client_name" };
  }

  const redirectResult = validateRedirectUris(b.redirect_uris);
  if (!redirectResult.ok) {
    logger.warn({}, "[oidc-client-registration-request] invalid or missing redirect_uris");
    return { ok: false, error: "invalid_redirect_uri", field: "redirect_uris" };
  }

  const scopeResult = validateScope(b.scope);
  if (!scopeResult.ok) {
    logger.warn({}, "[oidc-client-registration-request] invalid scope");
    return { ok: false, error: "invalid_client_metadata", field: "scope" };
  }

  return {
    ok: true,
    clientName: nameResult.clientName,
    redirectUris: redirectResult.redirectUris,
    scopes: scopeResult.scopes,
  };
}

/**
 * 8e: validates a `PUT /oidc/register/:client_id` body. See this file's
 * own "UPDATE — Phase 8e" header for why this is a separate function
 * rather than a thin wrapper: `scope` is never read here at all, and both
 * fields are optional (at least one required).
 */
export function validateOidcClientRegistrationUpdateRequest(
  body: unknown,
): OidcClientRegistrationUpdateValidationResult {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const hasClientName = Object.prototype.hasOwnProperty.call(b, "client_name");
  const hasRedirectUris = Object.prototype.hasOwnProperty.call(b, "redirect_uris");

  if (!hasClientName && !hasRedirectUris) {
    logger.warn({}, "[oidc-client-registration-request] update request has neither client_name nor redirect_uris");
    return { ok: false, error: "invalid_client_metadata", field: "client_name" };
  }

  const result: { clientName?: string; redirectUris?: string[] } = {};

  if (hasClientName) {
    const nameResult = validateClientName(b.client_name);
    if (!nameResult.ok) {
      logger.warn({}, "[oidc-client-registration-request] invalid client_name on update");
      return { ok: false, error: "invalid_client_metadata", field: "client_name" };
    }
    result.clientName = nameResult.clientName;
  }

  if (hasRedirectUris) {
    const redirectResult = validateRedirectUris(b.redirect_uris);
    if (!redirectResult.ok) {
      logger.warn({}, "[oidc-client-registration-request] invalid redirect_uris on update");
      return { ok: false, error: "invalid_redirect_uri", field: "redirect_uris" };
    }
    result.redirectUris = redirectResult.redirectUris;
  }

  return { ok: true, ...result };
}
