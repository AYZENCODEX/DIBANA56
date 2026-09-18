// scripts/src/encrypt-env.ts
// ─────────────────────────────────────────────────────────────────────────────
// Encrypts a .env file into a single portable backup blob (AES-256-GCM,
// scrypt key derivation from a passphrase you supply — same authenticated-
// encryption approach as artifacts/api-server/src/lib/wallet-crypto.ts).
//
// Store the resulting .env.enc file wherever you like (a private repo,
// cloud storage, a password manager attachment) — it's useless without the
// passphrase, which you should NOT store next to it.
//
// Usage:
//   ENV_BACKUP_PASSPHRASE="a strong passphrase" npx tsx scripts/src/encrypt-env.ts [path-to-.env] [output-path]
//
// Defaults: reads ./.env, writes ./.env.enc
//
// SECURITY: prefer the env var over a CLI arg for the passphrase — CLI args
// can end up in shell history / process listings.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import crypto from "node:crypto";

const SALT_SIZE = 32;
const IV_SIZE = 12;
const SCRYPT_N = 2 ** 15;

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  // maxmem must be raised explicitly — Node's default scrypt memory cap
  // (32MB) is too tight for N=2^15 with r=8 and rejects the call otherwise.
  return crypto.scryptSync(passphrase, salt, 32, { N: SCRYPT_N, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

function main() {
  const inputPath = process.argv[2] ?? ".env";
  const outputPath = process.argv[3] ?? `${inputPath}.enc`;
  const passphrase = process.env["ENV_BACKUP_PASSPHRASE"] ?? process.argv[4];

  if (!passphrase) {
    console.error(
      "Missing passphrase. Set ENV_BACKUP_PASSPHRASE=\"...\" (preferred) or pass it as a 3rd argument.\n" +
      `Usage: ENV_BACKUP_PASSPHRASE="..." npx tsx scripts/src/encrypt-env.ts [${inputPath}] [${outputPath}]`
    );
    process.exit(1);
  }
  if (!existsSync(inputPath)) {
    console.error(`No file found at ${inputPath}`);
    process.exit(1);
  }

  const plaintext = readFileSync(inputPath);
  const salt = crypto.randomBytes(SALT_SIZE);
  const iv = crypto.randomBytes(IV_SIZE);
  const key = deriveKey(passphrase, salt);

  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // Blob layout: salt(32) | iv(12) | authTag(16) | ciphertext
  const blob = Buffer.concat([salt, iv, authTag, ciphertext]);
  writeFileSync(outputPath, blob.toString("base64"));

  console.log(`[encrypt-env] Encrypted ${inputPath} -> ${outputPath} (${blob.length} bytes)`);
  console.log(`[encrypt-env] Keep the passphrase somewhere separate from this file — without it, ${outputPath} cannot be recovered.`);
}

main();
