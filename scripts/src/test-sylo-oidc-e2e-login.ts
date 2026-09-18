/**
 * scripts/src/test-sylo-oidc-e2e-login.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 3, Phase 5b-g: E2E Login Test.
 *
 * Composes 5b-a (Login Entry Point) through 5b-f (Login Error States) into
 * one simulated round trip, the same "compose the whole sub-phase chain
 * into one test" shape `test-oidc-phase4-exit.ts` (4e-e) already
 * established for Season 2's exit criteria.
 *
 * WHY THIS DOESN'T CALL `startSyloOidcLogin()` OR MOUNT `oidc-callback.tsx`
 * DIRECTLY
 * Both require a real browser: `startSyloOidcLogin()` reads
 * `window.location`/`window.sessionStorage` and ends in
 * `window.location.assign()` (a real navigation, not something a Node
 * process can meaningfully assert on); `oidc-callback.tsx` needs a
 * rendered DOM tree via React. Every actual decision either of them makes
 * already lives in framework-agnostic, injectable functions —
 * `generatePkcePair()`/`generateState()`/`buildAuthorizeUrl()`
 * (`oidc-client.ts`, 5a-a) and `completeSyloOidcLogin()` plus its
 * surrounding helpers (`sylo-oidc-callback.ts`, 5b-b..5b-f) — which is
 * exactly why those files are split out from the browser-only entry
 * point/page components in the first place (see each file's own header).
 * This test drives THOSE functions directly, with a fake `Storage` and
 * injected `exchangeCode`/`sessionExchange` dependencies standing in for
 * the two real effectful boundaries (`sessionStorage`, network) — the
 * identical pattern `CompleteSyloOidcLoginDeps` was designed for.
 *
 * Run: npx tsx scripts/src/test-sylo-oidc-e2e-login.ts
 */
import assert from "node:assert/strict";
import { generatePkcePair, generateState, buildAuthorizeUrl, type OidcClientConfig, type OidcProviderMetadata, type OidcTokenResponse } from "../../artifacts/ayzen/src/lib/oidc-client";
import {
  parseSyloOidcCallbackParams,
  verifySyloOidcState,
  readPendingSyloOidcTransaction,
  clearPendingSyloOidcTransaction,
  completeSyloOidcLogin,
  describeSyloOidcCallbackError,
  SyloOidcCallbackError,
  type CompleteSyloOidcLoginDeps,
  type SessionExchangeResult,
} from "../../artifacts/ayzen/src/lib/sylo-oidc-callback";
import { SYLO_OIDC_PENDING_KEY, type PendingSyloOidcTransaction } from "../../artifacts/ayzen/src/lib/sylo-oidc-login";

function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ok — ${name}`))
    .catch((err) => {
      console.error(`  FAIL — ${name}`);
      throw err;
    });
}

/** Minimal in-memory `Storage` double — same role a real `window.sessionStorage` plays across the 5b-a → 5b-b redirect round-trip, without needing a browser. */
class FakeStorage implements Storage {
  private store = new Map<string, string>();
  get length(): number { return this.store.size; }
  clear(): void { this.store.clear(); }
  getItem(key: string): string | null { return this.store.has(key) ? this.store.get(key)! : null; }
  key(index: number): string | null { return Array.from(this.store.keys())[index] ?? null; }
  removeItem(key: string): void { this.store.delete(key); }
  setItem(key: string, value: string): void { this.store.set(key, value); }
}

const CONFIG: OidcClientConfig = {
  issuer: "https://ayzen.tech",
  clientId: "sylo",
  redirectUri: "https://sylo.ayzen.tech/oidc/callback",
  scopes: ["openid", "profile", "email"],
};

const METADATA: OidcProviderMetadata = {
  issuer: "https://ayzen.tech",
  authorization_endpoint: "https://ayzen.tech/oidc/authorize",
  token_endpoint: "https://ayzen.tech/oidc/token",
  userinfo_endpoint: "https://ayzen.tech/oidc/userinfo",
};

/** 5b-a, reproduced with injected storage instead of `window.sessionStorage`/`window.location.assign` — mirrors exactly what `startSyloOidcLogin()` does internally (same functions, same order), just without the two browser-only calls at its edges. */
async function simulateLoginStart(storage: Storage, returnToPath = "/vault"): Promise<{ pending: PendingSyloOidcTransaction; authorizeUrl: string }> {
  const { codeVerifier, codeChallenge } = await generatePkcePair();
  const state = generateState();
  const nonce = generateState();
  const pending: PendingSyloOidcTransaction = {
    state,
    codeVerifier,
    nonce,
    clientId: CONFIG.clientId,
    returnToPath,
    createdAt: Date.now(),
  };
  storage.setItem(SYLO_OIDC_PENDING_KEY, JSON.stringify(pending));
  const authorizeUrl = buildAuthorizeUrl(CONFIG, METADATA, codeChallenge, state, nonce);
  return { pending, authorizeUrl };
}

/** Base64url-encodes a minimal ID token payload — same shape `routes/oidc-token.ts` would issue, just constructed directly rather than actually signed (this test only needs the `nonce`/`sub` claims `completeSyloOidcLogin()` reads, not a verifiable signature — the browser doesn't verify the signature either, see `sylo-oidc-callback.ts`'s own header). */
function fakeIdToken(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${header}.${payload}.fake-signature`;
}

async function main() {
  console.log("5b-g: E2E Sylo OIDC login — happy path");

  await test("full round trip: login start -> provider callback -> token exchange -> session established", async () => {
    const storage = new FakeStorage();
    const { pending, authorizeUrl } = await simulateLoginStart(storage, "/vault/documents");

    // Sanity check on what 5b-a itself builds, before simulating the
    // provider's response — this is genuinely what a browser would have
    // navigated to.
    const authUrl = new URL(authorizeUrl);
    assert.equal(authUrl.origin + authUrl.pathname, "https://ayzen.tech/oidc/authorize");
    assert.equal(authUrl.searchParams.get("state"), pending.state);

    // Provider redirects back to /oidc/callback?code=...&state=...
    const callbackSearch = `?code=AUTHCODE123&state=${encodeURIComponent(pending.state)}`;
    const params = parseSyloOidcCallbackParams(callbackSearch);
    assert.equal(params.code, "AUTHCODE123");
    assert.equal(params.state, pending.state);
    assert.equal(params.error, null);

    const readBack = readPendingSyloOidcTransaction(storage);
    assert.deepEqual(readBack, pending);
    assert.equal(verifySyloOidcState(readBack, params.state), true);

    const idToken = fakeIdToken({ sub: "42", nonce: pending.nonce });
    const tokens: OidcTokenResponse = {
      access_token: "AT_XYZ",
      token_type: "Bearer",
      expires_in: 3600,
      scope: "openid profile email",
      id_token: idToken,
    };
    const sessionResult: SessionExchangeResult = { token: "sylo-session-token", user: { id: 42, email: "person@example.com" } };

    const deps: CompleteSyloOidcLoginDeps = {
      config: CONFIG,
      metadata: METADATA,
      exchangeCode: async (_config, _metadata, code, codeVerifier) => {
        assert.equal(code, "AUTHCODE123");
        assert.equal(codeVerifier, pending.codeVerifier);
        return tokens;
      },
      sessionExchange: async () => sessionResult,
    };

    const result = await completeSyloOidcLogin(params, readBack, deps);
    clearPendingSyloOidcTransaction(storage);

    assert.equal(result.token, "sylo-session-token");
    assert.equal(result.user.id, 42);
    assert.equal(result.returnToPath, "/vault/documents");
    assert.equal(result.tokens.access_token, "AT_XYZ");
    assert.equal(readPendingSyloOidcTransaction(storage), null); // single-use — consumed
  });

  await test("returnToPath defaults correctly and survives an ID token with no nonce claim (openid scope not redeemed)", async () => {
    const storage = new FakeStorage();
    const { pending } = await simulateLoginStart(storage, "/vault");
    const params = parseSyloOidcCallbackParams(`?code=C&state=${pending.state}`);
    const deps: CompleteSyloOidcLoginDeps = {
      config: CONFIG,
      metadata: METADATA,
      exchangeCode: async () => ({ access_token: "AT", token_type: "Bearer", expires_in: 3600, scope: "profile" }), // no id_token
      sessionExchange: async () => ({ token: "t", user: { id: 7 } }),
    };
    const result = await completeSyloOidcLogin(params, readPendingSyloOidcTransaction(storage), deps);
    assert.equal(result.returnToPath, "/vault");
    assert.equal(result.tokens.id_token, undefined);
  });

  console.log("\n5b-f: closed set of failure states, end to end through completeSyloOidcLogin()");

  await test("provider_error: /oidc/callback?error=access_denied short-circuits before touching storage/network", async () => {
    const params = parseSyloOidcCallbackParams("?error=access_denied&error_description=User+cancelled");
    await assert.rejects(
      completeSyloOidcLogin(params, null, {} as CompleteSyloOidcLoginDeps),
      (err: unknown) => err instanceof SyloOidcCallbackError && err.code === "provider_error",
    );
  });

  await test("missing_pending_transaction: valid code+state but nothing in this tab's storage (reload mid-attempt)", async () => {
    const params = parseSyloOidcCallbackParams("?code=C&state=S");
    await assert.rejects(
      completeSyloOidcLogin(params, null, {} as CompleteSyloOidcLoginDeps),
      (err: unknown) => err instanceof SyloOidcCallbackError && err.code === "missing_pending_transaction",
    );
  });

  await test("state_mismatch: returned state doesn't match what this tab generated", async () => {
    const storage = new FakeStorage();
    const { pending } = await simulateLoginStart(storage);
    const params = parseSyloOidcCallbackParams("?code=C&state=SOMETHING-ELSE");
    await assert.rejects(
      completeSyloOidcLogin(params, pending, {} as CompleteSyloOidcLoginDeps),
      (err: unknown) => err instanceof SyloOidcCallbackError && err.code === "state_mismatch",
    );
  });

  await test("missing_code: state matches but no code param at all", async () => {
    const storage = new FakeStorage();
    const { pending } = await simulateLoginStart(storage);
    const params = parseSyloOidcCallbackParams(`?state=${pending.state}`);
    await assert.rejects(
      completeSyloOidcLogin(params, pending, {} as CompleteSyloOidcLoginDeps),
      (err: unknown) => err instanceof SyloOidcCallbackError && err.code === "missing_code",
    );
  });

  await test("token_exchange_failed: the token endpoint rejects the code", async () => {
    const storage = new FakeStorage();
    const { pending } = await simulateLoginStart(storage);
    const params = parseSyloOidcCallbackParams(`?code=BADCODE&state=${pending.state}`);
    const deps: CompleteSyloOidcLoginDeps = {
      config: CONFIG,
      metadata: METADATA,
      exchangeCode: async () => { throw new Error("invalid_grant"); },
      sessionExchange: async () => ({ token: "t", user: { id: 1 } }),
    };
    await assert.rejects(
      completeSyloOidcLogin(params, pending, deps),
      (err: unknown) => err instanceof SyloOidcCallbackError && err.code === "token_exchange_failed",
    );
  });

  await test("identity_mismatch: ID token nonce doesn't match this tab's pending nonce", async () => {
    const storage = new FakeStorage();
    const { pending } = await simulateLoginStart(storage);
    const params = parseSyloOidcCallbackParams(`?code=C&state=${pending.state}`);
    const deps: CompleteSyloOidcLoginDeps = {
      config: CONFIG,
      metadata: METADATA,
      exchangeCode: async () => ({
        access_token: "AT", token_type: "Bearer", expires_in: 3600, scope: "openid",
        id_token: fakeIdToken({ sub: "1", nonce: "WRONG-NONCE" }),
      }),
      sessionExchange: async () => ({ token: "t", user: { id: 1 } }),
    };
    await assert.rejects(
      completeSyloOidcLogin(params, pending, deps),
      (err: unknown) => err instanceof SyloOidcCallbackError && err.code === "identity_mismatch",
    );
  });

  await test("session_exchange_failed: token exchange succeeds but session-exchange call fails", async () => {
    const storage = new FakeStorage();
    const { pending } = await simulateLoginStart(storage);
    const params = parseSyloOidcCallbackParams(`?code=C&state=${pending.state}`);
    const deps: CompleteSyloOidcLoginDeps = {
      config: CONFIG,
      metadata: METADATA,
      exchangeCode: async () => ({ access_token: "AT", token_type: "Bearer", expires_in: 3600, scope: "openid", id_token: fakeIdToken({ sub: "1", nonce: pending.nonce }) }),
      sessionExchange: async () => { throw new Error("no ayzen_session cookie"); },
    };
    await assert.rejects(
      completeSyloOidcLogin(params, pending, deps),
      (err: unknown) => err instanceof SyloOidcCallbackError && err.code === "session_exchange_failed",
    );
  });

  await test("identity_mismatch: session-exchange's user.id doesn't match the ID token's sub (defense in depth)", async () => {
    const storage = new FakeStorage();
    const { pending } = await simulateLoginStart(storage);
    const params = parseSyloOidcCallbackParams(`?code=C&state=${pending.state}`);
    const deps: CompleteSyloOidcLoginDeps = {
      config: CONFIG,
      metadata: METADATA,
      exchangeCode: async () => ({ access_token: "AT", token_type: "Bearer", expires_in: 3600, scope: "openid", id_token: fakeIdToken({ sub: "999", nonce: pending.nonce }) }),
      sessionExchange: async () => ({ token: "t", user: { id: 1 } }), // session-exchange says user 1, ID token says sub "999"
    };
    await assert.rejects(
      completeSyloOidcLogin(params, pending, deps),
      (err: unknown) => err instanceof SyloOidcCallbackError && err.code === "identity_mismatch",
    );
  });

  console.log("\ndescribeSyloOidcCallbackError() — every code maps to a retryable, non-leaking user-facing message");

  await test("every SyloOidcCallbackErrorCode has a description that never echoes the raw internal message", () => {
    const codes = [
      "provider_error", "missing_pending_transaction", "state_mismatch",
      "missing_code", "token_exchange_failed", "session_exchange_failed", "identity_mismatch",
    ] as const;
    for (const code of codes) {
      const err = new SyloOidcCallbackError(code, "some raw internal detail, e.g. a stack trace fragment");
      const described = describeSyloOidcCallbackError(err);
      assert.ok(described.title.length > 0);
      assert.ok(described.description.length > 0);
      assert.equal(described.canRetry, true);
      assert.equal(described.description.includes("stack trace fragment"), false);
    }
  });

  await test("a non-SyloOidcCallbackError (unexpected throw) still gets a safe, generic, retryable message", () => {
    const described = describeSyloOidcCallbackError(new Error("ECONNRESET"));
    assert.ok(described.title.length > 0);
    assert.equal(described.canRetry, true);
    assert.equal(described.description.includes("ECONNRESET"), false);
  });

  console.log("\nAll assertions passed.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
