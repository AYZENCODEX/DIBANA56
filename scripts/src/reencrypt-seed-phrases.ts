// scripts/src/reencrypt-seed-phrases.ts
// ─────────────────────────────────────────────────────────────────────────────
// One-time migration companion for routes/vault.ts's seed-phrase security
// fix: crypto wallet seed phrases (vault_entries.encrypted_seed_phrase) used
// to be encrypted with a key derived from SESSION_SECRET, falling back to a
// hardcoded literal ("ayzen_default_seed_key_32bytes!!") if that env var was
// unset. That fallback/reuse has been removed — routes/vault.ts now requires
// a dedicated VAULT_SEED_ENCRYPTION_KEY and refuses to start without one.
//
// This script decrypts every existing encrypted_seed_phrase under the OLD
// key derivation and re-encrypts it under the NEW dedicated key, in the same
// iv:tag:ciphertext format routes/vault.ts already reads (no version prefix
// — vault.ts's seed-phrase store has never been versioned, unlike
// lib/vault-crypto.ts's field encryption, which is why this script exists
// separately from reencrypt-vault.ts rather than folding into it — see the
// scope note in that file).
//
// Usage:
//   DATABASE_URL=... \
//   OLD_SESSION_SECRET=<the SESSION_SECRET this deployment ran with before, \
//     or omit entirely if it was never set and rows were encrypted under the \
//     hardcoded fallback> \
//   VAULT_SEED_ENCRYPTION_KEY=<new key already set for the API server> \
//     npx tsx scripts/src/reencrypt-seed-phrases.ts [--batch-size=500] [--dry-run]
//
// Safe to run more than once — rows that fail to decrypt under the old key
// are left untouched and logged, not blanked, so a second run with a
// corrected OLD_SESSION_SECRET can still pick them up.
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import crypto from "node:crypto";

// ── Old key derivation — must match the removed code in routes/vault.ts ────
// If OLD_SESSION_SECRET isn't set, rows were encrypted under the old
// hardcoded fallback literal — reproduce that exactly, don't guess.
const OLD_SEED_KEY = process.env["OLD_SESSION_SECRET"] ?? "ayzen_default_seed_key_32bytes!!";
const OLD_KEY_BUF = crypto.scryptSync(OLD_SEED_KEY, "ayzen_seed_salt", 32);

// ── New key — same requirement routes/vault.ts enforces at boot ────────────
const NEW_SEED_KEY_RAW = process.env["VAULT_SEED_ENCRYPTION_KEY"];
if (!NEW_SEED_KEY_RAW || NEW_SEED_KEY_RAW.length < 32) {
  console.error(
    "VAULT_SEED_ENCRYPTION_KEY is missing or shorter than 32 characters — set it to the exact " +
    "same value the API server is now configured with before running this migration."
  );
  process.exit(1);
}
const NEW_KEY_BUF = crypto.scryptSync(NEW_SEED_KEY_RAW, "ayzen_seed_salt", 32);

function decryptOld(stored: string): string | null {
  try {
    const [ivHex, tagHex, encHex] = stored.split(":");
    if (!ivHex || !tagHex || !encHex) return null;
    const iv = Buffer.from(ivHex, "hex");
    const tag = Buffer.from(tagHex, "hex");
    const enc = Buffer.from(encHex, "hex");
    const decipher = crypto.createDecipheriv("aes-256-gcm", OLD_KEY_BUF, iv);
    decipher.setAuthTag(tag);
    return decipher.update(enc).toString("utf8") + decipher.final("utf8");
  } catch {
    return null;
  }
}

function encryptNew(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", NEW_KEY_BUF, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return iv.toString("hex") + ":" + tag.toString("hex") + ":" + enc.toString("hex");
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const batchSize = parseInt(args.find(a => a.startsWith("--batch-size="))?.split("=")[1] ?? "500", 10);

  if (OLD_SEED_KEY === "ayzen_default_seed_key_32bytes!!") {
    console.log("[reencrypt-seed-phrases] OLD_SESSION_SECRET not set — assuming rows were encrypted under the hardcoded fallback key.");
  }
  console.log(`[reencrypt-seed-phrases] Starting${dryRun ? " (dry run — no writes)" : ""}, batch size ${batchSize}.`);

  let migrated = 0;
  let failed = 0;
  let lastId = 0;

  for (;;) {
    const result: any = await db.execute(sql.raw(
      `SELECT id, encrypted_seed_phrase FROM vault_entries ` +
      `WHERE encrypted_seed_phrase IS NOT NULL AND id > ${lastId} ` +
      `ORDER BY id LIMIT ${batchSize}`
    ));
    const rows: any[] = result.rows ?? result;
    if (rows.length === 0) break;

    for (const row of rows) {
      lastId = row.id;
      const stored = row.encrypted_seed_phrase as string | null;
      if (!stored) continue;

      const plain = decryptOld(stored);
      if (plain === null) {
        console.warn(`[reencrypt-seed-phrases] vault_entries#${row.id}: could not decrypt under old key — skipped, left unchanged (may already be migrated, or OLD_SESSION_SECRET is wrong).`);
        failed++;
        continue;
      }

      const reencrypted = encryptNew(plain);
      if (!dryRun) {
        await db.execute(sql.raw(
          `UPDATE vault_entries SET encrypted_seed_phrase = '${reencrypted.replace(/'/g, "''")}' WHERE id = ${row.id}`
        ));
      }
      migrated++;
    }

    console.log(`[reencrypt-seed-phrases] ${migrated} migrated, ${failed} skipped so far (last id ${lastId})...`);
    if (rows.length < batchSize) break;
  }

  console.log(`[reencrypt-seed-phrases] Complete. ${migrated} row(s) ${dryRun ? "would be " : ""}migrated, ${failed} row(s) skipped (see warnings above).`);
  if (failed > 0) {
    console.log(`[reencrypt-seed-phrases] Skipped rows are UNCHANGED — still encrypted under the old key. Re-run with the correct OLD_SESSION_SECRET to pick them up before removing the old key from anywhere it's still recoverable.`);
  }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("[reencrypt-seed-phrases] Fatal error:", err);
  process.exit(1);
});
