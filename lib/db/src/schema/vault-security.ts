import { pgTable, serial, integer, text, boolean, timestamp } from "drizzle-orm/pg-core";

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
 * vaultTwoFaSecret / vaultTwoFaEnabled — Vault's OWN TOTP 2FA, entirely
 * separate from the account-level 2FA at users.two_fa_secret (the one used
 * for login and shown on the account /security page). Set up on
 * /vault/security, this is what components/vault/vault-auth.tsx checks
 * during the password+2FA fallback of the Vault re-auth gate — see
 * routes/vault-reauth.ts, which now reads these columns instead of the
 * account's. Changing/disabling account 2FA never touches these, and vice
 * versa.
 *
 * vaultPasswordHash — Vault's OWN password, same idea as vaultTwoFaSecret
 * above but for the "password" half of the PIN/password + 2FA re-auth
 * fallback. Entirely independent of the account login password
 * (users.password_hash) — routes/vault-reauth.ts's /vault/reauth/verify
 * NEVER checks the account password, only vaultPinHash or vaultPasswordHash,
 * so a shared/observed account login can never unlock Vault on its own.
 * When both vaultPinHash and vaultPasswordHash are set, the PIN takes
 * priority (shorter, faster to enter) — see GET /vault/reauth/status's
 * usesVaultPin/usesVaultPassword fields. If NEITHER is set, Vault re-auth's
 * fallback step can't be completed at all (only passkey works, or nothing
 * does) — routes/vault-reauth.ts responds 428 CREDENTIAL_NOT_SET and sends
 * the person to /vault/security to set one up.
 *
 * All of vaultPinHash / entityPinHash / vaultPasswordHash may be NULL — a
 * user who hasn't set a given one yet is not gated by it on /vault/security
 * itself (see the frontend gates: nothing set → no lock screen there),
 * though vaultPinHash/vaultPasswordHash being both NULL does block the
 * /vault/reauth/verify fallback as described above.
 */
/**
 * authStepPolicy — governs how many of the three Vault re-auth steps
 * (1: passkey, 2: Vault PIN/password + Vault 2FA, 3: email code + Vault PIN
 * failover) must succeed before Vault unlocks. See routes/vault-reauth.ts.
 *   "any"    — passing ANY ONE step unlocks Vault (default, matches the
 *              original passkey-OR-password+2FA behavior).
 *   "step12" — steps 1 AND 2 must both succeed.
 *   "step123"— steps 1 AND 2 AND 3 must all succeed.
 * Step 3 is always available as a fail-over when step 2 can't be completed
 * (lost authenticator app), regardless of this policy — this only changes
 * whether passing it is OPTIONAL or REQUIRED for unlock.
 */
export const AUTH_STEP_POLICIES = ["any", "step12", "step123"] as const;
export type AuthStepPolicy = (typeof AUTH_STEP_POLICIES)[number];

export const vaultSecurityTable = pgTable("vault_security", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().unique(),
  // The Vault Security PIN — the single most powerful credential in Vault.
  // Required (alongside whatever else is already required) to: change/create
  // a passkey, add/remove/change Vault 2FA, change the Vault password, and
  // as the credential checked in Vault re-auth's step 2 and step 3. Setting
  // this is mandatory — see routes/vault-security.ts's
  // /vault/security/pin/request-code + PUT /vault/security/pin (kind="vault"),
  // which require the account password + a fresh email code to set or change
  // it, reflecting how much it gates. Distinct from entityPinHash below —
  // two different PINs, see file header.
  vaultPinHash: text("vault_pin_hash"),
  entityPinHash: text("entity_pin_hash"),
  vaultTwoFaSecret: text("vault_two_fa_secret"),
  vaultTwoFaEnabled: boolean("vault_two_fa_enabled").notNull().default(false),
  vaultPasswordHash: text("vault_password_hash"),
  authStepPolicy: text("auth_step_policy").notNull().default("any"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type VaultSecurity = typeof vaultSecurityTable.$inferSelect;
