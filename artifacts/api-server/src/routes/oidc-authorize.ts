/**
 * routes/oidc-authorize.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 2, Phase 3a (Authorization Request Validation) +
 * Phase 3b (Login & Authorization Code): `GET /oidc/authorize`.
 *
 * The first route this roadmap wires `validateOidcClientRequest()` (2E)
 * into — 2E-c's own worked example predicted exactly this call site. Adds
 * `lib/oidc-authorize-request.ts` (3a-a..3a-g) on top of it for the
 * request-shape checks (response_type/state/nonce/PKCE) Phase 2 never
 * covered, and — as of this pass — composes 3b-a..3b-g on top of that:
 *
 *   validate (3a, unchanged from before)
 *     -> existing-session detection (3b-a, lib/auth-utils.ts's
 *        getTokenFromReq()/getUserFromToken() — the same central-SSO
 *        cookie check every other AYZEN surface already uses, not a new
 *        session mechanism invented for OIDC)
 *     -> no session: central login redirect (3b-b), preserving the
 *        original request via `return_to` (3b-c)
 *     -> session found: generate + persist an authorization code (3b-d/
 *        3b-e, lib/oidc-authorization-codes.ts, already wired) bound to
 *        this request's client/redirect_uri/user/scopes/PKCE
 *        challenge/nonce
 *     -> callback redirect with `?code=...&state=...` (3b-f)
 *
 * 3b-a, CONCRETELY: "session" here means exactly what every other
 * first-party route in this codebase already means by it — a verified
 * `ayzen_session` cookie (or, permissively, an `Authorization: Bearer`
 * header, since `getTokenFromReq()` checks both) that
 * `getUserFromToken()` resolves to a live, non-banned user. This route
 * does not invent a second, OIDC-specific notion of "signed in"; it reuses
 * the exact central-SSO mechanism `CHANGES_CENTRAL_ACCOUNT_SSO_COOKIE.md`
 * already built so that a user already signed in on `ayzen.tech` (or any
 * `*.ayzen.tech` subdomain sharing that cookie) never has to log in again
 * just because a client redirected them through `/oidc/authorize`.
 *
 * 3b-b/3b-c, CONCRETELY: an unauthenticated request 302s to
 * `/login?return_to=<this request's own original URL>`. `return_to` is
 * built from `req.originalUrl` — a value THIS SERVER constructs from the
 * request it just validated, never anything read back from client input —
 * so the entire original `/oidc/authorize` query string (client_id,
 * redirect_uri, state, nonce, code_challenge, ...) survives the login
 * round-trip without this route needing a separate server-side
 * "authorize transaction" table to stash it in: the return_to URL IS the
 * preserved request. `artifacts/ayzen/src/pages/login.tsx`'s own
 * `redirectAfterLogin()` honors this by doing a full navigation back to
 * that exact URL once login succeeds and the session cookie is set,
 * which is what lets 3b-a's check pass on the second attempt.
 *
 * 3b-f, CONCRETELY: `res.redirect(302, ...)` to `redirectUri` (already
 * verified against the client's registered URIs by Phase 2E/3a) with
 * `code` and `state` (RFC 6749 §4.1.2) appended as query params — the
 * same `URL`-object-then-`searchParams.set` shape
 * `respondToAuthorizeFailure()` below already uses for its own error
 * redirects, not a hand-built query string.
 *
 * WHAT'S STILL NOT HERE (Phase 3c/3d, in routes/oidc-token.ts): this
 * route only ever ISSUES a code — it never looks one up, consumes one,
 * verifies a PKCE verifier, or mints an access token. See that file.
 *
 * SEASON 4, PHASE 7c (Authorize-Flow Integration), added on top of the
 * above: right after 3b-a's session check and before 3b-d's code
 * generation, a non-first-party client with no active consent row (7a's
 * `getActiveConsent()`) is sent to `/oidc/consent` (7b) instead, via the
 * same `req.originalUrl`-as-`returnTo` mechanism 3b-b/3b-c already use for
 * the login round-trip. First-party clients fall straight through to
 * unchanged 3b-d/3b-e/3b-f code issuance.
 *
 * SEASON 4, PHASE 7e (Consent Re-Prompt Policy), added on top of 7c: an
 * existing active consent no longer skips the screen unconditionally —
 * see the consent-gate block's own comment for `evaluateScopeCreep()`
 * (`lib/oidc-consent-scope-superset.ts`), which also now decides whether
 * to redirect.
 *
 * MOUNTING: bare origin, not under `/api`.
 * `redirect_uri` values registered in Phase 2B (e.g.
 * `https://sylo.ayzen.tech/oidc/callback`) are themselves bare paths on
 * each CLIENT's own origin, not `/api`-prefixed — the authorization
 * endpoint on THIS (the issuer's) origin follows the same convention for
 * the identical reason `routes/well-known-jwks.ts` and
 * `routes/well-known-openid-configuration.ts` are: an OIDC client
 * constructs this URL directly (`${issuer}/oidc/authorize?...`), not
 * through this codebase's own `/api` surface, and is never expected to
 * carry this deployment's internal API key. Mounted directly on the
 * Express `app` (see app.ts), same as the two `well-known` routers, and
 * NOT one of the routers combined in `routes/index.ts`.
 *
 * RATE LIMITING: `authLimiter` (`middlewares/security.ts`) — the same
 * limiter every other user-facing authentication entry point in this
 * codebase uses (`/auth/login`, `/auth/init`, ...). `/oidc/authorize` is a
 * login-flow entry point in the same sense (it is, in Season 3, meant to
 * replace those endpoints for first-party clients), so it gets the same
 * brute-force/flood protection rather than either the generous
 * `globalLimiter` or no limiter at all (the two `well-known` routes skip
 * rate limiting entirely, but those are static metadata reads with no
 * client-supplied parameters to abuse — this endpoint is not that).
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { authLimiter } from "../middlewares/security";
import {
  parseOidcAuthorizeRequest,
  validateOidcAuthorizeRequest,
  type OidcAuthorizeRequestValidationResult,
} from "../lib/oidc-authorize-request";
import { getTokenFromReq, getUserFromToken } from "../lib/auth-utils";
import {
  generateAuthorizationCode,
  persistAuthorizationCode,
} from "../lib/oidc-authorization-codes";
import { getActiveConsent } from "../lib/oidc-user-consents";
import { evaluateScopeCreep } from "../lib/oidc-consent-scope-superset";
import { logger } from "../lib/logger";

/**
 * 7c: where a non-first-party client with no active consent is sent
 * before code issuance — the SPA page `artifacts/ayzen/src/pages/
 * oidc-consent.tsx` (7b), mounted at this exact bare, same-origin path.
 * Same "relative path, no separate env var" reasoning as
 * `CENTRAL_LOGIN_PATH` above — this server and the SPA always share an
 * origin.
 */
const CONSENT_PATH = "/oidc/consent";

/**
 * 3b-b: where an unauthenticated request is sent to sign in. A bare,
 * same-origin SPA path (`/login`, `artifacts/ayzen/src/pages/login.tsx`) —
 * this API server and the SPA share an origin in every deployment this
 * codebase targets (see app.ts's static-serving block), so a relative
 * path is correct here and never needs its own env var the way
 * `AYZEN_COOKIE_DOMAIN`/`SYLO_HOSTS` do for genuinely cross-host concerns.
 */
const CENTRAL_LOGIN_PATH = "/login";

const router: IRouter = Router();

/**
 * 3a-g, applied: turns a failing `OidcAuthorizeRequestValidationResult`
 * into an HTTP response. Exported separately from the route handler below
 * so 3a-h's tests can exercise the response-shaping logic itself with a
 * minimal `res` double, same pattern as `well-known-jwks.ts`'s
 * `jwksHandler` / `well-known-openid-configuration.ts`'s
 * `openidConfigurationHandler`.
 *
 * `redirectable: false` results (`invalid_client`, `invalid_redirect_uri`)
 * are rendered directly as a 400 — see `oidc-client-validation.ts`'s
 * header for why these must never become a redirect. `redirectable: true`
 * results carry an already-verified `redirectUri`; those are reported via
 * a 302 redirect back to the client with `?error=...` (and `&state=...`
 * when the original request supplied one — the roadmap's global error
 * model doesn't require echoing state on THIS class of failure, but RFC
 * 6749 §4.1.2.1 does whenever the original request's `state` was
 * available, so it is echoed whenever `raw.state` parsed to something,
 * even for the one failure case where `state` itself was what was
 * missing).
 */
export function respondToAuthorizeFailure(
  res: Response,
  result: Extract<OidcAuthorizeRequestValidationResult, { ok: false }>,
  rawState: string | undefined,
): void {
  if (!result.redirectable) {
    res.status(400).json({ error: result.error });
    return;
  }

  const target = new URL(result.redirectUri);
  target.searchParams.set("error", result.error);
  if (rawState) target.searchParams.set("state", rawState);
  res.redirect(302, target.toString());
}

/**
 * The actual handler logic, exported separately from the router wiring —
 * same reasoning as every other route in this roadmap (`jwksHandler`,
 * `openidConfigurationHandler`): unit-testable with a minimal req/res
 * double instead of a live HTTP server.
 */
export async function authorizeHandler(req: Request, res: Response): Promise<void> {
  const raw = parseOidcAuthorizeRequest(req.query as Record<string, unknown>);

  // oidc.authorize.started — section 5's observability event list. Logged
  // before validation so a malformed/attack request still leaves a trail,
  // not just successfully-validated ones. clientId only (never scope,
  // redirect_uri, or any PKCE/state/nonce value at this log level — none
  // of those are secrets, but there is no need to duplicate the full
  // request into logs when the per-failure warn logs in
  // lib/oidc-authorize-request.ts already capture what's relevant to each
  // rejection reason).
  logger.info({ clientId: raw.clientId }, "oidc.authorize.started");

  const result = await validateOidcAuthorizeRequest(raw);

  if (!result.ok) {
    logger.warn({ clientId: raw.clientId, error: result.error }, "oidc.authorize.denied");
    respondToAuthorizeFailure(res, result, raw.state);
    return;
  }

  // Passed every 3a-a..3a-f check. From here on `result` carries exactly
  // what 3b-d/3b-e/3b-f need: the resolved client, verified redirectUri,
  // scopes, state, nonce, and PKCE challenge/method.

  // 3b-a — Existing Session Detection. Same central-SSO check every other
  // authenticated route in this codebase uses (see file header) — never a
  // second, OIDC-only session mechanism.
  const token = getTokenFromReq(req);
  const session = token ? await getUserFromToken(token) : null;

  if (!session) {
    // 3b-b/3b-c — Central Login Redirect + Return-to State. See file
    // header for why `req.originalUrl` (server-observed, not client-
    // supplied) is what's safe to round-trip here.
    logger.info({ clientId: result.client.clientId }, "oidc.authorize.login_required");
    const loginUrl = new URL(CENTRAL_LOGIN_PATH, `${req.protocol}://${req.get("host")}`);
    loginUrl.searchParams.set("return_to", req.originalUrl);
    res.redirect(302, loginUrl.toString());
    return;
  }

  // 7c — Consent Gate. First-party clients (every client Season 1-3
  // seeded — Sylo/Ryft/Wisp/Verve/Zynth) never needed a "does the user
  // trust this client" question in the first place (see file header /
  // 7a-7b's own doc) and skip this entirely, same as before this pass. A
  // non-first-party client needs an ACTIVE consent row (7a's
  // `getActiveConsent()`, `revoked_at IS NULL`) for this exact
  // (userId, clientId) pair before a code is ever issued; "never asked"
  // and "asked and revoked" (7d) both read back as `null` here on purpose
  // (see that function's own doc) and both mean the same thing to this
  // route: send the browser to the consent screen.
  //
  // 7e ADDITION: an existing active consent is no longer automatically
  // "sufficient" on its own — `evaluateScopeCreep()` (7e's own pure
  // comparison, `lib/oidc-consent-scope-superset.ts`) checks whether that
  // grant's `grantedScopes` already covers every scope THIS request is
  // asking for. A client that was granted `openid profile` and is now
  // requesting `openid profile email` gets sent to the consent screen
  // again — `evaluateScopeCreep()` called with `existingConsent === null`
  // (the "never asked" case) naturally reports every requested scope as
  // new via the same code path, so the two cases (`null` consent, and a
  // consent that no longer covers this request) share one branch below
  // instead of needing separate handling. `/oidc/consent/info`'s own
  // handler (7b, updated this pass) re-runs the identical comparison to
  // decide which scopes to highlight — this route only needs the
  // boolean, not the detail, since all it does here is decide whether to
  // redirect at all.
  //
  // The redirect target re-uses `req.originalUrl` exactly like 3b-b/3b-c's
  // login redirect above — this route's own already-validated request,
  // never a client-supplied value — as `returnTo`, the identical
  // "the URL IS the preserved transaction" mechanism `/oidc/consent`'s
  // own Allow handler (7b) hands back as `resumeUrl` to resume here.
  if (!result.client.isFirstParty) {
    const consent = await getActiveConsent(session.userId, result.client.clientId);
    const { isSuperset } = evaluateScopeCreep(consent?.grantedScopes ?? [], result.scopes);
    if (!isSuperset) {
      logger.info({ clientId: result.client.clientId }, "oidc.authorize.consent_required");
      const consentUrl = new URL(CONSENT_PATH, `${req.protocol}://${req.get("host")}`);
      consentUrl.searchParams.set("returnTo", req.originalUrl);
      res.redirect(302, consentUrl.toString());
      return;
    }
  }

  // 3b-d — Code Generation.
  const rawCode = generateAuthorizationCode();

  // 3b-e — Code Persistence, bound to this authorize request. A failed
  // persist must not proceed to a callback with a `code` the token
  // endpoint could never redeem (see persistAuthorizationCode()'s own doc
  // comment) — reported as `server_error`. Not in section 4's enumerated
  // list (which is entirely about REQUEST-shape errors: invalid_request,
  // invalid_client, ...), but it is RFC 6749 §4.1.2.1's own standard code
  // for exactly this case ("the provider itself failed, not anything the
  // client sent") — the same "use standard OAuth/OIDC-style errors,
  // don't invent a different contract per endpoint" principle section 4
  // states, applied to the one failure mode that list didn't need to
  // enumerate because it isn't about the request.
  const persisted = await persistAuthorizationCode(rawCode, {
    clientId: result.client.clientId,
    redirectUri: result.redirectUri,
    userId: session.userId,
    scopes: result.scopes,
    codeChallenge: result.codeChallenge,
    codeChallengeMethod: result.codeChallengeMethod,
    nonce: result.nonce,
  });

  if (!persisted) {
    logger.warn({ clientId: result.client.clientId }, "oidc.authorize.denied");
    const target = new URL(result.redirectUri);
    target.searchParams.set("error", "server_error");
    target.searchParams.set("state", result.state);
    res.redirect(302, target.toString());
    return;
  }

  // 3b-f — Code Callback. Return code + state to the exact validated
  // redirect URI — same URL-object shape respondToAuthorizeFailure() uses
  // for its own redirects, never a hand-built query string.
  logger.info({ clientId: result.client.clientId }, "oidc.code.issued");
  const callback = new URL(result.redirectUri);
  callback.searchParams.set("code", rawCode);
  callback.searchParams.set("state", result.state);
  res.redirect(302, callback.toString());
}

router.get("/oidc/authorize", authLimiter, authorizeHandler);

export default router;
