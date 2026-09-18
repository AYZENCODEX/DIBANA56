import { pgTable, serial, text, integer, boolean, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * passkey_credentials — WebAuthn/FIDO2 credentials ("passkeys") registered
 * against a user account, used as an alternative (or replacement) login
 * method for username+password.
 *
 * Nothing secret is ever stored here: `credentialId` and `publicKey` are the
 * public half of a key pair the authenticator (phone/laptop/security key)
 * generated and kept the private half of. The server can only ever verify a
 * signature with them — it can't sign in as the user without the physical
 * authenticator. `counter` is the signature counter used to detect cloned
 * authenticators (should only ever increase; a login with a lower or equal
 * counter than what's stored is rejected as a replay/clone).
 *
 * `transports` stores the browser-reported hints (e.g. ["internal"],
 * ["usb","nfc"]) as a comma-separated string so the client can skip
 * unusable transports on repeat logins — purely a UX hint, never trusted
 * for security decisions.
 */
export const passkeyCredentialsTable = pgTable(
  "passkey_credentials",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").notNull(),
    credentialId: text("credential_id").notNull(),
    publicKey: text("public_key").notNull(),
    counter: integer("counter").notNull().default(0),
    deviceType: text("device_type").notNull().default("singleDevice"), // 'singleDevice' | 'multiDevice'
    backedUp: boolean("backed_up").notNull().default(false),
    transports: text("transports"), // comma-separated: "internal,hybrid,usb,nfc,ble"
    name: text("name").notNull().default("Passkey"), // user-facing label, e.g. "iPhone Face ID"
    lastUsedAt: timestamp("last_used_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("passkey_credentials_user_id_idx").on(table.userId),
    uniqueIndex("passkey_credentials_credential_id_idx").on(table.credentialId),
  ],
);

export const insertPasskeyCredentialSchema = createInsertSchema(passkeyCredentialsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertPasskeyCredential = z.infer<typeof insertPasskeyCredentialSchema>;
export type PasskeyCredential = typeof passkeyCredentialsTable.$inferSelect;
