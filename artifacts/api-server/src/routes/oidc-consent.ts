/**
 * routes/oidc-consent.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 4, Phase 7b: Consent UI (backend half).
 *
 * `GET /oidc/consent/info`, `POST /oidc/consent/allow`,
 * `POST /oidc/consent/deny` — everything `artifacts/ayzen/src/pages/
 * oidc-consent.tsx` needs to render the consent screen and act on
 * Allow/Deny, WITHOUT this codebase inventing a second "pending authorize
 * transaction" storage mechanism. Every one of these three endpoints takes
 * a single `returnTo` value — the exact same server-observed, never-
 * client-constructed `/oidc/authorize?...` URL `routes/oidc-authorize.ts`'s
 * own `return_to` (3b-b/3b-c) already round-trips through `/login` — and
 * re-parses/re-validates it with the IDENTICAL pipeline `/oidc/authorize`
 * itself uses (`parseOidcAuthorizeRequest()` + `validateOidcAuthorizeRequest()`,
 * Phase 3a). That is the whole trick: this file adds no new "what is this
 * request, is it valid" logic of its own, it only re-asks a question
 * `/oidc/authorize` already knows how to answer, using a URL 7c (later)
 * will be the one to actually construct and redirect a browser to.
 *
 * Scope discipline (this is 7b, not 7a/7c/7d/7e):
 *   - Does not decide WHEN a user gets sent here — no code in this file
 *     redirects `/oidc/authorize` traffic to `/oidc/consent`; that hook
 *     lives in `routes/oidc-authorize.ts` (7c, now wired: a non-first-
 *     party client with no active consent row, OR one whose existing
 *     consent no longer covers every requested scope (7e's own scope-creep
 *     check), is sent here right after 3b-a's session check, before 3b-d's
 *     code issuance). This file still doesn't decide that itself — it only
 *     re-validates the same request 7c already routed here, same as
 *     before.
 *   - Allow (`POST /oidc/consent/allow`) DOES call 7a's `grantConsent()`
 *     — see that file's own header for why the write function itself
 *     lives in 7a while the route composing "validate, then write" is
 *     7b's own deliverable, same "lib persists, route decides when"
 *     split every earlier OIDC route/lib pair in this roadmap uses. It
 *     deliberately does NOT itself mint an authorization code or touch
 *     `oidc_authorization_codes` — resuming the actual code-issuance flow
 *     happens by handing the browser back to the exact same
 *     `/oidc/authorize?...` URL it started from (`resumeUrl` in the
 *     response below), the identical "the URL IS the preserved
 *     transaction" mechanism `/login`'s own `return_to` already uses.
 *     A second visit to `/oidc/authorize` for the same client now skips
 *     straight past this screen instead, because 7c's own short-circuit
 *     (`getActiveConsent()` + 7e's `evaluateScopeCreep()`, right there in
 *     that route) sees the row this Allow handler just wrote and confirms
 *     it already covers whatever gets requested next.
 *   - No revoke, no consent listing — 7d.
 *   - `GET /oidc/consent/info` (below) DOES now report scope-creep
 *     information (7e, this pass) — see that handler's own comment. The
 *     Allow handler itself is UNCHANGED by 7e: every Allow here still
 *     always grants exactly the scopes THIS request asked for (already
 *     validated by `validateOidcAuthorizeRequest()`), never a narrowed or
 *     merged set — a re-prompt caused by scope creep asks for (typically)
 *     the union of old+new scopes in the SAME request, so granting exactly
 *     what was requested already produces the correct widened grant with
 *     no special-casing needed here. See `lib/oidc-consent-scope-superset.ts`'s
 *     own header for why this asymmetry ("shrinking never re-prompts,
 *     growing always does") is deliberate.
 *
 * WHY A FIRST-PARTY CLIENT IS REJECTED HERE TOO (belt-and-suspenders)
 * 7c is what will make sure a first-party client's request never reaches
 * this screen at all (first-party clients skip consent entirely, 7c's own
 * text). Because these three routes are independently reachable today
 * (nothing gates them on having come from `/oidc/authorize`'s own
 * decision), each one re-checks `client.isFirstParty` itself and refuses
 * with `consent_not_required` rather than trusting that only 7c's future
 * routing will ever call them — the same "re-validate at this layer too,
 * don't just trust the caller already checked" discipline
 * `validateOidcRedirectUri()` uses for redirect_uri (checked once in 2C,
 * re-verified again inside `oidc-authorize-request.ts`'s composition)
 * rather than a new pattern invented for this file.
 *
 * AUTH: `requireAuth` on all three. The consent screen is, by 7b's own
 * text, something shown "login-এর পরে" (after login) — there is no
 * legitimate anonymous caller for any of these three endpoints. Requiring
 * a session here (rather than trusting that only an already-authenticated
 * page ever calls them) also means `req.user.userId` — never a
 * client-supplied value — is what `grantConsent()` records the grant
 * against.
 *
 * MOUNTING: bare origin, no `apiKeyScopeGate`, `authLimiter` — identical
 * tier to every other `/oidc/*` router in this codebase (see app.ts's own
 * comments on `oidcAuthorizeRouter` etc.) for the identical reason: this
 * is part of the same user-facing login/authorization flow, not this
 * deployment's `/api` surface.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { authLimiter } from "../middlewares/security";
import { requireAuth } from "../middlewares/auth";
import {
  parseOidcAuthorizeRequest,
  validateOidcAuthorizeRequest,
  type RawOidcAuthorizeRequest,
  type OidcAuthorizeRequestValidationResult,
} from "../lib/oidc-authorize-request";
import { describeConsentScopes } from "../lib/oidc-consent-scope-copy";
import { grantConsent, getActiveConsent } from "../lib/oidc-user-consents";
import { evaluateScopeCreep } from "../lib/oidc-consent-scope-superset";
import { logger } from "../lib/logger";

/**
 * The only path prefix ever honored as a `returnTo` value — identical
 * allow-list discipline to `login.tsx`'s own `oidcReturnTo` state (that
 * file only ever accepts a value starting with `/oidc/authorize`, for the
 * same open-redirect reason). A `returnTo` that doesn't start with this
 * is rejected before it's ever parsed as a URL, let alone validated.
 */
const RETURN_TO_PREFIX = "/oidc/authorize";

/**
 * Turns a `returnTo` string back into the same `RawOidcAuthorizeRequest`
 * shape `routes/oidc-authorize.ts` builds from `req.query` — i.e. re-derives
 * exactly what the original `/oidc/authorize` request's query string was,
 * from a value this server itself produced (never one accepted from
 * anywhere else — see `RETURN_TO_PREFIX` above). Returns `null` for
 * anything that isn't a well-formed `/oidc/authorize?...` path, so callers
 * never hand a garbage/absent value on to `validateOidcAuthorizeRequest()`.
 */
export function parseReturnTo(returnTo: unknown): RawOidcAuthorizeRequest | null {
  if (typeof returnTo !== "string" || !returnTo.startsWith(RETURN_TO_PREFIX)) return null;
  let url: URL;
  try {
    // Base is a throwaway placeholder — `returnTo` is always a relative
    // path/query, never itself absolute; only `url.searchParams` is used.
    url = new URL(returnTo, "http://internal.invalid");
  } catch {
    return null;
  }
  const query: Record<string, string> = {};
  for (const [key, value] of url.searchParams.entries()) query[key] = value;
  return parseOidcAuthorizeRequest(query);
}

/** JSON shape for any of the three routes' failure responses — mirrors `OidcAuthorizeRequestValidationResult`'s own failure fields rather than inventing a second error shape, plus this file's own `consent_not_required` case. */
type ConsentRequestFailure =
  | Extract<OidcAuthorizeRequestValidationResult, { ok: false }>
  | { ok: false; redirectable: false; error: "consent_not_required" };

function sendFailure(res: Response, failure: ConsentRequestFailure): void {
  // Every failure this file produces is a 400 — none of them is "the
  // server itself failed" (that's the separate `server_error` case in the
  // Allow handler below, when `grantConsent()` fails).
  res.status(400).json({
    ok: false,
    error: failure.error,
    redirectable: failure.redirectable,
    redirectUri: "redirectUri" in failure ? failure.redirectUri : undefined,
  });
}

/**
 * Shared first three steps for all three routes: parse `returnTo`,
 * re-validate it exactly like `/oidc/authorize` would, and reject a
 * first-party client (see file header). Returns the successful
 * `OidcAuthorizeRequestValidationResult` (`ok: true`) or `null` after
 * already having written the failure response itself, so callers can
 * `if (!result) return;`.
 */
async function resolveConsentRequest(
  req: Request,
  res: Response,
): Promise<Extract<OidcAuthorizeRequestValidationResult, { ok: true }> | null> {
  const returnTo = (req.method === "GET" ? req.query.returnTo : req.body?.returnTo) as unknown;
  const raw = parseReturnTo(returnTo);
  if (!raw) {
    res.status(400).json({ ok: false, error: "invalid_request", redirectable: false });
    return null;
  }

  const result = await validateOidcAuthorizeRequest(raw);
  if (!result.ok) {
    sendFailure(res, result);
    return null;
  }

  if (result.client.isFirstParty) {
    logger.warn(
      { clientId: result.client.clientId },
      "[oidc-consent] consent screen requested for a first-party client, rejected",
    );
    sendFailure(res, { ok: false, redirectable: false, error: "consent_not_required" });
    return null;
  }

  return result;
}

const router: IRouter = Router();

/**
 * 7b: what the consent screen renders. Deliberately returns a sanitized
 * projection, never the raw `OidcClient` row — `client.clientSecretHash`
 * must never reach a browser response (this roadmap's global "do not log
 * (or expose) client secrets" rule, same discipline `lib/oidc-clients.ts`'s
 * own header states for logging).
 *
 * `clientDisplayName` falls back to the raw `client_id` — `oidc_clients`
 * has no display-name column as of this pass (Season 1-3's schema only
 * ever needed `client_id` as an internal identifier; Season 4/5's own
 * roadmap text for 7a lists exactly five new columns, none of them a
 * name). `scripts/src/seed-oidc-clients.ts`'s `label` field is a
 * seed-script-only display string, never written to the DB, so it isn't
 * reachable from here either. A real per-client display name is
 * Phase 8a's own concern (dynamic registration's request body carries a
 * `client_name` the roadmap explicitly names) — showing the bare
 * `client_id` here now is an honest placeholder, not a bug this pass is
 * pretending doesn't exist.
 *
 * 7e ADDITION: also looks up this user's existing active consent
 * (`getActiveConsent()`, 7a) for this same client and runs it through
 * `evaluateScopeCreep()` (7e's own pure comparison) against the scopes
 * THIS request is asking for. `isReprompt` tells the frontend whether this
 * is a first-time grant or a widen-of-an-existing-grant screen (so it can
 * change the heading copy — see `pages/oidc-consent.tsx`'s own update);
 * each entry in `scopes` carries `isNew`, so the screen can highlight only
 * the scopes that weren't already granted, per 7e's own roadmap text
 * ("শুধু নতুন scope-গুলো হাইলাইট করে"). When there is no existing consent
 * at all, `getActiveConsent()` returns `null`, `evaluateScopeCreep([],
 * requested)` correctly reports every scope as new (see that function's
 * own header), and `isReprompt` is `false` — the ordinary first-time-grant
 * screen, unchanged in substance from what 7b originally shipped.
 */
router.get("/oidc/consent/info", authLimiter, requireAuth, async (req: Request, res: Response) => {
  const result = await resolveConsentRequest(req, res);
  if (!result) return;

  const userId = req.user!.userId;
  const existingConsent = await getActiveConsent(userId, result.client.clientId);
  const { newScopes } = evaluateScopeCreep(existingConsent?.grantedScopes ?? [], result.scopes);
  const newScopeSet = new Set(newScopes);

  res.json({
    ok: true,
    clientId: result.client.clientId,
    clientDisplayName: result.client.clientId,
    scopes: describeConsentScopes(result.scopes).map((scope) => ({
      ...scope,
      isNew: newScopeSet.has(scope.scope),
    })),
    isReprompt: existingConsent !== null,
    state: result.state,
  });
});

/**
 * 7b Allow. Records the grant (7a's `grantConsent()`) against the
 * SESSION's own userId — never a client-supplied one — then hands back
 * `resumeUrl`, the exact same `/oidc/authorize?...` URL this request came
 * from, for the frontend to do a full-page navigation to. See file header
 * for why re-visiting that URL, not minting a code here, is what
 * "continues the flow."
 */
router.post("/oidc/consent/allow", authLimiter, requireAuth, async (req: Request, res: Response) => {
  const result = await resolveConsentRequest(req, res);
  if (!result) return;

  const userId = req.user!.userId;
  const granted = await grantConsent(userId, result.client.clientId, result.scopes);
  if (!granted) {
    logger.warn({ clientId: result.client.clientId, userId }, "[oidc-consent] failed to persist consent grant");
    res.status(500).json({ ok: false, error: "server_error", redirectable: false });
    return;
  }

  logger.info({ clientId: result.client.clientId, userId }, "oidc.consent.granted");
  res.json({ ok: true, resumeUrl: req.body?.returnTo as string });
});

/**
 * 7b Deny. RFC 6749 §4.1.2.1's standard `access_denied` error code,
 * redirected back to the ALREADY-VERIFIED `redirectUri` (never a raw,
 * unchecked value) with `state` echoed when the original request had one
 * — the identical shape `respondToAuthorizeFailure()`
 * (`routes/oidc-authorize.ts`) already uses for every other
 * `/oidc/authorize` failure. Nothing is written to `oidc_user_consents`
 * for a deny — there is no grant to record.
 */
router.post("/oidc/consent/deny", authLimiter, requireAuth, async (req: Request, res: Response) => {
  const result = await resolveConsentRequest(req, res);
  if (!result) return;

  logger.info({ clientId: result.client.clientId, userId: req.user!.userId }, "oidc.consent.denied");
  const target = new URL(result.redirectUri);
  target.searchParams.set("error", "access_denied");
  target.searchParams.set("state", result.state);
  res.json({ ok: true, redirectTo: target.toString() });
});

export default router;
