/**
 * scripts/src/test-oidc-client-admin-request.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 5, Phase 9b (admin client detail/edit) + Phase 9c
 * (admin client create/delete) — tests for
 * `artifacts/api-server/src/lib/oidc-client-admin-request.ts`'s
 * `validateOidcAdminClientUpdateRequest()` / `validateOidcAdminClientCreateRequest()`.
 *
 * Same shape as scripts/src/test-oidc-client-registration-request.ts (8a/8e):
 * DB-free, runnable anywhere with nothing but
 * `npx tsx scripts/src/test-oidc-client-admin-request.ts`. The functions
 * under test import only `KNOWN_OIDC_SCOPES` from the already-pure
 * `oidc-scope-validation.ts` — no `@workspace/db` — so every behavior they
 * have is exercised directly here.
 *
 * Deliberately includes a case proving 9b/9c do NOT apply Phase 8d's
 * dynamic-client redirect-uri policy (non-https, non-localhost accepted) —
 * see `lib/oidc-client-admin-request.ts`'s own header, "WHY NOT REUSE
 * 8a/8d's VALIDATION," for why that is correct here, not a gap.
 *
 * Run: npx tsx scripts/src/test-oidc-client-admin-request.ts
 */
import assert from "node:assert/strict";
import {
  validateOidcAdminClientUpdateRequest,
  validateOidcAdminClientCreateRequest,
  type OidcAdminClientUpdateValidationResult,
  type OidcAdminClientCreateValidationResult,
} from "../../artifacts/api-server/src/lib/oidc-client-admin-request";

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ok — ${name}`);
  } catch (err) {
    console.error(`  FAIL — ${name}`);
    throw err;
  }
}

function assertUpdateOk(
  result: OidcAdminClientUpdateValidationResult,
  expected: { redirectUris?: string[]; allowedScopes?: string[]; backchannelLogoutUri?: string | null },
): void {
  assert.equal(result.ok, true);
  const ok = result as Extract<OidcAdminClientUpdateValidationResult, { ok: true }>;
  assert.deepEqual(ok.updates, expected);
}

function assertUpdateRejected(
  result: OidcAdminClientUpdateValidationResult,
  expectedField: "redirectUris" | "allowedScopes" | "backchannelLogoutUri" | "none",
): void {
  assert.equal(result.ok, false);
  const failure = result as Extract<OidcAdminClientUpdateValidationResult, { ok: false }>;
  assert.equal(failure.error, "invalid_request");
  assert.equal(failure.field, expectedField);
}

console.log("validateOidcAdminClientUpdateRequest() — 9b");

test("updates just redirectUris", () => {
  assertUpdateOk(
    validateOidcAdminClientUpdateRequest({ redirectUris: ["https://ryft.ayzen.tech/oidc/callback"] }),
    { redirectUris: ["https://ryft.ayzen.tech/oidc/callback"] },
  );
});

test("a non-https redirect_uri is ACCEPTED here — 8d's dynamic-client policy does not apply to first-party admin edits", () => {
  assertUpdateOk(validateOidcAdminClientUpdateRequest({ redirectUris: ["http://internal.example/cb"] }), {
    redirectUris: ["http://internal.example/cb"],
  });
});

test("updates just allowedScopes, deduplicated", () => {
  assertUpdateOk(validateOidcAdminClientUpdateRequest({ allowedScopes: ["openid", "profile", "openid"] }), {
    allowedScopes: ["openid", "profile"],
  });
});

test("allowedScopes may be an empty array (revoking every scope is a legitimate, if unusual, admin action)", () => {
  assertUpdateOk(validateOidcAdminClientUpdateRequest({ allowedScopes: [] }), { allowedScopes: [] });
});

test("updates just backchannelLogoutUri to a real URL", () => {
  assertUpdateOk(
    validateOidcAdminClientUpdateRequest({ backchannelLogoutUri: "https://ryft.ayzen.tech/oidc/backchannel-logout" }),
    { backchannelLogoutUri: "https://ryft.ayzen.tech/oidc/backchannel-logout" },
  );
});

test("explicit null backchannelLogoutUri clears it (distinguishable from 'field absent')", () => {
  assertUpdateOk(validateOidcAdminClientUpdateRequest({ backchannelLogoutUri: null }), {
    backchannelLogoutUri: null,
  });
});

test("multiple fields at once", () => {
  assertUpdateOk(
    validateOidcAdminClientUpdateRequest({
      redirectUris: ["https://ryft.ayzen.tech/oidc/callback"],
      allowedScopes: ["openid"],
    }),
    { redirectUris: ["https://ryft.ayzen.tech/oidc/callback"], allowedScopes: ["openid"] },
  );
});

test("an empty body (no editable field named) is rejected", () => {
  assertUpdateRejected(validateOidcAdminClientUpdateRequest({}), "none");
});

test("clientName is never read — it is not an editable field for 9b, unlike redirect_uris/allowed_scopes/backchannel_logout_uri", () => {
  // clientName alone, with no 9b-recognized field present, is exactly the
  // same as an empty body from this validator's point of view.
  assertUpdateRejected(validateOidcAdminClientUpdateRequest({ clientName: "New Name" }), "none");
});

test("redirectUris must be a non-empty array", () => {
  assertUpdateRejected(validateOidcAdminClientUpdateRequest({ redirectUris: [] }), "redirectUris");
});

test("redirectUris rejects a malformed URL", () => {
  assertUpdateRejected(validateOidcAdminClientUpdateRequest({ redirectUris: ["not-a-url"] }), "redirectUris");
});

test("allowedScopes rejects an unknown scope", () => {
  assertUpdateRejected(validateOidcAdminClientUpdateRequest({ allowedScopes: ["openid", "wallet"] }), "allowedScopes");
});

test("allowedScopes rejects a non-array", () => {
  assertUpdateRejected(validateOidcAdminClientUpdateRequest({ allowedScopes: "openid" }), "allowedScopes");
});

test("backchannelLogoutUri rejects a malformed URL", () => {
  assertUpdateRejected(validateOidcAdminClientUpdateRequest({ backchannelLogoutUri: "not-a-url" }), "backchannelLogoutUri");
});

test("backchannelLogoutUri rejects an empty string (use null to clear, not '')", () => {
  assertUpdateRejected(validateOidcAdminClientUpdateRequest({ backchannelLogoutUri: "" }), "backchannelLogoutUri");
});

console.log("All validateOidcAdminClientUpdateRequest tests passed.");

function assertCreateOk(
  result: OidcAdminClientCreateValidationResult,
  expected: {
    clientId: string;
    clientName: string;
    redirectUris: string[];
    postLogoutRedirectUris: string[];
    allowedScopes: string[];
    backchannelLogoutUri: string | null;
  },
): void {
  assert.equal(result.ok, true);
  const ok = result as Extract<OidcAdminClientCreateValidationResult, { ok: true }>;
  assert.equal(ok.clientId, expected.clientId);
  assert.equal(ok.clientName, expected.clientName);
  assert.deepEqual(ok.redirectUris, expected.redirectUris);
  assert.deepEqual(ok.postLogoutRedirectUris, expected.postLogoutRedirectUris);
  assert.deepEqual(ok.allowedScopes, expected.allowedScopes);
  assert.equal(ok.backchannelLogoutUri, expected.backchannelLogoutUri);
}

function assertCreateRejected(
  result: OidcAdminClientCreateValidationResult,
  expectedField:
    | "clientId"
    | "clientName"
    | "redirectUris"
    | "postLogoutRedirectUris"
    | "allowedScopes"
    | "backchannelLogoutUri",
): void {
  assert.equal(result.ok, false);
  const failure = result as Extract<OidcAdminClientCreateValidationResult, { ok: false }>;
  assert.equal(failure.error, "invalid_request");
  assert.equal(failure.field, expectedField);
}

console.log("validateOidcAdminClientCreateRequest() — 9c");

test("a well-formed create request with every field", () => {
  assertCreateOk(
    validateOidcAdminClientCreateRequest({
      clientId: "ryft",
      clientName: "Ryft",
      redirectUris: ["https://ryft.ayzen.tech/oidc/callback"],
      postLogoutRedirectUris: ["https://ryft.ayzen.tech/"],
      allowedScopes: ["openid", "profile", "email"],
      backchannelLogoutUri: "https://ryft.ayzen.tech/oidc/backchannel-logout",
    }),
    {
      clientId: "ryft",
      clientName: "Ryft",
      redirectUris: ["https://ryft.ayzen.tech/oidc/callback"],
      postLogoutRedirectUris: ["https://ryft.ayzen.tech/"],
      allowedScopes: ["openid", "profile", "email"],
      backchannelLogoutUri: "https://ryft.ayzen.tech/oidc/backchannel-logout",
    },
  );
});

test("allowedScopes/backchannelLogoutUri/postLogoutRedirectUris are all optional, defaulting to []/null/[]", () => {
  assertCreateOk(
    validateOidcAdminClientCreateRequest({
      clientId: "ryft-staging",
      clientName: "Ryft (staging)",
      redirectUris: ["http://localhost:3000/oidc/callback"],
    }),
    {
      clientId: "ryft-staging",
      clientName: "Ryft (staging)",
      redirectUris: ["http://localhost:3000/oidc/callback"],
      postLogoutRedirectUris: [],
      allowedScopes: [],
      backchannelLogoutUri: null,
    },
  );
});

test("isFirstParty / registrationStatus in the body are silently ignored, never read into the result", () => {
  const result = validateOidcAdminClientCreateRequest({
    clientId: "ryft",
    clientName: "Ryft",
    redirectUris: ["https://ryft.ayzen.tech/oidc/callback"],
    isFirstParty: false,
    registrationStatus: "pending",
  });
  assert.equal(result.ok, true);
  assert.ok(!("isFirstParty" in result));
  assert.ok(!("registrationStatus" in result));
});

test("clientId must match the slug pattern (rejects uppercase)", () => {
  assertCreateRejected(
    validateOidcAdminClientCreateRequest({
      clientId: "Ryft",
      clientName: "Ryft",
      redirectUris: ["https://ryft.ayzen.tech/oidc/callback"],
    }),
    "clientId",
  );
});

test("clientId rejects a leading hyphen", () => {
  assertCreateRejected(
    validateOidcAdminClientCreateRequest({
      clientId: "-ryft",
      clientName: "Ryft",
      redirectUris: ["https://ryft.ayzen.tech/oidc/callback"],
    }),
    "clientId",
  );
});

test("clientId rejects a trailing hyphen", () => {
  assertCreateRejected(
    validateOidcAdminClientCreateRequest({
      clientId: "ryft-",
      clientName: "Ryft",
      redirectUris: ["https://ryft.ayzen.tech/oidc/callback"],
    }),
    "clientId",
  );
});

test("a single-character clientId is accepted", () => {
  assertCreateOk(
    validateOidcAdminClientCreateRequest({
      clientId: "r",
      clientName: "R",
      redirectUris: ["https://r.ayzen.tech/oidc/callback"],
    }),
    {
      clientId: "r",
      clientName: "R",
      redirectUris: ["https://r.ayzen.tech/oidc/callback"],
      postLogoutRedirectUris: [],
      allowedScopes: [],
      backchannelLogoutUri: null,
    },
  );
});

test("clientName is required", () => {
  assertCreateRejected(
    validateOidcAdminClientCreateRequest({ clientId: "ryft", redirectUris: ["https://ryft.ayzen.tech/oidc/callback"] }),
    "clientName",
  );
});

test("redirectUris is required and must be non-empty", () => {
  assertCreateRejected(
    validateOidcAdminClientCreateRequest({ clientId: "ryft", clientName: "Ryft", redirectUris: [] }),
    "redirectUris",
  );
});

test("postLogoutRedirectUris rejects a malformed entry", () => {
  assertCreateRejected(
    validateOidcAdminClientCreateRequest({
      clientId: "ryft",
      clientName: "Ryft",
      redirectUris: ["https://ryft.ayzen.tech/oidc/callback"],
      postLogoutRedirectUris: ["not-a-url"],
    }),
    "postLogoutRedirectUris",
  );
});

test("allowedScopes rejects an unknown scope", () => {
  assertCreateRejected(
    validateOidcAdminClientCreateRequest({
      clientId: "ryft",
      clientName: "Ryft",
      redirectUris: ["https://ryft.ayzen.tech/oidc/callback"],
      allowedScopes: ["openid", "wallet"],
    }),
    "allowedScopes",
  );
});

test("backchannelLogoutUri rejects a malformed URL", () => {
  assertCreateRejected(
    validateOidcAdminClientCreateRequest({
      clientId: "ryft",
      clientName: "Ryft",
      redirectUris: ["https://ryft.ayzen.tech/oidc/callback"],
      backchannelLogoutUri: "not-a-url",
    }),
    "backchannelLogoutUri",
  );
});

test("field-check order: clientId is checked before clientName even when both are invalid", () => {
  assertCreateRejected(
    validateOidcAdminClientCreateRequest({
      clientId: "Ryft!",
      clientName: "",
      redirectUris: ["https://ryft.ayzen.tech/oidc/callback"],
    }),
    "clientId",
  );
});

console.log("All validateOidcAdminClientCreateRequest tests passed.");
