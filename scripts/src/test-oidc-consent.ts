/**
 * scripts/src/test-oidc-consent.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 4, Phase 7a/7b: tests for the pure, DB-free parts of
 * this phase pair.
 *
 * `lib/oidc-user-consents.ts`'s `getActiveConsent()`/`grantConsent()`
 * themselves require a live `oidc_user_consents` table (migration 088) and
 * are exercised the same way `persistAuthorizationCode()`/
 * `persistRefreshToken()` already are — via an integration run against a
 * real database, not this pure script (see `test-oidc-refresh-tokens.ts`'s
 * own header for the identical split). This file covers exactly what's
 * reachable with nothing but `npx tsx scripts/src/test-oidc-consent.ts`:
 *   - `describeConsentScopes()` (7b, lib/oidc-consent-scope-copy.ts)
 *   - `parseReturnTo()` (7b, routes/oidc-consent.ts) — the `returnTo` ->
 *     `RawOidcAuthorizeRequest` parser, independent of the DB-touching
 *     `validateOidcAuthorizeRequest()` it feeds into.
 *
 * Run: npx tsx scripts/src/test-oidc-consent.ts
 */
import assert from "node:assert/strict";
import { describeConsentScopes } from "../../artifacts/api-server/src/lib/oidc-consent-scope-copy";
import { parseReturnTo } from "../../artifacts/api-server/src/routes/oidc-consent";

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ok — ${name}`);
  } catch (err) {
    console.error(`  FAIL — ${name}`);
    throw err;
  }
}

console.log("describeConsentScopes()");

test("maps a known scope to its fixed label/description", () => {
  const [openid] = describeConsentScopes(["openid"]);
  assert.equal(openid.scope, "openid");
  assert.equal(typeof openid.label, "string");
  assert.ok(openid.label.length > 0);
  assert.ok(openid.description.length > 0);
});

test("covers every scope this provider actually knows (openid, profile, email)", () => {
  const described = describeConsentScopes(["openid", "profile", "email"]);
  assert.deepEqual(described.map((s) => s.scope), ["openid", "profile", "email"]);
  for (const s of described) {
    assert.notEqual(s.label, "Additional access", `${s.scope} should have real copy, not the unknown-scope fallback`);
  }
});

test("preserves request order rather than a fixed display order", () => {
  const described = describeConsentScopes(["email", "openid"]);
  assert.deepEqual(described.map((s) => s.scope), ["email", "openid"]);
});

test("an unrecognized scope falls back to generic copy instead of throwing", () => {
  const [unknown] = describeConsentScopes(["some_future_scope"]);
  assert.equal(unknown.scope, "some_future_scope");
  assert.equal(unknown.label, "Additional access");
});

test("an empty scope list maps to an empty result", () => {
  assert.deepEqual(describeConsentScopes([]), []);
});

console.log("\nparseReturnTo()");

test("parses a well-formed /oidc/authorize returnTo into its query fields", () => {
  const raw = parseReturnTo(
    "/oidc/authorize?client_id=ryft&redirect_uri=https%3A%2F%2Fryft.ayzen.tech%2Foidc%2Fcallback&response_type=code&scope=openid%20profile&state=abc123",
  );
  assert.ok(raw);
  assert.equal(raw!.clientId, "ryft");
  assert.equal(raw!.redirectUri, "https://ryft.ayzen.tech/oidc/callback");
  assert.equal(raw!.responseType, "code");
  assert.equal(raw!.scope, "openid profile");
  assert.equal(raw!.state, "abc123");
});

test("rejects a returnTo that doesn't start with /oidc/authorize (no open-redirect side door)", () => {
  assert.equal(parseReturnTo("/oidc/consent?client_id=ryft"), null);
  assert.equal(parseReturnTo("https://evil.example.com/oidc/authorize?client_id=ryft"), null);
  assert.equal(parseReturnTo("/dashboard"), null);
});

test("rejects non-string input", () => {
  assert.equal(parseReturnTo(undefined), null);
  assert.equal(parseReturnTo(null), null);
  assert.equal(parseReturnTo(42), null);
  assert.equal(parseReturnTo(["/oidc/authorize?client_id=ryft"]), null);
});

test("a bare /oidc/authorize with no query string still parses (fields simply undefined)", () => {
  const raw = parseReturnTo("/oidc/authorize");
  assert.ok(raw);
  assert.equal(raw!.clientId, undefined);
});

console.log("\nAll assertions passed.");
