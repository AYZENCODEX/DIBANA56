/**
 * lib/oidc-userinfo.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 2, Phase 4c-d (Profile Claims) + Phase 4c-e (Email
 * Claims), plus the user lookup `routes/oidc-userinfo.ts` (4c-f) needs
 * between verifying a token (4c-a/4c-b/4c-c,
 * `lib/oidc-access-token-verification.ts`) and shaping a response.
 *
 * Scope discipline (this is 4c-d/4c-e, not 4c-a/4c-b/4c-c or 4c-f):
 *   - No signature/expiry/issuer verification, no subject/scope
 *     extraction from a raw JWT — that's `oidc-access-token-verification.ts`
 *     (4c-a/4c-b/4c-c), already done and imported by neither this file nor
 *     needed by it: this file only ever receives an already-verified
 *     `userId` and an already-extracted `scopes` array.
 *   - No `Authorization` header parsing, no HTTP response shaping — that's
 *     `routes/oidc-userinfo.ts` (4c-f).
 *
 * WHY A SEPARATE `fetchOidcUserinfoRecord()`, NOT `getUserFromToken()` REUSED
 * `getUserFromToken()` (`lib/auth-utils.ts`) takes a raw TOKEN and returns
 * this codebase's internal `{ userId, role, authType, ... }` auth-context
 * shape — it re-verifies from scratch (session JWT / API key / legacy
 * base64) and has no notion of an already-verified OIDC access token's
 * `sub`. By the time this file's `fetchOidcUserinfoRecord()` runs, 4c-a has
 * already done the ONLY verification step needed; all that's left is "look
 * up user `userId`", which needs a DB query, not a second auth pass.
 * `avatarUrl`/`emailVerified`/`username` are also fields `getUserFromToken()`
 * never selects — this file selects exactly what UserInfo claims need
 * and nothing else.
 *
 * BANNED/SUSPENDED EXCLUSION: identical check `getUserFromToken()`
 * (`lib/auth-utils.ts`) and `apiKeyScopeGate`'s own DB read already apply
 * — a `usersTable.status` of `"banned"` or `"suspended"` resolves to "no
 * such user" here too, same as every other authenticated read path in this
 * codebase. A validly-signed, unexpired access token minted for an account
 * that was banned AFTER the token was issued must not still be able to
 * pull that account's UserInfo claims.
 */
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";

/** Exactly what UserInfo claim-shaping (below) needs from a user row — not the full `usersTable` select. */
export interface OidcUserinfoRecord {
  id: number;
  username: string;
  email: string;
  emailVerified: boolean;
  avatarUrl: string | null;
}

/**
 * Looks up `userId` (already-verified subject from 4c-b) and returns the
 * fields UserInfo claim-shaping needs, or `null` if the account doesn't
 * exist or is banned/suspended (see file header). Never throws for a
 * missing/excluded user — `routes/oidc-userinfo.ts` (4c-f) treats `null`
 * the same as a failed token verification: RFC 6750 `invalid_token`, not a
 * 500.
 */
export async function fetchOidcUserinfoRecord(userId: number): Promise<OidcUserinfoRecord | null> {
  const [user] = await db
    .select({
      id: usersTable.id,
      username: usersTable.username,
      email: usersTable.email,
      emailVerified: usersTable.emailVerified,
      avatarUrl: usersTable.avatarUrl,
      status: usersTable.status,
    })
    .from(usersTable)
    .where(eq(usersTable.id, userId));

  if (!user || user.status === "banned" || user.status === "suspended") return null;

  return {
    id: user.id,
    username: user.username,
    email: user.email,
    emailVerified: user.emailVerified,
    avatarUrl: user.avatarUrl,
  };
}

/** 4c-d/4c-e composed: the claim set `buildUserinfoClaims()` can produce, scope-gated. Every field beyond `sub` is optional on the type — never present unless the granting scope was actually granted. */
export interface OidcUserinfoClaims {
  sub: string;
  preferred_username?: string;
  picture?: string;
  email?: string;
  email_verified?: boolean;
}

/**
 * 4c-d/4c-e: pure claim shaping — no I/O, `user` and `scopes` both already
 * resolved by the caller. `sub` (OIDC Core §5.3.2, REQUIRED) is the only
 * claim returned regardless of scope; every other claim is gated on the
 * scope that OIDC Core §5.4's Standard Claims table assigns it:
 *
 *   - `"profile"` -> `preferred_username` (the account's `username`) and
 *     `picture` (the account's `avatarUrl`) — `picture` is added via a
 *     conditional key, not `picture: user.avatarUrl ?? undefined`, so an
 *     account with no avatar set never gets a `picture` key at all (never
 *     an empty string, never a literal `null`) — the same "assigning
 *     `undefined` still creates the key" pitfall `oidc-id-token.ts`'s own
 *     `nonce` handling (4b-b/4b-c) already documents and avoids the same
 *     way.
 *   - `"email"` -> `email` and `email_verified` together, always as a
 *     pair (OIDC Core §5.4 lists them under the same `email` scope) —
 *     `email_verified` reflects the DB value AS-IS, including `false`;
 *     it is never defaulted to `true` just because the claim is present.
 *
 * A scope this provider doesn't recognize at all is simply not matched by
 * any `if` below and contributes nothing — unknown-scope REJECTION already
 * happened upstream, at request-validation time (`oidc-scope-validation.ts`,
 * Phase 2d), never here.
 */
export function buildUserinfoClaims(user: OidcUserinfoRecord, scopes: string[]): OidcUserinfoClaims {
  const claims: OidcUserinfoClaims = { sub: String(user.id) };

  if (scopes.includes("profile")) {
    claims.preferred_username = user.username;
    if (user.avatarUrl) claims.picture = user.avatarUrl;
  }

  if (scopes.includes("email")) {
    claims.email = user.email;
    claims.email_verified = user.emailVerified;
  }

  return claims;
}
