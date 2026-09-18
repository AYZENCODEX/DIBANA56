/**
 * routes/oidc-register.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 4, Phase 8a: Dynamic Client Registration
 * (RFC 7591-স্কোপড-ডাউন).
 *
 * `POST /oidc/register` — a third party registers itself as an OIDC
 * client without any AYZEN account or login, exactly like standard OIDC
 * Dynamic Client Registration (RFC 7591). Body: `client_name`,
 * `redirect_uris[]`, `scope` (space-delimited). Response: `client_id`,
 * `client_secret` (plaintext, this once, never retrievable again),
 * `registration_access_token` (Phase 8e, also plaintext-once — see below),
 * `client_id_issued_at` (RFC 7591 §3.2.1's own NumericDate — seconds since
 * epoch).
 *
 * Composition, same "route composes, libs do one thing each" split every
 * other OIDC route in this roadmap uses:
 *   1. `validateOidcClientRegistrationRequest()` (`lib/oidc-client-registration-request.ts`)
 *      — pure, DB-free request validation (now 8d-hardened — see that
 *      file's own header).
 *   2. `createOidcClient()` (`lib/oidc-client-registration.ts`) — generates
 *      `client_id`/`client_secret`/`registration_access_token`, hashes
 *      both secrets, inserts the row.
 *
 * Scope discipline (this is 8a/8c/8d/8e, not 8b — 8b's own text explains
 * why it added no code of its own):
 *   - `registration_status`/pending-approval gate — 8c (migration 091) —
 *     `createOidcClient()` writes every new client as `'pending'`, and
 *     `lib/oidc-client-validation.ts`'s `validateOidcClientId()` rejects
 *     anything not `'approved'` on every `/oidc/authorize`/`/oidc/token`
 *     request. A client THIS route creates is therefore NOT immediately
 *     usable — it needs Phase 9d's (not yet built) admin approval first.
 *     This route has no approval UI/endpoint of its own; it only creates
 *     the `'pending'` row.
 *   - Dedicated per-IP-per-hour registration rate limit — 8c:
 *     `oidcClientRegistrationLimiter` (`middlewares/security.ts`), applied
 *     ONLY to `POST /oidc/register` (creating a new row is the expensive,
 *     abusable action this limiter targets — see its own comment). The
 *     new 8e routes below use `authLimiter` instead — see their own note.
 *   - Stricter redirect_uri policy (https-only w/ localhost dev exception,
 *     no wildcard, no path-traversal, no fragment) — 8d, enforced entirely
 *     inside `validateOidcClientRegistrationRequest()`
 *     (`lib/oidc-client-registration-request.ts`) / its sibling
 *     `validateOidcClientRegistrationUpdateRequest()` for the PUT route
 *     below. This route does no policy-checking of its own.
 *   - `registration_access_token` / self-management — 8e, THIS pass: see
 *     the `GET`/`PUT /oidc/register/:client_id` handlers below.
 *
 * AUTH: `POST /oidc/register` itself is unauthenticated — deliberately.
 * This is the one `/oidc/*` route in this entire roadmap that must NOT
 * require an AYZEN session, matching 8a's own roadmap text verbatim ("এই
 * endpoint bare-origin (public, unauthenticated) — কোনো AYZEN login লাগে
 * না রেজিস্টার করতে, স্ট্যান্ডার্ড OIDC Dynamic Client Registration-এর
 * মতোই"). The new `GET`/`PUT /oidc/register/:client_id` routes (8e) are
 * ALSO unauthenticated in the AYZEN-session sense — no `requireAuth` — but
 * are gated by a bearer `registration_access_token` instead (RFC 7592's
 * own model: possession of the token issued at registration time IS the
 * credential, there is no AYZEN account behind any of this). Every other
 * `/oidc/*` route in this codebase either serves a browser mid-login-flow
 * (`/oidc/authorize`) or requires `requireAuth`
 * (`/oidc/consent/*`, `/oidc/connected-apps*`) — this file's three routes
 * are neither, by design.
 *
 * MOUNTING: bare origin, not under `/api` — same reasoning
 * `routes/oidc-authorize.ts`'s own header gives for that convention: a
 * generic OIDC client library constructs `${issuer}/oidc/register(/...)`
 * directly, never through this deployment's own `/api` surface, and is
 * never expected to carry this deployment's internal API key.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { oidcClientRegistrationLimiter, authLimiter } from "../middlewares/security";
import {
  validateOidcClientRegistrationRequest,
  validateOidcClientRegistrationUpdateRequest,
} from "../lib/oidc-client-registration-request";
import { createOidcClient, updateOidcClientRegistration } from "../lib/oidc-client-registration";
import { getOidcClientById } from "../lib/oidc-clients";
import { validateOidcClientRegistrationAccessToken } from "../lib/oidc-client-validation";
import { logger } from "../lib/logger";

const router: IRouter = Router();

/**
 * Phase 8e: extracts a `Bearer <token>` value from `Authorization`, same
 * `"Bearer "`-prefix-strip convention `lib/auth-utils.ts`'s own session/API-key
 * resolution already uses — reused here rather than re-deriving a second
 * parsing convention for what is, mechanically, the same header. Returns
 * `null` (never throws) for a missing header, a non-`Bearer` scheme, or an
 * empty token — every one of which is "no usable credential presented,"
 * indistinguishable to this route's callers below.
 */
function extractBearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
}

router.post("/oidc/register", oidcClientRegistrationLimiter, async (req: Request, res: Response) => {
  const result = validateOidcClientRegistrationRequest(req.body);
  if (!result.ok) {
    logger.warn({ field: result.field, error: result.error }, "oidc.register.denied");
    res.status(400).json({ error: result.error });
    return;
  }

  const created = await createOidcClient(result.clientName, result.redirectUris, result.scopes);
  if (!created) {
    logger.warn({ clientName: result.clientName }, "oidc.register.denied");
    res.status(500).json({ error: "server_error" });
    return;
  }

  res.status(201).json({
    client_id: created.clientId,
    client_secret: created.clientSecret,
    // Phase 8e — plaintext, this once, never retrievable again (there is
    // no "forgot my registration_access_token" recovery path, same as
    // there is none for client_secret; losing it means re-registering).
    registration_access_token: created.registrationAccessToken,
    client_id_issued_at: Math.floor(created.clientIdIssuedAt.getTime() / 1000),
  });
});

/**
 * Phase 8e — RFC 7592-স্কোপড-ডাউন Client Read.
 *
 * `authLimiter` (not `oidcClientRegistrationLimiter`): this route doesn't
 * create a new row (the abuse `oidcClientRegistrationLimiter` was built
 * for — junk `oidc_clients` rows), it's a credential-guessing surface
 * instead (repeatedly trying bearer tokens against a known/guessed
 * `client_id`) — exactly the class of endpoint `authLimiter`'s own comment
 * names ("the endpoints attackers brute-force"), reused rather than
 * inventing a third limiter for a third kind of abuse.
 *
 * Unknown `client_id` and a wrong/missing token both collapse to the same
 * `401 { error: "invalid_token" }` — never a `404` for an unknown
 * `client_id` — so this endpoint can never be used to enumerate which
 * `client_id`s exist by timing/status-code alone.
 */
router.get("/oidc/register/:client_id", authLimiter, async (req: Request, res: Response) => {
  const clientId = req.params.client_id;
  const token = extractBearerToken(req);
  const client = token ? await getOidcClientById(clientId) : null;

  if (!client || !token || !validateOidcClientRegistrationAccessToken(client, token).ok) {
    res.status(401).json({ error: "invalid_token" });
    return;
  }

  res.status(200).json({
    client_id: client.clientId,
    client_name: client.clientName,
    redirect_uris: client.redirectUris,
    client_id_issued_at: Math.floor(client.createdAt.getTime() / 1000),
  });
});

/**
 * Phase 8e — RFC 7592-স্কোপড-ডাউন Client Configuration Update.
 *
 * Body: `client_name`/`redirect_uris`, each optional, at least one
 * required (`validateOidcClientRegistrationUpdateRequest()`'s own "at
 * least one field" check) — `scope` is never read from this body at all,
 * by construction (see that function's own doc comment): a caller cannot
 * escalate `allowed_scopes` through this token no matter what the request
 * body contains, because no code reachable from this route ever looks at
 * a `scope`/`allowed_scopes` key.
 *
 * `redirect_uris`, when present, is held to the SAME 8d policy as initial
 * registration (`isDynamicClientRedirectUriAllowed()`, reused inside
 * `validateOidcClientRegistrationUpdateRequest()`) — a client cannot use
 * this endpoint to update its way to a wildcard/fragment/path-traversal
 * redirect_uri that `POST /oidc/register` would have rejected outright.
 *
 * Same 401-collapse and `authLimiter` reasoning as the `GET` handler
 * above.
 */
router.put("/oidc/register/:client_id", authLimiter, async (req: Request, res: Response) => {
  const clientId = req.params.client_id;
  const token = extractBearerToken(req);
  const client = token ? await getOidcClientById(clientId) : null;

  if (!client || !token || !validateOidcClientRegistrationAccessToken(client, token).ok) {
    res.status(401).json({ error: "invalid_token" });
    return;
  }

  const result = validateOidcClientRegistrationUpdateRequest(req.body);
  if (!result.ok) {
    logger.warn({ clientId, field: result.field, error: result.error }, "oidc.register.update.denied");
    res.status(400).json({ error: result.error });
    return;
  }

  const updated = await updateOidcClientRegistration(clientId, {
    clientName: result.clientName,
    redirectUris: result.redirectUris,
  });
  if (!updated) {
    res.status(500).json({ error: "server_error" });
    return;
  }

  res.status(200).json({
    client_id: updated.clientId,
    client_name: updated.clientName,
    redirect_uris: updated.redirectUris,
    client_id_issued_at: Math.floor(updated.createdAt.getTime() / 1000),
  });
});

export default router;
