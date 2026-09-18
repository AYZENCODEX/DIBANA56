/**
 * lib/policy/temporary-access/types.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 11 (Temporary / Expiring
 * Access).
 *
 * The interface `temporary-access-rule.ts` and
 * `drizzle-temporary-access-grant-provider.ts` are both written against —
 * same pattern as `resource/types.ts`'s `ResourceGrantProvider`: a narrow,
 * read-only, DB-free-to-depend-on contract so the rule itself can be
 * unit-tested with an in-memory fake instead of a real database.
 */

/** One temporary access grant on file. Mirrors
 *  `lib/db/src/schema/temporary-access-grants.ts`'s `temporary_access_grants`
 *  table row-for-row — see that file's header for the full rationale behind
 *  each field, in particular what `scope` means and why there is no
 *  `effect` column (this table is allow-only; see temporary-access-rule.ts's
 *  header). */
export interface TemporaryAccessGrant {
  /** Row id — surfaced only for logging/audit; the rule never branches on
   *  it. */
  id: number | string;
  /** "resource": this grant covers only `resourceId` (exact match). Present
   *  only when `scope === "resource"`.
   *  "resource_type": this grant covers every resource of the matching
   *  `resourceType`, optionally narrowed by `organizationId`. `resourceId`
   *  is not applicable and must be omitted/null for these rows. */
  scope: "resource" | "resource_type";
  resourceId?: string | null;
  /** Only consulted when `scope === "resource_type"`. `null`/`undefined`
   *  means "every organization" for that resource type. Ignored when
   *  `scope === "resource"` (the exact resource id already fully
   *  identifies the target — see schema file header). */
  organizationId?: number | null;
  /** Grant does not authorize before this instant (inclusive). */
  startsAt: Date;
  /** Grant stops authorizing AT this instant — the active window is the
   *  half-open interval [startsAt, expiresAt). See temporary-access-rule.ts's
   *  header for exact boundary semantics. */
  expiresAt: Date;
  grantedBy: number;
  /** Optional human-readable reason, surfaced on the resulting
   *  AuthorizationDecision's `message` — never put secrets/PII here (same
   *  rule as everywhere else in this engine). */
  reason?: string | null;
}

/**
 * Everything `createTemporaryAccessRule()` needs from storage.
 * `DrizzleTemporaryAccessGrantProvider`
 * (drizzle-temporary-access-grant-provider.ts) is the real,
 * `@workspace/db`-backed implementation; a `FakeTemporaryAccessGrantProvider`
 * (test-policy-temporary-access.ts) is the in-memory stand-in tests use.
 *
 * Contract every implementation must honor:
 *   - Never throw for "none found" — empty array, exactly like
 *     `ResourceGrantProvider`'s "unknown key contributes nothing" contract.
 *   - Read-only. No method here ever mutates state (writing a grant is a
 *     future admin-console concern — see roadmap Phase 23).
 *   - Returns EVERY candidate row for this (subject, resourceType, action)
 *     tuple — both `scope: "resource"` and `scope: "resource_type"` rows —
 *     WITHOUT filtering by time window. Time-window filtering is
 *     deliberately the RULE's job, not the provider's — see
 *     temporary-access-rule.ts's header for why (determinism: the rule
 *     compares against `request.context.timestamp`, a value fixed at
 *     request-build time, not against whatever the database considers
 *     "now" at query time).
 *   - Exact match only on `resourceType`/`action` — no wildcard expansion.
 */
export interface TemporaryAccessGrantProvider {
  getTemporaryAccessGrants(
    subjectUserId: number,
    resourceType: string,
    action: string,
  ): Promise<TemporaryAccessGrant[]>;
}
