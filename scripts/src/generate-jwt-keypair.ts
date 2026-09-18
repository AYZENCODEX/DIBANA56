// scripts/src/generate-jwt-keypair.ts
// ─────────────────────────────────────────────────────────────────────────────
// OIDC Roadmap — Season 1, Phase 1A (Crypto Foundation, part A).
//
// Generates one RSA-2048 keypair for RS256 session-token signing (see
// lib/jwt-keys.ts / lib/jwt.ts) and prints it ready to paste into your
// environment (.env, hosting provider secrets, etc). Run this once per
// keypair — Phase 1B adds a proper rotation flow that generates a new one
// alongside the old (still-valid-for-verification) key instead of replacing
// it outright.
//
// Usage:
//   npx tsx scripts/src/generate-jwt-keypair.ts
//
// SECURITY: the private key is printed to stdout in plaintext. Pipe it
// straight into your secret manager / .env file and don't leave it sitting
// in shell history or a CI log.
import { generateKeyPairSync, randomBytes } from "node:crypto";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const kid = randomBytes(8).toString("hex");

// Env vars can't hold real newlines on a single line, so ship the \n-escaped
// form — lib/jwt-keys.ts's normalizePem() un-escapes it back on load.
const escapedPrivate = privateKey.trim().replace(/\n/g, "\\n");
const escapedPublic = publicKey.trim().replace(/\n/g, "\\n");

console.log("# Generated RS256 keypair for AYZEN session tokens (Phase 1A).");
console.log("# Paste these into your environment. Keep the private key secret.");
console.log("");
console.log(`AYZEN_JWT_KID=${kid}`);
console.log(`AYZEN_JWT_PRIVATE_KEY="${escapedPrivate}"`);
console.log(`AYZEN_JWT_PUBLIC_KEY="${escapedPublic}"`);
console.log("");
console.log("# Optional grace period while old HS256 sessions expire naturally (7d):");
console.log("# ALLOW_LEGACY_HS256_TOKENS=true");
