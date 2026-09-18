/**
 * lib/policy/resource/explicit-grant-rule.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 03 (Resource / Ownership
 * Authorization), sub-phase 3B.
 *
 * `createExplicitResourceGrantRule()` implements TWO roadmap Phase 03 line
 * items with one rule: "explicit grants" and "resource-level deny" — see
 * `lib/db/src/schema/resource-grants.ts`'s header for why they share one
 * table/lookup. This is the engine's third real `PolicyRule` (after
 * `rbac-rule.ts` and `ownership-rule.ts`).
 *
 * ── Two-sided rule: this one CAN return an explicit DENY ─────────────────
 * Unlike `ownership-rule.ts` (which only ever abstains or ALLOWs),
 * this rule mirrors `locked-resource-rule.ts`'s posture for the "deny" half:
 * a `ResourceGrantEntry` with `effect: "deny"` is a deliberate administrative
 * override — "this specific subject must never do this specific action on
 * this specific resource, no matter what role/ownership/lock state say" —
 * and must be able to beat an ALLOW from any other rule via deny-overrides
 * (policy-engine.ts), regardless of registration order. The "allow" half
 * behaves exactly like ownership-rule.ts: it ADDS a grant path, it never
 * forecloses one (abstain-if-not-found, never an implicit deny).
 *
 * ── Exact match only — no wildcard, no ownership shortcut ────────────────
 * `resource.id` must be present for this rule to have anything to look up
 * (unlike ownership-rule.ts, which only needs `ownerId`) — a grant is
 * inherently about one concrete resource instance. `resource.id` is
 * stringified before lookup (`String(resource.id)`) since `ResourceRef.id`
 * is `string | number` but the storage column is TEXT (see schema file).
 *
 * ── Never trusts client input ─────────────────────────────────────────────
 * `request.subject.userId` is the DB-verified `Subject`, same boundary as
 * every other rule in this engine. `request.resource.type`/`.id` are
 * caller-supplied (PEP/route-layer concern, same trust boundary
 * ownership-rule.ts documents) — this rule only ever queries with them, it
 * never trusts them to already encode a decision.
 */

import { allow, deny } from "../authorization-decision";
import type { PolicyRule } from "../policy-engine";
import type { ResourceGrantProvider } from "./types";

/** Stable id this rule should be registered under. */
export const RESOURCE_GRANT_POLICY_ID = "resource-grant";

export function createExplicitResourceGrantRule(provider: ResourceGrantProvider): PolicyRule {
  return async (request) => {
    const subject = request.subject;
    // Defensive only — see rbac-rule.ts / ownership-rule.ts for why this
    // branch is unreachable in practice (policy-engine.ts already denies
    // UNAUTHENTICATED before any rule runs).
    if (!subject) return null;

    const resourceId = request.resource.id;
    if (resourceId === undefined || resourceId === null) return null; // nothing concrete to look up — abstain

    const entry = await provider.getResourceGrant(
      subject.userId,
      request.resource.type,
      String(resourceId),
      request.action,
    );

    if (entry === null) return null; // no statement on file for this exact tuple — abstain

    if (entry.effect === "deny") {
      return deny(request, "RESOURCE_GRANT_DENIED", {
        policyId: RESOURCE_GRANT_POLICY_ID,
        message: entry.reason ?? `explicit resource-level deny for action "${request.action}"`,
      });
    }

    return allow(request, "EXPLICIT_ALLOW", {
      policyId: RESOURCE_GRANT_POLICY_ID,
      message: entry.reason ?? `granted via explicit resource grant for action "${request.action}"`,
    });
  };
}
