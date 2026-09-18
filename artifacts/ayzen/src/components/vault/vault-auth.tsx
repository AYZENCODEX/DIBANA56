/**
 * components/vault/vault-auth.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase 17 — Vault Auth, extended for the 3-step re-auth + auth-step policy
 * feature. The re-auth screen rendered by vault-unlock-gate.tsx when the
 * Vault window has expired.
 *
 * Three possible steps, tried in order:
 *   1. Passkey — attempted automatically on mount if this account has ≥1
 *      passkey registered and the browser supports WebAuthn. Skipped
 *      entirely (not just failed — never shown) if no passkey exists.
 *   2. Vault PIN/Password + Vault 2FA — "Passkey unavailable? Use PIN/
 *      Password instead" whenever a passkey exists, or shown directly when
 *      it doesn't. Needs Vault 2FA enabled AND a Vault PIN or password
 *      configured (PIN takes priority when both exist) — see
 *      routes/vault-reauth.ts's POST /vault/reauth/verify.
 *   3. Email code + Vault PIN — a fail-over for step 2, reached via
 *      "Step 2 unavailable?" (e.g. lost authenticator app). Needs only a
 *      Vault PIN — no 2FA required, since the email code IS the second
 *      factor here. See POST /vault/reauth/email-code/send + /verify-step3.
 *
 * How many of the AVAILABLE steps must actually pass before Vault unlocks
 * is controlled by vault_security.auth_step_policy (see
 * schema/vault-security.ts + pages/user/vault-security.tsx's
 * AuthStepPolicyCard):
 *   "any"     — the first step that passes unlocks Vault immediately.
 *   "step12"  — step 1 (if a passkey exists) AND step 2 must both pass.
 *      Step 3 counts as fulfilling the "step 2" slot when used as its
 *      fail-over (you don't have to pass a broken step 2 AND its own
 *      replacement).
 *   "step123" — step 1 (if applicable) AND step 2-or-its-step-3-failover
 *      AND step 3 specifically must all pass. If step 3 was already used
 *      as step 2's fail-over that requirement is already met; otherwise,
 *      after step 2 succeeds normally, step 3 is asked for as one final
 *      step.
 * See isUnlocked() below for the exact rule this implements.
 *
 * A lightweight math captcha (same pattern as pages/login.tsx's
 * makeCaptcha) gates steps 2 and 3's submit button — passkey ceremonies
 * (step 1) are themselves a strong possession/biometric check and don't
 * get one.
 */
import { useEffect, useState } from "react";
import { Link } from "wouter";
import { startAuthentication } from "@simplewebauthn/browser";
import { browserSupportsWebAuthn } from "@/lib/passkey-api";
import {
  getVaultReauthStatus, verifyVaultReauth,
  getVaultReauthPasskeyOptions, verifyVaultReauthPasskey,
  sendVaultReauthEmailCode, verifyVaultReauthStep3,
  type AuthStepPolicy,
} from "@/lib/vault-security-api";
import { setVaultUnlocked } from "@/lib/vault-lock";
import { PinInput } from "@/components/vault/pin-input";
import { useCaptcha, CaptchaField } from "@/components/vault/math-captcha";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ShieldCheck, Loader2, AlertCircle, KeyRound, Lock, Fingerprint, Mail } from "lucide-react";
import { ApiError } from "@workspace/api-client-react";
import { cn } from "@/lib/utils";

type Stage =
  | "loading"          // fetching /vault/reauth/status
  | "passkey"          // attempting/offering passkey (step 1)
  | "password"         // Vault PIN/password + Vault 2FA form (step 2)
  | "email-step3"      // email code + Vault PIN (step 3)
  | "needs-setup";     // no step is completable yet

// Which of the 3 steps have passed this session, tracked at the top level
// so isUnlocked() can be re-evaluated after every success regardless of
// which stage produced it.
interface Progress {
  step1: boolean; // passkey
  step2: boolean; // PIN/password + Vault 2FA
  step3: boolean; // email code + Vault PIN (may have run as step 2's fail-over, or explicitly afterward)
}

function isUnlocked(policy: AuthStepPolicy, hasPasskey: boolean, p: Progress): boolean {
  const step1Ok = !hasPasskey || p.step1; // not required at all if no passkey exists
  const coreOk = p.step2 || p.step3;      // step 3 fulfills step 2's slot when used as its fail-over
  if (policy === "any") return p.step1 || p.step2 || p.step3;
  if (policy === "step12") return step1Ok && coreOk;
  // step123: same as step12, but step 3 must specifically have passed too —
  // already true if it was used as step 2's fail-over, otherwise it's
  // asked for as one more step after step 2 succeeds normally.
  return step1Ok && coreOk && p.step3;
}

/**
 * Once a step succeeds but isUnlocked() is still false (only reachable
 * under "step12"/"step123"), this picks which stage to show next based on
 * what's actually still missing — not just "whichever step number came
 * after the one that just passed", which would sometimes send someone to
 * step 3 for an email code they don't need when the real gap is an
 * unpassed passkey (step 1).
 */
function nextNeededStage(policy: AuthStepPolicy, hasPasskey: boolean, p: Progress): Stage {
  const step1Ok = !hasPasskey || p.step1;
  if (!step1Ok) return "passkey";
  if (!(p.step2 || p.step3)) return "password";
  // step1Ok and (step2||step3) both true here — only step123's extra
  // "step 3 specifically" requirement can still be unmet.
  return "email-step3";
}

// ─── Fancy icon badge shared by every stage ────────────────────────────────
// Gradient glow ring + a slow-spinning dashed border so the "Vault Locked"
// screen reads as something guarding a vault, not a generic form icon.
const TONE_CLASSES = {
  primary: { ring: "from-primary/40 via-primary/10 to-transparent", box: "bg-primary/10 border-primary/20", icon: "text-primary" },
  amber:   { ring: "from-amber-400/40 via-amber-400/10 to-transparent", box: "bg-amber-500/10 border-amber-500/20", icon: "text-amber-400" },
} as const;

function VaultAuthIcon({ icon: Icon, tone, pulsing }: { icon: React.ElementType; tone: keyof typeof TONE_CLASSES; pulsing?: boolean }) {
  const t = TONE_CLASSES[tone];
  return (
    <div className="relative mx-auto w-16 h-16 animate-scale-in">
      <div className={cn("absolute inset-0 rounded-full bg-gradient-to-br blur-md", t.ring, pulsing && "animate-glow-pulse")} />
      <div className="absolute inset-0 rounded-2xl border border-dashed border-primary/25 animate-spin-slow" />
      <div className={cn("relative w-16 h-16 rounded-2xl border flex items-center justify-center", t.box)}>
        <Icon className={cn("w-6 h-6", t.icon)} />
      </div>
    </div>
  );
}

export function VaultAuth({ onUnlocked }: { onUnlocked: () => void }) {
  const [stage, setStage] = useState<Stage>("loading");
  const [hasPasskey, setHasPasskey] = useState(false);
  const [usesVaultPin, setUsesVaultPin] = useState(false);
  const [step3Available, setStep3Available] = useState(false);
  const [policy, setPolicy] = useState<AuthStepPolicy>("any");
  const [progress, setProgress] = useState<Progress>({ step1: false, step2: false, step3: false });
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const [passkeyError, setPasskeyError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getVaultReauthStatus()
      .then(status => {
        if (cancelled) return;
        setHasPasskey(status.hasPasskey);
        setUsesVaultPin(status.usesVaultPin);
        setStep3Available(status.step3Available);
        setPolicy(status.authStepPolicy);
        const fallbackReady = status.twoFaEnabled && status.hasCredential;
        if (status.hasPasskey && browserSupportsWebAuthn()) {
          setStage("passkey");
        } else if (fallbackReady) {
          setStage("password");
        } else if (status.step3Available) {
          // Step 2 isn't configured (no Vault 2FA, or no credential) but a
          // Vault PIN exists — go straight to step 3, its only requirement.
          setStage("email-step3");
        } else {
          setStage("needs-setup");
        }
      })
      .catch(() => { if (!cancelled) setStage("password"); }); // fail open to the form rather than dead-end
    return () => { cancelled = true; };
  }, []);

  function markPassed(step: 1 | 2 | 3, currentPolicy: AuthStepPolicy, currentHasPasskey: boolean) {
    setProgress(prev => {
      const next: Progress = { ...prev, [`step${step}`]: true } as Progress;
      if (isUnlocked(currentPolicy, currentHasPasskey, next)) {
        setVaultUnlocked();
        onUnlocked();
      } else {
        // Not fully unlocked yet under a stricter policy — go straight to
        // whatever's actually still missing (see nextNeededStage's comment).
        setStage(nextNeededStage(currentPolicy, currentHasPasskey, next));
      }
      return next;
    });
  }

  async function attemptPasskey(auto: boolean) {
    setPasskeyBusy(true);
    setPasskeyError(null);
    try {
      const { options, challengeKey } = await getVaultReauthPasskeyOptions();
      const response = await startAuthentication({ optionsJSON: options });
      await verifyVaultReauthPasskey(challengeKey, response);
      markPassed(1, policy, hasPasskey);
      return;
    } catch (err: any) {
      // A cancelled/dismissed browser prompt on the automatic first attempt
      // shouldn't read as an error — just quietly leave the passkey option
      // available and let the person either retry or switch to password.
      if (err?.name !== "NotAllowedError" && !auto) {
        setPasskeyError(err?.message ?? "Passkey verification failed — try again.");
      }
    }
    setPasskeyBusy(false);
  }

  // Passkey-first: try once automatically as soon as we know it's an option.
  useEffect(() => {
    if (stage === "passkey") attemptPasskey(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage]);

  if (stage === "loading") {
    return (
      <div className="min-h-[60vh] flex items-center justify-center page-enter">
        <div className="relative">
          <div className="absolute inset-0 rounded-full bg-primary/20 blur-xl animate-glow-pulse" />
          <Loader2 className="relative w-6 h-6 text-primary animate-spin" />
        </div>
      </div>
    );
  }

  if (stage === "needs-setup") {
    return (
      <div className="min-h-[60vh] flex items-center justify-center page-enter">
        <div className="w-full max-w-xs space-y-6 text-center">
          <VaultAuthIcon icon={KeyRound} tone="amber" />
          <div className="animate-fade-up" style={{ animationDelay: "80ms" }}>
            <h1 className="text-lg font-bold font-mono uppercase tracking-tight">Vault Setup Required</h1>
            <p className="text-muted-foreground font-mono text-xs mt-1">
              Add a passkey, or set a Vault PIN/password and enable Vault 2FA, before you can unlock Vault.
            </p>
          </div>
          <Link href="/vault/security">
            <Button size="sm" className="font-mono text-xs uppercase tracking-wider transition-transform hover:scale-[1.03] active:scale-95 animate-fade-up" style={{ animationDelay: "160ms" }}>
              Go to Vault Security Settings
            </Button>
          </Link>
        </div>
      </div>
    );
  }

  if (stage === "passkey") {
    return (
      <div className="min-h-[60vh] flex items-center justify-center page-enter">
        <div className="w-full max-w-xs space-y-6 text-center">
          <VaultAuthIcon icon={Fingerprint} tone="primary" pulsing={passkeyBusy} />
          <div className="animate-fade-up" style={{ animationDelay: "80ms" }}>
            <h1 className="text-lg font-bold font-mono uppercase tracking-tight">Vault Locked</h1>
            <p className="text-muted-foreground font-mono text-xs mt-1">
              {passkeyBusy ? "Waiting for your passkey…" : "Unlock Vault with your passkey"}
            </p>
          </div>

          {passkeyError && (
            <p className="text-destructive font-mono text-xs flex items-center justify-center gap-1.5 animate-shake">
              <AlertCircle className="w-3.5 h-3.5" /> {passkeyError}
            </p>
          )}

          <Button
            size="sm"
            className="font-mono text-xs uppercase tracking-wider transition-transform hover:scale-[1.03] active:scale-95 animate-fade-up"
            style={{ animationDelay: "160ms" }}
            disabled={passkeyBusy}
            onClick={() => attemptPasskey(false)}
          >
            {passkeyBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <><Fingerprint className="w-3.5 h-3.5 mr-1.5" /> Try Passkey Again</>}
          </Button>

          <button
            type="button"
            onClick={() => setStage("password")}
            className="block mx-auto font-mono text-[10px] text-muted-foreground hover:text-primary transition-colors underline underline-offset-2 animate-fade-up"
            style={{ animationDelay: "220ms" }}
          >
            Passkey unavailable? Use PIN/Password instead
          </button>
        </div>
      </div>
    );
  }

  if (stage === "email-step3") {
    return (
      <EmailStep3Stage
        hasPasskey={hasPasskey}
        onBack={() => setStage(hasPasskey ? "passkey" : "password")}
        onUnlocked={() => markPassed(3, policy, hasPasskey)}
      />
    );
  }

  return (
    <PasswordStage
      hasPasskey={hasPasskey}
      usesVaultPin={usesVaultPin}
      step3Available={step3Available}
      onBackToPasskey={() => setStage("passkey")}
      onStep2Unavailable={() => setStage("email-step3")}
      onUnlocked={() => markPassed(2, policy, hasPasskey)}
    />
  );
}

function PasswordStage({
  hasPasskey, usesVaultPin, step3Available, onBackToPasskey, onStep2Unavailable, onUnlocked,
}: {
  hasPasskey: boolean;
  usesVaultPin: boolean;
  step3Available: boolean;
  onBackToPasskey: () => void;
  onStep2Unavailable: () => void;
  onUnlocked: () => void;
}) {
  // Vault PIN takes priority over Vault password when both are configured —
  // matches the server's preference in POST /vault/reauth/verify.
  const credentialLabel = usesVaultPin ? "Vault PIN" : "Vault Password";
  const [credential, setCredential] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  const captcha = useCaptcha();

  const credentialReady = usesVaultPin ? credential.length === 4 : !!credential;

  async function submit() {
    if (verifying || !credentialReady || totpCode.length !== 6) return;
    if (!captcha.check()) return;
    setVerifying(true);
    setError(null);
    try {
      await verifyVaultReauth(usesVaultPin ? { pin: credential } : { password: credential }, totpCode);
      onUnlocked();
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        setError((err.data as any)?.solution ?? "Too many attempts — try again shortly.");
      } else if (err instanceof ApiError && err.status === 401) {
        const code = (err.data as any)?.code;
        setError(code === "WRONG_TOTP" ? "Invalid authenticator code" : `Incorrect ${credentialLabel.toLowerCase()}`);
      } else {
        setError("Couldn't verify — try again.");
      }
      setTotpCode("");
    } finally {
      setVerifying(false);
    }
  }

  return (
    <div className="min-h-[60vh] flex items-center justify-center page-enter">
      <div className="w-full max-w-xs space-y-6 text-center">
        <VaultAuthIcon icon={ShieldCheck} tone="primary" />
        <div className="animate-fade-up" style={{ animationDelay: "60ms" }}>
          <h1 className="text-lg font-bold font-mono uppercase tracking-tight">Vault Locked</h1>
          <p className="text-muted-foreground font-mono text-xs mt-1">
            Enter your {credentialLabel.toLowerCase()} and Vault 2FA code to continue
          </p>
        </div>

        {usesVaultPin ? (
          <div className="space-y-1.5 animate-fade-up" style={{ animationDelay: "110ms" }}>
            <Label className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
              {credentialLabel}
            </Label>
            <PinInput length={4} value={credential} onChange={setCredential} disabled={verifying} error={!!error} autoFocus />
          </div>
        ) : (
          <div className="space-y-1.5 text-left animate-fade-up" style={{ animationDelay: "110ms" }}>
            <Label htmlFor="vault-auth-password" className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
              {credentialLabel}
            </Label>
            <Input
              id="vault-auth-password"
              type="password"
              autoComplete="current-password"
              autoFocus
              value={credential}
              disabled={verifying}
              onChange={e => setCredential(e.target.value)}
              className="font-mono text-sm transition-shadow focus-visible:shadow-[0_0_0_3px_var(--primary)/15]"
            />
          </div>
        )}

        <div className="space-y-1.5 animate-fade-up" style={{ animationDelay: "160ms" }}>
          <Label className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
            Vault Authenticator Code
          </Label>
          <PinInput length={6} value={totpCode} onChange={setTotpCode} disabled={verifying} error={!!error} />
        </div>

        <div className="animate-fade-up" style={{ animationDelay: "200ms" }}>
          <CaptchaField challenge={captcha.challenge} value={captcha.input} onChange={captcha.setInput} error={captcha.error} disabled={verifying} />
        </div>

        {error && (
          <p className="text-destructive font-mono text-xs flex items-center justify-center gap-1.5 animate-shake">
            <AlertCircle className="w-3.5 h-3.5" /> {error}
          </p>
        )}

        <Button
          size="sm"
          className="font-mono text-xs uppercase tracking-wider transition-transform hover:scale-[1.03] active:scale-95 animate-fade-up"
          style={{ animationDelay: "240ms" }}
          disabled={!credentialReady || totpCode.length !== 6 || !captcha.input || verifying}
          onClick={submit}
        >
          {verifying ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <><Lock className="w-3.5 h-3.5 mr-1.5" /> Unlock</>}
        </Button>

        <div className="flex flex-col gap-1.5 animate-fade-up" style={{ animationDelay: "280ms" }}>
          {hasPasskey && (
            <button
              type="button"
              onClick={onBackToPasskey}
              className="block mx-auto font-mono text-[10px] text-muted-foreground hover:text-primary transition-colors underline underline-offset-2"
            >
              Use passkey instead
            </button>
          )}
          {step3Available && (
            <button
              type="button"
              onClick={onStep2Unavailable}
              className="block mx-auto font-mono text-[10px] text-muted-foreground hover:text-primary transition-colors underline underline-offset-2"
            >
              Step 2 unavailable? Use email code instead
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Step 3 — email code + Vault PIN ───────────────────────────────────────
// Fail-over for step 2 (see file header). Sends a code on mount; the person
// enters it plus their Vault PIN. Same math captcha as step 2.
function EmailStep3Stage({
  hasPasskey, onBack, onUnlocked,
}: {
  hasPasskey: boolean;
  onBack: () => void;
  onUnlocked: () => void;
}) {
  const [pin, setPin] = useState("");
  const [emailCode, setEmailCode] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  const captcha = useCaptcha();

  useEffect(() => {
    let cancelled = false;
    setSending(true);
    sendVaultReauthEmailCode()
      .then(() => { if (!cancelled) setSent(true); })
      .catch(() => { if (!cancelled) setError("Couldn't send the email code — try again."); })
      .finally(() => { if (!cancelled) setSending(false); });
    return () => { cancelled = true; };
  }, []);

  async function resend() {
    setSending(true); setError(null);
    try { await sendVaultReauthEmailCode(); setSent(true); }
    catch { setError("Couldn't send the email code — try again."); }
    finally { setSending(false); }
  }

  async function submit() {
    if (verifying || pin.length !== 4 || !emailCode.trim()) return;
    if (!captcha.check()) return;
    setVerifying(true); setError(null);
    try {
      await verifyVaultReauthStep3(pin, emailCode.trim());
      onUnlocked();
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        setError((err.data as any)?.solution ?? "Too many attempts — try again shortly.");
      } else if (err instanceof ApiError && err.status === 401) {
        const code = (err.data as any)?.code;
        setError(code === "WRONG_EMAIL_CODE" ? "Invalid or expired email code" : "Incorrect Vault PIN");
      } else if (err instanceof ApiError && err.status === 428) {
        setError("Set a Vault PIN under Vault → Security first.");
      } else {
        setError("Couldn't verify — try again.");
      }
    } finally {
      setVerifying(false);
    }
  }

  return (
    <div className="min-h-[60vh] flex items-center justify-center page-enter">
      <div className="w-full max-w-xs space-y-6 text-center">
        <VaultAuthIcon icon={Mail} tone="primary" pulsing={sending && !sent} />
        <div className="animate-fade-up" style={{ animationDelay: "60ms" }}>
          <h1 className="text-lg font-bold font-mono uppercase tracking-tight">Vault Locked</h1>
          <p className="text-muted-foreground font-mono text-xs mt-1">
            {sending && !sent ? "Sending a code to your email…" : "Enter the code we emailed you plus your Vault PIN"}
          </p>
        </div>

        <div className="space-y-1.5 animate-fade-up" style={{ animationDelay: "110ms" }}>
          <Label className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
            Email Code
          </Label>
          <Input
            inputMode="numeric"
            placeholder="000000"
            value={emailCode}
            disabled={verifying}
            onChange={e => setEmailCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
            className="font-mono text-sm tracking-widest text-center transition-shadow focus-visible:shadow-[0_0_0_3px_var(--primary)/15]"
          />
          <button type="button" onClick={resend} disabled={sending} className="font-mono text-[10px] text-muted-foreground hover:text-primary transition-colors underline underline-offset-2">
            {sending ? "Sending…" : "Resend code"}
          </button>
        </div>

        <div className="space-y-1.5 animate-fade-up" style={{ animationDelay: "160ms" }}>
          <Label className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
            Vault PIN
          </Label>
          <PinInput length={4} value={pin} onChange={setPin} disabled={verifying} error={!!error} />
        </div>

        <div className="animate-fade-up" style={{ animationDelay: "200ms" }}>
          <CaptchaField challenge={captcha.challenge} value={captcha.input} onChange={captcha.setInput} error={captcha.error} disabled={verifying} />
        </div>

        {error && (
          <p className="text-destructive font-mono text-xs flex items-center justify-center gap-1.5 animate-shake">
            <AlertCircle className="w-3.5 h-3.5" /> {error}
          </p>
        )}

        <Button
          size="sm"
          className="font-mono text-xs uppercase tracking-wider transition-transform hover:scale-[1.03] active:scale-95 animate-fade-up"
          style={{ animationDelay: "240ms" }}
          disabled={pin.length !== 4 || !emailCode.trim() || !captcha.input || verifying}
          onClick={submit}
        >
          {verifying ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <><Lock className="w-3.5 h-3.5 mr-1.5" /> Unlock</>}
        </Button>

        <button
          type="button"
          onClick={onBack}
          className="block mx-auto font-mono text-[10px] text-muted-foreground hover:text-primary transition-colors underline underline-offset-2 animate-fade-up"
          style={{ animationDelay: "280ms" }}
        >
          {hasPasskey ? "Use passkey instead" : "Back"}
        </button>
      </div>
    </div>
  );
}
