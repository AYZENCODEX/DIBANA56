/**
 * scripts/src/test-sylo-oidc-config-and-discovery.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 3, Phase 5a-f: Configuration Tests.
 *
 * Exercises `artifacts/ayzen/src/lib/sylo-oidc-config.ts` (5a-b/5a-c/5a-d)
 * and `artifacts/ayzen/src/lib/sylo-oidc-discovery.ts` (5a-e) directly —
 * same "no framework/DOM dependency, runs for real under plain Node" shape
 * `test-sylo-oidc-client-library.ts` (5a-a) already established for the
 * other half of this workspace's OIDC client code. `resolveSyloOidcIssuer()`
 * and `getSyloOidcProviderMetadata()` both accept an `overrides` /
 * `ResolveSyloOidcIssuerOverrides` parameter for exactly this reason — see
 * each function's own doc comment.
 *
 * `window` genuinely doesn't exist in this plain-Node runner, so every
 * assertion below either supplies an explicit override (issuer/apiBase/
 * origin) or exercises the "no window" fallback path itself — never a real
 * browser global.
 *
 * Run: npx tsx scripts/src/test-sylo-oidc-config-and-discovery.ts
 */
import assert from "node:assert/strict";
import {
  resolveSyloOidcIssuer,
  resolveSyloOidcClientId,
  resolveSyloOidcRedirectUri,
  getSyloOidcClientConfig,
  SYLO_OIDC_CLIENT_ID,
  SYLO_OIDC_CALLBACK_PATH,
  SYLO_OIDC_SCOPES,
} from "../../artifacts/ayzen/src/lib/sylo-oidc-config";
import {
  fetchSyloOidcProviderMetadata,
  getSyloOidcProviderMetadata,
  __resetSyloOidcProviderMetadataCacheForTests,
} from "../../artifacts/ayzen/src/lib/sylo-oidc-discovery";

function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ok — ${name}`))
    .catch((err) => {
      console.error(`  FAIL — ${name}`);
      throw err;
    });
}

async function main() {
  console.log("resolveSyloOidcIssuer() — 5a-b");

  await test("explicit override wins over apiBase/origin", () => {
    const issuer = resolveSyloOidcIssuer({
      explicitIssuer: "https://account.ayzen.tech/",
      apiBase: "https://api.ayzen.tech",
      origin: "https://sylo.ayzen.tech",
    });
    assert.equal(issuer, "https://account.ayzen.tech"); // trailing slash stripped
  });

  await test("falls back to apiBase when no explicit override is given", () => {
    const issuer = resolveSyloOidcIssuer({ apiBase: "https://api.ayzen.tech/", origin: "https://sylo.ayzen.tech" });
    assert.equal(issuer, "https://api.ayzen.tech");
  });

  await test("falls back to origin when neither an explicit issuer nor an apiBase is available", () => {
    const issuer = resolveSyloOidcIssuer({ apiBase: "", origin: "https://sylo.ayzen.tech" });
    assert.equal(issuer, "https://sylo.ayzen.tech");
  });

  await test("an empty explicit override (whitespace only) is treated as absent, falls through", () => {
    const issuer = resolveSyloOidcIssuer({ explicitIssuer: "   ", apiBase: "https://api.ayzen.tech" });
    assert.equal(issuer, "https://api.ayzen.tech");
  });

  console.log("\nresolveSyloOidcClientId() / resolveSyloOidcRedirectUri() — 5a-c/5a-d");

  await test("client id falls back to the SYLO_OIDC_CLIENT_ID constant outside a browser (no window to detect a subdomain from)", () => {
    assert.equal(typeof window, "undefined");
    assert.equal(resolveSyloOidcClientId(), SYLO_OIDC_CLIENT_ID);
    assert.equal(resolveSyloOidcClientId(), "sylo");
  });

  await test("redirect URI resolves to \"\" outside a browser rather than guessing a hostname", () => {
    assert.equal(resolveSyloOidcRedirectUri(), "");
  });

  await test("SYLO_OIDC_CALLBACK_PATH is the exact path the redirect URI would be built from in a browser", () => {
    assert.equal(SYLO_OIDC_CALLBACK_PATH, "/oidc/callback");
  });

  console.log("\ngetSyloOidcClientConfig() — 5a-b/5a-c/5a-d composed");

  await test("assembles a full OidcClientConfig from the four resolvers, honoring issuer overrides", () => {
    const config = getSyloOidcClientConfig({ explicitIssuer: "https://account.ayzen.tech" });
    assert.equal(config.issuer, "https://account.ayzen.tech");
    assert.equal(config.clientId, "sylo");
    assert.equal(config.redirectUri, ""); // still no window in this runner
    assert.deepEqual(config.scopes, SYLO_OIDC_SCOPES);
    assert.deepEqual(config.scopes, ["openid", "profile", "email"]);
  });

  console.log("\nfetchSyloOidcProviderMetadata() — 5a-e");

  await test("parses a well-formed discovery document into the narrow OidcProviderMetadata shape", async () => {
    const originalFetch = globalThis.fetch;
    let requestedUrl = "";
    (globalThis as any).fetch = async (url: string) => {
      requestedUrl = url;
      return {
        ok: true,
        json: async () => ({
          issuer: "https://account.ayzen.tech",
          jwks_uri: "https://account.ayzen.tech/.well-known/jwks.json",
          authorization_endpoint: "https://account.ayzen.tech/oidc/authorize",
          token_endpoint: "https://account.ayzen.tech/oidc/token",
          userinfo_endpoint: "https://account.ayzen.tech/oidc/userinfo",
          response_types_supported: ["code"],
          scopes_supported: ["openid"],
          id_token_signing_alg_values_supported: ["RS256"],
        }),
      };
    };
    try {
      const metadata = await fetchSyloOidcProviderMetadata("https://account.ayzen.tech/");
      assert.equal(requestedUrl, "https://account.ayzen.tech/.well-known/openid-configuration");
      assert.deepEqual(metadata, {
        issuer: "https://account.ayzen.tech",
        authorization_endpoint: "https://account.ayzen.tech/oidc/authorize",
        token_endpoint: "https://account.ayzen.tech/oidc/token",
        userinfo_endpoint: "https://account.ayzen.tech/oidc/userinfo",
      });
    } finally {
      (globalThis as any).fetch = originalFetch;
    }
  });

  await test("throws when the response is not ok", async () => {
    const originalFetch = globalThis.fetch;
    (globalThis as any).fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
    try {
      await assert.rejects(fetchSyloOidcProviderMetadata("https://account.ayzen.tech"), /404/);
    } finally {
      (globalThis as any).fetch = originalFetch;
    }
  });

  await test("throws when a required field (e.g. token_endpoint) is missing", async () => {
    const originalFetch = globalThis.fetch;
    (globalThis as any).fetch = async () => ({
      ok: true,
      json: async () => ({
        issuer: "https://account.ayzen.tech",
        authorization_endpoint: "https://account.ayzen.tech/oidc/authorize",
        userinfo_endpoint: "https://account.ayzen.tech/oidc/userinfo",
      }),
    });
    try {
      await assert.rejects(fetchSyloOidcProviderMetadata("https://account.ayzen.tech"), /token_endpoint/);
    } finally {
      (globalThis as any).fetch = originalFetch;
    }
  });

  await test("throws when the response body isn't valid JSON", async () => {
    const originalFetch = globalThis.fetch;
    (globalThis as any).fetch = async () => ({ ok: true, json: async () => { throw new Error("not json"); } });
    try {
      await assert.rejects(fetchSyloOidcProviderMetadata("https://account.ayzen.tech"));
    } finally {
      (globalThis as any).fetch = originalFetch;
    }
  });

  console.log("\ngetSyloOidcProviderMetadata() — 5a-e, cached + env-resolving");

  await test("caches per issuer: two calls for the same issuer only fetch once", async () => {
    __resetSyloOidcProviderMetadataCacheForTests();
    const originalFetch = globalThis.fetch;
    let fetchCount = 0;
    (globalThis as any).fetch = async () => {
      fetchCount += 1;
      return {
        ok: true,
        json: async () => ({
          issuer: "https://account.ayzen.tech",
          authorization_endpoint: "https://account.ayzen.tech/oidc/authorize",
          token_endpoint: "https://account.ayzen.tech/oidc/token",
          userinfo_endpoint: "https://account.ayzen.tech/oidc/userinfo",
        }),
      };
    };
    try {
      const a = await getSyloOidcProviderMetadata({ explicitIssuer: "https://account.ayzen.tech" });
      const b = await getSyloOidcProviderMetadata({ explicitIssuer: "https://account.ayzen.tech" });
      assert.equal(fetchCount, 1);
      assert.deepEqual(a, b);
    } finally {
      (globalThis as any).fetch = originalFetch;
      __resetSyloOidcProviderMetadataCacheForTests();
    }
  });

  await test("a failed fetch does not poison the cache — a later call retries", async () => {
    __resetSyloOidcProviderMetadataCacheForTests();
    const originalFetch = globalThis.fetch;
    let fetchCount = 0;
    (globalThis as any).fetch = async () => {
      fetchCount += 1;
      if (fetchCount === 1) return { ok: false, status: 500, json: async () => ({}) };
      return {
        ok: true,
        json: async () => ({
          issuer: "https://account.ayzen.tech",
          authorization_endpoint: "https://account.ayzen.tech/oidc/authorize",
          token_endpoint: "https://account.ayzen.tech/oidc/token",
          userinfo_endpoint: "https://account.ayzen.tech/oidc/userinfo",
        }),
      };
    };
    try {
      await assert.rejects(getSyloOidcProviderMetadata({ explicitIssuer: "https://account.ayzen.tech" }));
      const metadata = await getSyloOidcProviderMetadata({ explicitIssuer: "https://account.ayzen.tech" });
      assert.equal(fetchCount, 2);
      assert.equal(metadata.issuer, "https://account.ayzen.tech");
    } finally {
      (globalThis as any).fetch = originalFetch;
      __resetSyloOidcProviderMetadataCacheForTests();
    }
  });

  await test("different issuers are cached independently", async () => {
    __resetSyloOidcProviderMetadataCacheForTests();
    const originalFetch = globalThis.fetch;
    const seenUrls: string[] = [];
    (globalThis as any).fetch = async (url: string) => {
      seenUrls.push(url);
      const issuer = url.replace("/.well-known/openid-configuration", "");
      return {
        ok: true,
        json: async () => ({
          issuer,
          authorization_endpoint: `${issuer}/oidc/authorize`,
          token_endpoint: `${issuer}/oidc/token`,
          userinfo_endpoint: `${issuer}/oidc/userinfo`,
        }),
      };
    };
    try {
      const a = await getSyloOidcProviderMetadata({ explicitIssuer: "https://account.ayzen.tech" });
      const b = await getSyloOidcProviderMetadata({ explicitIssuer: "https://staging.ayzen.tech" });
      assert.equal(seenUrls.length, 2);
      assert.notEqual(a.issuer, b.issuer);
    } finally {
      (globalThis as any).fetch = originalFetch;
      __resetSyloOidcProviderMetadataCacheForTests();
    }
  });

  console.log("\nAll assertions passed.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
