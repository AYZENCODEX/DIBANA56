/**
 * lib/policy/resource/types.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 03 (Resource / Ownership
 * Authorization), sub-phase 3B.
 *
 * The interface `explicit-grant-rule.ts` and `drizzle-resource-grant-provider.ts`
 * are both written against — same pattern as `rbac/types.ts`'s
 * `RbacProvider`: a narrow, read-only, DB-free-to-depend-on contract so the
 * rule itself can be unit-tested with an in-memory fake instead of a real
 * database.
 */

/** One explicit statement about a (subject, resource, action) tuple. See
 *  `lib/db/src/schema/resource-grants.ts`'s header for why "allow" and
 *  "deny" share one shape/table instead of two. */
export interface ResourceGrantEntry {
  effect: "allow" | "deny";
  /** Optional human-readable reason, surfaced on the resulting
   *  AuthorizationDecision's `message` — never put secrets/PII here (same
   *  rule as everywhere else in this engine — see authorization-decision.ts). */
  reason?: string;
}

/**
 * Everything `createExplicitResourceGrantRule()` needs from storage.
 * `DrizzleResourceGrantProvider` (drizzle-resource-grant-provider.ts) is the
 * real, `@workspace/db`-backed implementation; a `FakeResourceGrantProvider`
 * (test-policy-resource-grants.ts) is the in-memory stand-in tests use.
 *
 * Contract every implementation must honor:
 *   - Never throw for "not found" — no matching row means `null`, exactly
 *     like `RbacProvider`'s "unknown key contributes nothing" contract.
 *   - Read-only. No method here ever mutates state (writing a grant is a
 *     future admin-console/sharing-feature concern — see the Phase 3B
 *     CHANGES doc).
 *   - Exact match only — `resourceId`/`action` are compared as given, no
 *     wildcard expansion (see resource-grants.ts's header for why).
 */
export interface ResourceGrantProvider {
  getResourceGrant(
    subjectUserId: number,
    resourceType: string,
    resourceId: string,
    action: string,
  ): Promise<ResourceGrantEntry | null>;
}
