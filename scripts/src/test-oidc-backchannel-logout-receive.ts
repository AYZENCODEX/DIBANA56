/**
 * scripts/src/test-oidc-backchannel-logout-receive.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 3, Phase 6e-b tests (receiving side).
 *
 * Covers `lib/oidc-backchannel-logout-receive.ts`'s
 * `handleInboundBackchannelLogout()` against REAL RS256 cryptography — same
 * dev-ephemeral-keypair setup `test-oidc-id-token-hint.ts` (6a-b) and
 * `test-oidc-logout-propagation.ts` (6e-a) already established (`NODE_ENV`
 * forced to non-"production", no `AYZEN_JWT_*`/live secrets needed), signing
 * real Logout Tokens with `lib/oidc-logout-propagation.ts`'s own
 * `issueOidcLogoutToken()` so this file never hand-rolls a second claim
 * builder that could quietly drift from what the sending side actually
 * produces.
 *
 * SCOPE — what this file DOES cover (pure claim/signature verification,
 * no live DB needed):
 *   - Valid token shape (RS256, right `iss`, `events`, no `nonce`) is
 *     accepted up to the point verification hands off to a DB lookup.
 *   - Every rejection this function can return WITHOUT touching the DB:
 *     unsupported `alg`, signature verification failure (wrong/foreign
 *     keypair), expired token, wrong `iss`, `nonce` present, missing
 *     `events` claim, malformed `sub`/`aud`.
 *
 * SCOPE — what this file does NOT cover (same "DB-live behavior is
 * hand-verified, not exercised against a real pool" precedent
 * `test-oidc-clients.ts`'s own note already established for this
 * codebase): the `unknown_client` branch (needs a real answer from
 * `oidcClientExists()`) and the full success path's
 * `revokeSessionsByUserAndOriginClient()` call (needs a live
 * `user_sessions` row to actually revoke) both require a real
 * `DATABASE_URL`. Verified manually against a real dev DB instead —
 * flagged here as a manual verification step, the same way
 * `test-seed-oidc-clients.ts`'s own header flags its own DB-touching gap.
 *
 * Run: npx tsx scripts/src/test-oidc-backchannel-logout-receive.ts
 */
process.env.NODE_ENV = "test";
delete process.env.AYZEN_JWT_PRIVATE_KEY;
delete process.env.AYZEN_JWT_PUBLIC_KEY;
delete process.env.AYZEN_JWT_KID;
process.env.AYZEN_OIDC_ISSUER = "https://ayzen.tech";

import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import { generateKeyPairSync } from "node:crypto";
import { handleInboundBackchannelLogout } from "../../artifacts/api-server/src/lib/oidc-backchannel-logout-receive";
import {
  BACKCHANNEL_LOGOUT_EVENT,
  buildLogoutTokenClaims,
  issueOidcLogoutToken,
  type OidcLogoutTokenBinding,
} from "../../artifacts/api-server/src/lib/oidc-logout-propagation";
import { getActiveKeypair } from "../../artifacts/api-server/src/lib/jwt-keys";

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  ok — ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL — ${name}`);
    console.error(err);
  }
}

const BINDING: OidcLogoutTokenBinding = { userId: 42, clientId: "sylo", sid: null };

/** A second, unrelated RSA keypair — stands in for "signed by someone who is NOT this provider," so verification against the real active key must fail. */
const FOREIGN_KEYPAIR = generateKeyPairSync("rsa", { modulusLength: 2048 });

async function main() {
  console.log("handleInboundBackchannelLogout() — 6e-b (pure verification path)");

  await test("rejects a token signed with an unsupported alg (header alg mismatch)", async () => {
    const claims = buildLogoutTokenClaims(BINDING, "jti-alg", new Date());
    const token = jwt.sign(claims, FOREIGN_KEYPAIR.privateKey, { algorithm: "RS256", keyid: "not-a-real-kid" });
    // Re-sign the header only with an unsupported alg to force the header-level guard.
    const forgedHeader = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const parts = token.split(".");
    const forged = `${forgedHeader}.${parts[1]}.${parts[2]}`;
    const result = await handleInboundBackchannelLogout(forged);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "unsupported_alg");
  });

  await test("rejects a token signed with a foreign (non-active) keypair", async () => {
    const claims = buildLogoutTokenClaims(BINDING, "jti-foreign", new Date());
    const token = jwt.sign(claims, FOREIGN_KEYPAIR.privateKey, { algorithm: "RS256", keyid: getActiveKeypair().kid });
    const result = await handleInboundBackchannelLogout(token);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "signature_verification_failed");
  });

  await test("rejects an expired token (past its 2-minute exp)", async () => {
    const longAgo = new Date(Date.now() - 10 * 60 * 1000);
    const token = issueOidcLogoutToken(BINDING, longAgo, "jti-expired");
    const result = await handleInboundBackchannelLogout(token);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "expired");
  });

  await test("rejects a token with the wrong issuer", async () => {
    const claims = { ...buildLogoutTokenClaims(BINDING, "jti-iss", new Date()), iss: "https://not-ayzen.example" };
    const { privateKey, kid } = getActiveKeypair();
    const token = jwt.sign(claims, privateKey, { algorithm: "RS256", keyid: kid, noTimestamp: true });
    const result = await handleInboundBackchannelLogout(token);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "issuer_mismatch");
  });

  await test("rejects a token carrying a nonce claim (§2.4 prohibits it on a Logout Token)", async () => {
    const claims = { ...buildLogoutTokenClaims(BINDING, "jti-nonce", new Date()), nonce: "should-not-be-here" };
    const { privateKey, kid } = getActiveKeypair();
    const token = jwt.sign(claims, privateKey, { algorithm: "RS256", keyid: kid, noTimestamp: true });
    const result = await handleInboundBackchannelLogout(token);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "nonce_present");
  });

  await test("rejects a token missing the Back-Channel Logout events claim", async () => {
    const claims: Record<string, unknown> = { ...buildLogoutTokenClaims(BINDING, "jti-events", new Date()) };
    delete claims.events;
    const { privateKey, kid } = getActiveKeypair();
    const token = jwt.sign(claims, privateKey, { algorithm: "RS256", keyid: kid, noTimestamp: true });
    const result = await handleInboundBackchannelLogout(token);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "missing_events_claim");
  });

  await test("rejects a token whose events claim doesn't carry the exact Back-Channel Logout schema key", async () => {
    const claims = { ...buildLogoutTokenClaims(BINDING, "jti-wrong-event", new Date()), events: { "https://example.com/some-other-event": {} } };
    assert.notEqual(Object.keys(claims.events)[0], BACKCHANNEL_LOGOUT_EVENT);
    const { privateKey, kid } = getActiveKeypair();
    const token = jwt.sign(claims, privateKey, { algorithm: "RS256", keyid: kid, noTimestamp: true });
    const result = await handleInboundBackchannelLogout(token);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "missing_events_claim");
  });

  await test("rejects a token with a non-numeric sub", async () => {
    const claims = { ...buildLogoutTokenClaims(BINDING, "jti-sub", new Date()), sub: "not-a-number" };
    const { privateKey, kid } = getActiveKeypair();
    const token = jwt.sign(claims, privateKey, { algorithm: "RS256", keyid: kid, noTimestamp: true });
    const result = await handleInboundBackchannelLogout(token);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "malformed_claims");
  });

  await test("rejects a token with an empty aud", async () => {
    const claims = { ...buildLogoutTokenClaims(BINDING, "jti-aud", new Date()), aud: "" };
    const { privateKey, kid } = getActiveKeypair();
    const token = jwt.sign(claims, privateKey, { algorithm: "RS256", keyid: kid, noTimestamp: true });
    const result = await handleInboundBackchannelLogout(token);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "malformed_claims");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
