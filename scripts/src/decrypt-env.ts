// scripts/src/decrypt-env.ts
// ─────────────────────────────────────────────────────────────────────────────
// Decrypts a .env.enc file produced by encrypt-env.ts back into a plaintext
// .env file. Writes to a *.restored path by default so it never silently
// clobbers a live .env — rename it yourself once you've checked the contents.
//
// Usage:
//   ENV_BACKUP_PASSPHRASE="a strong passphrase" npx tsx scripts/src/decrypt-env.ts [path-to-.env.enc] [output-path]
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import crypto from "node:crypto";

const SALT_SIZE = 32;
const IV_SIZE = 12;
const AUTH_TAG_SIZE = 16;
const SCRYPT_N = 2 ** 15;

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  // Must match encrypt-env.ts's maxmem exactly, or valid decrypts will fail.
  return crypto.scryptSync(passphrase, salt, 32, { N: SCRYPT_N, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

function main() {
  const inputPath = process.argv[2] ?? ".env.enc";
  const outputPath = process.argv[3] ?? inputPath.replace(/\.enc$/, "") + ".restored";
  const passphrase = process.env["ENV_BACKUP_PASSPHRASE"] ?? process.argv[4];

  if (!passphrase) {
    console.error(
      "Missing passphrase. Set ENV_BACKUP_PASSPHRASE=\"...\" (preferred) or pass it as a 3rd argument."
    );
    process.exit(1);
  }
  if (!existsSync(inputPath)) {
    console.error(`No file found at ${inputPath}`);
    process.exit(1);
  }

  const blob = Buffer.from(readFileSync(inputPath, "utf8"), "base64");
  const salt = blob.subarray(0, SALT_SIZE);
  const iv = blob.subarray(SALT_SIZE, SALT_SIZE + IV_SIZE);
  const authTag = blob.subarray(SALT_SIZE + IV_SIZE, SALT_SIZE + IV_SIZE + AUTH_TAG_SIZE);
  const ciphertext = blob.subarray(SALT_SIZE + IV_SIZE + AUTH_TAG_SIZE);

  const key = deriveKey(passphrase, salt);

  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    writeFileSync(outputPath, plaintext);
    console.log(`[decrypt-env] Decrypted ${inputPath} -> ${outputPath}`);
    console.log(`[decrypt-env] Review it, then rename to .env when ready:  mv ${outputPath} .env`);
  } catch {
    console.error("Decryption failed — wrong passphrase, or the file is corrupted/tampered with.");
    process.exit(1);
  }
}

main();
