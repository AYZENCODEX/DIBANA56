/**
 * lib/oidc-id-token.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 2, Phase 4a (ID Token Claims) + Phase 4b (Nonce
 * Binding).
 *
 * "Build the claim set an ID token must carry, sign it with the same active
 * RS256 keypair every other token in this codebase uses, and carry the
 * nonce a client bound to its authorization request through untouched" —
 * this file's only job.
 *
 * WHY A NEW FILE, NOT `oidc-access-token.ts` EXTENDED
 * `issueOidcAccessToken()` (3c-f) already explicitly reserved this split in
 * its own header: an ID token is a different artifact from an access
 * token — its `sub`/`iss`/`aud`/`exp`/`iat` claim assembly is "Phase 4a's
 * own explicit task list ... a separate artifact with its own claim
 * builder, not something [oidc-access-token.ts] produces as a side
 * effect." An ID token also carries `nonce` (4b), which an access token
 * never does, and is meant to be read by the CLIENT itself (RFC 7519
 * decoded, not necessarily verified against a resource server) rather than
 * presented back to this provider as a bearer credential — different
 * consumer, different claim shape, same signing key.
 *
 * 4A — CLAIM BUILDER, SPLIT PURE/SIGNED (same shape as 3c-f)
 *   `buildIdTokenClaims()` is the pure claim-assembly step (4a-a..4a-e,
 *   4b-b/4b-c) — no I/O, no signing, takes `now` as a parameter so it's
 *   unit-testable without racing the real clock (same discipline
 *   `computeAuthorizationCodeExpiry()`, `oidc-authorization-codes.ts`,
 *   already uses). `issueOidcIdToken()` (4a-f) is the thin signing
 *   wrapper around it — the ONLY function in this file that touches
 *   `getActiveKeypair()`'s private key material.
 *
 * 4B — NONCE, CONCRETELY
 *   `oidc_authorization_codes.nonce` (migration 080, persisted by
 *   `persistAuthorizationCode()` — 3b-e already modeled this column; 4b-a
 *   is complete as of that migration, not new work here) is `string |
 *   null`: `null` when the client's original `/oidc/authorize` request
 *   omitted `nonce` entirely (OIDC Core §3.1.2.1: REQUIRED for the
 *   implicit/hybrid flows this provider never supports — Authorization
 *   Code flow only, §3.1.2.1's own text — so this provider treats it as
 *   OPTIONAL, matching what it actually enforces at 3a-e). `nonce` MUST be
 *   returned in the ID Token "if present in the Authentication Request"
 *   (§2) and MUST NOT appear at all otherwise — not as `null`, not as
 *   `""`. `resolveIdTokenNonce()` is that one-line rule, factored out so
 *   `buildIdTokenClaims()` and any future caller share exactly one
 *   `null`-to-"omit the key" conversion rather than two independently
 *   written ones.
 *
 *   4B-C "MISMATCH HANDLING": there is no separate mismatch check to write
 *   here. The roadmap's 4b-c line describes a hazard this file structurally
 *   cannot produce: `buildIdTokenClaims()` takes the SAME
 *   `{ userId, clientId, nonce }` binding `routes/oidc-token.ts` already
 *   reads straight off `consumption.code` — the single-use-consumed,
 *   binding-checked row `checkAuthorizationCodeBinding()` (3c-d) already
 *   validated for THIS exchange. There is no second, independently-supplied
 *   nonce value anywhere in this call path for the persisted one to be
 *   compared against or "mismatch" from — the nonce an ID token carries is
 *   definitionally the nonce its own authorization code was persisted
 *   with. What 4b-c protects against is therefore proven structurally
 *   (one binding in, one claims object out, nothing else consulted) and by
 *   the 4b-d replay tests below (identical binding twice -> identical
 *   claims; two distinct bindings -> each keeps only its own nonce).
 *
 * WHAT'S DELIBERATELY NOT HERE
 *   - No route, no `openid`-scope gate deciding WHETHER to call this file
 *     at all — that's `routes/oidc-token.ts` (already wired: it only calls
 *     `issueOidcIdToken()` when the redeemed code's scopes include
 *     `"openid"`, per OIDC Core §3.1.3.3).
 *   - No ID-token VERIFICATION function — nothing in this OIDC provider's
 *     own routes ever needs to verify an ID token it issued (that's the
 *     client's job, against this provider's own published JWKS); adding
 *     one here would be speculative, unused surface area.
 *
 * UPDATE — Season 3, Phase 6a-b (id_token_hint)
 * The claim directly above no longer holds. RP-Initiated Logout 1.0's
 * `end_session_endpoint` (routes/oidc-logout.ts) accepts an
 * `id_token_hint` — an ID token THIS provider issued, handed back to it —
 * and needs to verify that hint is a genuine, unmodified token of this
 * provider's own before trusting the `sub`/`aud` it carries to identify
 * which user/client a logout request is about. That is a real, concrete
 * caller, not a speculative one. `verifyIdTokenHint()` below is that
 * verification function, added now that it has an actual use.
 */
import jwt from "jsonwebtoken";
import { getActiveKeypair, resolveVerificationKeys } from "./jwt-keys";
import { resolveIssuer } from "./oidc-discovery";

/**
 * 4a-e: ID token lifetime. 60 minutes — mirrors `ACCESS_TOKEN_TTL_SECONDS`
 * (`oidc-access-token.ts`, 3c-f) for the identical reason that file already
 * gives: short enough to bound how long a leaked/logged ID token stays
 * useful, long enough that a client parsing it once at login doesn't need
 * to worry about clock skew tripping `exp` mid-read. An ID token is not a
 * bearer credential re-presented on every request the way an access token
 * is (RFC 7519/OIDC Core give it no equivalent to a refresh flow), so
 * there is no reason for its lifetime to differ from the access token
 * issued alongside it in the same `POST /oidc/token` response.
 */
export const ID_TOKEN_TTL_SECONDS = 60 * 60;

/** Everything an ID token must be bound to — the exact fields `routes/oidc-token.ts` already has in hand from the redeemed authorization code (`consumption.code`) once client auth + PKCE have passed. */
export interface OidcIdTokenBinding {
  userId: number;
  clientId: string;
  /** The exact value `oidc_authorization_codes.nonce` was persisted with for this code (3b-e) — `null` when the original `/oidc/authorize` request had none. Passed straight through, never re-derived here. */
  nonce: string | null;
}

/** 4a-a composed: the RFC 7519 / OIDC Core §2 claim set every ID token this provider issues carries. `nonce` is intentionally OPTIONAL on the type (not `string | null`) — see `resolveIdTokenNonce()` below for why the claims object must never carry a `null` nonce on the wire. */
export interface IdTokenClaims {
  /** 4a-b: the authenticated user, stringified (RFC 7519 §4.1.2 — `sub` is conventionally a string, even though `userId` is a DB integer everywhere else in this codebase; same convention `issueOidcAccessToken()` already uses). */
  sub: string;
  /** 4a-c: this provider's own issuer identity — always `resolveIssuer()` (Phase 1e-d), never a second, independently-configured value. */
  iss: string;
  /** 4a-d: the requesting client — RFC 7519 §4.1.3. */
  aud: string;
  /** 4a-e */
  iat: number;
  /** 4a-e */
  exp: number;
  nonce?: string;
}

/**
 * 4b-b/4b-c: the ONE `null`-to-"omit the claim" rule for a persisted
 * nonce. `null` (no nonce was ever bound to this authorization code)
 * resolves to `undefined` — never passed through as a literal `null`,
 * which `buildIdTokenClaims()` below relies on to decide whether the
 * `nonce` key belongs in the claims object at all (a `JSON.stringify`'d
 * `undefined` property is dropped; a `null` one is not).
 */
export function resolveIdTokenNonce(nonce: string | null): string | undefined {
  return nonce === null ? undefined : nonce;
}

/**
 * 4a-a..4a-e, 4b-b: pure claim assembly, no signing, no I/O. `now` defaults
 * to the real clock but takes an explicit `Date` so callers (and
 * `issueOidcIdToken()` itself, and this file's own tests) can pin `iat`/
 * `exp` deterministically — same discipline `computeAuthorizationCodeExpiry()`
 * already established for the equivalent authorization-code TTL math.
 *
 * The `nonce` key is added via a conditional spread, not
 * `nonce: resolveIdTokenNonce(binding.nonce)` assigned directly — assigning
 * `undefined` to a key still creates that key (`"nonce" in claims` would be
 * `true`), which is exactly the "not null, not ''" wire behavior 4b-c
 * forbids. The spread is the one construction that structurally cannot
 * produce a `nonce` key when there is nothing to carry.
 */
export function buildIdTokenClaims(binding: OidcIdTokenBinding, now: Date = new Date()): IdTokenClaims {
  const iat = Math.floor(now.getTime() / 1000);
  const exp = iat + ID_TOKEN_TTL_SECONDS;
  const nonce = resolveIdTokenNonce(binding.nonce);

  return {
    sub: String(binding.userId),
    iss: resolveIssuer(),
    aud: binding.clientId,
    iat,
    exp,
    ...(nonce !== undefined ? { nonce } : {}),
  };
}

/**
 * 4a-f: sign `buildIdTokenClaims(binding, now)` with the same active RS256
 * keypair (`getActiveKeypair()`, Phase 1a/1d) every other token in this
 * codebase uses — RS256 + `kid`, never HS256, never keyless, same as
 * `issueOidcAccessToken()` (3c-f).
 *
 * `noTimestamp: true` + signing the already-built claims object directly
 * (rather than passing `expiresIn`/`issuer`/`audience` as `jwt.sign()`
 * options) is deliberate: the claims object already carries `iat`/`exp`/
 * `iss`/`aud` from `buildIdTokenClaims()`, and `jsonwebtoken` throws if a
 * payload already defines a claim an option would also set. This also
 * guarantees the signed token's claims are byte-for-byte
 * `buildIdTokenClaims()`'s own output — there is no second, parallel path
 * that could compute `iat`/`exp` differently between the pure builder and
 * what actually gets signed.
 */
export function issueOidcIdToken(binding: OidcIdTokenBinding, now: Date = new Date()): string {
  const { privateKey, kid } = getActiveKeypair();
  const claims = buildIdTokenClaims(binding, now);
  return jwt.sign(claims, privateKey, {
    algorithm: "RS256",
    keyid: kid,
    noTimestamp: true,
  });
}

// ─── 6a-b: id_token_hint verification ───────────────────────────────────────

/** The subset of `IdTokenClaims` `verifyIdTokenHint()` hands back to a caller — just enough to identify which client/user a logout request's hint is about. */
export interface IdTokenHintClaims {
  sub: string;
  aud: string;
}

/**
 * Reads a JWT's header (`alg`/`kid`) without verifying the signature — used
 * only to decide WHICH key(s) to attempt verification with, never to trust
 * any claim in the token. Identical in shape and purpose to lib/jwt.ts's
 * own private `decodeHeader()` (Phase 1D-b) — duplicated rather than
 * imported since that one is intentionally unexported (session-token
 * verification internals), and this file's own `now`-parameterization
 * discipline already keeps it dependency-free of lib/jwt.ts.
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
 * 6a-b: verifies an `id_token_hint` is a genuine ID token this provider
 * itself issued, and returns its `sub`/`aud` if so.
 *
 * WHY `ignoreExpiration: true`
 * An ID token is typically still in the browser's hands well past its own
 * `exp` by the time the user clicks "sign out" — OIDC RP-Initiated Logout
 * 1.0 §2 only says a relying party "SHOULD NOT" send an already-expired
 * hint, not that the OP must reject one. The hint's job here is narrowly
 * "prove this really is a token this provider signed, so its `sub`/`aud`
 * can be trusted to identify the logout request's user/client" — signature
 * validity, not liveness, is what that requires. (Compare
 * `verifyAuthToken()` in lib/jwt.ts, which correctly DOES enforce `exp`:
 * that token is a live bearer credential being used to access something
 * right now. An `id_token_hint` is not re-used as a credential anywhere —
 * `routes/oidc-logout.ts` never accepts it as authorization to act, only
 * as a claim to corroborate against the caller's own separately-verified
 * session cookie/bearer token.)
 *
 * `kid`-based lookup uses the identical `resolveVerificationKeys(kid)`
 * (Phase 1D-b) every other verifier in this codebase uses — a `kid` that
 * doesn't resolve to a current active/retiring key yields zero candidates,
 * same "unknown kid fails safely, never falls back to an unrelated key"
 * guarantee `tryVerifyRs256()` (lib/jwt.ts) already established. `iss` is
 * checked explicitly against `resolveIssuer()` — `jwt.verify()`'s own
 * `algorithms: ["RS256"]` pin already stops alg-confusion, but nothing
 * else in the RS256 verify call constrains `iss`, and an attacker who
 * somehow obtained a validly-signed token from a DIFFERENT issuer must
 * still not be able to pass it off as this provider's own hint.
 *
 * Returns `null` on ANY failure (malformed token, unknown `kid`, bad
 * signature, wrong `iss`, missing/malformed `sub`/`aud`) — never throws,
 * same discipline as `verifyAuthToken()`/`verifyOAuthState()`.
 */
export function verifyIdTokenHint(token: string): IdTokenHintClaims | null {
  const header = decodeHeader(token);
  if (header?.alg && header.alg !== "RS256") return null; // id_token_hint is RS256-only, no legacy path — this provider has never issued an ID token any other way (see file header, Phase 1a/1b).

  for (const candidate of resolveVerificationKeys(header?.kid)) {
    let decoded: Record<string, unknown>;
    try {
      decoded = jwt.verify(token, candidate.publicKey, {
        algorithms: ["RS256"],
        ignoreExpiration: true,
      }) as Record<string, unknown>;
    } catch {
      continue; // this candidate didn't verify this token — try the next, if any
    }

    if (decoded.iss !== resolveIssuer()) return null; // genuinely signed, but by/for a different issuer identity — never trusted as this provider's own hint
    const sub = decoded.sub;
    const aud = decoded.aud;
    if (typeof sub === "string" && sub.length > 0 && typeof aud === "string" && aud.length > 0) {
      return { sub, aud };
    }
    return null; // signature+issuer check out, but the claim shape isn't a valid id_token_hint
  }

  return null;
}
