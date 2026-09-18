/**
 * lib/login-security.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Anomalous-IP login detection + step-up (multi-factor) verification chain.
 *
 * How it fits together with routes/auth.ts:
 *   1. POST /auth/login checks password as usual.
 *   2. isAnomalousIp() compares the request IP against this account's
 *      history of *successful* logins. An IP never seen before on a
 *      successful login is "anomalous" — a brand-new account (no history
 *      yet) is NOT anomalous, so the very first login never gets blocked.
 *   3. If anomalous, we do NOT issue a session token yet. Instead we open a
 *      "login challenge" that lists every verification method this account
 *      actually has available (email code is always included; TOTP 2FA,
 *      backup code, and passkey are added only if the account has them set
 *      up) and require ALL of them to pass, one by one, before a token is
 *      issued. This is intentionally stricter than a normal step-up flow
 *      (which usually only asks for one factor) because the request is
 *      explicit: every configured auth method must clear before an
 *      anomalous-IP login succeeds.
 *   4. Each factor is verified via POST /auth/login/step-up/verify (or, for
 *      passkey, via POST /passkey/login/verify with a challengeToken — see
 *      routes/passkey.ts) until requiredMethods ⊆ completedMethods, at
 *      which point the real session token is issued.
 *
 * Storage follows the same "raw SQL, migrated via the MIGRATIONS array in
 * index.ts" convention as vault_shares / user_backup_codes elsewhere in this
 * codebase, rather than a Drizzle schema file.
 */
import { pool } from "@workspace/db";
import crypto from "node:crypto";
import type { Request } from "express";

export type StepUpMethod = "email_otp" | "totp" | "backup_code" | "passkey";

const CHALLENGE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const IP_HISTORY_LOOKBACK = 50; // how many recent successful logins to compare against
const MAX_CHALLENGE_ATTEMPTS = 8; // across ALL methods combined, to blunt brute-forcing a backup code or TOTP

/** Best-effort real client IP, honoring the app's `trust proxy` setting (see app.ts). */
export function getClientIp(req: Request): string {
  return (req.ip || (req.socket && req.socket.remoteAddress) || "unknown").replace(/^::ffff:/, "");
}

/**
 * An IP counts as anomalous if the account has at least one prior successful
 * login AND this IP does not appear among its recent successful-login IPs.
 * A first-ever login has nothing to compare against, so it's never flagged.
 */
export async function isAnomalousIp(userId: number, ip: string): Promise<boolean> {
  const r = await pool.query(
    `SELECT ip FROM login_history WHERE user_id = $1 AND status = 'success' ORDER BY created_at DESC LIMIT $2`,
    [userId, IP_HISTORY_LOOKBACK],
  );
  if (r.rows.length === 0) return false; // no baseline yet — don't block the first login
  return !r.rows.some((row: any) => row.ip === ip);
}

export async function recordLoginHistory(params: {
  userId: number;
  ip: string;
  userAgent: string | null;
  status: "success" | "failed" | "pending_verification";
  anomalous: boolean;
  method?: string;
}): Promise<number> {
  const { userId, ip, userAgent, status, anomalous, method = "password" } = params;
  const r = await pool.query(
    `INSERT INTO login_history (user_id, ip, user_agent, status, anomalous, method)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [userId, ip, userAgent, status, anomalous, method],
  );
  return r.rows[0].id;
}

export async function markLoginHistoryStatus(id: number, status: "success" | "failed"): Promise<void> {
  await pool.query(`UPDATE login_history SET status = $1 WHERE id = $2`, [status, id]);
}

/** Which step-up methods this account actually has configured, in a fixed, predictable order. */
export async function availableStepUpMethods(userId: number): Promise<StepUpMethod[]> {
  const methods: StepUpMethod[] = ["email_otp"]; // every account has an email — always required

  const [twoFa, backupCodes, passkeys] = await Promise.all([
    pool.query(`SELECT two_fa_enabled, two_fa_secret FROM users WHERE id = $1`, [userId]),
    pool.query(`SELECT 1 FROM user_backup_codes WHERE user_id = $1 AND is_used = FALSE LIMIT 1`, [userId]),
    pool.query(`SELECT 1 FROM passkey_credentials WHERE user_id = $1 LIMIT 1`, [userId]),
  ]);

  if (twoFa.rows[0]?.two_fa_enabled && twoFa.rows[0]?.two_fa_secret) methods.push("totp");
  if (backupCodes.rows.length > 0) methods.push("backup_code");
  if (passkeys.rows.length > 0) methods.push("passkey");

  return methods;
}

function generateChallengeToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

export interface LoginChallenge {
  id: number;
  userId: number;
  token: string;
  ip: string;
  userAgent: string | null;
  requiredMethods: StepUpMethod[];
  completedMethods: StepUpMethod[];
  status: "pending" | "verified" | "expired";
  attempts: number;
  loginHistoryId: number | null;
  createdAt: Date;
  expiresAt: Date;
}

function rowToChallenge(row: any): LoginChallenge {
  return {
    id: row.id,
    userId: row.user_id,
    token: row.token,
    ip: row.ip,
    userAgent: row.user_agent,
    requiredMethods: JSON.parse(row.required_methods),
    completedMethods: JSON.parse(row.completed_methods),
    status: row.status,
    attempts: row.attempts,
    loginHistoryId: row.login_history_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

export async function createLoginChallenge(params: {
  userId: number;
  ip: string;
  userAgent: string | null;
  requiredMethods: StepUpMethod[];
  loginHistoryId: number;
  /** Factors already satisfied before the challenge was opened — e.g. a
   *  passkey login is itself strong enough that it shouldn't need to be
   *  redone as part of its own step-up chain. */
  initialCompletedMethods?: StepUpMethod[];
}): Promise<LoginChallenge> {
  const token = generateChallengeToken();
  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS);
  const completed = params.initialCompletedMethods ?? [];
  const isDone = params.requiredMethods.every((m) => completed.includes(m));
  const r = await pool.query(
    `INSERT INTO login_challenges (user_id, token, ip, user_agent, required_methods, completed_methods, status, login_history_id, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [params.userId, token, params.ip, params.userAgent, JSON.stringify(params.requiredMethods), JSON.stringify(completed), isDone ? "verified" : "pending", params.loginHistoryId, expiresAt],
  );
  return rowToChallenge(r.rows[0]);
}

export async function getLoginChallenge(token: string): Promise<LoginChallenge | null> {
  const r = await pool.query(`SELECT * FROM login_challenges WHERE token = $1`, [token]);
  if (!r.rows.length) return null;
  const challenge = rowToChallenge(r.rows[0]);
  if (challenge.status === "pending" && challenge.expiresAt.getTime() < Date.now()) {
    await pool.query(`UPDATE login_challenges SET status = 'expired' WHERE id = $1`, [challenge.id]);
    challenge.status = "expired";
  }
  return challenge;
}

/** Marks one factor as complete and returns the updated challenge (or null if not found/expired). */
export async function markStepUpMethodComplete(token: string, method: StepUpMethod): Promise<LoginChallenge | null> {
  const challenge = await getLoginChallenge(token);
  if (!challenge || challenge.status !== "pending") return challenge;

  const completed = new Set(challenge.completedMethods);
  completed.add(method);
  const isDone = challenge.requiredMethods.every((m) => completed.has(m));

  const r = await pool.query(
    `UPDATE login_challenges SET completed_methods = $1, status = $2 WHERE id = $3 RETURNING *`,
    [JSON.stringify([...completed]), isDone ? "verified" : "pending", challenge.id],
  );
  return rowToChallenge(r.rows[0]);
}

/** Increments the failed-attempt counter and locks the challenge out (expires it) once MAX_CHALLENGE_ATTEMPTS is hit. Returns the resulting attempt count and whether it just got locked out. */
export async function bumpChallengeAttempts(token: string): Promise<{ attempts: number; lockedOut: boolean }> {
  const r = await pool.query(
    `UPDATE login_challenges SET attempts = attempts + 1 WHERE token = $1 AND status = 'pending' RETURNING attempts`,
    [token],
  );
  const attempts = r.rows[0]?.attempts ?? 0;
  const lockedOut = attempts >= MAX_CHALLENGE_ATTEMPTS;
  if (lockedOut) {
    await pool.query(`UPDATE login_challenges SET status = 'expired' WHERE token = $1`, [token]);
  }
  return { attempts, lockedOut };
}

export function stepUpOtpKey(challengeToken: string): string {
  return `stepup:${challengeToken}`;
}
