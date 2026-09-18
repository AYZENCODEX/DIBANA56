/**
 * routes/vault-security.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase 5 — Vault Security: PINs & Session.
 *
 * Two independent 4-digit PINs per user, both hashed with bcrypt (lib/password.ts
 * — the same helper used for account passwords) and never stored or returned
 * in plaintext:
 *
 *   vaultPin  — unlocks Vault itself. Gated on the frontend by every /vault/*
 *               route (see components/vault/vault-unlock-gate.tsx). "Keep me
 *               signed in" is a purely client-side session length choice (see
 *               lib/vault-lock.ts) — the server only ever verifies a PIN, it
 *               never issues or tracks a separate vault session token.
 *   entityPin — required to view any entity's details. One shared PIN across
 *               every entity (not per-entity) — see components/vault/entity-pin-gate.tsx.
 *
 * Changing one PIN never reads or writes the other column — see PUT handlers
 * below, each of which only ever touches its own hash column.
 *
 * A NULL hash means that PIN has never been set. GET /vault/security/status
 * reports this so the frontend gates can skip locking on it (letting a new
 * user reach /vault/security to set their first PIN without being locked out
 * of the very page that sets it).
 *
 * Brute-force protection on the two /verify endpoints is a simple in-memory
 * lockout (5 wrong attempts → 60s cooldown per user+kind), on top of the
 * global API rate limiter already applied at the /api level in app.ts. This
 * is intentionally lightweight — good enough for a 4-digit PIN behind a
 * logged-in session, not a replacement for the account password.
 *
 * A successful entity-PIN verify also mints a short-lived, single-use reveal
 * token (see mintRevealToken/consumeRevealToken below), which
 * GET /vault/:id/seed (routes/vault.ts) now requires. Without this, a leaked
 * session cookie/token alone was enough to call that route directly and get
 * a plaintext seed phrase — the PIN gate only ever lived in the frontend UI.
 */
import { Router } from "express";
import { randomBytes } from "crypto";
import { db, vaultSecurityTable, usersTable, AUTH_STEP_POLICIES, type AuthStepPolicy } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireAuth, getRequestUserId } from "../middlewares/auth";
import { hashPassword, verifyPassword } from "../lib/password";
import { generateBase32Secret, totpVerify, totpUri } from "../lib/totp";
import { generateOtp, storeOtp, verifyOtp } from "../lib/otp-store";
import { otpLimiter } from "../middlewares/security";
import { sendEmail } from "../lib/email";
import { requireVaultPin } from "../lib/vault-pin-guard";
import QRCode from "qrcode";

const router = Router();

const PIN_REGEX = /^\d{4}$/;
const MIN_VAULT_PASSWORD_LENGTH = 8;

// OTP store key for the Vault Security PIN's mandatory setup/change email
// code — namespaced separately from every other otp-store key (account
// signup/login codes, password reset, step-up) so a code issued for one
// can never be replayed against another.
function vaultPinOtpKey(userId: number): string {
  return `vault-pin-setup:${userId}`;
}

type PinKind = "vault" | "entity";

function hashColumn(kind: PinKind) {
  return kind === "vault" ? vaultSecurityTable.vaultPinHash : vaultSecurityTable.entityPinHash;
}

async function getRow(userId: number) {
  const rows = await db.select().from(vaultSecurityTable).where(eq(vaultSecurityTable.userId, userId)).limit(1);
  return rows[0] ?? null;
}

// ─── Brute-force lockout (in-memory, best-effort — see file header) ──────────
const FAILED_ATTEMPT_LIMIT = 5;
const LOCKOUT_MS = 60_000;
const failedAttempts = new Map<string, { count: number; lockedUntil: number }>();

// "password" here is the vault-password-change lockout (wrong currentPassword
// on PUT /vault/security/password) — same lightweight, best-effort spirit as
// the PIN lockout, sharing the same Map by using a distinct key suffix.
// "vault-pin-setup" is the separate lockout for wrong accountPassword/
// emailCode on PUT /vault/security/pin (kind="vault") — kept apart so a
// mistake in one flow never locks out the other.
type LockoutKind = PinKind | "password" | "vault-pin-setup";

function attemptKey(userId: number, kind: LockoutKind): string {
  return `${userId}:${kind}`;
}

function isLockedOut(userId: number, kind: LockoutKind): number {
  const entry = failedAttempts.get(attemptKey(userId, kind));
  if (!entry) return 0;
  const remaining = entry.lockedUntil - Date.now();
  return remaining > 0 ? remaining : 0;
}

function recordFailure(userId: number, kind: LockoutKind): void {
  const key = attemptKey(userId, kind);
  const entry = failedAttempts.get(key) ?? { count: 0, lockedUntil: 0 };
  entry.count += 1;
  if (entry.count >= FAILED_ATTEMPT_LIMIT) {
    entry.lockedUntil = Date.now() + LOCKOUT_MS;
    entry.count = 0;
  }
  failedAttempts.set(key, entry);
}

function clearFailures(userId: number, kind: LockoutKind): void {
  failedAttempts.delete(attemptKey(userId, kind));
}

// ─── Reveal tokens — closes the "call the API directly, skip the PIN
// dialog" gap. A correct EntityPinGate check in the frontend only stops the
// *page*; someone with just a stolen/leaked session cookie (XSS, shared
// devtools console, replayed request, etc.) could otherwise hit
// GET /vault/:id/seed directly and get a plaintext seed phrase with no PIN
// at all, since that route only ever checked requireAuth. Now a successful
// entity-PIN verify mints a random, single-use, short-lived token; the seed
// route (routes/vault.ts) refuses to decrypt without a fresh valid one.
// In-memory + best-effort, same spirit as the lockout above — this is
// defense in depth on top of session auth, not a replacement for it.
const REVEAL_TOKEN_TTL_MS = 45_000;
const revealTokens = new Map<number, { token: string; expiresAt: number }>();

function mintRevealToken(userId: number): string {
  const token = randomBytes(24).toString("hex");
  revealTokens.set(userId, { token, expiresAt: Date.now() + REVEAL_TOKEN_TTL_MS });
  return token;
}

/** Single-use: a valid token is consumed (deleted) the moment it's checked, pass or fail. */
export function consumeRevealToken(userId: number, token: string | undefined | null): boolean {
  const entry = revealTokens.get(userId);
  if (!entry) return false;
  revealTokens.delete(userId);
  if (!token) return false;
  if (Date.now() > entry.expiresAt) return false;
  return entry.token === token;
}

/** True if this user currently has no entity PIN set — the seed route treats that as "nothing to gate on", matching every other entity-PIN check in the app. */
export async function hasNoEntityPin(userId: number): Promise<boolean> {
  const row = await getRow(userId);
  return !row?.entityPinHash;
}

// ─── GET /vault/security/status ────────────────────────────────────────────
router.get("/vault/security/status", requireAuth, async (req, res) => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }

  const row = await getRow(userId);
  res.json({
    vaultPinSet: !!row?.vaultPinHash,
    entityPinSet: !!row?.entityPinHash,
    vaultPasswordSet: !!row?.vaultPasswordHash,
    // The Vault Security PIN is mandatory (see file header) — this flag is
    // what the frontend uses to force the setup wizard before letting the
    // person touch 2FA, passkeys, the Vault password, or the auth-step
    // policy below (all of which requireVaultPin() gates once this is true).
    vaultPinMandatorySetupDone: !!row?.vaultPinHash,
    authStepPolicy: (row?.authStepPolicy ?? "any") as AuthStepPolicy,
    updatedAt: row?.updatedAt ?? null,
  });
});

// ─── PUT /vault/security/auth-policy — how many re-auth steps are required ──
// Body: { policy: "any" | "step12" | "step123", vaultPin? }. See
// schema/vault-security.ts's authStepPolicy comment and routes/vault-reauth
// .ts for what each value means. Gated by the Vault PIN like every other
// Vault-security mutation (requireVaultPin no-ops until a PIN is set).
router.put("/vault/security/auth-policy", requireAuth, async (req, res): Promise<void> => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }

  const { policy, vaultPin } = req.body ?? {};
  if (typeof policy !== "string" || !AUTH_STEP_POLICIES.includes(policy as AuthStepPolicy)) {
    res.status(400).json({ error: "Invalid policy", solution: `policy must be one of: ${AUTH_STEP_POLICIES.join(", ")}` });
    return;
  }

  const pinCheck = await requireVaultPin(userId, vaultPin);
  if (!pinCheck.ok) { res.status(pinCheck.status).json(pinCheck.body); return; }

  const existing = await getRow(userId);
  if (existing) {
    await db.update(vaultSecurityTable)
      .set({ authStepPolicy: policy, updatedAt: new Date() })
      .where(eq(vaultSecurityTable.userId, userId));
  } else {
    await db.insert(vaultSecurityTable).values({ userId, authStepPolicy: policy });
  }
  res.json({ ok: true, policy });
});

// ─── POST /vault/security/pin/request-code — step 1 of setting/changing the
// mandatory Vault Security PIN ───────────────────────────────────────────
// Sends a 6-digit email code to the account's own email. PUT
// /vault/security/pin (kind="vault") then requires both this code AND the
// account login password before accepting a new/changed PIN — deliberately
// heavier than every other PIN/password change in Vault, since this PIN is
// the most powerful credential in it (see file header + vault-pin-guard.ts).
router.post("/vault/security/pin/request-code", requireAuth, otpLimiter, async (req, res): Promise<void> => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }

  const [user] = await db.select({ email: usersTable.email }).from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  if (!user) { res.status(404).json({ error: "User not found" }); return; }

  const code = generateOtp();
  await storeOtp(vaultPinOtpKey(userId), code);

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
  <div class="header"><div class="logo">&gt;_ AYZEN</div><div class="sub">Vault Security</div></div>
  <div class="body">
    <h2>Vault PIN Setup Code</h2>
    <p>Use this code to set or change your Vault Security PIN:</p>
    <span class="otp">${code}</span>
    <p>This code expires in <strong>10 minutes</strong>. If you didn't request this, secure your account immediately.</p>
  </div>
  <div class="footer">&copy; 2026 AYZEN &mdash; Vault Security PIN setup.</div>
</div></body></html>`;

  const result = await sendEmail({ to: user.email, subject: "AYZEN — Vault PIN Setup Code", html, text: `Your Vault PIN setup code: ${code} (expires in 10 minutes)` });
  if (!result.success) {
    res.status(503).json({ error: "Failed to send email. Please check email config.", detail: result.error });
    return;
  }
  res.json({ message: "Verification code sent to your email." });
});

// ─── PUT /vault/security/password — set or change the Vault Auth Password ──
// Body: { password, currentPassword? }. currentPassword is required only
// when a vault password is already set (same "prove you know the existing
// one before overwriting it" rule as PUT /vault/security/pin above). This
// is intentionally NOT the account login password — see schema/vault-
// security.ts's vaultPasswordHash field comment for why.
router.put("/vault/security/password", requireAuth, async (req, res): Promise<void> => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }

  const lockedMs = isLockedOut(userId, "password");
  if (lockedMs > 0) {
    res.status(429).json({
      error: "Too many attempts",
      code: "PASSWORD_LOCKED",
      solution: `Wait ${Math.ceil(lockedMs / 1000)}s before trying again.`,
      retryAfterMs: lockedMs,
    });
    return;
  }

  const { password, currentPassword, vaultPin } = req.body ?? {};
  if (typeof password !== "string" || password.length < MIN_VAULT_PASSWORD_LENGTH) {
    res.status(400).json({
      error: "Invalid password",
      solution: `Vault password must be at least ${MIN_VAULT_PASSWORD_LENGTH} characters.`,
    });
    return;
  }

  const pinCheck = await requireVaultPin(userId, vaultPin);
  if (!pinCheck.ok) { res.status(pinCheck.status).json(pinCheck.body); return; }

  const existing = await getRow(userId);

  if (existing?.vaultPasswordHash) {
    if (typeof currentPassword !== "string" || !currentPassword) {
      res.status(400).json({ error: "Current vault password required", solution: "Provide currentPassword to change it." });
      return;
    }
    const matches = await verifyPassword(currentPassword, existing.vaultPasswordHash);
    if (!matches) {
      recordFailure(userId, "password");
      res.status(403).json({ error: "Incorrect current vault password", code: "WRONG_CURRENT_PASSWORD" });
      return;
    }
  }

  const newHash = await hashPassword(password);
  if (existing) {
    await db.update(vaultSecurityTable)
      .set({ vaultPasswordHash: newHash, updatedAt: new Date() })
      .where(eq(vaultSecurityTable.userId, userId));
  } else {
    await db.insert(vaultSecurityTable).values({ userId, vaultPasswordHash: newHash });
  }

  clearFailures(userId, "password");
  res.json({ ok: true });
});

// ─── POST /vault/security/password/disable — revert to the account password ─
// Clears vaultPasswordHash. If no Vault PIN is set either, this leaves the
// account with no fallback credential — Vault re-auth then has only the
// passkey path (or is entirely inaccessible without one). The frontend
// warns about this before calling here (see VaultPasswordCard).
router.post("/vault/security/password/disable", requireAuth, async (req, res): Promise<void> => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }

  const pinCheck = await requireVaultPin(userId, (req.body ?? {}).vaultPin);
  if (!pinCheck.ok) { res.status(pinCheck.status).json(pinCheck.body); return; }

  await db.update(vaultSecurityTable)
    .set({ vaultPasswordHash: null, updatedAt: new Date() })
    .where(eq(vaultSecurityTable.userId, userId));
  res.json({ ok: true });
});

// ─── PUT /vault/security/pin — set or change a PIN ─────────────────────────
// kind="entity": Body: { kind: "entity", pin: "1234", currentPin?: "0000" }
//   currentPin is required only when that PIN is already set (proves the
//   caller knows the existing PIN before overwriting it).
//
// kind="vault": Body: { kind: "vault", pin: "1234", accountPassword,
//   emailCode }. Deliberately heavier — this is the Vault Security PIN,
//   the most powerful credential in Vault (see vault-pin-guard.ts's file
//   header). Setting/changing it always requires BOTH the account login
//   password AND a fresh email code from POST
//   /vault/security/pin/request-code, whether or not a PIN was already set
//   — there is no lighter "currentPin" path for this kind, unlike entity.
router.put("/vault/security/pin", requireAuth, async (req, res) => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }

  const { kind, pin, currentPin, accountPassword, emailCode } = req.body ?? {};
  if (kind !== "vault" && kind !== "entity") {
    res.status(400).json({ error: "Invalid kind", solution: "kind must be \"vault\" or \"entity\"." });
    return;
  }
  if (typeof pin !== "string" || !PIN_REGEX.test(pin)) {
    res.status(400).json({ error: "Invalid PIN", solution: "PIN must be exactly 4 digits." });
    return;
  }

  const existing = await getRow(userId);

  if (kind === "vault") {
    const lockedMs = isLockedOut(userId, "vault-pin-setup");
    if (lockedMs > 0) {
      res.status(429).json({
        error: "Too many attempts",
        code: "VAULT_PIN_SETUP_LOCKED",
        solution: `Wait ${Math.ceil(lockedMs / 1000)}s before trying again.`,
        retryAfterMs: lockedMs,
      });
      return;
    }
    if (typeof accountPassword !== "string" || !accountPassword) {
      res.status(400).json({ error: "Account password required", code: "ACCOUNT_PASSWORD_REQUIRED" });
      return;
    }
    if (typeof emailCode !== "string" || !emailCode.trim()) {
      res.status(400).json({ error: "Email code required", code: "EMAIL_CODE_REQUIRED", solution: "Request a code via POST /vault/security/pin/request-code first." });
      return;
    }
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
    if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }
    const passwordOk = await verifyPassword(accountPassword, user.passwordHash);
    if (!passwordOk) {
      recordFailure(userId, "vault-pin-setup");
      res.status(403).json({ error: "Incorrect account password", code: "WRONG_ACCOUNT_PASSWORD" });
      return;
    }
    const codeOk = await verifyOtp(vaultPinOtpKey(userId), emailCode);
    if (!codeOk) {
      recordFailure(userId, "vault-pin-setup");
      res.status(403).json({ error: "Invalid or expired email code", code: "WRONG_EMAIL_CODE" });
      return;
    }
    clearFailures(userId, "vault-pin-setup");
  } else {
    const existingHash = existing?.entityPinHash;
    if (existingHash) {
      // Same brute-force lockout as POST /vault/security/verify (kind=
      // "entity") — this currentPin check is just as much a 4-digit guessing
      // surface and must share the limiter, or an attacker with a valid
      // session could brute-force the entity PIN here with no rate limit at
      // all by repeatedly calling this endpoint instead of /verify.
      const lockedMs = isLockedOut(userId, "entity");
      if (lockedMs > 0) {
        res.status(429).json({
          error: "Too many attempts",
          code: "PIN_LOCKED",
          solution: `Wait ${Math.ceil(lockedMs / 1000)}s before trying again.`,
          retryAfterMs: lockedMs,
        });
        return;
      }
      if (typeof currentPin !== "string" || !PIN_REGEX.test(currentPin)) {
        res.status(400).json({ error: "Current PIN required", solution: "Provide currentPin to change an existing PIN." });
        return;
      }
      const matches = await verifyPassword(currentPin, existingHash);
      if (!matches) {
        recordFailure(userId, "entity");
        res.status(403).json({ error: "Incorrect current PIN", code: "WRONG_CURRENT_PIN" });
        return;
      }
    }
  }

  const newHash = await hashPassword(pin);
  const column = kind === "vault" ? "vaultPinHash" : "entityPinHash";

  if (existing) {
    await db.update(vaultSecurityTable)
      .set({ [column]: newHash, updatedAt: new Date() } as any)
      .where(eq(vaultSecurityTable.userId, userId));
  } else {
    await db.insert(vaultSecurityTable).values({
      userId,
      [column]: newHash,
    } as any);
  }

  clearFailures(userId, kind);
  res.json({ ok: true, kind });
});

// ─── POST /vault/security/verify — check a PIN without changing anything ──
// Body: { kind: "vault" | "entity", pin: "1234" }
router.post("/vault/security/verify", requireAuth, async (req, res) => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }

  const { kind, pin } = req.body ?? {};
  if (kind !== "vault" && kind !== "entity") {
    res.status(400).json({ error: "Invalid kind", solution: "kind must be \"vault\" or \"entity\"." });
    return;
  }

  const lockedMs = isLockedOut(userId, kind);
  if (lockedMs > 0) {
    res.status(429).json({
      error: "Too many attempts",
      code: "PIN_LOCKED",
      solution: `Wait ${Math.ceil(lockedMs / 1000)}s before trying again.`,
      retryAfterMs: lockedMs,
    });
    return;
  }

  if (typeof pin !== "string" || !PIN_REGEX.test(pin)) {
    res.status(400).json({ error: "Invalid PIN", solution: "PIN must be exactly 4 digits." });
    return;
  }

  const row = await getRow(userId);
  const hash = kind === "vault" ? row?.vaultPinHash : row?.entityPinHash;

  if (!hash) {
    // Nothing set yet — nothing to verify against. Treat as valid so the
    // frontend gate (which already skips locking when unset) never dead-ends.
    res.json({ valid: true, pinSet: false });
    return;
  }

  const matches = await verifyPassword(pin, hash);
  if (!matches) {
    recordFailure(userId, kind);
    res.status(200).json({ valid: false, pinSet: true });
    return;
  }

  clearFailures(userId, kind);
  if (kind === "entity") {
    const revealToken = mintRevealToken(userId);
    res.json({ valid: true, pinSet: true, revealToken, revealTokenExpiresInMs: REVEAL_TOKEN_TTL_MS });
    return;
  }
  res.json({ valid: true, pinSet: true });
});

// ─── Vault 2FA — Vault's OWN TOTP, separate from account login 2FA ──────────
// Same RFC 6238 TOTP flow as routes/security.ts's /security/2fa/*, but reads
// and writes vault_security.vault_two_fa_secret / vault_two_fa_enabled
// instead of users.two_fa_secret / two_fa_enabled — so enabling, disabling,
// or resetting one never touches the other. This is what routes/vault-reauth
// .ts now checks for the Vault gate's password+2FA fallback.

// ─── GET /vault/security/2fa/status ────────────────────────────────────────
router.get("/vault/security/2fa/status", requireAuth, async (req, res) => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }
  const row = await getRow(userId);
  res.json({ enabled: !!row?.vaultTwoFaEnabled });
});

// ─── POST /vault/security/2fa/setup — generate a new secret + QR (not yet enabled) ─
router.post("/vault/security/2fa/setup", requireAuth, async (req, res) => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }

  const [user] = await db.select({ email: usersTable.email }).from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  if (!user) { res.status(404).json({ error: "User not found" }); return; }

  const secret = generateBase32Secret();
  const existing = await getRow(userId);
  if (existing) {
    await db.update(vaultSecurityTable)
      .set({ vaultTwoFaSecret: secret, vaultTwoFaEnabled: false, updatedAt: new Date() })
      .where(eq(vaultSecurityTable.userId, userId));
  } else {
    await db.insert(vaultSecurityTable).values({ userId, vaultTwoFaSecret: secret, vaultTwoFaEnabled: false });
  }

  // Distinct label from the account's own 2FA entry so both can coexist in
  // the same authenticator app without overwriting one another.
  const otpauth = totpUri(secret, `${user.email} (Vault)`);
  const qrDataUrl = await QRCode.toDataURL(otpauth);
  res.json({ secret, qrDataUrl, otpauth });
});

// ─── POST /vault/security/2fa/verify — confirm a 6-digit code to enable ───
router.post("/vault/security/2fa/verify", requireAuth, async (req, res) => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }

  const { token, vaultPin } = req.body ?? {};
  if (typeof token !== "string" || !token) { res.status(400).json({ error: "token is required" }); return; }

  const pinCheck = await requireVaultPin(userId, vaultPin);
  if (!pinCheck.ok) { res.status(pinCheck.status).json(pinCheck.body); return; }

  const row = await getRow(userId);
  if (!row?.vaultTwoFaSecret) { res.status(400).json({ error: "Run Vault 2FA setup first" }); return; }
  if (!totpVerify(token, row.vaultTwoFaSecret)) { res.status(400).json({ error: "Invalid or expired code" }); return; }

  await db.update(vaultSecurityTable)
    .set({ vaultTwoFaEnabled: true, updatedAt: new Date() })
    .where(eq(vaultSecurityTable.userId, userId));
  res.json({ enabled: true });
});

// ─── POST /vault/security/2fa/disable ──────────────────────────────────────
router.post("/vault/security/2fa/disable", requireAuth, async (req, res) => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }

  const pinCheck = await requireVaultPin(userId, (req.body ?? {}).vaultPin);
  if (!pinCheck.ok) { res.status(pinCheck.status).json(pinCheck.body); return; }

  await db.update(vaultSecurityTable)
    .set({ vaultTwoFaEnabled: false, vaultTwoFaSecret: null, updatedAt: new Date() })
    .where(eq(vaultSecurityTable.userId, userId));
  res.json({ enabled: false });
});

export default router;
