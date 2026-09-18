/**
 * scripts/src/test-oidc-clients.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 1, Phase 2A-d: schema tests for the `oidc_clients`
 * table introduced in 2A-a/2A-b (migration 079) and its data-access layer
 * from 2A-c (artifacts/api-server/src/lib/oidc-clients.ts).
 *
 * Same shape as scripts/src/test-verification-keys.ts (1D-a) and
 * test-rotate-jwt-signing-key.ts (1D-d) — exercises ONLY DB-free pure
 * functions, runnable anywhere with nothing but
 * `npx tsx scripts/src/test-oidc-clients.ts`.
 *
 * Covers the roadmap's 2A-d test list to the extent it's DB-free-testable:
 *   - "valid client"           → mapOidcClientRow() on a well-formed row;
 *                                 insertOidcClientSchema on a valid payload.
 *   - "missing required data"  → insertOidcClientSchema rejects a payload
 *                                 missing `clientId`.
 *   - "malformed registry data"→ mapOidcClientRow()/toStringArray() on
 *                                 non-array and mixed-type JSONB;
 *                                 insertOidcClientSchema rejects
 *                                 non-string-array redirect_uris/scopes.
 *
 * NOT covered here — "duplicate client_id":
 *   That is a live database behavior (the `oidc_clients_client_id_idx`
 *   UNIQUE index from migration 079 rejecting a second INSERT with the same
 *   `client_id`), not a pure function. It cannot be exercised without a
 *   DATABASE_URL, same limitation noted for the DB-dependent paths in
 *   CHANGES_JWT_MULTIKEY_PHASE1C.md. The constraint itself is hand-verified
 *   below by re-reading migration 079's DDL rather than executed:
 *     CREATE UNIQUE INDEX IF NOT EXISTS oidc_clients_client_id_idx
 *       ON oidc_clients(client_id);
 *   — a second INSERT with an existing client_id will raise Postgres error
 *   23505 (unique_violation), same failure mode jwt_signing_keys' analogous
 *   `kid` unique index produces.
 *
 * Run: npx tsx scripts/src/test-oidc-clients.ts
 */
import assert from "node:assert/strict";
import {
  mapOidcClientRow,
  toStringArray,
  type OidcClientDbRow,
} from "../../artifacts/api-server/src/lib/oidc-clients";
import { insertOidcClientSchema } from "../../lib/db/src/schema/oidc-clients";

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ok — ${name}`);
  } catch (err) {
    console.error(`  FAIL — ${name}`);
    throw err;
  }
}

const baseRow: OidcClientDbRow = {
  id: 1,
  client_id: "sylo",
  client_secret_hash: "hashed-secret",
  // Phase 8a (migration 090): first-party clients seeded before this
  // column existed keep `client_name IS NULL` — see that migration's own
  // header for why there's no backfill. `sylo` here stands in for exactly
  // that pre-8a row shape.
  client_name: null,
  // Phase 8c (migration 091): every pre-existing row is backfilled to
  // `'approved'` by that migration — `sylo` (a Season 1-3 first-party
  // client, already live long before 8c existed) is exactly that case.
  registration_status: "approved",
  redirect_uris: ["https://sylo.ayzen.tech/callback"],
  post_logout_redirect_uris: ["https://sylo.ayzen.tech/"],
  backchannel_logout_uri: "https://sylo.ayzen.tech/oidc/backchannel-logout",
  allowed_scopes: ["openid", "profile"],
  is_first_party: true,
  // Phase 8e (migration 092): every pre-existing row (sylo included) has
  // no self-management token and never will — see that migration's own
  // header for why NULL, not a backfilled value, is correct here.
  registration_access_token_hash: null,
  created_at: new Date("2026-01-01T00:00:00Z"),
  updated_at: new Date("2026-01-01T00:00:00Z"),
};

console.log("mapOidcClientRow() / toStringArray()");

test("valid client — well-formed row maps straight through", () => {
  const client = mapOidcClientRow(baseRow);
  assert.deepEqual(client, {
    id: 1,
    clientId: "sylo",
    clientSecretHash: "hashed-secret",
    clientName: null,
    registrationStatus: "approved",
    redirectUris: ["https://sylo.ayzen.tech/callback"],
    postLogoutRedirectUris: ["https://sylo.ayzen.tech/"],
    backchannelLogoutUri: "https://sylo.ayzen.tech/oidc/backchannel-logout",
    allowedScopes: ["openid", "profile"],
    isFirstParty: true,
    registrationAccessTokenHash: null,
    createdAt: baseRow.created_at,
    updatedAt: baseRow.updated_at,
  });
});

test("Phase 8e: a non-null registration_access_token_hash maps straight through", () => {
  const client = mapOidcClientRow({ ...baseRow, registration_access_token_hash: "hashed-reg-token" });
  assert.equal(client.registrationAccessTokenHash, "hashed-reg-token");
});

test("Phase 8a: a dynamically-registered client's real client_name maps straight through", () => {
  const client = mapOidcClientRow({ ...baseRow, client_name: "Wisp" });
  assert.equal(client.clientName, "Wisp");
});

test("Phase 8c: 'pending' and 'suspended' registration_status map straight through", () => {
  assert.equal(mapOidcClientRow({ ...baseRow, registration_status: "pending" }).registrationStatus, "pending");
  assert.equal(mapOidcClientRow({ ...baseRow, registration_status: "suspended" }).registrationStatus, "suspended");
});

test("Phase 8c: an unrecognized registration_status value fails closed to 'suspended', never throws", () => {
  // Should never happen in practice — migration 091's own CHECK constraint
  // enforces the three-value vocabulary at the DB layer — but this proves
  // the defensive fallback (fail-closed, not fail-open) actually works.
  const client = mapOidcClientRow({ ...baseRow, registration_status: "not-a-real-status" });
  assert.equal(client.registrationStatus, "suspended");
});

test("valid client — public (PKCE-only) client with a null secret hash maps cleanly", () => {
  const client = mapOidcClientRow({ ...baseRow, client_secret_hash: null });
  assert.equal(client.clientSecretHash, null);
});

test("malformed registry data — non-array JSONB (e.g. a stray object) becomes []", () => {
  const client = mapOidcClientRow({
    ...baseRow,
    redirect_uris: { not: "an array" } as unknown,
    post_logout_redirect_uris: { not: "an array" } as unknown,
    allowed_scopes: null as unknown,
  });
  assert.deepEqual(client.redirectUris, []);
  assert.deepEqual(client.postLogoutRedirectUris, []);
  assert.deepEqual(client.allowedScopes, []);
});

test("Season 3, Phase 6a-d: post_logout_redirect_uris maps independently from redirect_uris — well-formed row keeps both lists distinct", () => {
  const client = mapOidcClientRow(baseRow);
  assert.deepEqual(client.postLogoutRedirectUris, ["https://sylo.ayzen.tech/"]);
  assert.notDeepEqual(client.postLogoutRedirectUris, client.redirectUris);
});

test("malformed registry data — mixed-type array keeps only string entries", () => {
  const result = toStringArray(["openid", 42, null, "profile", { scope: "email" }]);
  assert.deepEqual(result, ["openid", "profile"]);
});

test("malformed registry data — toStringArray() on a plain scalar returns []", () => {
  assert.deepEqual(toStringArray("openid"), []);
  assert.deepEqual(toStringArray(undefined), []);
});

console.log("insertOidcClientSchema");

test("valid client — full first-party payload with a secret hash parses", () => {
  const parsed = insertOidcClientSchema.parse({
    clientId: "sylo",
    clientSecretHash: "hashed-secret",
    redirectUris: ["https://sylo.ayzen.tech/callback"],
    allowedScopes: ["openid", "profile"],
    isFirstParty: true,
  });
  assert.equal(parsed.clientId, "sylo");
});

test("valid client — public client with no secret hash parses (nullable column)", () => {
  const parsed = insertOidcClientSchema.parse({
    clientId: "ryft",
    clientSecretHash: null,
    redirectUris: ["https://ryft.ayzen.tech/callback"],
    allowedScopes: ["openid"],
    isFirstParty: true,
  });
  assert.equal(parsed.clientSecretHash, null);
});

test("missing required data — payload without clientId is rejected", () => {
  assert.throws(() => {
    insertOidcClientSchema.parse({
      redirectUris: ["https://sylo.ayzen.tech/callback"],
      allowedScopes: ["openid"],
      isFirstParty: true,
    });
  });
});

test("malformed registry data — redirectUris with a non-string element is rejected", () => {
  assert.throws(() => {
    insertOidcClientSchema.parse({
      clientId: "sylo",
      redirectUris: ["https://sylo.ayzen.tech/callback", 12345],
      allowedScopes: ["openid"],
      isFirstParty: true,
    });
  });
});

test("malformed registry data — allowedScopes as a non-array is rejected", () => {
  assert.throws(() => {
    insertOidcClientSchema.parse({
      clientId: "sylo",
      redirectUris: ["https://sylo.ayzen.tech/callback"],
      allowedScopes: "openid profile",
      isFirstParty: true,
    });
  });
});

console.log("All oidc_clients schema tests passed.");
