/**
 * components/vault/math-captcha.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Same lightweight client-side math captcha as pages/login.tsx's inline
 * makeCaptcha — pulled out so Vault re-auth's steps 2 and 3 (see
 * components/vault/vault-auth.tsx) can use the identical pattern without
 * duplicating it. Client-side only, same as login's: a low-friction bot
 * deterrent on top of the real credential checks, not a security boundary
 * on its own — the actual PIN/password/2FA/email-code verification is what
 * the backend enforces.
 */
import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export interface CaptchaChallenge { q: string; ans: number }

export function makeCaptcha(): CaptchaChallenge {
  const a = Math.floor(Math.random() * 9) + 1;
  const b = Math.floor(Math.random() * 9) + 1;
  const ops = [
    { q: `${a} + ${b}`, ans: a + b },
    { q: `${a + b} − ${b}`, ans: a },
    { q: `${a} × ${b > 5 ? 2 : b}`, ans: a * (b > 5 ? 2 : b) },
  ];
  return ops[Math.floor(Math.random() * ops.length)];
}

export function useCaptcha() {
  const [challenge, setChallenge] = useState<CaptchaChallenge>(makeCaptcha);
  const [input, setInput] = useState("");
  const [error, setError] = useState(false);

  function reset() {
    setChallenge(makeCaptcha());
    setInput("");
    setError(false);
  }

  function check(): boolean {
    const ok = parseInt(input, 10) === challenge.ans;
    if (!ok) { setError(true); setChallenge(makeCaptcha()); setInput(""); }
    else if (error) { setError(false); }
    return ok;
  }

  return { challenge, input, setInput, error, check, reset };
}

export function CaptchaField({
  challenge, value, onChange, error, disabled,
}: {
  challenge: CaptchaChallenge;
  value: string;
  onChange: (v: string) => void;
  error?: boolean;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-1.5 text-left">
      <Label className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
        {challenge.q} = ?
      </Label>
      <Input
        inputMode="numeric"
        value={value}
        disabled={disabled}
        onChange={e => onChange(e.target.value.replace(/[^\d-]/g, ""))}
        className={`font-mono h-10 text-sm bg-input border-border ${error ? "border-red-400/50" : ""}`}
      />
      {error && <p className="font-mono text-[10px] text-red-400">Wrong answer. Try the new question.</p>}
    </div>
  );
}
