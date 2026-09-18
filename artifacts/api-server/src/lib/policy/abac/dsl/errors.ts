/**
 * lib/policy/abac/dsl/errors.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 06 (Policy DSL).
 *
 * `DslError` is the one error type `tokenizer.ts`/`parser.ts` ever throw.
 * Deliberately a plain, typed, catchable error — never a raw string throw,
 * same discipline `policy-errors.ts` established for the engine core. This
 * is an AUTHORING-TIME error: it is thrown while compiling DSL text into an
 * `AbacCondition` (an admin/deploy-time operation — see `parser.ts`'s
 * header), never while evaluating an authorization request. It therefore
 * does NOT flow through `policy-engine.ts`'s POLICY_EVALUATION_ERROR path —
 * a caller (an admin tool, a future Phase 07 policy-registry loader, a
 * test) is expected to catch it before ever registering a policy built from
 * unvalidated text.
 */

export type DslErrorCode =
  | "INPUT_TOO_LONG"
  | "TOO_MANY_TOKENS"
  | "UNEXPECTED_CHARACTER"
  | "UNTERMINATED_STRING"
  | "STRING_TOO_LONG"
  | "INVALID_NUMBER"
  | "UNEXPECTED_TOKEN"
  | "UNEXPECTED_END_OF_INPUT"
  | "MAX_NESTING_DEPTH_EXCEEDED"
  | "UNKNOWN_ATTRIBUTE_GROUP"
  | "INVALID_ATTRIBUTE_PATH"
  | "EMPTY_EXPRESSION"
  | "TRAILING_INPUT"
  | "INVALID_LEFT_OPERAND"
  | "EMPTY_LIST";

export class DslError extends Error {
  readonly code: DslErrorCode;
  /** 0-based character offset into the original source where the problem
   *  was detected — always present, even for "unexpected end of input"
   *  (points at the source's length), so a caller can render a caret under
   *  the offending character without re-deriving it. */
  readonly position: number;

  constructor(code: DslErrorCode, message: string, position: number) {
    super(`${message} (at position ${position})`);
    this.name = "DslError";
    this.code = code;
    this.position = position;
  }
}
