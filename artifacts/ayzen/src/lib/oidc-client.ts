/**
 * oidc-client.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 3, Phase 5a-a: Client Library Setup.
 *
 * "Install/configure the existing OIDC client approach" — this file is
 * that installation. It is a GENERIC, reusable Authorization Code + PKCE
 * client toolkit: PKCE pair generation, `state` generation, an authorize
 * URL builder, and a token-exchange call. It knows nothing about Sylo,
 * AYZEN's central issuer, or any specific `client_id`/`redirect_uri` —
 * every one of those is a parameter, not a constant in this file. This is
 * deliberate: Sylo is the first of five first-party apps
 * (`seed-oidc-clients.ts`, Phase 2B: sylo/ryft/wisp/verve/zynth) that will
 * eventually go through this exact same client setup, the same
 * "add one more entry, nothing else in this file changes" shape
 * `subdomain-app.ts`'s own header already established for the subdomain
 * split.
 *
 * WHY HAND-ROLLED, NOT AN INSTALLED PACKAGE ("the EXISTING approach")
 * This codebase already has exactly one precedent for a browser-redirect
 * OAuth client: `lib/vault-backup-cloud.ts` (Google Drive / Dropbox
 * connect flow) — hand-rolled `fetch()` calls, no `openid-client`/
 * `oauth4webapi`/passport-family dependency anywhere in this monorepo's
 * `package.json` files. This file follows that same established house
 * approach rather than introducing a new third-party auth dependency,
 * adapted for what an OIDC PUBLIC client (see below) actually needs that
 * a confidential-client cloud-storage OAuth flow doesn't: PKCE, not a
 * client secret.
 *
 * PUBLIC CLIENT, PKCE-ONLY — NO SECRET, EVER
 * Every first-party AYZEN app (`seed-oidc-clients.ts`) is registered with
 * `client_secret_hash: null` — a public client. All five are the same
 * browser-served SPA bundle (`subdomain-app.ts`) scoped by hostname;
 * there is no server-side place to keep a confidential secret for any of
 * them, and section 3.2's PKCE requirement is that client type's proof of
 * possession instead (`lib/oidc-token-client-auth.ts`'s own header, the
 * provider side of this exact fact, already documents the identical
 * reasoning). `exchangeCodeForTokens()` below never sends a
 * `client_secret` — there is nothing to send.
 *
 * SCOPE DISCIPLINE (this is 5a-a, not 5a-b..5a-f or 5b)
 *   This file provides the MECHANISM — PKCE, state, URL-building,
 *   token exchange — generic over an `OidcClientConfig` /
 *   `OidcProviderMetadata` the CALLER supplies. It does not:
 *     - know Sylo's real issuer, client_id, or redirect_uri (5a-b/5a-c/
 *       5a-d — those sub-phases construct the actual `OidcClientConfig`
 *       value this file's functions will be called with);
 *     - fetch `/.well-known/openid-configuration` itself to populate an
 *       `OidcProviderMetadata` (5a-e, "Discovery Integration" — that
 *       sub-phase's job is producing the value this file's functions
 *       accept as a parameter, not fetching it from within this file);
 *     - render a login button, redirect the browser, define a callback
 *       route, persist `codeVerifier`/`state` across the redirect
 *       round-trip, or call any of this against a real value (all of
 *       that is Phase 5b, "Sylo Login Wiring" — 5b-a..5b-g).
 *   This file is imported by nothing yet, and imports nothing Sylo- or
 *   route-specific — it is pure, framework-agnostic client logic,
 *   independently testable (5a-f) before any of it is wired to a page.
 *
 * PKCE, CONCRETELY (RFC 7636)
 *   `code_verifier`: a high-entropy random string, base64url-encoded, no
 *   padding — RFC 7636 §4.1 allows 43-128 characters; 32 random bytes
 *   base64url-encodes to 43, the shortest RFC-compliant length, which is
 *   also what Auth0/Okta's own client SDKs default to.
 *   `code_challenge`: `BASE64URL(SHA256(code_verifier))`, the `"S256"`
 *   method (RFC 7636 §4.2) — the only method this provider's own PKCE
 *   enforcement (`lib/oidc-pkce.ts`, Phase 3d) accepts; `"plain"` is
 *   never offered here.
 *   Uses the browser's native Web Crypto API (`crypto.getRandomValues`,
 *   `crypto.subtle.digest`) — available in every environment this SPA
 *   already targets, no polyfill/dependency needed.
 */

/** Everything this library needs to know about ONE first-party app's OIDC client registration. Supplied by the caller (Phase 5a-b/5a-c/5a-d for Sylo) — never hardcoded here. */
export interface OidcClientConfig {
  /** This provider's issuer identity — must match `resolveIssuer()` (Phase 1e-d) exactly, including scheme and trailing-slash conventions. */
  issuer: string;
  /** The registered `client_id` (`oidc_clients.client_id`, e.g. `"sylo"` — `seed-oidc-clients.ts`, Phase 2B). */
  clientId: string;
  /** Must exactly match one of this client's registered `redirect_uris` (section 3.1: "exact matching; no wildcard redirect URI") — the provider's `/oidc/authorize` rejects anything else. */
  redirectUri: string;
  /** Space-joined into the `scope` parameter on the wire — see `buildAuthorizeUrl()`. `["openid", "profile", "email"]` for every currently-seeded first-party app. */
  scopes: string[];
}

/**
 * The subset of `/.well-known/openid-configuration`'s response
 * (Phase 1e-d/1e-e) this library actually consumes. Intentionally a
 * NARROW type, not every field that endpoint publishes — this library
 * only ever needs these four URLs; a caller with `fetchProviderMetadata()`
 * (Phase 5a-e, not built here) can pass the full discovery response
 * straight in, since a wider object satisfies this narrower shape.
 */
export interface OidcProviderMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
}

/** RFC 7636 PKCE pair — generated fresh for every login attempt, never reused across attempts. */
export interface PkcePair {
  /** Kept client-side only (never sent at the `/oidc/authorize` step) until the token exchange — see file header. */
  codeVerifier: string;
  /** Sent at the `/oidc/authorize` step; never a secret on its own (RFC 7636 §5). */
  codeChallenge: string;
}

/** The token endpoint's success response shape — matches exactly what `routes/oidc-token.ts` (Phase 3c/4a/4b/3e-c) returns on the provider side. */
export interface OidcTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
  /** Present only when `"openid"` was among the redeemed code's scopes (OIDC Core §3.1.3.3) — see `routes/oidc-token.ts`'s own header. */
  id_token?: string;
  /** Present only when refresh-token persistence succeeded (Phase 3e-c's "baseline", not a full refresh grant yet). */
  refresh_token?: string;
}

/** The token endpoint's OAuth-error response shape (section 4's global error model). */
export interface OidcTokenErrorResponse {
  error: string;
  error_description?: string;
}

/**
 * Base64url encoding (RFC 4648 §5, no padding) of an `ArrayBuffer` — the
 * one encoding PKCE (RFC 7636 §4.1/§4.2) requires everywhere, built on
 * `btoa()` rather than a dependency: standard base64 first, then the
 * three-character swap RFC 4648 §5 defines relative to standard base64.
 */
function base64UrlEncode(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** `byteLength` cryptographically-random bytes (`crypto.getRandomValues` — never `Math.random()`), base64url-encoded. */
function randomUrlSafeString(byteLength: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return base64UrlEncode(bytes.buffer);
}

/**
 * Generates one fresh PKCE pair (RFC 7636). `code_verifier` is 32 random
 * bytes (43 base64url characters — the shortest RFC-compliant length);
 * `code_challenge` is its SHA-256 digest, base64url-encoded, per the
 * `"S256"` method (the only method `code_challenge_method` this library
 * ever sends — see file header for why never `"plain"`).
 */
export async function generatePkcePair(): Promise<PkcePair> {
  const codeVerifier = randomUrlSafeString(32);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier));
  return { codeVerifier, codeChallenge: base64UrlEncode(digest) };
}

/**
 * Generates one fresh `state` value (RFC 6749 §10.12 CSRF protection) —
 * 16 random bytes, base64url-encoded. Deliberately just an opaque random
 * token here, NOT a signed JWT the way `vault-backup-cloud.ts`'s
 * `signOAuthState()` is: that file's state needs to survive being handed
 * to and echoed back BY a third-party provider (Google/Dropbox) across a
 * server-side redirect with no client-side storage in between, so it
 * carries its own tamper-proofing. This library's `state` instead lives
 * entirely within the caller's own control (persisted client-side across
 * the redirect — Phase 5b's job) and is compared for exact equality on
 * return (5b-c, "State Verification") — an opaque random value is
 * sufficient, and involves no signing key/dependency this purely
 * client-side library would otherwise need.
 */
export function generateState(): string {
  return randomUrlSafeString(16);
}

/**
 * Builds the `/oidc/authorize` redirect URL (RFC 6749 §4.1.1 + OIDC Core
 * §3.1.2.1 + RFC 7636 §4.3): `response_type=code`, this client's
 * `client_id`/`redirect_uri`, space-joined `scope`, the caller-supplied
 * `state`, `code_challenge`/`code_challenge_method=S256`, and — when
 * `"openid"` is among `config.scopes` and the caller supplies one — OIDC
 * Core's optional `nonce` (carried through to the ID token by Phase 4b).
 * Pure URL construction — does not itself navigate the browser (5b-a).
 */
export function buildAuthorizeUrl(
  config: OidcClientConfig,
  metadata: Pick<OidcProviderMetadata, "authorization_endpoint">,
  codeChallenge: string,
  state: string,
  nonce?: string,
): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    scope: config.scopes.join(" "),
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });
  if (nonce) params.set("nonce", nonce);
  return `${metadata.authorization_endpoint}?${params.toString()}`;
}

/**
 * Redeems an authorization `code` at the token endpoint (RFC 6749 §4.1.3
 * + RFC 7636 §4.5). `POST`, form-encoded, exactly the shape
 * `routes/oidc-token.ts` (3c-a) parses. No `client_secret` — see file
 * header ("PUBLIC CLIENT, PKCE-ONLY"); `code_verifier` is this client's
 * proof of possession instead.
 *
 * Throws on any non-2xx response or an OAuth `{ error, error_description? }`
 * body, with a message built from `error_description` when the provider
 * sent one — same "surface the provider's own reason, don't invent a
 * generic one" precedent `vault-backup-cloud.ts`'s own
 * `exchangeGoogleCode()`/`exchangeDropboxCode()` already use for the
 * identical failure case.
 */
export async function exchangeCodeForTokens(
  config: OidcClientConfig,
  metadata: Pick<OidcProviderMetadata, "token_endpoint">,
  code: string,
  codeVerifier: string,
): Promise<OidcTokenResponse> {
  const res = await fetch(metadata.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: config.redirectUri,
      client_id: config.clientId,
      code_verifier: codeVerifier,
    }),
  });

  const data = (await res.json()) as OidcTokenResponse | OidcTokenErrorResponse;
  if (!res.ok || "error" in data) {
    const err = data as OidcTokenErrorResponse;
    throw new Error(err.error_description ?? err.error ?? "OIDC token exchange failed");
  }
  return data as OidcTokenResponse;
}
