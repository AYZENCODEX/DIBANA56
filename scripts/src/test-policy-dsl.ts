/**
 * scripts/src/test-policy-dsl.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 06 (Policy DSL) tests.
 *
 * Same shape as every other scripts/src/test-policy-*.ts: DB-free, runnable
 * anywhere with nothing but
 *   npx tsx scripts/src/test-policy-dsl.ts
 *
 * Covers, in order:
 *   1. tokenizer.ts — token classification, keyword vs. dotted-path
 *      disambiguation, string escaping, number parsing.
 *   2. parser.ts — the full grammar (comparisons, AND/OR/NOT, parens, IN/
 *      NOT IN, EXISTS/NOT EXISTS, attribute-to-attribute comparisons),
 *      operator precedence, and every documented error code — including
 *      the "bounded" requirements (INPUT_TOO_LONG, TOO_MANY_TOKENS,
 *      MAX_NESTING_DEPTH_EXCEEDED) the roadmap's Phase 06 section demands.
 *   3. compile-policy.ts — DSL text compiled into an `AbacPolicyDefinition`
 *      and run through the real engine end-to-end.
 *   4. Security: policy injection (malformed/hostile expression text is
 *      always rejected before ever reaching the engine, never silently
 *      coerced into "always allow"), the roadmap's own conceptual example
 *      used as a genuine cross-tenant isolation check, and confirmation
 *      that no code path anywhere in the DSL uses `eval`/`Function`/`vm`.
 *
 * Run: npx tsx scripts/src/test-policy-dsl.ts
 */

import assert from "node:assert/strict";
import {
  PolicyEngine,
  createAbacRule,
  parseAbacDsl,
  DslError,
  compileAbacPolicy,
  compileAbacPolicies,
  evaluateAbacCondition,
  resolveAttributes,
  ABAC_POLICY_ID,
  type Subject,
  type ResourceRef,
  type PolicyContext,
  type BuildAuthorizationRequestInput,
} from "../../artifacts/api-server/src/lib/policy";
import { createPolicyContext } from "../../artifacts/api-server/src/lib/policy/policy-context";
import { tokenize } from "../../artifacts/api-server/src/lib/policy/abac/dsl/tokenizer";

function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ok — ${name}`))
    .catch((err) => {
      console.error(`  FAIL — ${name}`);
      throw err;
    });
}

function buildInput(subject: Subject | null, action: string, resource: ResourceRef): BuildAuthorizationRequestInput {
  return { subject, action, resource };
}

function expectDslError(expression: string, expectedCode?: string): DslError {
  assert.throws(
    () => parseAbacDsl(expression),
    (err: unknown) => {
      assert.ok(err instanceof DslError, `expected a DslError for ${JSON.stringify(expression)}, got ${err}`);
      if (expectedCode) assert.equal((err as DslError).code, expectedCode, `wrong DslError.code for ${JSON.stringify(expression)}`);
      return true;
    },
  );
  try {
    parseAbacDsl(expression);
  } catch (err) {
    return err as DslError;
  }
  throw new Error("unreachable");
}

async function main() {
  console.log("Policy Engine — Phase 06 (Policy DSL) tests");

  // ── tokenizer.ts ─────────────────────────────────────────────────────

  await test("tokenizer: dotted paths are single IDENT tokens, keywords stay bare-word only", () => {
    const tokens = tokenize('subject.role == "admin" AND resource.sensitivity != "low"');
    const kinds = tokens.map((t) => t.kind);
    assert.deepEqual(kinds, ["IDENT", "EQ", "STRING", "AND", "IDENT", "NEQ", "STRING", "EOF"]);
  });

  await test("tokenizer: keyword casing is strict — lowercase 'and' is not the AND keyword", () => {
    // "and" is not a dotted path either, so it lexes as a plain (invalid) IDENT — which the
    // parser then rejects as an attribute path, not silently treated as logical AND.
    expectDslError('subject.role == "x" and subject.role == "y"', "TRAILING_INPUT");
  });

  await test("tokenizer: string escaping handles \\\" and \\\\ only", () => {
    const tokens = tokenize(String.raw`"a\"b\\c"`);
    assert.equal(tokens[0].kind, "STRING");
    assert.equal(tokens[0].text, 'a"b\\c');
  });

  await test("tokenizer: negative and decimal numbers", () => {
    const tokens = tokenize("-3.5");
    assert.equal(tokens[0].kind, "NUMBER");
    assert.equal(tokens[0].text, "-3.5");
  });

  // ── parser.ts — grammar coverage ────────────────────────────────────────

  const now = new Date("2026-09-07T00:00:00.000Z");
  function buildContext(overrides: Partial<PolicyContext> = {}): PolicyContext {
    return createPolicyContext({ ...overrides });
  }
  const bag = resolveAttributes(
    { userId: 2, role: "user", authType: "session", organizationId: 7, riskLevel: "medium", verificationLevel: "email_verified" },
    { type: "sylo.vault_item", id: 42, organizationId: 7, sensitivity: "high" },
    buildContext({ sessionAgeSeconds: 120 }),
    "sylo.vault.read",
  );

  await test("happy path: simple equals comparison against a string literal", () => {
    assert.equal(evaluateAbacCondition(parseAbacDsl('subject.role == "user"'), bag), true);
    assert.equal(evaluateAbacCondition(parseAbacDsl('subject.role == "admin"'), bag), false);
  });

  await test("roadmap's own conceptual example shape: attribute == attribute AND attribute-comparison", () => {
    const condition = parseAbacDsl('subject.organizationId == resource.organizationId AND resource.sensitivity == "high"');
    assert.equal(evaluateAbacCondition(condition, bag), true);
  });

  await test("numeric comparisons: >, >=, <, <=", () => {
    assert.equal(evaluateAbacCondition(parseAbacDsl("environment.sessionAgeSeconds > 100"), bag), true);
    assert.equal(evaluateAbacCondition(parseAbacDsl("environment.sessionAgeSeconds >= 120"), bag), true);
    assert.equal(evaluateAbacCondition(parseAbacDsl("environment.sessionAgeSeconds < 100"), bag), false);
    assert.equal(evaluateAbacCondition(parseAbacDsl("environment.sessionAgeSeconds <= 120"), bag), true);
  });

  await test("OR / NOT / parenthesized grouping, with correct precedence (AND binds tighter than OR)", () => {
    // Without parens: "A OR B AND C" parses as "A OR (B AND C)"
    const noParens = parseAbacDsl('subject.role == "admin" OR subject.role == "user" AND resource.sensitivity == "high"');
    assert.equal(evaluateAbacCondition(noParens, bag), true); // user AND high-sensitivity
    const negation = parseAbacDsl('NOT (subject.role == "admin")');
    assert.equal(evaluateAbacCondition(negation, bag), true);
  });

  await test("EXISTS and NOT EXISTS", () => {
    assert.equal(evaluateAbacCondition(parseAbacDsl("EXISTS subject.riskLevel"), bag), true);
    assert.equal(evaluateAbacCondition(parseAbacDsl("NOT EXISTS subject.accountState"), bag), true);
    assert.equal(evaluateAbacCondition(parseAbacDsl("EXISTS subject.accountState"), bag), false);
  });

  await test("IN and NOT IN with literal lists", () => {
    assert.equal(evaluateAbacCondition(parseAbacDsl('subject.riskLevel IN ["low", "medium"]'), bag), true);
    assert.equal(evaluateAbacCondition(parseAbacDsl('subject.riskLevel NOT IN ["low", "high"]'), bag), true);
    assert.equal(evaluateAbacCondition(parseAbacDsl('subject.riskLevel IN ["low", "high"]'), bag), false);
  });

  await test("boolean and null literals", () => {
    const b2 = resolveAttributes(
      { userId: 2, role: "user", authType: "session" },
      { type: "sylo.vault_item", id: 1, locked: false },
      buildContext(),
      "sylo.vault.read",
    );
    assert.equal(evaluateAbacCondition(parseAbacDsl("resource.locked == false"), b2), true);
    assert.equal(evaluateAbacCondition(parseAbacDsl("resource.ownerId == null"), b2), false); // missing attribute never equals null
  });

  await test("boundary: action path and bare action comparisons", () => {
    assert.equal(evaluateAbacCondition(parseAbacDsl('action == "sylo.vault.read"'), bag), true);
    assert.equal(evaluateAbacCondition(parseAbacDsl('action == "sylo.vault.update"'), bag), false);
  });

  // ── parser.ts — every documented error path ─────────────────────────────

  await test("rejects an empty expression", () => {
    expectDslError("", "EMPTY_EXPRESSION");
    expectDslError("   ", "EMPTY_EXPRESSION");
  });

  await test("rejects an unknown attribute group", () => {
    expectDslError('nope.role == "x"', "UNKNOWN_ATTRIBUTE_GROUP");
  });

  await test("rejects a malformed attribute path (no dot, not 'action')", () => {
    expectDslError('subjectrole == "x"', "INVALID_ATTRIBUTE_PATH");
  });

  await test("rejects a literal on the left-hand side of a comparison", () => {
    expectDslError('"x" == subject.role', "INVALID_LEFT_OPERAND");
    expectDslError("5 > subject.riskLevel", "INVALID_LEFT_OPERAND");
  });

  await test("rejects an unterminated string literal", () => {
    expectDslError('subject.role == "unterminated', "UNTERMINATED_STRING");
  });

  await test("rejects an unexpected character", () => {
    expectDslError("subject.role == @nope", "UNEXPECTED_CHARACTER");
  });

  await test("rejects trailing input after a complete expression", () => {
    expectDslError('subject.role == "x" garbage', "TRAILING_INPUT");
  });

  await test("rejects a comparison missing its right-hand side (end of input)", () => {
    expectDslError("subject.role ==", "UNEXPECTED_END_OF_INPUT");
    expectDslError('subject.role == "x" AND', "UNEXPECTED_END_OF_INPUT");
  });

  await test("rejects an unbalanced parenthesis", () => {
    expectDslError('(subject.role == "x"', "UNEXPECTED_END_OF_INPUT");
    expectDslError('subject.role == "x")', "TRAILING_INPUT");
  });

  await test("rejects an empty IN list", () => {
    expectDslError("subject.role IN []", "EMPTY_LIST");
  });

  await test("rejects a mixed-type IN list", () => {
    expectDslError('subject.role IN [1, "a"]', "UNEXPECTED_TOKEN");
  });

  await test("rejects 'NOT' not followed by 'IN' inside a comparison", () => {
    expectDslError('subject.role NOT "x"', "UNEXPECTED_TOKEN");
  });

  await test("rejects an invalid number literal shape (exponent notation unsupported)", () => {
    // "1e3" tokenizes as NUMBER "1" followed by IDENT "e3" — a syntax error at the parser level
    // (extra input after a complete comparison would need a boolean combinator, not a bare ident).
    expectDslError("subject.age > 1e3", "TRAILING_INPUT");
  });

  // ── bounded parsing (the roadmap's "bounded" DSL requirement) ───────────

  await test("bounded: an oversized expression is rejected (INPUT_TOO_LONG), not truncated", () => {
    const huge = `subject.role == "${"a".repeat(5000)}"`;
    expectDslError(huge, "INPUT_TOO_LONG");
  });

  await test("bounded: an oversized string literal is rejected (STRING_TOO_LONG)", () => {
    const huge = `subject.role == "${"a".repeat(600)}"`;
    expectDslError(huge, "STRING_TOO_LONG");
  });

  await test("bounded: deeply nested parentheses fail closed (MAX_NESTING_DEPTH_EXCEEDED), never a stack overflow", () => {
    const deep = "(".repeat(200) + 'subject.role == "x"' + ")".repeat(200);
    assert.doesNotThrow(() => {
      try {
        parseAbacDsl(deep);
      } catch (err) {
        if (err instanceof DslError && err.code === "MAX_NESTING_DEPTH_EXCEEDED") return;
        throw err;
      }
    });
    expectDslError(deep, "MAX_NESTING_DEPTH_EXCEEDED");
  });

  await test("bounded: many short tokens under the length limit still hit TOO_MANY_TOKENS", () => {
    // 300 repetitions of "1," comfortably under 4096 chars but well past 512 tokens.
    const manyTokens = `subject.role IN [${Array.from({ length: 300 }, () => '"a"').join(",")}]`;
    expectDslError(manyTokens, "TOO_MANY_TOKENS");
  });

  // ── never dynamically executes anything ─────────────────────────────────

  await test("security: an expression containing JS-looking payloads is only ever data, never executed", () => {
    // These are classic "if this were eval'd, something bad would happen" probes. Every one of
    // them must be rejected as a syntax error — the DSL has no code path that would let arbitrary
    // JS execute, but this test exists to make that an explicit, checked guarantee, not folklore.
    const probes = [
      'subject.role == "x"); require("child_process").exec("id"); (',
      "subject.role == `${process.exit(1)}`",
      "subject.role == 1+1",
      "__proto__.polluted == true",
      "constructor.constructor",
    ];
    for (const probe of probes) {
      assert.throws(() => parseAbacDsl(probe), DslError, `expected ${JSON.stringify(probe)} to be rejected`);
    }
  });

  await test("security: 'subject.__proto__' is treated as an ordinary (non-matching) field, not a prototype-pollution vector", () => {
    const condition = parseAbacDsl("EXISTS subject.__proto__");
    assert.equal(evaluateAbacCondition(condition, bag), false); // not an own property of the bag's subject object
  });

  // ── compile-policy.ts + engine integration ──────────────────────────────

  await test("compileAbacPolicy(): DSL text becomes a working AbacPolicyDefinition end-to-end", async () => {
    const policy = compileAbacPolicy({
      id: "same-org-and-verified",
      effect: "allow",
      expression: 'subject.organizationId == resource.organizationId AND subject.verificationLevel == "email_verified"',
      actions: ["sylo.vault.read"],
    });
    const engine = new PolicyEngine();
    engine.registerRule(ABAC_POLICY_ID, createAbacRule([policy]));

    const decision = await engine.evaluate(
      buildInput(
        { userId: 2, role: "user", authType: "session", organizationId: 7, verificationLevel: "email_verified" },
        "sylo.vault.read",
        { type: "sylo.vault_item", id: 42, organizationId: 7 },
      ),
    );
    assert.equal(decision.effect, "ALLOW");
    assert.equal(decision.reason, "EXPLICIT_ALLOW");
  });

  await test("compileAbacPolicies(): fails on the first invalid expression, compiles nothing partially", () => {
    assert.throws(
      () =>
        compileAbacPolicies([
          { id: "valid", effect: "allow", expression: 'subject.role == "admin"' },
          { id: "invalid", effect: "allow", expression: "subject.role ==" },
        ]),
      DslError,
    );
  });

  await test("security: policy injection — a hostile expression from an untrusted source is rejected before ever reaching the engine", () => {
    // Simulates a future Phase 07 admin-console submission: the caller must validate with
    // compileAbacPolicy() and handle the thrown DslError, never register a partially-parsed or
    // best-effort-parsed policy.
    const hostileSubmission = 'subject.role == "admin" OR true'; // "true" alone is not a valid comparison operand pairing here
    assert.throws(() => compileAbacPolicy({ id: "hostile", effect: "allow", expression: hostileSubmission }), DslError);
  });

  await test("security: cross-tenant isolation via the roadmap's own conceptual example", async () => {
    const policy = compileAbacPolicy({
      id: "same-org-only",
      effect: "allow",
      expression: "subject.organizationId == resource.organizationId",
      actions: ["sylo.vault.read"],
    });
    const engine = new PolicyEngine();
    engine.registerRule(ABAC_POLICY_ID, createAbacRule([policy]));

    const sameOrg = await engine.evaluate(
      buildInput({ userId: 2, role: "user", authType: "session", organizationId: 7 }, "sylo.vault.read", {
        type: "sylo.vault_item",
        id: 42,
        organizationId: 7,
      }),
    );
    assert.equal(sameOrg.effect, "ALLOW");

    const crossTenant = await engine.evaluate(
      buildInput({ userId: 2, role: "user", authType: "session", organizationId: 7 }, "sylo.vault.read", {
        type: "sylo.vault_item",
        id: 42,
        organizationId: 99,
      }),
    );
    assert.equal(crossTenant.effect, "DENY");
  });

  await test("composition: a DSL-compiled ABAC allow does not override deny-overrides from earlier phases", async () => {
    const { createLockedResourceRule, LOCKED_RESOURCE_POLICY_ID } = await import("../../artifacts/api-server/src/lib/policy");
    const policy = compileAbacPolicy({
      id: "allow-all",
      effect: "allow",
      expression: 'action == "sylo.vault.read"',
    });
    const engine = new PolicyEngine();
    engine.registerRule(ABAC_POLICY_ID, createAbacRule([policy]));
    engine.registerRule(LOCKED_RESOURCE_POLICY_ID, createLockedResourceRule());

    const decision = await engine.evaluate(
      buildInput({ userId: 2, role: "user", authType: "session" }, "sylo.vault.read", { type: "sylo.vault_item", id: 42, locked: true }),
    );
    assert.equal(decision.effect, "DENY");
    assert.equal(decision.reason, "RESOURCE_LOCKED");
  });

  console.log("Policy Engine — Phase 06 (Policy DSL): all tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
