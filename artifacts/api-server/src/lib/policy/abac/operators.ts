/**
 * lib/policy/abac/operators.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 05 (ABAC).
 *
 * Pure functions implementing every operator `AttributeComparison` can name
 * (types.ts). No DB, no Express, no exceptions — same discipline every other
 * lib/policy/* pure-logic module already established (see
 * rbac/permission-matcher.ts's header for the same "fails closed, never
 * throws" posture applied to a different comparison problem).
 *
 * ── Fails closed on incomparable values, never throws ─────────────────────
 * A comparison whose operands can't meaningfully be ordered (e.g. comparing
 * a string role name against a Date, or a boolean against a number) simply
 * evaluates to `false` — "this condition is not satisfied" — rather than
 * throwing. This matters for the same reason `permissionMatches()` fails
 * closed on a malformed grant pattern: a bug or unexpected attribute shape
 * must never turn "condition doesn't match" into an uncaught exception that
 * `policy-engine.ts` would otherwise have to convert into a POLICY_EVALUATION_ERROR
 * deny. Both outcomes are "deny" in the end (an abstaining ABAC rule falls
 * through to default-deny same as any other abstention), but failing closed
 * *within* the comparison keeps `abac-rule.ts` a plain, exception-free
 * function, matching every other rule in this engine.
 *
 * ── Deterministic ──────────────────────────────────────────────────────────
 * Every function here is a pure function of its arguments — no clock reads
 * (a `before`/`after` comparison's "now" is whatever `environment.time`
 * the caller resolved it to, already fixed at request-build time — see
 * policy-context.ts), no randomness, no hidden state.
 */

import type { AttributeOperator, AttributeValue } from "./types";

/** True for a string that is unambiguously a plain integer or decimal
 *  number (optional leading `-`, digits, optional `.digits`) — no
 *  whitespace, no exponent notation, no leading `+`. Deliberately strict:
 *  this is only used to decide whether a numeric-looking string may be
 *  treated as equal to a `number`, so it must not accept anything a naive
 *  `Number(x)` coercion would parse "creatively" (e.g. `""`, `"  42"`,
 *  `"1e3"`, `"0x2a"` are all rejected here even though `Number()` would
 *  parse some of them). */
function isPlainNumericString(value: string): boolean {
  return /^-?\d+(\.\d+)?$/.test(value);
}

/** Normalizes a value for equality comparison: `Date` → epoch millis (so a
 *  `Date` and a numeric/ISO-string value can compare equal if they represent
 *  the same instant), everything else passed through unchanged. */
function normalizeForEquality(value: unknown): unknown {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    // Only treat as a timestamp if the string is unambiguously a full ISO
    // date/time (has a date component with dashes) — otherwise "5" would
    // parse as a nonsense date-ish number and silently change comparisons
    // for perfectly ordinary short strings.
    if (!Number.isNaN(parsed) && /^\d{4}-\d{2}-\d{2}/.test(value)) return parsed;
  }
  return value;
}

/** Structural, type-tolerant equality for the closed `AttributeValue`
 *  domain. Arrays compare element-wise in order (used when an attribute
 *  itself is array-valued, e.g. comparing `subject.scopes` directly rather
 *  than via `in`).
 *
 * Numeric string ↔ number equivalence: `ResourceRef.id` (and similar
 * caller-supplied identifiers) is typed `string | number` — the same
 * caller might populate it either way depending on where it came from
 * (route params are strings; a DB primary key is often a number). Every
 * other resource-identity-consuming rule in this engine already normalizes
 * this away by calling `String(resourceId)` before comparing/looking up
 * (see explicit-grant-rule.ts / rebac-rule.ts) — an ABAC condition author
 * writing `{ attribute: "resource.id", operator: "equals", value: "42" }`
 * should get the same "these mean the same resource" answer regardless of
 * which JS type the resolved attribute happens to be, so `42` and `"42"`
 * compare equal here too. This equivalence is deliberately narrow
 * (`isPlainNumericString()` above) so it can never make two semantically
 * different strings (e.g. a role name that happens to look numeric) match
 * a number by accident — it only fires when one side is already a
 * `number` and the other is unambiguously that same number spelled out as
 * a string. */
export function valuesEqual(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => valuesEqual(v, b[i]));
  }
  if (Array.isArray(a) || Array.isArray(b)) return false;

  const na = normalizeForEquality(a);
  const nb = normalizeForEquality(b);
  if (na === nb) return true;

  if (typeof na === "number" && typeof nb === "string" && isPlainNumericString(nb)) {
    return na === Number(nb);
  }
  if (typeof nb === "number" && typeof na === "string" && isPlainNumericString(na)) {
    return nb === Number(na);
  }
  return false;
}

/** Converts a value to a single orderable number for `greaterThan`/
 *  `lessThan`/`before`/`after`-family comparisons, or `undefined` if it
 *  can't be meaningfully ordered (fails closed — see file header). Numbers
 *  pass through; `Date`s and full ISO date/time strings become epoch
 *  millis; everything else (booleans, arrays, plain non-date strings,
 *  null/undefined) is not orderable here. */
function toOrderable(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

/** True if `needle` appears in `haystack` under `valuesEqual()` semantics.
 *  `haystack` must actually be an array — a non-array `value` on an `in`/
 *  `notIn` comparison is a malformed condition, not a match, and fails
 *  closed to `false` rather than throwing. */
function includesValue(haystack: unknown, needle: unknown): boolean {
  if (!Array.isArray(haystack)) return false;
  return haystack.some((candidate) => valuesEqual(candidate, needle));
}

/**
 * Evaluates one operator against a resolved attribute value and a
 * condition's literal `value`. `exists`/`notExists` test presence only
 * (ignore `value` entirely) — every other operator treats a missing
 * (`undefined`/`null`) attribute as "condition not satisfied" (`false`),
 * never as a match and never as a thrown error.
 */
export function evaluateOperator(
  operator: AttributeOperator,
  attributeValue: unknown,
  conditionValue: AttributeValue,
): boolean {
  if (operator === "exists") return attributeValue !== undefined && attributeValue !== null;
  if (operator === "notExists") return attributeValue === undefined || attributeValue === null;

  if (attributeValue === undefined || attributeValue === null) return false;

  switch (operator) {
    case "equals":
      return valuesEqual(attributeValue, conditionValue);
    case "notEquals":
      return !valuesEqual(attributeValue, conditionValue);
    case "in":
      return includesValue(conditionValue, attributeValue);
    case "notIn":
      return !includesValue(conditionValue, attributeValue);
    case "greaterThan":
    case "greaterThanOrEqual":
    case "lessThan":
    case "lessThanOrEqual":
    case "before":
    case "after": {
      const left = toOrderable(attributeValue);
      const right = toOrderable(conditionValue);
      if (left === undefined || right === undefined) return false; // not comparable — fails closed
      switch (operator) {
        case "greaterThan":
          return left > right;
        case "greaterThanOrEqual":
          return left >= right;
        case "lessThan":
          return left < right;
        case "lessThanOrEqual":
          return left <= right;
        case "before":
          return left < right;
        case "after":
          return left > right;
      }
    }
  }

  // Unreachable given AttributeOperator is a closed union, but keeps this
  // function total (fails closed) rather than implicitly returning
  // `undefined` if the union is ever extended without updating this switch.
  return false;
}
