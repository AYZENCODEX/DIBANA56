/**
 * lib/oidc-token-request.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 2, Phase 3c-a: Token Request Parser, and 3c-g: Token
 * Error Model (the shared type only — response HTTP shaping stays in
 * `routes/oidc-token.ts`, same split `oidc-authorize-request.ts`/
 * `oidc-authorize.ts` used between "define the error union" and "render it
 * as an HTTP response").
 *
 * Scope discipline (this is 3c-a/3c-g, not 3c-b..3c-f):
 *   - Parsing only — does not look up the client, the code, or verify
 *     anything. `RawOidcTokenRequest`'s fields are exactly what RFC 6749
 *     §4.1.3 defines for an authorization_code grant request
 *     (`grant_type`, `code`, `redirect_uri`, `client_id`) plus the two this
 *     roadmap layers on top of it: `client_secret` (RFC 6749 §3.2.1,
 *     confidential-client auth — 3c-b) and `code_verifier` (RFC 7636 §4.5,
 *     PKCE — 3d-a). Reading/checking any of those five is a later
 *     sub-phase's job; this file only gets them out of the request body
 *     into a typed, normalized shape.
 *   - No unsupported_grant_type/invalid_request DECISION logic — this file
 *     defines the vocabulary (`OidcTokenErrorCode`) those decisions are
 *     reported with, `routes/oidc-token.ts` is where they're actually made
 *     (parallel to how `oidc-client-validation.ts` defines
 *     `"invalid_client"`/`"invalid_redirect_uri"` but `oidc-authorize.ts`
 *     decides when each applies).
 *
 * BODY SOURCE: `application/x-www-form-urlencoded`
 * RFC 6749 §4.1.3 requires the token request body to be
 * `application/x-www-form-urlencoded` — this codebase's `app.ts` already
 * mounts `express.urlencoded({ extended: true, ... })` globally (ahead of
 * this route, alongside `express.json()` for every other endpoint), so
 * `req.body` arrives as a plain parsed object either way with no new
 * middleware needed. `parseOidcTokenRequest()` below is deliberately
 * middleware-agnostic (`Record<string, unknown>` in, typed object out) —
 * same shape `parseOidcAuthorizeRequest()` (3a-a) uses for `req.query` — so
 * it doesn't care which body parser produced that object.
 */

/** 3c-a: the request shape after parsing, before any validation. Every field is `string | undefined` — absent, not defaulted to `""` or `null`, so a later "is this required field missing" check (3c-b..3c-e, `routes/oidc-token.ts`) can use plain truthiness. */
export interface RawOidcTokenRequest {
  grantType: string | undefined;
  code: string | undefined;
  redirectUri: string | undefined;
  clientId: string | undefined;
  clientSecret: string | undefined;
  codeVerifier: string | undefined;
}

/**
 * Same parameter-pollution defense `parseOidcAuthorizeRequest()` (3a-a)
 * uses for query params, applied here to body fields instead: a urlencoded
 * body CAN repeat a key (`grant_type=a&grant_type=b`), which Express's
 * `qs`-based urlencoded parser turns into an array rather than a string.
 * Taking the first value (and normalizing an empty string to `undefined`,
 * same as 3a-a) means a repeated/empty field behaves like a well-formed
 * single value from every downstream check's point of view, never like a
 * different, un-anticipated JS type.
 */
function firstBodyValue(value: unknown): string | undefined {
  if (typeof value === "string") return value.length > 0 ? value : undefined;
  if (Array.isArray(value)) return firstBodyValue(value[0]);
  return undefined;
}

/** 3c-a: `POST /oidc/token` body -> `RawOidcTokenRequest`. Pure, DB-free, never throws — same guarantee `parseOidcAuthorizeRequest()` (3a-a) makes for query parsing. */
export function parseOidcTokenRequest(body: Record<string, unknown>): RawOidcTokenRequest {
  return {
    grantType: firstBodyValue(body.grant_type),
    code: firstBodyValue(body.code),
    redirectUri: firstBodyValue(body.redirect_uri),
    clientId: firstBodyValue(body.client_id),
    clientSecret: firstBodyValue(body.client_secret),
    codeVerifier: firstBodyValue(body.code_verifier),
  };
}

/**
 * 3c-g: Token Error Model — the roadmap's global error model (section 4)
 * narrowed to the five codes actually reachable from `/oidc/token`
 * (`unsupported_response_type` and `access_denied` are authorize-endpoint-
 * only concerns, Phase 3a/4 — a token request has no `response_type` and
 * nothing for a resource owner to interactively deny at this endpoint).
 */
export type OidcTokenErrorCode =
  | "invalid_request"
  | "invalid_client"
  | "invalid_grant"
  | "invalid_scope"
  | "unauthorized_client"
  | "unsupported_grant_type";

/** RFC 6749 §5.2's error response body shape — every failure branch in `routes/oidc-token.ts` produces exactly this, never a differently-shaped ad-hoc error object. */
export interface OidcTokenErrorBody {
  error: OidcTokenErrorCode;
}
