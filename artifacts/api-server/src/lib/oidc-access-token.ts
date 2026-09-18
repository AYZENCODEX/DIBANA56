/**
 * lib/oidc-access-token.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 2, Phase 3c-f: Access Token Issuance.
 *
 * "Issue an access token bound to the correct user/client/scope" — this
 * file's only job. Signs with the exact same active RSA keypair
 * `lib/jwt.ts`'s `signAuthToken()` already uses
 * (`getActiveKeypair()`/`kid`, `lib/jwt-keys.ts`, Phase 1a/1d) — one signer
 * for this deployment, not a second keypair invented just for OIDC access
 * tokens.
 *
 * WHY A NEW FUNCTION, NOT `signAuthToken()` REUSED DIRECTLY
 * `signAuthToken()`'s payload shape (`userId`, `role`, optional `sid` tied
 * to a `user_sessions` row) is this codebase's INTERNAL session-cookie
 * token — it has no `aud` (every verifier is this same codebase) and no
 * `scope` (internal routes don't do OAuth-style scope checks). An OIDC
 * access token is a different artifact with different required claims
 * (`aud` bound to the requesting client, `scope` carrying what the
 * authorization code actually granted — section 3.4's "bound to
 * transaction/user" carried forward past redemption) — reusing
 * `signAuthToken()` would mean either overloading its payload type with
 * OIDC-only fields every internal caller would have to ignore, or passing
 * `role`/`sid` values that don't mean anything for an external client.
 * Same signing key, deliberately different, purpose-built payload.
 *
 * SCOPE DISCIPLINE (this is 3c-f, not 4a/4c-a)
 *   - This is an ACCESS token, not an ID token. `sub`/`iss`/`aud`/`exp`/
 *     `iat` claim assembly for an ID token is Phase 4a's own explicit task
 *     list (4a-a..4a-g) — a separate artifact with its own claim builder,
 *     not something this file produces as a side effect. Nothing here is
 *     returned as `id_token`.
 *   - No VERIFICATION function is exported from this file. Reading an
 *     access token back (`GET /oidc/userinfo`'s "Access Token Verification")
 *     is explicitly Phase 4c-a's task, not 3c-f's — writing that now would
 *     be implementing 4c-a ahead of Phase 4, which the roadmap's "no
 *     speculative implementation of future phases" rule (section 1.4) says
 *     not to do. `jwt.verify()` against this codebase's own published
 *     JWKS is a completely mechanical operation whenever Phase 4c-a is
 *     ready to add it — this file deliberately leaves that door open
 *     (RS256 + `kid` + standard `aud`/`iss`/`exp` claims) without walking
 *     through it itself.
 *
 * EXPIRY: 60 MINUTES
 * Not specified by the roadmap's 3c-f task text itself, so this picks the
 * same "what do real providers actually converge on" reasoning
 * `AUTHORIZATION_CODE_TTL_MS` (3b-g, `lib/oidc-authorization-codes.ts`)
 * already used: Google/Okta/Auth0 access tokens are commonly ~1 hour,
 * short enough to bound how long a leaked bearer token stays useful, long
 * enough that a client isn't forced to re-authenticate constantly before
 * Phase 3e's refresh-token baseline exists to smooth that over.
 */
import jwt from "jsonwebtoken";
import { getActiveKeypair } from "./jwt-keys";
import { resolveIssuer } from "./oidc-discovery";

/** 60 minutes, in seconds — `jsonwebtoken`'s `expiresIn` option and the OAuth `expires_in` response field are both conventionally seconds, unlike `AUTHORIZATION_CODE_TTL_MS`'s milliseconds (`lib/oidc-authorization-codes.ts`, a plain `Date` arithmetic constant, not a `jsonwebtoken` option). */
export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;

/** Everything an access token must be bound to, per this sub-phase's own task text — user, client, scope. */
export interface OidcAccessTokenBinding {
  userId: number;
  clientId: string;
  scopes: string[];
}

/** The RFC 6749 §5.1 "successful token response" shape, minus the `id_token`/`refresh_token` fields Phase 4/3e add on top — `routes/oidc-token.ts` (3c) returns exactly this on success. */
export interface IssuedOidcAccessToken {
  accessToken: string;
  tokenType: "Bearer";
  expiresIn: number;
  scope: string;
}

/**
 * 3c-f: sign and return a bearer access token for `binding`.
 *
 * Claims:
 *   - `sub`: the bound user, stringified — JWT `sub` is conventionally a
 *     string per RFC 7519 §4.1.2, even though `userId` is a DB integer
 *     everywhere else in this codebase.
 *   - `scope`: space-delimited, OAuth's own conventional encoding for a
 *     scope list in a token (RFC 6749 §3.3) — not a JSON array, so a
 *     Phase 4c-a verifier can read it with a plain `.split(" ")` the same
 *     way `oidc-scope-validation.ts`'s `parseScopeString()` already reads
 *     the equivalent request-side parameter.
 *   - `aud`: `binding.clientId` — RFC 7519 §4.1.3; lets a future verifier
 *     (4c-a) confirm a token presented to one client's resource route
 *     wasn't actually minted for a different client.
 *   - `iss`: `resolveIssuer()` (Phase 1e-d) — the same issuer identity this
 *     codebase already publishes via `/.well-known/openid-configuration`,
 *     never a second, independently-configured value.
 *   - `exp`/`iat`: via `expiresIn`/`jsonwebtoken`'s own default `iat`
 *     stamping — same mechanism `signAuthToken()` already relies on.
 */
export function issueOidcAccessToken(binding: OidcAccessTokenBinding): IssuedOidcAccessToken {
  const { privateKey, kid } = getActiveKeypair();
  const scope = binding.scopes.join(" ");
  const accessToken = jwt.sign(
    { sub: String(binding.userId), scope },
    privateKey,
    {
      algorithm: "RS256",
      keyid: kid,
      issuer: resolveIssuer(),
      audience: binding.clientId,
      expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    },
  );
  return { accessToken, tokenType: "Bearer", expiresIn: ACCESS_TOKEN_TTL_SECONDS, scope };
}
