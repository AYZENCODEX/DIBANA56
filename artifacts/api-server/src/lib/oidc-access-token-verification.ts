/**
 * lib/oidc-access-token-verification.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 2, Phase 4c-a (Access Token Verification), 4c-b
 * (Subject Extraction), 4c-c (Scope Extraction).
 *
 * "Read an access token `issueOidcAccessToken()` (3c-f) minted, and prove
 * it's genuinely ours, unexpired, and tells you who/what it's for" — this
 * file's only job. `oidc-access-token.ts`'s own header explicitly reserved
 * this: "No VERIFICATION function is exported from this file ... Reading
 * an access token back ... is explicitly Phase 4c-a's task." This is that
 * task.
 *
 * WHY A NEW FILE, NOT `lib/jwt.ts`'s `verifyAuthToken()` REUSED
 * `verifyAuthToken()` verifies this codebase's INTERNAL session cookie
 * token (`AuthTokenPayload`: `userId`/`role`/optional `sid`) and — by
 * design (see that file's own header) — also accepts the legacy
 * kid-less/HS256 grace-period path for those. An OIDC access token
 * (`issueOidcAccessToken()`'s output) is a different artifact: `sub`
 * (string, not `userId` number), `scope` (space-delimited, no `role`), an
 * `aud` claim session tokens never carry, and — critically — it must
 * NEVER be accepted via the HS256/legacy fallback `verifyAuthToken()`
 * exists for; an OIDC access token is always freshly RS256-signed, with no
 * migration-era predecessor format to stay compatible with. Reusing
 * `verifyAuthToken()` would mean either accepting a legacy-format forgery
 * risk that never applied to this artifact, or bolting an OIDC-only branch
 * onto a function every non-OIDC route in this codebase also calls. Same
 * signing/verification KEY material (`lib/jwt-keys.ts`'s
 * `resolveVerificationKeys()`, Phase 1d-b), deliberately different,
 * purpose-built verification function — the same "same key, different
 * artifact" split `oidc-access-token.ts` itself already drew against
 * `signAuthToken()`.
 *
 * SCOPE DISCIPLINE (this is 4c-a/4c-b/4c-c, not 4c-d/4c-e/4c-f):
 *   - No profile/email claim shaping — that's 4c-d/4c-e
 *     (`lib/oidc-userinfo.ts`), a pure claims-composition layer this file
 *     has no opinion on.
 *   - No HTTP route, no `Authorization` header parsing — that's 4c-f
 *     (`routes/oidc-userinfo.ts`). This file only ever receives an
 *     already-extracted raw token string.
 *   - No user lookup — `sub` here is returned as a plain `number`
 *     (RFC 7519 §4.1.2's `sub` is a string on the wire; this file parses
 *     it back to the DB-shaped integer every other part of this codebase
 *     already uses), but whether that id maps to a real, non-banned user
 *     row is 4c-f's job (`routes/oidc-userinfo.ts`), not this file's — the
 *     exact same "verify the token, resolve the user separately" split
 *     `lib/auth-utils.ts`'s `getUserFromToken()` already draws internally
 *     between `verifyAuthToken()` and its own DB re-lookup.
 *
 * 3.3's JWT REQUIREMENTS, APPLIED HERE
 *   - "enforce expected algorithm": `header.alg` must be exactly `"RS256"`
 *     — never HS256, never `"none"`, never absent-and-assumed.
 *   - "validate issuer": `jwt.verify()`'s own `issuer` option, pinned to
 *     `resolveIssuer()` (Phase 1e-d) — a token whose `iss` doesn't match
 *     this exact provider is rejected by the library itself, not by an
 *     after-the-fact string comparison this file could get wrong.
 *   - "validate audience where applicable": see `resolveTokenSubject()`'s
 *     own note below for why "applicable" here means "present", not
 *     "equal to one specific expected client" — this endpoint has no
 *     single expected client to pin `audience` to.
 *   - "validate expiry": `jwt.verify()`'s own default behavior — throws
 *     `TokenExpiredError`, caught below and reported as the same
 *     `invalid_token` reason as every other verification failure (section
 *     4's global error model has no more specific code for "your token
 *     expired" vs. any other reason a token doesn't verify).
 *   - "respect kid": `resolveVerificationKeys(header.kid)` (Phase 1d-b) —
 *     a token whose `kid` doesn't name a real active/retiring key
 *     resolves to zero candidates and is rejected outright, never
 *     retried against an unrelated key.
 *   - "never expose private key material": this file only ever calls
 *     `getActiveKeypair()`/`resolveVerificationKeys()` for PUBLIC keys
 *     (verification), and never touches `privateKey` at all.
 *
 * UPDATE — Season 5, Phase 10a: Introspection Endpoint.
 *
 * `VerifiedOidcAccessToken` now also carries `exp`/`iat` (both unix
 * seconds, read straight off the already-verified `decoded` payload
 * `jwt.verify()` itself stamped — `issueOidcAccessToken()`'s own
 * `expiresIn` option and `jsonwebtoken`'s default `iat` behavior are what
 * put them there in the first place, this file just stops discarding
 * them). Nothing about the VERIFICATION logic above changed for this
 * update — every branch, every rejection reason, the RS256-only/
 * no-legacy-fallback posture, all exactly as 4c-a/4c-b/4c-c left them.
 * The only change is that two fields already present in every
 * successfully-decoded payload are now returned instead of dropped, so
 * `lib/oidc-token-introspection.ts` (10a) can report RFC 7662 §2.2's
 * `exp` claim without this file growing a second decode path or a second
 * verification function. `GET /oidc/userinfo` (4c-f) and
 * `routes/oidc-resource.ts` (4e-a), the two existing callers, are
 * unaffected — both destructure only the fields they already used, and
 * an additive struct field breaks neither.
 */
import jwt from "jsonwebtoken";
import { resolveVerificationKeys } from "./jwt-keys";
import { resolveIssuer } from "./oidc-discovery";
import { parseScopeString } from "./oidc-scope-validation";

/** 4c-b/4c-c composed: everything a caller needs out of a verified access token. */
export interface VerifiedOidcAccessToken {
  userId: number;
  /** `aud` — the client this token was minted for (3c-f). Not itself used to authorize the UserInfo request (see file header), but returned for callers that DO want to log/inspect it. */
  clientId: string;
  scopes: string[];
  /** `exp` — unix seconds, `jsonwebtoken`'s own stamp from `issueOidcAccessToken()`'s `expiresIn`. Added Phase 10a (see file header's UPDATE note) for `lib/oidc-token-introspection.ts`'s RFC 7662 `exp` claim. */
  exp: number;
  /** `iat` — unix seconds, `jsonwebtoken`'s own default stamp. Same Phase 10a addition as `exp` above. */
  iat: number;
}

export type OidcAccessTokenVerificationResult =
  | { ok: true; token: VerifiedOidcAccessToken }
  | { ok: false; reason: "malformed" | "invalid_signature" | "expired" | "invalid_issuer" | "unknown_kid" | "missing_subject" };

/**
 * Reads a JWT's header (`alg`/`kid`) without verifying the signature — used
 * only to decide WHICH key(s) to attempt verification with, same
 * never-trust-before-verify precedent `lib/jwt.ts`'s own (unexported,
 * hence duplicated here rather than imported) `decodeHeader()` helper
 * already set for session tokens.
 */
function decodeHeader(token: string): { alg?: string; kid?: string } | null {
  try {
    const decoded = jwt.decode(token, { complete: true }) as { header?: { alg?: string; kid?: string } } | null;
    return decoded?.header ?? null;
  } catch {
    return null;
  }
}

/**
 * 4c-a/4c-b/4c-c: verify `rawToken` as a genuine, unexpired, correctly-
 * issued OIDC access token, and extract its subject + scopes.
 *
 * RS256-only, no legacy fallback (see file header) — a token whose header
 * `alg` isn't exactly `"RS256"` is rejected immediately as `"malformed"`,
 * before any key lookup is even attempted.
 *
 * AUDIENCE, CONCRETELY: `jwt.verify()` is called WITHOUT an `audience`
 * option. `GET /oidc/userinfo` (4c-f) is not itself scoped to one
 * particular client — any client holding a validly-issued access token for
 * ANY of this provider's registered clients is entitled to call it for the
 * user that token names (this is standard OIDC UserInfo behavior: the
 * endpoint authenticates the BEARER, not a specific audience). What IS
 * still enforced is that `aud` is present and non-empty — every token
 * `issueOidcAccessToken()` mints always sets one (3c-f), so its absence
 * here would mean a malformed or foreign token, not a legitimately-issued
 * one for a different client.
 */
export function verifyOidcAccessToken(rawToken: string): OidcAccessTokenVerificationResult {
  const header = decodeHeader(rawToken);
  if (!header || header.alg !== "RS256") {
    return { ok: false, reason: "malformed" };
  }

  let decoded: Record<string, unknown> | null = null;
  let sawExpiredCandidate = false;
  for (const candidate of resolveVerificationKeys(header.kid)) {
    try {
      decoded = jwt.verify(rawToken, candidate.publicKey, {
        algorithms: ["RS256"],
        issuer: resolveIssuer(),
      }) as Record<string, unknown>;
      break;
    } catch (err) {
      // A key that rejects for EXPIRY (as opposed to a bad signature/
      // issuer) means the token really is this provider's own — just
      // stale — so a later candidate key failing differently shouldn't
      // paper over that with the less specific "unknown_kid"/"invalid_
      // signature" reason. Recorded, not returned immediately: an
      // attacker-controlled token that also happens to look "expired"
      // under the WRONG key still needs to fail signature verification
      // first against every real candidate before this is trusted.
      if (err instanceof jwt.TokenExpiredError) sawExpiredCandidate = true;
      continue;
    }
  }

  if (!decoded) {
    if (resolveVerificationKeys(header.kid).length === 0) {
      return { ok: false, reason: "unknown_kid" };
    }
    if (sawExpiredCandidate) {
      return { ok: false, reason: "expired" };
    }
    return { ok: false, reason: "invalid_signature" };
  }

  const aud = decoded.aud;
  if (typeof aud !== "string" || aud.length === 0) {
    return { ok: false, reason: "malformed" };
  }

  // 4c-b — Subject Extraction. `sub` is always a stringified positive
  // integer on the wire (issueOidcAccessToken()'s own convention, RFC
  // 7519 §4.1.2) — parsed back to the number every other part of this
  // codebase (usersTable.id, AuthTokenPayload.userId, ...) already uses.
  const rawSub = decoded.sub;
  const userId = typeof rawSub === "string" ? Number(rawSub) : NaN;
  if (!Number.isInteger(userId) || userId <= 0) {
    return { ok: false, reason: "missing_subject" };
  }

  // 4c-c — Scope Extraction. `scope` is the same space-delimited encoding
  // `issueOidcAccessToken()` writes it in (RFC 6749 §3.3) — reusing
  // `parseScopeString()` (Phase 2d-a) rather than a second `.split(" ")`
  // keeps exactly one normalization implementation for that format across
  // both the REQUEST side (2d) and this, its TOKEN-side counterpart.
  const rawScope = decoded.scope;
  const scopes = parseScopeString(typeof rawScope === "string" ? rawScope : "");

  // Phase 10a addition (see file header's UPDATE note) — `exp`/`iat` are
  // always numbers on a token that just passed `jwt.verify()` above (that
  // call itself enforces `exp` is a valid, unexpired numeric claim, and
  // `issueOidcAccessToken()` never omits either); `Number(...)` with a
  // `NaN` guard is defensive shape-narrowing only, not a real expected
  // failure mode, same posture the `userId`/`aud` checks above already
  // take for claims this provider's own issuer always sets.
  const exp = typeof decoded.exp === "number" ? decoded.exp : NaN;
  const iat = typeof decoded.iat === "number" ? decoded.iat : NaN;
  if (!Number.isFinite(exp) || !Number.isFinite(iat)) {
    return { ok: false, reason: "malformed" };
  }

  return {
    ok: true,
    token: { userId, clientId: aud, scopes, exp, iat },
  };
}
