/**
 * lib/policy/rbac/types.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 02 (RBAC).
 *
 * The one interface every other rbac/* file is written against —
 * `rbac-rule.ts`, `role-resolver.ts`, and `drizzle-rbac-provider.ts` all
 * import `RbacProvider`/`RoleRecord` from here, and none of them import
 * `@workspace/db` directly except `drizzle-rbac-provider.ts` (see that
 * file's header). `scripts/src/test-policy-rbac.ts`'s in-memory
 * `FakeRbacProvider` implements this exact same interface, which is what
 * lets the whole RBAC rule chain be unit-tested without a database.
 *
 * Deliberately narrow: three read-only lookups, nothing else. No `write`
 * methods exist here (granting a role/permission is a future admin-console
 * concern — Phase 23 — not something the PDP's read path needs), and no
 * method takes anything client-influenced beyond a `userId`/`roleKey`
 * string that already came from a DB-verified `Subject` or from walking a
 * role's own `parentRoleKey` (see role-resolver.ts).
 */

/**
 * A single role row, identified by its stable `key` (not its numeric DB
 * id — see rbac.ts's schema-file header for why: seed data and
 * role-inheritance chains are both written in terms of `key`, so callers
 * of this interface never need to know or look up a role's `id`).
 */
export interface RoleRecord {
  key: string;
  /** The role this one inherits from, or `null` for a root role. A chain
   *  of these is what role-resolver.ts's bounded BFS walks. */
  parentRoleKey: string | null;
}

/**
 * Everything the RBAC `PolicyRule` (rbac-rule.ts) and the role-inheritance
 * resolver (role-resolver.ts) need from storage. `DrizzleRbacProvider`
 * (drizzle-rbac-provider.ts) is the real, `@workspace/db`-backed
 * implementation; `FakeRbacProvider` (test-policy-rbac.ts) is an in-memory
 * stand-in used by tests.
 *
 * Contract every implementation must honor:
 *   - Never throw for "not found" — an unknown `userId` or `roleKey`
 *     contributes nothing (empty array / `null`), the same as a user or
 *     role that legitimately has no rows. This lets role-resolver.ts treat
 *     "orphaned reference" and "genuinely empty" identically (see that
 *     file's header) without a try/catch at every call site.
 *   - Read-only. No method here ever mutates state.
 */
export interface RbacProvider {
  /** Role keys explicitly assigned to `userId` via `user_roles` — NOT
   *  including the implicit legacy-role membership `legacy-role-map.ts`
   *  derives from `subject.role`; the RBAC rule combines both sets itself
   *  (see rbac-rule.ts) before calling `resolveEffectivePermissions()`. */
  getUserRoleKeys(userId: number): Promise<string[]>;

  /** Grant patterns (concrete keys or trailing-wildcard patterns — see
   *  permission-matcher.ts) attached directly to `roleKey`, NOT including
   *  anything inherited from a parent role — inheritance is
   *  role-resolver.ts's job, one layer up. Returns `[]` for an unknown
   *  role key. */
  getRolePermissionKeys(roleKey: string): Promise<string[]>;

  /** The role record for `roleKey`, or `null` if no such role exists.
   *  Used by role-resolver.ts purely to discover `parentRoleKey` for the
   *  next hop of its inheritance walk. */
  getRole(roleKey: string): Promise<RoleRecord | null>;
}
