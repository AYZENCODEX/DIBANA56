import { useState, useEffect } from "react";
import { Link, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Terminal, ArrowRight, Loader2, Gift, Mail, ShieldCheck } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";

type Step = "form" | "otp";

export default function Register() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();

  const [step, setStep] = useState<Step>("form");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [refCode, setRefCode] = useState("");
  const [otp, setOtp] = useState("");
  const [sendingOtp, setSendingOtp] = useState(false);
  const [registering, setRegistering] = useState(false);
  const [countdown, setCountdown] = useState(0);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const ref = params.get("ref") ?? params.get("refCode");
    if (ref) setRefCode(ref.toUpperCase().trim());
  }, []);

  useEffect(() => {
    if (countdown <= 0) return;
    const t = setTimeout(() => setCountdown(c => c - 1), 1000);
    return () => clearTimeout(t);
  }, [countdown]);

  const handleSendOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !email.trim() || !password.trim()) {
      toast({ variant: "destructive", title: "All fields required", description: "Please fill in username, email and password." });
      return;
    }
    setSendingOtp(true);
    try {
      const res = await fetch(`${BASE}/api/auth/send-otp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = await res.json();
      if (res.ok) {
        toast({ title: "Code sent!", description: `A 6-digit code was sent to ${email}` });
        setStep("otp");
        setCountdown(60);
      } else {
        toast({ variant: "destructive", title: "Failed to send code", description: data.error ?? "Please try again." });
      }
    } catch {
      toast({ variant: "destructive", title: "Connection error", description: "Could not reach the server." });
    }
    setSendingOtp(false);
  };

  const handleResendOtp = async () => {
    if (countdown > 0) return;
    setSendingOtp(true);
    try {
      const res = await fetch(`${BASE}/api/auth/send-otp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (res.ok) {
        toast({ title: "Code resent!", description: `New code sent to ${email}` });
        setCountdown(60);
      }
    } catch {}
    setSendingOtp(false);
  };

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!otp.trim()) {
      toast({ variant: "destructive", title: "Enter verification code" });
      return;
    }
    setRegistering(true);
    try {
      const body: Record<string, string> = { username, email, password, emailOtp: otp.trim() };
      if (refCode.trim()) body.refCode = refCode.trim().toUpperCase();

      const res = await fetch(`${BASE}/api/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (res.ok) {
        toast({ title: "Account created!", description: refCode ? `Referral code ${refCode} applied!` : "You can now log in." });
        setLocation("/login");
      } else {
        toast({ variant: "destructive", title: "Registration failed", description: data.error ?? "Please check your inputs." });
        if (data.error?.includes("code")) {
          setOtp("");
        }
      }
    } catch {
      toast({ variant: "destructive", title: "Connection error" });
    }
    setRegistering(false);
  };

  return (
    <div className="min-h-screen w-full bg-background flex flex-col items-center justify-center p-4 relative overflow-hidden">
      <div className="absolute inset-0 z-0 opacity-[0.02]"
        style={{ backgroundImage: "linear-gradient(to right, #808080 1px, transparent 1px), linear-gradient(to bottom, #808080 1px, transparent 1px)", backgroundSize: "40px 40px" }} />

      <div className="w-full max-w-md space-y-8 relative z-10">
        <div className="text-center">
          <div className="flex justify-center mb-6">
            <div className="w-16 h-16 bg-primary/10 rounded-xl flex items-center justify-center border border-primary/20 shadow-[0_0_15px_rgba(0,255,255,0.1)]">
              <Terminal className="w-8 h-8 text-primary" />
            </div>
          </div>
          <h1 className="text-4xl font-mono font-bold tracking-tighter text-foreground mb-2">AYZEN</h1>
          <p className="text-muted-foreground font-mono text-sm uppercase tracking-widest">Airdrop Command Center</p>
        </div>

        <div className="bg-card border border-card-border p-8 shadow-2xl relative">
          <div className="absolute top-0 left-0 w-full h-[1px] bg-gradient-to-r from-transparent via-primary to-transparent opacity-50" />

          {/* Step indicators */}
          <div className="flex items-center gap-2 mb-6">
            <div className={`flex items-center justify-center w-6 h-6 rounded-full text-[10px] font-mono font-bold border ${step === "form" ? "bg-primary text-black border-primary" : "bg-primary/20 text-primary border-primary/40"}`}>1</div>
            <div className="flex-1 h-px bg-border" />
            <div className={`flex items-center justify-center w-6 h-6 rounded-full text-[10px] font-mono font-bold border ${step === "otp" ? "bg-primary text-black border-primary" : "border-border text-muted-foreground"}`}>2</div>
            <div className="ml-2 font-mono text-[10px] text-muted-foreground uppercase tracking-wider">
              {step === "form" ? "Fill Details" : "Verify Email"}
            </div>
          </div>

          {step === "form" ? (
            <form onSubmit={handleSendOtp} className="space-y-5">
              <div className="space-y-2">
                <Label htmlFor="username" className="font-mono text-xs uppercase tracking-wider text-muted-foreground">Alias</Label>
                <Input id="username" type="text" placeholder="hunter01" value={username} onChange={e => setUsername(e.target.value)}
                  className="bg-input border-border font-mono h-12 focus-visible:ring-primary/50 focus-visible:border-primary" required />
              </div>

              <div className="space-y-2">
                <Label htmlFor="email" className="font-mono text-xs uppercase tracking-wider text-muted-foreground">Email</Label>
                <Input id="email" type="email" placeholder="system@operator.com" value={email} onChange={e => setEmail(e.target.value)}
                  className="bg-input border-border font-mono h-12 focus-visible:ring-primary/50 focus-visible:border-primary" required />
              </div>

              <div className="space-y-2">
                <Label htmlFor="password" className="font-mono text-xs uppercase tracking-wider text-muted-foreground">Passphrase</Label>
                <Input id="password" type="password" value={password} onChange={e => setPassword(e.target.value)}
                  className="bg-input border-border font-mono h-12 focus-visible:ring-primary/50 focus-visible:border-primary" required />
              </div>

              <div className="space-y-2">
                <Label htmlFor="refCode" className="font-mono text-xs uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                  <Gift className="w-3 h-3 text-primary" /> Referral Code <span className="text-muted-foreground/40">(optional)</span>
                </Label>
                <Input id="refCode" type="text" placeholder="AYZNXXXXXX" value={refCode} onChange={e => setRefCode(e.target.value.toUpperCase())}
                  className="bg-input border-border font-mono h-10 focus-visible:ring-primary/50 focus-visible:border-primary uppercase placeholder:normal-case placeholder:text-muted-foreground" />
                {refCode && (
                  <p className="text-[10px] font-mono text-primary">✓ Referral code will be applied on registration</p>
                )}
              </div>

              <Button type="submit" className="w-full h-12 font-mono font-bold uppercase tracking-widest bg-primary text-primary-foreground hover:bg-primary/90"
                disabled={sendingOtp}>
                {sendingOtp ? <Loader2 className="w-4 h-4 animate-spin" /> : (
                  <span className="flex items-center gap-2"><Mail className="w-4 h-4" /> Send Verification Code</span>
                )}
              </Button>
            </form>
          ) : (
            <form onSubmit={handleRegister} className="space-y-5">
              <div className="bg-primary/5 border border-primary/20 rounded-lg p-4 text-center">
                <ShieldCheck className="w-8 h-8 text-primary mx-auto mb-2" />
                <p className="font-mono text-xs text-muted-foreground">Code sent to</p>
                <p className="font-mono text-sm text-foreground font-bold">{email}</p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="otp" className="font-mono text-xs uppercase tracking-wider text-muted-foreground">
                  6-Digit Verification Code
                </Label>
                <Input
                  id="otp"
                  type="text"
                  inputMode="numeric"
                  placeholder="000000"
                  maxLength={6}
                  value={otp}
                  onChange={e => setOtp(e.target.value.replace(/\D/g, ""))}
                  className="bg-input border-border font-mono h-14 text-center text-2xl tracking-[0.5em] focus-visible:ring-primary/50 focus-visible:border-primary"
                  required
                  autoFocus
                />
              </div>

              <Button type="submit" className="w-full h-12 font-mono font-bold uppercase tracking-widest bg-primary text-primary-foreground hover:bg-primary/90"
                disabled={registering || otp.length !== 6}>
                {registering ? <Loader2 className="w-4 h-4 animate-spin" /> : (
                  <span className="flex items-center gap-2">Create Account <ArrowRight className="w-4 h-4" /></span>
                )}
              </Button>

              <div className="flex items-center justify-between pt-1">
                <button type="button" onClick={() => { setStep("form"); setOtp(""); }}
                  className="font-mono text-xs text-muted-foreground hover:text-foreground underline underline-offset-2">
                  ← Change details
                </button>
                <button type="button" onClick={handleResendOtp} disabled={countdown > 0 || sendingOtp}
                  className="font-mono text-xs text-primary hover:text-primary/80 disabled:opacity-40 disabled:cursor-not-allowed">
                  {sendingOtp ? "Sending..." : countdown > 0 ? `Resend in ${countdown}s` : "Resend Code"}
                </button>
              </div>
            </form>
          )}
        </div>

        <div className="text-center text-sm text-muted-foreground font-mono">
          Already registered? <Link href="/login" className="text-primary hover:underline">Identify</Link>
        </div>
      </div>
    </div>
  );
}
