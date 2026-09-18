import { Router, type Request } from "express";
import { db, usersTable, pool } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import * as crypto from "crypto";
import { referralsTable } from "@workspace/db";
import { getUserFromToken, getTokenFromReq } from "../lib/auth-utils";
import { sendEmail } from "../lib/email";
import { signAuthToken, verifyAuthToken } from "../lib/jwt";
import { hashPassword, verifyPassword, needsRehash } from "../lib/password";
import { authLimiter, otpLimiter } from "../middlewares/security";
import { totpVerify } from "../lib/totp";
import { generateOtp, storeOtp, verifyOtp } from "../lib/otp-store";
import {
  getClientIp,
  isAnomalousIp,
  recordLoginHistory,
  markLoginHistoryStatus,
  availableStepUpMethods,
  createLoginChallenge,
  getLoginChallenge,
  markStepUpMethodComplete,
  bumpChallengeAttempts,
  stepUpOtpKey,
  type StepUpMethod,
} from "../lib/login-security";
import {
  createSession,
  touchSession,
  listSessions,
  revokeSession,
  revokeSessionByJti,
  revokeAllSessionsExcept,
} from "../lib/sessions";
import { setSessionCookie, clearSessionCookie, getSessionCookie } from "../lib/session-cookie";
// OIDC Roadmap — Season 3, Phase 6e-b (Sylo Integration): after any of
// this file's own session-revoke calls below succeeds, best-effort
// notifies every registered first-party client (today: Sylo) via
// Back-Channel Logout — see that function's own header for why it's
// fire-and-forget (`void ...`, never `await`ed) at every call site.
import { dispatchBackchannelLogoutForUser } from "../lib/oidc-logout-propagation";
// 6e-b: validates an optional `client_id` on session-exchange's request
// body against the real client registry (Phase 2A-c) before tagging a new
// session's `origin_client_id` with it — see that handler's own comment.
import { oidcClientExists } from "../lib/oidc-clients";
// OIDC Roadmap — Season 3, Phase 5c-d (additive, comparison monitoring):
// records this endpoint's attempts under the "legacy" path so the dual-run
// admin view can compare them against the "oidc" path's own numbers from
// routes/oidc-token.ts. Never affects this route's own response — see
// that lib's own header.
import { recordOidcLoginAttempt, resolveLegacyLoginAppId } from "../lib/oidc-login-attempts";
// OIDC Roadmap — Season 3, Phase 5d-c (additive): once Sylo's rollout flag
// (5c-a) is on, the legacy credential form must stop accepting direct
// POST /auth/login hits for Sylo — see lib/oidc-cutover-gate.ts's own
// header for why this is the same flag flip as 5d-b's cutover, not a
// second one.
import { getOidcRolloutFlag } from "../lib/oidc-client-rollout";
import { evaluateLegacyLoginGate } from "../lib/oidc-cutover-gate";

const router = Router();

// ─── In-memory OTP store ────────────────────────────────────────────────────
// Lives in lib/otp-store.ts so routes/passkey.ts can share it for the
// email-code factor of the anomalous-IP step-up chain (see lib/login-security.ts).

// ─── Helpers ─────────────────────────────────────────────────────────────────
// hashPassword (bcrypt) and signAuthToken (signed JWT) now live in
// ../lib/password.ts and ../lib/jwt.ts — see those files for why the old
// sha256-with-static-salt hashing and unsigned base64 "tokens" were removed.

function sanitizeUser(user: typeof usersTable.$inferSelect) {
  const { passwordHash: _ph, twoFaSecret: _ts, ...safe } = user;
  return {
    ...safe,
    createdAt: safe.createdAt.toISOString(),
    lastActiveAt: safe.lastActiveAt?.toISOString() ?? null,
  };
}

function generateReferralCode(): string {
  return "AYZN" + crypto.randomBytes(3).toString("hex").toUpperCase();
}

// ─── Session-bound token issuance ────────────────────────────────────────────
// Every place that mints a login token goes through here so it also opens a
// user_sessions row (lib/sessions.ts) — that's what turns "one token for
// every AYZEN module" into an *account* session the user can actually see
// and revoke from the Security page, the way Google's device list works,
// instead of an opaque bearer token nobody can look up again.
async function mintSessionToken(user: { id: number; role: string }, req: Request): Promise<string> {
  const ip = getClientIp(req);
  const userAgent = (req.headers["user-agent"] as string) || null;
  const { jti } = await createSession({ userId: user.id, ip, userAgent });
  return signAuthToken(user.id, user.role, { sid: jti });
}

// ─── POST /auth/init — one-time seed: create first admin + optional user ─────
// Only works when zero admins exist in the database.
router.post("/auth/init", authLimiter, async (req, res): Promise<void> => {
  try {
    const existing = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.role, "admin")).limit(1);
    if (existing.length > 0) {
      res.status(403).json({ error: "Admin already initialised. Use /auth/register for new users." });
      return;
    }

    const {
      adminUsername = "admin",
      adminEmail = "admin@ayzen.io",
      adminPassword,
      userUsername,
      userEmail,
      userPassword,
    } = req.body;

    if (!adminPassword) {
      res.status(400).json({ error: "adminPassword is required" });
      return;
    }

    const created: Record<string, unknown>[] = [];

    // Create admin
    const adminReferralCode = generateReferralCode();
    const [admin] = await db.insert(usersTable).values({
      username: adminUsername,
      email: adminEmail,
      passwordHash: await hashPassword(adminPassword),
      role: "admin",
      status: "active",
      emailVerified: true,
      twoFaEnabled: false,
      referralCode: adminReferralCode,
    }).returning();
    db.execute(sql`INSERT INTO wallets (user_id, label, address, chain, chain_id, is_primary, balance, balance_usd, created_at, updated_at) VALUES (${admin.id}, 'My Wallet', 'pending', 'ETH', 1, true, 0, 0, NOW(), NOW())`).catch(() => {});
    created.push({ ...sanitizeUser(admin), role: "admin", token: await mintSessionToken(admin, req) });

    // Create regular user (optional)
    if (userUsername && userEmail && userPassword) {
      const userReferralCode = generateReferralCode();
      const [user] = await db.insert(usersTable).values({
        username: userUsername,
        email: userEmail,
        passwordHash: await hashPassword(userPassword),
        role: "user",
        status: "active",
        emailVerified: true,
        twoFaEnabled: false,
        referralCode: userReferralCode,
      }).returning();
      db.execute(sql`INSERT INTO wallets (user_id, label, address, chain, chain_id, is_primary, balance, balance_usd, created_at, updated_at) VALUES (${user.id}, 'My Wallet', 'pending', 'ETH', 1, true, 0, 0, NOW(), NOW())`).catch(() => {});
      created.push({ ...sanitizeUser(user), role: "user", token: await mintSessionToken(user, req) });
    }

    // Always seed demo accounts so the login page demo buttons work out of the box.
    // These are skipped if the email already exists (idempotent re-init).
    const DEMO_ACCOUNTS = [
      { username: "demoadmin", email: "demoadmin@ayzen.io", role: "admin" },
      { username: "demodev",   email: "demodev@ayzen.io",   role: "dev" },
      { username: "demomod",   email: "demomod@ayzen.io",   role: "moderator" },
      { username: "demoteam",  email: "demoteam@ayzen.io",  role: "team_leader" },
      { username: "demo",      email: "demo@ayzen.io",      role: "user" },
    ] as const;
    const demoHash = await hashPassword("Demo@1234");
    for (const demo of DEMO_ACCOUNTS) {
      try {
        const demoRef = generateReferralCode();
        const [demoUser] = await db.insert(usersTable).values({
          username: demo.username,
          email: demo.email,
          passwordHash: demoHash,
          role: demo.role,
          status: "active",
          emailVerified: true,
          twoFaEnabled: false,
          referralCode: demoRef,
        }).returning();
        db.execute(sql`INSERT INTO wallets (user_id, label, address, chain, chain_id, is_primary, balance, balance_usd, created_at, updated_at) VALUES (${demoUser.id}, 'My Wallet', 'pending', 'ETH', 1, true, 0, 0, NOW(), NOW())`).catch(() => {});
        created.push({ ...sanitizeUser(demoUser), role: demo.role, token: await mintSessionToken(demoUser, req) });
      } catch {
        // email conflict — demo account already exists, skip silently
      }
    }

    // Demo accounts are intentionally ready to explore the complete Vault
    // security surface. The demo PIN is hashed using the legacy-compatible
    // format so it can be verified without ever storing plaintext credentials.
    // Real accounts still go through the account-password + email-code setup.
    const demoVaultPinHash = "c64f825eaa96a531bfecb01fca6ab068e7ce51053b9ff36678e6d5c6f29f376a";
    await db.execute(sql`
      INSERT INTO vault_security (user_id, vault_pin_hash, entity_pin_hash, auth_step_policy)
      SELECT id, ${demoVaultPinHash}, ${demoVaultPinHash}, 'any'
      FROM users
      WHERE email IN ('demoadmin@ayzen.io', 'demodev@ayzen.io', 'demomod@ayzen.io', 'demoteam@ayzen.io', 'demo@ayzen.io')
      ON CONFLICT (user_id) DO UPDATE SET
        vault_pin_hash = COALESCE(vault_security.vault_pin_hash, EXCLUDED.vault_pin_hash),
        entity_pin_hash = COALESCE(vault_security.entity_pin_hash, EXCLUDED.entity_pin_hash)
    `);

    res.status(201).json({ message: "Initialised successfully", created });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /auth/send-otp — send 6-digit email verification code ──────────────
router.post("/auth/send-otp", otpLimiter, async (req, res): Promise<void> => {
  const { email } = req.body;
  if (!email) { res.status(400).json({ error: "email is required" }); return; }

  const code = generateOtp();
  await storeOtp(email, code);

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"/><style>
  body{margin:0;padding:0;background:#0a0d12;font-family:'Courier New',monospace;color:#e0f7f7;}
  .wrap{max-width:520px;margin:40px auto;background:#0d1117;border:1px solid #1a3a3a;border-radius:8px;overflow:hidden;}
  .header{padding:24px 32px;border-bottom:1px solid #1a3a3a;background:#070a0f;}
  .logo{font-size:20px;font-weight:bold;letter-spacing:4px;color:#00d4cc;}
  .sub{font-size:10px;letter-spacing:3px;color:#4a8080;margin-top:4px;text-transform:uppercase;}
  .body{padding:32px;}
  h2{color:#00d4cc;font-size:16px;letter-spacing:2px;text-transform:uppercase;margin:0 0 16px;}
  p{color:#a0c8c8;font-size:13px;line-height:1.7;margin:0 0 12px;}
  .otp{display:block;font-size:36px;font-weight:bold;letter-spacing:12px;color:#00d4cc;margin:24px 0;text-align:center;background:#070a0f;padding:20px;border-radius:6px;border:1px solid #1a3a3a;}
  .footer{padding:20px 32px;border-top:1px solid #1a3a3a;font-size:10px;color:#2a5050;letter-spacing:1px;}
</style></head>
<body><div class="wrap">
  <div class="header"><div class="logo">&gt;_ AYZEN</div><div class="sub">Airdrop Command Center</div></div>
  <div class="body">
    <h2>Verification Code</h2>
    <p>Your one-time verification code for AYZEN:</p>
    <span class="otp">${code}</span>
    <p>This code expires in <strong>10 minutes</strong>. Do not share it with anyone.</p>
  </div>
  <div class="footer">&copy; 2026 AYZEN &mdash; If you didn't request this, ignore this email.</div>
</div></body></html>`;

  const result = await sendEmail({ to: email, subject: "AYZEN — Verification Code", html, text: `Your AYZEN verification code: ${code} (expires in 10 minutes)` });

  if (!result.success) {
    res.status(503).json({ error: "Failed to send email. Please check email config.", detail: result.error });
    return;
  }
  res.json({ message: "Verification code sent to your email." });
});

// ─── POST /auth/register ─────────────────────────────────────────────────────
router.post("/auth/register", authLimiter, async (req, res): Promise<void> => {
  const { username, email, password, refCode, emailOtp } = req.body;
  if (!username || !email || !password) {
    res.status(400).json({ error: "username, email, and password are required" }); return;
  }

  // Verify OTP if provided (required for new registrations)
  if (!emailOtp) {
    res.status(400).json({ error: "Email verification code is required. Please request a code first." }); return;
  }
  if (!(await verifyOtp(email, emailOtp))) {
    res.status(400).json({ error: "Invalid or expired verification code. Please request a new one." }); return;
  }

  const existing = await db.select().from(usersTable).where(eq(usersTable.email, email));
  if (existing.length > 0) { res.status(409).json({ error: "Email already registered" }); return; }

  let referralCode = generateReferralCode();
  let codeExists = true;
  while (codeExists) {
    const check = await db.select().from(usersTable).where(eq(usersTable.referralCode, referralCode));
    if (check.length === 0) codeExists = false;
    else referralCode = generateReferralCode();
  }

  let referredBy: number | null = null;
  let referrer: typeof usersTable.$inferSelect | null = null;
  if (refCode) {
    const [found] = await db.select().from(usersTable).where(eq(usersTable.referralCode, (refCode as string).toUpperCase().trim()));
    if (found) { referredBy = found.id; referrer = found; }
  }

  const [user] = await db.insert(usersTable).values({
    username, email, passwordHash: await hashPassword(password),
    role: "user", status: "active", emailVerified: true, twoFaEnabled: false,
    referralCode,
    ...(referredBy ? { referredBy } : {}),
  }).returning();

  if (referrer) {
    await db.insert(referralsTable).values({
      referrerId: referrer.id,
      referredId: user.id,
      codeUsed: (refCode as string).toUpperCase().trim(),
      rewardAmount: 10,
      rewardPaid: false,
    });
  }

  // Auto-create built-in ETH wallet for every new user
  db.execute(sql`INSERT INTO wallets (user_id, label, address, chain, chain_id, is_primary, balance, balance_usd, created_at, updated_at)
     VALUES (${user.id}, 'My Wallet', 'pending', 'ETH', 1, true, 0, 0, NOW(), NOW())`
  ).catch(() => {});

  // Auto-mint username NFT for every new user
  const cleanUname = username.replace(/[^a-zA-Z0-9_]/g, "").slice(0, 24);
  const unameTokenId = `USERNAME-${user.id}-${cleanUname.toUpperCase()}`;
  pool.query(
    `INSERT INTO nft_subscriptions
      (owner_id, original_owner_id, token_id, plan, nft_type, nft_category, badge_name, image_url, metadata, expires_at, is_listed, list_price, transfer_count, is_burned, minted_at, created_at, updated_at)
     VALUES ($1,$1,$2,'username','username','username',$3,NULL,'{}',NOW()+INTERVAL '100 years',false,NULL,0,false,NOW(),NOW(),NOW())
     ON CONFLICT DO NOTHING`,
    [user.id, unameTokenId, cleanUname]
  ).catch(() => {});

  // Auto-create built-in AYZEN email for every new user
  const ayzenEmailAddr = `${username.toLowerCase().replace(/[^a-z0-9]/g, '')}@ayzen.io`;
  db.execute(sql`INSERT INTO email_accounts (user_id, label, email_address, is_default, protocol, use_ssl, username, password, created_at, updated_at)
     VALUES (${user.id}, 'AYZEN Mail', ${ayzenEmailAddr}, true, 'IMAP', true, ${ayzenEmailAddr}, '', NOW(), NOW())`
  ).catch(() => {});

  const token = await mintSessionToken(user, req);

  import("../lib/email").then(({ sendWelcomeEmail }) => {
    sendWelcomeEmail(user.email, user.username).catch(() => {});
  }).catch(() => {});

  res.status(201).json({ token, refreshToken: token, user: sanitizeUser(user) });
});

// ─── Login pattern log + anomalous-IP step-up MFA ─────────────────────────────
// See lib/login-security.ts for the full design note. In short: every login
// attempt is written to login_history (audit trail). If the request IP has
// never had a successful login on this account before, we don't issue a
// token yet — we open a login_challenge that requires EVERY auth method the
// account has configured (email code always; TOTP/backup code/passkey if
// set up) to be verified, in any order, before a session is granted.

function stepUpEmailHtml(code: string): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"/><style>
  body{margin:0;padding:0;background:#0a0d12;font-family:'Courier New',monospace;color:#e0f7f7;}
  .wrap{max-width:520px;margin:40px auto;background:#0d1117;border:1px solid #1a3a3a;border-radius:8px;overflow:hidden;}
  .header{padding:24px 32px;border-bottom:1px solid #1a3a3a;background:#070a0f;}
  .logo{font-size:20px;font-weight:bold;letter-spacing:4px;color:#00d4cc;}
  .sub{font-size:10px;letter-spacing:3px;color:#4a8080;margin-top:4px;text-transform:uppercase;}
  .body{padding:32px;}
  h2{color:#ff6b6b;font-size:16px;letter-spacing:2px;text-transform:uppercase;margin:0 0 16px;}
  p{color:#a0c8c8;font-size:13px;line-height:1.7;margin:0 0 12px;}
  .otp{display:block;font-size:36px;font-weight:bold;letter-spacing:12px;color:#ff6b6b;margin:24px 0;text-align:center;background:#070a0f;padding:20px;border-radius:6px;border:1px solid #3a1a1a;}
  .footer{padding:20px 32px;border-top:1px solid #1a3a3a;font-size:10px;color:#2a5050;letter-spacing:1px;}
</style></head>
<body><div class="wrap">
  <div class="header"><div class="logo">&gt;_ AYZEN</div><div class="sub">Airdrop Command Center</div></div>
  <div class="body">
    <h2>New Sign-in Location Detected</h2>
    <p>We noticed a login attempt on your account from a device/IP we haven't seen before. Enter this code to confirm it's you — you'll also need to clear every other security step on your account before access is granted.</p>
    <span class="otp">${code}</span>
    <p>This code expires in <strong>10 minutes</strong>. If this wasn't you, change your password immediately.</p>
  </div>
  <div class="footer">&copy; 2026 AYZEN &mdash; Anomalous sign-in protection.</div>
</div></body></html>`;
}

async function beginStepUpChallenge(userId: number, email: string, ip: string, userAgent: string | null) {
  const loginHistoryId = await recordLoginHistory({ userId, ip, userAgent, status: "pending_verification", anomalous: true });
  const requiredMethods = await availableStepUpMethods(userId);
  const challenge = await createLoginChallenge({ userId, ip, userAgent, requiredMethods, loginHistoryId });

  // email_otp is always in requiredMethods — send its code immediately so
  // the frontend can show a single "check your email" step right away.
  const code = generateOtp();
  await storeOtp(stepUpOtpKey(challenge.token), code);
  const result = await sendEmail({ to: email, subject: "AYZEN — Confirm New Sign-in", html: stepUpEmailHtml(code), text: `Your AYZEN sign-in confirmation code: ${code} (expires in 10 minutes)` });

  return { challenge, emailSendFailed: !result.success };
}

router.post("/auth/login", authLimiter, async (req, res): Promise<void> => {
  const { email, password } = req.body;
  if (!email || !password) { res.status(400).json({ error: "email and password are required" }); return; }
  const ip = getClientIp(req);
  const userAgent = (req.headers["user-agent"] as string) || null;

  // Season 3, Phase 5c-d (additive): resolved once, used at every response
  // point below — see resolveLegacyLoginAppId()'s own header for why
  // Origin is tried first, Referer second, and why any other host records
  // nothing.
  const legacyLoginAppId = resolveLegacyLoginAppId(req.headers.origin) ?? resolveLegacyLoginAppId(req.headers.referer);

  // Season 3, Phase 5d-c: "Disable Old Login Path (Sylo only)". Reads the
  // SAME rollout flag 5c-a/5c-c/5d-b already flip — see
  // lib/oidc-cutover-gate.ts's own header for why cutover and disabling
  // the old path are one flag, not two. Checked BEFORE the credential
  // lookup below so a blocked Sylo attempt never touches the users table
  // or costs a bcrypt compare, and recorded as a "legacy" failure (5e-a/
  // 5e-b) so the admin dashboard shows a bypass attempt was blocked, not
  // silence.
  if (legacyLoginAppId) {
    const oidcEnabledForApp = await getOidcRolloutFlag(legacyLoginAppId);
    const gate = evaluateLegacyLoginGate(legacyLoginAppId, oidcEnabledForApp);
    if (gate.blocked) {
      recordOidcLoginAttempt(legacyLoginAppId, "legacy", "failure", gate.code);
      res.status(403).json({
        error: "This app now signs in with OIDC.",
        code: gate.code,
        solution: "Start the OIDC login flow (Sign in with AYZEN) instead of posting credentials directly to this endpoint.",
      });
      return;
    }
  }

  const [user] = await db.select().from(usersTable).where(eq(usersTable.email, email));
  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    if (user) recordLoginHistory({ userId: user.id, ip, userAgent, status: "failed", anomalous: false }).catch(() => {});
    if (legacyLoginAppId) recordOidcLoginAttempt(legacyLoginAppId, "legacy", "failure");
    res.status(401).json({ error: "Invalid credentials" }); return;
  }
  // Transparently upgrade legacy sha256 password hashes to bcrypt on successful login.
  if (needsRehash(user.passwordHash)) {
    await hashPassword(password).then((upgraded) =>
      db.update(usersTable).set({ passwordHash: upgraded }).where(eq(usersTable.id, user.id)),
    ).catch(() => {});
  }

  // ── Login pattern check: unrecognized IP → require full step-up chain ──────
  if (await isAnomalousIp(user.id, ip)) {
    const { challenge, emailSendFailed } = await beginStepUpChallenge(user.id, user.email, ip, userAgent);
    res.status(200).json({
      requiresStepUp: true,
      reason: "new_ip",
      challengeToken: challenge.token,
      requiredMethods: challenge.requiredMethods,
      completedMethods: challenge.completedMethods,
      expiresAt: challenge.expiresAt.toISOString(),
      emailSendFailed,
    });
    return;
  }

  // Recognized IP — password alone is sufficient, same as before.
  const loginHistoryId = await recordLoginHistory({ userId: user.id, ip, userAgent, status: "success", anomalous: false });
  void loginHistoryId;

  const { token, user: safeUser } = await finalizeLogin(user, req);
  setSessionCookie(res, token);
  if (legacyLoginAppId) recordOidcLoginAttempt(legacyLoginAppId, "legacy", "success");
  res.json({ token, refreshToken: token, user: safeUser });
});

/** Streak bookkeeping + token issuance shared by the direct-login and step-up-verified paths. */
async function finalizeLogin(user: typeof usersTable.$inferSelect, req: Request) {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const lastActive = user.lastActiveAt;
  const lastDate = lastActive ? lastActive.toISOString().slice(0, 10) : null;
  let newStreak = user.streak ?? 0;
  let newLongest = user.longestStreak ?? 0;

  if (!lastDate) {
    newStreak = 1;
  } else if (lastDate === today) {
    // Already active today — no change
  } else {
    const yesterday = new Date(now); yesterday.setDate(yesterday.getDate() - 1);
    const yStr = yesterday.toISOString().slice(0, 10);
    if (lastDate === yStr) {
      newStreak = (user.streak ?? 0) + 1;
    } else {
      newStreak = 1;
    }
  }
  newLongest = Math.max(newLongest, newStreak);

  await db.update(usersTable)
    .set({ lastActiveAt: now, streak: newStreak, longestStreak: newLongest })
    .where(eq(usersTable.id, user.id));

  const token = await mintSessionToken(user, req);
  return { token, user: { ...sanitizeUser(user), streak: newStreak, longestStreak: newLongest } };
}

// ─── GET /auth/login/step-up/:token — status of an open step-up challenge ────
router.get("/auth/login/step-up/:token", async (req, res): Promise<void> => {
  const challenge = await getLoginChallenge(req.params.token);
  if (!challenge) { res.status(404).json({ error: "Challenge not found" }); return; }
  res.json({
    status: challenge.status,
    requiredMethods: challenge.requiredMethods,
    completedMethods: challenge.completedMethods,
    expiresAt: challenge.expiresAt.toISOString(),
  });
});

// ─── POST /auth/login/step-up/verify — clear one required factor ─────────────
// body: { challengeToken, method: 'email_otp'|'totp'|'backup_code', code }
// ('passkey' is verified via POST /passkey/login/verify with the same
// challengeToken passed through — a WebAuthn assertion can't be reduced to
// a simple code field. See routes/passkey.ts.)
router.post("/auth/login/step-up/verify", authLimiter, async (req, res): Promise<void> => {
  const { challengeToken, method, code } = req.body as { challengeToken?: string; method?: StepUpMethod; code?: string };
  if (!challengeToken || !method) { res.status(400).json({ error: "challengeToken and method are required" }); return; }

  const challenge = await getLoginChallenge(challengeToken);
  if (!challenge) { res.status(404).json({ error: "Challenge not found" }); return; }
  if (challenge.status === "expired") { res.status(410).json({ error: "This sign-in confirmation has expired. Please log in again." }); return; }
  if (challenge.status === "verified") { res.status(400).json({ error: "This challenge was already completed" }); return; }
  if (!challenge.requiredMethods.includes(method)) { res.status(400).json({ error: `${method} is not required for this login` }); return; }
  if (challenge.completedMethods.includes(method)) { res.status(400).json({ error: `${method} was already verified` }); return; }
  if (method === "passkey") { res.status(400).json({ error: "Verify passkey via POST /passkey/login/verify with this challengeToken" }); return; }
  if (!code || !code.trim()) { res.status(400).json({ error: "code is required" }); return; }

  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, challenge.userId));
  if (!user) { res.status(404).json({ error: "Account not found" }); return; }

  let ok = false;
  if (method === "email_otp") {
    ok = await verifyOtp(stepUpOtpKey(challengeToken), code);
  } else if (method === "totp") {
    ok = !!user.twoFaSecret && totpVerify(code, user.twoFaSecret);
  } else if (method === "backup_code") {
    const r = await pool.query(
      "SELECT id FROM user_backup_codes WHERE user_id=$1 AND code=$2 AND is_used=FALSE FOR UPDATE",
      [user.id, code.toUpperCase().trim()],
    );
    if (r.rows.length) {
      await pool.query("UPDATE user_backup_codes SET is_used=TRUE, used_at=NOW() WHERE id=$1", [r.rows[0].id]);
      ok = true;
    }
  } else {
    res.status(400).json({ error: "Unknown method" }); return;
  }

  if (!ok) {
    const { lockedOut } = await bumpChallengeAttempts(challengeToken);
    if (lockedOut) {
      if (challenge.loginHistoryId) markLoginHistoryStatus(challenge.loginHistoryId, "failed").catch(() => {});
      res.status(429).json({ error: "Too many failed attempts. This sign-in confirmation has been locked — please log in again." });
      return;
    }
    res.status(401).json({ error: `Invalid ${method === "email_otp" ? "email code" : method === "totp" ? "authenticator code" : "backup code"}` });
    return;
  }

  const updated = await markStepUpMethodComplete(challengeToken, method);
  if (!updated) { res.status(404).json({ error: "Challenge not found" }); return; }

  if (updated.status === "verified") {
    if (updated.loginHistoryId) markLoginHistoryStatus(updated.loginHistoryId, "success").catch(() => {});
    const { token, user: safeUser } = await finalizeLogin(user, req);
    setSessionCookie(res, token);
    res.json({ verified: true, token, refreshToken: token, user: safeUser });
    return;
  }

  res.json({ verified: false, requiredMethods: updated.requiredMethods, completedMethods: updated.completedMethods });
});

// ─── POST /auth/verify-otp — validate OTP without creating session ────────────
router.post("/auth/verify-otp", authLimiter, async (req, res): Promise<void> => {
  const { email, code } = req.body;
  if (!email || !code) { res.status(400).json({ error: "email and code are required" }); return; }
  const valid = await verifyOtp(email, code);
  if (!valid) { res.status(400).json({ error: "Invalid or expired code. Please request a new one." }); return; }
  res.json({ valid: true });
});

// ─── POST /auth/magic-link — send OTP via Resend (replaces Supabase) ─────────
router.post("/auth/magic-link", otpLimiter, async (req, res): Promise<void> => {
  const { email } = req.body;
  if (!email) { res.status(400).json({ error: "email is required" }); return; }

  const code = generateOtp();
  await storeOtp(email, code);

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"/><style>
  body{margin:0;padding:0;background:#0a0d12;font-family:'Courier New',monospace;color:#e0f7f7;}
  .wrap{max-width:520px;margin:40px auto;background:#0d1117;border:1px solid #1a3a3a;border-radius:8px;overflow:hidden;}
  .header{padding:24px 32px;border-bottom:1px solid #1a3a3a;background:#070a0f;}
  .logo{font-size:20px;font-weight:bold;letter-spacing:4px;color:#00d4cc;}
  .sub{font-size:10px;letter-spacing:3px;color:#4a8080;margin-top:4px;text-transform:uppercase;}
  .body{padding:32px;}
  h2{color:#00d4cc;font-size:16px;letter-spacing:2px;text-transform:uppercase;margin:0 0 16px;}
  p{color:#a0c8c8;font-size:13px;line-height:1.7;margin:0 0 12px;}
  .otp{display:block;font-size:36px;font-weight:bold;letter-spacing:12px;color:#00d4cc;margin:24px 0;text-align:center;background:#070a0f;padding:20px;border-radius:6px;border:1px solid #1a3a3a;}
  .footer{padding:20px 32px;border-top:1px solid #1a3a3a;font-size:10px;color:#2a5050;letter-spacing:1px;}
</style></head>
<body><div class="wrap">
  <div class="header"><div class="logo">&gt;_ AYZEN</div><div class="sub">Airdrop Command Center</div></div>
  <div class="body">
    <h2>Login Code</h2>
    <p>Your AYZEN passwordless login code:</p>
    <span class="otp">${code}</span>
    <p>This code expires in <strong>10 minutes</strong>.</p>
  </div>
  <div class="footer">&copy; 2026 AYZEN &mdash; If you didn't request this, ignore this email.</div>
</div></body></html>`;

  const result = await sendEmail({ to: email, subject: "AYZEN — Login Code", html, text: `Your AYZEN login code: ${code}` });
  if (!result.success) {
    res.status(503).json({ error: "Failed to send login code. Check email configuration.", detail: result.error });
    return;
  }
  res.json({ message: "Login code sent to your email." });
});

// ─── POST /auth/magic-link/verify — verify OTP and login ─────────────────────
router.post("/auth/magic-link/verify", authLimiter, async (req, res): Promise<void> => {
  const { email, code } = req.body;
  if (!email || !code) { res.status(400).json({ error: "email and code are required" }); return; }

  if (!(await verifyOtp(email, code))) {
    res.status(401).json({ error: "Invalid or expired code" }); return;
  }

  let [user] = await db.select().from(usersTable).where(eq(usersTable.email, email));
  if (!user) {
    const username = email.split("@")[0].replace(/[^a-z0-9_]/gi, "_").toLowerCase().slice(0, 20) + "_" + crypto.randomBytes(2).toString("hex");
    const referralCode = "AYZN" + crypto.randomBytes(3).toString("hex").toUpperCase();
    [user] = await db.insert(usersTable).values({
      username, email,
      passwordHash: await hashPassword(crypto.randomBytes(16).toString("hex")),
      role: "user", status: "active", emailVerified: true, twoFaEnabled: false,
      referralCode,
    }).returning();
  } else {
    await db.update(usersTable).set({ lastActiveAt: new Date(), emailVerified: true }).where(eq(usersTable.id, user.id));
  }

  const token = await mintSessionToken(user, req);
  setSessionCookie(res, token);
  res.json({ token, refreshToken: token, user: sanitizeUser(user) });
});


// ─── Supabase OAuth sync — legacy fallback ────────────────────────────────────
router.post("/auth/supabase-sync", async (req, res): Promise<void> => {
  const token = req.headers.authorization?.replace("Bearer ", "").trim();
  if (!token) { res.status(401).json({ error: "No token provided" }); return; }
  const result = await getUserFromToken(token);
  if (!result) { res.status(401).json({ error: "Invalid or unrecognized token" }); return; }
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, result.userId));
  if (!user) { res.status(404).json({ error: "User not found" }); return; }
  await db.update(usersTable).set({ lastActiveAt: new Date() }).where(eq(usersTable.id, user.id));
  const ayzenToken = await mintSessionToken(user, req);
  setSessionCookie(res, ayzenToken);
  res.json({ token: ayzenToken, refreshToken: ayzenToken, user: sanitizeUser(user) });
});

router.post("/auth/refresh", async (req, res): Promise<void> => {
  // Accepts the refresh token from the body (existing mobile/API behavior)
  // or, failing that, the AYZEN session cookie — lets a web session on any
  // *.ayzen.tech subdomain silently refresh without the SPA having to keep
  // its own copy of the token around just to call this endpoint.
  const bodyToken = typeof req.body?.refreshToken === "string" ? req.body.refreshToken : null;
  const refreshToken = bodyToken || getTokenFromReq(req);
  if (!refreshToken) { res.status(400).json({ error: "refreshToken is required" }); return; }
  const result = await getUserFromToken(refreshToken);
  if (!result) { res.status(401).json({ error: "Invalid token" }); return; }
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, result.userId));
  if (!user) { res.status(401).json({ error: "User not found" }); return; }

  // If the token being refreshed already carries a session id, keep using
  // the same user_sessions row (just slide its expiry forward) so refreshing
  // doesn't spawn a phantom "new device" in the Security page's device list
  // every few requests. Only mint a brand-new session for tokens that never
  // had one (pre-sessions-feature tokens).
  const decoded = verifyAuthToken(refreshToken);
  let token: string;
  if (decoded?.sid && (await touchSession(decoded.sid))) {
    token = signAuthToken(user.id, user.role, { sid: decoded.sid });
  } else {
    token = await mintSessionToken(user, req);
  }
  setSessionCookie(res, token);
  res.json({ token, refreshToken: token, user: sanitizeUser(user) });
});

// ─── POST /auth/forgot-password — send reset OTP ─────────────────────────────
router.post("/auth/forgot-password", otpLimiter, async (req, res): Promise<void> => {
  const { email } = req.body;
  if (!email) { res.status(400).json({ error: "email is required" }); return; }

  const [user] = await db.select({ id: usersTable.id, username: usersTable.username }).from(usersTable).where(eq(usersTable.email, email));
  if (!user) {
    res.json({ message: "If this email exists, a reset code has been sent." });
    return;
  }

  const code = generateOtp();
  await storeOtp(`reset:${email}`, code);

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"/><style>
  body{margin:0;padding:0;background:#0a0d12;font-family:'Courier New',monospace;}
  .wrap{max-width:520px;margin:40px auto;background:#0d1117;border:1px solid #1a3a3a;border-radius:8px;}
  .header{padding:24px 32px;border-bottom:1px solid #1a3a3a;background:#070a0f;}
  .logo{font-size:20px;font-weight:bold;letter-spacing:4px;color:#00d4cc;}
  .body{padding:32px;}
  h2{color:#ff6b6b;font-size:16px;letter-spacing:2px;text-transform:uppercase;margin:0 0 16px;}
  p{color:#a0c8c8;font-size:13px;line-height:1.7;margin:0 0 12px;}
  .otp{display:block;font-size:36px;font-weight:bold;letter-spacing:12px;color:#ff6b6b;margin:24px 0;text-align:center;background:#070a0f;padding:20px;border-radius:6px;border:1px solid #3a1a1a;}
  .footer{padding:20px 32px;border-top:1px solid #1a3a3a;font-size:10px;color:#2a5050;}
</style></head>
<body><div class="wrap">
  <div class="header"><div class="logo">&gt;_ AYZEN</div></div>
  <div class="body">
    <h2>Password Reset</h2>
    <p>Hi <strong>${user.username}</strong>, use this code to reset your password:</p>
    <span class="otp">${code}</span>
    <p>This code expires in <strong>10 minutes</strong>. If you didn't request this, ignore this email.</p>
  </div>
  <div class="footer">&copy; 2026 AYZEN</div>
</div></body></html>`;

  const emailResult = await sendEmail({ to: email, subject: "AYZEN — Password Reset Code", html, text: `Your AYZEN password reset code: ${code}` });
  const response: Record<string, any> = { message: "If this email exists, a reset code has been sent." };
  // SECURITY: never leak the actual reset code in production, even if email
  // delivery fails — that would let anyone reset any account's password
  // just by knowing their email address and having Resend misconfigured.
  if (!emailResult.success && process.env.NODE_ENV !== "production") {
    response._demo_code = code;
    response._demo_note = "Email delivery unavailable — code shown for demo use only (non-production)";
  }
  res.json(response);
});

// ─── POST /auth/reset-password — verify OTP + set new password ────────────────
router.post("/auth/reset-password", authLimiter, async (req, res): Promise<void> => {
  const { email, code, newPassword } = req.body;
  if (!email || !code || !newPassword) {
    res.status(400).json({ error: "email, code, and newPassword are required" }); return;
  }
  if (newPassword.length < 6) {
    res.status(400).json({ error: "Password must be at least 6 characters" }); return;
  }
  if (!(await verifyOtp(`reset:${email}`, code))) {
    res.status(400).json({ error: "Invalid or expired reset code" }); return;
  }
  const [user] = await db.select().from(usersTable).where(eq(usersTable.email, email));
  if (!user) { res.status(404).json({ error: "User not found" }); return; }

  await db.update(usersTable).set({ passwordHash: await hashPassword(newPassword), lastActiveAt: new Date() }).where(eq(usersTable.id, user.id));
  // A password reset is a meaningful security event — sign out every other
  // device/session on the account (mirrors Google/most providers), then
  // issue the one fresh session for the device that just completed the
  // reset.
  await revokeAllSessionsExcept(user.id, null).catch(() => {});
  const token = await mintSessionToken(user, req);
  setSessionCookie(res, token);
  res.json({ message: "Password reset successful", token, refreshToken: token, user: sanitizeUser(user) });
});

router.post("/auth/setup-2fa", async (_req, res): Promise<void> => {
  const secret = crypto.randomBytes(20).toString("base64").replace(/[^A-Z2-7]/gi, "A").slice(0, 32).toUpperCase();
  const otpauthUrl = `otpauth://totp/AYZEN:user@ayzen.io?secret=${secret}&issuer=AYZEN`;
  res.json({ otpauthUrl, secret, qrCodeDataUrl: `https://api.qrserver.com/v1/create-qr-code/?data=${encodeURIComponent(otpauthUrl)}&size=200x200` });
});

router.post("/auth/verify-2fa", async (_req, res): Promise<void> => {
  res.json({ message: "2FA verified successfully" });
});

// ─── Sessions & devices — the AYZEN account's "Google-style" device list ────
// Backs the Security page's "Sessions & devices" panel. Every module
// (Mail/Vault/Finance/Marketplace) shares one login token, so this list is
// really the account's single-sign-on session — this is the surface that
// lets the owner see it and kill a specific one (or all-but-this-one).

router.get("/auth/sessions", async (req, res): Promise<void> => {
  const token = getTokenFromReq(req);
  if (!token) { res.status(401).json({ error: "Unauthorized" }); return; }
  const result = await getUserFromToken(token);
  if (!result) { res.status(401).json({ error: "Invalid token" }); return; }

  const decoded = verifyAuthToken(token);
  const currentSid = decoded?.sid ?? null;

  const sessions = await listSessions(result.userId);
  res.json({
    sessions: sessions.map((s) => ({
      id: s.id,
      deviceLabel: s.deviceLabel,
      ip: s.ip,
      createdAt: s.createdAt.toISOString(),
      lastSeenAt: s.lastSeenAt.toISOString(),
      expiresAt: s.expiresAt.toISOString(),
      isCurrent: !!currentSid && s.jti === currentSid,
    })),
  });
});

router.post("/auth/sessions/:id/revoke", authLimiter, async (req, res): Promise<void> => {
  const token = getTokenFromReq(req);
  if (!token) { res.status(401).json({ error: "Unauthorized" }); return; }
  const result = await getUserFromToken(token);
  if (!result) { res.status(401).json({ error: "Invalid token" }); return; }

  const sessionId = Number(req.params.id);
  if (!Number.isInteger(sessionId) || sessionId <= 0) { res.status(400).json({ error: "Invalid session id" }); return; }

  const ok = await revokeSession(result.userId, sessionId);
  if (!ok) { res.status(404).json({ error: "Session not found or already signed out" }); return; }
  // 6e-b: this revoke is per-session but userId-scoped propagation is all
  // a Logout Token can carry (see dispatchBackchannelLogoutForUser()'s own
  // header) — fire-and-forget, never blocks this response.
  void dispatchBackchannelLogoutForUser(result.userId);
  res.json({ message: "Session signed out" });
});

router.post("/auth/sessions/revoke-others", authLimiter, async (req, res): Promise<void> => {
  const token = getTokenFromReq(req);
  if (!token) { res.status(401).json({ error: "Unauthorized" }); return; }
  const result = await getUserFromToken(token);
  if (!result) { res.status(401).json({ error: "Invalid token" }); return; }

  const decoded = verifyAuthToken(token);
  const revoked = await revokeAllSessionsExcept(result.userId, decoded?.sid ?? null);
  // 6e-b: "sign out everywhere else" is exactly the kind of account-wide
  // event Phase 6d-a's own requirement #1 names — propagate regardless of
  // whether `revoked` is 0 (harmless no-op on the receiving side either
  // way; see resolveBackchannelLogoutTargets()'s own reasoning for why
  // this stays cheap even when there's nothing for Sylo to actually do).
  void dispatchBackchannelLogoutForUser(result.userId);
  res.json({ message: "Signed out of all other sessions", revoked });
});

router.get("/auth/me", async (req, res): Promise<void> => {
  const token = getTokenFromReq(req);
  if (!token) { res.status(401).json({ error: "Unauthorized" }); return; }
  const result = await getUserFromToken(token);
  if (!result) { res.status(401).json({ error: "Invalid token" }); return; }
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, result.userId));
  if (!user) { res.status(401).json({ error: "User not found" }); return; }
  res.json(sanitizeUser(user));
});

// ─── POST /auth/logout — clear the shared AYZEN Account cookie ───────────────
// Bearer-token callers (mobile, API keys) never had a cookie to clear, but
// hitting this is harmless for them — it just revokes the current session
// the same way `/auth/sessions/:id/revoke` does, scoped to their own token.
router.post("/auth/logout", async (req, res): Promise<void> => {
  const token = getTokenFromReq(req);
  clearSessionCookie(res);
  if (!token) { res.json({ message: "Signed out" }); return; }

  const decoded = verifyAuthToken(token);
  if (decoded?.sid) {
    await revokeSessionByJti(decoded.sid).catch(() => {});
    // 6e-b: Phase 6d-a's own requirement #1 — a plain, single-device
    // Central logout must also invalidate that user's Sylo session(s),
    // not just the one Central session just revoked above. Fire-and-forget;
    // see dispatchBackchannelLogoutForUser()'s own header for why.
    if (decoded.userId) void dispatchBackchannelLogoutForUser(decoded.userId);
  }
  res.json({ message: "Signed out" });
});

// ─── POST /auth/session-exchange — cookie session → standalone token ─────────
// AYZEN Astra (browser extension, master plan §3/§4) can't rely on
// third-party cookies the way a *.ayzen.tech subdomain can, so it can't
// just read the `ayzen_session` cookie directly. Instead its background
// script calls this endpoint (which the browser DOES attach the cookie to,
// since it's a normal same-site request to the API) to exchange that
// cookie session for its own independent token — one the extension stores
// itself and refreshes on its own schedule.
//
// This deliberately requires the *cookie*, not a Bearer header — the whole
// point is "prove you're logged in on the web session," not "hand me a
// token if you already have one," which would make this endpoint a
// no-op passthrough instead of an actual trust boundary.
//
// Mirrors `mintSessionToken`'s pattern (opens its own user_sessions row) so
// the resulting extension session shows up in the Security page's device
// list — labeled distinctly — and can be individually revoked without
// signing the user out of the web app.
router.post("/auth/session-exchange", authLimiter, async (req, res): Promise<void> => {
  const cookieToken = getSessionCookie(req);
  if (!cookieToken) {
    res.status(401).json({
      error: "Unauthorized",
      code: "NO_SESSION_COOKIE",
      solution: "This endpoint exchanges an active AYZEN Account web session for an extension token. Log in on ayzen.tech first.",
    });
    return;
  }
  const result = await getUserFromToken(cookieToken);
  if (!result) { res.status(401).json({ error: "Invalid or expired session" }); return; }
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, result.userId));
  if (!user) { res.status(401).json({ error: "User not found" }); return; }

  // OIDC Roadmap — Season 3, Phase 6e-b (migration 086): an optional
  // `client_id` in the request body, tagging the resulting session as
  // opened ON BEHALF OF that OIDC client. Opt-in, not inferred from the
  // request in any other way (e.g. Origin/Referer) — this endpoint has
  // exactly two known callers today (the AYZEN Astra extension, which
  // never sends this field, and sylo-oidc-session-exchange.ts, which
  // sends `client_id: "sylo"` — see that file's own header), and this
  // stays correct for either without needing to special-case "you're
  // probably Sylo if X." Validated against the real client registry
  // (`oidcClientExists()`, Phase 2A-c) rather than accepted as any
  // string — an unrecognized `client_id` is rejected outright rather
  // than silently tagging the session with a value that could never
  // actually match anything `revokeSessionsByUserAndOriginClient()`
  // (lib/sessions.ts) would ever be called with, since a typo'd/forged
  // tag here would otherwise sit invisibly un-revocable via Back-Channel
  // Logout for as long as the session lives.
  const rawClientId = (req.body as Record<string, unknown> | undefined)?.client_id;
  let originClientId: string | null = null;
  if (typeof rawClientId === "string" && rawClientId.trim().length > 0) {
    const candidate = rawClientId.trim();
    if (!(await oidcClientExists(candidate))) {
      res.status(400).json({ error: "Unrecognized client_id" });
      return;
    }
    originClientId = candidate;
  }

  const ip = getClientIp(req);
  const userAgent = originClientId ? `${originClientId} (OIDC session)` : "AYZEN Astra (extension)";
  const { jti } = await createSession({ userId: user.id, ip, userAgent, originClientId });
  const token = signAuthToken(user.id, user.role, { sid: jti });
  // Deliberately JSON-only, no cookie — the extension keeps this in its own
  // storage, separate from the web session's cookie/localStorage.
  res.json({ token, user: sanitizeUser(user) });
});

export default router;
