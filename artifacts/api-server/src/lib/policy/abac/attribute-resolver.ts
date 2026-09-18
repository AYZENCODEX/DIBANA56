/**
 * lib/policy/abac/attribute-resolver.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 05 (ABAC).
 *
 * `resolveAttributes()` builds the `AttributeBag` every ABAC condition reads
 * from, out of the request's already-validated `Subject` / `ResourceRef` /
 * `PolicyContext` (Phase 1A's types, extended by Phase 05 — see ../types.ts).
 * This is the PIP-adjacent seam the roadmap's target architecture names
 * (`PDP requests context through providers instead of arbitrary DB queries`
 * — Phase 18) pulled forward just far enough for ABAC to have somewhere
 * principled to read from: it does no DB/IO of its own, it only reshapes
 * data the caller already assembled, exactly like `pip/subject-adapter.ts`
 * and `pip/context-adapter.ts` do for their own inputs.
 *
 * ── Never trusts client input beyond what upstream already verified ───────
 * `subject.userId`/`role`/`authType` are the DB-verified `Subject` (Phase
 * 1A/1B) — never raw client input. Every other field on `Subject`/
 * `ResourceRef`/`PolicyContext` this resolver reads is caller-supplied at
 * whatever trust level the PEP/route layer that built the request gave it —
 * the same boundary every other resource-family rule in this engine already
 * documents (see ownership-rule.ts's header). This resolver does not
 * upgrade that trust level; it only reshapes it into `AttributeBag`'s shape.
 *
 * ── Requires an authenticated subject ──────────────────────────────────────
 * Takes a `Subject`, not `Subject | null` — `abac-rule.ts` (like every other
 * rule in this engine) checks for `null` itself before calling this, mostly
 * defensively since `policy-engine.ts` already denies UNAUTHENTICATED before
 * any rule runs. Typing this function to require a real `Subject` means that
 * check happens once, at the one real call site, rather than this file
 * having to re-decide what "no subject" should mean for attribute resolution.
 */

import type { PolicyContext, ResourceRef, Subject } from "../types";
import type { AttributeBag } from "./types";

export function resolveAttributes(
  subject: Subject,
  resource: ResourceRef,
  context: PolicyContext,
  action: string,
): AttributeBag {
  return {
    action,
    subject: {
      userId: subject.userId,
      role: subject.role,
      authType: subject.authType,
      organizationId: subject.organizationId,
      accountState: subject.accountState,
      verificationLevel: subject.verificationLevel,
      riskLevel: subject.riskLevel,
      keyType: subject.keyType,
      scopes: subject.scopes,
      assuranceMethods: subject.assuranceMethods,
    },
    resource: {
      type: resource.type,
      id: resource.id,
      ownerId: resource.ownerId,
      organizationId: resource.organizationId,
      classification: resource.classification,
      state: resource.state,
      sensitivity: resource.sensitivity,
      locked: resource.locked,
    },
    environment: {
      time: context.timestamp,
      ip: context.ip,
      sessionId: context.sessionId,
      deviceTrust: context.deviceTrust,
      sessionAgeSeconds: context.sessionAgeSeconds,
      authenticationFreshnessSeconds: context.authenticationFreshnessSeconds,
    },
  };
}

const TOP_LEVEL_GROUPS = new Set(["subject", "resource", "environment"]);

/**
 * Reads a dot-path attribute out of `bag` — e.g. `"subject.role"`,
 * `"resource.classification"`, `"environment.deviceTrust"`, or the bare
 * `"action"`. Returns `undefined` for any path that doesn't resolve
 * (unknown group, unknown field, or attempting to traverse past a
 * non-object) — this function never throws, matching every other read-only
 * lookup in this engine (`RbacProvider`/`ResourceGrantProvider`/
 * `RelationshipProvider` all document the same "unknown key contributes
 * nothing" contract).
 *
 * Deliberately shallow beyond the fixed `group.field` shape: there is no
 * unbounded traversal here (no arbitrary nesting, no prototype-chain
 * walking) — every path is at most two segments into a plain, pre-built
 * object literal, which is what keeps this bounded and safe against
 * anything resembling a prototype-pollution or `__proto__` path string
 * (an attribute string like `"subject.__proto__"` simply misses, the same
 * as any other unrecognized field name would).
 */
export function getAttribute(bag: AttributeBag, path: string): unknown {
  if (path === "action") return bag.action;

  const dotIndex = path.indexOf(".");
  if (dotIndex <= 0 || dotIndex === path.length - 1) return undefined; // malformed path — no match

  const group = path.slice(0, dotIndex);
  const field = path.slice(dotIndex + 1);
  if (field.includes(".")) return undefined; // only "group.field" (two segments) is supported in Phase 05
  if (!TOP_LEVEL_GROUPS.has(group)) return undefined;
  if (!Object.prototype.hasOwnProperty.call(bag[group as keyof AttributeBag], field)) return undefined;

  const groupObject = bag[group as "subject" | "resource" | "environment"] as Record<string, unknown>;
  return groupObject[field];
}
