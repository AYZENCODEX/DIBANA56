/**
 * scripts/src/test-oidc-token-introspection.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 5, Phase 10a: tests for
 * `parseOidcIntrospectionRequest()` (`lib/oidc-introspection-request.ts`)
 * and the DB-free half of `introspectOidcToken()`
 * (`lib/oidc-token-introspection.ts`).
 *
 * Same "pure parts run for real" precedent `test-oidc-userinfo.ts` (4c-g)
 * already used for `verifyOidcAccessToken()`: `issueOidcAccessToken()` is
 * reused to MINT real access tokens, and `introspectOidcToken()` is
 * called for real against them — no hand-built JWTs, no mocked
 * verification. Every scenario below stays entirely on the
 * ACCESS-TOKEN branch (`introspectAsAccessToken()`), which never touches
 * `@workspace/db` — a request with no `token_type_hint` (or an explicit
 * `"access_token"` hint) tries that branch FIRST, and a genuine access
 * token always resolves there (`introspectAsAccessToken()` returns
 * non-null, `introspectOidcToken()` never falls through to the
 * refresh-token branch), so this file exercises the real function, not a
 * stand-in for it.
 *
 * NOT covered here (needs a live DB — see file headers for why):
 *   - `introspectAsRefreshToken()` / `lookupRefreshToken()` — any
 *     scenario that reaches the refresh-token branch at all, including
 *     "unrecognized token, tried as neither" (which falls through BOTH
 *     branches and would call `lookupRefreshToken()` -> `pool.query()`).
 *     Same "hand-verified against the DDL/logic, not executed" gap
 *     `test-oidc-refresh-tokens.ts`'s own header already documents for
 *     `persistRefreshToken()`/`lookupRefreshToken()` themselves.
 *   - `introspectHandler()` (`routes/oidc-introspect.ts`) — the full
 *     parse -> client-auth -> introspect chain, since
 *     `authenticateOidcTokenClient()` calls `validateOidcClientId()` ->
 *     `getOidcClientById()`, itself a DB read. Reviewed by hand against
 *     `routes/oidc-token.ts`'s own already-tested equivalent shape, not
 *     run here.
 *
 * Run: npx tsx scripts/src/test-oidc-token-introspection.ts
 */
import assert from "node:assert/strict";
import { issueOidcAccessToken } from "../../artifacts/api-server/src/lib/oidc-access-token";
import { introspectOidcToken } from "../../artifacts/api-server/src/lib/oidc-token-introspection";
import { parseOidcIntrospectionRequest } from "../../artifacts/api-server/src/lib/oidc-introspection-request";

function test(name: string, fn: () => void | Promise<void>): void | Promise<void> {
  const finish = (err?: unknown) => {
    if (err) {
      console.error(`  FAIL — ${name}`);
      throw err;
    }
    console.log(`  ok — ${name}`);
  };
  try {
    const result = fn();
    if (result instanceof Promise) return result.then(() => finish(), finish);
    finish();
  } catch (err) {
    finish(err);
  }
}

async function main() {
  console.log("parseOidcIntrospectionRequest()");

  await test("reads all four fields from a well-formed body", () => {
    const parsed = parseOidcIntrospectionRequest({
      token: "abc123",
      token_type_hint: "refresh_token",
      client_id: "sylo",
      client_secret: "shh",
    });
    assert.deepEqual(parsed, {
      token: "abc123",
      tokenTypeHint: "refresh_token",
      clientId: "sylo",
      clientSecret: "shh",
    });
  });

  await test("missing fields come back undefined, never null/empty-string", () => {
    const parsed = parseOidcIntrospectionRequest({});
    assert.deepEqual(parsed, {
      token: undefined,
      tokenTypeHint: undefined,
      clientId: undefined,
      clientSecret: undefined,
    });
  });

  await test("an empty-string value normalizes to undefined, same as a missing field", () => {
    const parsed = parseOidcIntrospectionRequest({ token: "" });
    assert.equal(parsed.token, undefined);
  });

  await test("a repeated (array-shaped) urlencoded field takes the first value", () => {
    const parsed = parseOidcIntrospectionRequest({ token: ["first", "second"] });
    assert.equal(parsed.token, "first");
  });

  await test("does not throw on non-string, non-array field values", () => {
    assert.doesNotThrow(() => parseOidcIntrospectionRequest({ token: 12345 as unknown as string }));
    assert.equal(parseOidcIntrospectionRequest({ token: 12345 as unknown as string }).token, undefined);
  });

  console.log("\nintrospectOidcToken() — access-token branch (DB-free)");

  await test("a live access token, introspected by ITS OWN client, is active with the right claims", async () => {
    const issued = issueOidcAccessToken({ userId: 42, clientId: "sylo", scopes: ["openid", "profile"] });
    const result = await introspectOidcToken(issued.accessToken, undefined, "sylo");
    assert.equal(result.active, true);
    if (result.active) {
      assert.equal(result.sub, "42");
      assert.equal(result.client_id, "sylo");
      assert.equal(result.scope, "openid profile");
      assert.equal(result.token_type, "access_token");
      assert.equal(typeof result.exp, "number");
      assert.equal(typeof result.iat, "number");
      assert.ok(result.exp > result.iat);
    }
  });

  await test("an explicit 'access_token' hint reaches the exact same result as no hint at all", async () => {
    const issued = issueOidcAccessToken({ userId: 7, clientId: "wisp", scopes: ["openid"] });
    const noHint = await introspectOidcToken(issued.accessToken, undefined, "wisp");
    const withHint = await introspectOidcToken(issued.accessToken, "access_token", "wisp");
    assert.deepEqual(noHint, withHint);
  });

  await test("the SAME token introspected by a DIFFERENT client reports inactive, not the other client's claims", async () => {
    const issued = issueOidcAccessToken({ userId: 42, clientId: "sylo", scopes: ["openid"] });
    const result = await introspectOidcToken(issued.accessToken, undefined, "some-other-client");
    assert.deepEqual(result, { active: false });
  });

  console.log("\nAll Phase 10a introspection tests passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
