/**
 * scripts/src/test-oidc-pkce.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 2, Phase 3d-f: PKCE Test Matrix.
 *
 * `lib/oidc-pkce.ts` is pure and dependency-free (only `node:crypto`), so
 * this whole file runs anywhere with nothing but
 * `npx tsx scripts/src/test-oidc-pkce.ts` — no DB, no stubs needed.
 *
 * "Phase 3d DONE only after all negative tests pass" (roadmap, 3d section)
 * — every negative case section 6's "Authorization Code" /
 * "Token" matrices call for PKCE-wise (missing verifier, invalid verifier,
 * wrong method) is covered below, plus the positive case and a real RFC
 * 7636 Appendix B worked example.
 *
 * Run: npx tsx scripts/src/test-oidc-pkce.ts
 */
import assert from "node:assert/strict";
import { computeS256Challenge, verifyPkce, type PkceVerificationResult } from "../../artifacts/api-server/src/lib/oidc-pkce";

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ok — ${name}`);
  } catch (err) {
    console.error(`  FAIL — ${name}`);
    throw err;
  }
}

function assertOk(result: PkceVerificationResult): void {
  assert.equal(result.ok, true);
}

function assertRejected(result: PkceVerificationResult, reason: Extract<PkceVerificationResult, { ok: false }>["reason"]): void {
  assert.equal(result.ok, false);
  assert.equal((result as { ok: false; reason: string }).reason, reason);
}

console.log("computeS256Challenge()");

test("RFC 7636 Appendix B worked example produces the spec's exact challenge", () => {
  // RFC 7636 Appendix B: code_verifier "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
  // -> code_challenge "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM" (S256).
  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  const expected = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
  assert.equal(computeS256Challenge(verifier), expected);
});

test("different verifiers never collide to the same challenge", () => {
  assert.notEqual(computeS256Challenge("verifier-one-xxxxxxxxxxxxxxxxxxxxxxxxxxxx"), computeS256Challenge("verifier-two-xxxxxxxxxxxxxxxxxxxxxxxxxxxx"));
});

console.log("\nverifyPkce()");

const REAL_VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const REAL_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

test("correct verifier against its own S256 challenge — accepted (positive case)", () => {
  assertOk(verifyPkce(REAL_VERIFIER, REAL_CHALLENGE, "S256"));
});

test("missing verifier (undefined) — rejected as missing_verifier", () => {
  assertRejected(verifyPkce(undefined, REAL_CHALLENGE, "S256"), "missing_verifier");
});

test("empty-string verifier — rejected as missing_verifier", () => {
  assertRejected(verifyPkce("", REAL_CHALLENGE, "S256"), "missing_verifier");
});

test("wrong verifier (valid shape, wrong value) — rejected as challenge_mismatch", () => {
  assertRejected(verifyPkce("wrong-verifier-xxxxxxxxxxxxxxxxxxxxxxxxxxxx", REAL_CHALLENGE, "S256"), "challenge_mismatch");
});

test("verifier that is a near-miss of the real one (one char different) — rejected", () => {
  const almost = REAL_VERIFIER.slice(0, -1) + (REAL_VERIFIER.endsWith("k") ? "K" : "k");
  assertRejected(verifyPkce(almost, REAL_CHALLENGE, "S256"), "challenge_mismatch");
});

test('method "plain" on the stored row — rejected as unsupported_method, never silently accepted', () => {
  assertRejected(verifyPkce(REAL_VERIFIER, REAL_VERIFIER, "plain"), "unsupported_method");
});

test("unrecognized method on the stored row — rejected as unsupported_method", () => {
  assertRejected(verifyPkce(REAL_VERIFIER, REAL_CHALLENGE, "S1"), "unsupported_method");
});

test("method check happens before the challenge is even computed (plain + a verifier whose plain value equals the challenge is still rejected)", () => {
  // If this function ever silently downgraded to "plain" semantics
  // (verifier === challenge), this case would incorrectly pass — it must
  // not, per section 3.2's "do not silently downgrade".
  assertRejected(verifyPkce("same-value-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", "same-value-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", "plain"), "unsupported_method");
});

test("challenge comparison is exact — a challenge with different casing does not match", () => {
  const upper = REAL_CHALLENGE.toUpperCase();
  if (upper !== REAL_CHALLENGE) {
    assertRejected(verifyPkce(REAL_VERIFIER, upper, "S256"), "challenge_mismatch");
  }
});

console.log("\nAll assertions passed.");
