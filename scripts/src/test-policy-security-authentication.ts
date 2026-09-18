/**
 * scripts/src/test-policy-security-authentication.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Save as: scripts/src/test-policy-security-authentication.ts
 *
 * AYZEN Policy & Authorization Mega Engine — Phase 22B (Security / Abuse
 * Testing — Authentication category).
 *
 * The roadmap's own Phase 22 section, verbatim, for the slice this file
 * covers:
 *
 *   "Authentication:
 *    - unsigned token
 *    - malformed token
 *    - expired token
 *    - token substitution
 *    - stale session"
 *
 * This is a sub-phase, not all of Phase 22 — Phase 22A (Authorization
 * category) already shipped; Context, Policy, and Reliability remain,
 * exactly as 22A's own closing comment flagged (Rule 16: do not implement
 * future phases prematurely).
 *
 * ── Why this needed its own sub-phase, not a 22A extension ────────────────
 * 22A's entire fixture set assumes `req.user` is already authentic — every
 * case there builds a fake `Request` with a hand-set `user` field and asks
 * "can a hostile client influence the DECISION given an authentic subject".
 * This phase asks the question underneath that one: "can a hostile client
 * forge or resurrect the authentic subject in the first place". That means
 * exercising the REAL `lib/jwt.ts` verification code (`verifyAuthToken()`)
 * and, for the one DB-dependent case, the real `lib/auth-utils.ts` /
 * `lib/sessions.ts` — not a fake `req.user` at all.
 *
 * ── Scope discipline: verifyAuthToken() directly, not full HTTP middleware ──
 * Every attack case below calls `verifyAuthToken()` (`lib/jwt.ts`) directly
 * with a hand-assembled or hand-tampered token string — the exact function
 * `getUserFromToken()` (`lib/auth-utils.ts`) and every `requireAuth`-family
 * middleware (`middlewares/auth.ts`) call first, before anything else. This
 * is the same "test at the boundary an attacker actually touches" discipline
 * 22A used for `authorize()` — here the boundary is the raw bearer-token
 * string, the thing an attacker actually gets to choose. `getUserFromToken()`
 * itself is only exercised for the one case (unsigned legacy token) that
 * returns null WITHOUT reaching the database, so this file stays runnable
 * without a live Postgres for cases 1-4 (see runtime note below); the one
 * genuinely DB-dependent case (5, stale session) is handled the same way
 * `test-oidc-logout-session-integration.ts` (OIDC roadmap, Phase 6c-d)
 * already established for this exact situation — see that section's own
 * comment.
 *
 * ── Runtime requirements ──────────────────────────────────────────────────
 * Needs DATABASE_URL set to ANY value (even an unreachable host/port) —
 * this is a pre-existing constraint of this codebase, not something this
 * phase introduces: `lib/jwt-keys.ts` imports the shared `pg` `Pool` from
 * `@workspace/db` at module load time (that module throws immediately if
 * `DATABASE_URL` is unset at all — see `lib/db/src/index.ts`), and
 * `lib/auth-utils.ts` imports `@workspace/db` too. `test-resolve-
 * verification-keys.ts` (Phase 1D-b) already documents this same
 * requirement in its own header.
 *
 * A REAL reachable Postgres is NOT required for cases 1-4 below:
 * `getVerificationKeys()` (`lib/jwt-keys.ts`) wraps its `jwt_signing_keys`
 * read in try/catch and falls back to the single env-resolved active
 * keypair on any DB error — a refused/unreachable connection is exactly
 * such an error. Case 5 is checked by static source verification plus a
 * documented manual step, not a live run (see its own section for why).
 *
 * Run: npx tsx scripts/src/test-policy-security-authentication.ts
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import jwt from "jsonwebtoken";
import { generateKeyPairSync } from "node:crypto";
import { signAuthToken, verifyAuthToken } from "../../artifacts/api-server/src/lib/jwt";
import { getActiveKeypair } from "../../artifacts/api-server/src/lib/jwt-keys";
import { getUserFromToken } from "../../artifacts/api-server/src/lib/auth-utils";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_SRC = path.resolve(__dirname, "../../artifacts/api-server/src");

let passed = 0;
let failed = 0;

/** Catches and counts rather than throwing, so one failing case never hides
 *  the results of every case after it — matters here more than in 22A
 *  because this file mixes live behavioral checks with static source
 *  verification, and a reader needs to see the full picture of which half
 *  is or isn't currently true. */
function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(`  ok — ${name}`);
    })
    .catch((err) => {
      failed++;
      console.error(`  FAIL — ${name}`);
      console.error(err);
    });
}

function readSrc(relPath: string): string {
  return fs.readFileSync(path.join(API_SRC, relPath), "utf8");
}

function base64url(input: Buffer | string): string {
  return (Buffer.isBuffer(input) ? input : Buffer.from(input)).toString("base64url");
}

/** Hand-assembles a JWT-shaped string from arbitrary header/payload objects
 *  and a raw signature segment. Used instead of jsonwebtoken's own .sign()
 *  for shapes that library wouldn't normally produce (e.g. alg:"none" with
 *  no signature) — these tests need to exercise exactly what an attacker
 *  could put on the wire, not what our own signing code happens to emit. */
function assembleToken(header: object, payload: object, signature: string): string {
  return `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}.${signature}`;
}

function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
}

/** Tampers with one claim of an otherwise-real, validly-signed token WITHOUT
 *  re-signing it — the header and signature segments are carried over
 *  unchanged, only the payload segment is recomputed. Every case that uses
 *  this is checking the same underlying guarantee (a modified payload no
 *  longer matches its signature), applied to a different claim each time,
 *  matching 22A's own "same mechanism, different attacker-controlled field"
 *  structure. */
function tamperPayload(token: string, mutate: (payload: Record<string, unknown>) => void): string {
  const [headerPart, payloadPart, sigPart] = token.split(".");
  const payload = decodeSegment(payloadPart);
  mutate(payload);
  return `${headerPart}.${base64url(JSON.stringify(payload))}.${sigPart}`;
}

function generateAttackerKeypair() {
  return generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
}

async function main() {
  console.log("Policy Engine — Phase 22B (Security / Abuse Testing — Authentication) tests");

  const realKid = getActiveKeypair().kid;

  // ── fixture sanity ───────────────────────────────────────────────────
  // Same discipline 22A used for its resource-ID-substitution positive
  // control: confirm the harness can accept a token at all before relying
  // on every later "and this is rejected" result meaning something.

  await test("fixture sanity: an ordinary, freshly-signed token verifies successfully", () => {
    const token = signAuthToken(9001, "member");
    const payload = verifyAuthToken(token);
    assert.ok(payload, "expected a real, untampered token to verify");
    assert.equal(payload!.userId, 9001);
    assert.equal(payload!.role, "member");
  });

  // ── 1. unsigned token ────────────────────────────────────────────────
  console.log("\n1. Unsigned token");

  await test('unsigned token: alg:"none" with an empty signature segment is rejected — verifyAuthToken() only ever attempts RS256 verification (algorithms pinned explicitly), there is no signature-less accept path', () => {
    const forged = assembleToken({ alg: "none", typ: "JWT" }, { userId: 1, role: "admin" }, "");
    assert.equal(verifyAuthToken(forged), null);
  });

  await test("unsigned token: the legacy base64(JSON) format (no signature, no header, not JWT-shaped at all) is rejected by verifyAuthToken()", () => {
    const legacy = Buffer.from(JSON.stringify({ userId: 1, role: "admin" })).toString("base64");
    assert.equal(verifyAuthToken(legacy), null);
  });

  await test("unsigned token: getUserFromToken() rejects the same legacy base64 token when ALLOW_LEGACY_AUTH_TOKENS is unset (the default) — verified WITHOUT touching the database, since this path returns null before any DB lookup is reached (looksLikeApiKey → false, verifyAuthToken → null, no external JWT secret configured, legacy flag off)", async () => {
    delete process.env.ALLOW_LEGACY_AUTH_TOKENS;
    delete process.env.SUPABASE_JWT_SECRET;
    delete process.env.JWT_SECRET;
    const legacy = Buffer.from(JSON.stringify({ userId: 1, role: "admin" })).toString("base64");
    const result = await getUserFromToken(legacy);
    assert.equal(result, null);
  });

  // ── 2. malformed token ──────────────────────────────────────────────
  console.log("\n2. Malformed token");

  await test("malformed token: a plain garbage string is rejected", () => {
    assert.equal(verifyAuthToken("this-is-not-a-jwt-at-all"), null);
  });

  await test("malformed token: a dot-separated but non-base64 garbage string is rejected", () => {
    assert.equal(verifyAuthToken("not!!.base64!!.at-all!!"), null);
  });

  await test("malformed token: truncating a real token's signature segment invalidates it", () => {
    const token = signAuthToken(9002, "member");
    const truncated = token.slice(0, -10);
    assert.equal(verifyAuthToken(truncated), null);
  });

  await test("malformed token: tampering with the role claim (privilege escalation via the token itself, not the request body) without re-signing invalidates the signature", () => {
    const token = signAuthToken(9003, "member");
    const tampered = tamperPayload(token, (p) => {
      p.role = "admin";
    });
    assert.equal(verifyAuthToken(tampered), null);
  });

  await test("malformed token: tampering with the userId claim without re-signing invalidates the signature", () => {
    const token = signAuthToken(9004, "member");
    const tampered = tamperPayload(token, (p) => {
      p.userId = 1;
    });
    assert.equal(verifyAuthToken(tampered), null);
  });

  // ── 3. expired token ─────────────────────────────────────────────────
  console.log("\n3. Expired token");

  await test("expired token: a token signed with a negative expiry (already expired at issuance) is rejected", () => {
    const token = signAuthToken(9005, "member", { expiresIn: "-10s" });
    assert.equal(verifyAuthToken(token), null);
  });

  await test("expired token: forging the exp claim forward without re-signing does not resurrect an expired token — same signature-mismatch mechanism as the malformed-token cases above, checked explicitly for this claim since exp is the one an attacker most directly wants to move", () => {
    const token = signAuthToken(9006, "member", { expiresIn: "-10s" });
    const tampered = tamperPayload(token, (p) => {
      p.exp = Math.floor(Date.now() / 1000) + 3600; // 1h in the future
    });
    assert.equal(verifyAuthToken(tampered), null);
  });

  // ── 4. token substitution / key confusion ───────────────────────────
  console.log("\n4. Token substitution");

  await test("token substitution: swapping the sid claim of a valid token (session-hijack attempt aimed at inheriting someone else's session id) without re-signing invalidates it", () => {
    const token = signAuthToken(9007, "member", { sid: "aaaa-real-own-session" });
    const tampered = tamperPayload(token, (p) => {
      p.sid = "bbbb-someone-elses-session";
    });
    assert.equal(verifyAuthToken(tampered), null);
  });

  await test("token substitution: a token forged with an attacker-owned RSA keypair but the SERVER's real kid in its header is rejected (kid confusion / key injection) — resolveVerificationKeys(kid) resolves that kid to the real server key only, and the attacker's signature does not verify against it", () => {
    const attacker = generateAttackerKeypair();
    const forged = jwt.sign({ userId: 1, role: "admin" }, attacker.privateKey, {
      algorithm: "RS256",
      keyid: realKid,
      expiresIn: "1h",
    });
    assert.equal(verifyAuthToken(forged), null);
  });

  await test("token substitution: a well-formed RS256 token bearing a fabricated, unregistered kid is rejected and never silently retried against the real active key — the deterministic no-fallback lookup documented in jwt-keys.ts", () => {
    const attacker = generateAttackerKeypair();
    const forged = jwt.sign({ userId: 1, role: "admin" }, attacker.privateKey, {
      algorithm: "RS256",
      keyid: "kid-that-does-not-exist",
      expiresIn: "1h",
    });
    assert.equal(verifyAuthToken(forged), null);
  });

  await test("token substitution: RS256→HS256 algorithm-confusion (signing with the server's own PUBLIC key used as an HMAC secret, claiming HS256) is rejected — ALLOW_LEGACY_HS256_TOKENS is off by default, which is the only path that ever attempts an HS256 check at all; even if it were on, getLegacyHs256Secret() reads a server-configured env secret, never RSA public key material, so this specific forgery would still not match", () => {
    delete process.env.ALLOW_LEGACY_HS256_TOKENS;
    const { publicKey } = getActiveKeypair();
    const forged = jwt.sign({ userId: 1, role: "admin" }, publicKey, {
      algorithm: "HS256",
      keyid: realKid,
      expiresIn: "1h",
    });
    assert.equal(verifyAuthToken(forged), null);
  });

  // ── 5. stale session ─────────────────────────────────────────────────
  // DB-dependent, split the same way test-oidc-logout-session-integration.ts
  // (OIDC roadmap, Phase 6c-d) already established for this exact situation:
  // the DB-free, mechanically-checkable half is asserted against the real
  // source below; the DB-dependent half (does a revoked-mid-life session
  // actually stop authenticating a still-cryptographically-valid token) is
  // recorded as a manual step, not faked with a mocked pool.
  console.log("\n5. Stale session");

  await test("stale session: getUserFromToken() consults isSessionRevoked(ownToken.sid) and returns null immediately when it reports revoked/expired — before the DB role/status re-read that would otherwise happen next", () => {
    const authUtilsSrc = readSrc("lib/auth-utils.ts");
    assert.match(authUtilsSrc, /import\s*\{\s*isSessionRevoked\s*,\s*touchSession\s*\}\s*from\s*"\.\/sessions"/);
    assert.match(authUtilsSrc, /ownToken\.sid\s*&&\s*\(await isSessionRevoked\(ownToken\.sid\)\)/);
    const lines = authUtilsSrc.split("\n");
    const checkLineIdx = lines.findIndex((l) => l.includes("await isSessionRevoked(ownToken.sid)"));
    assert.notEqual(checkLineIdx, -1, "expected an isSessionRevoked(ownToken.sid) check in auth-utils.ts");
    assert.match(lines[checkLineIdx + 1], /return null;/);
  });

  await test("stale session: lib/sessions.ts's isSessionRevoked() treats BOTH an explicit revocation AND a lapsed expiry as stale — a session does not have to be explicitly revoked to stop authenticating, it can also simply time out", () => {
    const sessionsSrc = readSrc("lib/sessions.ts");
    assert.match(
      sessionsSrc,
      /isSessionRevoked[\s\S]*?return !!row\.revoked_at \|\| new Date\(row\.expires_at\)\.getTime\(\) < Date\.now\(\);/,
    );
  });

  await test("stale session: a sid-less (pre-sessions-feature) token is deliberately NOT subject to this check at all — confirms the exemption is scoped to ownToken.sid being falsy, not a broader bypass", () => {
    const authUtilsSrc = readSrc("lib/auth-utils.ts");
    // The condition is `ownToken.sid && (...)` — an absent sid short-circuits
    // the whole check to false, which is documented, pre-existing behavior
    // (see lib/jwt.ts's own AuthTokenPayload.sid comment), not something
    // this phase is asserting is a good idea on its own.
    assert.match(authUtilsSrc, /if \(ownToken\.sid && \(await isSessionRevoked\(ownToken\.sid\)\)\) \{/);
  });

  console.log(
    "\n  MANUAL — requires a live DATABASE_URL, a real user row, and a real login session " +
      "(not exercised here; see this file's header and test-oidc-logout-session-integration.ts's " +
      "own precedent for this exact DB-dependency split):\n" +
      "    1. Log in normally — the issued token carries a `sid` bound to a fresh\n" +
      "       user_sessions row (lib/sessions.ts's createSession()).\n" +
      "    2. Confirm an authenticated request with that token succeeds.\n" +
      "    3. Revoke the session (POST /auth/sessions/:id/revoke, the Security page's own\n" +
      "       button) — or let it lapse past its expires_at — WITHOUT touching the token\n" +
      "       itself. Its signature and its own exp claim are still perfectly valid.\n" +
      "    4. Confirm: the SAME token is now rejected — getUserFromToken() ->\n" +
      "       isSessionRevoked(sid) -> true -> null -> requireAuth() responds\n" +
      "       401 INVALID_TOKEN.\n" +
      "  This is precisely the failure mode a signature/expiry-only check (everything in\n" +
      "  cases 1-4 above) cannot catch by construction — a stale session is a token that\n" +
      "  is still cryptographically perfect but points at server-side state that has since\n" +
      "  been invalidated. That gap is exactly why user_sessions exists at all instead of\n" +
      "  relying on token expiry alone (see lib/sessions.ts's own file header).",
  );

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main();

/**
 * ── Deliberately NOT done here (later Phase 22 sub-phases) ───────────────
 * - Context category (spoofed organization/role/risk/device/assurance) —
 *   22A's role/org cases already cover the PEP-boundary slice of "spoofed
 *   role"/"spoofed organization" via the request body/headers; this file
 *   covers the token/session layer's own version of "spoofed role" (a
 *   tampered role claim) and "spoofed identity" (kid confusion, sid
 *   substitution). What's still not covered is the roadmap's own framing
 *   of Context: a Phase 18 PolicyInformationPoint's enrichment inputs
 *   specifically (session/device/risk PROVIDERS feeding enrichment.pip),
 *   which needs its own fixture set with a fake, adversarial PIP.
 * - Policy category (policy injection, invalid DSL, conflicting rules,
 *   priority abuse, cache poisoning, stale authorization cache) — needs
 *   the Phase 06 DSL compiler and Phase 07 registry/PAP layer exercised
 *   adversarially, a distinct suite from this one.
 * - Reliability category (database/policy/provider/cache failure, partial
 *   context failure) — needs providers that fail on demand (throwing
 *   fakes), not the always-succeeding fakes 22A's suite uses, and not the
 *   "DB unreachable → fall back to env keypair" behavior this file relies
 *   on for cases 1-4 (that fallback is itself Reliability-relevant and
 *   worth a dedicated, explicit case in that later sub-phase rather than
 *   being incidentally exercised here as a side effect).
 */
