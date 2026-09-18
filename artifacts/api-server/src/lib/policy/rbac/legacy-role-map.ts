/**
 * lib/policy/rbac/legacy-role-map.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 02 (RBAC).
 *
 * See lib/db/src/schema/rbac.ts's file header for the full design
 * rationale — short version: every AYZEN user already has a single
 * `users.role` string ("user" | "dev" | "admin" in practice today,
 * re-read from the DB on every request by `getUserFromToken()` and copied
 * onto `Subject.role` by Phase 1B's `subjectFromAuthUser()`). Phase 02
 * seeds three matching SYSTEM roles (migration 096) instead of requiring a
 * `user_roles` row for every existing user. This file is the one place
 * that "legacy string → RBAC role key(s)" mapping is spelled out.
 *
 * Deliberately a closed, explicit map — NOT `return [role]` for whatever
 * string shows up. An unrecognized `subject.role` value (a custom string
 * some future feature invents, or simply a typo/unexpected DB value)
 * contributes NO implicit system-role membership; it is not silently
 * treated as a role key that happens to not exist in `roles` (which would
 * resolve to zero permissions anyway via `RbacProvider.getRole()` /
 * `getRolePermissionKeys()` returning empty — so behaviorally identical to
 * omitting it here) but writing it as an explicit whitelist keeps this
 * function's behavior obvious from reading it alone, without having to
 * reason about the provider's unknown-key handling too.
 */

const LEGACY_ROLE_KEYS: ReadonlySet<string> = new Set(["user", "dev", "admin"]);

/**
 * `subject.role` (the DB-verified legacy string) → the RBAC role key(s) it
 * implicitly grants membership in. Today always 0 or 1 entries — a list is
 * used (not a nullable single value) so a future legacy value could map to
 * more than one starting role without changing this function's signature.
 */
export function legacyRoleToRoleKeys(role: string): string[] {
  return LEGACY_ROLE_KEYS.has(role) ? [role] : [];
}
