/**
 * scripts/src/test-oidc-refresh-tokens.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 2, Phase 3e-d/3e-e (partial): tests for the pure,
 * DB-free parts of `lib/oidc-refresh-tokens.ts` — generation, hashing, and
 * expiry policy (3e-a/3e-b).
 *
 * `persistRefreshToken()` / `lookupRefreshToken()` themselves require a
 * live `oidc_refresh_tokens` table (migration 082) and are exercised the
 * same way `persistAuthorizationCode()` is — via an integration run against
 * a real database, not this pure script. This file covers exactly what
 * `test-oidc-pkce.ts` / `test-oidc-token-request.ts` cover for their own
 * modules: the part of 3e-d/3e-e reachable with nothing but
 * `npx tsx scripts/src/test-oidc-refresh-tokens.ts`.
 *
 * Run: npx tsx scripts/src/test-oidc-refresh-tokens.ts
 */
import assert from "node:assert/strict";
import {
  generateRefreshToken,
  hashRefreshToken,
  computeRefreshTokenExpiry,
  isRefreshTokenExpired,
  REFRESH_TOKEN_TTL_MS,
} from "../../artifacts/api-server/src/lib/oidc-refresh-tokens";

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ok — ${name}`);
  } catch (err) {
    console.error(`  FAIL — ${name}`);
    throw err;
  }
}

console.log("generateRefreshToken()");

test("produces a non-empty, base64url-shaped string", () => {
  const token = generateRefreshToken();
  assert.equal(typeof token, "string");
  assert.ok(token.length > 0);
  assert.match(token, /^[A-Za-z0-9_-]+$/);
});

test("two calls never produce the same token (256 bits of entropy)", () => {
  assert.notEqual(generateRefreshToken(), generateRefreshToken());
});

console.log("\nhashRefreshToken()");

test("is deterministic — the same raw token always hashes the same way", () => {
  const raw = generateRefreshToken();
  assert.equal(hashRefreshToken(raw), hashRefreshToken(raw));
});

test("different raw tokens never collide to the same hash", () => {
  assert.notEqual(hashRefreshToken("token-one-xxxxxxxxxxxxxxxxxxxxxxxxxxxx"), hashRefreshToken("token-two-xxxxxxxxxxxxxxxxxxxxxxxxxxxx"));
});

test("the raw token itself never appears inside its own hash (baseline secrecy sanity check)", () => {
  const raw = generateRefreshToken();
  assert.equal(hashRefreshToken(raw).includes(raw), false);
});

console.log("\ncomputeRefreshTokenExpiry() / isRefreshTokenExpired()");

test("expiry is computed as exactly now + REFRESH_TOKEN_TTL_MS", () => {
  const now = new Date("2026-01-01T00:00:00.000Z");
  const expiry = computeRefreshTokenExpiry(now);
  assert.equal(expiry.getTime() - now.getTime(), REFRESH_TOKEN_TTL_MS);
});

test("REFRESH_TOKEN_TTL_MS is exactly 30 days", () => {
  assert.equal(REFRESH_TOKEN_TTL_MS, 30 * 24 * 60 * 60 * 1000);
});

test("a token expiring in the future is not expired yet", () => {
  const now = new Date("2026-01-01T00:00:00.000Z");
  const expiresAt = computeRefreshTokenExpiry(now);
  const justBefore = new Date(expiresAt.getTime() - 1);
  assert.equal(isRefreshTokenExpired(expiresAt, justBefore), false);
});

test("a token is expired at the exact expiry instant (inclusive boundary, same convention as isAuthorizationCodeExpired)", () => {
  const now = new Date("2026-01-01T00:00:00.000Z");
  const expiresAt = computeRefreshTokenExpiry(now);
  assert.equal(isRefreshTokenExpired(expiresAt, expiresAt), true);
});

test("a token well past its expiry is expired", () => {
  const expiresAt = new Date("2026-01-01T00:00:00.000Z");
  const now = new Date("2026-06-01T00:00:00.000Z");
  assert.equal(isRefreshTokenExpired(expiresAt, now), true);
});

console.log("\nAll assertions passed.");
