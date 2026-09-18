import { pgTable, serial, integer, text, timestamp } from "drizzle-orm/pg-core";

/**
 * schema/vault-security.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase 5 — Vault Security: PINs & Session.
 *
 * One row per user. Two independent 4-digit PINs, both stored hashed (never
 * plaintext) via lib/password.ts's bcrypt helpers — the same hashing used for
 * account passwords:
 *
 *   vaultPinHash  — required to unlock Vault itself (gates all /vault/* pages,
 *                   see components/vault/vault-unlock-gate.tsx on the frontend).
 *   entityPinHash — required to view any entity's details. One shared PIN for
 *                   every entity, independent of vaultPinHash (changing one
 *                   never touches the other — see routes/vault-security.ts).
 *
 * Either column may be NULL — a user who hasn't set a given PIN yet is not
 * gated by it (see the frontend gate: no PIN set → no lock screen). This is
 * what lets a brand-new user reach /vault/security to set their first PIN
 * without being locked out of the page that sets it.
 */
export const vaultSecurityTable = pgTable("vault_security", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().unique(),
  vaultPinHash: text("vault_pin_hash"),
  entityPinHash: text("entity_pin_hash"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type VaultSecurity = typeof vaultSecurityTable.$inferSelect;
