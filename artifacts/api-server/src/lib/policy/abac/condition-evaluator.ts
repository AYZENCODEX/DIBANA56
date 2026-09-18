/**
 * lib/policy/abac/condition-evaluator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 05 (ABAC), extended in
 * Phase 06 (Policy DSL) to resolve attribute-to-attribute comparisons.
 *
 * `evaluateAbacCondition()` walks an `AbacCondition` tree (types.ts) against
 * a resolved `AttributeBag` (attribute-resolver.ts) and reduces it to a
 * single boolean, using `operators.ts` for every leaf comparison. This is
 * the whole "combining AND/OR/NOT" half of the roadmap's Phase 05 operator
 * list — the comparison operators themselves (`equals`, `in`, `before`,
 * etc.) live in operators.ts.
 *
 * ── Bounded, deterministic, side-effect-free ──────────────────────────────
 * A plain recursive walk over an already-fully-built tree (see types.ts's
 * header for why the tree can't be unbounded or self-referential) — no
 * loops that could run away, no IO, no mutation of `bag`. Given the same
 * `(condition, bag)` pair this always returns the same boolean.
 *
 * ── Phase 06: resolving `valueAttribute` ──────────────────────────────────
 * A leaf comparison's right-hand side is either `condition.value` (a fixed
 * literal — the only form Phase 05 produced) or, if present,
 * `condition.valueAttribute` (another dot path, resolved against the same
 * `bag` the left-hand side came from — this is what lets a condition
 * compare `subject.organization` against `resource.organization`
 * dynamically, per request, rather than against a constant baked in at
 * authoring time). `getAttribute()` never throws on an unresolvable path
 * (attribute-resolver.ts), so a `valueAttribute` that doesn't resolve
 * simply yields `undefined` — which every operator except `exists`/
 * `notExists` already treats as "condition not satisfied" (operators.ts).
 * If both `value` and `valueAttribute` are set on the same node (should
 * not happen from `parseAbacDsl()`, but nothing stops a hand-built
 * condition from doing it), `valueAttribute` wins — a dynamic comparison
 * must never be silently downgraded to a stale literal.
 *
 * ── Boundary semantics for empty AND/OR (documented, not incidental) ──────
 * `{ kind: "and", conditions: [] }` evaluates to `true` (vacuously — "every
 * condition in an empty list holds"), the conventional identity for
 * conjunction and consistent with `Array.prototype.every` on an empty
 * array. `{ kind: "or", conditions: [] }` evaluates to `false` — no
 * condition was satisfied because there were none to satisfy — which is
 * also the safer of the two possible defaults (an empty OR can never
 * accidentally grant access). Test coverage for both is one of the
 * "boundary-condition tests" the roadmap's Phase 05 section calls for.
 */

import { evaluateOperator } from "./operators";
import { getAttribute } from "./attribute-resolver";
import type { AbacCondition, AttributeBag, AttributeValue } from "./types";

export function evaluateAbacCondition(condition: AbacCondition, bag: AttributeBag): boolean {
  switch (condition.kind) {
    case "comparison": {
      const attributeValue = getAttribute(bag, condition.attribute);
      // `getAttribute()` returns `unknown` (attribute-resolver.ts) because it
      // performs no runtime narrowing beyond presence/absence — but every
      // value actually stored in an `AttributeBag` is drawn from the closed
      // `AttributeValue` domain (see types.ts), so this cast reflects a
      // genuine invariant of how bags are built, not an escape hatch.
      const conditionValue: AttributeValue =
        condition.valueAttribute !== undefined
          ? (getAttribute(bag, condition.valueAttribute) as AttributeValue)
          : condition.value;
      return evaluateOperator(condition.operator, attributeValue, conditionValue);
    }
    case "and":
      return condition.conditions.every((child) => evaluateAbacCondition(child, bag));
    case "or":
      return condition.conditions.some((child) => evaluateAbacCondition(child, bag));
    case "not":
      return !evaluateAbacCondition(condition.condition, bag);
  }
}
