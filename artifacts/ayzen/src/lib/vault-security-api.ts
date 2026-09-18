/**
 * lib/vault-security-api.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase 5 — Vault Security: PINs & Session.
 *
 * Thin typed wrapper around customFetch for routes/vault-security.ts. Not
 * generated from the OpenAPI spec (same pattern as several other Vault
 * sub-pages, e.g. vault-2fa-entity.tsx's direct customFetch calls) — this
 * endpoint set is small enough that hand-writing it is simpler than wiring
 * up codegen for it.
 */
import { customFetch } from "@workspace/api-client-react";
import { getApiBase } from "@/lib/api-base";

// The API server is mounted under /api in the shared Replit proxy. Keep these
// hand-written Vault calls on the same base path as the generated client and
// the login page. Without it, requests fall through to the frontend app and
// setup errors look like a generic "Couldn't start 2FA setup" failure.
function vaultApiPath(path: string): string {
  return `${getApiBase()}/api${path}`;
}

export type PinKind = "vault" | "entity";
export type AuthStepPolicy = "any" | "step12" | "step123";

export interface VaultSecurityStatus {
  vaultPinSet: boolean;
  entityPinSet: boolean;
  vaultPasswordSet: boolean;
  vaultPinMandatorySetupDone: boolean;
  authStepPolicy: AuthStepPolicy;
  updatedAt: string | null;
}

// ─── Auth step policy — how many of the 3 Vault re-auth steps are required ──
export function setAuthStepPolicy(policy: AuthStepPolicy, vaultPin?: string): Promise<{ ok: true; policy: AuthStepPolicy }> {
  return customFetch(vaultApiPath("/vault/security/auth-policy"), {
    method: "PUT",
    body: JSON.stringify({ policy, vaultPin }),
  });
}

// ─── Vault Security PIN — the mandatory, most-powerful credential in Vault ──
// Setting or changing it (unlike every other PIN/password in Vault) always
// requires a fresh email code AND the account login password — see
// routes/vault-security.ts's PUT /vault/security/pin (kind="vault").

export function requestVaultPinSetupCode(): Promise<{ message: string }> {
  return customFetch(vaultApiPath("/vault/security/pin/request-code"), { method: "POST" });
}

export function setVaultPin(pin: string, accountPassword: string, emailCode: string): Promise<{ ok: true; kind: "vault" }> {
  return customFetch(vaultApiPath("/vault/security/pin"), {
    method: "PUT",
    body: JSON.stringify({ kind: "vault", pin, accountPassword, emailCode }),
  });
}

// ─── Vault Auth Password — separate from the account login password ────────
// Configured here, checked by POST /vault/reauth/verify's password+2FA
// fallback instead of the account password once set. See
// schema/vault-security.ts's vaultPasswordHash field for the full rationale.

export function setVaultPassword(password: string, currentPassword: string | undefined, vaultPin?: string): Promise<{ ok: true }> {
  return customFetch(vaultApiPath("/vault/security/password"), {
    method: "PUT",
    body: JSON.stringify({ password, currentPassword, vaultPin }),
  });
}

export function disableVaultPassword(vaultPin?: string): Promise<{ ok: true }> {
  return customFetch(vaultApiPath("/vault/security/password/disable"), {
    method: "POST",
    body: JSON.stringify({ vaultPin }),
  });
}

export interface VerifyPinResult {
  valid: boolean;
  pinSet: boolean;
  // Only present for a successful kind="entity" verify — a random,
  // single-use token that GET /vault/:id/seed now requires (see
  // routes/vault-security.ts + routes/vault.ts on the backend).
  revealToken?: string;
  revealTokenExpiresInMs?: number;
}

export function getVaultSecurityStatus(): Promise<VaultSecurityStatus> {
  return customFetch<VaultSecurityStatus>(vaultApiPath("/vault/security/status"));
}

export function setPin(kind: PinKind, pin: string, currentPin?: string): Promise<{ ok: true; kind: PinKind }> {
  return customFetch(vaultApiPath("/vault/security/pin"), {
    method: "PUT",
    body: JSON.stringify({ kind, pin, currentPin }),
  });
}

export function verifyPin(kind: PinKind, pin: string): Promise<VerifyPinResult> {
  return customFetch(vaultApiPath("/vault/security/verify"), {
    method: "POST",
    body: JSON.stringify({ kind, pin }),
  });
}

// ─── Vault re-auth (passkey, or Vault PIN/password + Vault 2FA) ────────────
// The gate in front of Vault itself (components/vault/vault-unlock-gate.tsx
// + pages/user/vault-auth.tsx). Passkey is tried first when available; the
// fallback checks a Vault-specific PIN or password (never the account login
// password) + Vault's OWN 2FA (see the vault-scoped 2FA functions below —
// entirely separate from the account's login 2FA on /security). See
// routes/vault-reauth.ts.

export interface VaultReauthStatus {
  twoFaEnabled: boolean;
  hasPasskey: boolean;
  usesVaultPassword: boolean;
  usesVaultPin: boolean;
  hasCredential: boolean;
  step3Available: boolean;
  authStepPolicy: AuthStepPolicy;
}

export function getVaultReauthStatus(): Promise<VaultReauthStatus> {
  return customFetch<VaultReauthStatus>(vaultApiPath("/vault/reauth/status"));
}

// ─── Step 3 — email code + Vault PIN failover ──────────────────────────────
// Reached when step 2 (Vault PIN/password + Vault 2FA) can't be completed —
// see components/vault/vault-auth.tsx's "step 2 unavailable" link.

export function sendVaultReauthEmailCode(): Promise<{ message: string }> {
  return customFetch(vaultApiPath("/vault/reauth/email-code/send"), { method: "POST" });
}

export function verifyVaultReauthStep3(pin: string, emailCode: string): Promise<{ ok: true }> {
  return customFetch(vaultApiPath("/vault/reauth/verify-step3"), {
    method: "POST",
    body: JSON.stringify({ pin, emailCode }),
  });
}

// Pass exactly the credential that's actually configured (PIN takes
// priority when both exist — see VaultReauthStatus.usesVaultPin). The
// account login password is never accepted here, only a Vault-specific
// PIN or password set up on /vault/security.
export function verifyVaultReauth(credential: { password?: string; pin?: string }, totpCode?: string): Promise<{ ok: true }> {
  return customFetch(vaultApiPath("/vault/reauth/verify"), {
    method: "POST",
    body: JSON.stringify({ ...credential, totpCode }),
  });
}

export interface VaultReauthPasskeyOptions {
  options: any;
  challengeKey: string;
}

export function getVaultReauthPasskeyOptions(): Promise<VaultReauthPasskeyOptions> {
  return customFetch<VaultReauthPasskeyOptions>(vaultApiPath("/vault/reauth/passkey/options"), { method: "POST" });
}

export function verifyVaultReauthPasskey(challengeKey: string, response: any): Promise<{ ok: true }> {
  return customFetch(vaultApiPath("/vault/reauth/passkey/verify"), {
    method: "POST",
    body: JSON.stringify({ challengeKey, response }),
  });
}

// ─── Vault 2FA — Vault's OWN TOTP, separate from account login 2FA ──────────
// Managed on /vault/security (see vault-security.tsx's TwoFaCard) and
// checked by the password+2FA fallback above — NOT the same secret as the
// account's /security page 2FA. See routes/vault-security.ts's
// /vault/security/2fa/* endpoints and schema/vault-security.ts for the full
// rationale.

export interface VaultTwoFaStatus { enabled: boolean }
export interface VaultTwoFaSetup { secret: string; qrDataUrl: string }

export function getVaultTwoFaStatus(): Promise<VaultTwoFaStatus> {
  return customFetch<VaultTwoFaStatus>(vaultApiPath("/vault/security/2fa/status"));
}
export function setupVaultTwoFa(): Promise<VaultTwoFaSetup> {
  return customFetch<VaultTwoFaSetup>(vaultApiPath("/vault/security/2fa/setup"), { method: "POST" });
}
export function verifyVaultTwoFa(token: string, vaultPin?: string): Promise<{ enabled: true }> {
  return customFetch(vaultApiPath("/vault/security/2fa/verify"), {
    method: "POST",
    body: JSON.stringify({ token, vaultPin }),
  });
}
export function disableVaultTwoFa(vaultPin?: string): Promise<{ enabled: false }> {
  return customFetch(vaultApiPath("/vault/security/2fa/disable"), {
    method: "POST",
    body: JSON.stringify({ vaultPin }),
  });
}

// ─── Vault activity feed (mine) ─────────────────────────────────────────────
// Powers the "Activity Log" item in the Vault sidebar. See GET /vault/activity.

export interface VaultActivityEntry {
  id: number;
  vaultEntryId: number;
  userId: number;
  action: string;
  detail: string | null;
  createdAt: string;
  entitySerial: string | null;
  entityId: number | null;
}

export interface VaultActivityPage {
  entries: VaultActivityEntry[];
  total: number;
  page: number;
  limit: number;
}

export function getVaultActivity(page = 1, limit = 30): Promise<VaultActivityPage> {
  const params = new URLSearchParams({ page: String(page), limit: String(limit) });
  return customFetch<VaultActivityPage>(vaultApiPath(`/vault/activity?${params}`));
}
