/**
 * lib/policy/abac/dsl/parser.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 06 (Policy DSL).
 *
 * `parseAbacDsl()` is the whole DSL: it turns text like
 *   `subject.organization == resource.organization AND subject.riskLevel != "high"`
 * into exactly the `AbacCondition` tree (abac/types.ts) that
 * `condition-evaluator.ts` already knows how to evaluate — the identical
 * shape `abac-rule.ts`/`AbacPolicyDefinition.condition` consumed since
 * Phase 05. This file adds NO new runtime evaluation semantics; it is
 * purely a compiler from text to that pre-existing tree.
 *
 * ── This is an AUTHORING-TIME operation, not a per-request one ────────────
 * `parseAbacDsl()` is meant to be called ONCE per policy — when a policy is
 * authored/loaded/activated (today: by whatever code builds an
 * `AbacPolicyDefinition[]` to pass to `createAbacRule()`; in a future Phase
 * 07, by a policy-registry loader when a version is activated) — never once
 * per authorization request. `evaluateAbacCondition()` walking the parsed
 * tree stays exactly as cheap and dynamic-code-free per request as it was
 * in Phase 05; parsing text is comparatively expensive and happens off the
 * hot path. See `compile-policy.ts` for the "parse once, hand the engine
 * the already-parsed condition" helper that makes this the natural way to
 * use this file.
 *
 * ── Never uses eval() or equivalent — by construction ──────────────────────
 * This is a hand-written recursive-descent parser over a hand-written
 * tokenizer (tokenizer.ts). At no point is any substring of the DSL source
 * ever passed to `eval()`, `new Function()`, `vm.Script`, a template
 * literal, or any other dynamic-code-execution primitive — the source text
 * is only ever *classified* (tokenizer) and *shaped into a data structure*
 * (this file). The roadmap's Phase 06 "never use eval() or equivalent"
 * requirement therefore isn't a coding-style rule being followed here; the
 * parser has no code path that could violate it even by accident.
 *
 * ── Bounded nesting depth ───────────────────────────────────────────────────
 * `MAX_NESTING_DEPTH` bounds how deep parenthesized groups / NOT chains may
 * recurse (each `(`, and each `NOT`, increments a depth counter that is
 * decremented on return). `tokenizer.ts`'s `MAX_TOKENS` bounds the *number*
 * of tokens but not how deeply they can nest (e.g. `((((((...))))))` uses
 * only 2 tokens per level and could otherwise recurse as deep as
 * `MAX_TOKENS` allows, risking a stack overflow well before that). This is
 * exactly the "unbounded policy evaluation" the roadmap's PERFORMANCE RULES
 * section warns against, applied to compile time instead of eval time.
 *
 * ── Grammar (EBNF) ──────────────────────────────────────────────────────────
 *   expression   := orExpr
 *   orExpr       := andExpr ( "OR" andExpr )*
 *   andExpr      := unaryExpr ( "AND" unaryExpr )*
 *   unaryExpr    := "NOT" unaryExpr | primaryExpr
 *   primaryExpr  := "(" orExpr ")" | existsExpr | comparisonExpr
 *   existsExpr   := "EXISTS" path
 *   comparisonExpr := path ( "IN" listLiteral
 *                           | "NOT" "IN" listLiteral
 *                           | compareOp operand )
 *   compareOp    := "==" | "!=" | ">" | ">=" | "<" | "<="
 *   operand      := path | literal
 *   path         := IDENT                      -- must start with
 *                                                  subject./resource./
 *                                                  environment./action
 *   literal      := STRING | NUMBER | "true" | "false" | "null"
 *   listLiteral  := "[" ( literal ( "," literal )* )? "]"
 *
 * `AND` binds tighter than `OR` (conventional precedence); `NOT` binds
 * tighter than both. The left-hand side of every comparison MUST be an
 * attribute path (never a literal) — `AbacCondition`'s `AttributeComparison`
 * shape requires a string `attribute` field on the left by construction
 * (abac/types.ts), so `"5" == subject.riskLevel` is rejected as
 * `INVALID_LEFT_OPERAND` rather than silently flipped. The right-hand side
 * may be a path (compiles to `valueAttribute` — Phase 06's addition to
 * `AttributeComparison`) or a literal (compiles to `value`, exactly as
 * Phase 05 already supported).
 */

import { DslError } from "./errors";
import { tokenize, type Token, type TokenKind } from "./tokenizer";
import type { AbacCondition, AttributeOperator, AttributeValue } from "../types";

export const MAX_NESTING_DEPTH = 32;

const ATTRIBUTE_GROUPS = new Set(["subject", "resource", "environment"]);

function isValidPath(path: string): boolean {
  if (path === "action") return true;
  const dot = path.indexOf(".");
  if (dot <= 0) return false;
  const group = path.slice(0, dot);
  const rest = path.slice(dot + 1);
  if (!ATTRIBUTE_GROUPS.has(group)) return false;
  if (rest.length === 0 || rest.includes(".")) return false; // Phase 06, like Phase 05, only supports "group.field" — two segments
  return true;
}

class ParserState {
  private readonly tokens: Token[];
  private index = 0;
  private depth = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  peek(): Token {
    return this.tokens[this.index];
  }

  advance(): Token {
    const token = this.tokens[this.index];
    if (token.kind !== "EOF") this.index++;
    return token;
  }

  expect(kind: TokenKind, description: string): Token {
    const token = this.peek();
    if (token.kind !== kind) {
      throw new DslError(
        token.kind === "EOF" ? "UNEXPECTED_END_OF_INPUT" : "UNEXPECTED_TOKEN",
        `expected ${description}, got ${token.kind === "EOF" ? "end of input" : JSON.stringify(token.text || token.kind)}`,
        token.position,
      );
    }
    return this.advance();
  }

  enterNesting(position: number): void {
    this.depth++;
    if (this.depth > MAX_NESTING_DEPTH) {
      throw new DslError("MAX_NESTING_DEPTH_EXCEEDED", `expression nesting exceeds the maximum allowed depth of ${MAX_NESTING_DEPTH}`, position);
    }
  }

  exitNesting(): void {
    this.depth--;
  }
}

function parseOr(state: ParserState): AbacCondition {
  let left = parseAnd(state);
  while (state.peek().kind === "OR") {
    state.advance();
    const right = parseAnd(state);
    left = { kind: "or", conditions: [left, right] };
  }
  return left;
}

function parseAnd(state: ParserState): AbacCondition {
  let left = parseUnary(state);
  while (state.peek().kind === "AND") {
    state.advance();
    const right = parseUnary(state);
    left = { kind: "and", conditions: [left, right] };
  }
  return left;
}

function parseUnary(state: ParserState): AbacCondition {
  if (state.peek().kind === "NOT") {
    const notToken = state.advance();
    state.enterNesting(notToken.position);
    try {
      const inner = parseUnary(state);
      return { kind: "not", condition: inner };
    } finally {
      state.exitNesting();
    }
  }
  return parsePrimary(state);
}

function parsePrimary(state: ParserState): AbacCondition {
  const token = state.peek();

  if (token.kind === "LPAREN") {
    state.advance();
    state.enterNesting(token.position);
    try {
      const inner = parseOr(state);
      state.expect("RPAREN", "')'");
      return inner;
    } finally {
      state.exitNesting();
    }
  }

  if (token.kind === "EXISTS") {
    state.advance();
    const pathToken = state.expect("IDENT", "an attribute path after EXISTS");
    validatePath(pathToken);
    return { kind: "comparison", attribute: pathToken.text, operator: "exists" };
  }

  return parseComparison(state);
}

function validatePath(token: Token): void {
  if (!isValidPath(token.text)) {
    const dot = token.text.indexOf(".");
    const code = dot <= 0 ? "INVALID_ATTRIBUTE_PATH" : "UNKNOWN_ATTRIBUTE_GROUP";
    throw new DslError(
      code,
      `"${token.text}" is not a valid attribute path — expected "action" or "subject."/"resource."/"environment." followed by a field name`,
      token.position,
    );
  }
}

const COMPARE_OPERATORS: Readonly<Partial<Record<TokenKind, AttributeOperator>>> = {
  EQ: "equals",
  NEQ: "notEquals",
  GT: "greaterThan",
  GTE: "greaterThanOrEqual",
  LT: "lessThan",
  LTE: "lessThanOrEqual",
};

function parseComparison(state: ParserState): AbacCondition {
  const leftToken = state.peek();

  if (leftToken.kind !== "IDENT") {
    throw new DslError(
      leftToken.kind === "EOF" ? "UNEXPECTED_END_OF_INPUT" : "INVALID_LEFT_OPERAND",
      `the left-hand side of a comparison must be an attribute path, got ${leftToken.kind === "EOF" ? "end of input" : JSON.stringify(leftToken.text || leftToken.kind)}`,
      leftToken.position,
    );
  }
  state.advance();
  validatePath(leftToken);
  const attribute = leftToken.text;

  const next = state.peek();

  if (next.kind === "IN") {
    state.advance();
    const value = parseListLiteral(state);
    return { kind: "comparison", attribute, operator: "in", value };
  }

  if (next.kind === "NOT") {
    const notToken = state.advance();
    state.expect("IN", "'IN' after 'NOT' in a comparison (only 'NOT IN' is supported here)");
    const value = parseListLiteral(state);
    return { kind: "comparison", attribute, operator: "notIn", value };
  }

  const operator = COMPARE_OPERATORS[next.kind];
  if (!operator) {
    throw new DslError(
      next.kind === "EOF" ? "UNEXPECTED_END_OF_INPUT" : "UNEXPECTED_TOKEN",
      `expected a comparison operator (==, !=, >, >=, <, <=), 'IN', or 'NOT IN' after "${attribute}", got ${next.kind === "EOF" ? "end of input" : JSON.stringify(next.text || next.kind)}`,
      next.position,
    );
  }
  state.advance();

  const rightToken = state.peek();
  if (rightToken.kind === "IDENT") {
    state.advance();
    validatePath(rightToken);
    return { kind: "comparison", attribute, operator, valueAttribute: rightToken.text };
  }

  const value = parseLiteral(state);
  return { kind: "comparison", attribute, operator, value };
}

function parseLiteral(state: ParserState): AttributeValue {
  const token = state.peek();
  switch (token.kind) {
    case "STRING":
      state.advance();
      return token.text;
    case "NUMBER": {
      state.advance();
      const parsed = Number(token.text);
      if (!Number.isFinite(parsed)) {
        throw new DslError("INVALID_NUMBER", `"${token.text}" is not a valid number`, token.position);
      }
      return parsed;
    }
    case "TRUE":
      state.advance();
      return true;
    case "FALSE":
      state.advance();
      return false;
    case "NULL":
      state.advance();
      return null;
    default:
      throw new DslError(
        token.kind === "EOF" ? "UNEXPECTED_END_OF_INPUT" : "UNEXPECTED_TOKEN",
        `expected a literal value (string, number, true, false, or null), got ${token.kind === "EOF" ? "end of input" : JSON.stringify(token.text || token.kind)}`,
        token.position,
      );
  }
}

function parseListLiteral(state: ParserState): AttributeValue {
  const open = state.expect("LBRACKET", "'[' to start a list literal after 'IN'");
  state.enterNesting(open.position);
  try {
    const items: (string | number | boolean | null)[] = [];
    if (state.peek().kind !== "RBRACKET") {
      items.push(parseLiteral(state) as string | number | boolean | null);
      while (state.peek().kind === "COMMA") {
        state.advance();
        items.push(parseLiteral(state) as string | number | boolean | null);
      }
    }
    state.expect("RBRACKET", "']' to close a list literal");
    if (items.length === 0) {
      throw new DslError("EMPTY_LIST", "an 'IN'/'NOT IN' list literal must contain at least one value", open.position);
    }
    // AttributeValue's array member types are string[] | number[] — a
    // mixed-type literal list (e.g. [1, "a"]) is deliberately rejected here
    // rather than silently widened to `unknown[]`, keeping the DSL "typed"
    // per the roadmap's own Phase 06 requirement.
    const allStrings = items.every((v) => typeof v === "string");
    const allNumbers = items.every((v) => typeof v === "number");
    if (!allStrings && !allNumbers) {
      throw new DslError(
        "UNEXPECTED_TOKEN",
        "an 'IN'/'NOT IN' list literal must contain only strings or only numbers, not a mix (and not true/false/null)",
        open.position,
      );
    }
    return items as string[] | number[];
  } finally {
    state.exitNesting();
  }
}

/**
 * Compiles DSL source text into an `AbacCondition`. Throws `DslError` on any
 * syntax problem, out-of-bounds input, or reference to an attribute group
 * outside `subject`/`resource`/`environment`/`action`. Never throws
 * anything else, and never returns a partially-built condition on failure.
 *
 * Call this once, when a policy is authored/loaded — see this file's
 * header and `compile-policy.ts`. Do not call it once per authorization
 * request.
 */
export function parseAbacDsl(source: string): AbacCondition {
  if (source.trim().length === 0) {
    throw new DslError("EMPTY_EXPRESSION", "expression must not be empty", 0);
  }
  const tokens = tokenize(source);
  const state = new ParserState(tokens);
  const condition = parseOr(state);
  const trailing = state.peek();
  if (trailing.kind !== "EOF") {
    throw new DslError(
      "TRAILING_INPUT",
      `unexpected trailing input starting at ${JSON.stringify(trailing.text || trailing.kind)}`,
      trailing.position,
    );
  }
  return condition;
}
