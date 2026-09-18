/**
 * lib/sylo-oidc-session-exchange.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 3, Phase 5b-e: Local Session Establishment.
 *
 * The one effectful call `completeSyloOidcLogin()` (sylo-oidc-callback.ts)
 * takes as an injected dependency rather than making directly: a
 * `credentials: "include"` POST to the EXISTING `POST /auth/session-
 * exchange` endpoint (`routes/auth.ts`) — see `sylo-oidc-callback.ts`'s
 * own file header for why this endpoint, not the OIDC access/ID tokens
 * themselves, is what Sylo's local session gets built from.
 *
 * `credentials: "include"` is required here specifically (unlike
 * `oidc-client.ts`'s `exchangeCodeForTokens()`, which never sends
 * credentials — it authenticates via `code_verifier` instead): this call
 * is the one place in the whole 5b flow that relies on the browser
 * attaching the shared `ayzen_session` cookie, exactly the way
 * `session-exchange`'s own file header describes for its original
 * (browser-extension) caller. `lib/session-cookie.ts`'s `SameSite=Lax`
 * already covers this cross-subdomain call (see that file's own doc
 * comment) without needing `SameSite=None`.
 *
 * OIDC Roadmap — Season 3, Phase 6e-b (Sylo Integration): the request
 * body now names `client_id: "sylo"`. `routes/auth.ts`'s handler tags the
 * resulting `user_sessions` row with it (migration 086,
 * `origin_client_id`) — the one thing that lets a LATER inbound Back-
 * Channel Logout event (`routes/oidc-backchannel-logout.ts`) find and
 * revoke exactly this session, instead of every session the signed-in
 * user has anywhere. Nothing about the exchange itself changes; this is
 * additive to the existing request body, not a new call.
 */
import { getApiBase } from "./api-base";
import type { SessionExchangeResult } from "./sylo-oidc-callback";

/**
 * 5b-e: exchanges the browser's current `ayzen_session` cookie for a
 * standalone `{ token, user }` pair via the existing session-exchange
 * endpoint. Throws on any non-2xx response; the message favors whatever
 * the endpoint's own `error` field says (same "surface the provider's own
 * reason" precedent `oidc-client.ts`'s `exchangeCodeForTokens()` already
 * follows for its own error path).
 */
export async function exchangeSyloSessionCookie(): Promise<SessionExchangeResult> {
  const res = await fetch(`${getApiBase()}/api/auth/session-exchange`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: "sylo" }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data?.token || !data?.user) {
    throw new Error(data?.error ?? "Could not establish a local session");
  }
  return { token: data.token, user: data.user };
}
