/**
 * lib/sessions.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN account sessions — the "Google-style" device list.
 *
 * AYZEN's Mail, Vault, Finance, and Marketplace surfaces are all routes
 * inside one SPA (see artifacts/ayzen/src/lib/route-config.tsx), so a single
 * login token already grants access to all of them — that part of "SSO
 * across sub-apps" was already true for free. What was missing is what
 * every real account system (Google, GitHub, etc.) builds on top of that:
 * a durable, revocable record of *which* sign-ins are currently valid, so
 * the account owner can see "this session is signed in on Chrome/Windows,
 * last active 2 minutes ago" and kill it remotely — including from a
 * device that was lost/stolen, without knowing its password.
 *
 * Previously every AYZEN auth token was a bare JWT with no way to revoke a
 * single one short of rotating the signing key (which would kill every
 * session for every user at once — see lib/jwt-keys.ts for the current
 * RS256 keypair; this was AYZEN_JWT_SECRET back when tokens were HS256).
 * This file adds a `user_sessions` table
 * (see the CREATE TABLE in index.ts's MIGRATIONS array) that each login
 * writes a row to, and threads a `sid` (session id) claim through the JWT
 * (see lib/jwt.ts) so a specific token can be looked up and revoked without
 * touching anyone else's session or the account password.
 *
 * Tokens signed before this shipped simply have no `sid` claim — they keep
 * working exactly as before (isSessionRevoked treats an unknown/missing sid
 * as "not revoked") until they expire naturally 7 days after issuance.
 */
import { pool } from "@workspace/db";
import crypto from "node:crypto";

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // matches DEFAULT_EXPIRY in lib/jwt.ts

export interface UserSession {
  id: number;
  userId: number;
  jti: string;
  deviceLabel: string;
  ip: string | null;
  userAgent: string | null;
  createdAt: Date;
  lastSeenAt: Date;
  revokedAt: Date | null;
  expiresAt: Date;
  /**
   * OIDC Roadmap — Season 3, Phase 6e-b (migration 086). The
   * `oidc_clients.client_id` this session was opened on behalf of via
   * `POST /auth/session-exchange` (e.g. `'sylo'`), or `null` for every
   * ordinary Central login and for the pre-existing AYZEN Astra extension
   * exchange — neither of which is "on behalf of" any OIDC client. See
   * `createSession()`'s own doc comment and `revokeSessionsByUserAndOriginClient()`
   * below, its one reader.
   */
  originClientId: string | null;
}

function rowToSession(row: any): UserSession {
  return {
    id: row.id,
    userId: row.user_id,
    jti: row.jti,
    deviceLabel: row.device_label,
    ip: row.ip,
    userAgent: row.user_agent,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    revokedAt: row.revoked_at,
    expiresAt: row.expires_at,
    originClientId: row.origin_client_id ?? null,
  };
}

export function generateSessionId(): string {
  return crypto.randomBytes(24).toString("hex");
}

/** Best-effort "Chrome on Windows" style label from a User-Agent string — good enough for a device list, no external dependency needed. */
export function deviceLabelFromUserAgent(ua: string | null): string {
  if (!ua) return "Unknown device";

  let browser = "Unknown browser";
  if (/EdgA?\//.test(ua)) browser = "Edge";
  else if (/OPR\//.test(ua)) browser = "Opera";
  else if (/Chrome\//.test(ua) && !/Chromium\//.test(ua)) browser = "Chrome";
  else if (/CriOS\//.test(ua)) browser = "Chrome";
  else if (/FxiOS\//.test(ua)) browser = "Firefox";
  else if (/Firefox\//.test(ua)) browser = "Firefox";
  else if (/Safari\//.test(ua) && !/Chrome\//.test(ua)) browser = "Safari";

  let os = "";
  if (/Windows/.test(ua)) os = "Windows";
  else if (/Mac OS X/.test(ua)) os = /iPhone|iPad|iPod/.test(ua) ? "" : "macOS";
  else if (/Android/.test(ua)) os = "Android";
  else if (/iPhone|iPad|iPod/.test(ua)) os = "iOS";
  else if (/Linux/.test(ua)) os = "Linux";

  if (/iPhone/.test(ua)) return `${browser} on iPhone`;
  if (/iPad/.test(ua)) return `${browser} on iPad`;
  if (/Android/.test(ua) && /Mobile/.test(ua)) return `${browser} on Android`;

  return os ? `${browser} on ${os}` : browser;
}

/**
 * Opens a new session row for a freshly-issued login token. Returns the
 * `jti` to embed in the JWT via signAuthToken(..., { sid: jti }).
 *
 * `originClientId` (OIDC Roadmap — Season 3, Phase 6e-b, migration 086):
 * optional, defaults to `null`. Every EXISTING caller of `createSession()`
 * (the ordinary login flow, the AYZEN Astra extension's session-exchange
 * call) keeps passing nothing here and keeps getting `null` — identical
 * behavior to before this parameter existed. The one new caller is
 * `POST /auth/session-exchange` when its request body names a recognized
 * `client_id` (Sylo's own `sylo-oidc-session-exchange.ts` call) — see that
 * route's own doc comment for why it's opt-in rather than inferred.
 */
export async function createSession(params: {
  userId: number;
  ip: string | null;
  userAgent: string | null;
  originClientId?: string | null;
}): Promise<{ jti: string; expiresAt: Date }> {
  const jti = generateSessionId();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  const deviceLabel = deviceLabelFromUserAgent(params.userAgent);
  const originClientId = params.originClientId ?? null;
  await pool.query(
    `INSERT INTO user_sessions (user_id, jti, device_label, ip, user_agent, expires_at, origin_client_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [params.userId, jti, deviceLabel, params.ip, params.userAgent, expiresAt, originClientId],
  );
  return { jti, expiresAt };
}

/**
 * Marks a session as recently active and slides its expiry forward by
 * another 7 days — mirrors how Google/most account systems keep a session
 * alive as long as it's actually being used, rather than hard-expiring an
 * account 7 days after login regardless of activity. This is purely a
 * bookkeeping convenience: the JWT itself still has its own fixed
 * signature + `exp`, checked first by verifyAuthToken(), so sliding this
 * timestamp can never grant access beyond what a valid signed token
 * already allows.
 * Returns false if the session is unknown, revoked, or already expired.
 */
export async function touchSession(jti: string): Promise<boolean> {
  const r = await pool.query(
    `UPDATE user_sessions
     SET last_seen_at = NOW(), expires_at = NOW() + INTERVAL '7 days'
     WHERE jti = $1 AND revoked_at IS NULL AND expires_at > NOW()
     RETURNING id`,
    [jti],
  );
  return r.rows.length > 0;
}

/** True only when the `sid` belongs to a session that was explicitly revoked or has lapsed. An unrecognized `sid` (e.g. a pre-sessions-feature token) is NOT treated as revoked. */
export async function isSessionRevoked(jti: string): Promise<boolean> {
  const r = await pool.query(
    `SELECT revoked_at, expires_at FROM user_sessions WHERE jti = $1`,
    [jti],
  );
  if (r.rows.length === 0) return false;
  const row = r.rows[0];
  return !!row.revoked_at || new Date(row.expires_at).getTime() < Date.now();
}

/** All of a user's currently-valid sessions, most recently active first — powers the "Sessions & devices" list on the Security page. */
export async function listSessions(userId: number): Promise<UserSession[]> {
  const r = await pool.query(
    `SELECT * FROM user_sessions
     WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > NOW()
     ORDER BY last_seen_at DESC`,
    [userId],
  );
  return r.rows.map(rowToSession);
}

/** Revokes one session by id, scoped to the owning user so one account can never revoke another's session by guessing an id. Returns false if not found/already revoked. */
export async function revokeSession(userId: number, sessionId: number): Promise<boolean> {
  const r = await pool.query(
    `UPDATE user_sessions SET revoked_at = NOW()
     WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
     RETURNING id`,
    [sessionId, userId],
  );
  return r.rows.length > 0;
}

/** Revokes a session by its `jti` (the claim embedded in the JWT) rather than its numeric row id — used by /auth/logout, which only has the token, not the Security page's numeric session id. */
export async function revokeSessionByJti(jti: string): Promise<boolean> {
  const r = await pool.query(
    `UPDATE user_sessions SET revoked_at = NOW() WHERE jti = $1 AND revoked_at IS NULL RETURNING id`,
    [jti],
  );
  return r.rows.length > 0;
}

/**
 * OIDC Roadmap — Season 3, Phase 6e-b: revokes every currently-active
 * session for `userId` that was opened on behalf of `originClientId`
 * (e.g. `'sylo'`) — see `createSession()`'s own doc comment for how that
 * tag gets set. This is the narrow counterpart to `revokeAllSessionsExcept()`
 * below: that function revokes everything BUT one session; this one
 * revokes ONLY the sessions tagged for one specific client, leaving every
 * other session (untagged Central sessions, sessions tagged for a
 * DIFFERENT client) untouched.
 *
 * The one caller is `routes/oidc-backchannel-logout.ts` (Sylo's own
 * receiving endpoint): a verified inbound Logout Token only ever carries
 * `sub` (a userId), never a `sid` (this provider doesn't populate one on
 * the SENDING side either — see `lib/oidc-logout-propagation.ts`'s own
 * header) — so "which session(s) does this event concern" can only be
 * answered at the ORIGIN-CLIENT granularity this column provides, not a
 * single-session one. Never called with `originClientId: null` — that
 * would revoke every untagged Central session for the user, which is
 * `revokeAllSessionsExcept(userId, null)`'s job, not this one's.
 */
export async function revokeSessionsByUserAndOriginClient(userId: number, originClientId: string): Promise<number> {
  const r = await pool.query(
    `UPDATE user_sessions SET revoked_at = NOW()
     WHERE user_id = $1 AND origin_client_id = $2 AND revoked_at IS NULL
     RETURNING id`,
    [userId, originClientId],
  );
  return r.rows.length;
}

/** "Sign out of all other sessions" — revokes every active session for a user except `keepJti` (pass null to sign out everywhere, including the current device). Returns the number of sessions revoked. */
export async function revokeAllSessionsExcept(userId: number, keepJti: string | null): Promise<number> {
  const r = keepJti
    ? await pool.query(
        `UPDATE user_sessions SET revoked_at = NOW()
         WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > NOW() AND jti <> $2
         RETURNING id`,
        [userId, keepJti],
      )
    : await pool.query(
        `UPDATE user_sessions SET revoked_at = NOW()
         WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > NOW()
         RETURNING id`,
        [userId],
      );
  return r.rows.length;
}
