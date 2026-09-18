/**
 * lib/totp.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Minimal RFC 6238 TOTP implementation (base32 secret, HMAC-SHA1, 30s step,
 * 6 digits). Previously lived only inside routes/security.ts (account 2FA
 * setup/verify/disable) — pulled out here so routes/vault-reauth.ts (Vault's
 * password + 2FA re-auth gate) can verify against the same `users.two_fa_secret`
 * without duplicating the HOTP/TOTP math a second time.
 */
import crypto from "crypto";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function generateBase32Secret(byteLength = 20): string {
  const bytes = crypto.randomBytes(byteLength);
  let bits = "";
  for (const b of bytes) bits += b.toString(2).padStart(8, "0");
  let out = "";
  for (let i = 0; i + 5 <= bits.length; i += 5) {
    out += BASE32_ALPHABET[parseInt(bits.slice(i, i + 5), 2)];
  }
  return out;
}

function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = "";
  for (const c of clean) {
    const idx = BASE32_ALPHABET.indexOf(c);
    if (idx === -1) continue;
    bits += idx.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

function hotp(secret: string, counter: number): string {
  const key = base32Decode(secret);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac("sha1", key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(code % 1_000_000).padStart(6, "0");
}

export function totpGenerate(secret: string, step = 30): string {
  const counter = Math.floor(Date.now() / 1000 / step);
  return hotp(secret, counter);
}

/** Verifies a 6-digit code against `secret`, allowing ±1 step of clock drift. */
export function totpVerify(token: string, secret: string, step = 30, window = 1): boolean {
  if (!token || !secret) return false;
  const counter = Math.floor(Date.now() / 1000 / step);
  const clean = token.replace(/\s/g, "");
  for (let errWindow = -window; errWindow <= window; errWindow++) {
    if (hotp(secret, counter + errWindow) === clean) return true;
  }
  return false;
}

export function totpUri(secret: string, email: string, issuer = "AYZEN"): string {
  const label = encodeURIComponent(`${issuer}:${email}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
