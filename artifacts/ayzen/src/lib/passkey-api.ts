/**
 * lib/passkey-api.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Thin wrapper around @simplewebauthn/browser for AYZEN's passkey endpoints
 * (see artifacts/api-server/src/routes/passkey.ts).
 */
import { startRegistration, startAuthentication, browserSupportsWebAuthn } from "@simplewebauthn/browser";
import { getApiBase } from "@/lib/api-base";

const BASE = getApiBase();

export { browserSupportsWebAuthn };

async function authedJson(path: string, token: string, init?: RequestInit) {
  const res = await fetch(`${BASE}/api${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(init?.headers ?? {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

export interface PasskeySummary {
  id: number;
  name: string;
  deviceType: string;
  backedUp: boolean;
  transports: string[];
  lastUsedAt: string | null;
  createdAt: string;
}

export async function listPasskeys(token: string): Promise<PasskeySummary[]> {
  return authedJson("/passkey/list", token);
}

/**
 * Registers a new passkey against the currently logged-in account. Passkeys
 * double as Vault re-auth step 1, so the backend now requires the Vault
 * Security PIN here too (no-op server-side until a PIN has been set — see
 * lib/vault-pin-guard.ts). Pass it once vault-security.tsx's setup wizard
 * is done.
 */
export async function registerPasskey(token: string, name?: string, vaultPin?: string): Promise<PasskeySummary> {
  const { options, challengeKey } = await authedJson("/passkey/register/options", token, { method: "POST" });
  const response = await startRegistration({ optionsJSON: options });
  return authedJson("/passkey/register/verify", token, {
    method: "POST",
    body: JSON.stringify({ challengeKey, response, name, vaultPin }),
  });
}

export async function renamePasskey(token: string, id: number, name: string): Promise<PasskeySummary> {
  return authedJson(`/passkey/${id}`, token, { method: "PATCH", body: JSON.stringify({ name }) });
}

/** Same Vault PIN gate as registerPasskey — see its comment. */
export async function deletePasskey(token: string, id: number, vaultPin?: string): Promise<void> {
  const qs = vaultPin ? `?vaultPin=${encodeURIComponent(vaultPin)}` : "";
  await authedJson(`/passkey/${id}${qs}`, token, { method: "DELETE" });
}

/**
 * Logs in with a passkey. Pass `email` to hint the browser toward that
 * account's credentials, or omit it for discoverable/usernameless login
 * (browser shows whatever passkeys it has saved for this site).
 */
/**
 * Logs in with a passkey. Pass `email` to hint the browser toward that
 * account's credentials, or omit it for discoverable/usernameless login
 * (browser shows whatever passkeys it has saved for this site).
 *
 * Pass `loginChallengeToken` when this passkey is clearing the 'passkey'
 * factor of an anomalous-IP step-up challenge (see lib/login-security.ts
 * on the server) rather than logging in on its own — in that case the
 * response won't include a token until every other required factor has
 * also been cleared; see `verified` in the return value.
 */
export async function loginWithPasskey(
  email?: string,
  loginChallengeToken?: string,
): Promise<{
  token?: string;
  refreshToken?: string;
  user?: any;
  verified?: boolean;
  requiresStepUp?: boolean;
  challengeToken?: string;
  requiredMethods?: string[];
  completedMethods?: string[];
}> {
  const optionsRes = await fetch(`${BASE}/api/passkey/login/options`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(email ? { email } : {}),
  });
  const optionsData = await optionsRes.json().catch(() => ({}));
  if (!optionsRes.ok) throw new Error(optionsData.error || "Could not start passkey login");

  const response = await startAuthentication({ optionsJSON: optionsData.options });

  const verifyRes = await fetch(`${BASE}/api/passkey/login/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ challengeKey: optionsData.challengeKey, response, ...(loginChallengeToken ? { loginChallengeToken } : {}) }),
  });
  const verifyData = await verifyRes.json().catch(() => ({}));
  if (!verifyRes.ok) throw new Error(verifyData.error || "Passkey login failed");
  return verifyData;
}
