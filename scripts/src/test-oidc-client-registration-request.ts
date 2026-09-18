/**
 * scripts/src/test-oidc-client-registration-request.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 4, Phase 8a: Dynamic Client Registration — tests
 * for `artifacts/api-server/src/lib/oidc-client-registration-request.ts`'s
 * `validateOidcClientRegistrationRequest()`.
 *
 * Same shape as scripts/src/test-oidc-scope-validation.ts (2D-e): DB-free,
 * runnable anywhere with nothing but
 * `npx tsx scripts/src/test-oidc-client-registration-request.ts`. The
 * function under test does not import `@workspace/db` (only
 * `parseScopeString`/`KNOWN_OIDC_SCOPES` from the already-pure
 * `oidc-scope-validation.ts`), so every behavior it has is exercised
 * directly here — no DB-dependent gap to leave uncovered.
 *
 * Run: npx tsx scripts/src/test-oidc-client-registration-request.ts
 */
import assert from "node:assert/strict";
import {
  validateOidcClientRegistrationRequest,
  validateOidcClientRegistrationUpdateRequest,
  type OidcClientRegistrationValidationResult,
  type OidcClientRegistrationUpdateValidationResult,
} from "../../artifacts/api-server/src/lib/oidc-client-registration-request";

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ok — ${name}`);
  } catch (err) {
    console.error(`  FAIL — ${name}`);
    throw err;
  }
}

function assertOk(result: OidcClientRegistrationValidationResult, expected: { clientName: string; redirectUris: string[]; scopes: string[] }): void {
  assert.equal(result.ok, true);
  const ok = result as Extract<OidcClientRegistrationValidationResult, { ok: true }>;
  assert.equal(ok.clientName, expected.clientName);
  assert.deepEqual(ok.redirectUris, expected.redirectUris);
  assert.deepEqual(ok.scopes, expected.scopes);
}

function assertRejected(
  result: OidcClientRegistrationValidationResult,
  expectedError: "invalid_redirect_uri" | "invalid_client_metadata",
  expectedField: "client_name" | "redirect_uris" | "scope",
): void {
  assert.equal(result.ok, false);
  const failure = result as Extract<OidcClientRegistrationValidationResult, { ok: false }>;
  assert.equal(failure.error, expectedError);
  assert.equal(failure.field, expectedField);
}

console.log("validateOidcClientRegistrationRequest() — valid requests");

test("a well-formed request with all three fields", () => {
  const result = validateOidcClientRegistrationRequest({
    client_name: "Wisp",
    redirect_uris: ["https://wisp.ayzen.tech/oidc/callback"],
    scope: "openid profile email",
  });
  assertOk(result, { clientName: "Wisp", redirectUris: ["https://wisp.ayzen.tech/oidc/callback"], scopes: ["openid", "profile", "email"] });
});

test("client_name is trimmed", () => {
  const result = validateOidcClientRegistrationRequest({
    client_name: "  Verve  ",
    redirect_uris: ["https://verve.ayzen.tech/callback"],
  });
  assertOk(result, { clientName: "Verve", redirectUris: ["https://verve.ayzen.tech/callback"], scopes: [] });
});

test("scope is optional — omitted scope is a valid, empty scope request", () => {
  const result = validateOidcClientRegistrationRequest({
    client_name: "Zynth",
    redirect_uris: ["https://zynth.ayzen.tech/callback"],
  });
  assertOk(result, { clientName: "Zynth", redirectUris: ["https://zynth.ayzen.tech/callback"], scopes: [] });
});

test("multiple redirect_uris, duplicates de-duplicated", () => {
  const result = validateOidcClientRegistrationRequest({
    client_name: "Ryft",
    redirect_uris: ["https://ryft.ayzen.tech/a", "https://ryft.ayzen.tech/b", "https://ryft.ayzen.tech/a"],
  });
  assertOk(result, { clientName: "Ryft", redirectUris: ["https://ryft.ayzen.tech/a", "https://ryft.ayzen.tech/b"], scopes: [] });
});

test("http://localhost is accepted — 8d's dev exception, not an absence of policy", () => {
  // Phase 8d added a real https-only policy (see
  // lib/oidc-dynamic-client-redirect-uri-policy.ts) — this case still
  // passes under it because localhost is an explicit, deliberate carve-out
  // for local development, not because no policy exists at this layer
  // anymore. See the "Phase 8d — redirect_uri policy" block below for the
  // cases that policy DOES reject.
  const result = validateOidcClientRegistrationRequest({
    client_name: "LocalDevClient",
    redirect_uris: ["http://localhost:3000/callback"],
  });
  assertOk(result, { clientName: "LocalDevClient", redirectUris: ["http://localhost:3000/callback"], scopes: [] });
});

test("Phase 8b: is_first_party (and other unsupported fields) in the body are silently ignored, never honored", () => {
  // 8b's own roadmap text: "is_first_party = false ... hardcoded, request
  // body থেকে override করার কোনো উপায় নেই". This function never reads
  // `is_first_party`, `client_id`, or `client_secret` off the body at all
  // — proving that at the VALIDATION layer, on top of
  // `lib/oidc-client-registration.ts`'s own hardcoded `FALSE` at the
  // INSERT layer (defense in depth, not redundancy: this test would still
  // catch a regression even if someone "helpfully" added body-reading here
  // later).
  const result = validateOidcClientRegistrationRequest({
    client_name: "EvilCo",
    redirect_uris: ["https://evil.example/callback"],
    is_first_party: true,
    client_id: "sylo",
    client_secret: "attacker-chosen-secret",
    registration_status: "approved",
  });
  assertOk(result, { clientName: "EvilCo", redirectUris: ["https://evil.example/callback"], scopes: [] });
  // The success shape has exactly three fields — proving none of the
  // attacker-supplied extras leaked through into the validated result.
  assert.deepEqual(Object.keys(result).sort(), ["clientName", "ok", "redirectUris", "scopes"]);
});

console.log("validateOidcClientRegistrationRequest() — client_name failures");

test("missing client_name", () => {
  assertRejected(validateOidcClientRegistrationRequest({ redirect_uris: ["https://a.example/cb"] }), "invalid_client_metadata", "client_name");
});

test("empty/whitespace-only client_name", () => {
  assertRejected(validateOidcClientRegistrationRequest({ client_name: "   ", redirect_uris: ["https://a.example/cb"] }), "invalid_client_metadata", "client_name");
});

test("non-string client_name", () => {
  assertRejected(validateOidcClientRegistrationRequest({ client_name: 42, redirect_uris: ["https://a.example/cb"] }), "invalid_client_metadata", "client_name");
});

test("client_name over the length cap", () => {
  assertRejected(
    validateOidcClientRegistrationRequest({ client_name: "x".repeat(201), redirect_uris: ["https://a.example/cb"] }),
    "invalid_client_metadata",
    "client_name",
  );
});

console.log("validateOidcClientRegistrationRequest() — redirect_uris failures");

test("missing redirect_uris", () => {
  assertRejected(validateOidcClientRegistrationRequest({ client_name: "X" }), "invalid_redirect_uri", "redirect_uris");
});

test("empty redirect_uris array", () => {
  assertRejected(validateOidcClientRegistrationRequest({ client_name: "X", redirect_uris: [] }), "invalid_redirect_uri", "redirect_uris");
});

test("redirect_uris is not an array", () => {
  assertRejected(validateOidcClientRegistrationRequest({ client_name: "X", redirect_uris: "https://a.example/cb" }), "invalid_redirect_uri", "redirect_uris");
});

test("a malformed URL string among redirect_uris", () => {
  assertRejected(validateOidcClientRegistrationRequest({ client_name: "X", redirect_uris: ["not a url at all"] }), "invalid_redirect_uri", "redirect_uris");
});

test("a non-string entry among redirect_uris", () => {
  assertRejected(validateOidcClientRegistrationRequest({ client_name: "X", redirect_uris: ["https://a.example/cb", 123] }), "invalid_redirect_uri", "redirect_uris");
});

test("too many redirect_uris", () => {
  const uris = Array.from({ length: 11 }, (_, i) => `https://a.example/cb${i}`);
  assertRejected(validateOidcClientRegistrationRequest({ client_name: "X", redirect_uris: uris }), "invalid_redirect_uri", "redirect_uris");
});

console.log("validateOidcClientRegistrationRequest() — Phase 8d redirect_uri policy");

test("a non-localhost http:// redirect_uri is rejected", () => {
  assertRejected(
    validateOidcClientRegistrationRequest({ client_name: "X", redirect_uris: ["http://a.example/cb"] }),
    "invalid_redirect_uri",
    "redirect_uris",
  );
});

test("a wildcard in a redirect_uri is rejected", () => {
  assertRejected(
    validateOidcClientRegistrationRequest({ client_name: "X", redirect_uris: ["https://a.example/*"] }),
    "invalid_redirect_uri",
    "redirect_uris",
  );
});

test("a path-traversal segment in a redirect_uri is rejected", () => {
  assertRejected(
    validateOidcClientRegistrationRequest({ client_name: "X", redirect_uris: ["https://a.example/../cb"] }),
    "invalid_redirect_uri",
    "redirect_uris",
  );
});

test("a fragment in a redirect_uri is rejected", () => {
  assertRejected(
    validateOidcClientRegistrationRequest({ client_name: "X", redirect_uris: ["https://a.example/cb#token"] }),
    "invalid_redirect_uri",
    "redirect_uris",
  );
});

test("one policy-violating entry rejects the whole request, even alongside an otherwise-fine one", () => {
  assertRejected(
    validateOidcClientRegistrationRequest({
      client_name: "X",
      redirect_uris: ["https://a.example/cb", "http://a.example/cb"],
    }),
    "invalid_redirect_uri",
    "redirect_uris",
  );
});

console.log("validateOidcClientRegistrationRequest() — scope failures");

test("an unknown scope is rejected", () => {
  assertRejected(
    validateOidcClientRegistrationRequest({ client_name: "X", redirect_uris: ["https://a.example/cb"], scope: "openid wallet" }),
    "invalid_client_metadata",
    "scope",
  );
});

test("non-string scope", () => {
  assertRejected(
    validateOidcClientRegistrationRequest({ client_name: "X", redirect_uris: ["https://a.example/cb"], scope: 7 }),
    "invalid_client_metadata",
    "scope",
  );
});

console.log("validateOidcClientRegistrationRequest() — field-check order");

test("client_name is checked before redirect_uris", () => {
  assertRejected(validateOidcClientRegistrationRequest({}), "invalid_client_metadata", "client_name");
});

test("redirect_uris is checked before scope", () => {
  assertRejected(
    validateOidcClientRegistrationRequest({ client_name: "X", scope: "wallet" }),
    "invalid_redirect_uri",
    "redirect_uris",
  );
});

console.log("All oidc-client-registration-request tests passed.");

// ─────────────────────────────────────────────────────────────────────────────
// OIDC Roadmap — Season 4, Phase 8e: tests for
// validateOidcClientRegistrationUpdateRequest() (`PUT /oidc/register/:client_id`).

function assertUpdateOk(
  result: OidcClientRegistrationUpdateValidationResult,
  expected: { clientName?: string; redirectUris?: string[] },
): void {
  assert.equal(result.ok, true);
  const ok = result as Extract<OidcClientRegistrationUpdateValidationResult, { ok: true }>;
  assert.deepEqual(ok.clientName, expected.clientName);
  assert.deepEqual(ok.redirectUris, expected.redirectUris);
}

function assertUpdateRejected(
  result: OidcClientRegistrationUpdateValidationResult,
  expectedError: "invalid_redirect_uri" | "invalid_client_metadata",
  expectedField: "client_name" | "redirect_uris",
): void {
  assert.equal(result.ok, false);
  const failure = result as Extract<OidcClientRegistrationUpdateValidationResult, { ok: false }>;
  assert.equal(failure.error, expectedError);
  assert.equal(failure.field, expectedField);
}

console.log("validateOidcClientRegistrationUpdateRequest() — valid requests");

test("client_name only — a partial update", () => {
  assertUpdateOk(validateOidcClientRegistrationUpdateRequest({ client_name: "Renamed" }), { clientName: "Renamed" });
});

test("redirect_uris only — a partial update", () => {
  assertUpdateOk(validateOidcClientRegistrationUpdateRequest({ redirect_uris: ["https://a.example/cb"] }), {
    redirectUris: ["https://a.example/cb"],
  });
});

test("both client_name and redirect_uris together", () => {
  assertUpdateOk(
    validateOidcClientRegistrationUpdateRequest({ client_name: "Renamed", redirect_uris: ["https://a.example/cb"] }),
    { clientName: "Renamed", redirectUris: ["https://a.example/cb"] },
  );
});

test("client_name is trimmed, same as at registration time", () => {
  assertUpdateOk(validateOidcClientRegistrationUpdateRequest({ client_name: "  Renamed  " }), { clientName: "Renamed" });
});

test("scope in the body is silently ignored — this token can never request a scope change", () => {
  const result = validateOidcClientRegistrationUpdateRequest({ client_name: "Renamed", scope: "openid profile email wallet" });
  assertUpdateOk(result, { clientName: "Renamed" });
  assert.deepEqual(Object.keys(result).sort(), ["clientName", "ok"]);
});

console.log("validateOidcClientRegistrationUpdateRequest() — failures");

test("neither client_name nor redirect_uris present — nothing to update", () => {
  assertUpdateRejected(validateOidcClientRegistrationUpdateRequest({}), "invalid_client_metadata", "client_name");
});

test("neither field present, only an unsupported field (e.g. scope alone)", () => {
  assertUpdateRejected(
    validateOidcClientRegistrationUpdateRequest({ scope: "openid" }),
    "invalid_client_metadata",
    "client_name",
  );
});

test("empty/whitespace-only client_name", () => {
  assertUpdateRejected(validateOidcClientRegistrationUpdateRequest({ client_name: "   " }), "invalid_client_metadata", "client_name");
});

test("empty redirect_uris array", () => {
  assertUpdateRejected(validateOidcClientRegistrationUpdateRequest({ redirect_uris: [] }), "invalid_redirect_uri", "redirect_uris");
});

test("a malformed URL among redirect_uris", () => {
  assertUpdateRejected(
    validateOidcClientRegistrationUpdateRequest({ redirect_uris: ["not a url"] }),
    "invalid_redirect_uri",
    "redirect_uris",
  );
});

test("Phase 8d's policy applies here too — a wildcard redirect_uri is rejected", () => {
  assertUpdateRejected(
    validateOidcClientRegistrationUpdateRequest({ redirect_uris: ["https://a.example/*"] }),
    "invalid_redirect_uri",
    "redirect_uris",
  );
});

test("Phase 8d's policy applies here too — a non-localhost http:// redirect_uri is rejected", () => {
  assertUpdateRejected(
    validateOidcClientRegistrationUpdateRequest({ redirect_uris: ["http://a.example/cb"] }),
    "invalid_redirect_uri",
    "redirect_uris",
  );
});

test("a valid redirect_uris update alongside an invalid client_name still fails on client_name (checked first)", () => {
  assertUpdateRejected(
    validateOidcClientRegistrationUpdateRequest({ client_name: "", redirect_uris: ["https://a.example/cb"] }),
    "invalid_client_metadata",
    "client_name",
  );
});

console.log("All oidc-client-registration-update-request tests passed.");
