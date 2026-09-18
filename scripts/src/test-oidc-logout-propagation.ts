/**
 * scripts/src/test-oidc-logout-propagation.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 3, Phase 6e-a tests.
 *
 * Covers `lib/oidc-logout-propagation.ts`'s `buildLogoutTokenClaims()` /
 * `issueOidcLogoutToken()` against REAL RS256 cryptography — same
 * dev-ephemeral-keypair setup `test-oidc-id-token-hint.ts` (6a-b) already
 * established (`NODE_ENV` forced to non-"production", no
 * `AYZEN_JWT_*`/live secrets needed) — plus `propagateBackchannelLogout()`
 * against a fake, in-memory `deliver` (no real network call exists to make
 * yet — see that file's own header for why).
 *
 * Run: npx tsx scripts/src/test-oidc-logout-propagation.ts
 */
process.env.NODE_ENV = "test";
delete process.env.AYZEN_JWT_PRIVATE_KEY;
delete process.env.AYZEN_JWT_PUBLIC_KEY;
delete process.env.AYZEN_JWT_KID;
process.env.AYZEN_OIDC_ISSUER = "https://ayzen.tech";

import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import { generateKeyPairSync } from "node:crypto";
import {
  BACKCHANNEL_LOGOUT_EVENT,
  LOGOUT_TOKEN_TTL_SECONDS,
  buildLogoutTokenClaims,
  issueOidcLogoutToken,
  propagateBackchannelLogout,
  type OidcBackchannelLogoutDeliverFn,
  type OidcBackchannelLogoutDeliveryResult,
  type OidcBackchannelLogoutTarget,
  type OidcLogoutTokenBinding,
} from "../../artifacts/api-server/src/lib/oidc-logout-propagation";
import { getActiveKeypair } from "../../artifacts/api-server/src/lib/jwt-keys";
import { resolveIssuer } from "../../artifacts/api-server/src/lib/oidc-discovery";

function test(name: string, fn: () => void | Promise<void>): void | Promise<void> {
  try {
    const result = fn();
    if (result instanceof Promise) {
      return result
        .then(() => console.log(`  ok — ${name}`))
        .catch((err) => {
          console.error(`  FAIL — ${name}`);
          throw err;
        });
    }
    console.log(`  ok — ${name}`);
  } catch (err) {
    console.error(`  FAIL — ${name}`);
    throw err;
  }
}

const FIXED_NOW = new Date("2026-01-01T00:00:00.000Z");
const FIXED_IAT = Math.floor(FIXED_NOW.getTime() / 1000);

const BINDING_NO_SID: OidcLogoutTokenBinding = { userId: 42, clientId: "sylo", sid: null };
const BINDING_WITH_SID: OidcLogoutTokenBinding = { userId: 42, clientId: "sylo", sid: "session-abc" };

async function main() {

console.log("buildLogoutTokenClaims() — 6e-a");

test("carries the fixed events member exactly", () => {
  const claims = buildLogoutTokenClaims(BINDING_NO_SID, "jti-1", FIXED_NOW);
  assert.deepEqual(claims.events, { [BACKCHANNEL_LOGOUT_EVENT]: {} });
});

test("uses resolveIssuer() for iss, never a second independently-configured value", () => {
  const claims = buildLogoutTokenClaims(BINDING_NO_SID, "jti-1", FIXED_NOW);
  assert.equal(claims.iss, resolveIssuer());
});

test("sub is the stringified userId, aud is the clientId", () => {
  const claims = buildLogoutTokenClaims(BINDING_NO_SID, "jti-1", FIXED_NOW);
  assert.equal(claims.sub, "42");
  assert.equal(claims.aud, "sylo");
});

test("iat/exp are computed from the explicit now, exp = iat + LOGOUT_TOKEN_TTL_SECONDS", () => {
  const claims = buildLogoutTokenClaims(BINDING_NO_SID, "jti-1", FIXED_NOW);
  assert.equal(claims.iat, FIXED_IAT);
  assert.equal(claims.exp, FIXED_IAT + LOGOUT_TOKEN_TTL_SECONDS);
});

test("jti is passed through unchanged", () => {
  const claims = buildLogoutTokenClaims(BINDING_NO_SID, "a-specific-jti", FIXED_NOW);
  assert.equal(claims.jti, "a-specific-jti");
});

test("sid is entirely absent (not even as a null/empty key) when binding.sid is null", () => {
  const claims = buildLogoutTokenClaims(BINDING_NO_SID, "jti-1", FIXED_NOW);
  assert.equal("sid" in claims, false);
});

test("sid is carried through when binding.sid is set", () => {
  const claims = buildLogoutTokenClaims(BINDING_WITH_SID, "jti-1", FIXED_NOW);
  assert.equal(claims.sid, "session-abc");
});

test("never carries a nonce claim — Logout Tokens MUST NOT (Back-Channel Logout 1.0 §2.4)", () => {
  const claims = buildLogoutTokenClaims(BINDING_WITH_SID, "jti-1", FIXED_NOW) as Record<string, unknown>;
  assert.equal("nonce" in claims, false);
});

test("identical binding + jti + now yields identical claims (deterministic, no hidden state)", () => {
  const a = buildLogoutTokenClaims(BINDING_WITH_SID, "jti-1", FIXED_NOW);
  const b = buildLogoutTokenClaims(BINDING_WITH_SID, "jti-1", FIXED_NOW);
  assert.deepEqual(a, b);
});

console.log("\nissueOidcLogoutToken() — 6e-a");

test("signs with the active keypair's RS256 + kid, verifiable against its public key", () => {
  const { publicKey, kid } = getActiveKeypair();
  const token = issueOidcLogoutToken(BINDING_NO_SID, FIXED_NOW, "jti-1");
  const decoded = jwt.verify(token, publicKey, { algorithms: ["RS256"] }) as Record<string, unknown>;
  assert.equal(decoded.sub, "42");
  assert.equal(decoded.aud, "sylo");
  assert.equal(decoded.jti, "jti-1");
  assert.deepEqual(decoded.events, { [BACKCHANNEL_LOGOUT_EVENT]: {} });

  const header = jwt.decode(token, { complete: true }) as { header: { alg: string; kid?: string } };
  assert.equal(header.header.alg, "RS256");
  assert.equal(header.header.kid, kid);
});

test("signed token's claims are byte-for-byte buildLogoutTokenClaims()'s own output", () => {
  const token = issueOidcLogoutToken(BINDING_WITH_SID, FIXED_NOW, "jti-2");
  const decoded = jwt.decode(token) as Record<string, unknown>;
  const expected = buildLogoutTokenClaims(BINDING_WITH_SID, "jti-2", FIXED_NOW);
  assert.deepEqual(decoded, expected);
});

test("defaults jti to a fresh, distinct value per call when not supplied", () => {
  const tokenA = issueOidcLogoutToken(BINDING_NO_SID, FIXED_NOW);
  const tokenB = issueOidcLogoutToken(BINDING_NO_SID, FIXED_NOW);
  const jtiA = (jwt.decode(tokenA) as Record<string, unknown>).jti;
  const jtiB = (jwt.decode(tokenB) as Record<string, unknown>).jti;
  assert.notEqual(jtiA, jtiB);
});

test("a token signed by an unrelated keypair fails verification against the active public key", () => {
  const { publicKey: foreignPublicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const token = issueOidcLogoutToken(BINDING_NO_SID, FIXED_NOW, "jti-3");
  assert.throws(() => jwt.verify(token, foreignPublicKey, { algorithms: ["RS256"] }));
});

console.log("\npropagateBackchannelLogout() — 6e-a");

await test("hands the target and a real, verifiable Logout Token to the injected deliver()", async () => {
  const { publicKey } = getActiveKeypair();
  const target: OidcBackchannelLogoutTarget = { clientId: "sylo", backchannelLogoutUri: "https://sylo.ayzen.tech/oidc/backchannel-logout" };
  let received: { target: OidcBackchannelLogoutTarget; logoutToken: string } | null = null;
  const deliver: OidcBackchannelLogoutDeliverFn = async (t, token) => {
    received = { target: t, logoutToken: token };
    return { ok: true };
  };

  const result = await propagateBackchannelLogout(BINDING_NO_SID, target, deliver, FIXED_NOW);

  assert.equal(result.ok, true);
  assert.ok(received);
  assert.equal(received!.target, target);
  const decoded = jwt.verify(received!.logoutToken, publicKey, { algorithms: ["RS256"] }) as Record<string, unknown>;
  assert.equal(decoded.aud, "sylo");
});

await test("propagates the injected deliver()'s failure result unchanged", async () => {
  const target: OidcBackchannelLogoutTarget = { clientId: "sylo", backchannelLogoutUri: "https://sylo.ayzen.tech/oidc/backchannel-logout" };
  const failure: OidcBackchannelLogoutDeliveryResult = { ok: false, reason: "non_2xx_response", detail: "500" };
  const deliver: OidcBackchannelLogoutDeliverFn = async () => failure;

  const result = await propagateBackchannelLogout(BINDING_NO_SID, target, deliver, FIXED_NOW);
  assert.deepEqual(result, failure);
});

await test("never calls deliver() before the Logout Token is fully built (deliver only ever sees a complete, signed string)", async () => {
  const target: OidcBackchannelLogoutTarget = { clientId: "sylo", backchannelLogoutUri: "https://sylo.ayzen.tech/oidc/backchannel-logout" };
  let seenToken: string | null = null;
  const deliver: OidcBackchannelLogoutDeliverFn = async (_t, token) => {
    seenToken = token;
    return { ok: true };
  };
  await propagateBackchannelLogout(BINDING_NO_SID, target, deliver, FIXED_NOW);
  assert.ok(seenToken && seenToken.split(".").length === 3);
});

console.log("\nAll assertions passed.");

}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
