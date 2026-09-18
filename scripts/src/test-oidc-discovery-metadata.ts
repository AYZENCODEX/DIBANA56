/**
 * scripts/src/test-oidc-discovery-metadata.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 1, Phase 1E-d: unit tests for
 * buildOidcDiscoveryMetadata()/resolveIssuer() in
 * artifacts/api-server/src/lib/oidc-discovery.ts.
 *
 * Pure, DB-free, env-free (resolveIssuer() is exercised separately from
 * buildOidcDiscoveryMetadata(), which takes issuer as a plain parameter) —
 * same discipline as 1E-a/1E-b's tests.
 *
 * Run: npx tsx scripts/src/test-oidc-discovery-metadata.ts
 */
import assert from "node:assert/strict";
import { buildOidcDiscoveryMetadata, resolveIssuer } from "../../artifacts/api-server/src/lib/oidc-discovery";

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ok — ${name}`);
  } catch (err) {
    console.error(`  FAIL — ${name}`);
    throw err;
  }
}

console.log("buildOidcDiscoveryMetadata()");

test("issuer is carried through as given (already clean)", () => {
  const meta = buildOidcDiscoveryMetadata("https://account.ayzen.tech");
  assert.equal(meta.issuer, "https://account.ayzen.tech");
});

test("trailing slash(es) on issuer are stripped", () => {
  const meta = buildOidcDiscoveryMetadata("https://account.ayzen.tech/");
  assert.equal(meta.issuer, "https://account.ayzen.tech");
  const meta2 = buildOidcDiscoveryMetadata("https://account.ayzen.tech///");
  assert.equal(meta2.issuer, "https://account.ayzen.tech");
});

test("jwks_uri is derived from issuer, not independently settable", () => {
  const meta = buildOidcDiscoveryMetadata("https://account.ayzen.tech");
  assert.equal(meta.jwks_uri, "https://account.ayzen.tech/.well-known/jwks.json");
});

test("jwks_uri stays correctly joined even when issuer had a trailing slash", () => {
  const meta = buildOidcDiscoveryMetadata("https://account.ayzen.tech/");
  assert.equal(meta.jwks_uri, "https://account.ayzen.tech/.well-known/jwks.json");
  assert.ok(!meta.jwks_uri.includes("//.well-known")); // no doubled slash
});

test("issuer and jwks_uri always share the same origin, for any issuer input", () => {
  for (const issuer of ["https://ayzen.tech", "http://localhost:8080", "https://staging.ayzen.replit.app/"]) {
    const meta = buildOidcDiscoveryMetadata(issuer);
    assert.ok(meta.jwks_uri.startsWith(meta.issuer + "/"));
  }
});

test("response_types_supported is exactly [\"code\"] — no implicit/hybrid", () => {
  const meta = buildOidcDiscoveryMetadata("https://ayzen.tech");
  assert.deepEqual(meta.response_types_supported, ["code"]);
});

test("scopes_supported is exactly [\"openid\"] at this phase", () => {
  const meta = buildOidcDiscoveryMetadata("https://ayzen.tech");
  assert.deepEqual(meta.scopes_supported, ["openid"]);
});

test("id_token_signing_alg_values_supported is exactly [\"RS256\"] — HS256 never advertised", () => {
  const meta = buildOidcDiscoveryMetadata("https://ayzen.tech");
  assert.deepEqual(meta.id_token_signing_alg_values_supported, ["RS256"]);
  assert.equal(meta.id_token_signing_alg_values_supported.includes("HS256" as any), false);
});

test("no endpoint fields for routes that don't exist yet (registration_endpoint)", () => {
  // UPDATE — Phase 10e: this assertion originally also named
  // authorization_endpoint/token_endpoint/userinfo_endpoint here, back
  // when 1E-d shipped and none of those three routes existed yet. Phase
  // 5a-e (see this file's own header) published all three once
  // routes/oidc-authorize.ts, routes/oidc-token.ts, and
  // routes/oidc-userinfo.ts existed — asserting their absence today would
  // be asserting something this document is now correctly wrong about,
  // not a real regression check. `registration_endpoint` is the one
  // "endpoint that doesn't exist yet" still true today: Phase 8a's
  // routes/oidc-register.ts exists, but no discovery-metadata phase has
  // picked up advertising it (a real, separate, still-open gap — not this
  // pass's own scope, see lib/oidc-discovery.ts's own header for why 10e
  // only ever named introspection_endpoint/revocation_endpoint).
  const meta = buildOidcDiscoveryMetadata("https://ayzen.tech");
  const asRecord = meta as unknown as Record<string, unknown>;
  assert.equal("registration_endpoint" in asRecord, false);
});

test("introspection_endpoint is derived from issuer (Phase 10e)", () => {
  const meta = buildOidcDiscoveryMetadata("https://account.ayzen.tech");
  assert.equal(meta.introspection_endpoint, "https://account.ayzen.tech/oidc/introspect");
});

test("revocation_endpoint is derived from issuer (Phase 10e)", () => {
  const meta = buildOidcDiscoveryMetadata("https://account.ayzen.tech");
  assert.equal(meta.revocation_endpoint, "https://account.ayzen.tech/oidc/revoke");
});

test("introspection_endpoint and revocation_endpoint stay correctly joined even when issuer had a trailing slash", () => {
  const meta = buildOidcDiscoveryMetadata("https://account.ayzen.tech/");
  assert.equal(meta.introspection_endpoint, "https://account.ayzen.tech/oidc/introspect");
  assert.equal(meta.revocation_endpoint, "https://account.ayzen.tech/oidc/revoke");
  assert.ok(!meta.introspection_endpoint.includes("//oidc"));
  assert.ok(!meta.revocation_endpoint.includes("//oidc"));
});

test("issuer, introspection_endpoint, and revocation_endpoint always share the same origin, for any issuer input", () => {
  for (const issuer of ["https://ayzen.tech", "http://localhost:8080", "https://staging.ayzen.replit.app/"]) {
    const meta = buildOidcDiscoveryMetadata(issuer);
    assert.ok(meta.introspection_endpoint.startsWith(meta.issuer + "/"));
    assert.ok(meta.revocation_endpoint.startsWith(meta.issuer + "/"));
  }
});

test("returned arrays are fresh copies, not shared mutable state across calls", () => {
  const a = buildOidcDiscoveryMetadata("https://ayzen.tech");
  const b = buildOidcDiscoveryMetadata("https://ayzen.tech");
  a.scopes_supported.push("mutated");
  assert.deepEqual(b.scopes_supported, ["openid"]); // b unaffected by a's mutation
});

console.log("resolveIssuer()");

test("AYZEN_OIDC_ISSUER, when set, wins over APP_URL", () => {
  const prevIssuer = process.env.AYZEN_OIDC_ISSUER;
  const prevAppUrl = process.env.APP_URL;
  process.env.AYZEN_OIDC_ISSUER = "https://explicit-issuer.ayzen.tech/";
  process.env.APP_URL = "https://should-be-ignored.example";
  try {
    assert.equal(resolveIssuer(), "https://explicit-issuer.ayzen.tech");
  } finally {
    if (prevIssuer === undefined) delete process.env.AYZEN_OIDC_ISSUER;
    else process.env.AYZEN_OIDC_ISSUER = prevIssuer;
    if (prevAppUrl === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = prevAppUrl;
  }
});

test("falls back to APP_URL when AYZEN_OIDC_ISSUER is unset", () => {
  const prevIssuer = process.env.AYZEN_OIDC_ISSUER;
  const prevAppUrl = process.env.APP_URL;
  delete process.env.AYZEN_OIDC_ISSUER;
  process.env.APP_URL = "https://app-url-fallback.example/";
  try {
    assert.equal(resolveIssuer(), "https://app-url-fallback.example");
  } finally {
    if (prevIssuer === undefined) delete process.env.AYZEN_OIDC_ISSUER;
    else process.env.AYZEN_OIDC_ISSUER = prevIssuer;
    if (prevAppUrl === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = prevAppUrl;
  }
});

test("falls back to the hardcoded default when neither env var is set", () => {
  const prevIssuer = process.env.AYZEN_OIDC_ISSUER;
  const prevAppUrl = process.env.APP_URL;
  delete process.env.AYZEN_OIDC_ISSUER;
  delete process.env.APP_URL;
  try {
    assert.equal(resolveIssuer(), "https://ayzen.replit.app");
  } finally {
    if (prevIssuer === undefined) delete process.env.AYZEN_OIDC_ISSUER;
    else process.env.AYZEN_OIDC_ISSUER = prevIssuer;
    if (prevAppUrl === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = prevAppUrl;
  }
});

test("blank/whitespace-only AYZEN_OIDC_ISSUER is treated as unset", () => {
  const prevIssuer = process.env.AYZEN_OIDC_ISSUER;
  const prevAppUrl = process.env.APP_URL;
  process.env.AYZEN_OIDC_ISSUER = "   ";
  process.env.APP_URL = "https://app-url-fallback-2.example";
  try {
    assert.equal(resolveIssuer(), "https://app-url-fallback-2.example");
  } finally {
    if (prevIssuer === undefined) delete process.env.AYZEN_OIDC_ISSUER;
    else process.env.AYZEN_OIDC_ISSUER = prevIssuer;
    if (prevAppUrl === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = prevAppUrl;
  }
});

console.log("All oidc-discovery.ts tests passed.");
