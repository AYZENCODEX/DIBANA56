// scripts/src/seed-oidc-clients.ts
// ─────────────────────────────────────────────────────────────────────────────
// OIDC Roadmap — Season 1, Phase 2B: First-Party Seed Data (2B-a..2B-e).
//
// Registers AYZEN's five first-party subdomain apps — Sylo, Ryft, Wisp,
// Verve, Zynth — as rows in `oidc_clients` (migration 079, Phase 2A). These
// are the same five apps CHANGES_SYLO_SUBDOMAIN_SPLIT.md's
// `subdomain-app.ts` already names as the next hostname splits
// (`ryft.ayzen.tech`, `wisp.ayzen.tech`, `verve.ayzen.tech`,
// `zynth.ayzen.tech`, alongside the already-split `sylo.ayzen.tech`) — this
// is the OIDC-registry side of that same set of apps, not a new list.
//
// EVERY SEEDED CLIENT IS
//   - `is_first_party: true`.
//   - `clientSecretHash: null` — a public client, PKCE-only. All five are
//     the same browser-served SPA bundle (see subdomain-app.ts) scoped by
//     hostname; there's no server-side place to keep a confidential secret
//     for any of them. PKCE — mandatory for first-party clients per the
//     roadmap's global security section 3.2 — is the proof of possession
//     instead. This mirrors the `client_secret_hash` nullability decision
//     already documented in Phase 2A-a's schema.
//   - `allowedScopes: ["openid", "profile", "email"]` — `lib/oidc-
//     discovery.ts`'s SCOPES_SUPPORTED is `["openid"]` only today, and its
//     own comment says adding "profile"/"email" there is explicitly
//     "Phase 2's job (client `allowed_scopes` registry)". Seeded here now
//     so Phase 4's userinfo endpoint has real registry data to check
//     against once it exists, instead of needing a second seed pass.
//   - `redirectUris`: a single production callback,
//     `https://<client_id>.ayzen.tech/oidc/callback`. That route doesn't
//     exist yet (Phase 3 builds `/oidc/authorize` and the client-side
//     callback handler) — this is registry data ahead of the flow, the
//     same relationship migration 079 already has to the not-yet-built
//     `/oidc/authorize`. A dev/local redirect URI can be appended later
//     (once Phase 3 exists to actually test against) without a schema
//     change — `redirect_uris` is a plain JSONB array column.
//   - `postLogoutRedirectUris` (Season 3, Phase 6a-d, migration 084): a
//     single production landing page, `https://<client_id>.ayzen.tech/` —
//     each app's own home page, the obvious "where does a signed-out user
//     land" target for a first-party SPA with no separate marketing site.
//     Kept as its own column rather than reusing `redirectUris` — see
//     migration 084's own header for why RP-Initiated Logout's registered
//     list is deliberately independent from the OAuth callback allow-list.
//
// NOT SEEDED HERE (out of 2B's scope)
//   - No admin UI (roadmap 2b-f: "No admin UI").
//   - No client actually calling `/oidc/authorize` with these credentials
//     — nothing reads this table yet except Phase 2A-c's
//     `getOidcClientById()`/`oidcClientExists()`, and nothing calls those
//     from a route yet either.
//
// IDEMPOTENT: `INSERT .. ON CONFLICT (client_id) DO UPDATE`, safe to re-run
// (e.g. after editing SEED_CLIENTS below) without a separate "already
// seeded" check first. Re-running deliberately never touches
// `client_secret_hash` on conflict — see the DO UPDATE clause below — so a
// secret hash set by some later, out-of-band process for one of these
// clients is never silently wiped out by a reseed.
//
// Usage:
//   npx tsx scripts/src/seed-oidc-clients.ts [--dry-run]
//
//   --dry-run: prints what would be written, writes nothing.

import { pool } from "@workspace/db";

export interface SeedClient {
  clientId: string;
  label: string; // display name only, never written to the DB
  clientSecretHash: null; // every seeded client here is public/PKCE-only
  redirectUris: string[];
  postLogoutRedirectUris: string[];
  /**
   * OIDC Roadmap — Season 3, Phase 6e-b (migration 085). `null` for every
   * seeded client EXCEPT Sylo — this Season's own scope is "শুধু Sylo"
   * (`CHANGES_OIDC_LOGOUT_PROPAGATION_DECISION_PHASE6D.md`'s own 6d-a),
   * so Ryft/Wisp/Verve/Zynth are deliberately left unregistered for
   * propagation, exactly the fail-closed state migration 085's own header
   * describes ("a client that hasn't registered one simply never
   * receives propagation"). Registering theirs too is future-Season
   * work, not a schema/seed change — see migration 085's own header for
   * why the model itself doesn't need to change to support that later.
   */
  backchannelLogoutUri: string | null;
  allowedScopes: string[];
  isFirstParty: true;
}

/** Season 1's registered scope set for every first-party AYZEN app — see file header for why "profile"/"email" are included now. */
const AYZEN_FIRST_PARTY_SCOPES = ["openid", "profile", "email"];

function productionCallbackUrl(clientId: string): string {
  return `https://${clientId}.ayzen.tech/oidc/callback`;
}

/** Season 3, Phase 6a-d: each app's own home page — see file header. */
function productionPostLogoutUrl(clientId: string): string {
  return `https://${clientId}.ayzen.tech/`;
}

/** Season 3, Phase 6e-b: the one URI a registered client's own backchannel-logout receiving endpoint lives at — see `routes/oidc-backchannel-logout.ts`'s own header for why this exact path. */
function productionBackchannelLogoutUrl(clientId: string): string {
  return `https://${clientId}.ayzen.tech/oidc/backchannel-logout`;
}

function seedClient(clientId: string, label: string, opts?: { backchannelLogout?: boolean }): SeedClient {
  return {
    clientId,
    label,
    clientSecretHash: null,
    redirectUris: [productionCallbackUrl(clientId)],
    postLogoutRedirectUris: [productionPostLogoutUrl(clientId)],
    backchannelLogoutUri: opts?.backchannelLogout ? productionBackchannelLogoutUrl(clientId) : null,
    allowedScopes: AYZEN_FIRST_PARTY_SCOPES,
    isFirstParty: true,
  };
}

// 2B-a..2B-e: one entry per first-party app.
//
// UPDATE — backchannel logout coverage extended beyond Sylo. 6e-b's own
// receiving endpoint (`routes/oidc-backchannel-logout.ts`) and dispatch
// path (`lib/oidc-logout-propagation.ts`'s `resolveBackchannelLogoutTargets()`)
// were ALREADY fully generic over any registered `client_id` — the only
// thing scoping this to Sylo alone was this seed data. 6d-c's own Decision
// Record said as much: "this model has to keep working once Ryft/Wisp/
// Verve/Zynth become real ... RPs" — that Season deliberately deferred
// turning it on for them, not deferred building the mechanism. Since
// they're still the same monorepo Express app on the same domain family as
// Sylo (subdomain-app.ts), there's no remaining reason to leave them
// unregistered; flipping `backchannelLogout: true` here is the entire
// change. `workspace` (the main-domain "Login with AYZEN" client) gets the
// same treatment for the identical reason.
const workspaceClient: SeedClient = {
  clientId: "workspace",
  label: "AYZEN Workspace",
  clientSecretHash: null,
  redirectUris: [
    "https://ayzen.tech/oidc/callback",
    "https://workspace.ayzen.tech/oidc/callback",
  ],
  postLogoutRedirectUris: [
    "https://ayzen.tech/",
    "https://workspace.ayzen.tech/",
  ],
  // Same server-to-server target shape productionBackchannelLogoutUrl()
  // builds for every other first-party app — this client's own receiving
  // endpoint lives at the bare main domain, not a `workspace.` subdomain,
  // matching its redirect/post-logout URIs above.
  backchannelLogoutUri: "https://ayzen.tech/oidc/backchannel-logout",
  allowedScopes: AYZEN_FIRST_PARTY_SCOPES,
  isFirstParty: true,
};

export const SEED_CLIENTS: SeedClient[] = [
  seedClient("sylo", "Sylo", { backchannelLogout: true }),
  seedClient("ryft", "Ryft", { backchannelLogout: true }),
  seedClient("wisp", "Wisp", { backchannelLogout: true }),
  seedClient("verve", "Verve", { backchannelLogout: true }),
  seedClient("zynth", "Zynth", { backchannelLogout: true }),
  // Skarn (master plan §7 Phase 3, this pass) — the existing "Protocols"
  // nav group (route-config.tsx / app-sidebar.tsx) IS Skarn's product
  // surface, already built; this just registers its OIDC client the same
  // way every other split app got one, so skarn.ayzen.tech gets the same
  // "Sign in with AYZEN" auto-cutover the rest already have.
  seedClient("skarn", "Skarn", { backchannelLogout: true }),
  seedClient("warde", "Warde", { backchannelLogout: true }),
  workspaceClient,
];

async function main(): Promise<void> {
  const dryRun = process.argv.slice(2).includes("--dry-run");

  console.log(
    `[seed-oidc-clients] ${SEED_CLIENTS.length} first-party client(s) to seed: ${SEED_CLIENTS.map((c) => c.clientId).join(", ")}`,
  );

  if (dryRun) {
    for (const c of SEED_CLIENTS) {
      console.log(
        `[seed-oidc-clients] --dry-run: would upsert client_id='${c.clientId}' (${c.label}) ` +
          `redirect_uris=${JSON.stringify(c.redirectUris)} post_logout_redirect_uris=${JSON.stringify(c.postLogoutRedirectUris)} ` +
          `backchannel_logout_uri=${c.backchannelLogoutUri ?? "NULL"} ` +
          `allowed_scopes=${JSON.stringify(c.allowedScopes)} ` +
          `is_first_party=${c.isFirstParty} client_secret_hash=NULL`,
      );
    }
    console.log("[seed-oidc-clients] --dry-run: stopping here. No rows written.");
    return;
  }

  let upserted = 0;
  for (const c of SEED_CLIENTS) {
    try {
      await pool.query(
        `INSERT INTO oidc_clients (client_id, client_secret_hash, redirect_uris, post_logout_redirect_uris, backchannel_logout_uri, allowed_scopes, is_first_party, updated_at)
         VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6::jsonb, $7, NOW())
         ON CONFLICT (client_id) DO UPDATE SET
           redirect_uris = EXCLUDED.redirect_uris,
           post_logout_redirect_uris = EXCLUDED.post_logout_redirect_uris,
           backchannel_logout_uri = EXCLUDED.backchannel_logout_uri,
           allowed_scopes = EXCLUDED.allowed_scopes,
           is_first_party = EXCLUDED.is_first_party,
           updated_at = NOW()`,
        [
          c.clientId,
          c.clientSecretHash,
          JSON.stringify(c.redirectUris),
          JSON.stringify(c.postLogoutRedirectUris),
          c.backchannelLogoutUri,
          JSON.stringify(c.allowedScopes),
          c.isFirstParty,
        ],
      );
      upserted += 1;
      console.log(`[seed-oidc-clients] client_id='${c.clientId}' (${c.label}) upserted.`);
    } catch (err) {
      console.error(`[seed-oidc-clients] failed to upsert client_id='${c.clientId}':`, err);
    }
  }

  console.log(`[seed-oidc-clients] done — ${upserted}/${SEED_CLIENTS.length} client(s) upserted.`);
}

main()
  .catch((err) => {
    console.error("[seed-oidc-clients] unexpected error:", err);
    process.exitCode = 1;
  })
  .finally(() => {
    void pool.end();
  });
