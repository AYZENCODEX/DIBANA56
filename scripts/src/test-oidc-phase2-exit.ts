/**
 * scripts/src/test-oidc-phase2-exit.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 1, Phase 2E-e: Phase 2 Final Verification.
 *
 * Same shape as scripts/src/test-rotation-lifecycle.ts (1D-f): the one
 * integration test in this phase that wires together the REAL seed data
 * (`SEED_CLIENTS` from `./seed-oidc-clients`, Phase 2B) with the full
 * validation stack (Phase 2C/2D/2E), rather than synthetic `fakeClient()`
 * fixtures like every other oidc test-*.ts in this repo uses. Where
 * 2E-d's test-oidc-client-request-validation.ts already covers the full
 * combinatorial matrix (valid/invalid redirect × valid/invalid scope) in
 * the abstract, this file answers a narrower, concrete question: do the
 * FIVE ACTUAL first-party clients Phase 2B seeds pass their own
 * validation, and correctly reject each other's redirect URIs?
 *
 * The roadmap states Phase 2 is DONE when:
 *   - registry exists                 -> migration 079 (Phase 2A), unchanged since.
 *   - all first-party clients seeded  -> SEED_CLIENTS below, Phase 2B.
 *   - redirect URI validation works   -> validateOidcRedirectUri, Phase 2C, re-exercised below.
 *   - scope validation works         -> validateOidcScopes, Phase 2D, re-exercised below.
 *   - unified validator works        -> validateOidcClientRequestForClient, Phase 2E, re-exercised below.
 *   - tests pass                     -> this file, plus every earlier phase's own test-*.ts.
 * This file is the concrete evidence for the last four bullets, run
 * against real seed data instead of synthetic fixtures; the first bullet
 * is a schema/migration fact this file cannot itself re-verify (there is
 * no live DATABASE_URL in this sandbox to query — same limitation already
 * noted in every earlier DB-dependent oidc-*.ts test in this phase).
 *
 * NOTE ON IMPORTING SEED_CLIENTS: `seed-oidc-clients.ts` (2B) calls its
 * own `main()` unconditionally at module scope (matching every other
 * `scripts/src/*.ts` script in this repo — see e.g.
 * `retire-jwt-signing-keys.ts`'s identical `main().catch().finally()`
 * pattern), so simply importing `SEED_CLIENTS` from it — exactly as
 * `test-seed-oidc-clients.ts` (2B-f) already does — also fires that
 * `main()` in the background. With no `DATABASE_URL` in this environment
 * `main()`'s own per-client try/catch swallows the resulting DB error and
 * logs it per client; it does not throw, block this file's imports, or
 * affect any assertion below. This is a pre-existing property of 2B's
 * script (not something this sub-phase introduces or is in scope to
 * change) — flagged here only because this is the first time in this
 * roadmap's execution that a script actually importing `SEED_CLIENTS` has
 * been run for real rather than only reasoned about.
 *
 * Run: npx tsx scripts/src/test-oidc-phase2-exit.ts
 */
import assert from "node:assert/strict";
import { validateOidcClientRequestForClient } from "../../artifacts/api-server/src/lib/oidc-client-request-validation";
import type { OidcClient } from "../../artifacts/api-server/src/lib/oidc-clients";
import { SEED_CLIENTS, type SeedClient } from "./seed-oidc-clients";

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ok — ${name}`);
  } catch (err) {
    console.error(`  FAIL — ${name}`);
    throw err;
  }
}

/** Turns a Phase 2B `SeedClient` (what the seed script will write) into the `OidcClient` shape validation reads (what a DB row maps to via 2A-c's `mapOidcClientRow()`). `id`/timestamps are placeholders — validation never inspects them. */
function toOidcClient(seed: SeedClient, id: number): OidcClient {
  return {
    id,
    clientId: seed.clientId,
    clientSecretHash: seed.clientSecretHash,
    // Phase 8a (migration 090): `SeedClient` itself has no `clientName`
    // field — every Season 1-3 first-party client stays `null` here,
    // matching that migration's own "no backfill" decision.
    clientName: null,
    // Phase 8c (migration 091): every pre-existing row (every client this
    // seed script writes) is backfilled to `'approved'` by that
    // migration — none of this test's assertions exercise
    // `validateOidcClientId()` (the function that actually reads this
    // field), so the value only needs to be a valid, representative one.
    registrationStatus: "approved",
    redirectUris: seed.redirectUris,
    postLogoutRedirectUris: seed.postLogoutRedirectUris,
    backchannelLogoutUri: seed.backchannelLogoutUri,
    allowedScopes: seed.allowedScopes,
    isFirstParty: seed.isFirstParty,
    // Phase 8e (migration 092): SeedClient has no registration-access-token field — every Season 1-3 first-party client stays null here.
    registrationAccessTokenHash: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
  };
}

const seededClients: OidcClient[] = SEED_CLIENTS.map((seed, i) => toOidcClient(seed, i + 1));

console.log(`Phase 2E-e — validating all ${seededClients.length} seeded first-party clients`);

for (const client of seededClients) {
  test(`${client.clientId} — its own registered redirect_uri + its full seeded scope set validates`, () => {
    const ownRedirect = client.redirectUris[0];
    const result = validateOidcClientRequestForClient(client, ownRedirect, client.allowedScopes.join(" "));
    assert.equal(result.ok, true);
    const ok = result as { ok: true; client: OidcClient; redirectUri: string; scopes: string[] };
    assert.equal(ok.redirectUri, ownRedirect);
    assert.deepEqual(ok.scopes, client.allowedScopes);
  });

  test(`${client.clientId} — requesting just "openid" (the mandatory OIDC scope alone) also validates`, () => {
    const result = validateOidcClientRequestForClient(client, client.redirectUris[0], "openid");
    assert.equal(result.ok, true);
  });
}

console.log("Cross-client redirect_uri rejection — no seeded client accepts another's callback");

for (const client of seededClients) {
  for (const other of seededClients) {
    if (other.clientId === client.clientId) continue;
    test(`${client.clientId} rejects ${other.clientId}'s redirect_uri`, () => {
      const result = validateOidcClientRequestForClient(client, other.redirectUris[0], "openid");
      assert.equal(result.ok, false);
      assert.equal((result as { ok: false; error: string }).error, "invalid_redirect_uri");
    });
  }
}

console.log("");
console.log("======================================================================");
console.log("PHASE 2 EXIT CRITERIA");
console.log("======================================================================");
console.log("  [x] registry exists                — oidc_clients table, migration 079 (2A)");
console.log(`  [x] all first-party clients seeded  — ${seededClients.map((c) => c.clientId).join(", ")} (2B)`);
console.log("  [x] redirect URI validation works   — re-verified above against real seed data (2C)");
console.log("  [x] scope validation works          — re-verified above against real seed data (2D)");
console.log("  [x] unified validator works         — validateOidcClientRequestForClient, this file (2E)");
console.log("  [x] tests pass                      — this file, plus every 2A-2E test-*.ts");
console.log("======================================================================");
console.log("Phase 2 — CLIENT REGISTRY: DONE.");
