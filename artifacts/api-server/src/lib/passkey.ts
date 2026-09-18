/**
 * lib/passkey.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * WebAuthn (passkey) configuration + short-lived challenge store, shared by
 * routes/passkey.ts. Uses @simplewebauthn/server — WebAuthn's signature
 * verification (COSE keys, CBOR attestation, client-data hashing) is exactly
 * the kind of crypto you don't hand-roll (unlike lib/totp.ts's plain HOTP
 * math, which is simple enough to keep dependency-free).
 *
 * HOW TO TUNE
 *  - Set PASSKEY_RP_ID to your bare domain in production, e.g. "ayzen.tech".
 *    Must match the domain the frontend is served from (no scheme, no port,
 *    no path) — a passkey registered under one RP ID cannot be used to log
 *    in on another.
 *  - Set PASSKEY_ORIGIN to the exact frontend origin, e.g. "https://ayzen.tech".
 *    Falls back to the first entry in ALLOWED_ORIGINS, then to
 *    "http://localhost:5173" for local dev.
 */

import { randomBytes } from "crypto";
import type { Request } from "express";

const isProd = process.env.NODE_ENV === "production";

function firstAllowedOrigin(): string | null {
  const raw = process.env.ALLOWED_ORIGINS;
  if (!raw) return null;
  const first = raw.split(",").map((s) => s.trim()).filter(Boolean)[0];
  return first ?? null;
}

export const rpName = process.env.PASSKEY_RP_NAME || "AYZEN";
export const rpID = process.env.PASSKEY_RP_ID || (isProd ? "ayzen.tech" : "localhost");
export const origin =
  process.env.PASSKEY_ORIGIN || firstAllowedOrigin() || (isProd ? `https://${rpID}` : "http://localhost:5173");

/**
 * Replit previews and published apps are served through a proxy, so the
 * browser's actual origin can differ from the API process' localhost port.
 * Use the request origin when available; WebAuthn requires the exact browser
 * origin and the hostname-only RP ID.
 */
export function getWebAuthnConfig(req: Request): { rpID: string; origin: string } {
  if (process.env.PASSKEY_RP_ID && process.env.PASSKEY_ORIGIN) {
    return { rpID: process.env.PASSKEY_RP_ID, origin: process.env.PASSKEY_ORIGIN };
  }

  const requestOrigin = req.get("origin");
  if (requestOrigin) {
    try {
      const parsed = new URL(requestOrigin);
      return { rpID: parsed.hostname, origin: parsed.origin };
    } catch {
      // Fall through to forwarded host/protocol below.
    }
  }

  const forwardedHost = req.get("x-forwarded-host")?.split(",")[0]?.trim();
  const host = forwardedHost || req.get("host") || rpID;
  const forwardedProto = req.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const protocol = forwardedProto || req.protocol || (isProd ? "https" : "http");
  const hostName = host.replace(/:\d+$/, "");
  return { rpID: hostName, origin: `${protocol}://${host}` };
}

// ─── Challenge store ─────────────────────────────────────────────────────────
// WebAuthn's challenge is single-use and must be verified server-side against
// exactly the one it handed out. Same short-lived in-memory Map pattern as
// the OTP store in routes/auth.ts — fine for a single-process deployment;
// swap for Redis if the API ever runs multiple instances.
interface ChallengeEntry { challenge: string; userId?: number; expiry: number; }
const challengeStore = new Map<string, ChallengeEntry>();

const CHALLENGE_TTL_MS = 5 * 60 * 1000;

export function newChallengeKey(): string {
  return randomBytes(16).toString("hex");
}

export function storeChallenge(key: string, challenge: string, userId?: number) {
  challengeStore.set(key, { challenge, userId, expiry: Date.now() + CHALLENGE_TTL_MS });
}

export function consumeChallenge(key: string): ChallengeEntry | null {
  const entry = challengeStore.get(key);
  challengeStore.delete(key);
  if (!entry) return null;
  if (Date.now() > entry.expiry) return null;
  return entry;
}

// Periodic sweep so long-running processes don't leak abandoned challenges.
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of challengeStore) {
    if (now > entry.expiry) challengeStore.delete(key);
  }
}, 10 * 60 * 1000).unref();
