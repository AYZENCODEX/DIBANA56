/**
 * lib/otp-store.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * BUG FIX — "code always says expired/invalid, even right after receiving
 * it, even after resend."
 *
 * This used to be an in-memory `Map()`, which cannot work correctly once
 * more than one api-server instance is running (this app deploys with
 * `deploymentTarget = "autoscale"` — see .replit — and separately to Render
 * per replit.md). Whichever instance handles POST /auth/send-otp stores the
 * code in ITS OWN process memory; the next request (verify, or a resend)
 * can land on a different instance that never saw it, so the code always
 * comes back "invalid or expired" — not a timing issue, a structural one.
 *
 * Now backed by the `otp_codes` Postgres table (shared by every instance).
 * Codes are hashed (sha256) before being stored, same reasoning as never
 * storing plaintext passwords — see lib/db/src/schema/otp-codes.ts for the
 * full write-up.
 *
 * Used by routes/auth.ts (email verification during signup/signin, login
 * codes, password-reset codes) and routes/passkey.ts (the email factor of
 * the anomalous-IP step-up chain — see lib/login-security.ts). Keyed by an
 * arbitrary string (an email address, or `stepup:<challengeToken>` for
 * step-up codes) so both call sites share the same store without colliding.
 */
import { createHash, timingSafeEqual, randomInt } from "crypto";
import { eq, lt } from "drizzle-orm";
import { db, otpCodesTable } from "@workspace/db";

const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes — matches every "expires in 10 minutes" email copy in routes/auth.ts

export function generateOtp(): string {
  // Cryptographically random, not Math.random() — six digits, 000000-999999.
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

function hashCode(code: string): string {
  return createHash("sha256").update(code.trim()).digest("hex");
}

export async function storeOtp(key: string, code: string): Promise<void> {
  const k = key.toLowerCase();
  const codeHash = hashCode(code);
  const expiresAt = new Date(Date.now() + OTP_TTL_MS);

  // One row per key — a new send/resend replaces whatever code was there
  // before, so only the most recently issued code is ever valid.
  await db
    .insert(otpCodesTable)
    .values({ key: k, codeHash, expiresAt })
    .onConflictDoUpdate({
      target: otpCodesTable.key,
      set: { codeHash, expiresAt, createdAt: new Date() },
    });
}

export async function verifyOtp(key: string, code: string): Promise<boolean> {
  const k = key.toLowerCase();
  const [row] = await db.select().from(otpCodesTable).where(eq(otpCodesTable.key, k)).limit(1);
  if (!row) return false;

  if (Date.now() > row.expiresAt.getTime()) {
    await db.delete(otpCodesTable).where(eq(otpCodesTable.key, k));
    return false;
  }

  const candidate = Buffer.from(hashCode(code));
  const stored = Buffer.from(row.codeHash);
  const matches = candidate.length === stored.length && timingSafeEqual(candidate, stored);

  // Single-use either way, matching the old Map's delete-on-check semantics —
  // a wrong guess doesn't get unlimited retries against the same code.
  await db.delete(otpCodesTable).where(eq(otpCodesTable.key, k));
  return matches;
}

/** Best-effort cleanup of rows past their expiry — call occasionally (e.g. from a cron/uptime tick) so the table doesn't grow unbounded. Not required for correctness: verifyOtp already treats an expired row as invalid. */
export async function pruneExpiredOtps(): Promise<void> {
  await db.delete(otpCodesTable).where(lt(otpCodesTable.expiresAt, new Date()));
}
