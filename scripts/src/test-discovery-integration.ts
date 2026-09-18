/**
 * scripts/src/test-discovery-integration.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 1, Phase 1E-f: Discovery Integration Tests.
 *
 * The roadmap's Phase 1E-f test list is:
 *   - JWKS format
 *   - kid presence
 *   - private-key exclusion
 *   - discovery issuer
 *   - JWKS URI
 *   - supported algorithm metadata
 *   - rotation visibility
 * "Phase 1e DONE only after all tests pass."
 *
 * 1E-a/b/c/d/e's own unit tests already cover the first six items in
 * isolation (pure buildJwks(), pure buildOidcDiscoveryMetadata(), and each
 * handler individually against whatever the cache happened to contain at
 * that moment). What none of them do is exercise a KEY ROTATION through the
 * REAL, HTTP-facing code path — resolveVerificationKeys()'s cache, loaded
 * from (a stubbed) jwt_signing_keys, feeding the actual jwksHandler() and
 * openidConfigurationHandler() — the way 1D-f verified the rotation
 * lifecycle at the pure-function layer but one layer below where JWKS/
 * discovery live (Phase 1E didn't exist yet when 1D-f was written).
 *
 * This file closes exactly that gap: one continuous 3-stage rotation
 * (baseline -> mid-rotation/grace -> post-retirement), driven through
 * loadVerificationKeyCache() with a stubbed `pool.query()` standing in for
 * jwt_signing_keys, re-running the full 1E-f test list against the REAL
 * handlers at every stage — so "rotation visibility" is checked exactly
 * where a real client would observe it (the actual HTTP response), not just
 * against a hand-built VerificationKey[] passed straight into buildJwks().
 *
 * Real RSA keypairs, real RSA-SHA256 sign/verify (node:crypto) — same
 * discipline as test-rotation-lifecycle.ts (1D-f) and test-jwks-builder.ts
 * (1E-b) — so "a token signed with the old key still verifies against the
 * published old JWK, and no longer does once removed" is checked with
 * actual cryptography, not just kid string matching.
 *
 * Run: npx tsx scripts/src/test-discovery-integration.ts
 */
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as cryptoSign, verify as cryptoVerify, createPublicKey, type KeyObject } from "node:crypto";
import { pool } from "@workspace/db";
import {
  __resetVerificationKeyCacheForTests,
  loadVerificationKeyCache,
  resolveVerificationKeys,
  type JwtKeyLifecycleStatus,
} from "../../artifacts/api-server/src/lib/jwt-keys";
import { jwksHandler } from "../../artifacts/api-server/src/routes/well-known-jwks";
import { openidConfigurationHandler } from "../../artifacts/api-server/src/routes/well-known-openid-configuration";

function test(name: string, fn: () => void | Promise<void>): Promise<void> | void {
  const finish = (): void => console.log(`  ok — ${name}`);
  const fail = (): void => console.error(`  FAIL — ${name}`);
  try {
    const result = fn();
    if (result instanceof Promise) {
      return result.then(finish, (err) => {
        fail();
        throw err;
      });
    }
    finish();
  } catch (err) {
    fail();
    throw err;
  }
}

// ─── Fixed env-resolved signing keypair (baseline, before any rotation) ────
// getActiveKeypair() (1a) memoizes for process lifetime, so this must be set
// BEFORE anything in jwt-keys.ts is first touched below.
function genRsaPem(): { privateKey: string; publicKey: string } {
  return generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
}

const baselineKp = genRsaPem();
process.env.AYZEN_JWT_KID = "kid-baseline";
process.env.AYZEN_JWT_PRIVATE_KEY = baselineKp.privateKey;
process.env.AYZEN_JWT_PUBLIC_KEY = baselineKp.publicKey;
process.env.AYZEN_OIDC_ISSUER = "https://account.ayzen.tech";

// ─── Minimal real RS256 JWT — same shape as test-rotation-lifecycle.ts ─────

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

function signRs256(kid: string, privateKey: string): string {
  const header = { alg: "RS256", typ: "JWT", kid };
  const payload = { userId: 1 };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signature = cryptoSign("RSA-SHA256", Buffer.from(signingInput), privateKey);
  return `${signingInput}.${signature.toString("base64url")}`;
}

/** Verifies a token against ONE published JWK from a JWKS response body (n/e -> public key, real crypto). */
function verifyTokenAgainstJwk(token: string, jwk: { n: string; e: string }): boolean {
  const [encodedHeader, encodedPayload, encodedSignature] = token.split(".");
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = Buffer.from(encodedSignature, "base64url");
  const publicKey = createPublicKeyFromJwk(jwk);
  return cryptoVerify("RSA-SHA256", Buffer.from(signingInput), publicKey, signature);
}

function createPublicKeyFromJwk(jwk: { n: string; e: string }): KeyObject {
  return createPublicKey({ key: { kty: "RSA", n: jwk.n, e: jwk.e }, format: "jwk" } as any);
}

// ─── req/res doubles — identical shape to test-jwks-endpoint.ts ───────────

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

function callJwks(): { keys: Array<Record<string, unknown>> } {
  const { res, state } = makeFakeRes();
  jwksHandler({} as any, res);
  return state.body as { keys: Array<Record<string, unknown>> };
}

function callDiscovery(): Record<string, unknown> {
  const { res, state } = makeFakeRes();
  openidConfigurationHandler({} as any, res);
  return state.body as Record<string, unknown>;
}

// ─── Stubbed jwt_signing_keys table — driven directly, no real DB ─────────

interface FakeRow {
  kid: string;
  public_key: string;
  status: JwtKeyLifecycleStatus;
}

let fakeTable: FakeRow[] = [];

// Overrides the sandbox @workspace/db stub's pool.query for THIS file only —
// simulates exactly what fetchDbVerificationKeys()'s real SQL
// (`WHERE status = ANY($1::text[])`) would return: rows whose status is
// verify-eligible (active/retiring). A row moved to "retired" in fakeTable
// is simply left out of what this returns, same as the real query would
// exclude it — that's how "removed key no longer verifies" is simulated
// without needing canVerify()/VERIFY_ELIGIBLE_STATUSES exported here.
(pool as unknown as { query: (...args: unknown[]) => Promise<{ rows: FakeRow[] }> }).query = async (
  _sql: unknown,
  params: unknown,
) => {
  const [statuses, kid] = params as [JwtKeyLifecycleStatus[], string | undefined];
  let rows = fakeTable.filter((r) => statuses.includes(r.status));
  if (kid !== undefined) rows = rows.filter((r) => r.kid === kid);
  return { rows };
};

async function reloadCacheFrom(rows: FakeRow[]): Promise<void> {
  fakeTable = rows;
  __resetVerificationKeyCacheForTests();
  await loadVerificationKeyCache();
}

console.log("Phase 1E-f — Discovery Integration Tests (real rotation, real handlers)\n");

async function main(): Promise<void> {
  // ── Stage A: baseline, before any rotation — DB has exactly the env-active kid ──
  await reloadCacheFrom([{ kid: "kid-baseline", public_key: baselineKp.publicKey, status: "active" }]);

  const baselineToken = signRs256("kid-baseline", baselineKp.privateKey);

  await test("[baseline] JWKS format: { keys: [...] }, exactly the one active key published", () => {
    const jwks = callJwks();
    assert.ok(Array.isArray(jwks.keys));
    assert.deepEqual(
      jwks.keys.map((k) => k.kid),
      ["kid-baseline"],
    );
  });

  await test("[baseline] kid presence + private-key exclusion on the published key", () => {
    const jwks = callJwks();
    const key = jwks.keys[0];
    assert.equal(key.kid, "kid-baseline");
    assert.equal(key.kty, "RSA");
    assert.equal(key.alg, "RS256");
    assert.equal("d" in key, false);
    assert.equal("p" in key, false);
    assert.equal("q" in key, false);
  });

  await test("[baseline] discovery issuer + JWKS URI are set and consistent", () => {
    const discovery = callDiscovery();
    assert.equal(discovery.issuer, "https://account.ayzen.tech");
    assert.equal(discovery.jwks_uri, "https://account.ayzen.tech/.well-known/jwks.json");
  });

  await test("[baseline] supported algorithm metadata: RS256 only", () => {
    const discovery = callDiscovery();
    assert.deepEqual(discovery.id_token_signing_alg_values_supported, ["RS256"]);
  });

  await test("[baseline] a token signed with the active key verifies against the published JWK", () => {
    const jwks = callJwks();
    const key = jwks.keys[0] as { n: string; e: string };
    assert.equal(verifyTokenAgainstJwk(baselineToken, key), true);
  });

  // ── Stage B: mid-rotation — new key promoted to active, old key retiring (grace) ──
  const rotatedKp = genRsaPem();
  await reloadCacheFrom([
    { kid: "kid-baseline", public_key: baselineKp.publicKey, status: "retiring" },
    { kid: "kid-rotated", public_key: rotatedKp.publicKey, status: "active" },
  ]);

  const rotatedToken = signRs256("kid-rotated", rotatedKp.privateKey);

  await test("[mid-rotation] rotation visibility: JWKS publishes BOTH keys during the grace period", () => {
    const jwks = callJwks();
    assert.deepEqual(jwks.keys.map((k) => k.kid).sort(), ["kid-baseline", "kid-rotated"]);
  });

  await test("[mid-rotation] kid presence + private-key exclusion holds for every published key", () => {
    const jwks = callJwks();
    for (const key of jwks.keys) {
      assert.equal(typeof key.kid, "string");
      assert.equal(key.kty, "RSA");
      assert.equal(key.alg, "RS256");
      assert.equal("d" in key, false);
    }
  });

  await test("[mid-rotation] old token still verifies (grace period); new token verifies with the new key", () => {
    const jwks = callJwks();
    const oldKey = jwks.keys.find((k) => k.kid === "kid-baseline") as { n: string; e: string };
    const newKey = jwks.keys.find((k) => k.kid === "kid-rotated") as { n: string; e: string };
    assert.equal(verifyTokenAgainstJwk(baselineToken, oldKey), true);
    assert.equal(verifyTokenAgainstJwk(rotatedToken, newKey), true);
    // cross-verification must fail — the old token was never signed by the new key
    assert.equal(verifyTokenAgainstJwk(baselineToken, newKey), false);
  });

  await test("[mid-rotation] resolveVerificationKeys(kid) is deterministic per kid — no cross-key fallback", () => {
    assert.deepEqual(
      resolveVerificationKeys("kid-baseline").map((k) => k.kid),
      ["kid-baseline"],
    );
    assert.deepEqual(
      resolveVerificationKeys("kid-rotated").map((k) => k.kid),
      ["kid-rotated"],
    );
    assert.deepEqual(resolveVerificationKeys("kid-never-existed"), []);
  });

  await test("[mid-rotation] discovery issuer/JWKS URI/algorithm metadata are unchanged by rotation", () => {
    const discovery = callDiscovery();
    assert.equal(discovery.issuer, "https://account.ayzen.tech");
    assert.equal(discovery.jwks_uri, "https://account.ayzen.tech/.well-known/jwks.json");
    assert.deepEqual(discovery.id_token_signing_alg_values_supported, ["RS256"]);
  });

  // ── Stage C: post-retirement — see NOTE below on why this runs as a separate process ──
  //
  // getActiveKeypair() (1a, jwt-keys.ts) memoizes its env-resolved keypair
  // for the process's entire lifetime — by design, matching how a real
  // Node process only re-reads AYZEN_JWT_KID/PRIVATE_KEY/PUBLIC_KEY on
  // restart. That's correct production behavior, not something 1E-f should
  // work around by reaching into jwt-keys.ts's private module state — doing
  // so would be exactly the "redesign unrelated architecture" the roadmap
  // says not to do in this sub-phase.
  //
  // It does mean a genuine "old key fully retired, DB no longer has it at
  // all" state can't be represented by mutating env vars mid-process here:
  // mergeVerificationKeys() (1D-a) would see the DB response missing
  // kid-baseline and — correctly, by its own documented fallback rule —
  // re-add the STILL-env-configured kid-baseline keypair as "active",
  // because as far as this process's own env is concerned, nothing told it
  // otherwise. That is real, intentional 1D-a behavior (the roadmap's own
  // note: this fallback "stops contributing anything on its own" only once
  // ops keep AYZEN_JWT_KID in sync with the DB's active row) — not a defect
  // to patch here.
  //
  // What a real "post-retirement" state actually requires is what it takes
  // in production too: a fresh process, booted with env vars already
  // updated to the surviving key. scripts/src/test-discovery-integration-post-retirement.ts
  // is exactly that — a standalone script, spawned below as its own `tsx`
  // process with its own env, so its resolveKeypair()/getActiveKeypair()
  // memoize the SURVIVING key from cold start, the same way a real
  // post-rotation redeploy would.
  console.log("\n[post-retirement] running in a fresh process (see comment above for why)...\n");
  const { spawnSync } = await import("node:child_process");
  const result = spawnSync("npx", ["tsx", "scripts/src/test-discovery-integration-post-retirement.ts"], {
    stdio: "inherit",
    cwd: process.cwd(),
  });
  if (result.status !== 0) {
    throw new Error("post-retirement stage (separate process) failed");
  }

  console.log("\nAll Phase 1E-f discovery integration tests passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
