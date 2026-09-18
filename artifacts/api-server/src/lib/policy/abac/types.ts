/**
 * lib/policy/abac/types.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 05 (ABAC).
 *
 * Pure types. No DB, no Express — same discipline every other lib/policy/*
 * module already established (see rbac/types.ts, rebac/types.ts,
 * resource/types.ts). Nothing here reaches into storage: every attribute an
 * ABAC condition can reference is either already present on `Subject` /
 * `ResourceRef` / `PolicyContext` (see the Phase 05 additions to
 * ../types.ts) or derived from `AuthorizationRequest.action` itself.
 *
 * ── What Phase 05 deliberately is NOT ─────────────────────────────────────
 * This is not the "Policy DSL" the roadmap describes for Phase 06 — there is
 * no string grammar, no parser, and nothing here is ever `eval()`'d or
 * otherwise dynamically executed (roadmap Phase 06's "never use eval() or
 * equivalent" requirement is satisfied trivially here because there is no
 * expression *language* yet, only a typed, already-validated-by-TypeScript
 * condition *tree* built directly as plain objects). `AbacCondition` is
 * exactly the shape a Phase 06 DSL parser will eventually PRODUCE by parsing
 * a string like `subject.role == "admin" AND resource.sensitivity == "high"`
 * — Phase 05 builds the evaluator that consumes that shape; Phase 06's job
 * is only to build a parser that turns text into it. This is also not a
 * policy REGISTRY (Phase 07) — nothing here is versioned, persisted, or
 * administratively editable; `AbacPolicyDefinition[]` is passed in by
 * whatever code registers the rule, the same way `createExplicitResourceGrantRule()`
 * takes a provider and `createRebacRule()` takes a provider (Rule 16: do not
 * implement future phases prematurely).
 *
 * ── Phase 06 update ────────────────────────────────────────────────────
 * `AttributeComparison` gained an optional `valueAttribute` field so a
 * comparison's right-hand side can be another dynamic attribute path
 * instead of only a fixed literal (needed for the roadmap's own Phase 06
 * example, `subject.organization == resource.organization`). This is a
 * pure, additive widening of the same node shape — every `AbacCondition`
 * built during Phase 05 (literal-only comparisons) still means exactly
 * what it meant before; `dsl/parser.ts#parseAbacDsl()` is simply a second
 * way to produce this same tree, alongside building it by hand.
 *
 * ── Bounded and deterministic by construction ─────────────────────────────
 * `AbacCondition` is a finite tree of a closed set of node kinds
 * (comparison / and / or / not). There is no recursion primitive a condition
 * author could use to build an unbounded or self-referential structure at
 * evaluation time — the tree is exactly as deep as it was constructed, and
 * `condition-evaluator.ts` just walks it once. Combined with `operators.ts`
 * never throwing (a non-comparable value fails the comparison rather than
 * throwing), evaluation is deterministic and side-effect-free: the same
 * `(condition, AttributeBag)` pair always evaluates to the same boolean.
 */

/**
 * The closed set of attribute values this module ever compares. Deliberately
 * NOT `unknown`/`any` — every value flowing through the ABAC evaluator is one
 * of these, which is what lets `operators.ts` reason about comparability
 * without runtime type gymnastics. Arrays are supported for `in`/`notIn`'s
 * right-hand side and for array-valued attributes (e.g. `subject.scopes`,
 * `subject.assuranceMethods`).
 */
export type AttributeValue =
  | string
  | number
  | boolean
  | Date
  | null
  | undefined
  | string[]
  | number[];

/**
 * The flat, read-only view of everything an ABAC condition can reference for
 * one `AuthorizationRequest`. Built by `attribute-resolver.ts#resolveAttributes()`
 * — never constructed by hand outside tests. Grouped exactly the way the
 * roadmap's Phase 05 section groups them: subject / resource / environment,
 * plus the request's own `action` (useful for `AbacPolicyDefinition.actions`-
 * style matching without a separate top-level concept).
 */
export interface AttributeBag {
  readonly action: string;
  readonly subject: {
    readonly userId: number;
    readonly role: string;
    readonly authType: string;
    readonly organizationId?: number | null;
    readonly accountState?: string;
    readonly verificationLevel?: string | number;
    readonly riskLevel?: string;
    readonly keyType?: string;
    readonly scopes?: string[];
    readonly assuranceMethods?: string[];
  };
  readonly resource: {
    readonly type: string;
    readonly id?: string | number;
    readonly ownerId?: number;
    readonly organizationId?: number | null;
    readonly classification?: string;
    readonly state?: string;
    readonly sensitivity?: string;
    readonly locked?: boolean;
  };
  readonly environment: {
    readonly time: Date;
    readonly ip?: string;
    readonly sessionId?: string;
    readonly deviceTrust?: string;
    readonly sessionAgeSeconds?: number;
    readonly authenticationFreshnessSeconds?: number;
  };
}

/**
 * Every operator the roadmap's Phase 05 section names, plus `before`/`after`
 * as explicit aliases for the "time comparisons" line item (semantically
 * identical to `lessThan`/`greaterThan` — see operators.ts — but named
 * separately so a condition author writes `before`/`after` against
 * `environment.time`-shaped attributes and `lessThan`/`greaterThan` against
 * plain numeric ones, which reads better and is easier to audit).
 */
export type AttributeOperator =
  | "equals"
  | "notEquals"
  | "greaterThan"
  | "greaterThanOrEqual"
  | "lessThan"
  | "lessThanOrEqual"
  | "in"
  | "notIn"
  | "exists"
  | "notExists"
  | "before"
  | "after";

/**
 * One leaf comparison: "the attribute at `attribute` (a dot path — see
 * attribute-resolver.ts's `getAttribute()`) relates to a right-hand side
 * via `operator`". The right-hand side is either a literal `value` (the
 * only form Phase 05 shipped with) or, as of Phase 06, another attribute
 * path via `valueAttribute` — needed for the roadmap's own Phase 06
 * conceptual example (`subject.organization == resource.organization`),
 * which compares two *dynamic* attributes rather than an attribute against
 * a constant. Exactly one of `value`/`valueAttribute` should be set for
 * every operator except `exists`/`notExists`, which ignore both (only
 * presence of `attribute` matters). Building this object directly (Phase
 * 05's usage) or via `dsl/parser.ts#parseAbacDsl()` (Phase 06) produce the
 * identical shape — the evaluator (`condition-evaluator.ts`) doesn't know
 * or care which one produced it.
 */
export interface AttributeComparison {
  kind: "comparison";
  attribute: string;
  operator: AttributeOperator;
  value?: AttributeValue;
  /** Phase 06 addition. When set, the comparison's right-hand side is
   *  resolved from `this` dot path at evaluation time instead of being a
   *  fixed literal. Mutually exclusive with `value` in practice (a
   *  condition built by `parseAbacDsl()` only ever sets one); if both are
   *  somehow set, `condition-evaluator.ts` prefers `valueAttribute` (a
   *  dynamic comparison is never silently downgraded to a stale literal). */
  valueAttribute?: string;
}

export interface AbacAnd {
  kind: "and";
  conditions: AbacCondition[];
}

export interface AbacOr {
  kind: "or";
  conditions: AbacCondition[];
}

export interface AbacNot {
  kind: "not";
  condition: AbacCondition;
}

/** The full condition tree: a leaf comparison, or AND/OR/NOT over other
 *  conditions (which may themselves be leaves or further AND/OR/NOT). */
export type AbacCondition = AttributeComparison | AbacAnd | AbacOr | AbacNot;

/**
 * One attribute-based policy statement, as `createAbacRule()` (abac-rule.ts)
 * consumes it. Deliberately NOT persisted/versioned/administered anywhere —
 * that is Phase 07 (Policy Registry)'s job; this is the in-memory shape a
 * caller passes directly to `createAbacRule()`, same posture as every other
 * Phase 02-04 rule factory's input.
 */
export interface AbacPolicyDefinition {
  /** Stable identifier for this individual statement (distinct from the
   *  rule's own registration id — see ABAC_POLICY_ID in abac-rule.ts).
   *  Surfaced in the decision's `message` for audit/debugging. */
  id: string;
  effect: "allow" | "deny";
  condition: AbacCondition;
  /** Optional action pattern(s) this policy applies to, reusing
   *  `rbac/permission-matcher.ts`'s "product.resource.action" / trailing-
   *  wildcard grammar (e.g. `["sylo.vault.*"]`). Omit to apply to every
   *  action regardless of what it is. */
  actions?: string[];
  /** Optional human-readable detail surfaced on the resulting decision's
   *  `message`. Never put secrets/PII here — same rule as everywhere else
   *  in this engine (see authorization-decision.ts). */
  message?: string;
}
