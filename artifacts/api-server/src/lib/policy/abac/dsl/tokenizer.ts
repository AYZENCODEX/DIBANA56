/**
 * lib/policy/abac/dsl/tokenizer.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 06 (Policy DSL).
 *
 * `tokenize()` turns DSL source text into a flat `Token[]` — a classic
 * hand-written lexer, nothing exotic. No regex-based whole-string parsing,
 * no `eval`, no dynamic `Function` construction: this is a single left-to-
 * right character scan that only ever *classifies* substrings of the input
 * into a closed set of `TokenKind`s (see below). It cannot execute anything
 * the input contains — the roadmap's Phase 06 "never use eval() or
 * equivalent" requirement holds by construction here, not by convention.
 *
 * ── Bounded by construction ────────────────────────────────────────────────
 * Three independent bounds, each enforced as soon as it is knowable (never
 * after doing unbounded work first):
 *   - `MAX_INPUT_LENGTH` — the whole source string, checked before scanning
 *     a single character. Guards against a caller (e.g. a future Phase 07
 *     admin-console policy editor) submitting an absurdly large expression.
 *   - `MAX_STRING_LITERAL_LENGTH` — a single quoted string literal, checked
 *     while scanning it. Guards against a pathological single token
 *     dominating memory even under `MAX_INPUT_LENGTH`.
 *   - `MAX_TOKENS` — the total token count, checked after each token is
 *     emitted. Guards against many short tokens (e.g. `1,1,1,1,1,...`)
 *     staying under the character limit while still being expensive to
 *     parse. `parser.ts` separately bounds *nesting depth*, which token
 *     count alone doesn't limit (see that file's header).
 * All three fail closed: hitting any of them throws `DslError` immediately,
 * never truncates-and-continues (truncation would silently change what a
 * policy author asked for, which is worse than refusing outright — Rule 8:
 * "Authorization failures must fail closed").
 *
 * ── Keyword vs. attribute-path disambiguation ──────────────────────────────
 * An identifier token is anything matching `[A-Za-z_][A-Za-z0-9_]*` possibly
 * repeated with `.` separators (a dotted attribute path). Only a *bare*
 * identifier (no dot) is checked against the reserved-word table below, and
 * only using an exact, case-SENSITIVE match — `AND`/`OR`/`NOT`/`IN`/`EXISTS`
 * must be upper-case, `true`/`false`/`null` must be lower-case. This is a
 * deliberate strictness choice (not an oversight): a single fixed casing
 * per keyword removes an entire axis of ambiguity ("is `And` a keyword or a
 * field named And?") from what is supposed to be a typed, validated,
 * deterministic grammar (roadmap's own Phase 06 requirements list). A
 * dotted path can never collide with a keyword regardless of casing, since
 * keywords are single bare words and no reserved word is a sensible
 * attribute path segment on its own.
 */

import { DslError } from "./errors";

export const MAX_INPUT_LENGTH = 4096;
export const MAX_STRING_LITERAL_LENGTH = 512;
export const MAX_TOKENS = 512;

export type TokenKind =
  | "IDENT" // dotted or bare attribute path, e.g. "subject.role" or "action"
  | "STRING"
  | "NUMBER"
  | "TRUE"
  | "FALSE"
  | "NULL"
  | "AND"
  | "OR"
  | "NOT"
  | "IN"
  | "EXISTS"
  | "EQ" // ==
  | "NEQ" // !=
  | "GT" // >
  | "GTE" // >=
  | "LT" // <
  | "LTE" // <=
  | "LPAREN"
  | "RPAREN"
  | "LBRACKET"
  | "RBRACKET"
  | "COMMA"
  | "EOF";

export interface Token {
  kind: TokenKind;
  /** Raw text for IDENT; unescaped value for STRING; decimal-parsed value
   *  for NUMBER. Empty for punctuation/keyword tokens (kind says it all). */
  text: string;
  /** 0-based character offset in the original source where this token
   *  starts — used exclusively for error messages (`DslError.position`). */
  position: number;
}

const KEYWORDS: Readonly<Record<string, TokenKind>> = {
  AND: "AND",
  OR: "OR",
  NOT: "NOT",
  IN: "IN",
  EXISTS: "EXISTS",
  true: "TRUE",
  false: "FALSE",
  null: "NULL",
};

function isIdentStart(ch: string): boolean {
  return /[A-Za-z_]/.test(ch);
}
function isIdentPart(ch: string): boolean {
  return /[A-Za-z0-9_]/.test(ch);
}
function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}
function isWhitespace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
}

export function tokenize(source: string): Token[] {
  if (source.length > MAX_INPUT_LENGTH) {
    throw new DslError(
      "INPUT_TOO_LONG",
      `expression exceeds the maximum allowed length of ${MAX_INPUT_LENGTH} characters`,
      MAX_INPUT_LENGTH,
    );
  }

  const tokens: Token[] = [];
  let i = 0;
  const n = source.length;

  function pushToken(kind: TokenKind, text: string, position: number): void {
    tokens.push({ kind, text, position });
    if (tokens.length > MAX_TOKENS) {
      throw new DslError("TOO_MANY_TOKENS", `expression exceeds the maximum allowed token count of ${MAX_TOKENS}`, position);
    }
  }

  while (i < n) {
    const ch = source[i];

    if (isWhitespace(ch)) {
      i++;
      continue;
    }

    const start = i;

    // ── punctuation ──
    if (ch === "(") {
      pushToken("LPAREN", "(", start);
      i++;
      continue;
    }
    if (ch === ")") {
      pushToken("RPAREN", ")", start);
      i++;
      continue;
    }
    if (ch === "[") {
      pushToken("LBRACKET", "[", start);
      i++;
      continue;
    }
    if (ch === "]") {
      pushToken("RBRACKET", "]", start);
      i++;
      continue;
    }
    if (ch === ",") {
      pushToken("COMMA", ",", start);
      i++;
      continue;
    }

    // ── operators (longest match first: "!=" is the only spelling for
    //    "not equals" — a bare "!" is a syntax error, not silently treated
    //    as anything) ──
    if (ch === "=" && source[i + 1] === "=") {
      pushToken("EQ", "==", start);
      i += 2;
      continue;
    }
    if (ch === "!" && source[i + 1] === "=") {
      pushToken("NEQ", "!=", start);
      i += 2;
      continue;
    }
    if (ch === ">" && source[i + 1] === "=") {
      pushToken("GTE", ">=", start);
      i += 2;
      continue;
    }
    if (ch === "<" && source[i + 1] === "=") {
      pushToken("LTE", "<=", start);
      i += 2;
      continue;
    }
    if (ch === ">") {
      pushToken("GT", ">", start);
      i++;
      continue;
    }
    if (ch === "<") {
      pushToken("LT", "<", start);
      i++;
      continue;
    }

    // ── string literals: single or double quoted, backslash-escaped quote
    //    and backslash only (deliberately no \n/\t/\uXXXX escapes — nothing
    //    a policy condition legitimately needs a control character for) ──
    if (ch === '"' || ch === "'") {
      const quote = ch;
      let value = "";
      i++; // consume opening quote
      let terminated = false;
      while (i < n) {
        const c = source[i];
        if (c === quote) {
          terminated = true;
          i++;
          break;
        }
        if (c === "\\" && (source[i + 1] === quote || source[i + 1] === "\\")) {
          value += source[i + 1];
          i += 2;
        } else {
          value += c;
          i++;
        }
        if (value.length > MAX_STRING_LITERAL_LENGTH) {
          throw new DslError(
            "STRING_TOO_LONG",
            `string literal exceeds the maximum allowed length of ${MAX_STRING_LITERAL_LENGTH} characters`,
            start,
          );
        }
      }
      if (!terminated) {
        throw new DslError("UNTERMINATED_STRING", "unterminated string literal", start);
      }
      pushToken("STRING", value, start);
      continue;
    }

    // ── numbers: optional leading "-", digits, optional ".digits". No
    //    exponent notation, no leading "+", no leading "." — kept simple
    //    and unambiguous on purpose (a validated DSL, not a full language). ──
    if (isDigit(ch) || (ch === "-" && isDigit(source[i + 1] ?? ""))) {
      let j = i;
      if (source[j] === "-") j++;
      while (j < n && isDigit(source[j])) j++;
      if (source[j] === "." && isDigit(source[j + 1] ?? "")) {
        j++;
        while (j < n && isDigit(source[j])) j++;
      }
      const text = source.slice(i, j);
      pushToken("NUMBER", text, start);
      i = j;
      continue;
    }

    // ── identifiers / dotted attribute paths / keywords ──
    if (isIdentStart(ch)) {
      let j = i + 1;
      while (j < n && isIdentPart(source[j])) j++;
      // Extend across "." + identifier repeatedly to capture a dotted path
      // as a single IDENT token (e.g. "subject.role") — but only greedily
      // consume a dot when it is immediately followed by another identifier
      // character, so a trailing "." before something else (e.g. "subject."
      // at end of input, or "subject.)" ) is left for the parser to reject
      // as an invalid path rather than the tokenizer silently swallowing it.
      while (source[j] === "." && isIdentStart(source[j + 1] ?? "")) {
        j++; // consume "."
        while (j < n && isIdentPart(source[j])) j++;
      }
      const text = source.slice(i, j);
      const keyword = text.includes(".") ? undefined : KEYWORDS[text];
      pushToken(keyword ?? "IDENT", text, start);
      i = j;
      continue;
    }

    throw new DslError("UNEXPECTED_CHARACTER", `unexpected character ${JSON.stringify(ch)}`, start);
  }

  tokens.push({ kind: "EOF", text: "", position: n });
  return tokens;
}
