/**
 * lib/sylo-oidc-rollout-flag.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 3, Phase 5c-c: Dual-Run Gate (frontend read half).
 *
 * Reads the public `/oidc/rollout-flags/:appId` endpoint
 * (`routes/oidc-rollout-flag.ts`, 5c-a) so `App.tsx`'s `ProtectedRoute`
 * (5c-c) and `login.tsx` (5d-c) can decide, BEFORE any session exists,
 * whether to start `startSyloOidcLogin()` or fall through to the old
 * credential-form `/login` page. "Before any session exists" is why this
 * hits a public, unauthenticated endpoint rather than anything behind
 * `useAuth()`.
 *
 * FAIL-SAFE, NOT FAIL-OPEN — same discipline as the backend's own
 * `lib/oidc-client-rollout.ts`. A network error, a timeout, a non-2xx
 * response, or a malformed body all resolve to `false` (never throw, never
 * resolve to `true`) — a frontend that can't confirm OIDC is actually live
 * for this app_id must fall back to the old, always-working credential
 * form, not gamble on redirecting into an OIDC flow that might not be
 * ready. This mirrors `routes/oidc-rollout-flag.ts`'s own FAILURE SHAPE
 * note almost exactly, just on the other end of the same fetch.
 *
 * CACHED, SHORT TTL — matches the backend's own `CACHE_TTL_MS`
 * (`lib/oidc-client-rollout.ts`, 15s) exactly, for the identical reason:
 * this is a live, operator-flippable value (5c-c/5c-e/5d-b/5e-d), not a
 * static document, so both `App.tsx`'s `ProtectedRoute` (which re-checks on
 * every unauthenticated mount) and `login.tsx` (5d-c's cutover-redirect
 * effect) share one short-lived, per-app_id cache instead of each firing
 * its own request on every render, while still catching an operator's flag
 * flip within roughly one deploy's worth of page loads rather than only on
 * a hard refresh.
 *
 * SCOPE DISCIPLINE (this is 5c-c's read dependency, not 5c-a/5c-b/5c-d/5c-e)
 *   - No write path — flipping the flag is `routes/admin-oidc-rollout.ts`'s
 *     PATCH or `scripts/src/set-oidc-rollout-flag.ts`, never this file.
 *   - No opinion on WHAT to do with the result (start the OIDC redirect,
 *     fall through to the form) — that decision lives in `App.tsx`'s
 *     `ProtectedRoute` and `login.tsx`, this file only answers the
 *     boolean question.
 */
import { getApiBase } from "./api-base";

/** Matches `lib/oidc-client-rollout.ts`'s `CACHE_TTL_MS` exactly — see file header. */
export const ROLLOUT_FLAG_CACHE_TTL_MS = 15_000;

interface CachedFlag {
  value: boolean;
  at: number;
}

const flagCache = new Map<string, CachedFlag>();

/**
 * 5c-c: resolves whether OIDC login is currently enabled for `appId`, per
 * the public `/oidc/rollout-flags/:appId` endpoint. Never throws — any
 * failure (network, non-2xx, malformed JSON) resolves to `false`, per the
 * file header's fail-safe reasoning. Cached per-app_id for
 * `ROLLOUT_FLAG_CACHE_TTL_MS` so this never fires more than one request per
 * app_id per short window, however many components ask.
 */
export async function getSyloOidcRolloutFlag(appId: string): Promise<boolean> {
  const normalized = appId.trim().toLowerCase();

  const cached = flagCache.get(normalized);
  if (cached && Date.now() - cached.at < ROLLOUT_FLAG_CACHE_TTL_MS) return cached.value;

  let enabled = false;
  try {
    const res = await fetch(`${getApiBase()}/oidc/rollout-flags/${encodeURIComponent(normalized)}`);
    if (res.ok) {
      const data = await res.json().catch(() => null);
      enabled = typeof data?.oidcEnabled === "boolean" ? data.oidcEnabled : false;
    }
  } catch {
    // Network error, timeout, CORS failure, etc. — fail safe to false, see
    // file header. Deliberately swallowed, not logged: a logged-out
    // visitor's browser console is not where an operator will ever look
    // for this, and this endpoint's own route already logs server-side
    // read failures (routes/oidc-rollout-flag.ts).
    enabled = false;
  }

  flagCache.set(normalized, { value: enabled, at: Date.now() });
  return enabled;
}

/** Test-only escape hatch — clears the module cache. Never called from production code. */
export function __resetSyloOidcRolloutFlagCacheForTests(): void {
  flagCache.clear();
}
