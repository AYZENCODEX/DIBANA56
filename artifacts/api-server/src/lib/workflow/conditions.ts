/**
 * lib/workflow/conditions.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Mega Engine — Phase 8 blueprint, Part C2: Workflow execution logic
 * (§20 Workflow Conditions). Types.ts (C1) deliberately left `condition`
 * untyped — this is that piece.
 *
 * §20's own closed vocabulary, verbatim: equals/notEquals/exists/notExists/
 * in/notIn/greaterThan/lessThan/and/or/not. Nothing else. In particular:
 * NO `expr`/`script`/`fn` variant of any kind — §20's own explicit "No
 * eval(userProvidedString) / No unrestricted JavaScript/Python execution"
 * is enforced structurally here, by WorkflowCondition simply having no
 * constructor for arbitrary code in the first place, the same posture
 * definition-store.ts's validateDefinition() already draws for `type`
 * (an action-registry KEY, never a code string) — see that file's header.
 *
 * `path` is a dot-path into the flat data object the engine hands
 * evaluateCondition() (run context + workflow variables merged — see
 * engine.ts's buildConditionData()), resolved by simple property lookup
 * only (no array/bracket syntax, no wildcards) — deliberately the
 * smallest resolver that satisfies §20, not a general JSONPath/JMESPath
 * implementation.
 */

/** §20's closed vocabulary. A step's `condition` (types.ts) is one of these — see this file's header for why nothing else is (or ever should be) added to this union. */
export type WorkflowCondition =
  | { op: "equals"; path: string; value: unknown }
  | { op: "notEquals"; path: string; value: unknown }
  | { op: "exists"; path: string }
  | { op: "notExists"; path: string }
  | { op: "in"; path: string; values: unknown[] }
  | { op: "notIn"; path: string; values: unknown[] }
  | { op: "greaterThan"; path: string; value: number }
  | { op: "lessThan"; path: string; value: number }
  | { op: "and"; conditions: WorkflowCondition[] }
  | { op: "or"; conditions: WorkflowCondition[] }
  | { op: "not"; condition: WorkflowCondition };

export class InvalidConditionError extends Error {
  constructor(message: string) {
    super(`Invalid workflow condition: ${message}`);
    this.name = "InvalidConditionError";
  }
}

/** Dot-path lookup only (`"a.b.c"`) — no bracket/array indexing, no wildcards. `undefined` for any missing/unreachable segment, never a thrown error (a condition testing "notExists" on a genuinely absent path is a normal, expected case, not a fault). */
function resolvePath(data: Record<string, unknown>, path: string): unknown {
  if (!path) return undefined;
  let cursor: unknown = data;
  for (const segment of path.split(".")) {
    if (cursor === null || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

/**
 * Structural validation only, same "fail at the call site" posture
 * definition-store.ts's validateDefinition() already uses — a caller
 * (definition-store.ts, when validating a step's `condition`) can call
 * this synchronously before ever persisting a definition, instead of
 * discovering a malformed condition only at first RUN time.
 */
export function validateCondition(condition: WorkflowCondition, depth = 0): void {
  if (depth > 10) throw new InvalidConditionError("nesting exceeds 10 levels");
  switch (condition.op) {
    case "equals":
    case "notEquals":
      if (!condition.path) throw new InvalidConditionError(`"${condition.op}" requires a path`);
      return;
    case "exists":
    case "notExists":
      if (!condition.path) throw new InvalidConditionError(`"${condition.op}" requires a path`);
      return;
    case "in":
    case "notIn":
      if (!condition.path) throw new InvalidConditionError(`"${condition.op}" requires a path`);
      if (!Array.isArray(condition.values)) throw new InvalidConditionError(`"${condition.op}" requires a values array`);
      return;
    case "greaterThan":
    case "lessThan":
      if (!condition.path) throw new InvalidConditionError(`"${condition.op}" requires a path`);
      if (typeof condition.value !== "number") throw new InvalidConditionError(`"${condition.op}" requires a numeric value`);
      return;
    case "and":
    case "or":
      if (!Array.isArray(condition.conditions) || condition.conditions.length === 0) {
        throw new InvalidConditionError(`"${condition.op}" requires a non-empty conditions array`);
      }
      for (const c of condition.conditions) validateCondition(c, depth + 1);
      return;
    case "not":
      if (!condition.condition) throw new InvalidConditionError(`"not" requires a condition`);
      validateCondition(condition.condition, depth + 1);
      return;
    default: {
      const exhaustive: never = condition;
      throw new InvalidConditionError(`unknown operator "${(exhaustive as { op: string }).op}"`);
    }
  }
}

/**
 * Pure, synchronous, deterministic (§12/Rule 12's same posture the Policy
 * Engine's own evaluate() holds itself to) — same `data` in always
 * produces the same boolean out, no I/O, no randomness. Never throws for
 * a well-formed WorkflowCondition; call validateCondition() first (e.g.
 * at definition-publish time) to catch a malformed one before it ever
 * reaches here.
 */
export function evaluateCondition(condition: WorkflowCondition, data: Record<string, unknown>): boolean {
  switch (condition.op) {
    case "equals":
      return resolvePath(data, condition.path) === condition.value;
    case "notEquals":
      return resolvePath(data, condition.path) !== condition.value;
    case "exists":
      return resolvePath(data, condition.path) !== undefined;
    case "notExists":
      return resolvePath(data, condition.path) === undefined;
    case "in":
      return condition.values.includes(resolvePath(data, condition.path));
    case "notIn":
      return !condition.values.includes(resolvePath(data, condition.path));
    case "greaterThan": {
      const v = resolvePath(data, condition.path);
      return typeof v === "number" && v > condition.value;
    }
    case "lessThan": {
      const v = resolvePath(data, condition.path);
      return typeof v === "number" && v < condition.value;
    }
    case "and":
      return condition.conditions.every((c) => evaluateCondition(c, data));
    case "or":
      return condition.conditions.some((c) => evaluateCondition(c, data));
    case "not":
      return !evaluateCondition(condition.condition, data);
    default:
      return false; // unreachable for a validated condition — fail closed (skip the step) rather than throw mid-run for an unrecognized shape.
  }
}
