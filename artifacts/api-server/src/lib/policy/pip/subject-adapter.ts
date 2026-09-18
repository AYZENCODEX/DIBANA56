/**
 * lib/policy/pip/subject-adapter.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 01 (Foundation / PDP Core),
 * sub-phase 1B: PIP (Policy Information Point) — Identity adapter.
 *
 *   Identity → PIP → PDP/Policy Engine → Decision → PEP → Business Action → Audit
 *              ^^^
 *              this file
 *
 * `middlewares/auth.ts`'s `requireAuth`/`requireAdmin`/etc. already do the
 * real identity work (verify JWT or API key, re-read role from DB, check
 * session revocation) and land the result on `req.user: AuthUser`. Phase 1A's
 * `Subject` type was deliberately modeled on that exact shape (see
 * types.ts's doc comment) — this file is the one place that mapping is
 * spelled out, so a future PEP adapter (or a test) doesn't have to
 * reconstruct it by hand at every call site.
 *
 * Deliberately NOT done here (see CHANGES_POLICY_AUTHORIZATION_ENGINE_PHASE1B.md):
 * - No import of `middlewares/auth.ts`'s `AuthUser` type. That would make
 *   this framework-agnostic-so-far policy module depend on an Express
 *   middleware file. Instead this file declares its own minimal structural
 *   type (`AuthenticatedUserLike`) that `AuthUser` already happens to
 *   satisfy — callers pass `req.user` straight through, no adapter glue
 *   needed at the call site, but the two files stay decoupled.
 * - No DB reads, no organization-membership lookup. AYZEN has no
 *   organizations table yet, so `Subject.organizationId` has nothing to
 *   populate from (Phase 03's concern) — left undefined rather than guessed.
 * - No assurance-method lookup. No session/login-security table currently
 *   records *which* MFA method was used for a given session (Phase 09's
 *   concern) — `Subject.assuranceMethods` left undefined here too.
 * - Nothing calls this function anywhere in the app yet. Existing routes and
 *   middleware are untouched — this is purely a new, unused (so far) export.
 */

import type { AssuranceMethod, Subject, SubjectAuthType } from "../types";

/**
 * Structural shape this adapter accepts. `middlewares/auth.ts`'s `AuthUser`
 * (what `req.user` is typed as today) satisfies this without any changes on
 * that side — this is intentionally a subset/superset-compatible shape, not
 * an import of that file's type.
 */
export interface AuthenticatedUserLike {
  userId: number;
  role: string;
  /** Optional today on some legacy code paths — see normalizeAuthType(). */
  authType?: string;
  keyType?: "full" | "scoped";
  scopes?: string[];
}

const VALID_AUTH_TYPES: ReadonlySet<SubjectAuthType> = new Set(["session", "apikey", "legacy", "oidc"]);

/**
 * `AuthenticatedUserLike.authType` is a plain `string | undefined` (some
 * callers construct `req.user` without it — see `middlewares/auth.ts`'s
 * `AuthUser` interface, where the field is optional). `Subject.authType` is
 * the closed `SubjectAuthType` union `buildAuthorizationRequest()` validates
 * against. Rather than let an unrecognized/missing value silently produce an
 * `InvalidAuthorizationContextError` deny for what is, in practice, always a
 * real logged-in user, this normalizes to `"session"` — the historically
 * default case for every code path that predates the apikey/legacy
 * distinction. This function only ever narrows an already-authenticated
 * user's metadata; it is never the thing deciding whether someone is
 * authenticated at all (that remains `getUserFromToken()`'s job, upstream).
 */
function normalizeAuthType(authType: string | undefined): SubjectAuthType {
  if (authType && VALID_AUTH_TYPES.has(authType as SubjectAuthType)) {
    return authType as SubjectAuthType;
  }
  return "session";
}

/**
 * Maps an already-authenticated identity (`req.user`, as set by
 * `requireAuth`/`requireAdmin`/etc.) onto the PDP's `Subject` shape.
 *
 * `null`/`undefined` in → `null` out, deliberately: `Subject | null` is how
 * Phase 1A's engine represents "no authenticated caller" (see types.ts and
 * policy-engine.ts's `UNAUTHENTICATED` branch), so an unauthenticated
 * request maps the same way here rather than throwing or being treated as a
 * caller-error.
 *
 * Never throws. Never reads the database. Never reaches into the raw token
 * — this only reshapes data the caller already resolved and verified
 * upstream.
 */
export function subjectFromAuthUser(user: AuthenticatedUserLike | null | undefined): Subject | null {
  if (!user) return null;
  return {
    userId: user.userId,
    role: user.role,
    authType: normalizeAuthType(user.authType),
    keyType: user.keyType,
    scopes: user.scopes,
    organizationId: undefined,
    assuranceMethods: undefined as AssuranceMethod[] | undefined,
  };
}
