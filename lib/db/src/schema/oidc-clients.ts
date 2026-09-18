import { pgTable, serial, text, boolean, timestamp, jsonb, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * schema/oidc-clients.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 1, Phase 2A: Client registry table design
 * (migration 079).
 *
 * The trusted registry of first-party OIDC clients (Sylo, Ryft, Wisp, Verve,
 * Zynth) that Phase 3's `/oidc/authorize` and `/oidc/token` endpoints will
 * validate every request against — which `client_id`s exist, which
 * `redirect_uris` each may send a user back to, and which `allowed_scopes`
 * each may request. Today nothing reads or writes this table; it's the
 * storage layer only.
 *
 * `clientSecretHash` is nullable: a first-party client doing Authorization
 * Code + PKCE (required for all first-party clients per the roadmap's
 * global security requirements, section 3.2) doesn't strictly need a
 * client secret — PKCE is the proof of possession. Whether Sylo etc. end up
 * confidential or public is a Phase 2B seeding decision, not this one.
 *
 * `redirectUris` / `allowedScopes` are JSONB arrays of strings, matching the
 * existing `api_keys.scopes` precedent rather than introducing a native
 * Postgres array column type into this codebase.
 *
 * Scope note: schema ONLY, same discipline as the migration — no seed data
 * (Phase 2B), no repository/data-access helpers (Phase 2C-a), no
 * redirect-uri or scope validation (Phase 2C/2D), no wiring into
 * `/oidc/authorize` (Phase 2E). Do not add fields beyond what 2A-a
 * specifies unless a later phase concretely needs them.
 *
 * UPDATE — Season 3, Phase 6a-d (migration 084): `postLogoutRedirectUris`
 * added. RP-Initiated Logout 1.0's own registered allow-list — a JSONB
 * array of strings with the identical shape/default/nullability as
 * `redirectUris` above, for the identical reason (see migration 084's own
 * header): a Sign-out target and an OAuth callback target are two
 * independent registered lists, never one reused for both purposes.
 *
 * UPDATE — Season 3, Phase 6e-b (migration 085): `backchannelLogoutUri`
 * added. A single nullable TEXT column (not JSONB — this is one URI per
 * client, never a list), `null` by default/fail-closed. See migration
 * 085's own header for why this is a third, independent column rather
 * than folded into `redirectUris` or `postLogoutRedirectUris`, and
 * `lib/oidc-clients.ts`'s `listBackchannelLogoutTargets()` for the one
 * reader.
 */
export const oidcClientsTable = pgTable(
  "oidc_clients",
  {
    id: serial("id").primaryKey(),
    clientId: text("client_id").notNull(), // public identifier, e.g. "sylo"
    clientSecretHash: text("client_secret_hash"), // NULL for public/PKCE-only clients; hashed, never plaintext
    redirectUris: jsonb("redirect_uris").notNull().default([]).$type<string[]>(),
    // Phase 6a-d (migration 084): RP-Initiated Logout's own registered
    // allow-list — deliberately a separate column from redirectUris above,
    // not a reuse of it. See migration 084's header for why.
    postLogoutRedirectUris: jsonb("post_logout_redirect_uris").notNull().default([]).$type<string[]>(),
    // Phase 6e-b (migration 085): OpenID Back-Channel Logout 1.0's
    // per-client receiving endpoint. Nullable, no default list shape (a
    // single URI, not an allow-list) — see migration 085's own header.
    backchannelLogoutUri: text("backchannel_logout_uri"),
    allowedScopes: jsonb("allowed_scopes").notNull().default([]).$type<string[]>(),
    isFirstParty: boolean("is_first_party").notNull().default(false),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [uniqueIndex("oidc_clients_client_id_idx").on(table.clientId)],
);

export const insertOidcClientSchema = createInsertSchema(oidcClientsTable, {
  redirectUris: z.array(z.string()),
  postLogoutRedirectUris: z.array(z.string()),
  allowedScopes: z.array(z.string()),
}).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertOidcClient = z.infer<typeof insertOidcClientSchema>;
export type OidcClientRow = typeof oidcClientsTable.$inferSelect;
