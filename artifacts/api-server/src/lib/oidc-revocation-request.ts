/**
 * lib/oidc-revocation-request.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 5, Phase 10b: Revocation Endpoint (RFC
 * 7009-scoped-down) — request parsing half.
 *
 * Same "lib parses, route decides" split every earlier endpoint in this
 * roadmap already uses, and the closest possible sibling to
 * `lib/oidc-introspection-request.ts` (10a) — RFC 7009 §2.1's request
 * body is, field-for-field, the same shape RFC 7662 §2.1's already is:
 *   - `token` (required — the token to revoke)
 *   - `token_type_hint` (optional — `"access_token"` | `"refresh_token"`,
 *     an ORDERING preference only, same "MAY ignore this parameter"
 *     posture RFC 7009 §2.1 states in the identical words RFC 7662 §2.1
 *     already uses for its own hint — so, same as
 *     `parseOidcIntrospectionRequest()`, no enum validation here)
 *   - `client_id` / `client_secret` — RFC 7009 §2.1's own client
 *     authentication fields, the identical POST-body form (never an
 *     `Authorization` header) `lib/oidc-token-client-auth.ts` already
 *     checks for `/oidc/token` and `/oidc/introspect` alike. `routes/
 *     oidc-revoke.ts` feeds these straight into
 *     `authenticateOidcTokenClient()` unchanged — this file adds no
 *     second client-auth implementation.
 *
 * A SEPARATE FILE, NOT `oidc-introspection-request.ts` REUSED — same "one
 * small parsing file per endpoint, not a shared body-shape module"
 * precedent every other request-parsing pair in this roadmap already
 * follows (`oidc-authorize-request.ts`, `oidc-token-request.ts`,
 * `oidc-introspection-request.ts` itself) — the two RFCs happening to
 * share an identical field set today is not a reason to couple two
 * different endpoints' request types to one type declaration that would
 * have to be renamed or split the moment either RFC's body actually
 * diverges.
 *
 * Scope discipline (this is 10b's OWN parsing step, not 10b's
 * revocation-mutation step):
 *   - No token verification, no DB lookup/write, no client authentication
 *     — see `lib/oidc-token-revocation.ts` (the revoke half) and
 *     `lib/oidc-token-client-auth.ts` (client auth, reused as-is) for
 *     those. This file only gets fields out of the request body into a
 *     typed, normalized shape.
 *
 * BODY SOURCE: `application/x-www-form-urlencoded`
 * RFC 7009 §2.1 specifies the same content type RFC 7662 §2.1 (and RFC
 * 6749 §4.1.3's token endpoint) already require — `app.ts`'s global
 * `express.urlencoded(...)` mount already covers this route too, so
 * `parseOidcRevocationRequest()` stays middleware-agnostic
 * (`Record<string, unknown>` in, typed object out), identical to
 * `parseOidcIntrospectionRequest()`'s own posture.
 */

/** 10b: the request shape after parsing, before any validation. Every field is `string | undefined` — absent, not defaulted to `""` or `null` — so a later "is this required field missing" check (`routes/oidc-revoke.ts`) can use plain truthiness, same convention `RawOidcIntrospectionRequest` already established. */
export interface RawOidcRevocationRequest {
  token: string | undefined;
  tokenTypeHint: string | undefined;
  clientId: string | undefined;
  clientSecret: string | undefined;
}

/**
 * Same parameter-pollution defense `parseOidcIntrospectionRequest()`'s own
 * `firstBodyValue()` uses, duplicated here rather than imported — the
 * identical "one small pure helper per parsing file, not a shared utility
 * module" precedent this file's own header already explains for why it
 * isn't just importing that sibling file's type instead.
 */
function firstBodyValue(value: unknown): string | undefined {
  if (typeof value === "string") return value.length > 0 ? value : undefined;
  if (Array.isArray(value)) return firstBodyValue(value[0]);
  return undefined;
}

/** 10b: `POST /oidc/revoke` body -> `RawOidcRevocationRequest`. Pure, DB-free, never throws — same guarantee `parseOidcIntrospectionRequest()` makes for its own endpoint. */
export function parseOidcRevocationRequest(body: Record<string, unknown>): RawOidcRevocationRequest {
  return {
    token: firstBodyValue(body.token),
    tokenTypeHint: firstBodyValue(body.token_type_hint),
    clientId: firstBodyValue(body.client_id),
    clientSecret: firstBodyValue(body.client_secret),
  };
}
