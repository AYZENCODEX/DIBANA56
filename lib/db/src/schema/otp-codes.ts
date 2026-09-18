import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

/**
 * schema/otp-codes.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * BUG FIX — "code always says expired/invalid, even right after receiving it,
 * even after resend."
 *
 * ROOT CAUSE: lib/otp-store.ts used to keep codes in a plain in-memory
 * `Map()`. That works fine on a single long-running process, but .replit
 * has `deploymentTarget = "autoscale"` — Replit (and Render, where this is
 * also deployed per replit.md) can and does run multiple stateless instances
 * of api-server, and can recycle/restart an instance at any time. Whichever
 * instance handled POST /auth/send-otp stored the code in ITS OWN memory.
 * The very next request (verify, or even a resend) can just as easily land
 * on a different instance — which has never seen that code, so it always
 * looks "expired or invalid" no matter how fast or how many times the user
 * retries. This is not a race condition or a timing bug, it's structural:
 * an in-memory Map can never work correctly behind a multi-instance/
 * autoscale deployment.
 *
 * FIX: move the store into Postgres (this table), which every instance
 * already shares. Codes are hashed (sha256) before being written — same
 * reasoning as never storing plaintext passwords — since a raw 6-digit code
 * sitting in a DB dump/backup would otherwise be trivially replayable during
 * its 10-minute window.
 *
 * `key` is the same arbitrary string lib/otp-store.ts always used: an email
 * address for signup/login/reset codes, or `stepup:<challengeToken>` for the
 * anomalous-IP step-up flow (see routes/passkey.ts). One row per key —
 * requesting a new code (send or resend) overwrites the previous row for
 * that key, so only the most recently sent code is ever valid, matching the
 * old Map's `.set()` semantics.
 */
export const otpCodesTable = pgTable("otp_codes", {
  id: serial("id").primaryKey(),
  key: text("key").notNull().unique(),
  codeHash: text("code_hash").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type OtpCodeRow = typeof otpCodesTable.$inferSelect;
