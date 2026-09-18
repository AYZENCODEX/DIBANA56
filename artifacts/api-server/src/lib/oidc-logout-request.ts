/**
 * lib/oidc-logout-request.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 3, Phase 6a: RP-Initiated Logout Request
 * (6a-a Endpoint Skeleton's request-shape half, 6a-b id_token_hint,
 * 6a-c Client Resolution, 6a-d post_logout_redirect_uri, 6a-e Error
 * Handling).
 *
 * Same split every earlier request-validation file in this roadmap already
 * uses (`lib/oidc-authorize-request.ts`, Phase 3a): `parseOidcLogoutRequest()`
 * is pure, total, and cannot fail — it just reads query-string strings into
 * a typed shape. `validateOidcLogoutRequest()` is the async orchestration
 * step that resolves a client (DB read, Phase 2A-c) and checks the
 * `post_logout_redirect_uri` against it (Phase 2C's redirect-URI
 * discipline, mirrored for this purpose by 6a-d's own
 * `validateOidcPostLogoutRedirectUri()`). `routes/oidc-logout.ts` composes
 * this with `verifyIdTokenHint()` (`lib/oidc-id-token.ts`, 6a-b) and
 * `routes/auth.ts`-style session termination (6b) — this file owns request
 * validation only, not session state.
 *
 * 6a-e, THE SHORT VERSION: OIDC RP-Initiated Logout 1.0, unlike
 * `/oidc/authorize`, has no `?error=...` redirect-back mechanism at all —
 * there is no "client's own redirect_uri" to bounce an error to before the
 * client has even been confirmed. So EVERY failure case below is
 * `redirectable: false` by construction (the field exists for symmetry
 * with `OidcAuthorizeRequestValidationResult` and so a future caller can't
 * assume otherwise): a bad `id_token_hint`, an unresolvable client, and an
 * unregistered `post_logout_redirect_uri` are all rendered directly by
 * `routes/oidc-logout.ts`, never as a redirect — see
 * `lib/oidc-client-validation.ts`'s header for why redirecting on an
 * unverified target is unsafe in the first place, which applies here with
 * even less justification (Phase 3's authorize endpoint at least has a
 * previously-verified `redirect_uri` to fall back on for SOME failures;
 * this endpoint never does).
 *
 * 6a-c, CONCRETELY: the requesting client is resolved from `id_token_hint`'s
 * own `aud` claim when a hint is present and verifies (RP-Initiated Logout
 * 1.0 §2's own recommended mechanism — the hint already proves, by
 * signature, which client's login this token was issued for), falling back
 * to the bare `client_id` query parameter otherwise. If BOTH are present
 * they must agree — silently preferring one over a caller-supplied
 * disagreement would let a caller name one client's `id_token_hint`
 * alongside a different client's `client_id`/`post_logout_redirect_uri`,
 * which is exactly the kind of confused-deputy mismatch this file's own
 * exact-match discipline elsewhere is built to prevent.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT DO
 *   - No session lookup/termination (Phase 6b, routes/oidc-logout.ts's own
 *     job, reusing `lib/sessions.ts`/`lib/session-cookie.ts` exactly as
 *     `routes/auth.ts`'s `POST /auth/logout` already does).
 *   - No `id_token_hint` signature verification itself — that is
 *     `verifyIdTokenHint()` (`lib/oidc-id-token.ts`, 6a-b), injected as a
 *     parameter so this file stays DB/crypto-free and independently
 *     unit-testable, same "inject the effectful boundary" discipline
 *     `lib/oidc-cutover-gate.ts` already documents for itself.
 *   - No logout-propagation/`user_sessions` cross-path behavior — that is
 *     Phase 6c/6d/6e, explicitly out of scope for this pass.
 */

import type { OidcClient } from "./oidc-clients";
import { validateOidcPostLogoutRedirectUri } from "./oidc-client-validation";
import { logger } from "./logger";

/** 6a-a: the request-shape fields `GET /oidc/logout` accepts, straight off the query string — RP-Initiated Logout 1.0 §2's own parameter names. */
export interface OidcLogoutRequestRaw {
  idTokenHint?: string;
  clientId?: string;
  postLogoutRedirectUri?: string;
  state?: string;
}

/** A verified `id_token_hint`'s claims — the subset `validateOidcLogoutRequest()` needs. Matches `IdTokenHintClaims` (`lib/oidc-id-token.ts`) by shape; declared independently here so this file has no import-time dependency on `jsonwebtoken`/`jwt-keys`. */
export interface VerifiedLogoutHint {
  sub: string;
  aud: string;
}

/** Injected verifier signature — `verifyIdTokenHint` (`lib/oidc-id-token.ts`) already matches this exactly; a caller passes it in rather than this file importing it directly, so `validateOidcLogoutRequest()` stays unit-testable with a fake verifier and no real RS256 keys. */
export type IdTokenHintVerifier = (token: string) => VerifiedLogoutHint | null;

/**
 * Season 3, Phase 6c-a/6c-d: injected client-resolver signature —
 * `getOidcClientById` (`./oidc-clients`) already matches this exactly.
 * Required (not defaulted), the identical discipline this file already
 * applies to `verifyHint`/`IdTokenHintVerifier` above: the caller
 * (`routes/oidc-logout.ts`) passes the real `getOidcClientById` in, this
 * file never imports it directly. That keeps `./oidc-clients` — which
 * imports `pool` from `@workspace/db`, a module that throws at import time
 * without a live `DATABASE_URL` — out of this file's import graph
 * entirely (only the `OidcClient` *type* is imported, which TypeScript
 * erases at compile time and never touches at runtime). This is what lets
 * `scripts/src/test-oidc-logout-request.ts` exercise every branch of
 * `validateOidcLogoutRequest()` (unknown client, resolved client, hint/
 * client_id agreement, post_logout_redirect_uri matching) against an
 * in-memory client set, with no live `DATABASE_URL` and no DB test stub —
 * consistent with every other DB-adjacent pure-logic test in this roadmap
 * (see `scripts/src/test-oidc-clients.ts`'s own note on why DB-live
 * behavior, e.g. a duplicate `client_id`, is hand-verified there instead
 * of exercised against a real pool).
 */
export type OidcClientResolver = (clientId: string) => Promise<OidcClient | null>;

/** 6a-a total, pure: reads query-string values into `OidcLogoutRequestRaw`. Anything not a non-empty string is left `undefined` — this function cannot fail. */
export function parseOidcLogoutRequest(query: Record<string, unknown>): OidcLogoutRequestRaw {
  const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
  return {
    idTokenHint: str(query.id_token_hint),
    clientId: str(query.client_id),
    postLogoutRedirectUri: str(query.post_logout_redirect_uri),
    state: str(query.state),
  };
}

/** 6a-e: the one consistent success/failure shape for a logout request. `redirectable` is always `false` — see file header. */
export type OidcLogoutRequestValidationResult =
  | {
      ok: true;
      /** The resolved client, or `null` when the request carried neither a usable `id_token_hint` nor a `client_id` — a bare "just sign me out" hit, which 6b's session termination still honors. */
      client: OidcClient | null;
      /** Registered-and-verified, or `null` when none was supplied (or none could be safely validated) — `routes/oidc-logout.ts` only redirects the user-agent when this is non-null. */
      postLogoutRedirectUri: string | null;
      /** Echoed back verbatim alongside a redirect, RP-Initiated Logout 1.0 §3's own `state` behavior — never itself validated, same as `/oidc/authorize`'s `state` handling (Phase 3a). */
      state: string | undefined;
      /** The verified hint's `sub`, if a hint was supplied and verified — informational only; 6b resolves the SESSION to terminate from the caller's own cookie/bearer token, never from this. */
      hintUserId: string | null;
    }
  | { ok: false; error: "invalid_request" | "invalid_client" | "invalid_post_logout_redirect_uri"; redirectable: false };

/**
 * 6a-b/6a-c/6a-d composed: validates a parsed logout request, resolving and
 * cross-checking a client and (if present) a `post_logout_redirect_uri`
 * against it.
 *
 * `verifyHint` and `resolveClient` are both injected (see
 * `IdTokenHintVerifier`/`OidcClientResolver` above) rather than imported
 * directly — the two effectful boundaries (crypto, DB) in an otherwise
 * pure function, factored out for unit-testability. `routes/oidc-logout.ts`
 * passes the real `verifyIdTokenHint`/`getOidcClientById` for both; a test
 * passes fakes for both.
 */
export async function validateOidcLogoutRequest(
  raw: OidcLogoutRequestRaw,
  verifyHint: IdTokenHintVerifier,
  resolveClient: OidcClientResolver,
): Promise<OidcLogoutRequestValidationResult> {
  // 6a-b — id_token_hint. A HINT THAT WAS SUPPLIED BUT DOES NOT VERIFY is
  // rejected outright (invalid_request) rather than silently ignored: a
  // caller presenting a malformed/forged/foreign-issuer token as proof of
  // "which login this is" gets no benefit of the doubt just because
  // dropping it would let the request continue some other way. A hint
  // that was never supplied at all is fine — id_token_hint is RECOMMENDED,
  // not REQUIRED (RP-Initiated Logout 1.0 §2).
  let hint: VerifiedLogoutHint | null = null;
  if (raw.idTokenHint !== undefined) {
    hint = verifyHint(raw.idTokenHint);
    if (!hint) {
      logger.warn({}, "[oidc-logout-request] id_token_hint present but failed verification, rejected");
      return { ok: false, error: "invalid_request", redirectable: false };
    }
  }

  // 6a-c — Client Resolution. Prefer the hint's own aud (already
  // signature-verified above); fall back to the bare client_id param.
  // If both are present they must agree — see file header.
  let resolvedClientId: string | null = null;
  if (hint && raw.clientId !== undefined && hint.aud !== raw.clientId) {
    logger.warn(
      { hintAud: hint.aud, clientId: raw.clientId },
      "[oidc-logout-request] id_token_hint aud and client_id disagree, rejected",
    );
    return { ok: false, error: "invalid_request", redirectable: false };
  }
  resolvedClientId = hint?.aud ?? raw.clientId ?? null;

  let client: OidcClient | null = null;
  if (resolvedClientId !== null) {
    client = await resolveClient(resolvedClientId);
    if (!client) {
      logger.warn({ clientId: resolvedClientId }, "[oidc-logout-request] unresolvable client_id, rejected");
      return { ok: false, error: "invalid_client", redirectable: false };
    }
  }

  // 6a-d — post_logout_redirect_uri. Requires an already-resolved client
  // to validate against; a redirect target can never be honored for a
  // client this endpoint couldn't identify (same "never trust a
  // user-supplied redirect destination" rule as Phase 2C's redirect_uri
  // check — see lib/oidc-client-validation.ts's own header).
  let postLogoutRedirectUri: string | null = null;
  if (raw.postLogoutRedirectUri !== undefined) {
    if (!client) {
      logger.warn(
        {},
        "[oidc-logout-request] post_logout_redirect_uri supplied with no resolvable client, rejected",
      );
      return { ok: false, error: "invalid_request", redirectable: false };
    }
    const redirectResult = validateOidcPostLogoutRedirectUri(client, raw.postLogoutRedirectUri);
    if (!redirectResult.ok) {
      return { ok: false, error: redirectResult.error, redirectable: false };
    }
    postLogoutRedirectUri = redirectResult.postLogoutRedirectUri;
  }

  return {
    ok: true,
    client,
    postLogoutRedirectUri,
    state: raw.state,
    hintUserId: hint?.sub ?? null,
  };
}
