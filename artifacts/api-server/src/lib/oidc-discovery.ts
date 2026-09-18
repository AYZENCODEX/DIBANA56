/**
 * lib/oidc-discovery.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 1, Phase 1E-d: OIDC Configuration Object.
 *
 * Defines the discovery metadata document `/.well-known/openid-configuration`
 * will eventually serve (that HTTP endpoint is Phase 1E-e — explicitly NOT
 * built in this sub-phase, see roadmap: "Do not advertise endpoints that do
 * not exist yet").
 *
 * This file is intentionally separate from lib/jwt-keys.ts: that file owns
 * key MATERIAL (signing/verification/rotation/JWKS), this one owns provider
 * METADATA (issuer identity, supported capabilities, endpoint URLs) — a
 * different concern that Phase 3/4 will keep extending as more of the OIDC
 * surface (authorization endpoint, token endpoint, userinfo endpoint) ships.
 *
 * UPDATE — Season 3, Phase 5a-e (Discovery Integration)
 * `authorization_endpoint` / `token_endpoint` / `userinfo_endpoint` are now
 * published below. 1E-d's original text deferred them with "do not
 * advertise endpoints that do not exist yet" — that condition no longer
 * holds: `routes/oidc-authorize.ts` (Phase 3b), `routes/oidc-token.ts`
 * (Phase 3c/3d/3e), and `routes/oidc-userinfo.ts` (Phase 4c) all exist and
 * are mounted today. `lib/oidc-authorize-request.ts`'s own header already
 * flagged this exact gap as "left as a follow-up note in this phase's
 * CHANGES doc rather than acted on here" back when 3a shipped — 5a-e
 * (Sylo's own "Discovery Integration: load provider metadata" sub-phase)
 * is that follow-up: Sylo's `sylo-oidc-discovery.ts` needs a real
 * `authorization_endpoint`/`token_endpoint`/`userinfo_endpoint` to fetch
 * from this document, or "load provider metadata" would have nothing
 * useful to load.
 *
 * WHAT'S STILL DELIBERATELY NOT HERE
 *   - `token_endpoint_auth_methods_supported`, `grant_types_supported`,
 *     `claims_supported`, `code_challenge_methods_supported`, etc. — none
 *     of Sylo's config/discovery/login sub-phases (5a/5b) read any of
 *     these, and adding metadata fields nothing in this roadmap yet
 *     consumes is exactly the kind of speculative, ahead-of-need addition
 *     section 1.4 says not to do. `scopes_supported` is also left exactly
 *     as 1E-d set it (`["openid"]`) for the identical reason — expanding
 *     it to include "profile"/"email" was already named 1E-d's own
 *     explicit non-goal ("Phase 2's job... Phase 4's job"), and no
 *     sub-phase since has picked that up; Sylo's client config
 *     (`sylo-oidc-config.ts`) sources its own scope list directly from
 *     the client registry seed, not from this document, so nothing is
 *     blocked on it.
 * jwks_uri was already included (Phase 1E-c, routes/well-known-jwks.ts).
 *
 * UPDATE — Season 3, Phase 6a-a (end_session_endpoint)
 * `end_session_endpoint` is now published below, the same "the field
 * follows the endpoint's own existence" rule the 5a-e update above already
 * established for authorization_endpoint/token_endpoint/userinfo_endpoint:
 * `routes/oidc-logout.ts` (Phase 6a/6b) now exists and is mounted, so this
 * document advertises it. OIDC Discovery 1.0 itself doesn't define this
 * field — it's OpenID Connect RP-Initiated Logout 1.0 §3's own discovery
 * metadata addition, published here (not a separate document) since this
 * is already the one place this provider's endpoint URLs are assembled.
 *
 * UPDATE — Season 5, Phase 10e (Discovery Metadata)
 * `introspection_endpoint` / `revocation_endpoint` are now published
 * below — the identical "the field follows the endpoint's own existence"
 * rule every earlier update to this file has followed: `routes/
 * oidc-introspect.ts` (10a) and `routes/oidc-revoke.ts` (10b) both now
 * exist and are mounted, so this document advertises both. Neither field
 * is defined by OIDC Discovery 1.0 itself — `introspection_endpoint` is
 * RFC 8414 §2's own registered discovery metadata extension for RFC 7662,
 * `revocation_endpoint` is that same RFC 8414 §2's extension for RFC 7009
 * — published here rather than a separate document, same reasoning
 * `end_session_endpoint` above already gives. Both are DERIVED from
 * `issuer`, same as every other endpoint field in this document, so none
 * of the seven can ever independently drift from the issuer identity —
 * the same by-construction guarantee 1E-e's original acceptance criterion
 * already relies on for `jwks_uri`.
 *
 * `token_endpoint_auth_methods_supported` is still deliberately NOT added
 * here — this file's own "WHAT'S STILL DELIBERATELY NOT HERE" note above
 * already names it as unread by anything in this roadmap, and nothing
 * shipped since (10a/10b included) changes that: `lib/oidc-token-client-auth.ts`
 * is the ONE client-auth implementation `/oidc/token`, `/oidc/introspect`,
 * and `/oidc/revoke` all three already share, unconditionally — there is
 * no second method a relying party could discover and choose between, so
 * advertising a one-element `["client_secret_post"]` array would describe
 * a capability no caller of this document has any decision to make about.
 */

/** The provider metadata document this file can currently produce — a strict subset of the full OIDC Discovery 1.0 shape, growing as later phases ship the endpoints it describes. */
export interface OidcDiscoveryMetadata {
  issuer: string;
  jwks_uri: string;
  /** Phase 5a-e: `GET {issuer}/oidc/authorize` (routes/oidc-authorize.ts, Phase 3b) — the Authorization Code + PKCE entry point. */
  authorization_endpoint: string;
  /** Phase 5a-e: `POST {issuer}/oidc/token` (routes/oidc-token.ts, Phase 3c/3d/3e) — code-for-tokens exchange. */
  token_endpoint: string;
  /** Phase 5a-e: `GET {issuer}/oidc/userinfo` (routes/oidc-userinfo.ts, Phase 4c) — the bearer-token resource endpoint. */
  userinfo_endpoint: string;
  /** Phase 6a-a: `GET {issuer}/oidc/logout` (routes/oidc-logout.ts, Phase 6a/6b) — RP-Initiated Logout 1.0's `end_session_endpoint`. */
  end_session_endpoint: string;
  /** Phase 10e: `POST {issuer}/oidc/introspect` (routes/oidc-introspect.ts, Phase 10a) — RFC 8414 §2's discovery extension for RFC 7662. */
  introspection_endpoint: string;
  /** Phase 10e: `POST {issuer}/oidc/revoke` (routes/oidc-revoke.ts, Phase 10b) — RFC 8414 §2's discovery extension for RFC 7009. */
  revocation_endpoint: string;
  /** Only "code" — Authorization Code + PKCE (Phase 3) is the only flow this roadmap ever plans to support; implicit/hybrid are out of scope entirely, not just "not yet". */
  response_types_supported: string[];
  scopes_supported: string[];
  /** RS256 only — Phase 1a/1b's signing switch. HS256 is an internal migration-grace mechanism (ALLOW_LEGACY_HS256_TOKENS, lib/jwt-keys.ts) for pre-existing session tokens, never something an OIDC client should be told to expect or accept. */
  id_token_signing_alg_values_supported: string[];
}

/**
 * "openid" is the only scope Season 1 needs to declare — it's the one
 * mandatory-by-spec value, and the only one any currently-existing code
 * path (there is no token/userinfo endpoint yet) could honor. Additional
 * scopes (profile, email, ...) are Phase 2's job (client `allowed_scopes`
 * registry) and Phase 4's job (userinfo claims) to introduce — adding them
 * to this list before either exists would advertise a capability with
 * nothing behind it yet.
 */
const SCOPES_SUPPORTED = ["openid"] as const;

const RESPONSE_TYPES_SUPPORTED = ["code"] as const;

const ID_TOKEN_SIGNING_ALG_VALUES_SUPPORTED = ["RS256"] as const;

/**
 * Resolves the OIDC issuer identifier: the exact origin (scheme + host, no
 * trailing slash, no path) discovery clients will compare against the
 * `iss` claim of every token this provider issues later (Phase 3/4).
 *
 * `AYZEN_OIDC_ISSUER` is a dedicated override for when the OIDC issuer
 * needs to differ from the general app origin (e.g. a distinct
 * `account.ayzen.tech` identity host vs. wherever the app itself is
 * reachable) — falls back to the same `APP_URL` env var / production
 * default already used elsewhere in this codebase (lib/finance-invoice.ts)
 * so Season 1 doesn't require a new env var to be set just to exercise
 * this locally. Trailing slashes are stripped so callers can safely do
 * `${issuer}/.well-known/...` without a doubled `//`.
 */
export function resolveIssuer(): string {
  const explicit = process.env.AYZEN_OIDC_ISSUER?.trim();
  const raw = explicit && explicit.length > 0 ? explicit : (process.env.APP_URL ?? "https://ayzen.replit.app");
  return raw.replace(/\/+$/, "");
}

/**
 * Pure builder: issuer (string) -> discovery metadata. Takes `issuer` as a
 * parameter rather than reading the env itself so it's unit-testable
 * without env-var setup/teardown, same discipline as buildJwks() (1E-b)
 * taking its keys as a parameter instead of resolving them internally.
 *
 * `jwks_uri` is DERIVED from `issuer` (`${issuer}/.well-known/jwks.json`)
 * rather than independently configured, so the two can never drift apart —
 * directly satisfies 1E-e's later acceptance criterion ("issuer and
 * endpoint URLs are consistent") by construction, before that sub-phase
 * even starts.
 */
export function buildOidcDiscoveryMetadata(issuer: string): OidcDiscoveryMetadata {
  const cleanIssuer = issuer.replace(/\/+$/, "");
  return {
    issuer: cleanIssuer,
    jwks_uri: `${cleanIssuer}/.well-known/jwks.json`,
    // Phase 5a-e: derived from `issuer`, same as `jwks_uri` above, so none
    // of the four can ever independently drift from the issuer identity —
    // the same by-construction guarantee 1E-e's "issuer and endpoint URLs
    // are consistent" acceptance criterion already relies on for jwks_uri.
    authorization_endpoint: `${cleanIssuer}/oidc/authorize`,
    token_endpoint: `${cleanIssuer}/oidc/token`,
    userinfo_endpoint: `${cleanIssuer}/oidc/userinfo`,
    // Phase 6a-a: derived from `issuer`, same as the other three endpoints
    // above — none of the five can ever independently drift from the
    // issuer identity.
    end_session_endpoint: `${cleanIssuer}/oidc/logout`,
    // Phase 10e: derived from `issuer`, same as every endpoint field
    // above — none of the seven can ever independently drift from the
    // issuer identity.
    introspection_endpoint: `${cleanIssuer}/oidc/introspect`,
    revocation_endpoint: `${cleanIssuer}/oidc/revoke`,
    response_types_supported: [...RESPONSE_TYPES_SUPPORTED],
    scopes_supported: [...SCOPES_SUPPORTED],
    id_token_signing_alg_values_supported: [...ID_TOKEN_SIGNING_ALG_VALUES_SUPPORTED],
  };
}

/**
 * Convenience wrapper: resolves the issuer from the environment
 * (resolveIssuer()) and builds the metadata document from it. This is what
 * 1E-e's (not-yet-built) `/.well-known/openid-configuration` endpoint will
 * call — exported now so that sub-phase is a route handler wiring this up,
 * not new metadata-assembly logic.
 */
export function getOidcDiscoveryMetadata(): OidcDiscoveryMetadata {
  return buildOidcDiscoveryMetadata(resolveIssuer());
}
