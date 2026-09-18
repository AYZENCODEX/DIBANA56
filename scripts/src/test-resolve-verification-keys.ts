/**
 * scripts/src/test-resolve-verification-keys.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 1, Phase 1D-b: unit tests for
 * resolveVerificationKeys() (the synchronous, kid-based lookup
 * verifyAuthToken()/verifyOAuthState() now use) in
 * artifacts/api-server/src/lib/jwt-keys.ts.
 *
 * Covers both Done-criteria paths from the roadmap:
 *   - a known kid resolves to exactly that key;
 *   - an unknown kid fails safely (empty candidate list, never a fallback
 *     to an unrelated key).
 *
 * This drives the real exported functions (unlike
 * test-verification-keys.ts's pure-logic version of the Phase 1D-a merge
 * step), so it needs __resetVerificationKeyCacheForTests() to get a clean
 * cache per case, and needs DATABASE_URL set (loadVerificationKeyCache()
 * calls getVerificationKeys(), which reads jwt_signing_keys) — cases 4-7
 * below call loadVerificationKeyCache() with a live DB connection. Run
 * against a dev DB where jwt_signing_keys is empty (Phase 1C shipped no
 * write path yet) so the "post-cache-load" cases below only ever see the
 * env-fallback key, same as this file's own assertions expect.
 *
 * Run: npx tsx scripts/src/test-resolve-verification-keys.ts
 */
import assert from "node:assert/strict";
import {
  resolveVerificationKeys,
  loadVerificationKeyCache,
  getActiveKeypair,
  __resetVerificationKeyCacheForTests,
} from "../../artifacts/api-server/src/lib/jwt-keys";

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ok — ${name}`);
  } catch (err) {
    console.error(`  FAIL — ${name}`);
    throw err;
  }
}

async function testAsync(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ok — ${name}`);
  } catch (err) {
    console.error(`  FAIL — ${name}`);
    throw err;
  }
}

async function main() {
  const envKeypair = getActiveKeypair();

  console.log("resolveVerificationKeys() — pre-cache-load window");

  test("known kid (the env keypair's own) resolves correctly before the cache loads", () => {
    __resetVerificationKeyCacheForTests();
    const result = resolveVerificationKeys(envKeypair.kid);
    assert.equal(result.length, 1);
    assert.equal(result[0].kid, envKeypair.kid);
  });

  test("unknown kid fails safely before the cache loads — never falls back to the env key", () => {
    __resetVerificationKeyCacheForTests();
    const result = resolveVerificationKeys("some-kid-that-does-not-exist");
    assert.equal(result.length, 0);
  });

  test("no kid given falls back permissively to the env key before the cache loads", () => {
    __resetVerificationKeyCacheForTests();
    const result = resolveVerificationKeys(undefined);
    assert.equal(result.length, 1);
    assert.equal(result[0].kid, envKeypair.kid);
  });

  console.log("resolveVerificationKeys() — after the cache has loaded");

  await testAsync("known kid resolves correctly once the cache has loaded", async () => {
    __resetVerificationKeyCacheForTests();
    await loadVerificationKeyCache();
    const result = resolveVerificationKeys(envKeypair.kid);
    assert.equal(result.length, 1);
    assert.equal(result[0].kid, envKeypair.kid);
  });

  await testAsync("unknown kid fails safely once the cache has loaded", async () => {
    __resetVerificationKeyCacheForTests();
    await loadVerificationKeyCache();
    const result = resolveVerificationKeys("some-kid-that-does-not-exist");
    assert.equal(result.length, 0);
  });

  console.log("All resolveVerificationKeys() tests passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
