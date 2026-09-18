/**
 * components/vault/vault-pin-prompt.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * The Vault Security PIN gates every sensitive Vault-security mutation now —
 * passkey create/delete, Vault 2FA enable/disable, Vault password set/
 * change/disable, and the auth-step policy itself (see lib/vault-pin-guard.ts
 * on the backend). Rather than duplicate a PIN dialog in every card on
 * vault-security.tsx (and on the account /security page, since passkeys are
 * shared), useVaultPinPrompt() gives any component a single
 * `askVaultPin(): Promise<string>` — it opens a small modal, resolves with
 * the 4 digits once entered, or rejects (message "cancelled") if the person
 * backs out. Render <prompt.element/> once near the top of the component
 * tree that calls askVaultPin.
 *
 * This intentionally does NOT verify the PIN itself — every gated endpoint
 * already re-checks it server-side (requireVaultPin), so this is purely a
 * "collect the digits" UI step, not a client-side trust boundary.
 */
import { useRef, useState } from "react";
import { PinInput } from "@/components/vault/pin-input";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { ShieldCheck } from "lucide-react";

export function useVaultPinPrompt() {
  const [open, setOpen] = useState(false);
  const [pin, setPinValue] = useState("");
  const resolverRef = useRef<{ resolve: (pin: string) => void; reject: (err: Error) => void } | null>(null);

  /**
   * Opens the PIN prompt and resolves with the 4 digits, or rejects with
   * message "cancelled" if the person backs out. Pass `required: false`
   * (e.g. before the mandatory Vault PIN has ever been set — see
   * vault-security.tsx's pinSetupDone) to skip the modal entirely and
   * resolve with "" immediately: asking someone to enter a PIN they were
   * never given to set is confusing UX, and the backend's requireVaultPin()
   * already no-ops on an empty/absent PIN until one exists anyway.
   */
  function askVaultPin(required: boolean = true): Promise<string> {
    if (!required) return Promise.resolve("");
    setPinValue("");
    setOpen(true);
    return new Promise<string>((resolve, reject) => {
      resolverRef.current = { resolve, reject };
    });
  }

  function handleComplete(value: string) {
    resolverRef.current?.resolve(value);
    resolverRef.current = null;
    setOpen(false);
  }

  function handleCancel() {
    resolverRef.current?.reject(new Error("cancelled"));
    resolverRef.current = null;
    setOpen(false);
  }

  const element = (
    <Dialog open={open} onOpenChange={o => !o && handleCancel()}>
      <DialogContent className="max-w-xs">
        <DialogHeader>
          <DialogTitle className="font-mono text-sm uppercase tracking-wide flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-primary" /> Vault PIN Required
          </DialogTitle>
          <DialogDescription className="font-mono text-xs">
            This change requires your Vault Security PIN.
          </DialogDescription>
        </DialogHeader>
        <div className="py-4">
          <PinInput value={pin} onChange={setPinValue} onComplete={handleComplete} autoFocus />
        </div>
        <DialogFooter>
          <Button variant="ghost" size="sm" className="font-mono text-xs" onClick={handleCancel}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  return { askVaultPin, element };
}
