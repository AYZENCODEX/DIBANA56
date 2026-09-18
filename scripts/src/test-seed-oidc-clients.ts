/**
 * scripts/src/test-seed-oidc-clients.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 1, Phase 2B-f: Seed Verification.
 * UPDATE — covers the `workspace` client (main-domain "Login with AYZEN"
 * button) and universal backchannel-logout registration (all eight seeded
 * clients now carry a `backchannelLogoutUri`, not Sylo alone).
 *
 * UPDATE (master plan §7 Phase 3, this pass) — adds `skarn` and `warde` to
 * SUBDOMAIN_CLIENT_IDS. Both product surfaces (the "Protocols" and "Team"
 * nav groups) were already built; this file just needed to know their
 * client ids exist now, same as when ryft/wisp/verve/zynth were added.
 *
 * Roadmap 2B-f asks to verify: unique client IDs; exact redirect URIs;
 * expected scopes; first-party flag — "No admin UI." Same DB-free
 * pure-data discipline as every other test-*.ts in this repo (see
 * scripts/src/test-oidc-clients.ts's 2A-d header for why): this checks the
 * `SEED_CLIENTS` array `seed-oidc-clients.ts` will write, not live rows in
 * `oidc_clients` — there's no DATABASE_URL in this environment to read rows
 * back from after running the seed script for real. Once a DB is
 * available, running `npx tsx scripts/src/seed-oidc-clients.ts` followed by
 * a manual `SELECT * FROM oidc_clients` is the live-data equivalent of what
 * this file checks statically.
 *
 * `workspace` is a genuine, documented exception to the `<id>.ayzen.tech`
 * convention the other seven follow (it's the main app itself, reachable at
 * both the bare domain and `workspace.ayzen.tech` — see
 * `seed-oidc-clients.ts`'s own comment on `workspaceClient`), so every test
 * below that asserts the `<id>.ayzen.tech` URI shape is scoped to the seven
 * SUBDOMAIN_CLIENT_IDS, with `workspace` checked separately by its own
 * dedicated tests instead of being silently exempted from the file.
 *
 * Run: npx tsx scripts/src/test-seed-oidc-clients.ts
 */
import assert from "node:assert/strict";
import { SEED_CLIENTS } from "./seed-oidc-clients";

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ok — ${name}`);
  } catch (err) {
    console.error(`  FAIL — ${name}`);
    throw err;
  }
}

const SUBDOMAIN_CLIENT_IDS = ["sylo", "ryft", "wisp", "verve", "zynth", "skarn", "warde"];
const EXPECTED_CLIENT_IDS = [...SUBDOMAIN_CLIENT_IDS, "workspace"];
const EXPECTED_SCOPES = ["openid", "profile", "email"];

const subdomainClients = () => SEED_CLIENTS.filter((c) => SUBDOMAIN_CLIENT_IDS.includes(c.clientId));
const workspaceClient = () => SEED_CLIENTS.find((c) => c.clientId === "workspace");

console.log("SEED_CLIENTS");

test("exactly the eight first-party apps are seeded (seven subdomain apps + workspace), no more, no fewer", () => {
  assert.deepEqual(
    SEED_CLIENTS.map((c) => c.clientId).sort(),
    [...EXPECTED_CLIENT_IDS].sort(),
  );
});

test("unique client IDs — no duplicate client_id across the seed list", () => {
  const ids = SEED_CLIENTS.map((c) => c.clientId);
  assert.equal(new Set(ids).size, ids.length);
});

test("exact redirect URIs — each subdomain client has exactly one production https://<id>.ayzen.tech/oidc/callback entry", () => {
  for (const c of subdomainClients()) {
    assert.deepEqual(c.redirectUris, [`https://${c.clientId}.ayzen.tech/oidc/callback`]);
  }
});

test("redirect URIs use https and the ayzen.tech host — no scheme/host drift between subdomain clients", () => {
  for (const c of subdomainClients()) {
    for (const uri of c.redirectUris) {
      const url = new URL(uri);
      assert.equal(url.protocol, "https:");
      assert.equal(url.hostname, `${c.clientId}.ayzen.tech`);
    }
  }
});

test("Season 3, Phase 6a-d: exact post-logout redirect URIs — each subdomain client has exactly one production https://<id>.ayzen.tech/ home-page entry", () => {
  for (const c of subdomainClients()) {
    assert.deepEqual(c.postLogoutRedirectUris, [`https://${c.clientId}.ayzen.tech/`]);
  }
});

test("Season 3, Phase 6a-d: post-logout redirect URIs are a genuinely different registered list from the OAuth callback allow-list, not an alias of it", () => {
  for (const c of SEED_CLIENTS) {
    for (const uri of c.postLogoutRedirectUris) {
      assert.equal(c.redirectUris.includes(uri), false);
    }
  }
});

test("workspace client: registered at both the bare main domain and workspace.ayzen.tech, https only, no <id>.ayzen.tech entry", () => {
  const c = workspaceClient();
  assert.ok(c, "workspace client must be seeded");
  assert.deepEqual(c!.redirectUris.sort(), [
    "https://ayzen.tech/oidc/callback",
    "https://workspace.ayzen.tech/oidc/callback",
  ]);
  assert.deepEqual(c!.postLogoutRedirectUris.sort(), [
    "https://ayzen.tech/",
    "https://workspace.ayzen.tech/",
  ]);
  for (const uri of [...c!.redirectUris, ...c!.postLogoutRedirectUris]) {
    assert.equal(new URL(uri).protocol, "https:");
  }
});

test("expected scopes — every client is seeded with exactly openid+profile+email, same order", () => {
  for (const c of SEED_CLIENTS) {
    assert.deepEqual(c.allowedScopes, EXPECTED_SCOPES);
  }
});

test("first-party flag — every seeded client is is_first_party=true", () => {
  for (const c of SEED_CLIENTS) {
    assert.equal(c.isFirstParty, true);
  }
});

test("no client secret is seeded — every client is public/PKCE-only (clientSecretHash=null)", () => {
  for (const c of SEED_CLIENTS) {
    assert.equal(c.clientSecretHash, null);
  }
});

test("backchannel logout is now registered for every seeded client, not Sylo alone — each URI matches that client's own origin", () => {
  for (const c of SEED_CLIENTS) {
    assert.ok(c.backchannelLogoutUri, `${c.clientId} must have a backchannelLogoutUri`);
    const url = new URL(c.backchannelLogoutUri!);
    assert.equal(url.protocol, "https:");
    assert.equal(url.pathname, "/oidc/backchannel-logout");
    if (c.clientId === "workspace") {
      assert.equal(url.hostname, "ayzen.tech");
    } else {
      assert.equal(url.hostname, `${c.clientId}.ayzen.tech`);
    }
  }
});

console.log("All oidc_clients seed-verification tests passed.");
