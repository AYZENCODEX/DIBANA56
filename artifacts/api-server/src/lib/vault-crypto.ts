/**
 * lib/vault-crypto.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Field-level encryption for Vault credential columns (passwords, 2FA
 * secrets, backup codes, IMAP passwords, synced mail bodies) — separate from
 * lib/wallet-crypto.ts so a leak of one key doesn't expose the other.
 *
 * KMS-style envelope encryption (v1+): data is never encrypted directly with
 * a key from the environment. Instead:
 *
 *   KEK (key-encryption key)  — VAULT_MASTER_KEY from the environment, never
 *                               stored anywhere. Only ever used to wrap/unwrap
 *                               DEKs — never touches actual field data.
 *   DEK (data-encryption key) — a random 32-byte key, generated here, wrapped
 *                               (AES-256-GCM'd) with the KEK, and stored in
 *                               the encryption_keys table (schema/encryption-
 *                               keys.ts). This is what actually encrypts
 *                               field data. Every DEK has a version number.
 *
 * Rotating (rotateKey()) generates a new DEK/version and makes it active for
 * new writes — old DEKs are kept forever so already-encrypted rows keep
 * decrypting. scripts/src/reencrypt-vault.ts walks every sensitive column and
 * re-encrypts rows still on an old version under the active one; run it after
 * every rotation (it's safe to run any time, e.g. as a background job — rows
 * already on the active version are skipped).
 *
 * Format: "enc:v<version>:<iv>:<ciphertext>:<authTag>" (all hex, AES-256-GCM).
 *
 * Backward compatibility (pre-KMS rows, and rows written before
 * loadKeyManager() finished its first load at boot):
 *   - No "enc:" prefix at all           → legacy plaintext, passed through
 *     unchanged. Lets this ship without a forced backfill migration.
 *   - "enc:<iv>:<ct>:<tag>" (no "vN:")  → pre-KMS format, decrypted with the
 *     legacy key derived directly from VAULT_FIELD_ENCRYPTION_KEY (the same
 *     derivation this module used before the KMS layer existed). Never used
 *     to encrypt new data — reencrypt-vault.ts migrates these to a real DEK.
 *
 * SECURITY: set VAULT_FIELD_ENCRYPTION_KEY (>= 32 chars) in the environment
 * before this module is imported, or the server refuses to start. Set
 * VAULT_MASTER_KEY (>= 32 chars, a DIFFERENT secret) to use as the KEK — if
 * unset, VAULT_FIELD_ENCRYPTION_KEY doubles as the KEK, which works but means
 * one leaked env var exposes both the legacy key and every wrapped DEK, so a
 * dedicated VAULT_MASTER_KEY is strongly recommended before rotating.
 */
import crypto from "crypto";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const NAMESPACE = "vault";
const PREFIX = "enc:";

const LEGACY_KEY_RAW = process.env["VAULT_FIELD_ENCRYPTION_KEY"];
if (!LEGACY_KEY_RAW || LEGACY_KEY_RAW.length < 32) {
  throw new Error(
    "VAULT_FIELD_ENCRYPTION_KEY is missing or shorter than 32 characters. Set it as a strong " +
    "random secret (e.g. `openssl rand -hex 32`) in your environment before starting the API " +
    "server — this key protects every credential stored in Vault/KYC/Local/Game/Mail records."
  );
}
// Pre-KMS rows were encrypted directly with this key — kept forever, read-only,
// purely to decrypt anything reencrypt-vault.ts hasn't migrated yet. Left on
// the original derivation deliberately: this key is never used to wrap/unwrap
// anything, it's the literal field-encryption key for old rows, so changing
// its derivation would make every un-migrated legacy row unreadable outright.
const LEGACY_KEY = Buffer.from(LEGACY_KEY_RAW.slice(0, 32).padEnd(32, "0"));

const KEK_RAW = process.env["VAULT_MASTER_KEY"] || LEGACY_KEY_RAW;

// KEK derivation, hardened.
// ─────────────────────────────────────────────────────────────────────────
// The original derivation below (`raw.slice(0, 32).padEnd(32, "0")`) treats
// the env secret as raw key bytes: only its first 32 *characters* are used,
// the rest silently discarded, and anything shorter is zero-padded rather
// than stretched. That quietly undermines the "≥32 chars" advice this file
// gives — `openssl rand -hex 32` (which this file's own error message
// recommends) produces 64 hex characters worth of 256-bit entropy, but the
// old derivation only ever used the first 32 of them (~128 bits), and a
// hyphen-joined passphrase gets similarly truncated wherever it happens to
// hit 32 characters.
//
// deriveKekStrong() instead runs the FULL raw secret through HKDF-SHA256
// (RFC 5869) with a fixed, module-specific salt/info for domain separation,
// so every byte of whatever's in VAULT_MASTER_KEY contributes to the
// resulting 256-bit KEK regardless of the secret's length or encoding.
//
// unwrapDek() tries the strong KEK first and falls back to the legacy
// (truncate-and-pad) derivation only if that fails. This is safe — not a
// weakening — specifically because AES-256-GCM authenticates: unwrapping
// with the wrong key throws (auth tag mismatch) rather than silently
// returning garbage, so the fallback can only ever succeed on a DEK that
// really was wrapped under the old derivation. That lets already-deployed
// encryption_keys rows keep decrypting with zero migration step, while
// every new DEK (bootstrap, rotateKey()) is wrapped under the hardened key
// going forward. Operators who want existing rows re-wrapped under the
// strong KEK immediately (rather than left on legacy-wrap-but-still-secure)
// can run `scripts/src/rewrap-encryption-keys.ts --upgrade-derivation`.
const KEK_HKDF_SALT = Buffer.from("ayzen:vault-crypto:kek-v2", "utf8");
const KEK_HKDF_INFO = Buffer.from("kek", "utf8");
function deriveKekStrong(raw: string): Buffer {
  return Buffer.from(crypto.hkdfSync("sha256", Buffer.from(raw, "utf8"), KEK_HKDF_SALT, KEK_HKDF_INFO, 32));
}
function deriveKekLegacy(raw: string): Buffer {
  return Buffer.from(raw.slice(0, 32).padEnd(32, "0"));
}
const KEK = deriveKekStrong(KEK_RAW);
const KEK_LEGACY = deriveKekLegacy(KEK_RAW);

function aesEncrypt(key: Buffer, plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return iv.toString("hex") + ":" + enc.toString("hex") + ":" + tag.toString("hex");
}

function aesDecrypt(key: Buffer, packed: string): string {
  const [ivHex, encHex, tagHex] = packed.split(":");
  if (!ivHex || !encHex || !tagHex) throw new Error("Malformed ciphertext (expected iv:ct:tag)");
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
  try {
    return Buffer.from(aesDecrypt(KEK, wrapped), "hex");
  } catch {
    // Wrapped before this hardening landed — see the KEK derivation comment
    // above for why this fallback is safe rather than a weakening.
    return Buffer.from(aesDecrypt(KEK_LEGACY, wrapped), "hex");
  }
}

// In-memory cache: DEK version -> raw 32-byte key. Populated by
// loadKeyManager() at server startup (see index.ts's waitForDbThenMigrate)
// and refreshed after rotateKey(). Never persisted outside this process.
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
 * encryption_keys table migration has run — encryptField()/decryptField()
 * fall back to the legacy key until this completes, so calling it late is
 * safe, just means early-boot writes stay on the legacy format until the
 * next reencrypt-vault run.
 */
export async function loadKeyManager(): Promise<void> {
  const result: any = await db.execute(
    sql`SELECT version, wrapped_dek, active FROM encryption_keys WHERE namespace = ${NAMESPACE} ORDER BY version ASC`
  );
  const rows: any[] = result.rows ?? result;
  if (rows.length === 0) {
    await bootstrapFirstKey();
    return loadKeyManager();
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
 * rows keep decrypting under them until scripts/src/reencrypt-vault.ts moves
 * them onto the new version. Returns the new version number.
 */
export async function rotateKey(): Promise<number> {
  if (!ready) await loadKeyManager();
  const newVersion = (activeVersion ?? 0) + 1;
  const dek = crypto.randomBytes(32);
  await db.execute(sql`UPDATE encryption_keys SET active = FALSE WHERE namespace = ${NAMESPACE}`);
  await db.execute(sql`
    INSERT INTO encryption_keys (namespace, version, wrapped_dek, active)
    VALUES (${NAMESPACE}, ${newVersion}, ${wrapDek(dek)}, TRUE)
  `);
  await loadKeyManager();
  return newVersion;
}

/** Current active DEK version, or null if loadKeyManager() hasn't run yet. */
export function getActiveVersion(): number | null {
  return activeVersion;
}

/** Encrypt a value for storage. Null/undefined/"" pass through unchanged. */
export function encryptField<T extends string | null | undefined>(value: T): T {
  if (value === null || value === undefined || value === "") return value;
  if (!ready || activeVersion === null) {
    // Key manager not loaded yet (very early in boot) — fall back to the
    // legacy key so writes never fail. Self-heals: once loadKeyManager()
    // completes, all subsequent writes use a real DEK automatically.
    return (PREFIX + aesEncrypt(LEGACY_KEY, String(value))) as T;
  }
  const dek = dekCache.get(activeVersion)!;
  return (PREFIX + "v" + activeVersion + ":" + aesEncrypt(dek, String(value))) as T;
}

/**
 * Decrypt a stored value. Legacy plaintext (no "enc:" prefix) is returned
 * as-is. Malformed or unrecoverable ciphertext fails open with a visible
 * marker instead of crashing the response.
 */
export function decryptField<T extends string | null | undefined>(value: T): T {
  if (value === null || value === undefined || value === "") return value;
  const s = String(value);
  if (!s.startsWith(PREFIX)) return value; // legacy plaintext row
  const rest = s.slice(PREFIX.length);
  try {
    const versioned = rest.match(/^v(\d+):(.+)$/);
    if (versioned) {
      const version = Number(versioned[1]);
      const dek = dekCache.get(version);
      if (!dek) return "[decryption failed: unknown key version]" as T;
      return aesDecrypt(dek, versioned[2]) as T;
    }
    // No version marker → pre-KMS ciphertext, decrypt with the legacy key.
    return aesDecrypt(LEGACY_KEY, rest) as T;
  } catch {
    return "[decryption failed]" as T;
  }
}

/** Decrypt a set of fields on a plain object (e.g. a raw-SQL result row). Returns a shallow copy. */
export function decryptRow<T extends Record<string, any>>(row: T, fields: readonly (keyof T)[]): T {
  const out = { ...row };
  for (const f of fields) out[f] = decryptField(out[f] as any);
  return out;
}

export function decryptRows<T extends Record<string, any>>(rows: T[], fields: readonly (keyof T)[]): T[] {
  return rows.map(r => decryptRow(r, fields));
}
