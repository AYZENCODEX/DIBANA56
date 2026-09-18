/**
 * lib/policy/audit/to-audit-entry.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 17 (Authorization Audit).
 *
 * `toAuditEntry()` is the ONLY place an `AuthorizationDecision` (+ the
 * `AuthorizationRequest` that produced it) gets turned into an
 * `AuthorizationAuditEntry`. Pure, synchronous, no DB, no Express — same
 * discipline every other lib/policy/* file follows. Every writer
 * (real or fake) receives entries built by this one function, so "what is
 * and isn't safe to persist" is decided in exactly one place, not
 * re-derived at every call site.
 */

import { randomUUID } from "node:crypto";
import type { AuthorizationDecision, AuthorizationRequest } from "../types";
import type { AuthorizationAuditEntry } from "./types";

/**
 * The roadmap's own `product.resource.action` grammar
 * (../rbac/permission-matcher.ts) is exactly three `[a-z0-9_-]+` segments
 * joined by `.`. This derives ONLY the first segment, and ONLY when the
 * whole string actually matches that three-segment shape — an opaque
 * Phase 01-style action (anything that doesn't look like
 * "product.resource.action") yields `undefined`, not a guess.
 *
 * ── Why this reads `request.action`, never `resource.type` ──────────────
 * `ResourceRef.type` (e.g. `"sylo.vault_item"`) is a SEPARATE, two-segment
 * convention (see types.ts's own doc comment on that field) that does not
 * reliably carry the same first segment as a request's actual
 * `product.resource.action` permission key — `registry-rule-loader.ts`'s
 * own header is explicit that the three dot-segments this grammar
 * actually names come from `action`, not `resource.type`. Deriving
 * `product` from the wrong field would silently mislabel audit rows for
 * any resource type that doesn't happen to share its product prefix.
 */
function deriveProduct(action: string | undefined): string | undefined {
  if (!action) return undefined;
  const segments = action.split(".");
  if (segments.length !== 3) return undefined;
  const SEGMENT_RE = /^[a-z0-9_-]+$/;
  if (!segments.every((s) => SEGMENT_RE.test(s))) return undefined;
  return segments[0];
}

/**
 * Builds one `AuthorizationAuditEntry` from a finalized decision and (when
 * available) the request that produced it. `request` is `undefined` only
 * for the one engine path where a request could never be built at all
 * (invalid context before validation completes — see
 * `resolveRequestOrEarlyDecision()` in ../policy-engine.ts) — an entry is
 * still produced for that case (Rule 10: sensitive authorization
 * decisions must be auditable, including malformed/rejected ones), just
 * with every request-derived field left `undefined`.
 *
 * Deliberately excludes, on every entry, regardless of what `request`
 * carries: `context.ip`, `context.sessionId`, `context.extra`, the
 * subject's `scopes`, and the resource's full attribute set
 * (`ownerId`/`classification`/`sensitivity`/etc. beyond `type`+`id`) — the
 * roadmap's own "avoid unnecessary sensitive data" instruction, made
 * concrete. A future caller that genuinely needs one of those for a
 * specific investigation has `decision.requestId`/`entry.requestId` to
 * join back to a request-scoped structured log line
 * (../decision-observer.ts) or to the original request object itself if
 * the caller still has it in hand — this table does not need to duplicate
 * everything reachable from a decision just because it's reachable.
 */
export function toAuditEntry(
  decision: AuthorizationDecision,
  request: AuthorizationRequest | undefined,
): AuthorizationAuditEntry {
  const subject = request?.subject ?? undefined;
  const assuranceMethods =
    subject?.assuranceMethods && subject.assuranceMethods.length > 0 ? [...subject.assuranceMethods] : undefined;

  return {
    decisionId: randomUUID(),
    requestId: decision.requestId,

    subjectUserId: subject?.userId,
    subjectRole: subject?.role,
    subjectAuthType: subject?.authType,
    subjectOrganizationId: subject?.organizationId,

    product: deriveProduct(request?.action),
    resourceType: request?.resource?.type,
    resourceId: request?.resource?.id !== undefined ? String(request.resource.id) : undefined,
    action: request?.action,

    decision: decision.effect,
    reasonCode: decision.reason,

    policyId: decision.policyId,
    policyVersion: decision.policyVersion,

    risk: subject?.riskLevel,
    assuranceMethods,
    requiredAssurance: decision.requiredAssurance,

    timestamp: decision.evaluatedAt,
    latencyMs: decision.latencyMs,
  };
}
