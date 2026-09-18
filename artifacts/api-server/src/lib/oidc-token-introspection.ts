/**
 * lib/oidc-token-introspection.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 5, Phase 10a: Introspection Endpoint (RFC
 * 7662-scoped-down) — the lookup/classification half.
 *
 * "Given a token string an authenticated client handed us, is it active,
 * and if so, whose is it and what does it grant" — this file's only job.
 * `routes/oidc-introspect.ts` (10a's route half) does the parsing (via
 * `lib/oidc-introspection-request.ts`) and client authentication (via
 * `lib/oidc-token-client-auth.ts`, reused as-is — see that file's own
 * header) before ever calling in here; this file receives an
 * already-authenticated caller's `client_id` and the raw token string,
 * nothing else.
 *
 * NO NEW VERIFICATION/STORAGE LOGIC — TWO EXISTING PRIMITIVES, COMPOSED
 * This provider has exactly two kinds of bearer secret a client could be
 * asking about:
 *   - an access token — `verifyOidcAccessToken()` (Phase 4c-a,
 *     `lib/oidc-access-token-verification.ts`) already proves signature/
 *     issuer/expiry/kid and extracts `sub`/`scope`/`aud`; Phase 10a's own
 *     update to that file (see its header) additionally exposes `exp`/
 *     `iat`, the two claims this file needs that 4c-a's original callers
 *     (`GET /oidc/userinfo`, `GET /oidc/resource/*`) never did.
 *   - a refresh token — `lookupRefreshToken()` (Phase 3e-d,
 *     `lib/oidc-refresh-tokens.ts`) already proves persistence and
 *     returns `clientId`/`userId`/`scopes`/`expiresAt`/`revokedAt`;
 *     `isRefreshTokenExpired()` (3e-b, same file) already answers the one
 *     policy question this file would otherwise have to re-derive.
 * This file adds no third way to mint, store, or verify either artifact —
 * it is a read-only classifier sitting on top of both, exactly the
 * "lib composes, doesn't reinvent" discipline the rest of this roadmap
 * already follows (`routes/oidc-token.ts` composing 3c-b..3e-c is the
 * clearest existing precedent for this same shape).
 *
 * `revoked_at` — READ HERE FOR THE FIRST TIME, WRITTEN BY NOBODY YET
 * `lib/oidc-refresh-tokens.ts`'s own header already documents that
 * nothing in this codebase writes `revoked_at` yet (that's Phase 10b's
 * job). This file reads it anyway (`stored.revokedAt !== null` counts as
 * inactive) purely so that the moment 10b starts writing it, 10a's
 * response is correct with no code change here — the identical
 * forward-compatible-reader posture `lib/oidc-client-validation.ts`'s
 * `validateOidcClientId()` already took reading `registration_status`
 * before Phase 9's approval workflow existed to ever set it away from
 * `'pending'`.
 *
 * WHY A TOKEN'S OWN `client_id`/`aud` MUST MATCH THE INTROSPECTING CLIENT
 * RFC 7662 itself does not mandate this (§2.1 only requires the caller to
 * be an "authorized protected resources" — it leaves what "authorized"
 * means to the deployment). This provider has no separate "resource
 * server" identity distinct from "OIDC client" (every caller of this
 * endpoint authenticates the same way `/oidc/token` callers do, via
 * `lib/oidc-token-client-auth.ts`) and no scope/role that would mark one
 * client as trusted to inspect another's tokens. Absent that concept,
 * letting any authenticated client introspect ANY other client's token
 * would turn this endpoint into exactly the kind of cross-client oracle
 * `lib/oidc-token-client-auth.ts`'s own header already refuses to build
 * for "does this client_id exist" — except worse, because the thing being
 * leaked here would be a real user's session activity (still-valid
 * tokens, their scopes, their expiry) rather than a boolean. So: a
 * syntactically/cryptographically valid token whose own `client_id`
 * doesn't match the authenticated caller is reported `{ active: false }`,
 * identical to a token that doesn't exist at all — RFC 7662 §2.2 itself
 * blesses exactly this non-distinction ("the authorization server MAY
 * respond ... with an HTTP 200 ... {\"active\": false}" for a token it
 * chooses not to describe further, no separate error code required).
 *
 * Scope discipline (this is 10a, not 10b/10c/10d/10e):
 *   - Read-only. Nothing here revokes, deletes, or mutates any row —
 *     `POST /oidc/revoke` (10b) is a separate, not-yet-built endpoint;
 *     this file's only effect on the system is a log line.
 *   - No cascade-by-client, no backchannel logout (10c/10d) — this file
 *     answers one token's question, not "every token this client/user
 *     pair holds."
 *   - No discovery-metadata change (10e) — `/.well-known/openid-configuration`
 *     advertising `introspection_endpoint` is that sub-phase's own,
 *     separate, single-line addition once this endpoint exists to
 *     advertise; not done in this pass (see this pass's own CHANGES file).
 */
import { verifyOidcAccessToken } from "./oidc-access-token-verification";
import { lookupRefreshToken, isRefreshTokenExpired } from "./oidc-refresh-tokens";
import { hashOidcAccessToken, isAccessTokenRevoked } from "./oidc-token-revocation";
import { logger } from "./logger";

/** RFC 7662 §2.2's active-token response shape, scoped down to the claims this provider can actually populate for either token kind — `sub`/`client_id`/`scope`/`exp`/`iat` all mean the same thing across both branches below, `token_type` is the one field that tells a caller which branch answered. */
export interface OidcIntrospectionActiveResult {
  active: true;
  sub: string;
  client_id: string;
  scope: string;
  token_type: "access_token" | "refresh_token";
  exp: number;
  iat: number;
}

/** RFC 7662 §2.2's inactive-token response shape — deliberately just the one field the RFC requires, never an error code or a reason (see file header for why "wrong client" and "doesn't exist" are indistinguishable on the wire). */
export interface OidcIntrospectionInactiveResult {
  active: false;
}

export type OidcIntrospectionResult = OidcIntrospectionActiveResult | OidcIntrospectionInactiveResult;

const INACTIVE: OidcIntrospectionInactiveResult = { active: false };

/** Pure: `Date` -> unix seconds, the wire format RFC 7519 (and this provider's own access-token claims) already use for `exp`/`iat`. `lib/oidc-refresh-tokens.ts` stores these as `Date` columns (`expires_at`/`created_at`), not unix-seconds integers — this is the one conversion needed to describe a refresh token in the same claim vocabulary an access token's JWT already speaks. */
function epochSeconds(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

/**
 * Attempt to classify `token` as an access token belonging to
 * `requestingClientId`.
 *
 * Returns `null` — not `INACTIVE` — when `token` simply isn't a
 * verifiable access token at all (wrong `alg`, bad signature, unknown
 * `kid`, expired, ...); `null` is this pair of functions' own private
 * "try the other token type next" signal, distinct from a definite
 * `{ active: false }` verdict. Returns `INACTIVE` (not `null`) for a
 * token that verifies fine but names a DIFFERENT client — that is a
 * definite answer (see file header), not a "maybe it's a refresh token
 * instead" case; a value never encodes as both artifacts at once.
 */
async function introspectAsAccessToken(token: string, requestingClientId: string): Promise<OidcIntrospectionResult | null> {
  const verified = verifyOidcAccessToken(token);
  if (!verified.ok) return null;

  if (verified.token.clientId !== requestingClientId) {
    logger.warn(
      { requestingClientId, tokenClientId: verified.token.clientId },
      "[oidc-token-introspection] access token introspected by a client other than its own audience, reporting inactive",
    );
    return INACTIVE;
  }

  // Season 5, Phase 10b — a cryptographically-valid access token can have
  // been explicitly killed via `POST /oidc/revoke` since it was minted;
  // without this check, introspect would keep reporting `active: true`
  // for a token 10b's own endpoint just revoked, which is exactly the
  // "cosmetic revocation" gap this roadmap's Phase 9d/7d notes already
  // criticize elsewhere. See `lib/oidc-token-revocation.ts`'s own header
  // for why this is a separate composed check, not folded into
  // `verifyOidcAccessToken()` itself — this IS the change that makes this
  // function (and therefore both branches of `introspectOidcToken()`'s
  // try-order below) touch the DB, where the access-token branch
  // previously never did; see this file's own UPDATE note near the top.
  if (await isAccessTokenRevoked(hashOidcAccessToken(token))) {
    logger.info(
      { requestingClientId, tokenClientId: verified.token.clientId },
      "[oidc-token-introspection] revoked access token introspected, reporting inactive",
    );
    return INACTIVE;
  }

  return {
    active: true,
    sub: String(verified.token.userId),
    client_id: verified.token.clientId,
    scope: verified.token.scopes.join(" "),
    token_type: "access_token",
    exp: verified.token.exp,
    iat: verified.token.iat,
  };
}

/**
 * Attempt to classify `token` as a refresh token belonging to
 * `requestingClientId`. Same `null` (try the other type) vs. `INACTIVE`
 * (definite verdict) split as `introspectAsAccessToken()` above — see its
 * own doc comment for the full reasoning, identical here.
 */
async function introspectAsRefreshToken(
  token: string,
  requestingClientId: string,
): Promise<OidcIntrospectionResult | null> {
  const stored = await lookupRefreshToken(token);
  if (!stored) return null;

  if (stored.clientId !== requestingClientId) {
    logger.warn(
      { requestingClientId, tokenClientId: stored.clientId },
      "[oidc-token-introspection] refresh token introspected by a client other than its own owner, reporting inactive",
    );
    return INACTIVE;
  }

  if (stored.revokedAt !== null || isRefreshTokenExpired(stored.expiresAt)) {
    return INACTIVE;
  }

  return {
    active: true,
    sub: String(stored.userId),
    client_id: stored.clientId,
    scope: stored.scopes.join(" "),
    token_type: "refresh_token",
    exp: epochSeconds(stored.expiresAt),
    iat: epochSeconds(stored.createdAt),
  };
}

/**
 * 10a: `POST /oidc/introspect`'s whole answer, everything after client
 * auth. `tokenTypeHint` is RFC 7662 §2.1's own optional hint — honored as
 * an ORDERING preference only (try the hinted kind first), never as a
 * hard filter: an absent, wrong, or unrecognized hint still gets a
 * correct answer, it just costs one extra lookup, identical to how RFC
 * 7662 itself describes the hint ("if this parameter is ... not
 * correctly guessed, ... the server MUST NOT be required to determine
 * the token type on the first attempt, and, therefore, must also be able
 * to search across its various stores").
 *
 * `requestingClientId` is the ALREADY-AUTHENTICATED caller's `client_id`
 * (`authenticateOidcTokenClient()`'s own output, Phase 3c-b, reused
 * as-is by `routes/oidc-introspect.ts`) — this function does no client
 * authentication of its own, it only uses that identity for the
 * ownership check both branches above apply.
 */
export async function introspectOidcToken(
  token: string,
  tokenTypeHint: string | undefined,
  requestingClientId: string,
): Promise<OidcIntrospectionResult> {
  const tryRefreshFirst = tokenTypeHint === "refresh_token";

  const first = tryRefreshFirst
    ? await introspectAsRefreshToken(token, requestingClientId)
    : introspectAsAccessToken(token, requestingClientId);
  if (first !== null) return first;

  const second = tryRefreshFirst
    ? introspectAsAccessToken(token, requestingClientId)
    : await introspectAsRefreshToken(token, requestingClientId);
  if (second !== null) return second;

  logger.info({ requestingClientId }, "[oidc-token-introspection] token matched neither access nor refresh storage, reporting inactive");
  return INACTIVE;
}
