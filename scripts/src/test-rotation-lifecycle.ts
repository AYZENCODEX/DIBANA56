/**
 * scripts/src/test-rotation-lifecycle.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 1, Phase 1D-f: Rotation Integration Verification.
 *
 * Exercises the FULL key-rotation lifecycle end to end, wiring together the
 * pure decision functions from every earlier 1D sub-phase:
 *   - mergeVerificationKeys()      (1D-a) — DB rows + env keypair → resolvable set
 *   - canSign() / canVerify()      (1D-c) — which states may sign/verify
 *   - planRotation()               (1D-d) — is it safe to rotate, and how
 *   - planRetirement()/isRetirementSafe() (1D-e) — is it safe to retire
 *
 * against REAL RS256 cryptography (RSA keypairs generated with node:crypto,
 * signed/verified with node:crypto's sign()/verify() using RSA-SHA256 —
 * exactly what jsonwebtoken's RS256 does under the hood, just without the
 * dependency). Earlier phases' CHANGES notes flagged the actual crypto
 * round-trip (sign with one key, verify with another, wrong key must fail)
 * as untested in this sandbox (no `jsonwebtoken` package, no DB) — this file
 * closes that gap using only node's built-in crypto module, no install
 * required.
 *
 * What this is NOT: a test against the live jwt_signing_keys table, or
 * against lib/jwt.ts's actual signAuthToken()/verifyAuthToken() (those need
 * `jsonwebtoken` + a live DB connection, unavailable in this sandbox — see
 * "Known limitation" at the bottom). All DB state here is an in-memory
 * simulation of what rotate-jwt-signing-key.ts / retire-jwt-signing-keys.ts
 * would have written; the token format is a minimal, self-contained RS256
 * JWT (header.payload.signature, base64url, RSA-SHA256) built for this test
 * only, deliberately shaped identically to what lib/jwt.ts produces so the
 * verification logic under test (which key(s) are even offered as
 * candidates) is exercised the same way it would be for a real token.
 *
 * Covers the roadmap's Phase 1D-f test list, in order:
 *   1. old key signs
 *   2. new key is introduced
 *   3. new tokens use new kid
 *   4. old tokens verify with old key
 *   5. unknown kid fails
 *   6. old key eventually becomes removable
 *   7. removed key no longer verifies
 *
 * Run: npx tsx scripts/src/test-rotation-lifecycle.ts
 */
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as cryptoSign, verify as cryptoVerify } from "node:crypto";
import {
  mergeVerificationKeys,
  canSign,
  canVerify,
  planRetirement,
  RETENTION_PERIOD_MS,
  MAX_TOKEN_LIFETIME_MS,
  type JwtKeypair,
  type VerificationKey,
  type RetiringKeyRow,
} from "../../artifacts/api-server/src/lib/jwt-keys";
import { planRotation } from "./rotate-jwt-signing-key";

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ok — ${name}`);
  } catch (err) {
    console.error(`  FAIL — ${name}`);
    throw err;
  }
}

// ─── Minimal, self-contained RS256 JWT — real crypto, no dependency ────────

interface Keypair {
  kid: string;
  privateKey: string;
  publicKey: string;
}

function generateRsaKeypair(kid: string): Keypair {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return { kid, privateKey, publicKey };
}

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

/** Signs {alg:"RS256",kid}.payload with the given private key — same shape lib/jwt.ts's signAuthToken()/signOAuthState() produce via jsonwebtoken. */
function signRs256(payload: Record<string, unknown>, privateKey: string, kid: string): string {
  const header = { alg: "RS256", typ: "JWT", kid };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signature = cryptoSign("RSA-SHA256", Buffer.from(signingInput), privateKey);
  return `${signingInput}.${signature.toString("base64url")}`;
}

/** Reads a token's `kid` header without verifying the signature — same purpose as lib/jwt.ts's decodeHeader(). */
function tokenKid(token: string): string | undefined {
  const [encodedHeader] = token.split(".");
  const header = JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8")) as { kid?: string };
  return header.kid;
}

/** Real RSA-SHA256 signature verification against one candidate public key. */
function verifyWithKey(token: string, publicKey: string): boolean {
  const [encodedHeader, encodedPayload, encodedSignature] = token.split(".");
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = Buffer.from(encodedSignature, "base64url");
  return cryptoVerify("RSA-SHA256", Buffer.from(signingInput), publicKey, signature);
}

/**
 * Mirrors lib/jwt.ts's tryVerifyRs256(): tries every candidate
 * resolveVerificationKeys()-shaped key resolveCandidates() returned, in
 * order, real-signature-verifies against each, returns true on the first
 * match. An empty candidate list (unknown kid) means "nothing to try" —
 * verification fails without ever touching an unrelated key.
 */
function verifyToken(token: string, candidates: VerificationKey[]): boolean {
  return candidates.some((c) => verifyWithKey(token, c.publicKey));
}

// ─── The lifecycle ──────────────────────────────────────────────────────────

console.log("Phase 1D-f — full rotation lifecycle (real RSA crypto)\n");

const t0 = new Date("2026-01-01T00:00:00.000Z");

// Step 1: old key signs. This is what's "active" before any rotation —
// exactly getActiveKeypair()'s role today.
const oldKp = generateRsaKeypair("kid-old");
const oldToken = signRs256({ userId: 1, role: "user" }, oldKp.privateKey, oldKp.kid);

test("1. old key signs — token carries its kid and verifies against its own public key", () => {
  assert.equal(tokenKid(oldToken), "kid-old");
  assert.equal(verifyWithKey(oldToken, oldKp.publicKey), true);
});

// Step 2: new key is introduced — via the real planRotation() decision
// (1D-d), same as rotate-jwt-signing-key.ts would compute against a live
// DB. DB starts with kid-old as the (only) active row, matching the env.
let plan = planRotation([{ kid: oldKp.kid }], oldKp.kid);

test("2. new key is introduced — planRotation() approves a normal retire-existing rotation", () => {
  assert.deepEqual(plan, { ok: true, mode: "retire-existing", outgoingKid: "kid-old" });
});

const newKp = generateRsaKeypair("kid-new");

// Simulated post-rotation DB state (what rotate-jwt-signing-key.ts's
// transaction would have written): kid-old -> retiring (as of t0),
// kid-new -> active. mergeVerificationKeys() (1D-a) is fed this directly —
// it's the same function lib/jwt-keys.ts's getVerificationKeys() calls
// after a real DB read.
const dbAfterRotation: VerificationKey[] = [
  { kid: oldKp.kid, publicKey: oldKp.publicKey, status: "retiring" },
  { kid: newKp.kid, publicKey: newKp.publicKey, status: "active" },
];
const envAfterRotation: JwtKeypair = { kid: newKp.kid, privateKey: newKp.privateKey, publicKey: newKp.publicKey };

test("2b. exactly one row is sign-eligible after rotation, and it's the new key", () => {
  const signEligible = dbAfterRotation.filter((k) => canSign(k.status));
  assert.deepEqual(
    signEligible.map((k) => k.kid),
    ["kid-new"],
  );
});

// Step 3: new tokens use the new kid.
const newToken = signRs256({ userId: 1, role: "user" }, newKp.privateKey, newKp.kid);

test("3. new tokens use new kid — resolving by kid-new finds exactly the new key and verifies", () => {
  assert.equal(tokenKid(newToken), "kid-new");
  const candidates = mergeVerificationKeys(dbAfterRotation, envAfterRotation, "kid-new");
  assert.deepEqual(
    candidates.map((c) => c.kid),
    ["kid-new"],
  );
  assert.equal(verifyToken(newToken, candidates), true);
});

// Step 4: old tokens still verify with the old (now-retiring) key.
test("4. old tokens verify with old key — resolving by kid-old still finds it (grace period)", () => {
  const candidates = mergeVerificationKeys(dbAfterRotation, envAfterRotation, "kid-old");
  assert.deepEqual(
    candidates.map((c) => c.kid),
    ["kid-old"],
  );
  assert.equal(candidates[0].status, "retiring");
  assert.equal(canVerify(candidates[0].status), true);
  assert.equal(verifyToken(oldToken, candidates), true);
});

// Cross-check: a token signed under kid-old must NOT verify against
// kid-new's public key, and vice versa — proves the "which key" resolution
// actually matters cryptographically, not just as bookkeeping.
test("4b. old token does not verify against the new key's public key (wrong-key rejection is real, not assumed)", () => {
  assert.equal(verifyWithKey(oldToken, newKp.publicKey), false);
});
test("4c. new token does not verify against the old key's public key", () => {
  assert.equal(verifyWithKey(newToken, oldKp.publicKey), false);
});

// Step 5: unknown kid fails — never falls back to some other key.
test("5. unknown kid fails — resolves to zero candidates, nothing to try, forged-kid token is rejected", () => {
  const candidates = mergeVerificationKeys(dbAfterRotation, envAfterRotation, "kid-bogus");
  assert.deepEqual(candidates, []);
  // A token claiming a kid that was never issued, signed with some
  // unrelated (attacker-controlled) key, must not verify — there's no
  // candidate to even try it against.
  const attackerKp = generateRsaKeypair("kid-bogus");
  const forgedToken = signRs256({ userId: 999, role: "admin" }, attackerKp.privateKey, "kid-bogus");
  assert.equal(verifyToken(forgedToken, candidates), false);
});

// Step 6: old key eventually becomes removable — planRetirement() (1D-e),
// checked on both sides of the retention boundary.
const retiringRow: RetiringKeyRow = { kid: oldKp.kid, retiringAt: t0 };

test("6a. immediately after rotating, the old key is NOT yet removable", () => {
  const decisions = planRetirement([retiringRow], t0);
  assert.equal(decisions[0].safe, false);
});

test("6b. well before the retention window elapses (e.g. 1 day in), still not removable", () => {
  const decisions = planRetirement([retiringRow], new Date(t0.getTime() + 1 * 24 * 60 * 60 * 1000));
  assert.equal(decisions[0].safe, false);
});

const eligibleAt = new Date(t0.getTime() + RETENTION_PERIOD_MS);

test("6c. once RETENTION_PERIOD_MS (max token lifetime + skew) has elapsed, it becomes removable", () => {
  const decisions = planRetirement([retiringRow], eligibleAt);
  assert.equal(decisions[0].safe, true);
  // Sanity: the retention window is strictly longer than the token's own
  // max lifetime — otherwise a token minted right before rotation could
  // outlive its own signing key's verification eligibility.
  assert.ok(RETENTION_PERIOD_MS > MAX_TOKEN_LIFETIME_MS);
});

// Step 7: removed key no longer verifies — simulate retire-jwt-signing-keys.ts
// having run (kid-old moved to 'retired', so it drops out of the DB read
// entirely — fetchDbVerificationKeys()'s WHERE status = ANY(VERIFY_ELIGIBLE_STATUSES)
// excludes 'retired' rows at the SQL layer, never even returning them).
const dbAfterRetirement: VerificationKey[] = dbAfterRotation.filter((k) => k.kid !== oldKp.kid);

test("7. removed key no longer verifies — resolving kid-old after retirement finds nothing", () => {
  const candidates = mergeVerificationKeys(dbAfterRetirement, envAfterRotation, "kid-old");
  assert.deepEqual(candidates, []);
  assert.equal(verifyToken(oldToken, candidates), false);
});

test("7b. the still-active new key is unaffected by the old key's retirement", () => {
  const candidates = mergeVerificationKeys(dbAfterRetirement, envAfterRotation, "kid-new");
  assert.equal(verifyToken(newToken, candidates), true);
});

console.log("\nAll Phase 1D-f rotation-lifecycle tests passed — full lifecycle (sign → rotate → dual-verify → unknown-kid-reject → retire → reject) holds under real RS256 cryptography.");
