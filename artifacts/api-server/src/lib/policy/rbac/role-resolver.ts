/**
 * lib/policy/rbac/role-resolver.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 02 (RBAC).
 *
 * `resolveEffectivePermissions()` walks a set of starting role keys plus
 * every role each one inherits from (via `parent_role_key`), and collects
 * every grant pattern attached to any role in that closure. This is the
 * one place role-inheritance traversal happens — the RBAC `PolicyRule`
 * (rbac-rule.ts) calls this instead of walking `RbacProvider` itself, so
 * the bounded/cycle-safe traversal logic exists in exactly one spot.
 *
 * BOUNDED, per roadmap's performance rules ("avoid ... unbounded
 * relationship traversal") and reliability concerns: a role graph is data
 * (seeded today, admin-editable in a future phase) — nothing here assumes
 * it is acyclic or shallow. `MAX_DEPTH` and an explicit visited-set stop a
 * malformed or maliciously-edited parent chain (a role that is its own
 * ancestor, or an absurdly long chain) from looping forever or doing
 * unbounded work. Hitting either limit is not an error — the resolver
 * simply stops descending further down that branch and returns whatever
 * it already collected, which is a strictly SAFER outcome (fewer
 * permissions than intended) than either hanging or granting more than
 * intended.
 */

import type { RbacProvider } from "./types";

/** Generous enough for any real org-chart-style role hierarchy AYZEN is
 *  likely to have (today: 3 levels — user → dev → admin), while still
 *  being a concrete, enforced ceiling rather than "however deep the data
 *  happens to go". */
const MAX_DEPTH = 16;

export interface ResolveEffectivePermissionsOptions {
  maxDepth?: number;
}

/**
 * Returns the union of every grant pattern reachable from `roleKeys`
 * (each key itself, plus every ancestor reachable via `parent_role_key`,
 * up to `maxDepth` hops, with cycle detection). Never throws — an unknown
 * role key or a provider that returns `[]`/`null` simply contributes
 * nothing, per `RbacProvider`'s own contract (see types.ts).
 */
export async function resolveEffectivePermissions(
  provider: RbacProvider,
  roleKeys: readonly string[],
  options: ResolveEffectivePermissionsOptions = {},
): Promise<Set<string>> {
  const maxDepth = options.maxDepth ?? MAX_DEPTH;
  const visited = new Set<string>();
  const permissions = new Set<string>();

  // BFS via an explicit queue (not recursion) so a very deep/cyclic chain
  // can never blow the call stack — only ever bounded by maxDepth * the
  // (also bounded) fan-out of roleKeys.
  const queue: Array<{ key: string; depth: number }> = roleKeys.map((key) => ({ key, depth: 0 }));

  while (queue.length > 0) {
    const { key, depth } = queue.shift()!;
    if (visited.has(key)) continue; // cycle guard
    visited.add(key);

    const grants = await provider.getRolePermissionKeys(key);
    for (const grant of grants) permissions.add(grant);

    if (depth >= maxDepth) continue; // depth guard — do not fetch this role's own parent

    const role = await provider.getRole(key);
    if (role?.parentRoleKey && !visited.has(role.parentRoleKey)) {
      queue.push({ key: role.parentRoleKey, depth: depth + 1 });
    }
  }

  return permissions;
}
