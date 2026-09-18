/**
 * lib/sylo-oidc-discovery.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 3, Phase 5a-e: Discovery Integration.
 *
 * "Load provider metadata" — fetches `/.well-known/openid-configuration`
 * (Phase 1E-e, `routes/well-known-openid-configuration.ts`) from this
 * bundle's configured issuer (`resolveSyloOidcIssuer()`, 5a-b,
 * `sylo-oidc-config.ts`) and narrows the response down to the
 * `OidcProviderMetadata` shape `oidc-client.ts` (5a-a) actually consumes:
 * `issuer` / `authorization_endpoint` / `token_endpoint` /
 * `userinfo_endpoint`. The full discovery document has more fields than
 * that (`scopes_supported`, `response_types_supported`, ...,
 * `lib/oidc-discovery.ts` on the provider side) — this file only reads
 * the four this SPA's client library needs, the same "narrow type, wider
 * object satisfies it" relationship `oidc-client.ts`'s own
 * `OidcProviderMetadata` doc comment already describes.
 *
 * WHY THIS COULDN'T BE BUILT BEFORE NOW
 * The provider's discovery document didn't publish
 * `authorization_endpoint`/`token_endpoint`/`userinfo_endpoint` until this
 * same pass updated `lib/oidc-discovery.ts` (provider side) to add them —
 * seeing them appear there is what makes "load provider metadata" have
 * something real to load, per that file's own updated header.
 *
 * CACHED, NOT REFETCHED PER CALL
 * Both `startSyloOidcLogin()` (5b-a) and the callback page (5b-b) need
 * this document, and 1E-e's own `Cache-Control: public, max-age=3600`
 * already tells any well-behaved client the value is good for an hour —
 * fetching it fresh on every call would ignore that and add latency to
 * both the login redirect and the callback round-trip for no benefit.
 * A single in-flight/resolved promise is cached per issuer (module-level
 * `Map`, not just one bare variable) so concurrent callers within the
 * same page load share one network request, and a value already resolved
 * this page-load is returned synchronously via the cached promise rather
 * than re-fetched. There is deliberately no TTL/expiry logic beyond that:
 * this is an SPA — a full page load/navigation already clears the cache
 * (module state doesn't survive one), and 1E-d's own reasoning is that
 * this document "only changes on a code deploy", which a page reload
 * already picks up.
 *
 * SCOPE DISCIPLINE (this is 5a-e, not 5a-a..5a-d or 5b)
 *   - Does not know how to build an `OidcClientConfig` (5a-b/c/d,
 *     `sylo-oidc-config.ts`) — takes the resolved issuer as an input to
 *     the URL it fetches, not a second, independently-configured issuer.
 *   - Does not redirect the browser, generate PKCE/state, or exchange a
 *     code — that is Phase 5b, and it consumes
 *     `getSyloOidcProviderMetadata()` as an already-built dependency the
 *     same way `test-sylo-oidc-client-library.ts`'s literal `metadata`
 *     object stands in for it in 5a-a's own tests.
 */
import { resolveSyloOidcIssuer, type ResolveSyloOidcIssuerOverrides } from "./sylo-oidc-config";
import type { OidcProviderMetadata } from "./oidc-client";

/** Per-issuer cache of the in-flight/resolved metadata fetch — see file header ("CACHED, NOT REFETCHED PER CALL"). Keyed by issuer so a test/dev environment that resolves a different issuer never serves another issuer's cached document. */
const metadataCache = new Map<string, Promise<OidcProviderMetadata>>();

/**
 * 5a-e: fetches and validates the discovery document at
 * `{issuer}/.well-known/openid-configuration`, narrowing it to the four
 * fields `OidcProviderMetadata` requires. Pure with respect to module
 * state — takes `issuer` as a parameter and does no caching itself — so
 * it's unit-testable the same "inject the effectful boundary" way every
 * other 5a/5b file in this roadmap already is; `getSyloOidcProviderMetadata()`
 * below is the cached, env-resolving convenience wrapper production code
 * actually calls.
 *
 * Throws (never returns a partial/malformed document) when the response
 * isn't `ok`, isn't valid JSON, or is missing any of the four required
 * string fields — a caller with an incomplete provider metadata document
 * has no safe fallback to build an authorize URL or exchange a code with.
 */
export async function fetchSyloOidcProviderMetadata(issuer: string): Promise<OidcProviderMetadata> {
  const cleanIssuer = issuer.replace(/\/+$/, "");
  const discoveryUrl = `${cleanIssuer}/.well-known/openid-configuration`;

  const res = await fetch(discoveryUrl);
  if (!res.ok) {
    throw new Error(`Could not load OIDC provider metadata (${res.status} from ${discoveryUrl})`);
  }

  const data = await res.json().catch(() => null);
  const requiredFields: (keyof OidcProviderMetadata)[] = [
    "issuer",
    "authorization_endpoint",
    "token_endpoint",
    "userinfo_endpoint",
  ];
  const missing = requiredFields.filter((field) => typeof data?.[field] !== "string" || !data[field]);
  if (missing.length > 0) {
    throw new Error(`OIDC provider metadata from ${discoveryUrl} is missing: ${missing.join(", ")}`);
  }

  return {
    issuer: data.issuer,
    authorization_endpoint: data.authorization_endpoint,
    token_endpoint: data.token_endpoint,
    userinfo_endpoint: data.userinfo_endpoint,
  };
}

/**
 * 5a-e, composed: resolves this bundle's issuer the same way
 * `getSyloOidcClientConfig()` (5a-b/c/d) does, then fetches (or returns
 * the already-cached fetch of) that issuer's provider metadata. This is
 * what `startSyloOidcLogin()` (5b-a) and the callback page (5b-b) both
 * call — see file header for why the result is cached per issuer rather
 * than fetched fresh on every call.
 *
 * `overrides` is threaded straight through to `resolveSyloOidcIssuer()`
 * for the identical reason `getSyloOidcClientConfig()` accepts the same
 * parameter: 5a-f's tests need to exercise a specific issuer without a
 * real Vite/browser environment, without this function gaining a second,
 * divergent way to resolve one.
 */
export function getSyloOidcProviderMetadata(overrides?: ResolveSyloOidcIssuerOverrides): Promise<OidcProviderMetadata> {
  const issuer = resolveSyloOidcIssuer(overrides);
  const cached = metadataCache.get(issuer);
  if (cached) return cached;

  const pending = fetchSyloOidcProviderMetadata(issuer).catch((err) => {
    // A failed fetch must not poison the cache — the next call (e.g. the
    // "Try again" button on the callback page's error state,
    // oidc-callback.tsx 5b-f) should get a fresh attempt, not a
    // permanently-rejected cached promise.
    metadataCache.delete(issuer);
    throw err;
  });
  metadataCache.set(issuer, pending);
  return pending;
}

/** Test-only escape hatch: clears the module-level cache so 5a-f's tests (and any other test importing this module) start from a clean slate instead of leaking a resolved/rejected promise across test cases. Never called from production code. */
export function __resetSyloOidcProviderMetadataCacheForTests(): void {
  metadataCache.clear();
}
