import { pgTable, serial, integer, text, timestamp } from "drizzle-orm/pg-core";

/**
 * schema/vault-attachments.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Feature 12 — Document/File Attachments.
 *
 * Lets a user attach small files (ID scan, contract, screenshot, etc.) to a
 * Vault entity (vault_entries row), the same way vault_activity_log and
 * vault_field_history are scoped by vaultEntryId — no FK/cascade, same
 * rationale as those tables (see schema/vault.ts).
 *
 * Storage: there is no object-storage (S3/R2/etc.) wired into this project,
 * so file bytes are base64-encoded, then encrypted at rest with the same
 * envelope-encryption helper every other Vault secret uses
 * (lib/vault-crypto.ts's encryptField/decryptField — namespace "vault",
 * columns are TEXT so this reuses the exact same DEK/KEK machinery, no new
 * key material). This keeps every credential AND every attachment behind
 * one key-rotation story instead of two.
 *
 * Because everything rides through a single TEXT column with no streaming,
 * this is deliberately sized for small documents (ID photos, PDF contracts),
 * not bulk file storage — see MAX_ATTACHMENT_BYTES in
 * routes/vault-attachments.ts. A future move to real object storage would
 * replace encryptedContent with a storage key/URL and leave every other
 * column (and the API contract) unchanged.
 */
export const vaultAttachmentsTable = pgTable("vault_attachments", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  vaultEntryId: integer("vault_entry_id").notNull(),
  fileName: text("file_name").notNull(),
  mimeType: text("mime_type").notNull(),
  // Original (decoded, pre-encryption) file size in bytes — used for list
  // views and the MAX_ATTACHMENT_BYTES check on upload, so callers never
  // have to decrypt just to show a file size.
  fileSizeBytes: integer("file_size_bytes").notNull(),
  // Free-form label for the document type — "id_scan" | "contract" | "other"
  // etc. Not an enum at the DB level (same pattern as vault_entries.status),
  // validated in the route instead so new categories don't need a migration.
  category: text("category").notNull().default("other"),
  note: text("note"),
  // base64(file bytes), run through encryptField() before being stored —
  // see file header. Never returned by the list endpoint, only by the
  // single-attachment download route.
  encryptedContent: text("encrypted_content").notNull(),
  uploadedAt: timestamp("uploaded_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type VaultAttachment = typeof vaultAttachmentsTable.$inferSelect;
