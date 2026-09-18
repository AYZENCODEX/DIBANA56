/**
 * routes/vault-reauth.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Vault re-authentication — the gate in front of every /vault/* page (see
 * components/vault/vault-unlock-gate.tsx + pages/user/vault-auth.tsx on the
 * frontend). Two ways to clear it, passkey tried first:
 *
 *   1. Passkey (preferred) — POST /vault/reauth/passkey/options + /verify.
 *      Scoped to the CURRENT account's own registered passkeys only; unlike
 *      routes/passkey.ts's login endpoints this never issues a new session
 *      token or touches anomalous-IP step-up — it's just a possession check
 *      on top of an already-valid session.
 *   2. Vault PIN/Password + Vault 2FA (fallback, e.g. no passkey registered,
 *      or the browser/device doesn't support WebAuthn) — POST
 *      /vault/reauth/verify. The credential checked is EITHER
 *      vault_security.vault_pin_hash or vault_security.vault_password_hash —
 *      Vault's OWN PIN/password, set up on /vault/security. The account
 *      login password (users.password_hash) is NEVER checked here — Vault
 *      re-auth never needs or accepts it, only a credential set up
 *      specifically for Vault. If neither a Vault PIN nor a Vault password
 *      has been configured yet, this endpoint refuses with 428 and sends the
 *      person to /vault/security to set one up first. The 2FA code is
 *      checked against vault_security.vault_two_fa_secret — Vault's OWN
 *      TOTP, entirely separate from users.two_fa_secret (account login 2FA
 *      on the /security page). See schema/vault-security.ts and
 *      routes/vault-security.ts's /vault/security/pin,
 *      /vault/security/password and /vault/security/2fa/* endpoints, which
 *      manage those columns.
 *
 * Requirement: re-verify (either method) on the FIRST Vault visit of the
 * calendar day, or whenever more than 3 hours have passed since the last
 * successful Vault re-auth — whichever comes first. Inside that 3-hour /
 * same-day window, no further re-auth is needed.
 *
 * Same architecture as the PIN system this replaced (see components/vault/
 * vault-unlock-gate.tsx + lib/vault-lock.ts): these endpoints only ever
 * verify credentials. The "am I still inside the window" decision and the
 * timestamp itself live client-side (lib/vault-lock.ts), same spirit as the
 * account's own "keep me signed in" toggle — the server ties this to nothing
 * but credential correctness so a stale timer on the client can never grant
 * more access than a fresh credential check would.
 *
 * The entity-view PIN (kind="entity" in vault-security.ts) is untouched by
 * this file — that's a separate, lighter gate scoped to a browser session,
 * not part of this daily/3h re-auth requirement.
 *
 * Step 3 — email code + Vault PIN (POST /vault/reauth/email-code/send +
 * /vault/reauth/verify-step3) — is a fail-over for when step 2 can't be
 * completed (e.g. a lost authenticator app for Vault 2FA), reachable from
 * the "step 2 unavailable" link in components/vault/vault-auth.tsx. Only
 * available once a Vault PIN is set (see step3Available in the status
 * response). Whether passing step 1/2/3 individually is enough to unlock,
 * or all of them are required together, is controlled by
 * vault_security.auth_step_policy — see schema/vault-security.ts.
 */
import { Router } from "express";
import { db, usersTable, vaultSecurityTable, passkeyCredentialsTable, type AuthStepPolicy } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import { requireAuth, getRequestUserId, pepDecisionObserver } from "../middlewares/auth";
import { verifyPassword } from "../lib/password";
import { totpVerify } from "../lib/totp";
import { getWebAuthnConfig, newChallengeKey, storeChallenge, consumeChallenge } from "../lib/passkey";
import { generateOtp, storeOtp, verifyOtp } from "../lib/otp-store";
import { otpLimiter } from "../middlewares/security";
import { sendEmail } from "../lib/email";
import { PolicyEngine } from "../lib/policy/policy-engine";
import { createResourceOwnershipRule } from "../lib/policy/resource";
import { authorize } from "../lib/policy/pep";

const router = Router();

// ── Route Integration Roadmap — Season C, Phase C2 (mechanical sweep, batch 2) ──
// This file's own grep hit (`cred.userId !== userId` in
// POST /vault/reauth/passkey/verify, below) is a strict ownership question
// with no admin bypass — same posture as routes/passkey.ts's PATCH/DELETE
// /passkey/:id (this same batch): a passkey credential belongs to exactly
// one account, so `createResourceOwnershipRule()` alone is registered, no
// role-override rule. `authorize()` is called inline rather than via a
// route-level `requireOwnership()` middleware because the credential row
// this check needs is already fetched earlier in the SAME handler (for the
// WebAuthn verification step right after it) — a middleware would just
// re-run that lookup a second time. Reusing the already-fetched `cred`
// keeps this a one-query check, same "resource lookup, not request-
// supplied ownerId" trust boundary Phase B1's finance.ts drew, just via an
// existing variable instead of a fresh `ResourceRefBuilder` read.
const VAULT_REAUTH_OWNER_SENTINEL_NONE = -1;

const vaultReauthOwnershipEngine = new PolicyEngine({ onDecision: pepDecisionObserver });
vaultReauthOwnershipEngine.registerRule("resource-ownership", createResourceOwnershipRule());

// OTP key for Vault re-auth's step 3 (email code + Vault PIN failover) —
// namespaced separately from every other otp-store key, including the
// unrelated vault-pin-setup one used by PUT /vault/security/pin.
function vaultReauthOtpKey(userId: number): string {
  return `vault-reauth-step3:${userId}`;
}

// ─── Brute-force lockout (in-memory, best-effort — mirrors vault-security.ts) ─
// Shared across both re-auth methods (passkey + password/2FA) — a lockout on
// one blocks the other too, since both are just alternate proofs of the same
// "is this really the account owner" question.
const FAILED_ATTEMPT_LIMIT = 5;
const LOCKOUT_MS = 60_000;
const failedAttempts = new Map<number, { count: number; lockedUntil: number }>();

function isLockedOut(userId: number): number {
  const entry = failedAttempts.get(userId);
  if (!entry) return 0;
  const remaining = entry.lockedUntil - Date.now();
  return remaining > 0 ? remaining : 0;
}

function recordFailure(userId: number): void {
  const entry = failedAttempts.get(userId) ?? { count: 0, lockedUntil: 0 };
  entry.count += 1;
  if (entry.count >= FAILED_ATTEMPT_LIMIT) {
    entry.lockedUntil = Date.now() + LOCKOUT_MS;
    entry.count = 0;
  }
  failedAttempts.set(userId, entry);
}

function clearFailures(userId: number): void {
  failedAttempts.delete(userId);
}

// ─── GET /vault/reauth/status — what can this account use to unlock Vault? ───
// The Vault re-auth screen needs this up front: whether to offer the passkey
// button at all (account has ≥1 passkey registered), and whether the
// password+2FA fallback is even usable yet (Vault 2FA must be set up first —
// if not, the frontend sends them to /vault/security instead of showing a
// code field that can never be filled in).
router.get("/vault/reauth/status", requireAuth, async (req, res): Promise<void> => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }

  const [vaultSec] = await db.select({
    vaultTwoFaEnabled: vaultSecurityTable.vaultTwoFaEnabled,
    vaultPasswordHash: vaultSecurityTable.vaultPasswordHash,
    vaultPinHash: vaultSecurityTable.vaultPinHash,
    authStepPolicy: vaultSecurityTable.authStepPolicy,
  }).from(vaultSecurityTable).where(eq(vaultSecurityTable.userId, userId)).limit(1);
  const passkeys = await db.select({ id: passkeyCredentialsTable.id })
    .from(passkeyCredentialsTable).where(eq(passkeyCredentialsTable.userId, userId));

  res.json({
    twoFaEnabled: !!vaultSec?.vaultTwoFaEnabled,
    hasPasskey: passkeys.length > 0,
    // Lets the frontend decide which credential field to show on the
    // fallback step (matching whichever one is actually being checked by
    // POST /vault/reauth/verify below) — PIN takes priority when both are
    // set. usesVaultPassword is kept for backward compatibility with older
    // frontend builds; usesVaultPin is the new field.
    usesVaultPassword: !!vaultSec?.vaultPasswordHash,
    usesVaultPin: !!vaultSec?.vaultPinHash,
    hasCredential: !!vaultSec?.vaultPasswordHash || !!vaultSec?.vaultPinHash,
    // Step 3 (email code + Vault PIN) only ever has ONE possible credential
    // — the Vault PIN itself, unlike step 2 which can be PIN-or-password —
    // so step 3 is only reachable once a Vault PIN exists.
    step3Available: !!vaultSec?.vaultPinHash,
    // "any" (default): passing any ONE of the available steps unlocks.
    // "step12": steps 1+2 both required. "step123": all three required.
    // See schema/vault-security.ts's authStepPolicy comment.
    authStepPolicy: (vaultSec?.authStepPolicy ?? "any") as AuthStepPolicy,
  });
});

// ─── POST /vault/reauth/email-code/send — step 3 email half ───────────────
// Sends a 6-digit code to the account's own email. Step 3 (email code +
// Vault PIN) is the fail-over Vault re-auth reaches for when step 2 (Vault
// PIN/password + Vault 2FA) can't be completed — e.g. a lost authenticator
// app — see components/vault/vault-auth.tsx's "step 2 unavailable" link.
// It's also what routes/vault-security.ts's mandatory-PIN flow points to
// when 2FA/password/passkey are ALL unavailable: email + Vault PIN is the
// one path that never depends on anything else being intact.
router.post("/vault/reauth/email-code/send", requireAuth, otpLimiter, async (req, res): Promise<void> => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }

  const [user] = await db.select({ email: usersTable.email }).from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  if (!user) { res.status(404).json({ error: "User not found" }); return; }

  const [vaultSec] = await db.select({ vaultPinHash: vaultSecurityTable.vaultPinHash })
    .from(vaultSecurityTable).where(eq(vaultSecurityTable.userId, userId)).limit(1);
  if (!vaultSec?.vaultPinHash) {
    res.status(428).json({
      error: "Set a Vault PIN before using this fail-over",
      code: "CREDENTIAL_NOT_SET",
      solution: "Set a Vault PIN under Vault → Security, then try again.",
    });
    return;
  }

  const code = generateOtp();
  await storeOtp(vaultReauthOtpKey(userId), code);

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
  <div class="header"><div class="logo">&gt;_ AYZEN</div><div class="sub">Vault Re-auth</div></div>
  <div class="body">
    <h2>Vault Unlock Code</h2>
    <p>Use this code with your Vault PIN to unlock Vault:</p>
    <span class="otp">${code}</span>
    <p>This code expires in <strong>10 minutes</strong>. If you didn't request this, secure your account immediately.</p>
  </div>
  <div class="footer">&copy; 2026 AYZEN &mdash; Vault re-auth fail-over.</div>
</div></body></html>`;

  const result = await sendEmail({ to: user.email, subject: "AYZEN — Vault Unlock Code", html, text: `Your Vault unlock code: ${code} (expires in 10 minutes)` });
  if (!result.success) {
    res.status(503).json({ error: "Failed to send email. Please check email config.", detail: result.error });
    return;
  }
  res.json({ message: "Verification code sent to your email." });
});

// ─── POST /vault/reauth/verify-step3 — email code + Vault PIN ─────────────
// Body: { pin, emailCode }. Shares the same in-memory lockout as passkey +
// step 2 (see isLockedOut/recordFailure above) — a lockout on any one
// method blocks all three, since they're all just alternate proofs of the
// same "is this really the account owner" question.
router.post("/vault/reauth/verify-step3", requireAuth, async (req, res): Promise<void> => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }

  const lockedMs = isLockedOut(userId);
  if (lockedMs > 0) {
    res.status(429).json({
      error: "Too many attempts",
      code: "REAUTH_LOCKED",
      solution: `Wait ${Math.ceil(lockedMs / 1000)}s before trying again.`,
      retryAfterMs: lockedMs,
    });
    return;
  }

  const { pin, emailCode } = req.body ?? {};
  const [vaultSec] = await db.select({ vaultPinHash: vaultSecurityTable.vaultPinHash })
    .from(vaultSecurityTable).where(eq(vaultSecurityTable.userId, userId)).limit(1);

  if (!vaultSec?.vaultPinHash) {
    res.status(428).json({
      error: "Set a Vault PIN before using this fail-over",
      code: "CREDENTIAL_NOT_SET",
      solution: "Set a Vault PIN under Vault → Security, then try again.",
    });
    return;
  }

  if (typeof pin !== "string" || !pin) {
    res.status(400).json({ error: "Vault PIN is required", code: "CREDENTIAL_REQUIRED" });
    return;
  }
  const pinOk = await verifyPassword(pin, vaultSec.vaultPinHash);
  if (!pinOk) {
    recordFailure(userId);
    res.status(401).json({ error: "Incorrect Vault PIN", code: "WRONG_PIN" });
    return;
  }

  if (typeof emailCode !== "string" || !emailCode.trim()) {
    res.status(400).json({ error: "Email code is required", code: "EMAIL_CODE_REQUIRED" });
    return;
  }
  const codeOk = await verifyOtp(vaultReauthOtpKey(userId), emailCode);
  if (!codeOk) {
    recordFailure(userId);
    res.status(401).json({ error: "Invalid or expired email code", code: "WRONG_EMAIL_CODE" });
    return;
  }

  clearFailures(userId);
  res.json({ ok: true });
});

// ─── POST /vault/reauth/passkey/options ────────────────────────────────────
// Scoped to only the current user's own passkeys — never an empty/anonymous
// allow-list like routes/passkey.ts's login endpoint, since there's already
// a known, authenticated account here.
router.post("/vault/reauth/passkey/options", requireAuth, async (req, res): Promise<void> => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }

  const lockedMs = isLockedOut(userId);
  if (lockedMs > 0) {
    res.status(429).json({ error: "Too many attempts", code: "REAUTH_LOCKED", solution: `Wait ${Math.ceil(lockedMs / 1000)}s before trying again.`, retryAfterMs: lockedMs });
    return;
  }

  const creds = await db.select().from(passkeyCredentialsTable).where(eq(passkeyCredentialsTable.userId, userId));
  if (creds.length === 0) { res.status(404).json({ error: "No passkeys registered for this account" }); return; }

  const webAuthn = getWebAuthnConfig(req);
  const options = await generateAuthenticationOptions({
    rpID: webAuthn.rpID,
    allowCredentials: creds.map((c) => ({
      id: c.credentialId,
      transports: c.transports ? (c.transports.split(",") as any[]) : undefined,
    })),
    userVerification: "preferred",
  });

  const challengeKey = newChallengeKey();
  storeChallenge(challengeKey, options.challenge);
  res.json({ options, challengeKey });
});

// ─── POST /vault/reauth/passkey/verify ─────────────────────────────────────
// Body: { challengeKey, response }. Unlike routes/passkey.ts's login/verify,
// this never issues a new session token — the caller already has one. A
// successful verification here just proves possession of a passkey
// belonging to the CURRENT session's account, which is all Vault re-auth
// needs.
router.post("/vault/reauth/passkey/verify", requireAuth, async (req, res): Promise<void> => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }

  const lockedMs = isLockedOut(userId);
  if (lockedMs > 0) {
    res.status(429).json({ error: "Too many attempts", code: "REAUTH_LOCKED", solution: `Wait ${Math.ceil(lockedMs / 1000)}s before trying again.`, retryAfterMs: lockedMs });
    return;
  }

  const { challengeKey, response } = req.body as { challengeKey?: string; response?: any };
  if (!challengeKey || !response) { res.status(400).json({ error: "challengeKey and response are required" }); return; }

  const entry = consumeChallenge(challengeKey);
  if (!entry) { res.status(400).json({ error: "Challenge expired or invalid. Try again." }); return; }

  const credentialId: string | undefined = response.id;
  if (!credentialId) { res.status(400).json({ error: "Malformed passkey response" }); return; }

  const [cred] = await db.select().from(passkeyCredentialsTable).where(eq(passkeyCredentialsTable.credentialId, credentialId));
  // Must both exist AND belong to the currently signed-in account — a
  // passkey for a *different* AYZEN account must never clear *this*
  // session's Vault gate, even if the browser happens to have both saved.
  // Phase C2: PDP-routed, same "Passkey not found"/non-owner response as
  // before (a missing credential and a real non-owner both DENY the same
  // way — sentinel ownerId trick, see this file's Phase C2 header note).
  const credOwnership = await authorize({
    req,
    engine: vaultReauthOwnershipEngine,
    action: "vault.reauth.passkey_verify",
    resource: { type: "passkey.credential", id: cred?.id ?? credentialId, ownerId: cred?.userId ?? VAULT_REAUTH_OWNER_SENTINEL_NONE },
  });
  if (credOwnership.decision.effect !== "ALLOW") {
    res.status(401).json({ error: "This passkey does not belong to your account" });
    return;
  }
  if (!cred) {
    // Unreachable in practice — a missing `cred` is given the sentinel
    // ownerId above, which the ownership rule can never ALLOW (ALLOW
    // requires ownerId === subject.userId, see ownership-rule.ts), so the
    // branch above already returned. Kept purely so TypeScript can narrow
    // `cred` to non-null for everything below, same "defensive only"
    // posture ownership-rule.ts's own null-subject check documents.
    res.status(401).json({ error: "This passkey does not belong to your account" });
    return;
  }

  try {
    const webAuthn = getWebAuthnConfig(req);
    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: entry.challenge,
      expectedOrigin: webAuthn.origin,
      expectedRPID: webAuthn.rpID,
      credential: {
        id: cred.credentialId,
        publicKey: new Uint8Array(Buffer.from(cred.publicKey, "base64url")),
        counter: cred.counter,
        transports: cred.transports ? (cred.transports.split(",") as any[]) : undefined,
      },
    });

    if (!verification.verified) {
      recordFailure(userId);
      res.status(401).json({ error: "Passkey verification failed" });
      return;
    }

    await db.update(passkeyCredentialsTable)
      .set({ counter: verification.authenticationInfo.newCounter, lastUsedAt: new Date() })
      .where(eq(passkeyCredentialsTable.id, cred.id));

    clearFailures(userId);
    res.json({ ok: true });
  } catch (err: any) {
    recordFailure(userId);
    res.status(401).json({ error: err.message || "Passkey verification failed" });
  }
});

// ─── POST /vault/reauth/verify — Vault PIN/password + Vault 2FA check ─────
// Body: { password?: string, pin?: string, totpCode?: string }. Exactly one
// of password/pin is expected, matching whichever credential the account
// actually has configured (PIN takes priority when both exist — see GET
// /vault/reauth/status). The account login password is never accepted here.
router.post("/vault/reauth/verify", requireAuth, async (req, res): Promise<void> => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }

  const lockedMs = isLockedOut(userId);
  if (lockedMs > 0) {
    res.status(429).json({
      error: "Too many attempts",
      code: "REAUTH_LOCKED",
      solution: `Wait ${Math.ceil(lockedMs / 1000)}s before trying again.`,
      retryAfterMs: lockedMs,
    });
    return;
  }

  const { password, pin, totpCode } = req.body ?? {};

  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }

  // Vault 2FA is mandatory for this fallback — set up separately from
  // account 2FA on /vault/security (see GET /vault/reauth/status, which the
  // frontend checks first to send them there instead of dead-ending here).
  const [vaultSec] = await db.select().from(vaultSecurityTable).where(eq(vaultSecurityTable.userId, userId)).limit(1);

  const hasVaultPin = !!vaultSec?.vaultPinHash;
  const hasVaultPassword = !!vaultSec?.vaultPasswordHash;

  if (!hasVaultPin && !hasVaultPassword) {
    res.status(428).json({
      error: "Set a Vault PIN or password to unlock Vault",
      code: "CREDENTIAL_NOT_SET",
      solution: "Set a Vault PIN or password under Vault → Security, then try again.",
    });
    return;
  }

  let credentialKind: "pin" | "password";
  let credentialHash: string;
  let providedValue: unknown;

  if (hasVaultPin) {
    credentialKind = "pin";
    credentialHash = vaultSec!.vaultPinHash!;
    providedValue = pin;
  } else {
    credentialKind = "password";
    credentialHash = vaultSec!.vaultPasswordHash!;
    providedValue = password;
  }

  if (typeof providedValue !== "string" || !providedValue) {
    res.status(400).json({
      error: credentialKind === "pin" ? "Vault PIN is required" : "Vault password is required",
      code: "CREDENTIAL_REQUIRED",
    });
    return;
  }

  const credentialOk = await verifyPassword(providedValue, credentialHash);
  if (!credentialOk) {
    recordFailure(userId);
    res.status(401).json({
      error: credentialKind === "pin" ? "Incorrect Vault PIN" : "Incorrect Vault password",
      code: credentialKind === "pin" ? "WRONG_PIN" : "WRONG_PASSWORD",
    });
    return;
  }

  if (!vaultSec?.vaultTwoFaEnabled || !vaultSec?.vaultTwoFaSecret) {
    res.status(428).json({
      error: "Vault 2FA is required to access Vault",
      code: "2FA_NOT_ENABLED",
      solution: "Enable 2FA under Vault → Security, then try again.",
    });
    return;
  }

  if (typeof totpCode !== "string" || !totpCode.trim()) {
    res.status(400).json({ error: "Authenticator code is required", code: "TOTP_REQUIRED" });
    return;
  }

  const totpOk = totpVerify(totpCode, vaultSec.vaultTwoFaSecret);
  if (!totpOk) {
    recordFailure(userId);
    res.status(401).json({ error: "Invalid authenticator code", code: "WRONG_TOTP" });
    return;
  }

  clearFailures(userId);
  res.json({ ok: true });
});

export default router;
