/**
 * components/vault/entity-pin-gate.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase 5 — Vault Security: PINs & Session.
 *
 * Wraps an entity's detail page content and requires the shared entity-view
 * PIN before rendering it — one PIN for every entity, not per-entity (see
 * routes/vault-security.ts). Independent of VaultUnlockGate: getting past
 * that gate to reach a /vault/entity/:id page at all doesn't skip this one.
 *
 *   - No entity PIN set yet         → renders children immediately (same
 *     "nothing to gate on" rule as VaultUnlockGate).
 *   - PIN set, already unlocked     → renders children immediately. Unlocking
 *     once covers every entity for the rest of this browser session (see
 *     lib/vault-lock.ts) — re-prompting per entity would be needless friction
 *     for a shared PIN, and the spec only requires it be asked, not asked
 *     every single time.
 *   - PIN set, locked               → shows the unlock screen, no "keep me
 *     signed in" option (that's specific to the vault-login PIN).
 */
import { useEffect, useState, type ReactNode } from "react";
import { KeyRound, Loader2, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PinInput } from "@/components/vault/pin-input";
import { getVaultSecurityStatus, verifyPin } from "@/lib/vault-security-api";
import { isEntityViewUnlocked, setEntityViewUnlocked } from "@/lib/vault-lock";
import { ApiError } from "@workspace/api-client-react";

type GateState = "checking" | "open" | "locked";

export function EntityPinGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<GateState>("checking");

  useEffect(() => {
    let cancelled = false;
    getVaultSecurityStatus()
      .then(status => {
        if (cancelled) return;
        if (!status.entityPinSet || isEntityViewUnlocked()) {
          setState("open");
        } else {
          setState("locked");
        }
      })
      .catch(() => {
        if (!cancelled) setState("open");
      });
    return () => { cancelled = true; };
  }, []);

  if (state === "checking") {
    return (
      <div className="min-h-[40vh] flex items-center justify-center">
        <Loader2 className="w-6 h-6 text-primary animate-spin" />
      </div>
    );
  }

  if (state === "locked") {
    return <EntityUnlockScreen onUnlocked={() => setState("open")} />;
  }

  return <>{children}</>;
}

function EntityUnlockScreen({ onUnlocked }: { onUnlocked: () => void }) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);

  async function submit(candidate: string) {
    if (verifying) return;
    setVerifying(true);
    setError(null);
    try {
      const result = await verifyPin("entity", candidate);
      if (result.valid) {
        setEntityViewUnlocked();
        onUnlocked();
      } else {
        setError("Incorrect PIN");
        setPin("");
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        setError((err.data as any)?.solution ?? "Too many attempts — try again shortly.");
      } else {
        setError("Couldn't verify PIN — try again.");
      }
      setPin("");
    } finally {
      setVerifying(false);
    }
  }

  return (
    <div className="min-h-[40vh] flex items-center justify-center page-enter">
      <div className="w-full max-w-xs space-y-6 text-center">
        <div className="w-14 h-14 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center mx-auto">
          <KeyRound className="w-6 h-6 text-primary" />
        </div>
        <div>
          <h1 className="text-lg font-bold font-mono uppercase tracking-tight">Entity Locked</h1>
          <p className="text-muted-foreground font-mono text-xs mt-1">Enter your entity-view PIN to continue</p>
        </div>

        <PinInput value={pin} onChange={setPin} onComplete={submit} disabled={verifying} error={!!error} />

        {error && (
          <p className="text-destructive font-mono text-xs flex items-center justify-center gap-1.5">
            <AlertCircle className="w-3.5 h-3.5" /> {error}
          </p>
        )}

        <Button
          size="sm"
          className="font-mono text-xs uppercase tracking-wider"
          disabled={pin.length !== 4 || verifying}
          onClick={() => submit(pin)}
        >
          {verifying ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Unlock"}
        </Button>
      </div>
    </div>
  );
}
