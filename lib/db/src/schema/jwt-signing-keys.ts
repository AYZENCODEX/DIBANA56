import { pgTable, serial, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * schema/jwt-signing-keys.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 1, Phase 1C: Multi-key storage/schema (migration 078).
 *
 * Durable, kid-indexed record of every RS256 public key AYZEN Central
 * Account has ever signed session tokens with — what lib/jwt-keys.ts's
 * single env-var-resolved `getActiveKeypair()` doesn't give any visibility
 * into. Storing the PUBLIC key here (never the private key — that stays a
 * single active env var) is what lets a future rotation keep an old key
 * valid for verification during an overlap window instead of invalidating
 * every in-flight token the instant AYZEN_JWT_KID changes.
 *
 * `status` is the overlap window itself:
 *   "active"   — currently signs new tokens. Exactly one row at a time
 *                (DB-enforced, see migration 078's partial unique index) —
 *                must match the env's AYZEN_JWT_KID.
 *   "retiring" — stopped signing, still valid for verification.
 *   "retired"  — no longer valid for verification either; kept as history.
 *
 * Scope note: this file is schema ONLY, same discipline as the migration —
 * no rotation policy, no read/write helpers, no wiring into lib/jwt-keys.ts
 * or lib/jwt.ts yet. Phase 1D adds getVerificationKeys(kid?) and the
 * rotation trigger that actually reads/writes this table; Phase 1E's
 * /.well-known/jwks.json publishes what 1D writes here.
 */
export const jwtSigningKeysTable = pgTable(
  "jwt_signing_keys",
  {
    id: serial("id").primaryKey(),
    kid: text("kid").notNull(), // matches the JWT header's `kid` claim
    publicKey: text("public_key").notNull(), // PEM, SPKI — verification only
    algorithm: text("algorithm").notNull().default("RS256"),
    status: text("status").notNull().default("active"), // "active" | "retiring" | "retired"
    retiringAt: timestamp("retiring_at"),
    retiredAt: timestamp("retired_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("jwt_signing_keys_kid_idx").on(table.kid),
    index("jwt_signing_keys_status_idx").on(table.status),
  ],
);

export const insertJwtSigningKeySchema = createInsertSchema(jwtSigningKeysTable).omit({
  id: true,
  createdAt: true,
});
export type InsertJwtSigningKey = z.infer<typeof insertJwtSigningKeySchema>;
export type JwtSigningKeyRow = typeof jwtSigningKeysTable.$inferSelect;
