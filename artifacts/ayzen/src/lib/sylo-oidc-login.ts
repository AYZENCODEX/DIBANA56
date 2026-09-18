/**
 * lib/sylo-oidc-login.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 3, Phase 5b-a: Login Entry Point.
 *
 * "Connect login action to OIDC authorize" — starts a fresh Authorization
 * Code + PKCE attempt for whichever first-party app this bundle is
 * currently scoped to (`getSyloOidcClientConfig()`, 5a-b/c/d) against the
 * provider metadata Phase 5a-e already knows how to load
 * (`getSyloOidcProviderMetadata()`), using the generic mechanism 5a-a
 * built (`generatePkcePair()`/`generateState()`/`buildAuthorizeUrl()`,
 * `oidc-client.ts`) — this file is the first thing in the roadmap that
 * actually calls any of those three for a real value instead of a test
 * double.
 *
 * WHY sessionStorage, NOT a React state variable
 * `startSyloOidcLogin()` ends in a full top-level navigation
 * (`window.location.assign`) to a DIFFERENT origin in production (the
 * issuer's own `/oidc/authorize`, e.g. `https://ayzen.tech`, per
 * `resolveSyloOidcIssuer()` — genuinely cross-origin from
 * `sylo.ayzen.tech` even though same-site for the shared session cookie,
 * see `lib/session-cookie.ts`'s own SameSite=Lax reasoning). This SPA's
 * entire JS heap — including any in-memory `codeVerifier`/`state` — is
 * gone by the time the browser comes back to `/oidc/callback` (5b-b).
 * `sessionStorage` is the one browser storage that survives that
 * round-trip while still being cleared when the tab/browser closes (never
 * `localStorage` — a stale, unconsumed PKCE verifier has no legitimate
 * reason to outlive the tab that generated it).
 *
 * NEVER REUSED ACROSS ATTEMPTS
 * Every call to `startSyloOidcLogin()` generates a brand new PKCE pair,
 * `state`, and `nonce` (RFC 7636 §7.1's own guidance, echoed in
 * `oidc-client.ts`'s own `PkcePair` doc comment: "generated fresh for
 * every login attempt, never reused") and overwrites whatever pending
 * transaction sessionStorage held before — an abandoned/failed prior
 * attempt is simply superseded, never merged with or validated against.
 *
 * SCOPE DISCIPLINE (this is 5b-a, not 5b-b..5b-g)
 *   - Does not read `code`/`state` off a callback URL or verify anything
 *     — that is 5b-b/5b-c (`sylo-oidc-callback.ts`).
 *   - Does not render anything — `pages/oidc-callback.tsx` (5b-b) and the
 *     `App.tsx` wiring that calls `startSyloOidcLogin()` (this phase's own
 *     "connect login action" half) own the React/DOM side.
 */
import { generatePkcePair, generateState, buildAuthorizeUrl } from "./oidc-client";
import { getSyloOidcClientConfig } from "./sylo-oidc-config";
import { getSyloOidcProviderMetadata } from "./sylo-oidc-discovery";

/** sessionStorage key for the one in-flight OIDC transaction this tab holds. Read back by `sylo-oidc-callback.ts` (5b-b/5b-c/5b-d). */
export const SYLO_OIDC_PENDING_KEY = "ayzen_sylo_oidc_pending";

/** Everything the callback (5b-b..5b-e) needs to finish an attempt started here. */
export interface PendingSyloOidcTransaction {
  state: string;
  codeVerifier: string;
  nonce: string;
  clientId: string;
  /** Where to return the user once login completes — the in-app path they were trying to reach, NOT the OIDC `redirect_uri` itself (that's always `/oidc/callback`, fixed). Defaults to the subdomain app's own home. */
  returnToPath: string;
  createdAt: number;
}

/** 32 random bytes, base64url — same `oidc-client.ts` primitives 5a-a already built for PKCE, reused here for the `nonce` too (OIDC Core's nonce has the identical "unguessable, single-use, generated fresh per attempt" requirement PKCE's own values do). Not exported from `oidc-client.ts` itself (that file only exports a `state` generator, not a bare random-string one) — `generateState()` already produces exactly this shape, so it's reused directly rather than duplicating `randomUrlSafeString()`. */
function generateNonce(): string {
  return generateState();
}

function readPendingReturnToPath(fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const { pathname, search } = window.location;
  // Never persist the OIDC callback path itself as a "return to" target —
  // that would loop the user straight back into a fresh callback with no
  // code/state, since `pathname` here is captured BEFORE any redirect.
  if (pathname.startsWith("/oidc/")) return fallback;
  return `${pathname}${search}`;
}

/**
 * 5b-a: begins a fresh Authorization Code + PKCE attempt and navigates the
 * browser to the provider's `/oidc/authorize`. Never resolves on success
 * (the tab navigates away); only rejects if provider metadata can't be
 * loaded or `window` isn't available (e.g. called during SSR/build).
 *
 * `returnToPath` defaults to the current path so a login triggered by
 * hitting a protected, in-scope route (the common case — see App.tsx's
 * `ProtectedRoute`) lands the user back where they were headed, not just
 * at the subdomain's home page.
 */
export async function startSyloOidcLogin(returnToPath?: string): Promise<void> {
  if (typeof window === "undefined") {
    throw new Error("startSyloOidcLogin() requires a browser environment");
  }

  const config = getSyloOidcClientConfig();
  const metadata = await getSyloOidcProviderMetadata();
  const { codeVerifier, codeChallenge } = await generatePkcePair();
  const state = generateState();
  const nonce = generateNonce();

  const pending: PendingSyloOidcTransaction = {
    state,
    codeVerifier,
    nonce,
    clientId: config.clientId,
    returnToPath: returnToPath ?? readPendingReturnToPath("/"),
    createdAt: Date.now(),
  };
  window.sessionStorage.setItem(SYLO_OIDC_PENDING_KEY, JSON.stringify(pending));

  const authorizeUrl = buildAuthorizeUrl(config, metadata, codeChallenge, state, nonce);
  window.location.assign(authorizeUrl);
}
