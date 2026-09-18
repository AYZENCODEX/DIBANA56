import { useState } from "react";
import { Link, useLocation } from "wouter";
import { Terminal, Mail, KeyRound, Eye, EyeOff, ArrowRight, Loader2, CheckCircle, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import { SuccessAnimation } from "@/components/success-animation";

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";

type Step = "email" | "code" | "password" | "done";

export default function ForgotPassword() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const { login: setAuthContext } = useAuth();

  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPass, setShowPass] = useState(false);
  const [loading, setLoading] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [showSuccess, setShowSuccess] = useState(false);
  const [demoCode, setDemoCode] = useState<string | null>(null);

  const startCountdown = () => {
    setCountdown(60);
    const interval = setInterval(() => {
      setCountdown(c => {
        if (c <= 1) { clearInterval(interval); return 0; }
        return c - 1;
      });
    }, 1000);
  };

  const handleSendCode = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const res = await fetch(`${BASE}/api/auth/forgot-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = await res.json();
      if (res.ok) {
        if (data._demo_code) {
          setDemoCode(data._demo_code);
          toast({ title: "Demo mode", description: "Email not configured — code shown below for testing." });
        } else {
          toast({ title: "Code sent!", description: `Check ${email} for your reset code.` });
        }
        setStep("code");
        startCountdown();
      } else {
        toast({ variant: "destructive", title: data.error ?? "Failed to send code" });
      }
    } catch {
      toast({ variant: "destructive", title: "Connection error" });
    }
    setLoading(false);
  };

  const handleVerifyCode = (e: React.FormEvent) => {
    e.preventDefault();
    if (code.length !== 6) {
      toast({ variant: "destructive", title: "Enter the 6-digit code" });
      return;
    }
    setStep("password");
  };

  const handleResetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newPassword !== confirmPassword) {
      toast({ variant: "destructive", title: "Passwords don't match" });
      return;
    }
    if (newPassword.length < 6) {
      toast({ variant: "destructive", title: "Password must be at least 6 characters" });
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`${BASE}/api/auth/reset-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, code, newPassword }),
      });
      const data = await res.json();
      if (res.ok) {
        setShowSuccess(true);
        if (data.token && data.user) {
          setAuthContext(data.user, data.token);
        }
        setTimeout(() => {
          setLocation(data.user?.role === "admin" ? "/admin/dashboard" : "/dashboard");
        }, 2000);
      } else {
        toast({ variant: "destructive", title: data.error ?? "Reset failed" });
        if (data.error?.includes("code")) setStep("code");
      }
    } catch {
      toast({ variant: "destructive", title: "Connection error" });
    }
    setLoading(false);
  };

  const handleResend = async () => {
    if (countdown > 0) return;
    setLoading(true);
    try {
      await fetch(`${BASE}/api/auth/forgot-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      toast({ title: "Code resent!", description: `New code sent to ${email}` });
      startCountdown();
    } catch {}
    setLoading(false);
  };

  const steps: Step[] = ["email", "code", "password"];
  const stepIdx = steps.indexOf(step === "done" ? "password" : step);

  return (
    <div className="min-h-screen w-full bg-background flex flex-col items-center justify-center p-4 relative overflow-hidden">
      <div className="absolute inset-0 z-0 opacity-[0.02]"
        style={{ backgroundImage: "linear-gradient(to right, #808080 1px, transparent 1px), linear-gradient(to bottom, #808080 1px, transparent 1px)", backgroundSize: "40px 40px" }} />

      <SuccessAnimation
        show={showSuccess}
        message="Password Reset!"
        subMessage="Logging you in..."
        type="success"
      />

      <div className="w-full max-w-md space-y-8 relative z-10">
        <div className="text-center">
          <div className="flex justify-center mb-6">
            <div className="w-16 h-16 bg-red-500/10 rounded-xl flex items-center justify-center border border-red-500/20 shadow-[0_0_15px_rgba(239,68,68,0.1)]">
              <KeyRound className="w-8 h-8 text-red-400" />
            </div>
          </div>
          <h1 className="text-3xl font-mono font-bold tracking-tighter text-foreground mb-2">Reset Password</h1>
          <p className="text-muted-foreground font-mono text-xs uppercase tracking-widest">AYZEN Account Recovery</p>
        </div>

        <div className="bg-card border border-card-border p-8 shadow-2xl relative">
          <div className="absolute top-0 left-0 w-full h-[1px] bg-gradient-to-r from-transparent via-red-500 to-transparent opacity-40" />

          {/* Step indicators */}
          <div className="flex items-center gap-2 mb-6">
            {["Email", "Code", "Password"].map((label, i) => (
              <div key={i} className="flex items-center gap-2 flex-1">
                <div className={`flex items-center justify-center w-6 h-6 rounded-full text-[10px] font-mono font-bold border flex-shrink-0 ${i <= stepIdx ? "bg-primary text-black border-primary" : "border-border text-muted-foreground"}`}>
                  {i < stepIdx ? "✓" : i + 1}
                </div>
                <span className={`font-mono text-[10px] uppercase tracking-wider ${i === stepIdx ? "text-foreground" : "text-muted-foreground/40"}`}>{label}</span>
                {i < 2 && <div className="flex-1 h-px bg-border ml-1" />}
              </div>
            ))}
          </div>

          {step === "email" && (
            <form onSubmit={handleSendCode} className="space-y-5">
              <div className="space-y-2">
                <Label className="font-mono text-xs uppercase tracking-wider text-muted-foreground">Registered Email</Label>
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <Input type="email" placeholder="operator@command.io" value={email} onChange={e => setEmail(e.target.value)}
                    className="bg-input border-border font-mono h-12 pl-9 focus-visible:ring-primary/50 focus-visible:border-primary" required autoFocus />
                </div>
                <p className="text-[10px] font-mono text-muted-foreground/60">We'll send a 6-digit reset code to this email.</p>
              </div>
              <Button type="submit" disabled={loading} className="w-full h-12 font-mono font-bold uppercase tracking-widest">
                {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <span className="flex items-center gap-2"><Mail className="w-4 h-4" /> Send Reset Code</span>}
              </Button>
            </form>
          )}

          {step === "code" && (
            <form onSubmit={handleVerifyCode} className="space-y-5">
              <div className="bg-primary/5 border border-primary/20 rounded-lg p-4 text-center">
                <p className="font-mono text-xs text-muted-foreground">Code sent to</p>
                <p className="font-mono text-sm text-foreground font-bold">{email}</p>
              </div>
              {demoCode && (
                <div className="bg-amber-400/10 border border-amber-400/30 rounded-lg p-3 flex items-center justify-between gap-3">
                  <div>
                    <p className="font-mono text-[10px] text-amber-400/80 uppercase tracking-wider mb-0.5">Demo Code (email not configured)</p>
                    <p className="font-mono text-xl font-bold tracking-[0.3em] text-amber-400">{demoCode}</p>
                  </div>
                  <button type="button" onClick={() => setCode(demoCode)} className="font-mono text-[10px] text-amber-400 border border-amber-400/30 rounded px-2 py-1 hover:bg-amber-400/10 transition-colors">
                    Use
                  </button>
                </div>
              )}
              <div className="space-y-2">
                <Label className="font-mono text-xs uppercase tracking-wider text-muted-foreground">6-Digit Code</Label>
                <Input
                  type="text"
                  inputMode="numeric"
                  placeholder="000000"
                  maxLength={6}
                  value={code}
                  onChange={e => setCode(e.target.value.replace(/\D/g, ""))}
                  className="bg-input border-border font-mono h-14 text-center text-2xl tracking-[0.5em]"
                  required autoFocus
                />
              </div>
              <Button type="submit" disabled={code.length !== 6} className="w-full h-12 font-mono font-bold uppercase tracking-widest">
                <span className="flex items-center gap-2">Verify Code <ArrowRight className="w-4 h-4" /></span>
              </Button>
              <div className="flex justify-between items-center pt-1">
                <button type="button" onClick={() => setStep("email")} className="font-mono text-xs text-muted-foreground hover:text-foreground underline">← Change email</button>
                <button type="button" onClick={handleResend} disabled={countdown > 0 || loading}
                  className="font-mono text-xs text-primary disabled:opacity-40 disabled:cursor-not-allowed">
                  {countdown > 0 ? `Resend in ${countdown}s` : "Resend Code"}
                </button>
              </div>
            </form>
          )}

          {step === "password" && (
            <form onSubmit={handleResetPassword} className="space-y-5">
              <div className="space-y-2">
                <Label className="font-mono text-xs uppercase tracking-wider text-muted-foreground">New Passphrase</Label>
                <div className="relative">
                  <Input
                    type={showPass ? "text" : "password"}
                    placeholder="Min. 6 characters"
                    value={newPassword}
                    onChange={e => setNewPassword(e.target.value)}
                    className="bg-input border-border font-mono h-12 pr-10"
                    required minLength={6} autoFocus
                  />
                  <button type="button" onClick={() => setShowPass(p => !p)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                    {showPass ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>
              <div className="space-y-2">
                <Label className="font-mono text-xs uppercase tracking-wider text-muted-foreground">Confirm Passphrase</Label>
                <Input
                  type="password"
                  placeholder="Repeat your new password"
                  value={confirmPassword}
                  onChange={e => setConfirmPassword(e.target.value)}
                  className={`bg-input border-border font-mono h-12 ${confirmPassword && confirmPassword !== newPassword ? "border-red-400/50" : ""}`}
                  required
                />
                {confirmPassword && confirmPassword !== newPassword && (
                  <p className="font-mono text-[10px] text-red-400">Passwords don't match</p>
                )}
              </div>
              <Button type="submit" disabled={loading || newPassword !== confirmPassword || newPassword.length < 6}
                className="w-full h-12 font-mono font-bold uppercase tracking-widest bg-primary">
                {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <span className="flex items-center gap-2">Reset & Login <ArrowRight className="w-4 h-4" /></span>}
              </Button>
            </form>
          )}
        </div>

        <div className="text-center font-mono text-sm text-muted-foreground">
          <Link href="/login" className="text-primary hover:underline flex items-center justify-center gap-1">
            <ArrowLeft className="w-3 h-3" /> Back to Sign In
          </Link>
        </div>
      </div>
    </div>
  );
}
