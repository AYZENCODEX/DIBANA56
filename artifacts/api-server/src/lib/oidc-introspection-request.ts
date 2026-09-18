/**
 * lib/oidc-introspection-request.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 5, Phase 10a: Introspection Endpoint (RFC
 * 7662-scoped-down) — request parsing half.
 *
 * Same "lib parses, route decides" split every earlier endpoint in this
 * roadmap already uses (`oidc-authorize-request.ts` / `oidc-authorize.ts`,
 * `oidc-token-request.ts` / `oidc-token.ts`). This file's `RawOidcIntrospectionRequest`
 * is exactly RFC 7662 §2.1's request body, scoped down to the fields this
 * provider actually reads:
 *   - `token` (required by the RFC — the token to introspect)
 *   - `token_type_hint` (optional — `"access_token"` | `"refresh_token"`,
 *     used to pick which lookup to try first; RFC 7662 §2.1 itself says a
 *     server "MAY ignore this parameter", not that it must reject an
 *     unrecognized value — so this file does no enum validation of its
 *     own, same "typed shape now, decide what's legal later" split
 *     `parseOidcTokenRequest()` already draws for `grant_type`)
 *   - `client_id` / `client_secret` — RFC 7662 §2.1's own client
 *     authentication fields, identical shape to `/oidc/token`'s (RFC 6749
 *     §3.2.1 confidential-client auth, POST-body form, never an
 *     `Authorization` header — this provider only ever accepts the one
 *     form `lib/oidc-token-client-auth.ts` already checks). `routes/oidc-introspect.ts`
 *     feeds these straight into `authenticateOidcTokenClient()` (Phase
 *     3c-b) unchanged — this file adds no second client-auth
 *     implementation.
 *
 * Scope discipline (this is 10a's OWN parsing step, not 10a's lookup/
 * response-building step):
 *   - No token verification, no DB lookup, no client authentication — see
 *     `lib/oidc-token-introspection.ts` (the lookup/classification half)
 *     and `lib/oidc-token-client-auth.ts` (client auth, reused as-is) for
 *     those. This file only gets fields out of the request body into a
 *     typed, normalized shape, exactly `parseOidcTokenRequest()`'s own
 *     job description for its endpoint.
 *
 * BODY SOURCE: `application/x-www-form-urlencoded`
 * RFC 7662 §2.1 specifies the same content type RFC 6749 §4.1.3 requires
 * for the token endpoint — `app.ts`'s global `express.urlencoded(...)`
 * mount already covers this route too, so `parseOidcIntrospectionRequest()`
 * stays middleware-agnostic (`Record<string, unknown>` in, typed object
 * out) for the identical reason `parseOidcTokenRequest()`'s own header
 * gives.
 */

/** 10a: the request shape after parsing, before any validation. Every field is `string | undefined` — absent, not defaulted to `""` or `null` — so a later "is this required field missing" check (`routes/oidc-introspect.ts`) can use plain truthiness, same convention `RawOidcTokenRequest` already established. */
export interface RawOidcIntrospectionRequest {
  token: string | undefined;
  tokenTypeHint: string | undefined;
  clientId: string | undefined;
  clientSecret: string | undefined;
}

/**
 * Same parameter-pollution defense `parseOidcTokenRequest()`'s own
 * `firstBodyValue()` uses, duplicated here rather than imported — the
 * identical "one small pure helper per parsing file, not a shared utility
 * module" precedent that file's sibling parsers (`oidc-authorize-request.ts`)
 * already set, so this file has no import dependency on a route it isn't
 * otherwise related to.
 */
function firstBodyValue(value: unknown): string | undefined {
  if (typeof value === "string") return value.length > 0 ? value : undefined;
  if (Array.isArray(value)) return firstBodyValue(value[0]);
  return undefined;
}

/** 10a: `POST /oidc/introspect` body -> `RawOidcIntrospectionRequest`. Pure, DB-free, never throws — same guarantee `parseOidcTokenRequest()` makes for its own endpoint. */
export function parseOidcIntrospectionRequest(body: Record<string, unknown>): RawOidcIntrospectionRequest {
  return {
    token: firstBodyValue(body.token),
    tokenTypeHint: firstBodyValue(body.token_type_hint),
    clientId: firstBodyValue(body.client_id),
    clientSecret: firstBodyValue(body.client_secret),
  };
}
