/**
 * lib/policy/rebac/relation-action-map.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 04 (ReBAC).
 *
 * Pure functions, no DB, no Express — same discipline every other
 * DB-free file in `lib/policy` follows. Answers exactly one question:
 * "given that a subject holds relation R on a resource, is `action`
 * (an `AuthorizationRequest.action` string) one that relation covers?"
 *
 * ── Why Phase 04 needs this at all (unlike 3A/3C's blanket rules) ────────
 * `ownership-rule.ts` (3A) and `organization-access-rule.ts` (3C) both
 * grant EVERY action once their one fact matches (owner / same org) —
 * deliberately blunt, with both files' headers explicitly deferring
 * "per-role-within-organization granularity (member vs manager vs
 * viewer)" to "Phase 04 (ReBAC)'s ... relationship vocabulary". This file
 * is where that deferred grain actually lands: seven distinct relation
 * kinds are pointless if every single one grants identical blanket
 * access — the whole reason to name `viewer` separately from `editor` is
 * so a viewer's ALLOW does not extend to a write action. Still
 * deliberately coarse (a fixed relation→verb-class table, not the
 * general attribute/operator machinery of Phase 05 ABAC or the
 * declarative DSL of Phase 06) — see rebac-rule.ts's header for why that
 * boundary is drawn here.
 *
 * ── Verb extraction, not full permission-key matching ─────────────────────
 * Unlike RBAC's `permission-matcher.ts` (which matches a full
 * "product.resource.action" grant pattern against a concrete key),
 * relation grants are not product/resource-scoped at all — a relation is
 * inherently already scoped to ONE concrete resource instance (the
 * `(resourceType, resourceId)` the caller is asking about), so all that's
 * left to check is which VERB the action names. `actionVerb()` takes the
 * trailing dot-segment of a "product.resource.action"-shaped string (or
 * the whole string, if it has no dots — Phase 01 left `action` an opaque
 * string for exactly this kind of reuse across conventions). This is
 * intentionally simpler than `permission-matcher.ts`'s wildcard grammar:
 * there is nothing here for a relation to "match against" beyond a verb,
 * so there is nothing to validate as a grant pattern either.
 *
 * ── Coarse, deliberately conservative verb classes ────────────────────────
 * READ_VERBS / WRITE_VERBS / APPROVE_VERBS / MANAGE_VERBS are a fixed,
 * small, reviewed vocabulary — not an open-ended set a caller can extend
 * at runtime. An action verb this module has never heard of (a typo, or a
 * genuinely new verb some future product invents) matches NOTHING here —
 * fails closed, exactly like `permissionMatches()` treats a malformed
 * pattern as matching nothing rather than everything.
 */

import type { RelationKind } from "./types";

/** Read-only access to a resource's state/content. */
const READ_VERBS = new Set(["read", "view", "list", "get"]);
/** Creating or modifying a resource's own content/state. */
const WRITE_VERBS = new Set(["create", "update", "write", "edit"]);
/** Approving a pending action on the resource (see Phase 12's Approval
 *  Engine, which this verb class is a natural future consumer of — not
 *  implemented by this phase, only named here). */
const APPROVE_VERBS = new Set(["approve"]);
/** Administrative control over the resource itself (deleting it,
 *  reconfiguring its access, managing its membership). */
const MANAGE_VERBS = new Set(["manage", "delete", "remove"]);

/**
 * The trailing dot-segment of a "product.resource.action"-shaped string,
 * or the whole string if it has no dots at all (Phase 01's opaque-action
 * callers). Never throws; an empty/whitespace action normalizes to `""`,
 * which matches no verb set below (fails closed).
 */
export function actionVerb(action: string): string {
  if (typeof action !== "string") return "";
  const segments = action.split(".");
  return segments[segments.length - 1].trim().toLowerCase();
}

/**
 * Which verb classes each relation kind covers. Ordered roughly from
 * broadest to narrowest so the table doubles as documentation of the
 * intended access hierarchy — this ordering has no effect on evaluation,
 * only on readability.
 *
 *   owner    — full control: read, write, approve, manage.
 *   manager  — operational control short of ownership: read, write,
 *              approve (e.g. a team manager approving a teammate's
 *              request) — deliberately NOT manage (destructive/
 *              membership-altering actions stay owner-only until a
 *              future phase decides otherwise; see Rule 16).
 *   editor   — read, write. No approve, no manage.
 *   approver — read, approve. Can see what they're approving, cannot
 *              themselves create/edit the content, and — per the
 *              roadmap's Phase 13 (Separation of Duties) concern this
 *              relation exists to support — is never also granted write.
 *   member   — read only. Base "belongs to this organization/team" fact;
 *              write/approve/manage require a MORE specific relation
 *              (editor/manager/owner) on top.
 *   viewer   — read only, identical verb coverage to `member` but named
 *              separately because it targets a single resource ("viewer
 *              of this vault") rather than membership in a container
 *              ("member of this organization") — see roadmap examples.
 *   auditor  — read only. Distinguished from viewer/member so a future
 *              audit-log/compliance action verb (not in today's verb
 *              classes) can be granted to auditors without also handing
 *              it to every ordinary viewer, without redesigning this
 *              table (see file header — this is a fixed, reviewed
 *              vocabulary, extended deliberately, not implicitly).
 */
const RELATION_VERB_CLASSES: Record<RelationKind, ReadonlySet<string>> = {
  owner: new Set([...READ_VERBS, ...WRITE_VERBS, ...APPROVE_VERBS, ...MANAGE_VERBS]),
  manager: new Set([...READ_VERBS, ...WRITE_VERBS, ...APPROVE_VERBS]),
  editor: new Set([...READ_VERBS, ...WRITE_VERBS]),
  approver: new Set([...READ_VERBS, ...APPROVE_VERBS]),
  member: new Set([...READ_VERBS]),
  viewer: new Set([...READ_VERBS]),
  auditor: new Set([...READ_VERBS]),
};

/**
 * Does holding `relation` on a resource cover `action`? Fails closed: an
 * unrecognized relation or a verb none of the fixed classes contain both
 * return `false`, never `true`.
 */
export function relationGrantsAction(relation: RelationKind, action: string): boolean {
  const verbs = RELATION_VERB_CLASSES[relation];
  if (!verbs) return false; // defensive — RelationKind is a closed union, but never trust blindly
  return verbs.has(actionVerb(action));
}
