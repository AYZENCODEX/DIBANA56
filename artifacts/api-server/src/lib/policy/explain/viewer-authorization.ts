/**
 * lib/policy/explain/viewer-authorization.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 15 (Explainability).
 *
 * `canViewExplanationDetail()` answers the ONE question
 * `explain-authorization.ts` deliberately refuses to answer itself: "is
 * THIS caller allowed to see admin/debug policy detail?" — see that
 * file's own header for why the split exists.
 *
 * ── Reuses Phase 02's RBAC machinery verbatim — no parallel permission
 *    system ────────────────────────────────────────────────────────────
 * This is not a new authorization mechanism. It is the exact same
 * `RbacProvider` + `resolveEffectivePermissions()` + `permissionMatches()`
 * chain ../rbac/rbac-rule.ts already uses to decide "does this subject
 * hold a permission that covers this action" — the only difference is the
 * permission being checked is the fixed
 * `POLICY_EXPLANATION_PERMISSION` constant below, not
 * `request.action`. An `admin` subject already holds the `"*"` global
 * wildcard grant (migration 096's own seed data) and therefore already
 * satisfies this check with no further data change required — see
 * migration 102's own header for the additive, narrower
 * `admin.policy.explain` catalog row this phase also seeds, so a future
 * role (e.g. a dedicated "auditor" role) could be granted exactly this one
 * capability without the full admin wildcard.
 *
 * ── Fails closed ──────────────────────────────────────────────────────────
 * `subject === null` (unauthenticated) and "resolved permission set does
 * not cover `POLICY_EXPLANATION_PERMISSION`" both return `false` — never
 * `true` by default, never a thrown error that a careless caller might
 * accidentally treat as "allowed" via an unguarded try/catch. Matches
 * `resolveEffectivePermissions()`'s own "never throw for not found"
 * contract (../rbac/types.ts's `RbacProvider` header): an unknown role/
 * permission simply contributes nothing, which this function surfaces as
 * `false`, not an exception.
 *
 * ── Never trusts client-supplied "am I an admin" input ───────────────────
 * The only input this function reads is `subject` — expected to be the
 * same DB-verified `Subject` every other rule in this engine already
 * trusts (Phase 1B's `subjectFromAuthUser()`), never a client-supplied
 * role/permission list. There is no parameter here a caller could set to
 * "true" to force `detail` to be shown — Rule 9 ("never trust
 * client-supplied authorization context without server-side validation")
 * holds structurally, not by caller discipline.
 */

import { legacyRoleToRoleKeys } from "../rbac/legacy-role-map";
import { permissionMatches } from "../rbac/permission-matcher";
import { resolveEffectivePermissions } from "../rbac/role-resolver";
import type { RbacProvider } from "../rbac/types";
import type { Subject } from "../types";

/**
 * The permission that gates Phase 15 admin/debug explanation detail. Named
 * in the same `product.resource.action`-adjacent family
 * ../rbac/permission-matcher.ts's header describes for the roadmap's own
 * examples (`admin.user.manage`, ...) — `"admin"` product,
 * `"policy"` resource, `"explain"` action. Exported so a caller/test never
 * has to hardcode the literal string.
 */
export const POLICY_EXPLANATION_PERMISSION = "admin.policy.explain";

/**
 * `true` if `subject` holds a role (directly assigned, or via
 * `subject.role`'s legacy implicit membership — see
 * ../rbac/legacy-role-map.ts) whose effective, inheritance-resolved
 * permission set covers `POLICY_EXPLANATION_PERMISSION` (a concrete grant,
 * or any wildcard pattern covering it, e.g. `"admin.*"` or `"*"`).
 * `false` for `subject === null` and for any subject with no such grant.
 * Never throws — see file header's "Fails closed" section.
 */
export async function canViewExplanationDetail(
  subject: Subject | null,
  provider: RbacProvider,
): Promise<boolean> {
  if (!subject) return false;

  const startingRoleKeys = new Set<string>([
    ...legacyRoleToRoleKeys(subject.role),
    ...(await provider.getUserRoleKeys(subject.userId)),
  ]);
  if (startingRoleKeys.size === 0) return false;

  const permissions = await resolveEffectivePermissions(provider, [...startingRoleKeys]);
  for (const grant of permissions) {
    if (permissionMatches(grant, POLICY_EXPLANATION_PERMISSION)) return true;
  }
  return false;
}
