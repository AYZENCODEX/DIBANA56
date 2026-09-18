/**
 * lib/policy/registry/registry-rule-loader.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 16 (Policy Versioning).
 *
 * The seam the Phase 07 registry (policy-registry.ts) deliberately left
 * unbuilt (see that file's own header: "Nothing here feeds an ACTIVE
 * policy's compiled rule into the PDP's PolicyEngine at evaluation time
 * ... is a natural next step but is a distinct piece of wiring"):
 * `createRegistryPolicyRule()` turns ONE `PolicyRecord` (registry/types.ts)
 * into a real `PolicyRule` (../policy-engine.ts) that `PolicyEngine.registerRule()`
 * can consume, and `createRegistryPolicyRules()` does the same for a whole
 * `listActivePolicies()`-shaped batch.
 *
 * ── Why this belongs to Phase 16, not Phase 07 ───────────────────────────
 * Phase 07's own scope was the PAP (author/version/approve/activate) —
 * complete and correct without ever touching the PDP's evaluation path
 * (Rule 16: do not implement future phases prematurely). What makes this a
 * *versioning* concern rather than merely "finish the registry wiring" is
 * the field this function's whole reason for existing is to stamp:
 * `policyVersion` (../types.ts, added this same phase) — every decision a
 * registry-backed rule produces carries not just WHICH policy decided it
 * (`policyId`, already possible since Phase 01) but WHICH VERSION of that
 * policy, which is the one piece of information `../reproducibility.ts`'s
 * `getDecisionPolicySnapshot()` needs to look the exact original version
 * back up later, even after a newer version has since superseded it (Rule
 * 11: "Historical decisions must remain reproducible").
 *
 * ── Reuses Phase 05/06's evaluator verbatim — no second condition engine ──
 * A `PolicyRecord` with `ruleKind: "abac_dsl"` is compiled with the exact
 * same `compileAbacPolicy()` (../abac/dsl) `policy-registry.ts`'s own
 * `validateRuleContent()` already uses to REJECT an uncompilable policy at
 * authoring time — so a `PolicyRecord` that ever reached ACTIVE status is
 * guaranteed, by construction, to compile here too. Matching (does this
 * record apply to this request's action) reuses `rbac/permission-matcher.ts`'s
 * `permissionMatches()`, same grammar `abac/abac-rule.ts` already reuses
 * for its own `AbacPolicyDefinition.actions` — one action-matching grammar
 * for the whole engine, not a second one invented here. Condition
 * evaluation reuses `abac/condition-evaluator.ts#evaluateAbacCondition()`
 * over an `AttributeBag` built by `abac/attribute-resolver.ts#resolveAttributes()`
 * — identical to how `abac-rule.ts` itself evaluates a hand-built
 * `AbacPolicyDefinition`. This file is glue, not a new evaluator.
 *
 * ── Action pattern: `application.resource.action`, verbatim from the row ──
 * A `PolicyRecord`'s `application`/`resource`/`action` columns are exactly
 * the three dot-segments `permission-matcher.ts`'s own "product.resource.
 * action" grammar names (see that file's header) — this loader joins them
 * with `.` to build the one pattern this record applies to
 * (`"sylo.vault.read"`, etc.). A registry policy is always exactly this
 * specific about which action it covers; there is no registry-level
 * equivalent of `AbacPolicyDefinition.actions` accepting a *list* of
 * patterns, because Phase 07's own `PolicyRecord` schema only ever
 * recorded one `resource`/`action` pair per row (see registry/types.ts) —
 * this loader does not invent a wider grammar the stored data doesn't
 * actually carry.
 *
 * ── Fails closed on a non-ACTIVE record, synchronously, at construction ──
 * `createRegistryPolicyRule()` throws IMMEDIATELY (never returns a rule
 * that would throw or silently misbehave later) if `record.status !==
 * "ACTIVE"` — feeding a DRAFT/TESTING/APPROVED/DISABLED/ARCHIVED row's
 * rule content into live traffic would mean an unreviewed, un-approved, or
 * deliberately-retired policy is deciding real requests, which is exactly
 * what the Phase 07 lifecycle (registry/lifecycle.ts) exists to prevent.
 * The caller (a future PEP-layer loader — not built by this phase, same
 * "provide the engine, not the endpoint" posture policy-registry.ts's own
 * header already draws for itself) is expected to source records from
 * `PolicyRegistryProvider.listActivePolicies()`/`getActivePolicy()`, which
 * only ever return ACTIVE rows in the first place — this check exists so a
 * caller that passes a record from anywhere else (a stale cache entry, a
 * test fixture, a mistaken `getPolicy()` call for a specific non-ACTIVE
 * version) fails loudly rather than silently authorizing traffic against
 * unreviewed content. `createRegistryPolicyRules()` takes the opposite,
 * equally deliberate stance for a *batch*: it SILENTLY SKIPS any non-ACTIVE
 * row rather than throwing, because a real `listActivePolicies()` result
 * set may briefly contain such a row seen mid-transition (Rule 8's fail-
 * closed principle argues for excluding it, not for aborting the entire
 * batch load over one row a caller didn't hand-pick).
 *
 * ── Abstain, never throw, on a non-matching request ───────────────────────
 * Same "no opinion, not a decision" posture every other Phase 02-05 rule in
 * this engine already establishes (see abac-rule.ts's own header): when the
 * action doesn't match, or the condition evaluates false, this rule returns
 * `null` so `policy-engine.ts`'s deny-overrides loop simply moves on to the
 * next registered rule — a registry policy having no opinion on a request
 * must never itself become a decision (default-deny, if nothing else
 * grants, already handles "nobody had an opinion" at the engine level).
 */

import { allow, deny } from "../authorization-decision";
import { compileAbacPolicy } from "../abac/dsl";
import { evaluateAbacCondition } from "../abac/condition-evaluator";
import { resolveAttributes } from "../abac/attribute-resolver";
import { permissionMatches } from "../rbac/permission-matcher";
import type { PolicyRule, RegisteredPolicyRule } from "../policy-engine";
import type { PolicyRecord } from "./types";

/** Builds the one `product.resource.action` pattern `record` applies to —
 *  see file header's "Action pattern" section for why this is always
 *  exactly one pattern, never a list. */
function actionPatternFor(record: PolicyRecord): string {
  return `${record.application}.${record.resource}.${record.action}`;
}

/**
 * Turns one ACTIVE `PolicyRecord` into a real `PolicyRule`. Throws
 * synchronously if `record.status !== "ACTIVE"` (see file header) — this
 * check runs once, at rule-construction time, not on every request; the
 * DSL compile below also runs exactly once here for the same reason
 * (`compile-policy.ts`'s own header: "parsing authoring-time... evaluation
 * request-time — kept separate deliberately", the same discipline this
 * loader follows for a registry-sourced policy).
 *
 * Every decision this rule produces (ALLOW via `record.effect === "allow"`,
 * DENY via `record.effect === "deny"`) is stamped with BOTH `policyId:
 * record.policyId` and `policyVersion: record.version` — read off the same
 * `PolicyRecord`, so the two can never disagree about which version fired
 * (see types.ts's own doc comment on `AuthorizationDecision.policyVersion`).
 */
export function createRegistryPolicyRule(record: PolicyRecord): PolicyRule {
  if (record.status !== "ACTIVE") {
    throw new Error(
      `createRegistryPolicyRule(): policy "${record.policyId}" version ${record.version} is not ACTIVE (status: ${record.status}) — only an ACTIVE record's rule content may be fed into the PDP.`,
    );
  }

  // Compiled once, here, at rule-construction time — never on every
  // request. A record that ever reached ACTIVE already passed
  // policy-registry.ts's own `validateRuleContent()` at authoring time, so
  // this compile is not expected to fail in practice, but it is not
  // suppressed either: a compile failure here still throws, same
  // fail-closed posture every other compile-time failure in this engine
  // takes (Rule 8).
  const compiled = compileAbacPolicy({
    id: record.policyId,
    effect: record.effect,
    expression: record.rules,
  });

  const actionPattern = actionPatternFor(record);

  return (request) => {
    const subject = request.subject;
    // Defensive only — policy-engine.ts already returns UNAUTHENTICATED
    // before any rule runs when subject is null (see evaluateCore()).
    if (!subject) return null;

    if (!permissionMatches(actionPattern, request.action)) return null; // abstain: not this record's action

    const bag = resolveAttributes(subject, request.resource, request.context, request.action);
    if (!evaluateAbacCondition(compiled.condition, bag)) return null; // abstain: condition didn't match

    const stampOptions = {
      policyId: record.policyId,
      policyVersion: record.version,
      message: `registry policy "${record.policyId}" v${record.version} ${record.effect === "deny" ? "denied" : "allowed"} this request`,
    };

    return record.effect === "deny"
      ? deny(request, "EXPLICIT_DENY", stampOptions)
      : allow(request, "EXPLICIT_ALLOW", stampOptions);
  };
}

/**
 * Batch form: builds a `RegisteredPolicyRule` for every ACTIVE row in
 * `records`, SILENTLY SKIPPING any non-ACTIVE row (see file header's
 * "Fails closed" section for why this differs from
 * `createRegistryPolicyRule()`'s own throw-on-non-ACTIVE posture). Each
 * rule is registered under its own `record.policyId` — the natural,
 * already-unique id every `PolicyRecord` carries (registry/types.ts) —
 * exactly what a caller would pass as the `id` argument to
 * `PolicyEngine.registerRule()` for each entry.
 *
 * Intended caller shape (not wired into any real loader by this phase —
 * same "provide the engine, not the endpoint" posture policy-registry.ts's
 * own header already draws for itself):
 *
 *   const records = await provider.listActivePolicies({ application: "sylo" });
 *   for (const { id, rule } of createRegistryPolicyRules(records)) {
 *     engine.registerRule(id, rule);
 *   }
 */
export function createRegistryPolicyRules(records: readonly PolicyRecord[]): RegisteredPolicyRule[] {
  const result: RegisteredPolicyRule[] = [];
  for (const record of records) {
    if (record.status !== "ACTIVE") continue; // silently skip — see file header
    result.push({ id: record.policyId, rule: createRegistryPolicyRule(record) });
  }
  return result;
}
