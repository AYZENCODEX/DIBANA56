import { pgTable, serial, text, integer, timestamp, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * api_keys — developer API keys users generate to call the AYZEN API from
 * their own bots / scripts, instead of logging in with username+password.
 *
 * The raw key is shown to the user exactly once at creation time and is
 * NEVER stored — only its SHA-256 hash (`key_hash`) is persisted, the same
 * way passwords are stored as hashes, not plaintext. `key_prefix` keeps a
 * short, safe-to-display fragment (e.g. `ayzn_live_ab12cd34`) so the user
 * can recognize which key is which in the dashboard without ever seeing
 * the full secret again.
 *
 * `type` is 'full' (all AYZEN API features, same access as the user's own
 * session) or 'scoped' (restricted to `scopes`). Scope enforcement is not
 * wired up yet — `scopes` exists so scoped keys can be added later without
 * another migration; today every issued key is 'full'.
 */
export const apiKeysTable = pgTable(
  "api_keys",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").notNull(),
    name: text("name").notNull(),
    keyPrefix: text("key_prefix").notNull(),
    keyHash: text("key_hash").notNull(),
    type: text("type").notNull().default("full"), // 'full' | 'scoped'
    scopes: jsonb("scopes").notNull().default([]),
    lastUsedAt: timestamp("last_used_at"),
    lastUsedIp: text("last_used_ip"),
    expiresAt: timestamp("expires_at"),
    revokedAt: timestamp("revoked_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("api_keys_user_id_idx").on(table.userId),
    uniqueIndex("api_keys_key_hash_idx").on(table.keyHash),
  ],
);

export const insertApiKeySchema = createInsertSchema(apiKeysTable).omit({
  id: true,
  createdAt: true,
});
export type InsertApiKey = z.infer<typeof insertApiKeySchema>;
export type ApiKey = typeof apiKeysTable.$inferSelect;
