/**
 * lib/oidc-consent-api.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 4, Phase 7b: Consent UI (frontend API wrapper).
 *
 * Thin wrapper around `routes/oidc-consent.ts`'s three endpoints, same
 * `authedJson()`-style shape `lib/passkey-api.ts` already uses for this
 * codebase's other bearer-token-authenticated backend calls. Bare-origin
 * paths (`/oidc/consent/...`), NOT `/api`-prefixed — same reasoning
 * `lib/oidc-client.ts`/`lib/sylo-oidc-*.ts` already give for every other
 * `/oidc/*` call in this codebase: these routes are mounted directly on
 * the Express `app`, not under this deployment's `/api` surface (see
 * `routes/oidc-consent.ts`'s own header).
 *
 * UPDATE — Phase 7e (Consent Re-Prompt Policy): `OidcConsentScopeInfo`
 * gained `isNew`, `OidcConsentInfo` gained `isReprompt` — both read-only
 * additions to the existing response shape, no new endpoint, no change to
 * `allowOidcConsent()`/`denyOidcConsent()`'s own request/response shape.
 */
import { getApiBase } from "@/lib/api-base";

const BASE = getApiBase();

async function authedJson<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(init?.headers ?? {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || "Request failed") as Error & { code?: string };
    err.code = data.error;
    throw err;
  }
  return data as T;
}

/**
 * One scope's consent-screen copy — mirrors `OidcConsentScopeCopy`
 * (`lib/oidc-consent-scope-copy.ts`) plus `isNew` (Phase 7e), `true` when
 * this scope wasn't already covered by an existing active consent —
 * `pages/oidc-consent.tsx`'s own update uses this to highlight only the
 * scopes actually being added, not the whole list, on a re-prompt.
 */
export interface OidcConsentScopeInfo {
  scope: string;
  label: string;
  description: string;
  isNew: boolean;
}

/**
 * `GET /oidc/consent/info`'s success shape. `isReprompt` (Phase 7e) is
 * `true` when the user already has an active consent for this client and
 * this screen exists only because of scope creep — `false` for an
 * ordinary first-time grant. See `routes/oidc-consent.ts`'s own comment
 * on this handler for how the two are told apart.
 */
export interface OidcConsentInfo {
  clientId: string;
  clientDisplayName: string;
  scopes: OidcConsentScopeInfo[];
  isReprompt: boolean;
  state: string;
}

/**
 * Fetches what the consent screen needs to render, for the `/oidc/authorize`
 * request preserved in `returnTo` (see `pages/oidc-consent.tsx` for how
 * that value itself is obtained — the same "the URL IS the preserved
 * request" round-trip `login.tsx`'s own `return_to` already uses).
 */
export async function getOidcConsentInfo(token: string, returnTo: string): Promise<OidcConsentInfo> {
  return authedJson<OidcConsentInfo>(`/oidc/consent/info?returnTo=${encodeURIComponent(returnTo)}`, token);
}

/**
 * Records the grant and hands back `resumeUrl` — the same `returnTo` value
 * passed in, once the backend has re-verified it. The caller (the consent
 * page) does a full navigation (`window.location.href = resumeUrl`), never
 * `setLocation()` — `resumeUrl` targets `/oidc/authorize`, a server route,
 * not an SPA route wouter knows how to render (same reasoning
 * `login.tsx`'s own `redirectAfterLogin()` already documents for its
 * identical `oidcReturnTo` navigation).
 */
export async function allowOidcConsent(token: string, returnTo: string): Promise<{ resumeUrl: string }> {
  return authedJson<{ resumeUrl: string }>(`/oidc/consent/allow`, token, {
    method: "POST",
    body: JSON.stringify({ returnTo }),
  });
}

/**
 * Denies the request — hands back `redirectTo`, an already-verified
 * `?error=access_denied` URL on the CLIENT's own origin (never this
 * server's). Same full-navigation reasoning as `allowOidcConsent()`
 * above.
 */
export async function denyOidcConsent(token: string, returnTo: string): Promise<{ redirectTo: string }> {
  return authedJson<{ redirectTo: string }>(`/oidc/consent/deny`, token, {
    method: "POST",
    body: JSON.stringify({ returnTo }),
  });
}
