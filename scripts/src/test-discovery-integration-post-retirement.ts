/**
 * scripts/src/test-discovery-integration-post-retirement.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 1, Phase 1E-f: Discovery Integration Tests —
 * "post-retirement" stage, run as its OWN process.
 *
 * See the comment above the spawnSync() call in
 * scripts/src/test-discovery-integration.ts for why this can't be the
 * baseline/mid-rotation stages' continuation in the same process: this
 * script's env vars are set to the SURVIVING key from the very first line,
 * so getActiveKeypair()'s (1a) process-lifetime memoization picks up the
 * post-rotation state from cold start — exactly like a real redeploy after
 * a key rotation completes.
 *
 * Not meant to be run standalone in normal use (it's spawned by
 * test-discovery-integration.ts), but it works fine on its own too:
 *   npx tsx scripts/src/test-discovery-integration-post-retirement.ts
 */
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { pool } from "@workspace/db";
import { __resetVerificationKeyCacheForTests, loadVerificationKeyCache, resolveVerificationKeys } from "../../artifacts/api-server/src/lib/jwt-keys";
import { jwksHandler } from "../../artifacts/api-server/src/routes/well-known-jwks";
import { openidConfigurationHandler } from "../../artifacts/api-server/src/routes/well-known-openid-configuration";

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ok — ${name}`);
  } catch (err) {
    console.error(`  FAIL — ${name}`);
    throw err;
  }
}

// Surviving key — the ONLY key this process's env ever knows about, set
// before anything touches getActiveKeypair().
const survivingKp = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
process.env.AYZEN_JWT_KID = "kid-rotated";
process.env.AYZEN_JWT_PRIVATE_KEY = survivingKp.privateKey;
process.env.AYZEN_JWT_PUBLIC_KEY = survivingKp.publicKey;
process.env.AYZEN_OIDC_ISSUER = "https://account.ayzen.tech";

// jwt_signing_keys, post-retirement: the old key ("kid-baseline") is gone
// entirely — not present at any status, exactly as a real retirement
// (retire-jwt-signing-keys.ts) leaves it once it passes the retention
// window (1D-e) and is actually removed, not just marked "retired".
(pool as unknown as { query: (...args: unknown[]) => Promise<{ rows: unknown[] }> }).query = async () => ({
  rows: [{ kid: "kid-rotated", public_key: survivingKp.publicKey, status: "active" }],
});

function makeFakeRes() {
  const state: { headers: Record<string, string>; contentType?: string; body?: unknown } = { headers: {} };
  const res = {
    set(name: string, value: string) {
      state.headers[name] = value;
      return res;
    },
    type(contentType: string) {
      state.contentType = contentType;
      return res;
    },
    json(body: unknown) {
      state.body = body;
      return res;
    },
  };
  return { res: res as any, state };
}

console.log("Phase 1E-f — post-retirement stage (fresh process, env already rotated)\n");

async function main(): Promise<void> {
  __resetVerificationKeyCacheForTests();
  await loadVerificationKeyCache();

  test("JWKS publishes only the surviving key — the retired key is excluded", () => {
    const { res, state } = makeFakeRes();
    jwksHandler({} as any, res);
    const body = state.body as { keys: Array<{ kid: string }> };
    assert.deepEqual(
      body.keys.map((k) => k.kid),
      ["kid-rotated"],
    );
  });

  test("the retired kid resolves to nothing — old tokens are no longer verifiable via this endpoint", () => {
    assert.deepEqual(resolveVerificationKeys("kid-baseline"), []);
    assert.deepEqual(
      resolveVerificationKeys("kid-rotated").map((k) => k.kid),
      ["kid-rotated"],
    );
  });

  test("discovery stays internally consistent after the key set changed (issuer/jwks_uri/algs)", () => {
    const { res, state } = makeFakeRes();
    openidConfigurationHandler({} as any, res);
    const body = state.body as Record<string, unknown>;
    assert.equal(body.issuer, "https://account.ayzen.tech");
    assert.equal(body.jwks_uri, `${body.issuer}/.well-known/jwks.json`);
    assert.deepEqual(body.id_token_signing_alg_values_supported, ["RS256"]);
  });

  console.log("\nAll post-retirement assertions passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
