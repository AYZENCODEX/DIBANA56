/**
 * lib/policy/registry/drizzle-policy-registry-provider.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 07 (Policy Registry / PAP).
 *
 * The real, `@workspace/db`-backed `PolicyRegistryProvider` (see
 * registry/types.ts). This is the only file in `lib/policy/registry/*` that
 * imports `@workspace/db` — everything else (lifecycle.ts, authorizer.ts,
 * policy-registry.ts) is written against the plain `PolicyRegistryProvider`
 * interface and stays DB-free, so it can be unit-tested without a database
 * (see scripts/src/test-policy-registry.ts) — same split
 * `rbac/drizzle-rbac-provider.ts`'s own header documents for Phase 02.
 *
 * Like every prior phase's Drizzle provider, nothing in the app constructs
 * `DrizzlePolicyRegistryProvider` yet, and it cannot be executed against a
 * real database in this sandbox (no network) — included, reviewed, and
 * typed now so a future pass only has to wire it up.
 */

import { db, policiesTable, policyAdminAuditLogTable } from "@workspace/db";
import { and, desc, eq, max } from "drizzle-orm";
import type { NewPolicyInput, PolicyAdminAuditEntry, PolicyRecord, PolicyRegistryProvider, PolicyStatus } from "./types";
import { PolicyNotFoundError } from "./errors";

function toPolicyRecord(row: typeof policiesTable.$inferSelect): PolicyRecord {
  return {
    id: row.id,
    policyId: row.policyId,
    version: row.version,
    name: row.name,
    description: row.description,
    application: row.application,
    resource: row.resource,
    action: row.action,
    ruleKind: row.ruleKind as PolicyRecord["ruleKind"],
    rules: row.rules,
    effect: row.effect as PolicyRecord["effect"],
    priority: row.priority,
    status: row.status as PolicyStatus,
    createdBy: row.createdBy,
    approvedBy: row.approvedBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    approvedAt: row.approvedAt,
  };
}

export class DrizzlePolicyRegistryProvider implements PolicyRegistryProvider {
  async getPolicy(policyId: string, version?: number): Promise<PolicyRecord | null> {
    if (version !== undefined) {
      const [row] = await db
        .select()
        .from(policiesTable)
        .where(and(eq(policiesTable.policyId, policyId), eq(policiesTable.version, version)));
      return row ? toPolicyRecord(row) : null;
    }
    const [row] = await db
      .select()
      .from(policiesTable)
      .where(eq(policiesTable.policyId, policyId))
      .orderBy(desc(policiesTable.version))
      .limit(1);
    return row ? toPolicyRecord(row) : null;
  }

  async getActivePolicy(policyId: string): Promise<PolicyRecord | null> {
    const [row] = await db
      .select()
      .from(policiesTable)
      .where(and(eq(policiesTable.policyId, policyId), eq(policiesTable.status, "ACTIVE")));
    return row ? toPolicyRecord(row) : null;
  }

  async listActivePolicies(filter?: { application?: string; resource?: string }): Promise<PolicyRecord[]> {
    const conditions = [eq(policiesTable.status, "ACTIVE")];
    if (filter?.application) conditions.push(eq(policiesTable.application, filter.application));
    if (filter?.resource) conditions.push(eq(policiesTable.resource, filter.resource));
    const rows = await db
      .select()
      .from(policiesTable)
      .where(and(...conditions))
      .orderBy(desc(policiesTable.priority));
    return rows.map(toPolicyRecord);
  }

  /**
   * Phase 23A (Admin Policy Console). See `PolicyRegistryProvider
   * .listAllPolicies()`'s own doc comment (registry/types.ts) for the exact
   * contract: one row per DISTINCT `policyId` — its latest version by
   * `version` number, regardless of status — then narrowed by
   * `application`/`resource`/`status` on THAT resulting row (never on the
   * underlying candidate rows before "latest" is picked; a DRAFT v3 is
   * still policyId's latest even if an older v2 happened to match a
   * `status` filter more narrowly — same "latest wins, then filter"
   * semantics `getPolicy(policyId)` with no `version` argument already has
   * for a single policyId, applied here across every policyId at once).
   *
   * `DISTINCT ON (policy_id) ... ORDER BY policy_id, version DESC` is
   * Postgres's native way to pick exactly one (the highest-version) row
   * per `policyId` in a single query — this mirrors
   * `scripts/src/test-policy-registry.ts`'s in-memory
   * `FakePolicyRegistryProvider.listAllPolicies()` exactly: that fake
   * builds the same "highest version per policyId" map first, THEN
   * applies the filter, then sorts by `policyId`. Keeping both
   * implementations' semantics identical (filter-after-latest, not
   * filter-before) matters — a provider swap must never change which
   * rows an admin sees.
   *
   * Filtering in application code (not a second SQL `WHERE`) after the
   * `DISTINCT ON` is deliberate, not a missed optimization: Postgres does
   * not allow `WHERE` to reference the "winning" row of a `DISTINCT ON`
   * group without a subquery, and the admin console this feeds
   * (`lib/policy-admin-console.ts`) reads at most the full policy catalog
   * — hundreds of rows, not millions — so a second round-trip or a
   * hand-written subquery buys nothing here. Revisit with a subquery only
   * if this table ever grows large enough for that to matter (see
   * roadmap's own "introduce caching only after correctness" rule — the
   * same "don't optimize the read path prematurely" instinct applies to
   * query shape, not just caching).
   */
  async listAllPolicies(filter?: { application?: string; resource?: string; status?: PolicyStatus }): Promise<PolicyRecord[]> {
    const latestRows = await db
      .selectDistinctOn([policiesTable.policyId])
      .from(policiesTable)
      .orderBy(policiesTable.policyId, desc(policiesTable.version));
    return latestRows
      .map(toPolicyRecord)
      .filter(
        (r) =>
          (filter?.application === undefined || r.application === filter.application) &&
          (filter?.resource === undefined || r.resource === filter.resource) &&
          (filter?.status === undefined || r.status === filter.status),
      )
      .sort((a, b) => a.policyId.localeCompare(b.policyId));
  }

  async listVersions(policyId: string): Promise<PolicyRecord[]> {
    const rows = await db
      .select()
      .from(policiesTable)
      .where(eq(policiesTable.policyId, policyId))
      .orderBy(desc(policiesTable.version));
    return rows.map(toPolicyRecord);
  }

  async getLatestVersionNumber(policyId: string): Promise<number> {
    const [row] = await db
      .select({ latest: max(policiesTable.version) })
      .from(policiesTable)
      .where(eq(policiesTable.policyId, policyId));
    return row?.latest ?? 0;
  }

  async insertVersion(input: NewPolicyInput & { version: number; createdBy: number }): Promise<PolicyRecord> {
    const [row] = await db
      .insert(policiesTable)
      .values({
        policyId: input.policyId,
        version: input.version,
        name: input.name,
        description: input.description ?? null,
        application: input.application,
        resource: input.resource,
        action: input.action,
        ruleKind: input.ruleKind,
        rules: input.rules,
        effect: input.effect,
        priority: input.priority ?? 0,
        status: "DRAFT",
        createdBy: input.createdBy,
      })
      .returning();
    return toPolicyRecord(row);
  }

  async updateStatus(policyId: string, version: number, next: PolicyStatus, approvedBy: number | null): Promise<PolicyRecord> {
    const [row] = await db
      .update(policiesTable)
      .set({
        status: next,
        approvedBy,
        approvedAt: next === "APPROVED" ? new Date() : undefined,
        updatedAt: new Date(),
      })
      .where(and(eq(policiesTable.policyId, policyId), eq(policiesTable.version, version)))
      .returning();
    if (!row) throw new PolicyNotFoundError(policyId, version);
    return toPolicyRecord(row);
  }

  async recordAudit(entry: PolicyAdminAuditEntry): Promise<void> {
    await db.insert(policyAdminAuditLogTable).values({
      actorId: entry.actorId,
      policyId: entry.policyId,
      version: entry.version,
      policyRowId: entry.policyRowId,
      action: entry.action,
      before: entry.before ?? null,
      after: entry.after ?? null,
    });
  }
}
