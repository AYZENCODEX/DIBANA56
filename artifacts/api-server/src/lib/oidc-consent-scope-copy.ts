/**
 * lib/oidc-consent-scope-copy.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 4, Phase 7b: Consent UI — human-readable scope
 * descriptions.
 *
 * 7b's own text asks for exactly this: "কোন কোন scope-এর জন্য কী অ্যাক্সেস
 * পাচ্ছে (human-readable scope descriptions — `profile`, `email` ইত্যাদির
 * জন্য একটা fixed mapping)." A fixed, hand-written `Record`, not a
 * generated/derived string — the same "this is copy a human should review
 * when scopes change, not a mechanical transform of the scope name" reason
 * `KNOWN_OIDC_SCOPES` (`lib/oidc-scope-validation.ts`, Phase 2D) is itself a
 * fixed, explicit list rather than something derived from `oidc_clients.
 * allowed_scopes`.
 *
 * Deliberately keyed off `lib/oidc-scope-validation.ts`'s own
 * `KNOWN_OIDC_SCOPES` vocabulary (`openid`/`profile`/`email`) rather than a
 * separate list — this file's whole job is putting user-facing copy on
 * scopes that vocabulary already recognizes; a scope this provider doesn't
 * know isn't a scope Phase 7c will ever hand this file to render (2D's
 * `validateOidcScopes()` rejects it long before then). `UNKNOWN_SCOPE_COPY`
 * exists purely as a defensive fallback for a future scope value added to
 * `KNOWN_OIDC_SCOPES` without a matching entry here — never triggered by
 * anything reachable in this pass.
 *
 * Scope discipline (this is 7b, not 7e): no scope-set comparison, no
 * "which of these are NEW since the last grant" highlighting — that
 * fixed/highlighted distinction is 7e's own "শুধু নতুন scope-গুলো
 * হাইলাইট করে" job, layered on top of this file's plain per-scope copy
 * once 7e exists to compute which scopes are new.
 */

/** One scope's consent-screen copy: a short label plus a one-line description of what it lets the client see/do. */
export interface OidcConsentScopeCopy {
  scope: string;
  label: string;
  description: string;
}

const SCOPE_COPY: Record<string, Omit<OidcConsentScopeCopy, "scope">> = {
  openid: {
    label: "Confirm it's you",
    description: "Verify your AYZEN identity so this app knows who's signing in.",
  },
  profile: {
    label: "Basic profile",
    description: "Your username and public profile information.",
  },
  email: {
    label: "Email address",
    description: "Your AYZEN account email address.",
  },
};

/** Defensive fallback for a scope with no entry above — see file header. Never expected to be hit by anything `validateOidcScopes()` has already passed. */
const UNKNOWN_SCOPE_COPY: Omit<OidcConsentScopeCopy, "scope"> = {
  label: "Additional access",
  description: "This app is requesting an additional permission.",
};

/**
 * Maps an already-validated list of scopes (e.g. `OidcAuthorizeRequestValidationResult.scopes`)
 * to consent-screen copy, in the same order they were requested. Pure,
 * DB-free — takes plain strings, not an `OidcClient`, so it can be unit
 * tested and reused by both the backend response-shaping code and (if ever
 * needed) a client-side preview without either depending on the other.
 */
export function describeConsentScopes(scopes: string[]): OidcConsentScopeCopy[] {
  return scopes.map((scope) => ({ scope, ...(SCOPE_COPY[scope] ?? UNKNOWN_SCOPE_COPY) }));
}
