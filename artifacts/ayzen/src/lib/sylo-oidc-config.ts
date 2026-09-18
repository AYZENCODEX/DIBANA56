/**
 * lib/sylo-oidc-config.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 3, Phase 5a-b/5a-c/5a-d: Issuer / Client ID /
 * Redirect URI Configuration.
 *
 * This is the file `oidc-client.ts`'s own header predicted: "5a-b/5a-c/
 * 5a-d — those sub-phases construct the actual OidcClientConfig value this
 * file's functions will be called with." Nothing here re-implements PKCE,
 * URL-building, or token exchange — it only assembles the four values
 * `OidcClientConfig` needs, each sourced from the one place that already
 * owns it:
 *
 *   issuer       -> resolved the same override-then-fallback way the
 *                   backend's own `resolveIssuer()` (lib/oidc-discovery.ts)
 *                   does, so a frontend bundle never has to be told a
 *                   second, independently-configured issuer value that
 *                   could drift from the one the provider itself signs
 *                   tokens with.
 *   clientId     -> `getCurrentSubdomainApp()` (lib/subdomain-app.ts) — the
 *                   SAME hostname-detection Phase 2 of the subdomain split
 *                   already uses to know "this bundle is running as Sylo"
 *                   at all. `seed-oidc-clients.ts` registered a client row
 *                   with this exact id (Phase 2B), so no second id needs
 *                   inventing here.
 *   redirectUri  -> `${window.location.origin}/oidc/callback` — the exact
 *                   shape `seed-oidc-clients.ts`'s own
 *                   `productionCallbackUrl()` registered
 *                   (`https://sylo.ayzen.tech/oidc/callback`), derived
 *                   from the ACTUAL origin this bundle is running on
 *                   instead of a hardcoded hostname, so the same code
 *                   automatically produces the right value for whichever
 *                   first-party app it's compiled into later (Ryft, Wisp,
 *                   Verve, Zynth) without editing this file again — same
 *                   "add one more entry, nothing else changes" property
 *                   `subdomain-app.ts`'s own header calls out.
 *   scopes       -> `["openid", "profile", "email"]`, matching
 *                   `AYZEN_FIRST_PARTY_SCOPES` in `seed-oidc-clients.ts`
 *                   exactly — sending a wider scope set than the client is
 *                   registered for would just get trimmed/rejected by
 *                   Phase 2's scope validation for no benefit.
 *
 * SCOPE DISCIPLINE (this is 5a-b/c/d, not 5a-e/5a-f or 5b)
 *   - Does not fetch `/.well-known/openid-configuration` — that is 5a-e's
 *     job (`sylo-oidc-discovery.ts`). This file's only concern is the
 *     CLIENT's own registration shape, not the PROVIDER's published
 *     metadata.
 *   - Does not redirect the browser, generate PKCE/state, or exchange a
 *     code — that is Phase 5b, and it consumes `getSyloOidcClientConfig()`
 *     as an already-built input, exactly the way
 *     `test-sylo-oidc-client-library.ts`'s `CONFIG` constant stands in for
 *     it today.
 *
 * WHY NOT JUST HARDCODE `client_id: "sylo"` HERE
 * This file is scoped to Sylo (5a-c: "Use registered Sylo client"), but it
 * reads the id from `getCurrentSubdomainApp()` rather than the literal
 * string `"sylo"` for the same reason `subdomain-app.ts` itself is a
 * lookup table keyed by hostname rather than a single hardcoded app: the
 * moment this exact bundle is what Ryft/Wisp/Verve/Zynth run as their own
 * `<id>.ayzen.tech` deployment (subdomain-app.ts's own stated future),
 * this file needs zero changes to keep producing the correct client_id
 * for whichever one it's actually running as. It still defaults to
 * `"sylo"` — this phase's actual, only subject — when no subdomain is
 * detected (e.g. a unit test environment with no `window`), so it never
 * silently produces a `client_id` for the wrong app in an environment
 * `getCurrentSubdomainApp()` can't read a hostname from.
 */
import { getCurrentSubdomainApp } from "./subdomain-app";
import { getApiBase } from "./api-base";
import type { OidcClientConfig } from "./oidc-client";

/** 5a-c: the only client id this phase is scoped to — see file header for why it's a fallback, not the primary source. */
export const SYLO_OIDC_CLIENT_ID = "sylo";

/**
 * The main AYZEN app's own first-party client id (`seed-oidc-clients.ts`'s
 * `workspace` entry) — used when this bundle is running on the main domain
 * itself (no subdomain app detected), so the "Login with AYZEN" button on
 * `login.tsx` round-trips through this same provider bound to a client
 * that's actually registered for the main domain's own origin, not Sylo's.
 */
export const WORKSPACE_OIDC_CLIENT_ID = "workspace";

/** 5a-d: the exact path `seed-oidc-clients.ts`'s registered redirect URIs end in — kept as one constant so the config builder and the SPA route registered in App.tsx (Phase 5b-b) can never drift apart. */
export const SYLO_OIDC_CALLBACK_PATH = "/oidc/callback";

/** 5a-b: the scope set every first-party AYZEN client is registered with (`AYZEN_FIRST_PARTY_SCOPES`, seed-oidc-clients.ts) — kept in sync manually since the frontend has no access to that backend-only module. */
export const SYLO_OIDC_SCOPES = ["openid", "profile", "email"];

/**
 * `import.meta.env` is a Vite build-time construct — it doesn't exist at
 * all when this module is loaded outside a Vite bundle (e.g. `npx tsx
 * scripts/src/test-sylo-oidc-config-and-discovery.ts`, 5a-f's own test
 * runner, the same plain-Node execution every other `test-oidc-*.ts` file
 * in this roadmap uses). Optional-chained here so resolving the issuer
 * degenerates to "no explicit override" in that environment instead of
 * throwing — the exact same behavior a real Vite build gets when the env
 * var is simply unset, so this adds a test-friendly fallback without
 * changing production behavior at all.
 */
function readViteEnvVar(key: string): string | undefined {
  return (import.meta as { env?: Record<string, string | undefined> })?.env?.[key];
}

/** Everything 5a-f's tests can override to exercise `resolveSyloOidcIssuer()`'s branches without a real Vite/browser environment — see `readViteEnvVar()`'s own comment for why `apiBase`/`explicitIssuer` specifically need to be injectable rather than read live. Never used outside tests; the zero-argument call in production code paths (`getSyloOidcClientConfig()` below) always resolves every value for real. */
export interface ResolveSyloOidcIssuerOverrides {
  explicitIssuer?: string;
  apiBase?: string;
  origin?: string;
}

/**
 * 5a-b: resolves the OIDC issuer the exact way the backend's own
 * `resolveIssuer()` (lib/oidc-discovery.ts) does — an explicit override
 * first, then the value this frontend already uses to reach its own API
 * server (`getApiBase()`, the same base `login.tsx`'s `backendLogin()`
 * builds `${BASE}/api/auth/login` from), then the current origin as a
 * last resort for a same-origin dev server with neither configured.
 *
 * `/oidc/authorize`, `/oidc/token`, and `/oidc/userinfo` are bare-origin
 * routes on the API server (see each route file's own "MOUNTING" note),
 * not under `/api` — so `getApiBase()`'s value (already the API server's
 * origin, with no `/api` suffix baked in) is exactly the right base for
 * them too, the same way `login.tsx` reuses it for `/api`-prefixed routes.
 */
export function resolveSyloOidcIssuer(overrides: ResolveSyloOidcIssuerOverrides = {}): string {
  const explicit = (overrides.explicitIssuer ?? readViteEnvVar("VITE_OIDC_ISSUER"))?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");

  const apiBase = overrides.apiBase ?? getApiBase();
  if (apiBase) return apiBase.replace(/\/+$/, "");

  const origin = overrides.origin ?? (typeof window !== "undefined" ? window.location.origin : undefined);
  return origin ?? "";
}

/**
 * 5a-c: this bundle's registered `client_id` — the detected subdomain
 * app's id when one is recognized (see file header). Otherwise, in a real
 * browser this bundle is running on the main domain itself, so it resolves
 * to `WORKSPACE_OIDC_CLIENT_ID` (the main app's own registration, added
 * alongside the "Login with AYZEN" button — see that constant's doc
 * comment). `SYLO_OIDC_CLIENT_ID` remains the literal fallback only for a
 * non-browser environment (no `window` to detect a hostname from at all —
 * e.g. this file's own test runner) so that path's behavior is unchanged.
 */
export function resolveSyloOidcClientId(): string {
  const subdomainApp = getCurrentSubdomainApp();
  if (subdomainApp) return subdomainApp.id;
  if (typeof window !== "undefined") return WORKSPACE_OIDC_CLIENT_ID;
  return SYLO_OIDC_CLIENT_ID;
}

/**
 * 5a-d: this bundle's own origin's callback URL — must exactly match one
 * of the client's registered `redirect_uris` (section 3.1's "exact
 * matching; no wildcard redirect URI"; `seed-oidc-clients.ts` registers
 * exactly `https://<client_id>.ayzen.tech/oidc/callback` today). Returns
 * `""` outside a browser (no `window.location` to derive an origin from)
 * rather than guessing — a caller in that environment has no business
 * building an authorize URL anyway.
 */
export function resolveSyloOidcRedirectUri(): string {
  if (typeof window === "undefined") return "";
  return `${window.location.origin}${SYLO_OIDC_CALLBACK_PATH}`;
}

/**
 * 5a-b/5a-c/5a-d, composed: the actual `OidcClientConfig` value
 * `oidc-client.ts`'s functions are called with for Sylo (or whichever
 * first-party app this bundle is currently scoped to — see file header).
 */
export function getSyloOidcClientConfig(issuerOverrides?: ResolveSyloOidcIssuerOverrides): OidcClientConfig {
  return {
    issuer: resolveSyloOidcIssuer(issuerOverrides),
    clientId: resolveSyloOidcClientId(),
    redirectUri: resolveSyloOidcRedirectUri(),
    scopes: [...SYLO_OIDC_SCOPES],
  };
}
