/**
 * components/vault/vault-unlock-gate.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase 5 — Vault Security: Re-auth & Session. Phase 17 — the actual re-auth
 * screens now live in their own file, components/vault/vault-auth.tsx (was
 * previously inlined here) — this file is just the window check that decides
 * whether to show it.
 *
 * Wraps every /vault/* route (see App.tsx) and requires passkey, or account
 * PASSWORD + Vault's own 2FA, before rendering the page underneath:
 *
 *   - Still inside the re-auth window (first Vault visit today, and it's
 *     been ≤3h since the last successful re-auth — see lib/vault-lock.ts)
 *     → renders children immediately.
 *   - Window expired (new day, or >3h since last re-auth)
 *     → renders <VaultAuth>, which blocks children until passkey or
 *       password + Vault 2FA succeeds (see vault-auth.tsx for that flow,
 *       routes/vault-reauth.ts for the server side).
 */
import { useState, type ReactNode } from "react";
import { VaultAuth } from "@/components/vault/vault-auth";
import { isVaultUnlocked } from "@/lib/vault-lock";

export function VaultUnlockGate({ children }: { children: ReactNode }) {
  const [unlocked, setUnlocked] = useState(isVaultUnlocked);

  if (unlocked) return <>{children}</>;

  return <VaultAuth onUnlocked={() => setUnlocked(true)} />;
}
