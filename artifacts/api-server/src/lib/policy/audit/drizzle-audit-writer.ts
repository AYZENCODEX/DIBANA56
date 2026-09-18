/**
 * lib/policy/audit/drizzle-audit-writer.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 17 (Authorization Audit).
 *
 * The real, `@workspace/db`-backed `AuthorizationAuditWriter` (see
 * ./types.ts). This is the only file in `lib/policy/audit/*` that imports
 * `@workspace/db` — everything else (to-audit-entry.ts, audit-observer.ts)
 * is written against the plain `AuthorizationAuditWriter` interface and
 * stays DB-free, so it can be unit-tested without a database (see
 * scripts/src/test-policy-audit.ts) — same split every prior phase's own
 * Drizzle provider header documents (e.g.
 * ../registry/drizzle-policy-registry-provider.ts's).
 *
 * Like every prior phase's Drizzle provider, nothing in the app constructs
 * `DrizzleAuthorizationAuditWriter` yet, and it cannot be executed against
 * a real database in this sandbox (no network) — included, reviewed, and
 * typed now so a future pass only has to wire it up.
 *
 * `write()` never throws outward on a DB error — it is called from
 * `createAuthorizationAuditObserver()` (./audit-observer.ts), which already
 * wraps every call defensively, but this class also never lets a DB
 * failure surface as anything other than a rejected promise the observer
 * is already prepared to swallow (it does not, itself, additionally try to
 * retry/queue — see this method's own doc comment for why that is
 * deliberately out of scope for Phase 17).
 */

import { db, authorizationAuditLogTable } from "@workspace/db";
import type { AuthorizationAuditEntry, AuthorizationAuditWriter } from "./types";

export class DrizzleAuthorizationAuditWriter implements AuthorizationAuditWriter {
  /**
   * Inserts exactly one row per call — Phase 17 does not batch (a batch
   * writer would need its own buffering/flush-timing policy, which is a
   * distinct concern the roadmap does not ask this phase to solve; Phase
   * 20's `authorizeMany()` batch-authorization work is the more natural
   * home for "avoid N+1 audit writes" if that ever becomes a measured
   * problem — see this file's header). A rejected insert propagates as a
   * rejected promise; it is the caller's (`createAuthorizationAuditObserver()`'s)
   * job to make sure that never becomes an authorization failure, not
   * this method's.
   */
  async write(entry: AuthorizationAuditEntry): Promise<void> {
    await db.insert(authorizationAuditLogTable).values({
      decisionId: entry.decisionId,
      requestId: entry.requestId,
      subjectUserId: entry.subjectUserId,
      subjectRole: entry.subjectRole,
      subjectAuthType: entry.subjectAuthType,
      subjectOrganizationId: entry.subjectOrganizationId,
      product: entry.product,
      resourceType: entry.resourceType,
      resourceId: entry.resourceId,
      action: entry.action,
      decision: entry.decision,
      reasonCode: entry.reasonCode,
      policyId: entry.policyId,
      policyVersion: entry.policyVersion,
      risk: entry.risk,
      assuranceMethods: entry.assuranceMethods,
      requiredAssurance: entry.requiredAssurance,
      timestamp: entry.timestamp,
      latencyMs: entry.latencyMs,
    });
  }
}
