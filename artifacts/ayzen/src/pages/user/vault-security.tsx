/**
 * vault-security.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase 5 — Vault Security: Re-auth & Session. Phase 17 — Vault has its own
 * dedicated auth (see pages/user/vault-auth.tsx + components/vault/
 * vault-unlock-gate.tsx) and its own 2FA, separate from the account's.
 *
 * Vault entry is gated by passkey (if registered) or a Vault-only PIN/
 * PASSWORD + VAULT'S OWN 2FA — never the account's login password or login
 * 2FA, see lib/vault-security-api.ts's getVaultTwoFaStatus/setupVaultTwoFa
 * /etc. This page manages:
 *   - Passkeys — the same account-wide passkeys used to sign in, offered
 *     here as the first-choice way to unlock Vault
 *   - Vault PIN & Vault Password — the PIN/password half of the re-auth
 *     fallback when no passkey is used (PIN takes priority when both are set)
 *   - Vault 2FA (TOTP) — inline setup/enable/disable, its own secret,
 *     entirely independent of the account's /security page 2FA
 *   - Entity-View PIN — required to view any entity's details
 *   - Session info — stay-signed-in window & manual lock
 */
import { useCallback, useEffect, useState } from "react";
import {
  ShieldCheck, KeyRound, Loader2, CheckCircle2, Circle,
  Clock, Lock, ShieldAlert, QrCode, Copy, Check, Eye, EyeOff,
  Fingerprint, Plus, Pencil, Trash2, AlertTriangle, Mail, ListChecks,
} from "lucide-react";
import { useLocation } from "wouter";
import { VaultSectionPage } from "@/components/layout/vault-sidebar";
import { PinInput } from "@/components/vault/pin-input";
import { useVaultPinPrompt } from "@/components/vault/vault-pin-prompt";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import { getVaultSecurityStatus, setPin, type PinKind, type VaultSecurityStatus, type AuthStepPolicy } from "@/lib/vault-security-api";
import { getVaultTwoFaStatus, setupVaultTwoFa, verifyVaultTwoFa, disableVaultTwoFa, type VaultTwoFaSetup } from "@/lib/vault-security-api";
import { setVaultPassword, disableVaultPassword } from "@/lib/vault-security-api";
import { requestVaultPinSetupCode, setVaultPin, setAuthStepPolicy } from "@/lib/vault-security-api";
import { lockVault, lockEntityView, VAULT_UNLOCK_HOURS } from "@/lib/vault-lock";
import { listPasskeys, registerPasskey, renamePasskey, deletePasskey, browserSupportsWebAuthn, type PasskeySummary } from "@/lib/passkey-api";
import { ApiError } from "@workspace/api-client-react";

const MIN_VAULT_PASSWORD_LENGTH = 8;

// Vault 2FA is its OWN TOTP secret (vault_security.vault_two_fa_secret),
// entirely separate from the account's login 2FA on /security — see
// lib/vault-security-api.ts and routes/vault-security.ts's
// /vault/security/2fa/* endpoints. Enabling/disabling one never touches
// the other, and this is what pages/user/vault-auth.tsx checks during the
// password+2FA fallback of the Vault re-auth gate.
function getTwoFaStatus() { return getVaultTwoFaStatus(); }
function setupTwoFa() { return setupVaultTwoFa(); }
function verifyTwoFa(token: string, vaultPin?: string) { return verifyVaultTwoFa(token, vaultPin); }
function disableTwoFa(vaultPin?: string) { return disableVaultTwoFa(vaultPin); }

// ─── Main page ────────────────────────────────────────────────────────────────

export default function VaultSecurity() {
  const [pinStatus, setPinStatus]       = useState<VaultSecurityStatus | null>(null);
  const [twoFaEnabled, setTwoFaEnabled] = useState<boolean | null>(null); // null = loading
  const [loading, setLoading]           = useState(true);
  const [dialogKind, setDialogKind]     = useState<PinKind | null>(null);
  const [passwordDialogOpen, setPasswordDialogOpen] = useState(false);
  const [vaultPinSetupOpen, setVaultPinSetupOpen] = useState(false);
  const { toast } = useToast();
  const { token, user } = useAuth() as any;
  const [, navigate] = useLocation();
  const vaultPinPrompt = useVaultPinPrompt();

  const refresh = () => {
    setLoading(true);
    Promise.all([getVaultSecurityStatus(), getTwoFaStatus()])
      .then(([sec, fa]) => {
        setPinStatus(sec);
        setTwoFaEnabled(fa.enabled);
      })
      .catch(() => toast({ title: "Couldn't load security status", variant: "destructive" }))
      .finally(() => setLoading(false));
  };

  useEffect(refresh, []);

  // Mandatory Vault PIN not set yet — everything else that requireVaultPin()
  // gates server-side is left reachable (the guard itself no-ops until a PIN
  // exists — see lib/vault-pin-guard.ts), but the UI leads with this card
  // first so nobody skips it by accident. Per spec: the settings page
  // itself stays open the whole time, only the *other* toggles effectively
  // wait on this.
  const pinSetupDone = !!pinStatus?.vaultPinMandatorySetupDone;
  // Skips the PIN prompt entirely until the mandatory Vault PIN has been
  // set — see useVaultPinPrompt's askVaultPin() comment. Passed down
  // instead of the raw askVaultPin so every child card gets this for free.
  const askVaultPinIfNeeded = () => vaultPinPrompt.askVaultPin(pinSetupDone);

  return (
    <VaultSectionPage
      title="Security"
      description="Vault PIN, passkey, 2FA, entity-view PIN, auth policy & session"
      icon={ShieldCheck}
    >
      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-6 h-6 text-primary animate-spin" />
        </div>
      ) : (
        <div className="space-y-4">
          {/* ── Vault Security PIN — mandatory, most powerful credential ──── */}
          <VaultPinSetupCard
            isSet={pinSetupDone}
            onManage={() => setVaultPinSetupOpen(true)}
          />

          {user?.email?.endsWith("@ayzen.io") && (
            <div className="bg-primary/5 border border-primary/20 rounded-lg p-3 text-xs font-mono text-primary/80">
              Demo Vault access is ready. Use PIN <span className="font-bold text-primary">1234</span> when a Vault action asks for it, then configure or replace any security option below.
            </div>
          )}

          {!pinSetupDone && (
            <div className="bg-amber-500/5 border border-amber-500/20 rounded-lg p-3 flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" />
              <p className="text-xs font-mono text-amber-400">
                Set your Vault Security PIN above first — it's required to add/change a
                passkey, enable/change Vault 2FA, or set a Vault password.
              </p>
            </div>
          )}

          {/* ── Passkey Configuration ───────────────────────────────────── */}
          <PasskeysCard token={token} askVaultPin={askVaultPinIfNeeded} />

          {/* ── Vault Auth Password ─────────────────────────────────────── */}
          <VaultPasswordCard
            isSet={!!pinStatus?.vaultPasswordSet}
            hasVaultPin={pinSetupDone}
            onManage={() => setPasswordDialogOpen(true)}
            onDisabled={refresh}
            askVaultPin={askVaultPinIfNeeded}
          />

          {/* ── 2FA card ────────────────────────────────────────────────── */}
          <TwoFaCard
            enabled={twoFaEnabled}
            onChanged={(next) => setTwoFaEnabled(next)}
            askVaultPin={askVaultPinIfNeeded}
          />

          {/* ── Auth step policy ─────────────────────────────────────────── */}
          <AuthStepPolicyCard
            policy={pinStatus?.authStepPolicy ?? "any"}
            step3Available={pinSetupDone}
            askVaultPin={askVaultPinIfNeeded}
            onSaved={refresh}
          />

          {/* ── Entity-View PIN ─────────────────────────────────────────── */}
          <PinStatusCard
            icon={KeyRound}
            title="Entity-View PIN"
            description="One shared PIN required to view any entity's details. Separate from the Vault Security PIN above — this one only gates entity detail pages, not Vault-wide settings."
            isSet={!!pinStatus?.entityPinSet}
            onManage={() => setDialogKind("entity")}
          />

          {/* ── Stay Signed In info ─────────────────────────────────────── */}
          <Card className="border-dashed border-border/40 bg-muted/10">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-mono uppercase tracking-wide flex items-center gap-2">
                <Clock className="w-4 h-4 text-primary/60" /> Stay Signed In
              </CardTitle>
            </CardHeader>
            <CardContent className="text-xs font-mono text-muted-foreground/70 leading-relaxed">
              Once you unlock Vault, it stays unlocked for {VAULT_UNLOCK_HOURS} hours — no need
              to re-enter anything until then, or until the next calendar day, whichever comes
              first. The entity-view PIN is still asked once per browser session either way.
            </CardContent>
            <CardFooter>
              <Button
                variant="outline" size="sm" className="font-mono text-xs gap-1.5"
                onClick={() => {
                  lockVault();
                  lockEntityView();
                  toast({ title: "Vault locked", description: "You'll be asked to re-authenticate." });
                  navigate("/vault");
                }}
              >
                <Lock className="w-3.5 h-3.5" /> Lock Vault Now
              </Button>
            </CardFooter>
          </Card>
        </div>
      )}

      {dialogKind === "entity" && (
        <PinDialog
          kind="entity"
          isChange={!!pinStatus?.entityPinSet}
          onClose={() => setDialogKind(null)}
          onSaved={() => { setDialogKind(null); refresh(); }}
        />
      )}

      {passwordDialogOpen && (
        <VaultPasswordDialog
          isChange={!!pinStatus?.vaultPasswordSet}
          onClose={() => setPasswordDialogOpen(false)}
          onSaved={() => { setPasswordDialogOpen(false); refresh(); }}
          askVaultPin={askVaultPinIfNeeded}
        />
      )}

      {vaultPinSetupOpen && (
        <VaultPinSetupDialog
          isChange={pinSetupDone}
          onClose={() => setVaultPinSetupOpen(false)}
          onSaved={() => { setVaultPinSetupOpen(false); refresh(); }}
        />
      )}

      {vaultPinPrompt.element}
    </VaultSectionPage>
  );
}

// ─── Inline 2FA management card ───────────────────────────────────────────────

function TwoFaCard({
  enabled, onChanged, askVaultPin,
}: {
  enabled: boolean | null;
  onChanged: (next: boolean) => void;
  askVaultPin: () => Promise<string>;
}) {
  const [setupData, setSetupData]     = useState<VaultTwoFaSetup | null>(null);
  const [verifyCode, setVerifyCode]   = useState("");
  const [copied, setCopied]           = useState(false);
  const [busy, setBusy]               = useState(false);
  const { toast } = useToast();

  async function startSetup() {
    setBusy(true);
    try {
      const data = await setupTwoFa();
      setSetupData(data);
      setVerifyCode("");
    } catch {
      toast({ title: "Couldn't start 2FA setup", variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  async function confirmSetup() {
    if (verifyCode.trim().length !== 6) {
      toast({ title: "Enter the 6-digit code from your authenticator app", variant: "destructive" });
      return;
    }
    setBusy(true);
    try {
      const vaultPin = await askVaultPin();
      await verifyTwoFa(verifyCode.trim(), vaultPin);
      setSetupData(null);
      setVerifyCode("");
      onChanged(true);
      toast({ title: "2FA enabled", description: "Your Vault is now protected." });
    } catch (err) {
      if (!(err instanceof Error && err.message === "cancelled")) {
        toast({ title: "Invalid code — try again", variant: "destructive" });
      }
      setVerifyCode("");
    } finally {
      setBusy(false);
    }
  }

  async function handleDisable() {
    if (!confirm("Disable 2FA? You won't be able to access the Vault until you re-enable it.")) return;
    setBusy(true);
    try {
      const vaultPin = await askVaultPin();
      await disableTwoFa(vaultPin);
      onChanged(false);
      toast({ title: "2FA disabled" });
    } catch (err) {
      if (!(err instanceof Error && err.message === "cancelled")) {
        toast({ title: "Couldn't disable 2FA", variant: "destructive" });
      }
    } finally {
      setBusy(false);
    }
  }

  function copySecret() {
    if (!setupData) return;
    navigator.clipboard.writeText(setupData.secret);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-mono uppercase tracking-wide flex items-center gap-2">
          <ShieldCheck className="w-4 h-4 text-primary/60" /> Vault 2FA
        </CardTitle>
        <CardDescription className="text-xs font-mono">
          Your Vault PIN or Vault password + this Vault-only 2FA code, required on the first
          Vault visit of the day or after {VAULT_UNLOCK_HOURS}h of inactivity — a passkey can
          skip this if you have one registered. This is separate from your account's
          login 2FA under Account → Security.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Status badge */}
        <div className="flex items-center gap-1.5 text-xs font-mono">
          {enabled === null ? (
            <><Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground/40" /> <span className="text-muted-foreground/50">Checking…</span></>
          ) : enabled ? (
            <><CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" /> <span className="text-emerald-400">2FA enabled</span></>
          ) : (
            <><ShieldAlert className="w-3.5 h-3.5 text-amber-400" /> <span className="text-amber-400">2FA not enabled — Vault is inaccessible until it is</span></>
          )}
        </div>

        {/* Setup flow — shown after "Enable 2FA" is clicked */}
        {setupData && !enabled && (
          <div className="space-y-3 pt-1 border-t border-border/20">
            <p className="text-xs font-mono text-muted-foreground/70">
              Scan the QR code with Google Authenticator, Authy, or any TOTP app,
              then enter the 6-digit code below.
            </p>
            {setupData.qrDataUrl ? (
              <div className="flex justify-center">
                <img
                  src={setupData.qrDataUrl}
                  alt="2FA QR code"
                  className="w-36 h-36 rounded-md bg-white p-2"
                />
              </div>
            ) : null}
            <div className="flex items-center gap-2 px-3 py-2 bg-muted/20 rounded-lg border border-border/30">
              <QrCode className="w-3.5 h-3.5 text-muted-foreground/50 flex-shrink-0" />
              <span className="font-mono text-xs tracking-widest text-primary flex-1 truncate">
                {setupData.secret}
              </span>
              <button
                type="button"
                onClick={copySecret}
                className="text-muted-foreground/50 hover:text-primary transition-colors flex-shrink-0"
              >
                {copied
                  ? <Check className="w-3.5 h-3.5 text-emerald-400" />
                  : <Copy className="w-3.5 h-3.5" />}
              </button>
            </div>
            <div className="space-y-1.5">
              <Label className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
                Authenticator Code
              </Label>
              <PinInput
                length={6}
                value={verifyCode}
                onChange={setVerifyCode}
                onComplete={confirmSetup}
                disabled={busy}
                error={false}
              />
            </div>
          </div>
        )}
      </CardContent>

      <CardFooter className="gap-2 flex-wrap">
        {enabled ? (
          <Button
            variant="outline" size="sm" className="font-mono text-xs"
            onClick={handleDisable} disabled={busy}
          >
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Disable 2FA"}
          </Button>
        ) : setupData ? (
          <>
            <Button
              size="sm" className="font-mono text-xs"
              onClick={confirmSetup}
              disabled={busy || verifyCode.length !== 6}
            >
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Confirm & Enable"}
            </Button>
            <Button
              variant="ghost" size="sm" className="font-mono text-xs"
              onClick={() => { setSetupData(null); setVerifyCode(""); }}
              disabled={busy}
            >
              Cancel
            </Button>
          </>
        ) : (
          <Button
            size="sm" className="font-mono text-xs"
            onClick={startSetup} disabled={busy || enabled === null}
          >
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Enable 2FA"}
          </Button>
        )}
      </CardFooter>
    </Card>
  );
}

// ─── PIN status card ──────────────────────────────────────────────────────────

function PinStatusCard({
  icon: Icon, title, description, isSet, onManage,
}: {
  icon: React.ElementType; title: string; description: string; isSet: boolean; onManage: () => void;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-mono uppercase tracking-wide flex items-center gap-2">
          <Icon className="w-4 h-4 text-primary/60" /> {title}
        </CardTitle>
        <CardDescription className="text-xs font-mono">{description}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-center gap-1.5 text-xs font-mono">
          {isSet ? (
            <><CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" /> <span className="text-emerald-400">PIN set</span></>
          ) : (
            <><Circle className="w-3.5 h-3.5 text-muted-foreground/40" /> <span className="text-muted-foreground/60">Not set</span></>
          )}
        </div>
      </CardContent>
      <CardFooter>
        <Button variant={isSet ? "outline" : "default"} size="sm" className="font-mono text-xs" onClick={onManage}>
          {isSet ? "Change PIN" : "Set PIN"}
        </Button>
      </CardFooter>
    </Card>
  );
}

// ─── PIN change dialog ────────────────────────────────────────────────────────

type Step = "current" | "new" | "confirm";

function PinDialog({
  kind, isChange, onClose, onSaved,
}: {
  kind: PinKind; isChange: boolean; onClose: () => void; onSaved: () => void;
}) {
  const [step, setStep]           = useState<Step>(isChange ? "current" : "new");
  const [currentPin, setCurrentPin] = useState("");
  const [newPin, setNewPin]       = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [error, setError]         = useState<string | null>(null);
  const [saving, setSaving]       = useState(false);
  const { toast } = useToast();

  const label = kind === "vault" ? "Vault PIN" : "Entity-View PIN";

  function handleCurrentComplete(pin: string) {
    setCurrentPin(pin); setError(null); setStep("new");
  }
  function handleNewComplete(pin: string) {
    setNewPin(pin); setError(null); setStep("confirm");
  }
  async function handleConfirmComplete(pin: string) {
    setConfirmPin(pin);
    if (pin !== newPin) {
      setError("PINs don't match — try again."); setConfirmPin(""); return;
    }
    setSaving(true); setError(null);
    try {
      await setPin(kind, newPin, isChange ? currentPin : undefined);
      toast({ title: `${label} saved`, description: isChange ? "Your PIN has been updated." : "Your PIN is now active." });
      onSaved();
    } catch (err) {
      setNewPin(""); setConfirmPin("");
      if (err instanceof ApiError && err.status === 403) {
        setError("Current PIN was incorrect."); setCurrentPin(""); setStep("current");
      } else {
        setError("Couldn't save PIN — try again."); setStep("new");
      }
    } finally {
      setSaving(false);
    }
  }

  const stepCopy: Record<Step, string> = {
    current: `Enter your current ${label.toLowerCase()}`,
    new: isChange ? `Enter a new ${label.toLowerCase()}` : `Choose a ${label.toLowerCase()}`,
    confirm: `Confirm your new ${label.toLowerCase()}`,
  };

  return (
    <Dialog open onOpenChange={o => !o && onClose()}>
      <DialogContent className="max-w-xs">
        <DialogHeader>
          <DialogTitle className="font-mono text-sm uppercase tracking-wide">
            {isChange ? `Change ${label}` : `Set ${label}`}
          </DialogTitle>
          <DialogDescription className="font-mono text-xs">{stepCopy[step]}</DialogDescription>
        </DialogHeader>
        <div className="py-4">
          {step === "current" && (
            <PinInput value={currentPin} onChange={setCurrentPin} onComplete={handleCurrentComplete} disabled={saving} error={!!error} autoFocus />
          )}
          {step === "new" && (
            <PinInput value={newPin} onChange={setNewPin} onComplete={handleNewComplete} disabled={saving} error={!!error} autoFocus />
          )}
          {step === "confirm" && (
            <PinInput value={confirmPin} onChange={setConfirmPin} onComplete={handleConfirmComplete} disabled={saving} error={!!error} autoFocus />
          )}
        </div>
        {error && <p className="text-destructive font-mono text-xs text-center -mt-2">{error}</p>}
        <DialogFooter>
          <Button variant="ghost" size="sm" className="font-mono text-xs" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          {saving && (
            <div className="flex items-center gap-1.5 text-xs font-mono text-muted-foreground">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> Saving...
            </div>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Vault Auth Password card ──────────────────────────────────────────────
// Separate from the account login password (see schema/vault-security.ts's
// vaultPasswordHash field for the full rationale). This is the "password"
// half of the password+2FA fallback checked by routes/vault-reauth.ts's
// POST /vault/reauth/verify — when unset, that route falls back to the
// account password, same as before this feature existed.

function VaultPasswordCard({
  isSet, hasVaultPin, onManage, onDisabled, askVaultPin,
}: {
  isSet: boolean;
  hasVaultPin: boolean;
  onManage: () => void;
  onDisabled: () => void;
  askVaultPin: () => Promise<string>;
}) {
  const [busy, setBusy] = useState(false);
  const { toast } = useToast();

  async function handleDisable() {
    const warning = hasVaultPin
      ? "Turn off the Vault password? You'll still be able to unlock Vault with your Vault PIN."
      : "Turn off the Vault password? With no Vault PIN set either, you'll only be able to unlock Vault with a passkey.";
    if (!confirm(warning)) return;
    setBusy(true);
    try {
      const vaultPin = await askVaultPin();
      await disableVaultPassword(vaultPin);
      toast({ title: "Vault password disabled" });
      onDisabled();
    } catch (err) {
      if (!(err instanceof Error && err.message === "cancelled")) {
        toast({ title: "Couldn't disable Vault password", variant: "destructive" });
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-mono uppercase tracking-wide flex items-center gap-2">
          <ShieldAlert className="w-4 h-4 text-primary/60" /> Vault Password
        </CardTitle>
        <CardDescription className="text-xs font-mono">
          A password just for Vault — never your account login password. Used with Vault 2FA
          to unlock Vault when passkey isn't available (the Vault PIN above takes priority if
          it's also set).
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-center gap-1.5 text-xs font-mono">
          {isSet ? (
            <><CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" /> <span className="text-emerald-400">Vault password set</span></>
          ) : (
            <><Circle className="w-3.5 h-3.5 text-muted-foreground/40" /> <span className="text-muted-foreground/60">Not set</span></>
          )}
        </div>
      </CardContent>
      <CardFooter className="gap-2 flex-wrap">
        <Button variant={isSet ? "outline" : "default"} size="sm" className="font-mono text-xs" onClick={onManage}>
          {isSet ? "Change Vault Password" : "Set Vault Password"}
        </Button>
        {isSet && (
          <Button variant="ghost" size="sm" className="font-mono text-xs" onClick={handleDisable} disabled={busy}>
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Turn Off"}
          </Button>
        )}
      </CardFooter>
    </Card>
  );
}

// ─── Passkey Configuration ──────────────────────────────────────────────────
// Same account-wide passkeys managed on the account /security page (see
// pages/user/security.tsx's PasskeysPanel and routes/passkey.ts) — surfaced
// here too since these are exactly what components/vault/vault-auth.tsx
// tries first when unlocking Vault. Adding/removing a passkey here affects
// both account login and Vault re-auth identically; there's no
// Vault-specific passkey set.

function PasskeysCard({ token, askVaultPin }: { token: string; askVaultPin: () => Promise<string> }) {
  const { toast } = useToast();
  const [passkeys, setPasskeys] = useState<PasskeySummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [registering, setRegistering] = useState(false);
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const supported = browserSupportsWebAuthn();

  const load = useCallback(async () => {
    setLoading(true);
    try { setPasskeys(await listPasskeys(token)); } catch { setPasskeys([]); }
    setLoading(false);
  }, [token]);

  useEffect(() => { load(); }, [load]);

  const handleAdd = async () => {
    setRegistering(true);
    try {
      const vaultPin = await askVaultPin();
      const label = typeof navigator !== "undefined" && /iphone|ipad/i.test(navigator.userAgent) ? "iPhone"
        : /android/i.test(navigator.userAgent) ? "Android device"
        : /mac/i.test(navigator.userAgent) ? "Mac" : "This device";
      await registerPasskey(token, label, vaultPin);
      toast({ title: "Passkey added" });
      load();
    } catch (e: any) {
      if (e?.name !== "NotAllowedError" && e?.message !== "cancelled") {
        toast({ variant: "destructive", title: "Could not add passkey", description: e.message });
      }
    }
    setRegistering(false);
  };

  const handleRename = async (id: number) => {
    if (!renameValue.trim()) { setRenamingId(null); return; }
    try {
      await renamePasskey(token, id, renameValue.trim());
      setRenamingId(null);
      load();
    } catch (e: any) { toast({ variant: "destructive", title: "Rename failed", description: e.message }); }
  };

  const handleDelete = async (id: number) => {
    try {
      const vaultPin = await askVaultPin();
      await deletePasskey(token, id, vaultPin);
      toast({ title: "Passkey removed" });
      load();
    } catch (e: any) {
      if (e?.message !== "cancelled") toast({ variant: "destructive", title: "Failed", description: e.message });
    }
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-mono uppercase tracking-wide flex items-center gap-2">
          <Fingerprint className="w-4 h-4 text-primary/60" /> Passkey
        </CardTitle>
        <CardDescription className="text-xs font-mono">
          Unlock Vault instantly with your device's fingerprint, face, or screen lock — tried
          first, before any PIN/password + 2FA fallback.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {!supported ? (
          <div className="bg-amber-500/5 border border-amber-500/20 rounded-lg p-3 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" />
            <p className="text-xs font-mono text-amber-400">This browser doesn't support passkeys.</p>
          </div>
        ) : loading ? (
          <div className="flex items-center gap-2 text-muted-foreground text-xs font-mono"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading...</div>
        ) : passkeys.length === 0 ? (
          <div className="bg-muted/20 border border-border/30 rounded-lg p-3 text-xs font-mono text-muted-foreground">
            No passkeys yet — add one below to skip the PIN/password + 2FA step when unlocking Vault.
          </div>
        ) : (
          <div className="space-y-2">
            {passkeys.map((pk) => (
              <div key={pk.id} className="flex items-center gap-3 bg-muted/10 border border-border/30 rounded-md px-3 py-2.5">
                <Fingerprint className="w-4 h-4 text-primary flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  {renamingId === pk.id ? (
                    <Input
                      autoFocus
                      value={renameValue}
                      onChange={e => setRenameValue(e.target.value)}
                      onKeyDown={e => e.key === "Enter" && handleRename(pk.id)}
                      onBlur={() => handleRename(pk.id)}
                      className="h-7 text-xs font-mono bg-input border-border"
                    />
                  ) : (
                    <div className="font-mono text-xs text-foreground truncate">{pk.name}</div>
                  )}
                  <div className="text-[10px] font-mono text-muted-foreground mt-0.5">
                    {pk.lastUsedAt ? `Last used ${new Date(pk.lastUsedAt).toLocaleDateString()}` : `Added ${new Date(pk.createdAt).toLocaleDateString()}`}
                  </div>
                </div>
                <button
                  onClick={() => { setRenamingId(pk.id); setRenameValue(pk.name); }}
                  className="text-muted-foreground hover:text-primary flex-shrink-0"
                  title="Rename"
                >
                  <Pencil className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={() => handleDelete(pk.id)}
                  className="text-muted-foreground hover:text-red-400 flex-shrink-0"
                  title="Remove"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
      </CardContent>
      {supported && (
        <CardFooter>
          <Button size="sm" className="font-mono text-xs gap-2" onClick={handleAdd} disabled={registering}>
            {registering ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
            Add Passkey
          </Button>
        </CardFooter>
      )}
    </Card>
  );
}

// ─── Vault Auth Password dialog ────────────────────────────────────────────

function VaultPasswordDialog({
  isChange, onClose, onSaved, askVaultPin,
}: {
  isChange: boolean;
  onClose: () => void;
  onSaved: () => void;
  askVaultPin: () => Promise<string>;
}) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword]         = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showCurrent, setShowCurrent]         = useState(false);
  const [showNew, setShowNew]                 = useState(false);
  const [error, setError]                     = useState<string | null>(null);
  const [saving, setSaving]                   = useState(false);
  const { toast } = useToast();

  async function handleSave() {
    if (isChange && !currentPassword) {
      setError("Enter your current Vault password."); return;
    }
    if (newPassword.length < MIN_VAULT_PASSWORD_LENGTH) {
      setError(`Vault password must be at least ${MIN_VAULT_PASSWORD_LENGTH} characters.`); return;
    }
    if (newPassword !== confirmPassword) {
      setError("Passwords don't match."); return;
    }
    setSaving(true); setError(null);
    try {
      const vaultPin = await askVaultPin();
      await setVaultPassword(newPassword, isChange ? currentPassword : undefined, vaultPin);
      toast({ title: "Vault password saved", description: isChange ? "Your Vault password has been updated." : "Your Vault password is now active." });
      onSaved();
    } catch (err) {
      if (err instanceof Error && err.message === "cancelled") {
        setSaving(false); return;
      }
      if (err instanceof ApiError && err.status === 403) {
        setError("Current Vault password was incorrect.");
      } else if (err instanceof ApiError && err.status === 429) {
        setError((err.data as any)?.solution ?? "Too many attempts — try again shortly.");
      } else {
        setError("Couldn't save Vault password — try again.");
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={o => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="font-mono text-sm uppercase tracking-wide">
            {isChange ? "Change Vault Password" : "Set Vault Password"}
          </DialogTitle>
          <DialogDescription className="font-mono text-xs">
            {isChange
              ? "This replaces your current Vault password — not your account login password."
              : "This is separate from your account login password, used only to unlock Vault."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {isChange && (
            <div className="space-y-1.5">
              <Label className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
                Current Vault Password
              </Label>
              <div className="relative">
                <Input
                  type={showCurrent ? "text" : "password"}
                  autoComplete="current-password"
                  value={currentPassword}
                  disabled={saving}
                  onChange={e => setCurrentPassword(e.target.value)}
                  className="font-mono text-sm pr-9"
                />
                <button type="button" onClick={() => setShowCurrent(p => !p)} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground">
                  {showCurrent ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>
          )}

          <div className="space-y-1.5">
            <Label className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
              New Vault Password
            </Label>
            <div className="relative">
              <Input
                type={showNew ? "text" : "password"}
                autoComplete="new-password"
                placeholder={`Min ${MIN_VAULT_PASSWORD_LENGTH} characters`}
                value={newPassword}
                disabled={saving}
                onChange={e => setNewPassword(e.target.value)}
                className="font-mono text-sm pr-9"
              />
              <button type="button" onClick={() => setShowNew(p => !p)} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground">
                {showNew ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
              Confirm New Vault Password
            </Label>
            <Input
              type={showNew ? "text" : "password"}
              autoComplete="new-password"
              value={confirmPassword}
              disabled={saving}
              onChange={e => setConfirmPassword(e.target.value)}
              className="font-mono text-sm"
            />
          </div>
        </div>

        {error && <p className="text-destructive font-mono text-xs -mt-1">{error}</p>}

        <DialogFooter className="gap-2">
          <Button variant="ghost" size="sm" className="font-mono text-xs" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            size="sm" className="font-mono text-xs"
            onClick={handleSave}
            disabled={saving || !newPassword || !confirmPassword || (isChange && !currentPassword)}
          >
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Vault Security PIN — mandatory, most-powerful credential in Vault ────
// See schema/vault-security.ts's vaultPinHash comment + lib/vault-pin-guard.ts.
// Setting/changing it is deliberately heavier than every other PIN/password
// in Vault: it always requires a fresh email code AND the account login
// password (VaultPinSetupDialog below), never just "enter the old PIN".

function VaultPinSetupCard({ isSet, onManage }: { isSet: boolean; onManage: () => void }) {
  return (
    <Card className={isSet ? undefined : "border-primary/40"}>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-mono uppercase tracking-wide flex items-center gap-2">
          <ShieldCheck className="w-4 h-4 text-primary" /> Vault Security PIN
          {!isSet && <span className="text-[10px] font-mono text-primary/80 border border-primary/30 rounded px-1.5 py-0.5 normal-case tracking-normal">Required</span>}
        </CardTitle>
        <CardDescription className="text-xs font-mono">
          The most powerful credential in Vault. Required — on top of whatever else a given
          action already asks for — to add/remove a passkey, enable or disable Vault 2FA,
          set or change your Vault password, change the auth-step policy below, and as the
          credential checked during Vault re-auth steps 2 and 3. Setting or changing it always
          needs your account password plus a fresh email code — never just the old PIN.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-center gap-1.5 text-xs font-mono">
          {isSet ? (
            <><CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" /> <span className="text-emerald-400">Vault PIN set</span></>
          ) : (
            <><Circle className="w-3.5 h-3.5 text-primary/60" /> <span className="text-primary/80">Not set yet — set it now to unlock the rest of Vault security</span></>
          )}
        </div>
      </CardContent>
      <CardFooter>
        <Button variant={isSet ? "outline" : "default"} size="sm" className="font-mono text-xs" onClick={onManage}>
          {isSet ? "Change Vault PIN" : "Set Vault PIN"}
        </Button>
      </CardFooter>
    </Card>
  );
}

type PinSetupStep = "intro" | "code-sent" | "form";

function VaultPinSetupDialog({
  isChange, onClose, onSaved,
}: {
  isChange: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [step, setStep] = useState<PinSetupStep>("intro");
  const [sending, setSending] = useState(false);
  const [accountPassword, setAccountPassword] = useState("");
  const [emailCode, setEmailCode] = useState("");
  const [newPin, setNewPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();

  async function sendCode() {
    setSending(true); setError(null);
    try {
      await requestVaultPinSetupCode();
      setStep("form");
      toast({ title: "Code sent", description: "Check your email for the Vault PIN setup code." });
    } catch {
      setError("Couldn't send the email code — try again.");
    } finally {
      setSending(false);
    }
  }

  async function handleSave() {
    if (!accountPassword) { setError("Enter your account password."); return; }
    if (!emailCode.trim()) { setError("Enter the code from your email."); return; }
    if (newPin.length !== 4) { setError("PIN must be 4 digits."); return; }
    if (newPin !== confirmPin) { setError("PINs don't match."); return; }
    setSaving(true); setError(null);
    try {
      await setVaultPin(newPin, accountPassword, emailCode.trim());
      toast({ title: "Vault PIN saved", description: isChange ? "Your Vault PIN has been updated." : "Your Vault PIN is now active — the rest of Vault security is unlocked." });
      onSaved();
    } catch (err) {
      if (err instanceof ApiError) {
        const code = (err.data as any)?.code;
        if (code === "WRONG_ACCOUNT_PASSWORD") setError("Incorrect account password.");
        else if (code === "WRONG_EMAIL_CODE") setError("Invalid or expired email code — request a new one.");
        else setError((err.data as any)?.error ?? "Couldn't save Vault PIN — try again.");
      } else {
        setError("Couldn't save Vault PIN — try again.");
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={o => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="font-mono text-sm uppercase tracking-wide">
            {isChange ? "Change Vault Security PIN" : "Set Vault Security PIN"}
          </DialogTitle>
          <DialogDescription className="font-mono text-xs">
            Requires your account password and a fresh email code — this PIN gates the rest
            of Vault security.
          </DialogDescription>
        </DialogHeader>

        {step === "intro" && (
          <div className="space-y-4 py-2">
            <p className="text-xs font-mono text-muted-foreground/70">
              We'll email a 6-digit code to your account address. You'll need it, along with
              your account password, to finish.
            </p>
            <Button size="sm" className="font-mono text-xs gap-2 w-full" onClick={sendCode} disabled={sending}>
              {sending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Mail className="w-3.5 h-3.5" />}
              Send Email Code
            </Button>
          </div>
        )}

        {step === "form" && (
          <div className="space-y-4 py-2">
            <div className="space-y-1.5 text-left">
              <Label className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
                Account Password
              </Label>
              <div className="relative">
                <Input
                  type={showPassword ? "text" : "password"}
                  autoComplete="current-password"
                  value={accountPassword}
                  disabled={saving}
                  onChange={e => setAccountPassword(e.target.value)}
                  className="font-mono text-sm pr-9"
                />
                <button type="button" onClick={() => setShowPassword(p => !p)} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground">
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <div className="space-y-1.5 text-left">
              <Label className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
                Email Code
              </Label>
              <Input
                inputMode="numeric"
                placeholder="000000"
                value={emailCode}
                disabled={saving}
                onChange={e => setEmailCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                className="font-mono text-sm tracking-widest"
              />
              <button type="button" onClick={sendCode} disabled={sending} className="font-mono text-[10px] text-muted-foreground hover:text-primary underline underline-offset-2">
                Resend code
              </button>
            </div>

            <div className="space-y-1.5">
              <Label className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70 block text-center">
                New Vault PIN
              </Label>
              <PinInput value={newPin} onChange={setNewPin} disabled={saving} error={!!error} />
            </div>

            <div className="space-y-1.5">
              <Label className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70 block text-center">
                Confirm Vault PIN
              </Label>
              <PinInput value={confirmPin} onChange={setConfirmPin} disabled={saving} error={!!error} />
            </div>
          </div>
        )}

        {error && <p className="text-destructive font-mono text-xs -mt-1">{error}</p>}

        <DialogFooter className="gap-2">
          <Button variant="ghost" size="sm" className="font-mono text-xs" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          {step === "form" && (
            <Button
              size="sm" className="font-mono text-xs"
              onClick={handleSave}
              disabled={saving || !accountPassword || emailCode.length !== 6 || newPin.length !== 4 || confirmPin.length !== 4}
            >
              {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Save"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Auth step policy — how many of the 3 Vault re-auth steps are required ─
// See schema/vault-security.ts's authStepPolicy comment and
// components/vault/vault-auth.tsx for how each value plays out at unlock
// time. Changing this is itself gated by the Vault PIN.

const POLICY_LABELS: Record<AuthStepPolicy, { title: string; description: string }> = {
  any: {
    title: "Any one step",
    description: "Passing passkey, OR PIN/password + 2FA, OR email code + Vault PIN unlocks Vault. Fastest, matches how Vault worked before this setting existed.",
  },
  step12: {
    title: "Steps 1 + 2 required",
    description: "Both passkey AND Vault PIN/password + 2FA must succeed. Step 3 (email code) is still available as a fail-over if step 2 can't be completed.",
  },
  step123: {
    title: "Steps 1 + 2 + 3 required",
    description: "Passkey, Vault PIN/password + 2FA, AND email code + Vault PIN must all succeed. The strictest option.",
  },
};

function AuthStepPolicyCard({
  policy, step3Available, askVaultPin, onSaved,
}: {
  policy: AuthStepPolicy;
  step3Available: boolean;
  askVaultPin: () => Promise<string>;
  onSaved: () => void;
}) {
  const [saving, setSaving] = useState<AuthStepPolicy | null>(null);
  const { toast } = useToast();

  async function choose(next: AuthStepPolicy) {
    if (next === policy || saving) return;
    setSaving(next);
    try {
      const vaultPin = await askVaultPin();
      await setAuthStepPolicy(next, vaultPin);
      toast({ title: "Auth policy updated", description: POLICY_LABELS[next].title });
      onSaved();
    } catch (err: any) {
      if (err?.message !== "cancelled") {
        toast({ variant: "destructive", title: "Couldn't update policy", description: err?.message });
      }
    } finally {
      setSaving(null);
    }
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-mono uppercase tracking-wide flex items-center gap-2">
          <ListChecks className="w-4 h-4 text-primary/60" /> Vault Auth Steps
        </CardTitle>
        <CardDescription className="text-xs font-mono">
          How many of the 3 Vault re-auth steps must pass before Vault unlocks.
          {!step3Available && " Step 3 needs a Vault PIN first."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {(Object.keys(POLICY_LABELS) as AuthStepPolicy[]).map((key) => {
          const info = POLICY_LABELS[key];
          const active = policy === key;
          return (
            <button
              key={key}
              type="button"
              onClick={() => choose(key)}
              disabled={saving !== null}
              className={`w-full text-left rounded-lg border px-3 py-2.5 transition-colors ${
                active ? "border-primary/50 bg-primary/5" : "border-border/30 bg-muted/10 hover:border-border/50"
              }`}
            >
              <div className="flex items-center gap-2">
                {active ? <CheckCircle2 className="w-3.5 h-3.5 text-primary flex-shrink-0" /> : <Circle className="w-3.5 h-3.5 text-muted-foreground/40 flex-shrink-0" />}
                <span className="font-mono text-xs uppercase tracking-wide text-foreground">{info.title}</span>
                {saving === key && <Loader2 className="w-3 h-3 animate-spin ml-auto" />}
              </div>
              <p className="font-mono text-[10px] text-muted-foreground/70 mt-1 ml-5.5 pl-0.5">{info.description}</p>
            </button>
          );
        })}
      </CardContent>
    </Card>
  );
}
