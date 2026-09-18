/**
 * scripts/src/test-policy-pip.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 01 (Foundation / PDP Core),
 * sub-phase 1B: PIP adapters tests.
 *
 * Same shape as scripts/src/test-policy-engine.ts: DB-free, no Express server
 * needed, runnable anywhere with
 *   npx tsx scripts/src/test-policy-pip.ts
 *
 * Covers:
 *   - subjectFromAuthUser: session/apikey/legacy mapping, missing authType
 *     normalization, null/undefined passthrough, scopes/keyType preserved
 *   - policyContextFromRequest: requestId precedence (explicit option >
 *     X-Request-Id header > generated), ip captured, sessionId passthrough,
 *     malformed/array header handled without throwing
 *
 * Run: npx tsx scripts/src/test-policy-pip.ts
 */

import assert from "node:assert/strict";
import type { Request } from "express";
import { subjectFromAuthUser, policyContextFromRequest } from "../../artifacts/api-server/src/lib/policy";

function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ok — ${name}`))
    .catch((err) => {
      console.error(`  FAIL — ${name}`);
      throw err;
    });
}

/** Minimal fake Request — only the fields context-adapter.ts actually reads. */
function fakeRequest(overrides: { headers?: Record<string, string | string[]>; ip?: string } = {}): Request {
  return {
    headers: overrides.headers ?? {},
    ip: overrides.ip,
  } as unknown as Request;
}

async function main() {
  console.log("Policy PIP adapters — Phase 1B tests");

  await test("subjectFromAuthUser: null/undefined → null", () => {
    assert.equal(subjectFromAuthUser(null), null);
    assert.equal(subjectFromAuthUser(undefined), null);
  });

  await test("subjectFromAuthUser: session user maps 1:1, authType preserved", () => {
    const subject = subjectFromAuthUser({ userId: 7, role: "user", authType: "session" });
    assert.deepEqual(subject, {
      userId: 7,
      role: "user",
      authType: "session",
      keyType: undefined,
      scopes: undefined,
      organizationId: undefined,
      assuranceMethods: undefined,
    });
  });

  await test("subjectFromAuthUser: apikey user preserves keyType/scopes", () => {
    const subject = subjectFromAuthUser({
      userId: 3,
      role: "user",
      authType: "apikey",
      keyType: "scoped",
      scopes: ["ryft.payment.read"],
    });
    assert.equal(subject?.authType, "apikey");
    assert.equal(subject?.keyType, "scoped");
    assert.deepEqual(subject?.scopes, ["ryft.payment.read"]);
  });

  await test("subjectFromAuthUser: legacy authType preserved (not overwritten)", () => {
    const subject = subjectFromAuthUser({ userId: 9, role: "user", authType: "legacy" });
    assert.equal(subject?.authType, "legacy");
  });

  await test("subjectFromAuthUser: missing/unrecognized authType normalizes to session", () => {
    const missing = subjectFromAuthUser({ userId: 5, role: "admin" });
    assert.equal(missing?.authType, "session");

    const garbage = subjectFromAuthUser({ userId: 5, role: "admin", authType: "not-a-real-type" });
    assert.equal(garbage?.authType, "session");
  });

  await test("subjectFromAuthUser: never fabricates organizationId/assuranceMethods", () => {
    const subject = subjectFromAuthUser({ userId: 1, role: "admin" });
    assert.equal(subject?.organizationId, undefined);
    assert.equal(subject?.assuranceMethods, undefined);
  });

  await test("policyContextFromRequest: generates a requestId when nothing is available", () => {
    const ctx = policyContextFromRequest(fakeRequest());
    assert.equal(typeof ctx.requestId, "string");
    assert.ok(ctx.requestId.length > 0);
  });

  await test("policyContextFromRequest: inbound X-Request-Id header is used", () => {
    const ctx = policyContextFromRequest(fakeRequest({ headers: { "x-request-id": "req-abc-123" } }));
    assert.equal(ctx.requestId, "req-abc-123");
  });

  await test("policyContextFromRequest: explicit option overrides the header", () => {
    const ctx = policyContextFromRequest(fakeRequest({ headers: { "x-request-id": "from-header" } }), {
      requestId: "from-caller",
    });
    assert.equal(ctx.requestId, "from-caller");
  });

  await test("policyContextFromRequest: array-valued / blank header does not throw, falls back", () => {
    const arrayHeader = policyContextFromRequest(fakeRequest({ headers: { "x-request-id": ["first", "second"] } }));
    assert.equal(arrayHeader.requestId, "first");

    const blankHeader = policyContextFromRequest(fakeRequest({ headers: { "x-request-id": "   " } }));
    assert.ok(blankHeader.requestId.length > 0);
    assert.notEqual(blankHeader.requestId, "   ");
  });

  await test("policyContextFromRequest: ip and sessionId are carried through", () => {
    const ctx = policyContextFromRequest(fakeRequest({ ip: "203.0.113.5" }), { sessionId: "sid-42" });
    assert.equal(ctx.ip, "203.0.113.5");
    assert.equal(ctx.sessionId, "sid-42");
  });

  console.log("\nAll Phase 1B PIP adapter tests passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
