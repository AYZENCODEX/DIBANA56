/**
 * routes/oidc-token.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 2, Phase 3c (Token Endpoint) + Phase 3d (PKCE
 * Enforcement) + Phase 3e-c (Refresh Token Baseline's Token Response
 * step) + Phase 4a/4b (ID Token issuance, wired in this pass) + Season 3,
 * Phase 5c-d/5e-a (dual-run comparison recording, wired in this pass):
 * `POST /oidc/token`.
 *
 * SEASON 3, 5c-d/5e-a ADDITION (additive only — no branch logic above
 * changed): every failure branch below now also calls
 * `recordOidcLoginAttempt(appId, "oidc", "failure", errorCode)` alongside
 * its existing `logger.warn(...)` call, and the success path calls
 * `recordOidcLoginAttempt(appId, "oidc", "success")` right after a code is
 * redeemed. `appId` is this request's `client_id` (`"sylo"`, etc.) — see
 * `recordTokenFailure()`'s own doc comment below for why it's skipped
 * entirely when no `client_id` can yet be trusted. This is what lets
 * `routes/admin-oidc-rollout.ts`'s dual-run comparison and
 * `evaluateOidcRolloutHealth()` (5e-c) see the "oidc" path's own real
 * traffic side by side with `routes/auth.ts`'s "legacy" path recording.
 *
 * Composes every piece 3c-a..3c-g, 3d-a..3d-e, 3e-c, and 4a/4b already
 * built, in the order section 3.4 and the roadmap's 3c task list imply:
 *
 *   parse (3c-a)
 *     -> required-parameter / grant_type check (3c-a/3c-g)
 *     -> client authentication (3c-b, lib/oidc-token-client-auth.ts)
 *     -> code lookup + atomic single-use consumption (3c-c/3c-e,
 *        lib/oidc-authorization-code-consumption.ts)
 *     -> client/redirect_uri/expiry binding checks (3c-d, same file)
 *     -> PKCE verifier check (3d-a..3d-e, lib/oidc-pkce.ts)
 *     -> access token issuance (3c-f, lib/oidc-access-token.ts)
 *     -> ID token issuance (4a/4b, lib/oidc-id-token.ts) — ONLY when the
 *        redeemed code's own scopes include "openid" (OIDC Core §3.1.3.3:
 *        "The OP MUST validate ... the response includes an ID Token if
 *        openid was included in the requested scope"; conversely, a code
 *        whose scopes never included it stays a plain OAuth exchange —
 *        no id_token field at all, not one with empty claims)
 *     -> refresh token issuance (3e-c, lib/oidc-refresh-tokens.ts) — see
 *        that file's own header for why this is "baseline" only (no
 *        refresh GRANT handling; that remains future scope)
 *
 * Every failure branch reports one of 3c-g's `OidcTokenErrorCode` values,
 * per section 4's global error model — see `respondTokenError()` below for
 * the one place that shape is rendered as HTTP, same "define the union in
 * lib, render it in the route" split `oidc-authorize.ts` established for
 * `respondToAuthorizeFailure()`.
 *
 * HARD SCOPE BOUNDARY FOR 3c/3d/4a/4b: this route does not:
 *   - implement a refresh-token GRANT (redeeming a refresh token for a new
 *     access token) — `grant_type` is checked against exactly
 *     `"authorization_code"`, nothing else is accepted yet. A refresh token
 *     IS now issued alongside the access token (3e-c) — see
 *     lib/oidc-refresh-tokens.ts for why that issuance is "baseline" only;
 *   - verify an access token anywhere (`GET /oidc/userinfo`, Phase 4c) —
 *     this route only ever mints tokens, never reads one back;
 *   - enforce any scope-based access-control middleware on OTHER routes
 *     (Phase 4d/4e) — issuing an `id_token` here has no relationship to
 *     that unrelated, not-yet-built middleware.
 *
 * WHY invalid_client/invalid_grant/... ARE ALL RENDERED AS 400
 * RFC 6749 §5.2 technically asks for 401 specifically when a client
 * authenticated via the HTTP `Authorization` header failed — this codebase
 * only ever accepts `client_id`/`client_secret` in the POST body (RFC
 * 6749 §2.3.1's alternative, and the only form `lib/oidc-token-client-auth.ts`
 * checks), so that particular 401 trigger never applies here. Every failure
 * — `invalid_client` included — is rendered as 400, the exact same choice
 * `routes/oidc-authorize.ts`'s `respondToAuthorizeFailure()` already made
 * for its own non-redirectable `invalid_client` case; one HTTP-status
 * convention across both OIDC endpoints in this codebase, not two.
 *
 * MOUNTING / RATE LIMITING: bare origin (not `/api`, not behind
 * `apiKeyScopeGate`) and `authLimiter`, for the identical reasons
 * `routes/oidc-authorize.ts`'s own header already documents for itself — an
 * OIDC client's backend calls this URL directly against the issuer's
 * origin, and a token-issuing endpoint that accepts a client-supplied
 * authorization `code` is exactly the kind of brute-forceable,
 * credential-adjacent surface `authLimiter` (not the generous
 * `globalLimiter`) exists for.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { authLimiter } from "../middlewares/security";
import { parseOidcTokenRequest, type OidcTokenErrorCode } from "../lib/oidc-token-request";
import { authenticateOidcTokenClient } from "../lib/oidc-token-client-auth";
import {
  consumeAuthorizationCode,
  checkAuthorizationCodeBinding,
} from "../lib/oidc-authorization-code-consumption";
import { verifyPkce } from "../lib/oidc-pkce";
import { issueOidcAccessToken } from "../lib/oidc-access-token";
import { issueOidcIdToken } from "../lib/oidc-id-token";
import { generateRefreshToken, persistRefreshToken } from "../lib/oidc-refresh-tokens";
import { recordOidcLoginAttempt } from "../lib/oidc-login-attempts";
import { logger } from "../lib/logger";

const router: IRouter = Router();

/** The only grant type this provider ever plans to support (Phase 3e's refresh-token baseline adds `"refresh_token"` on top later — not yet). */
const SUPPORTED_GRANT_TYPE = "authorization_code";

/** 3c-g, rendered: every failure branch below funnels through this one function, same discipline `respondToAuthorizeFailure()` (3a-g) established. See file header for why every code renders as 400. */
function respondTokenError(res: Response, error: OidcTokenErrorCode): void {
  res.status(400).json({ error });
}

/**
 * 5c-d/5e-a (additive, wired in this pass): records a token-endpoint
 * failure under the "oidc" path so `getOidcLoginAttemptStats()`'s dual-run
 * comparison and `evaluateOidcRolloutHealth()` (5e-c) have something real
 * to read for a Sylo cutover — mirrors `routes/auth.ts`'s own
 * `recordOidcLoginAttempt(legacyLoginAppId, "legacy", "failure", ...)` call
 * on the credential-form side of the same comparison.
 *
 * `appId` is this request's `client_id` — the same value
 * `seed-oidc-clients.ts` registered as `"sylo"` (etc.), and the same
 * `app_id` `lib/oidc-client-rollout.ts`'s rollout flag and
 * `lib/oidc-cutover-gate.ts`'s gate are both keyed by, so a single app_id
 * vocabulary threads through the legacy gate, the rollout flag, and this
 * comparison rather than three independently-invented ones.
 *
 * Deliberately a no-op when `appId` is falsy (a malformed request with no
 * `client_id` at all, or a client-auth failure before any `client_id`
 * could be trusted) — same "don't touch what you can't attribute"
 * discipline `resolveLegacyLoginAppId()`'s own header describes: recording
 * a failure against an unverified or absent client_id would let a stranger
 * pollute another app's stats just by sending a bad request with that
 * app's name in the body.
 */
function recordTokenFailure(appId: string | undefined, errorCode: OidcTokenErrorCode): void {
  if (!appId) return;
  recordOidcLoginAttempt(appId, "oidc", "failure", errorCode);
}

/**
 * The actual handler logic, exported separately from the router wiring —
 * same reasoning as `authorizeHandler` (3a) and every earlier route in this
 * roadmap: unit-testable with a minimal req/res double instead of a live
 * HTTP server.
 */
export async function tokenHandler(req: Request, res: Response): Promise<void> {
  const raw = parseOidcTokenRequest(req.body as Record<string, unknown>);

  // oidc.token.started — mirrors oidc.authorize.started's own reasoning
  // (oidc-authorize.ts): logged before any validation so a malformed/attack
  // request still leaves a trail. clientId only, never `code`/`client_secret`/
  // `code_verifier` (section 5's "do not log ... authorization codes /
  // access tokens" rule, and a client_secret or verifier is exactly the
  // kind of credential that rule exists to keep out of logs).
  logger.info({ clientId: raw.clientId }, "oidc.token.started");

  if (!raw.grantType) {
    logger.warn({ clientId: raw.clientId }, "oidc.token.failed");
    recordTokenFailure(raw.clientId, "invalid_request");
    respondTokenError(res, "invalid_request");
    return;
  }
  if (raw.grantType !== SUPPORTED_GRANT_TYPE) {
    logger.warn({ clientId: raw.clientId, grantType: raw.grantType }, "oidc.token.failed");
    recordTokenFailure(raw.clientId, "unsupported_grant_type");
    respondTokenError(res, "unsupported_grant_type");
    return;
  }
  if (!raw.code || !raw.redirectUri) {
    logger.warn({ clientId: raw.clientId }, "oidc.token.failed");
    recordTokenFailure(raw.clientId, "invalid_request");
    respondTokenError(res, "invalid_request");
    return;
  }

  // 3c-b
  const clientAuth = await authenticateOidcTokenClient(raw.clientId, raw.clientSecret);
  if (!clientAuth.ok) {
    logger.warn({ clientId: raw.clientId }, "oidc.token.failed");
    recordTokenFailure(raw.clientId, clientAuth.error);
    respondTokenError(res, clientAuth.error);
    return;
  }

  // 3c-c/3c-e — look up AND atomically consume in the same step; see
  // lib/oidc-authorization-code-consumption.ts for why these are one
  // operation.
  const consumption = await consumeAuthorizationCode(raw.code);
  if (!consumption.ok) {
    // oidc.code.replay specifically for "this code existed and was already
    // used" (section 5) — a code that never existed at all is just a
    // generic oidc.token.failed, not a replay of anything.
    logger.warn(
      { clientId: clientAuth.client.clientId },
      consumption.reason === "already_used" ? "oidc.code.replay" : "oidc.token.failed",
    );
    recordTokenFailure(clientAuth.client.clientId, "invalid_grant");
    respondTokenError(res, "invalid_grant");
    return;
  }

  // 3c-d — client/redirect_uri/expiry binding. Deliberately AFTER
  // consumption above, not before — see checkAuthorizationCodeBinding()'s
  // own doc comment for why a mismatched-binding code must still be burned
  // by this attempt.
  const binding = checkAuthorizationCodeBinding(consumption.code, {
    clientId: clientAuth.client.clientId,
    redirectUri: raw.redirectUri,
  });
  if (!binding.ok) {
    logger.warn(
      { clientId: clientAuth.client.clientId, reason: binding.reason },
      "oidc.token.failed",
    );
    recordTokenFailure(clientAuth.client.clientId, "invalid_grant");
    respondTokenError(res, "invalid_grant");
    return;
  }

  // 3d-a..3d-e — PKCE verifier check against the challenge persisted at
  // authorize-time (3b-e). RFC 7636 defines no code of its own; this
  // provider reports a PKCE failure the same way any other authorization-
  // code-is-unusable failure is reported — invalid_grant — same as every
  // 3c-d binding failure above.
  const pkce = verifyPkce(raw.codeVerifier, consumption.code.codeChallenge, consumption.code.codeChallengeMethod);
  if (!pkce.ok) {
    logger.warn(
      { clientId: clientAuth.client.clientId, reason: pkce.reason },
      "oidc.token.failed",
    );
    recordTokenFailure(clientAuth.client.clientId, "invalid_grant");
    respondTokenError(res, "invalid_grant");
    return;
  }

  // Every check passed — this code is now consumed and can never be
  // redeemed again (3c-e), regardless of what happens next.
  logger.info({ clientId: clientAuth.client.clientId }, "oidc.code.redeemed");

  // 5c-d/5e-a: the token endpoint's own success record for the "oidc" path
  // — recorded here, not after refresh-token persistence below, because a
  // refresh-token storage hiccup degrades the response (access-token-only)
  // without making this attempt itself a failed login; the access+id token
  // issued below is unconditional proof this attempt actually succeeded.
  recordOidcLoginAttempt(clientAuth.client.clientId, "oidc", "success");

  // 3c-f
  const issued = issueOidcAccessToken({
    userId: consumption.code.userId,
    clientId: clientAuth.client.clientId,
    scopes: consumption.code.scopes,
  });

  // 4a/4b — ID Token issuance, gated on the "openid" scope (OIDC Core
  // §3.1.3.3 — see file header). `consumption.code.nonce` is passed
  // through verbatim (4b-b); `issueOidcIdToken()`/`buildIdTokenClaims()`
  // own the "no nonce claim at all when null" behavior (4b-c) — this
  // route does not re-implement that check.
  const idToken = consumption.code.scopes.includes("openid")
    ? issueOidcIdToken({
        userId: consumption.code.userId,
        clientId: clientAuth.client.clientId,
        nonce: consumption.code.nonce,
      })
    : null;

  // 3e-c — Token Response: issue a refresh token alongside the access
  // token. Persistence-failure handling mirrors `persistAuthorizationCode()`'s
  // own contract (see oidc-refresh-tokens.ts): a token that failed to
  // durably store must never be handed to the client, since nothing would
  // ever be able to look it up again. This does NOT fail the whole
  // request — the access token above is already valid and already logged
  // as issued; a refresh-token storage hiccup degrades this response to
  // "access token only" rather than discarding a good access token over
  // it. Only the authorization_code grant issues one (3e's own baseline
  // scope; there is no other grant type reachable here yet — see this
  // route's header for why).
  const rawRefreshToken = generateRefreshToken();
  const refreshTokenPersisted = await persistRefreshToken(rawRefreshToken, {
    clientId: clientAuth.client.clientId,
    userId: consumption.code.userId,
    scopes: consumption.code.scopes,
  });
  if (!refreshTokenPersisted) {
    logger.warn({ clientId: clientAuth.client.clientId }, "oidc.token.refresh_token_persist_failed");
  }

  logger.info({ clientId: clientAuth.client.clientId }, "oidc.token.issued");

  res.status(200).json({
    access_token: issued.accessToken,
    token_type: issued.tokenType,
    expires_in: issued.expiresIn,
    scope: issued.scope,
    ...(idToken ? { id_token: idToken } : {}),
    ...(refreshTokenPersisted ? { refresh_token: rawRefreshToken } : {}),
  });
}

router.post("/oidc/token", authLimiter, tokenHandler);

export default router;
