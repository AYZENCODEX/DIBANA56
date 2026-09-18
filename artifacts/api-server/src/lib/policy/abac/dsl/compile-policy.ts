/**
 * lib/policy/abac/dsl/compile-policy.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 06 (Policy DSL).
 *
 * The seam between "a policy author writes DSL text" and "`createAbacRule()`
 * (abac-rule.ts) evaluates an `AbacCondition` tree". `AbacPolicyDefinitionSource`
 * is exactly `AbacPolicyDefinition` (abac/types.ts) with `condition` replaced
 * by `expression: string`; `compileAbacPolicy()`/`compileAbacPolicies()`
 * parse that text ONCE via `parseAbacDsl()` and hand back the same
 * `AbacPolicyDefinition` shape `createAbacRule()` already accepts — nothing
 * about the engine's per-request evaluation path changes.
 *
 * This intentionally is NOT the Phase 07 Policy Registry: nothing here
 * persists, versions, or administers policies. It is the minimal glue that
 * makes a future registry's job simple (`load DSL text from storage → call
 * compileAbacPolicy() once at activation time → hand the result to
 * createAbacRule()`), without building storage, versioning, or an admin
 * surface now (Rule 16).
 */

import type { AbacPolicyDefinition } from "../types";
import { parseAbacDsl } from "./parser";

export interface AbacPolicyDefinitionSource {
  id: string;
  effect: "allow" | "deny";
  /** DSL text — see parser.ts's header for the grammar. Parsed exactly
   *  once, here, not on every authorization request. */
  expression: string;
  actions?: string[];
  message?: string;
}

/** Parses `source.expression` and returns the equivalent `AbacPolicyDefinition`.
 *  Throws `DslError` (dsl/errors.ts) if the expression is invalid — the
 *  caller is expected to handle that as an authoring-time validation
 *  failure (e.g. reject a policy-editor submission), not as an
 *  authorization decision. */
export function compileAbacPolicy(source: AbacPolicyDefinitionSource): AbacPolicyDefinition {
  const condition = parseAbacDsl(source.expression);
  return {
    id: source.id,
    effect: source.effect,
    condition,
    actions: source.actions,
    message: source.message,
  };
}

/** Compiles a whole batch. Fails on the first invalid expression (does not
 *  partially compile) — a policy set with even one invalid statement must
 *  never be silently registered with that statement dropped, which would
 *  change the set's meaning without anyone asking for that (fail closed:
 *  Rule 8). */
export function compileAbacPolicies(sources: readonly AbacPolicyDefinitionSource[]): AbacPolicyDefinition[] {
  return sources.map(compileAbacPolicy);
}
