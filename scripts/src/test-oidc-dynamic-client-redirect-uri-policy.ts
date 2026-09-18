/**
 * scripts/src/test-oidc-dynamic-client-redirect-uri-policy.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 4, Phase 8d: tests for
 * `artifacts/api-server/src/lib/oidc-dynamic-client-redirect-uri-policy.ts`'s
 * `isDynamicClientRedirectUriAllowed()`.
 *
 * Same shape as scripts/src/test-oidc-client-registration-request.ts (8a):
 * DB-free, runnable anywhere with nothing but
 * `npx tsx scripts/src/test-oidc-dynamic-client-redirect-uri-policy.ts`.
 *
 * Run: npx tsx scripts/src/test-oidc-dynamic-client-redirect-uri-policy.ts
 */
import assert from "node:assert/strict";
import { isDynamicClientRedirectUriAllowed } from "../../artifacts/api-server/src/lib/oidc-dynamic-client-redirect-uri-policy";

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ok — ${name}`);
  } catch (err) {
    console.error(`  FAIL — ${name}`);
    throw err;
  }
}

console.log("isDynamicClientRedirectUriAllowed() — allowed");

test("a plain https:// URI is allowed", () => {
  assert.equal(isDynamicClientRedirectUriAllowed("https://wisp.ayzen.tech/oidc/callback"), true);
});

test("https:// with a query string is allowed", () => {
  assert.equal(isDynamicClientRedirectUriAllowed("https://wisp.ayzen.tech/callback?env=prod"), true);
});

test("http://localhost (any port) is allowed — dev exception", () => {
  assert.equal(isDynamicClientRedirectUriAllowed("http://localhost:3000/callback"), true);
  assert.equal(isDynamicClientRedirectUriAllowed("http://localhost/callback"), true);
});

test("http://127.0.0.1 is allowed — dev exception", () => {
  assert.equal(isDynamicClientRedirectUriAllowed("http://127.0.0.1:8080/callback"), true);
});

test("http://[::1] (IPv6 loopback) is allowed — dev exception", () => {
  assert.equal(isDynamicClientRedirectUriAllowed("http://[::1]:3000/callback"), true);
});

console.log("isDynamicClientRedirectUriAllowed() — rejected");

test("http:// on a real (non-localhost) host is rejected", () => {
  assert.equal(isDynamicClientRedirectUriAllowed("http://wisp.ayzen.tech/callback"), false);
});

test("http:// on a host that merely contains 'localhost' as a substring is rejected", () => {
  // Not the same hostname as "localhost" — a confusable lookalike must not
  // slip through on a substring match.
  assert.equal(isDynamicClientRedirectUriAllowed("http://localhost.evil.example/callback"), false);
  assert.equal(isDynamicClientRedirectUriAllowed("http://notlocalhost/callback"), false);
});

test("a wildcard character anywhere in the URI is rejected", () => {
  assert.equal(isDynamicClientRedirectUriAllowed("https://wisp.ayzen.tech/*"), false);
  assert.equal(isDynamicClientRedirectUriAllowed("https://*.wisp.ayzen.tech/callback"), false);
  assert.equal(isDynamicClientRedirectUriAllowed("https://wisp.ayzen.tech/callback?x=*"), false);
});

test("a path-traversal segment anywhere in the URI is rejected", () => {
  assert.equal(isDynamicClientRedirectUriAllowed("https://wisp.ayzen.tech/../callback"), false);
  assert.equal(isDynamicClientRedirectUriAllowed("https://wisp.ayzen.tech/a/../b"), false);
});

test("a fragment is rejected", () => {
  assert.equal(isDynamicClientRedirectUriAllowed("https://wisp.ayzen.tech/callback#token"), false);
  assert.equal(isDynamicClientRedirectUriAllowed("https://wisp.ayzen.tech/callback#"), false);
});

test("a malformed URL string is rejected, never throws", () => {
  assert.equal(isDynamicClientRedirectUriAllowed("not a url at all"), false);
  assert.equal(isDynamicClientRedirectUriAllowed(""), false);
});

test("a non-http(s) scheme is rejected", () => {
  assert.equal(isDynamicClientRedirectUriAllowed("ftp://wisp.ayzen.tech/callback"), false);
  assert.equal(isDynamicClientRedirectUriAllowed("myapp://callback"), false);
});

console.log("All oidc-dynamic-client-redirect-uri-policy tests passed.");
