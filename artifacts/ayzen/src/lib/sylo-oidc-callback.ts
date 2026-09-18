/**
 * lib/sylo-oidc-callback.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 3, Phase 5b-b..5b-f: Callback Route, State
 * Verification, Token Exchange, Local Session Establishment, Login Error
 * States.
 *
 * Pure orchestration logic for what happens at `/oidc/callback` — split
 * out of `pages/oidc-callback.tsx` (the actual route component) for the
 * identical reason every provider-side OIDC route in this roadmap
 * exports its handler separately from its router wiring (`authorizeHandler`,
 * `tokenHandler`, `userinfoHandler`, ...): unit-testable with plain
 * function calls and injected dependencies instead of needing a rendered
 * DOM/React tree.
 *
 *   parseSyloOidcCallbackParams()   — 5b-b: read code/state/error off the URL.
 *   readPendingSyloOidcTransaction()— reads what 5b-a (sylo-oidc-login.ts)
 *                                     stashed in sessionStorage before the
 *                                     redirect.
 *   verifySyloOidcState()           — 5b-c.
 *   completeSyloOidcLogin()         — 5b-d (token exchange) + 5b-e (local
 *                                     session establishment), composed.
 *   classifySyloOidcCallbackError() — 5b-f: turns any failure along the
 *                                     way into one small, closed set of
 *                                     user-facing states.
 *
 * 5b-e, CONCRETELY: "map successful OIDC authentication into the existing
 * Sylo session model" means calling the EXISTING `POST /auth/session-
 * exchange` endpoint (routes/auth.ts) — not inventing a new one. That
 * route already does exactly what's needed here: prove the caller holds
 * a valid `ayzen_session` cookie (which it does, by construction — 3b-a
 * required one before `/oidc/authorize` would ever have issued a code in
 * the first place) and mint a standalone `{ token, user }` pair in the
 * exact shape `useAuth().login(user, token)` already expects, the same
 * shape `login.tsx`'s own `backendLogin()`/`handleMagicVerify()` produce
 * today. This is deliberately NOT the OIDC `access_token`/`id_token`
 * themselves: those are bound to `aud: "sylo"` and carry OAuth `scope`,
 * not this codebase's internal `{ userId, role, sid }` session shape
 * (see `lib/oidc-access-token.ts`'s own header for exactly why those two
 * artifacts are intentionally different) — feeding an OIDC access token
 * into `api-client-react`'s bearer-token slot would break every existing
 * `/api/*` call Sylo's own pages already make. The OIDC tokens' actual job
 * here is proving the Authorization Code + PKCE round-trip itself
 * succeeded (5b-d); `session-exchange` is what turns "the round-trip
 * succeeded" into "Sylo's existing auth context has a user."
 *
 * ID TOKEN `sub` CROSS-CHECK (defense in depth, not the trust boundary)
 * The `id_token`'s payload `sub` is decoded (base64url, NOT signature-
 * verified — a browser has no business re-implementing RS256 verification
 * against the provider's JWKS just to read a claim it's about to
 * corroborate against a cookie-authenticated call anyway) and compared
 * against the user id `session-exchange` returns. A mismatch fails the
 * attempt even though `session-exchange`'s own cookie check is the real
 * trust boundary — this is the same "assert what you can even when it
 * isn't the primary check" discipline `checkAuthorizationCodeBinding()`
 * (provider-side, oidc-authorization-code-consumption.ts) already applies
 * to its own redundant client/redirect_uri check.
 */
import {
  exchangeCodeForTokens,
  type OidcClientConfig,
  type OidcProviderMetadata,
  type OidcTokenResponse,
} from "./oidc-client";
import { SYLO_OIDC_PENDING_KEY, type PendingSyloOidcTransaction } from "./sylo-oidc-login";
import { resolveSyloOidcIssuer, type ResolveSyloOidcIssuerOverrides } from "./sylo-oidc-config";

/** 5b-b: the shape `/oidc/callback?...` can arrive in — either a successful `code`+`state` pair (RFC 6749 §4.1.2) or an `error` (+ optional `error_description`) redirect (RFC 6749 §4.1.2.1, the same shape `respondToAuthorizeFailure()`/`oidc-authorize.ts`'s `server_error` branch produce on the provider side). */
export interface SyloOidcCallbackParams {
  code: string | null;
  state: string | null;
  error: string | null;
  errorDescription: string | null;
}

/** 5b-b: parses `window.location.search` (or any equivalent query string) into `SyloOidcCallbackParams`. Pure — takes the string, never reads `window` itself, so it's testable with any literal query string. */
export function parseSyloOidcCallbackParams(search: string): SyloOidcCallbackParams {
  const params = new URLSearchParams(search);
  return {
    code: params.get("code"),
    state: params.get("state"),
    error: params.get("error"),
    errorDescription: params.get("error_description"),
  };
}

/** Reads back what `startSyloOidcLogin()` (5b-a) stashed before the redirect. Returns `null` for anything unparseable rather than throwing — a missing/corrupt pending transaction is just another `state_mismatch`-shaped failure the caller already has to handle. */
export function readPendingSyloOidcTransaction(storage: Storage = window.sessionStorage): PendingSyloOidcTransaction | null {
  try {
    const raw = storage.getItem(SYLO_OIDC_PENDING_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (
      typeof parsed?.state === "string" &&
      typeof parsed?.codeVerifier === "string" &&
      typeof parsed?.nonce === "string" &&
      typeof parsed?.clientId === "string" &&
      typeof parsed?.returnToPath === "string"
    ) {
      return parsed as PendingSyloOidcTransaction;
    }
    return null;
  } catch {
    return null;
  }
}

/** Always call once an attempt is finished — success OR failure. A pending transaction is single-use (RFC 6749 §10.12's own CSRF rationale for `state`: it must not still validate on a second, replayed callback hit). */
export function clearPendingSyloOidcTransaction(storage: Storage = window.sessionStorage): void {
  storage.removeItem(SYLO_OIDC_PENDING_KEY);
}

/** 5b-c: exact-equality comparison (RFC 6749 §10.12) between the `state` the callback URL carried and the one `startSyloOidcLogin()` generated and stored before ever leaving this tab. */
export function verifySyloOidcState(pending: PendingSyloOidcTransaction | null, returnedState: string | null): boolean {
  return !!pending && !!returnedState && pending.state === returnedState;
}

/** Base64url-decodes a JWT's middle (payload) segment. Not signature verification — see file header for why that's deliberate here. Returns `null` for anything malformed rather than throwing, since this is only ever used for a secondary cross-check. */
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    const base64 = payload.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(payload.length / 4) * 4, "=");
    return JSON.parse(atob(base64));
  } catch {
    return null;
  }
}

/** The `{ token, user }` shape `POST /auth/session-exchange` returns — matches what `useAuth().login()` accepts as its first two arguments. */
export interface SessionExchangeResult {
  token: string;
  user: { id: number; [key: string]: unknown };
}

/** Injectable dependencies for `completeSyloOidcLogin()` — every effectful call (token exchange, the session-exchange fetch) goes through here so 5b-g's tests can supply fakes instead of hitting a real network/DB. */
export interface CompleteSyloOidcLoginDeps {
  config: OidcClientConfig;
  metadata: Pick<OidcProviderMetadata, "token_endpoint">;
  exchangeCode: typeof exchangeCodeForTokens;
  /** Calls `POST {apiBase}/api/auth/session-exchange` with the shared `ayzen_session` cookie attached (`credentials: "include"`) and returns the parsed `{ token, user }` body. Injected so tests never need a real cookie/DB. */
  sessionExchange: () => Promise<SessionExchangeResult>;
}

export type SyloOidcCallbackErrorCode =
  | "provider_error"
  | "missing_pending_transaction"
  | "state_mismatch"
  | "missing_code"
  | "token_exchange_failed"
  | "session_exchange_failed"
  | "identity_mismatch";

export class SyloOidcCallbackError extends Error {
  constructor(public readonly code: SyloOidcCallbackErrorCode, message: string) {
    super(message);
    this.name = "SyloOidcCallbackError";
  }
}

export interface CompletedSyloOidcLogin {
  user: SessionExchangeResult["user"];
  token: string;
  returnToPath: string;
  tokens: OidcTokenResponse;
}

/**
 * 5b-b..5b-e, composed: given the callback's query params and the pending
 * transaction this tab started (5b-a), verifies state (5b-c), exchanges
 * the code via PKCE (5b-d), and establishes Sylo's local session (5b-e).
 * Throws a `SyloOidcCallbackError` with a specific `code` on any failure
 * — 5b-f's job is turning that `code` into UI, not this function's.
 */
export async function completeSyloOidcLogin(
  params: SyloOidcCallbackParams,
  pending: PendingSyloOidcTransaction | null,
  deps: CompleteSyloOidcLoginDeps,
): Promise<CompletedSyloOidcLogin> {
  if (params.error) {
    throw new SyloOidcCallbackError(
      "provider_error",
      params.errorDescription ?? params.error,
    );
  }
  if (!pending) {
    throw new SyloOidcCallbackError(
      "missing_pending_transaction",
      "No pending sign-in was found in this tab (it may have expired or this tab was reloaded mid-attempt).",
    );
  }
  if (!verifySyloOidcState(pending, params.state)) {
    throw new SyloOidcCallbackError("state_mismatch", "The sign-in response did not match the request that started it.");
  }
  if (!params.code) {
    throw new SyloOidcCallbackError("missing_code", "The sign-in provider did not return an authorization code.");
  }

  let tokens: OidcTokenResponse;
  try {
    tokens = await deps.exchangeCode(deps.config, deps.metadata, params.code, pending.codeVerifier);
  } catch (err) {
    throw new SyloOidcCallbackError(
      "token_exchange_failed",
      err instanceof Error ? err.message : "Token exchange failed",
    );
  }

  // OIDC Core §3.1.3.7 step 11: the nonce carried in the ID token must
  // match the one this tab generated at 5b-a, when an ID token was issued
  // at all (it's absent whenever "openid" wasn't a redeemed scope —
  // `routes/oidc-token.ts`'s own conditional already documents this).
  if (tokens.id_token) {
    const claims = decodeJwtPayload(tokens.id_token);
    if (claims && typeof claims.nonce === "string" && claims.nonce !== pending.nonce) {
      throw new SyloOidcCallbackError("identity_mismatch", "The ID token's nonce did not match this sign-in attempt.");
    }
  }

  let sessionResult: SessionExchangeResult;
  try {
    sessionResult = await deps.sessionExchange();
  } catch (err) {
    throw new SyloOidcCallbackError(
      "session_exchange_failed",
      err instanceof Error ? err.message : "Could not establish a local session",
    );
  }

  // Defense-in-depth cross-check — see file header. Only enforced when the
  // ID token actually carried a `sub` claim to compare against.
  if (tokens.id_token) {
    const claims = decodeJwtPayload(tokens.id_token);
    const idTokenSub = claims && typeof claims.sub === "string" ? claims.sub : null;
    if (idTokenSub && idTokenSub !== String(sessionResult.user.id)) {
      throw new SyloOidcCallbackError("identity_mismatch", "The signed-in account did not match the OIDC identity.");
    }
  }

  return {
    user: sessionResult.user,
    token: sessionResult.token,
    returnToPath: pending.returnToPath,
    tokens,
  };
}

/** 5b-f: one small, closed set of user-facing messages — never surfaces raw provider `error_description`/exception text directly in the UI (that belongs in a console/log for debugging, not presented as if it were actionable copy to the end user). */
export function describeSyloOidcCallbackError(err: unknown): { title: string; description: string; canRetry: boolean } {
  if (err instanceof SyloOidcCallbackError) {
    switch (err.code) {
      case "provider_error":
        return { title: "Sign-in was cancelled or failed", description: "The sign-in provider reported a problem before it could finish. You can try again.", canRetry: true };
      case "missing_pending_transaction":
        return { title: "Sign-in attempt expired", description: "This sign-in link is no longer valid in this tab. Please try signing in again.", canRetry: true };
      case "state_mismatch":
        return { title: "Sign-in could not be verified", description: "For your security, this sign-in attempt could not be verified. Please try again.", canRetry: true };
      case "missing_code":
        return { title: "Sign-in didn't complete", description: "The sign-in provider didn't return the expected response. Please try again.", canRetry: true };
      case "token_exchange_failed":
        return { title: "Sign-in failed", description: "We couldn't complete sign-in with the provider. Please try again.", canRetry: true };
      case "session_exchange_failed":
        return { title: "Sign-in failed", description: "We verified your sign-in but couldn't start your session. Please try again.", canRetry: true };
      case "identity_mismatch":
        return { title: "Sign-in could not be verified", description: "For your security, this sign-in could not be verified. Please try again.", canRetry: true };
    }
  }
  return { title: "Sign-in failed", description: "Something went wrong while signing you in. Please try again.", canRetry: true };
}

/**
 * OIDC Roadmap — Season 3, Phase 5e-b (Token/Callback Errors, browser half).
 *
 * Fire-and-forget beacon to `routes/oidc-client-errors.ts`'s
 * `POST /oidc/client-errors`, called from `oidc-callback.tsx`'s existing
 * catch block (5b-f) right alongside the error UI it already shows. This
 * is the ONLY way the backend ever finds out `/oidc/callback` itself
 * failed — everything up to and including `token_exchange_failed` and
 * `session_exchange_failed` happens over the network and would already
 * show up in server-side logs/monitoring on its own, but `state_mismatch`,
 * `missing_pending_transaction`, `missing_code`, and `identity_mismatch`
 * are purely client-side observations with no other signal reaching the
 * server at all.
 *
 * Never awaited by the caller, never throws, never retried — a dropped
 * beacon just means one fewer data point for 5e-c's `topErrors`/health
 * check, not a broken sign-in flow for this user. `provider_error` is
 * deliberately NOT reported here even though it's a valid
 * `SyloOidcCallbackErrorCode`: it represents the PROVIDER (this same
 * backend, via `/oidc/authorize`) already having reported a failure of
 * its own choosing before ever redirecting back — recording it a second
 * time here would double-count a failure the server already knows about
 * on its own authorize-endpoint logs, the same double-counting concern
 * this file's sibling function `recordOidcCallbackError()`
 * (`lib/oidc-login-attempts.ts`) already avoids for a successful login.
 */
export function reportSyloOidcCallbackError(
  errorCode: SyloOidcCallbackErrorCode,
  appId?: string,
  overrides?: ResolveSyloOidcIssuerOverrides,
): void {
  if (errorCode === "provider_error") return;
  try {
    const issuer = resolveSyloOidcIssuer(overrides);
    const url = `${issuer.replace(/\/+$/, "")}/oidc/client-errors`;
    void fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // keepalive lets this survive a same-tick navigation away (e.g. the
      // "Try again" button restarting 5b-a) without the browser cancelling
      // the request mid-flight.
      keepalive: true,
      body: JSON.stringify({ appId: appId ?? "sylo", errorCode }),
    }).catch(() => {
      // Best-effort only — see this function's own doc comment.
    });
  } catch {
    // Synchronous failures (e.g. resolveSyloOidcIssuer() throwing in an
    // unexpected environment) are swallowed for the identical reason.
  }
}
