/**
 * routes/passkey.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Passkey (WebAuthn/FIDO2) registration and login.
 *
 *  Registration (requires an existing session — adding a passkey to an
 *  already-logged-in account):
 *    POST /passkey/register/options   → challenge + WebAuthn creation options
 *    POST /passkey/register/verify    → verify + store the new credential
 *    GET  /passkey/list               → list this account's passkeys
 *    PATCH  /passkey/:id              → rename a passkey
 *    DELETE /passkey/:id              → remove a passkey
 *
 *  Login (no session yet — this IS how you get one):
 *    POST /passkey/login/options      → challenge + WebAuthn request options
 *                                        (email optional — omit it for
 *                                        discoverable/usernameless login)
 *    POST /passkey/login/verify       → verify assertion, issue session token
 *
 * SECURITY NOTES
 *  - Verification always resolves the account from the credential ID stored
 *    in passkey_credentials, never from the client-supplied email — the
 *    email in /login/options is only used to narrow which credentials the
 *    browser is hinted to offer (UX), it grants nothing by itself.
 *  - counter is checked/updated on every login to detect cloned authenticators
 *    (see @simplewebauthn/server's verifyAuthenticationResponse).
 */

import { Router } from "express";
import { db, usersTable, passkeyCredentialsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import { requireAuth, pepDecisionObserver } from "../middlewares/auth";
import { signAuthToken } from "../lib/jwt";
import { rpName, getWebAuthnConfig, newChallengeKey, storeChallenge, consumeChallenge } from "../lib/passkey";
import {
  getClientIp,
  isAnomalousIp,
  recordLoginHistory,
  markLoginHistoryStatus,
  availableStepUpMethods,
  createLoginChallenge,
  getLoginChallenge,
  markStepUpMethodComplete,
  stepUpOtpKey,
} from "../lib/login-security";
import { generateOtp, storeOtp } from "../lib/otp-store";
import { sendEmail } from "../lib/email";
import { requireVaultPin } from "../lib/vault-pin-guard";
import { PolicyEngine } from "../lib/policy/policy-engine";
import { createResourceOwnershipRule } from "../lib/policy/resource";
import { authorize } from "../lib/policy/pep";

const router = Router();

// ── Route Integration Roadmap — Season C, Phase C2 (mechanical sweep, batch 2) ──
// Grep for `userId !== `/`!== .*userId` (the same audit Phase C1 ran)
// turned up two hits in this file: this one (register/verify's challenge
// ownership) and login/verify's `challenge.userId !== user.id` further down.
// Only THIS one is in scope — register/verify runs behind `requireAuth`, so
// a real `req.user` (and therefore a real PDP subject) already exists.
// login/verify has no `requireAuth` at all (that route IS how a session
// gets created), so there is no subject yet for `authorize()` to evaluate
// against — routing it through the PDP would either deny every legitimate
// login (no subject → UNAUTHENTICATED) or require inventing a fake subject,
// neither of which this phase does. Left exactly as-is, same as Phase C1
// left `events.ts`'s false-positive grep hit untouched.
//
// Unlike Phase C1's `support.ts`/`tasks.ts` ("owner OR admin"), every
// ownership question in this file and in `routes/vault-reauth.ts` (this
// same batch) has NO admin bypass — a passkey credential or a registration
// challenge belongs to exactly one account, full stop. So
// `createResourceOwnershipRule()` alone is enough here; Phase C1's new
// `createRoleOverrideRule()` is not needed and is not registered.
//
// `requireOwnership()` (`lib/policy/pep/middleware.ts`) was considered for
// PATCH/DELETE below (it's the more direct fit for a route-level "does the
// :id belong to me" check — the same helper Phase B1 used for
// `finance.ts`). It was NOT used because both routes already run at least
// one hand-rolled check BEFORE the point where ownership is decided (PATCH:
// the `name` required-field check; DELETE: `requireVaultPin()`) — inserting
// `requireOwnership()` as router-level middleware would run ahead of both,
// changing which error a non-owner sees first for those edge cases (e.g. a
// non-owner PATCHing with a blank name currently gets 400 "name is
// required", not 404 "Passkey not found"). Using `authorize()` inline, at
// the exact point the ownership check already happens, keeps that order
// byte-for-byte — same reasoning `support.ts`/`tasks.ts` used in Phase C1.
const PASSKEY_OWNER_SENTINEL_NONE = -1;

const passkeyOwnershipEngine = new PolicyEngine({ onDecision: pepDecisionObserver });
passkeyOwnershipEngine.registerRule("resource-ownership", createResourceOwnershipRule());

function sanitizeUser(user: typeof usersTable.$inferSelect) {
  const { passwordHash: _ph, twoFaSecret: _ts, ...safe } = user;
  return {
    ...safe,
    createdAt: safe.createdAt.toISOString(),
    lastActiveAt: safe.lastActiveAt?.toISOString() ?? null,
  };
}

function sanitizeCredential(row: typeof passkeyCredentialsTable.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    deviceType: row.deviceType,
    backedUp: row.backedUp,
    transports: row.transports ? row.transports.split(",") : [],
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

// ─── GET /passkey/list — this account's registered passkeys ──────────────────
router.get("/passkey/list", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const rows = await db.select().from(passkeyCredentialsTable).where(eq(passkeyCredentialsTable.userId, userId));
  res.json(rows.map(sanitizeCredential));
});

// ─── POST /passkey/register/options ───────────────────────────────────────────
router.post("/passkey/register/options", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
  if (!user) { res.status(404).json({ error: "User not found" }); return; }

  const existing = await db.select().from(passkeyCredentialsTable).where(eq(passkeyCredentialsTable.userId, userId));

  const webAuthn = getWebAuthnConfig(req);
  const options = await generateRegistrationOptions({
    rpName,
    rpID: webAuthn.rpID,
    userName: user.username,
    userDisplayName: user.username,
    userID: new TextEncoder().encode(String(user.id)),
    attestationType: "none",
    excludeCredentials: existing.map((c) => ({ id: c.credentialId })),
    authenticatorSelection: {
      residentKey: "preferred",
      userVerification: "preferred",
    },
  });

  const challengeKey = newChallengeKey();
  storeChallenge(challengeKey, options.challenge, userId);
  res.json({ options, challengeKey });
});

// ─── POST /passkey/register/verify ────────────────────────────────────────────
// Passkeys double as Vault re-auth step 1 (see routes/vault-reauth.ts), so
// creating one is a Vault-security action — gated by the Vault PIN like
// every other one (see lib/vault-pin-guard.ts; a no-op until a PIN exists).
router.post("/passkey/register/verify", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const { challengeKey, response, name, vaultPin } = req.body as { challengeKey?: string; response?: any; name?: string; vaultPin?: string };
  if (!challengeKey || !response) { res.status(400).json({ error: "challengeKey and response are required" }); return; }

  const pinCheck = await requireVaultPin(userId, vaultPin);
  if (!pinCheck.ok) { res.status(pinCheck.status).json(pinCheck.body); return; }

  const entry = consumeChallenge(challengeKey);
  if (!entry) { res.status(400).json({ error: "Challenge expired or invalid. Try again." }); return; }

  // Phase C2: the challenge's own userId (stamped at issue time by
  // POST /passkey/register/options, above) vs. the current session's —
  // PDP-routed, same "Challenge expired or invalid. Try again." response on
  // a non-owner as before, just observable now (requestId/audit row).
  const challengeOwnership = await authorize({
    req,
    engine: passkeyOwnershipEngine,
    action: "passkey.register_challenge.verify",
    resource: { type: "passkey.register_challenge", id: challengeKey, ownerId: entry.userId ?? PASSKEY_OWNER_SENTINEL_NONE },
  });
  if (challengeOwnership.decision.effect !== "ALLOW") { res.status(400).json({ error: "Challenge expired or invalid. Try again." }); return; }

  try {
    const webAuthn = getWebAuthnConfig(req);
    const verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: entry.challenge,
      expectedOrigin: webAuthn.origin,
      expectedRPID: webAuthn.rpID,
    });

    if (!verification.verified || !verification.registrationInfo) {
      res.status(400).json({ error: "Passkey verification failed" }); return;
    }

    const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;

    const [saved] = await db.insert(passkeyCredentialsTable).values({
      userId,
      credentialId: credential.id,
      publicKey: Buffer.from(credential.publicKey).toString("base64url"),
      counter: credential.counter,
      deviceType: credentialDeviceType,
      backedUp: credentialBackedUp,
      transports: credential.transports?.join(",") ?? null,
      name: (name && name.trim()) || "Passkey",
    }).returning();

    res.status(201).json(sanitizeCredential(saved));
  } catch (err: any) {
    res.status(400).json({ error: err.message || "Passkey registration failed" });
  }
});

// ─── PATCH /passkey/:id — rename ───────────────────────────────────────────────
router.patch("/passkey/:id", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const id = Number(req.params.id);
  const { name } = req.body as { name?: string };
  if (!name || !name.trim()) { res.status(400).json({ error: "name is required" }); return; }

  // Phase C2: PDP-routed ownership check ahead of the existing hand-rolled
  // `eq(id) AND eq(userId)` scoping below — that scoping stays exactly as
  // it was (Rule: don't remove a working system); this only adds
  // observability, same "second, PDP-routed check" posture as Phase B1's
  // finance.ts. Real owner is read fresh from the DB, never trusted from
  // the client; a nonexistent id gets the sentinel and DENYs the same as a
  // real non-owner (see FINANCE_OWNER_SENTINEL_NONE's own rationale in
  // finance.ts, Phase B1) — same "Passkey not found" response either way.
  const [existingCred] = await db.select({ userId: passkeyCredentialsTable.userId })
    .from(passkeyCredentialsTable).where(eq(passkeyCredentialsTable.id, id)).limit(1);
  const ownership = await authorize({
    req,
    engine: passkeyOwnershipEngine,
    action: "passkey.credential.update",
    resource: { type: "passkey.credential", id, ownerId: existingCred?.userId ?? PASSKEY_OWNER_SENTINEL_NONE },
  });
  if (ownership.decision.effect !== "ALLOW") { res.status(404).json({ error: "Passkey not found" }); return; }

  const [updated] = await db.update(passkeyCredentialsTable)
    .set({ name: name.trim() })
    .where(and(eq(passkeyCredentialsTable.id, id), eq(passkeyCredentialsTable.userId, userId)))
    .returning();
  if (!updated) { res.status(404).json({ error: "Passkey not found" }); return; }
  res.json(sanitizeCredential(updated));
});

// ─── DELETE /passkey/:id ────────────────────────────────────────────────────────
// Gated by the Vault PIN too — removing a passkey is as much a Vault-
// security change as adding one. Pass ?vaultPin=1234 (DELETE has no JSON
// body in the frontend's customFetch helper).
router.delete("/passkey/:id", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const id = Number(req.params.id);

  const pinCheck = await requireVaultPin(userId, req.query.vaultPin);
  if (!pinCheck.ok) { res.status(pinCheck.status).json(pinCheck.body); return; }

  // Phase C2 — same ownership check as PATCH above, placed after the PIN
  // gate (unchanged order: PIN was already required before ownership was
  // ever decided here, via the delete's own `eq(id) AND eq(userId)`).
  const [existingCred] = await db.select({ userId: passkeyCredentialsTable.userId })
    .from(passkeyCredentialsTable).where(eq(passkeyCredentialsTable.id, id)).limit(1);
  const ownership = await authorize({
    req,
    engine: passkeyOwnershipEngine,
    action: "passkey.credential.delete",
    resource: { type: "passkey.credential", id, ownerId: existingCred?.userId ?? PASSKEY_OWNER_SENTINEL_NONE },
  });
  if (ownership.decision.effect !== "ALLOW") { res.status(404).json({ error: "Passkey not found" }); return; }

  const deleted = await db.delete(passkeyCredentialsTable)
    .where(and(eq(passkeyCredentialsTable.id, id), eq(passkeyCredentialsTable.userId, userId)))
    .returning();
  if (!deleted.length) { res.status(404).json({ error: "Passkey not found" }); return; }
  res.json({ ok: true });
});

// ─── POST /passkey/login/options — email optional (omit for usernameless) ────
router.post("/passkey/login/options", async (req, res): Promise<void> => {
  const { email } = req.body as { email?: string };

  let allowCredentials: { id: string; transports?: any[] }[] = [];
  if (email) {
    const [user] = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.email, email));
    if (user) {
      const creds = await db.select().from(passkeyCredentialsTable).where(eq(passkeyCredentialsTable.userId, user.id));
      allowCredentials = creds.map((c) => ({
        id: c.credentialId,
        transports: c.transports ? (c.transports.split(",") as any[]) : undefined,
      }));
      // No passkeys on this account — say so up front rather than showing an
      // empty/confusing browser prompt.
      if (creds.length === 0) { res.status(404).json({ error: "No passkeys registered for this account" }); return; }
    }
    // Unknown email: fall through with an empty allow-list rather than
    // revealing whether the email exists.
  }

  const webAuthn = getWebAuthnConfig(req);
  const options = await generateAuthenticationOptions({
    rpID: webAuthn.rpID,
    allowCredentials: allowCredentials.length ? allowCredentials : undefined,
    userVerification: "preferred",
  });

  const challengeKey = newChallengeKey();
  storeChallenge(challengeKey, options.challenge);
  res.json({ options, challengeKey });
});

// ─── POST /passkey/login/verify — verify assertion, issue session token ──────
// Optional `loginChallengeToken`: when the account's login is going through
// the anomalous-IP step-up chain (see lib/login-security.ts / routes/auth.ts
// POST /auth/login), pass the challengeToken returned from that endpoint
// here. On success this marks the 'passkey' factor complete instead of
// issuing a token outright — a token is only returned once every required
// factor for that challenge has cleared.
router.post("/passkey/login/verify", async (req, res): Promise<void> => {
  const { challengeKey, response, loginChallengeToken } = req.body as { challengeKey?: string; response?: any; loginChallengeToken?: string };
  if (!challengeKey || !response) { res.status(400).json({ error: "challengeKey and response are required" }); return; }

  const entry = consumeChallenge(challengeKey);
  if (!entry) { res.status(400).json({ error: "Challenge expired or invalid. Try again." }); return; }

  const credentialId: string | undefined = response.id;
  if (!credentialId) { res.status(400).json({ error: "Malformed passkey response" }); return; }

  const [cred] = await db.select().from(passkeyCredentialsTable).where(eq(passkeyCredentialsTable.credentialId, credentialId));
  if (!cred) { res.status(401).json({ error: "This passkey is not registered with AYZEN" }); return; }

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

    if (!verification.verified) { res.status(401).json({ error: "Passkey verification failed" }); return; }

    await db.update(passkeyCredentialsTable)
      .set({ counter: verification.authenticationInfo.newCounter, lastUsedAt: new Date() })
      .where(eq(passkeyCredentialsTable.id, cred.id));

    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, cred.userId));
    if (!user) { res.status(401).json({ error: "Account not found" }); return; }

    // Anomalous-IP step-up flow: this passkey only clears the 'passkey'
    // factor of an open login_challenge — it doesn't issue a token by
    // itself unless every other required factor has already been cleared.
    if (loginChallengeToken) {
      const challenge = await getLoginChallenge(loginChallengeToken);
      if (!challenge) { res.status(404).json({ error: "Challenge not found" }); return; }
      if (challenge.status === "expired") { res.status(410).json({ error: "This sign-in confirmation has expired. Please log in again." }); return; }
      // Phase C2: left as a hand-rolled check on purpose — this whole route
      // has no `requireAuth`, so there is no PDP subject yet to authorize
      // against (see this file's Phase C2 header note above). Out of scope
      // for this batch, same as `events.ts` in Phase C1.
      if (challenge.userId !== user.id) { res.status(403).json({ error: "This passkey does not belong to the account on that challenge" }); return; }
      if (!challenge.requiredMethods.includes("passkey")) { res.status(400).json({ error: "passkey is not required for this login" }); return; }

      const updated = await markStepUpMethodComplete(loginChallengeToken, "passkey");
      if (!updated) { res.status(404).json({ error: "Challenge not found" }); return; }

      if (updated.status === "verified") {
        if (updated.loginHistoryId) markLoginHistoryStatus(updated.loginHistoryId, "success").catch(() => {});
        await db.update(usersTable).set({ lastActiveAt: new Date() }).where(eq(usersTable.id, user.id));
        const token = signAuthToken(user.id, user.role);
        res.json({ verified: true, token, refreshToken: token, user: sanitizeUser(user) });
        return;
      }

      res.json({ verified: false, requiredMethods: updated.requiredMethods, completedMethods: updated.completedMethods });
      return;
    }

    await db.update(usersTable).set({ lastActiveAt: new Date() }).where(eq(usersTable.id, user.id));

    // A fresh passkey login (no pre-existing challenge) is still subject to
    // the same anomalous-IP check as a password login — the passkey factor
    // just starts out already satisfied, since it's what got us here.
    const ip = getClientIp(req);
    const userAgent = (req.headers["user-agent"] as string) || null;
    if (await isAnomalousIp(user.id, ip)) {
      const loginHistoryId = await recordLoginHistory({ userId: user.id, ip, userAgent, status: "pending_verification", anomalous: true, method: "passkey" });
      const requiredMethods = await availableStepUpMethods(user.id);
      const challenge = await createLoginChallenge({ userId: user.id, ip, userAgent, requiredMethods, loginHistoryId, initialCompletedMethods: ["passkey"] });

      if (challenge.status === "verified") {
        // No other factors were configured beyond passkey itself — grant immediately.
        await markLoginHistoryStatus(loginHistoryId, "success");
        const token = signAuthToken(user.id, user.role);
        res.json({ token, refreshToken: token, user: sanitizeUser(user) });
        return;
      }

      // Email code is always part of the chain — send it now so the
      // frontend can show a single "check your email" step immediately.
      const code = generateOtp();
      await storeOtp(stepUpOtpKey(challenge.token), code);
      sendEmail({
        to: user.email,
        subject: "AYZEN — Confirm New Sign-in",
        html: `<p>New sign-in confirmation code: <strong>${code}</strong> (expires in 10 minutes). If this wasn't you, change your password immediately.</p>`,
        text: `Your AYZEN sign-in confirmation code: ${code} (expires in 10 minutes)`,
      }).catch(() => {});

      res.status(200).json({
        requiresStepUp: true,
        reason: "new_ip",
        challengeToken: challenge.token,
        requiredMethods: challenge.requiredMethods,
        completedMethods: challenge.completedMethods,
        expiresAt: challenge.expiresAt.toISOString(),
      });
      return;
    }

    const token = signAuthToken(user.id, user.role);
    res.json({ token, refreshToken: token, user: sanitizeUser(user) });
  } catch (err: any) {
    res.status(401).json({ error: err.message || "Passkey verification failed" });
  }
});

export default router;
