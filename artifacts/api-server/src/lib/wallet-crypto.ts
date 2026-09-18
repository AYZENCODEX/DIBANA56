/**
 * lib/wallet-crypto.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Shared AES-256-GCM encrypt/decrypt for wallet recovery phrases / private
 * keys at rest. Extracted from routes/wallets.ts so other routes (e.g.
 * routes/polymarket.ts) that need to unlock a user's wallet don't duplicate
 * the PHRASE_ENCRYPTION_KEY validation and cipher logic.
 *
 * KMS-style envelope encryption (v1+) — same design as lib/vault-crypto.ts
 * (see that file for the full design note), on its own key chain ("wallet"
 * namespace in the shared encryption_keys table) so a leak of one key
 * doesn't expose the other. This is the highest-value data in the system
 * (private keys / seed phrases), so it gets the same protection Vault/KYC
 * credentials already have, not a lesser static key:
 *
 *   KEK (key-encryption key)  — PHRASE_ENCRYPTION_KEY from the environment,
 *                               never stored anywhere. Only ever used to
 *                               wrap/unwrap DEKs — never touches phrase data.
 *   DEK (data-encryption key) — a random 32-byte key, generated here, wrapped
 *                               (AES-256-GCM'd) with the KEK, and stored in
 *                               the encryption_keys table under namespace
 *                               "wallet". This is what actually encrypts
 *                               phrases. Every DEK has a version number.
 *
 * Rotating (rotateWalletKey()) generates a new DEK/version and makes it
 * active for new writes — old DEKs are kept forever so already-encrypted
 * rows keep decrypting. There's no separate re-encryption script yet (unlike
 * vault's reencrypt-vault.ts) since this module has a single column
 * (wallets.encrypted_phrase); rotate, then re-save any wallet phrase you
 * want moved onto the new version (POST /wallets re-encrypts on write).
 *
 * Format: "v<version>:<iv>:<ciphertext>:<authTag>" (all hex, AES-256-GCM).
 *
 * Backward compatibility: every phrase encrypted before this envelope layer
 * existed used the plain "iv:ciphertext:authTag" format (no version prefix),
 * encrypted directly with what's now the legacy/KEK key. decryptPhrase()
 * keeps decrypting those forever — no forced backfill migration.
 *
 * SECURITY: this key (chain) protects every user's wallet recovery phrase.
 * There is no fallback — set PHRASE_ENCRYPTION_KEY in your environment
 * (>= 32 chars) before this module is imported, or the server refuses to
 * start. Set WALLET_MASTER_KEY (>= 32 chars, a DIFFERENT secret) to use as
 * the KEK — if unset, PHRASE_ENCRYPTION_KEY doubles as the KEK, which works
 * but means one leaked env var exposes both the legacy key and every wrapped
 * DEK, so a dedicated WALLET_MASTER_KEY is strongly recommended before
 * rotating.
 */
import crypto from "crypto";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const NAMESPACE = "wallet";

const PHRASE_ENCRYPTION_KEY_RAW = process.env["PHRASE_ENCRYPTION_KEY"];
if (!PHRASE_ENCRYPTION_KEY_RAW || PHRASE_ENCRYPTION_KEY_RAW.length < 32) {
  throw new Error(
    "PHRASE_ENCRYPTION_KEY is missing or shorter than 32 characters. Set it as a strong random " +
    "secret (e.g. `openssl rand -hex 32`) in your environment before starting the API server — " +
    "this key protects every user's wallet recovery phrase."
  );
}
// Pre-KMS phrases were encrypted directly with this key — kept forever,
// read-only, purely to decrypt anything that hasn't been re-saved since.
const LEGACY_KEY = Buffer.from(PHRASE_ENCRYPTION_KEY_RAW.slice(0, 32).padEnd(32, "0"));

const KEK_RAW = process.env["WALLET_MASTER_KEY"] || PHRASE_ENCRYPTION_KEY_RAW;
const KEK = Buffer.from(KEK_RAW.slice(0, 32).padEnd(32, "0"));

function aesEncrypt(key: Buffer, plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return iv.toString("hex") + ":" + enc.toString("hex") + ":" + authTag.toString("hex");
}

function aesDecrypt(key: Buffer, packed: string): string {
  const [ivHex, encHex, tagHex] = packed.split(":");
  if (!ivHex || !encHex || !tagHex) throw new Error("Malformed encrypted phrase (expected iv:ciphertext:authTag)");
  const iv = Buffer.from(ivHex, "hex");
  const enc = Buffer.from(encHex, "hex");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}

function wrapDek(dek: Buffer): string {
  return aesEncrypt(KEK, dek.toString("hex"));
}
function unwrapDek(wrapped: string): Buffer {
  return Buffer.from(aesDecrypt(KEK, wrapped), "hex");
}

// In-memory cache: DEK version -> raw 32-byte key. Populated by
// loadWalletKeyManager() at server startup (see index.ts's
// waitForDbThenMigrate) and refreshed after rotateWalletKey(). Never
// persisted outside this process.
const dekCache = new Map<number, Buffer>();
let activeVersion: number | null = null;
let ready = false;

async function bootstrapFirstKey(): Promise<void> {
  const dek = crypto.randomBytes(32);
  await db.execute(sql`
    INSERT INTO encryption_keys (namespace, version, wrapped_dek, active)
    VALUES (${NAMESPACE}, 1, ${wrapDek(dek)}, TRUE)
    ON CONFLICT (namespace, version) DO NOTHING
  `);
}

/**
 * Loads this namespace's DEKs from encryption_keys into memory, bootstrapping
 * version 1 if none exist yet. Call once at startup, after the
 * encryption_keys table migration has run — encryptPhrase()/decryptPhrase()
 * fall back to the legacy key until this completes, so calling it late is
 * safe, just means early-boot writes stay on the legacy format until the
 * server is restarted (or the wallet is re-saved) after loading succeeds.
 */
export async function loadWalletKeyManager(): Promise<void> {
  const result: any = await db.execute(
    sql`SELECT version, wrapped_dek, active FROM encryption_keys WHERE namespace = ${NAMESPACE} ORDER BY version ASC`
  );
  const rows: any[] = result.rows ?? result;
  if (rows.length === 0) {
    await bootstrapFirstKey();
    return loadWalletKeyManager();
  }
  dekCache.clear();
  activeVersion = null;
  for (const r of rows) {
    dekCache.set(Number(r.version), unwrapDek(r.wrapped_dek));
    if (r.active) activeVersion = Number(r.version);
  }
  if (activeVersion === null) activeVersion = Number(rows[rows.length - 1].version);
  ready = true;
}

/**
 * Generates a new DEK, makes it the active version for new writes, and
 * refreshes the in-memory cache. Old versions are kept — already-encrypted
 * phrases keep decrypting under them until re-saved onto the new version.
 * Returns the new version number.
 */
export async function rotateWalletKey(): Promise<number> {
  if (!ready) await loadWalletKeyManager();
  const newVersion = (activeVersion ?? 0) + 1;
  const dek = crypto.randomBytes(32);
  await db.execute(sql`UPDATE encryption_keys SET active = FALSE WHERE namespace = ${NAMESPACE}`);
  await db.execute(sql`
    INSERT INTO encryption_keys (namespace, version, wrapped_dek, active)
    VALUES (${NAMESPACE}, ${newVersion}, ${wrapDek(dek)}, TRUE)
  `);
  await loadWalletKeyManager();
  return newVersion;
}

/** Current active DEK version, or null if loadWalletKeyManager() hasn't run yet. */
export function getActiveWalletKeyVersion(): number | null {
  return activeVersion;
}

// Stored format: "v<version>:iv:ciphertext:authTag" once the key manager is
// loaded, or plain "iv:ciphertext:authTag" (legacy key) before that.
export function encryptPhrase(plain: string): string {
  if (!ready || activeVersion === null) {
    // Key manager not loaded yet (very early in boot) — fall back to the
    // legacy key so writes never fail. Self-heals: once
    // loadWalletKeyManager() completes, subsequent writes use a real DEK.
    return aesEncrypt(LEGACY_KEY, plain);
  }
  const dek = dekCache.get(activeVersion)!;
  return "v" + activeVersion + ":" + aesEncrypt(dek, plain);
}

export function decryptPhrase(encrypted: string): string {
  const versioned = encrypted.match(/^v(\d+):(.+)$/);
  if (versioned) {
    const version = Number(versioned[1]);
    const dek = dekCache.get(version);
    if (!dek) throw new Error(`Cannot decrypt wallet phrase: unknown key version v${version}`);
    return aesDecrypt(dek, versioned[2]);
  }
  // No version marker → pre-KMS ciphertext, decrypt with the legacy key.
  return aesDecrypt(LEGACY_KEY, encrypted);
}
