/**
 * scripts/src/test-sylo-oidc-client-library.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 3, Phase 5a-a: tests for the generic OIDC
 * Authorization Code + PKCE client library,
 * `artifacts/ayzen/src/lib/oidc-client.ts`.
 *
 * `oidc-client.ts` lives in the frontend workspace (`artifacts/ayzen`),
 * not the backend one — but it has zero framework/DOM dependencies (only
 * the Web Crypto API and `fetch`, both natively global in this sandbox's
 * Node 22+ the same way they're global in a browser), so it can be
 * imported and run for real here exactly the way every `scripts/src/
 * test-oidc-*.ts` file already reaches into `artifacts/api-server/src`
 * with a relative import — this is the identical pattern, aimed at the
 * other workspace.
 *
 * UNLIKE every earlier oidc test-*.ts file in this roadmap, this one
 * needs NO external npm dependency at all (no `jsonwebtoken`, no
 * `drizzle-orm`) — `crypto`/`fetch`/`btoa`/`TextEncoder` are Node
 * built-ins. So, unlike the 4a-4d/4e passes' CHANGES docs, there is no
 * "pending a live dependency run" caveat for this file: every assertion
 * below runs for real, right now, in this sandbox.
 *
 * Run: npx tsx scripts/src/test-sylo-oidc-client-library.ts
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  generatePkcePair,
  generateState,
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  type OidcClientConfig,
} from "../../artifacts/ayzen/src/lib/oidc-client";

function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ok — ${name}`))
    .catch((err) => {
      console.error(`  FAIL — ${name}`);
      throw err;
    });
}

const CONFIG: OidcClientConfig = {
  issuer: "https://ayzen.tech",
  clientId: "sylo",
  redirectUri: "https://sylo.ayzen.tech/oidc/callback",
  scopes: ["openid", "profile", "email"],
};

async function main() {
  console.log("generatePkcePair() — RFC 7636");

  await test("code_verifier is 43 base64url characters (32 random bytes, no padding)", async () => {
    const { codeVerifier } = await generatePkcePair();
    assert.equal(codeVerifier.length, 43);
    assert.match(codeVerifier, /^[A-Za-z0-9_-]+$/);
  });

  await test("code_challenge is exactly base64url(SHA-256(code_verifier)) — S256, real digest", async () => {
    const { codeVerifier, codeChallenge } = await generatePkcePair();
    const expected = createHash("sha256").update(codeVerifier).digest("base64url");
    assert.equal(codeChallenge, expected);
  });

  await test("two pairs are never identical (real CSPRNG, not a fixed/stubbed value)", async () => {
    const a = await generatePkcePair();
    const b = await generatePkcePair();
    assert.notEqual(a.codeVerifier, b.codeVerifier);
    assert.notEqual(a.codeChallenge, b.codeChallenge);
  });

  console.log("\ngenerateState() — RFC 6749 §10.12");

  await test("state is a base64url string, different on every call", () => {
    const s1 = generateState();
    const s2 = generateState();
    assert.match(s1, /^[A-Za-z0-9_-]+$/);
    assert.notEqual(s1, s2);
  });

  console.log("\nbuildAuthorizeUrl() — RFC 6749 §4.1.1 + OIDC Core §3.1.2.1 + RFC 7636 §4.3");

  await test("builds a correct authorize URL: response_type, client_id, redirect_uri, scope, state, S256 challenge", () => {
    const metadata = { authorization_endpoint: "https://ayzen.tech/oidc/authorize" };
    const url = new URL(buildAuthorizeUrl(CONFIG, metadata, "CHALLENGE123", "STATE456"));
    assert.equal(url.origin + url.pathname, "https://ayzen.tech/oidc/authorize");
    assert.equal(url.searchParams.get("response_type"), "code");
    assert.equal(url.searchParams.get("client_id"), "sylo");
    assert.equal(url.searchParams.get("redirect_uri"), "https://sylo.ayzen.tech/oidc/callback");
    assert.equal(url.searchParams.get("scope"), "openid profile email");
    assert.equal(url.searchParams.get("state"), "STATE456");
    assert.equal(url.searchParams.get("code_challenge"), "CHALLENGE123");
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  });

  await test("omits 'nonce' entirely when not supplied — never an empty/undefined param", () => {
    const metadata = { authorization_endpoint: "https://ayzen.tech/oidc/authorize" };
    const url = new URL(buildAuthorizeUrl(CONFIG, metadata, "c", "s"));
    assert.equal(url.searchParams.has("nonce"), false);
  });

  await test("includes 'nonce' verbatim when the caller supplies one", () => {
    const metadata = { authorization_endpoint: "https://ayzen.tech/oidc/authorize" };
    const url = new URL(buildAuthorizeUrl(CONFIG, metadata, "c", "s", "n-abc123"));
    assert.equal(url.searchParams.get("nonce"), "n-abc123");
  });

  console.log("\nexchangeCodeForTokens() — RFC 6749 §4.1.3 + RFC 7636 §4.5, PUBLIC CLIENT (no client_secret)");

  await test("POSTs form-urlencoded, correct grant_type/code/redirect_uri/client_id/code_verifier, NEVER a client_secret", async () => {
    const metadata = { token_endpoint: "https://ayzen.tech/oidc/token" };
    let capturedBody = "";
    let capturedHeaders: Record<string, string> = {};
    const originalFetch = globalThis.fetch;
    (globalThis as any).fetch = async (_url: string, opts: any) => {
      capturedBody = String(opts.body);
      capturedHeaders = opts.headers;
      return { ok: true, json: async () => ({ access_token: "AT1", token_type: "Bearer", expires_in: 3600, scope: "openid profile email" }) };
    };
    try {
      const result = await exchangeCodeForTokens(CONFIG, metadata, "AUTHCODE", "VERIFIER123");
      assert.equal(result.access_token, "AT1");
      assert.equal(capturedHeaders["Content-Type"], "application/x-www-form-urlencoded");
      const params = new URLSearchParams(capturedBody);
      assert.equal(params.get("grant_type"), "authorization_code");
      assert.equal(params.get("code"), "AUTHCODE");
      assert.equal(params.get("redirect_uri"), CONFIG.redirectUri);
      assert.equal(params.get("client_id"), "sylo");
      assert.equal(params.get("code_verifier"), "VERIFIER123");
      assert.equal(params.has("client_secret"), false); // public client — see file header
    } finally {
      (globalThis as any).fetch = originalFetch;
    }
  });

  await test("a successful response with id_token/refresh_token round-trips every field", async () => {
    const metadata = { token_endpoint: "https://ayzen.tech/oidc/token" };
    const originalFetch = globalThis.fetch;
    (globalThis as any).fetch = async () => ({
      ok: true,
      json: async () => ({
        access_token: "AT2",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "openid",
        id_token: "ID.TOKEN.HERE",
        refresh_token: "RT2",
      }),
    });
    try {
      const result = await exchangeCodeForTokens(CONFIG, metadata, "c", "v");
      assert.equal(result.id_token, "ID.TOKEN.HERE");
      assert.equal(result.refresh_token, "RT2");
    } finally {
      (globalThis as any).fetch = originalFetch;
    }
  });

  await test("an OAuth error response throws with the provider's error_description", async () => {
    const metadata = { token_endpoint: "https://ayzen.tech/oidc/token" };
    const originalFetch = globalThis.fetch;
    (globalThis as any).fetch = async () => ({
      ok: false,
      json: async () => ({ error: "invalid_grant", error_description: "authorization code expired" }),
    });
    try {
      await assert.rejects(
        exchangeCodeForTokens(CONFIG, metadata, "c", "v"),
        /authorization code expired/,
      );
    } finally {
      (globalThis as any).fetch = originalFetch;
    }
  });

  await test("an OAuth error response with no error_description falls back to the bare error code", async () => {
    const metadata = { token_endpoint: "https://ayzen.tech/oidc/token" };
    const originalFetch = globalThis.fetch;
    (globalThis as any).fetch = async () => ({ ok: false, json: async () => ({ error: "invalid_grant" }) });
    try {
      await assert.rejects(exchangeCodeForTokens(CONFIG, metadata, "c", "v"), /invalid_grant/);
    } finally {
      (globalThis as any).fetch = originalFetch;
    }
  });

  console.log("\nAll assertions passed.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
