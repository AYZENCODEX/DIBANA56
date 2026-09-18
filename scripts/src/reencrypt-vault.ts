// scripts/src/reencrypt-vault.ts
// ─────────────────────────────────────────────────────────────────────────────
// Migration + key-rotation companion for lib/vault-crypto.ts's KMS-style
// envelope encryption. Two jobs, one script:
//
//   1. RE-ENCRYPT: find rows whose sensitive columns are still on an older
//      key version (or still pre-KMS plaintext/legacy ciphertext) and
//      re-encrypt them under the current active DEK, stamping
//      encryption_version so they're not touched again next run.
//   2. ROTATE (--rotate): generate a brand new DEK, make it active, THEN do
//      the re-encrypt pass above so existing data actually moves onto it.
//      Without --rotate this script just catches up any rows that predate
//      the KMS layer or a previous rotation — safe to run repeatedly, e.g.
//      as a scheduled background job (it always LIMITs to a batch and exits,
//      so a cron/Render job calling this every few minutes will eventually
//      converge without ever holding a long-running transaction open).
//
// Usage:
//   DATABASE_URL=... VAULT_FIELD_ENCRYPTION_KEY=... [VAULT_MASTER_KEY=...] \
//     npx tsx scripts/src/reencrypt-vault.ts [--rotate] [--table=vault_entries] [--batch-size=500] [--dry-run]
//
// Notes:
//   - Uses the exact same ciphertext format and key-wrapping as
//     lib/vault-crypto.ts (kept in sync here rather than imported, since
//     scripts/ doesn't depend on the api-server package — see that file for
//     the design note this mirrors).
//   - Only covers lib/vault-crypto.ts's namespace ("vault"). Wallet recovery
//     phrases (lib/wallet-crypto.ts, wallets.encrypted_phrase /
//     vault_entries.encrypted_seed_phrase) are a separate key entirely and
//     out of scope here — give them their own script if/when that gets the
//     same KMS treatment.
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import crypto from "node:crypto";

const NAMESPACE = "vault";
const PREFIX = "enc:";

const LEGACY_KEY_RAW = process.env["VAULT_FIELD_ENCRYPTION_KEY"];
if (!LEGACY_KEY_RAW || LEGACY_KEY_RAW.length < 32) {
  console.error("VAULT_FIELD_ENCRYPTION_KEY is missing or shorter than 32 characters — required to read pre-KMS rows.");
  process.exit(1);
}
const LEGACY_KEY = Buffer.from(LEGACY_KEY_RAW.slice(0, 32).padEnd(32, "0"));
const KEK = Buffer.from((process.env["VAULT_MASTER_KEY"] || LEGACY_KEY_RAW).slice(0, 32).padEnd(32, "0"));

function aesEncrypt(key: Buffer, plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return iv.toString("hex") + ":" + enc.toString("hex") + ":" + tag.toString("hex");
}
function aesDecrypt(key: Buffer, packed: string): string {
  const [ivHex, encHex, tagHex] = packed.split(":");
  if (!ivHex || !encHex || !tagHex) throw new Error("Malformed ciphertext");
  const iv = Buffer.from(ivHex, "hex");
  const enc = Buffer.from(encHex, "hex");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}
function wrapDek(dek: Buffer): string { return aesEncrypt(KEK, dek.toString("hex")); }
function unwrapDek(wrapped: string): Buffer { return Buffer.from(aesDecrypt(KEK, wrapped), "hex"); }

const dekCache = new Map<number, Buffer>();
let activeVersion: number | null = null;

async function loadKeys(): Promise<void> {
  const result: any = await db.execute(
    sql`SELECT version, wrapped_dek, active FROM encryption_keys WHERE namespace = ${NAMESPACE} ORDER BY version ASC`
  );
  const rows: any[] = result.rows ?? result;
  if (rows.length === 0) {
    console.error("No encryption_keys rows for namespace 'vault' — start the API server at least once first (it bootstraps v1).");
    process.exit(1);
  }
  dekCache.clear();
  activeVersion = null;
  for (const r of rows) {
    dekCache.set(Number(r.version), unwrapDek(r.wrapped_dek));
    if (r.active) activeVersion = Number(r.version);
  }
  if (activeVersion === null) activeVersion = Number(rows[rows.length - 1].version);
}

async function rotate(): Promise<number> {
  const newVersion = (activeVersion ?? 0) + 1;
  const dek = crypto.randomBytes(32);
  await db.execute(sql`UPDATE encryption_keys SET active = FALSE WHERE namespace = ${NAMESPACE}`);
  await db.execute(sql`
    INSERT INTO encryption_keys (namespace, version, wrapped_dek, active)
    VALUES (${NAMESPACE}, ${newVersion}, ${wrapDek(dek)}, TRUE)
  `);
  await loadKeys();
  console.log(`[reencrypt-vault] Rotated: new active DEK is v${newVersion}.`);
  return newVersion;
}

function decryptAny(value: string | null): string | null {
  if (value === null || value === "") return value;
  if (!value.startsWith(PREFIX)) return value; // legacy plaintext
  const rest = value.slice(PREFIX.length);
  const versioned = rest.match(/^v(\d+):(.+)$/);
  if (versioned) {
    const dek = dekCache.get(Number(versioned[1]));
    if (!dek) throw new Error(`Unknown key version v${versioned[1]} — do you have the right VAULT_MASTER_KEY?`);
    return aesDecrypt(dek, versioned[2]);
  }
  return aesDecrypt(LEGACY_KEY, rest); // pre-KMS ciphertext
}
function encryptActive(plain: string | null): string | null {
  if (plain === null || plain === "") return plain;
  const dek = dekCache.get(activeVersion!)!;
  return PREFIX + "v" + activeVersion + ":" + aesEncrypt(dek, plain);
}

// ── Table config: every table with columns lib/vault-crypto.ts encrypts ────
interface TableConfig { table: string; idCol: string; versionCol: string; columns: string[]; }
const TABLES: TableConfig[] = [
  {
    table: "vault_entries", idCol: "id", versionCol: "encryption_version",
    columns: [
      "account_password", "email_password", "email_2fa", "email_backup_code", "email_recovery_password",
      "recovery_2fa", "recovery_backup_code",
      "twitter_password", "twitter_email_password", "twitter_2fa", "twitter_email_recovery_password",
      "discord_password", "discord_email_password", "discord_2fa", "discord_email_recovery_password",
      "telegram_password", "telegram_linked_email_password", "telegram_2fa",
      "backup_codes", "other_accounts",
    ],
  },
  { table: "kyc_entries", idCol: "id", versionCol: "encryption_version",
    columns: ["account_password", "email_password", "email_2fa", "email_backup_code", "nid_number"] },
  { table: "local_accounts", idCol: "id", versionCol: "encryption_version",
    columns: ["password", "recovery_email_password", "backup_codes", "twofa", "recovery_email_twofa"] },
  { table: "game_entries", idCol: "id", versionCol: "encryption_version",
    columns: ["account_password", "email_password", "email_2fa", "email_backup_code"] },
  { table: "other_two_factor_codes", idCol: "id", versionCol: "encryption_version",
    columns: ["totp_secret", "backup_codes"] },
  { table: "email_accounts", idCol: "id", versionCol: "encryption_version",
    columns: ["password", "auth_key"] },
  { table: "mail_messages", idCol: "id", versionCol: "encryption_version",
    columns: ["body_text"] },
];

async function reencryptTable(cfg: TableConfig, batchSize: number, dryRun: boolean): Promise<number> {
  const colList = cfg.columns.map(c => `"${c}"`).join(", ");
  let migrated = 0;
  for (;;) {
    const result: any = await db.execute(sql.raw(
      `SELECT "${cfg.idCol}", ${colList} FROM "${cfg.table}" ` +
      `WHERE "${cfg.versionCol}" IS NULL OR "${cfg.versionCol}" < ${activeVersion} ` +
      `ORDER BY "${cfg.idCol}" LIMIT ${batchSize}`
    ));
    const rows: any[] = result.rows ?? result;
    if (rows.length === 0) break;

    for (const row of rows) {
      const sets: string[] = [];
      for (const col of cfg.columns) {
        const raw = row[col];
        if (raw === null || raw === undefined || raw === "") continue;
        let plain: string;
        try {
          plain = decryptAny(String(raw))!;
        } catch (err: any) {
          console.warn(`[reencrypt-vault] ${cfg.table}#${row[cfg.idCol]}.${col}: skip (${err?.message ?? err})`);
          continue;
        }
        const reencrypted = encryptActive(plain);
        sets.push(`"${col}" = '${String(reencrypted).replace(/'/g, "''")}'`);
      }
      sets.push(`"${cfg.versionCol}" = ${activeVersion}`);
      if (!dryRun) {
        await db.execute(sql.raw(
          `UPDATE "${cfg.table}" SET ${sets.join(", ")} WHERE "${cfg.idCol}" = ${row[cfg.idCol]}`
        ));
      }
      migrated++;
    }
    console.log(`[reencrypt-vault] ${cfg.table}: ${migrated} row(s) ${dryRun ? "would be " : ""}migrated so far...`);
    if (rows.length < batchSize) break;
  }
  return migrated;
}

async function main() {
  const args = process.argv.slice(2);
  const shouldRotate = args.includes("--rotate");
  const dryRun = args.includes("--dry-run");
  const tableArg = args.find(a => a.startsWith("--table="))?.split("=")[1];
  const batchSize = parseInt(args.find(a => a.startsWith("--batch-size="))?.split("=")[1] ?? "500", 10);

  await loadKeys();
  console.log(`[reencrypt-vault] Active DEK before run: v${activeVersion}`);

  if (shouldRotate) await rotate();
  console.log(`[reencrypt-vault] Target key version: v${activeVersion}${dryRun ? " (dry run — no writes)" : ""}`);

  const targets = tableArg ? TABLES.filter(t => t.table === tableArg) : TABLES;
  if (tableArg && targets.length === 0) {
    console.error(`Unknown --table=${tableArg}. Known tables: ${TABLES.map(t => t.table).join(", ")}`);
    process.exit(1);
  }

  let total = 0;
  for (const cfg of targets) {
    const n = await reencryptTable(cfg, batchSize, dryRun);
    total += n;
    console.log(`[reencrypt-vault] ${cfg.table}: done, ${n} row(s) migrated.`);
  }
  console.log(`[reencrypt-vault] Complete. ${total} row(s) total ${dryRun ? "would be " : ""}migrated to v${activeVersion}.`);
  process.exit(0);
}

main().catch((err) => {
  console.error("[reencrypt-vault] Fatal error:", err);
  process.exit(1);
});
