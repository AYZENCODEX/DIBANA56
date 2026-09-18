import { pgTable, serial, integer, text, boolean, timestamp, unique } from "drizzle-orm/pg-core";

/**
 * schema/encryption-keys.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * KMS-style envelope encryption for lib/vault-crypto.ts (see that file for the
 * full design note). This table never stores a key that can decrypt data on
 * its own:
 *
 *   - Each row holds one *data-encryption key* (DEK), but only in wrapped
 *     (encrypted) form — wrapped_dek is the DEK encrypted with the app's
 *     key-encryption key (KEK, from VAULT_MASTER_KEY / VAULT_FIELD_ENCRYPTION_KEY
 *     in the environment, never persisted to the database).
 *   - "namespace" separates independent key chains — "vault" for
 *     lib/vault-crypto.ts today; a distinct namespace (e.g. "wallet") can be
 *     added later for lib/wallet-crypto.ts without touching this one, same
 *     reasoning as the two modules already using separate keys.
 *   - "version" is what vault-crypto.ts stamps onto every ciphertext it
 *     writes ("enc:v<version>:..."), so old rows keep decrypting under the
 *     DEK that was active when they were written, even after rotation.
 *   - Exactly one row per namespace has active = true at a time — that's the
 *     DEK new writes use. Old versions are never deleted: they're needed
 *     until the reencrypt-vault script has migrated every row off them.
 *
 * Rows are created/updated only by lib/vault-crypto.ts's loadKeyManager() /
 * rotateKey() and by scripts/src/reencrypt-vault.ts — nothing else should
 * write here.
 */
export const encryptionKeysTable = pgTable("encryption_keys", {
  id: serial("id").primaryKey(),
  namespace: text("namespace").notNull(),
  version: integer("version").notNull(),
  wrappedDek: text("wrapped_dek").notNull(),
  active: boolean("active").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => ({
  namespaceVersionUnique: unique().on(t.namespace, t.version),
}));

export type EncryptionKeyRow = typeof encryptionKeysTable.$inferSelect;
