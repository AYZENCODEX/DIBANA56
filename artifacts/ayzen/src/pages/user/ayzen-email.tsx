import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { Mail, CheckCircle, AlertCircle, Loader2, Copy, Check, ExternalLink, Inbox, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";

interface EmailStatus {
  ayzenEmail: string | null;
  ayzenEmailVerified?: boolean;
  forwardTo?: string | null;
  domain: string;
  cfConfigured: boolean;
  zoneFound: boolean;
  mode?: "forward" | "native";
}

export default function AyzenEmail() {
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const [status, setStatus] = useState<EmailStatus | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [username, setUsername] = useState("");
  const [forwardTo, setForwardTo] = useState("");
  const [checking, setChecking] = useState(false);
  const [availability, setAvailability] = useState<{ available: boolean; reason?: string } | null>(null);
  const [claiming, setClaiming] = useState(false);
  const [copied, setCopied] = useState(false);
  const [claimingNative, setClaimingNative] = useState(false);

  const token = () => localStorage.getItem("ayzen_token") ?? "";

  const refreshStatus = () => {
    fetch("/api/ayzen-email/status", { headers: { Authorization: `Bearer ${token()}` } })
      .then((r) => r.json())
      .then(setStatus)
      .catch(() => setStatus(null))
      .finally(() => setLoadingStatus(false));
  };

  useEffect(() => {
    refreshStatus();
  }, []);

  const claimNativeMailbox = async () => {
    setClaimingNative(true);
    try {
      const res = await fetch("/api/ayzen-email/claim-native", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token()}` },
        body: JSON.stringify({ forwardTo: status?.forwardTo || undefined }),
      });
      const data = await res.json();
      if (res.ok) {
        toast({ title: "Native mailbox activated", description: data.message ?? `${data.ayzenEmail} now has a real inbox.` });
        refreshStatus();
      } else {
        toast({ variant: "destructive", title: "Could not switch to native mode", description: data.error ?? "Try again" });
      }
    } catch (err: any) {
      toast({ variant: "destructive", title: "Error", description: err?.message ?? "Network error" });
    }
    setClaimingNative(false);
  };

  const checkUsername = async () => {
    if (!username.trim()) return;
    setChecking(true);
    setAvailability(null);
    try {
      const res = await fetch(`/api/ayzen-email/check/${encodeURIComponent(username.trim())}`, {
        headers: { Authorization: `Bearer ${token()}` },
      });
      const data = await res.json();
      setAvailability(data);
    } catch {
      setAvailability({ available: false, reason: "Check failed" });
    }
    setChecking(false);
  };

  const claimEmail = async () => {
    if (!username.trim() || !forwardTo.trim() || !availability?.available) return;
    setClaiming(true);
    try {
      const res = await fetch("/api/ayzen-email/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token()}` },
        body: JSON.stringify({ username: username.trim(), forwardTo: forwardTo.trim() }),
      });
      const data = await res.json();
      if (res.ok) {
        toast({
          title: data.verified ? "AYZEN Email Claimed & Verified!" : "AYZEN Email Claimed — Verify to Activate",
          description: data.message ?? `${data.ayzenEmail} is now yours.`,
        });
        setStatus((s) => s ? { ...s, ayzenEmail: data.ayzenEmail, ayzenEmailVerified: data.verified, forwardTo: data.forwardTo } : s);
        setUsername("");
        setForwardTo("");
        setAvailability(null);
      } else {
        toast({ variant: "destructive", title: "Failed", description: data.error ?? "Could not claim email" });
      }
    } catch (err: any) {
      toast({ variant: "destructive", title: "Error", description: err?.message ?? "Network error" });
    }
    setClaiming(false);
  };

  const copyEmail = () => {
    if (status?.ayzenEmail) {
      navigator.clipboard.writeText(status.ayzenEmail);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  if (loadingStatus) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-6 h-6 text-primary animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h1 className="text-2xl font-bold font-mono tracking-tighter uppercase">AYZEN Email</h1>
        <p className="text-muted-foreground font-mono text-sm">Claim your personal <span className="text-primary">username@ayzen.tech</span> address</p>
      </div>

      {/* Current email */}
      {status?.ayzenEmail ? (
        <Card className="bg-card border-card-border shadow-none">
          <CardHeader className="pb-3">
            <CardTitle className={`font-mono text-sm uppercase tracking-wider flex items-center gap-2 ${status.ayzenEmailVerified ? "text-primary" : "text-yellow-400"}`}>
              {status.ayzenEmailVerified ? <CheckCircle className="w-4 h-4" /> : <AlertCircle className="w-4 h-4" />}
              {status.ayzenEmailVerified ? "Active AYZEN Address" : "AYZEN Address — Pending Verification"}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center gap-3 bg-primary/5 border border-primary/20 rounded p-4">
              <Mail className="w-5 h-5 text-primary shrink-0" />
              <span className="font-mono text-lg font-bold text-primary flex-1">{status.ayzenEmail}</span>
              <Button variant="ghost" size="icon" onClick={copyEmail} className="shrink-0">
                {copied ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4" />}
              </Button>
            </div>
            {status.ayzenEmailVerified ? (
              <div className="text-xs font-mono text-muted-foreground space-y-1">
                <p>✓ Verified with Cloudflare — mail sent to this address forwards to {status.forwardTo ?? "your inbox"}.</p>
                <p>✓ Use this address for airdrop registrations to keep your real email private.</p>
              </div>
            ) : (
              <div className="text-xs font-mono text-yellow-400/90 space-y-1">
                <p>⚠ Cloudflare sent a verification email to {status.forwardTo ?? "your forwarding address"} — mail won't forward until you click that link.</p>
                <p className="text-muted-foreground">Reopen this page after verifying to refresh the status.</p>
              </div>
            )}
          </CardContent>
        </Card>
      ) : (
        <Card className="bg-card border-card-border shadow-none">
          <CardHeader className="pb-3">
            <CardTitle className="font-mono text-sm uppercase tracking-wider flex items-center gap-2">
              <Mail className="w-4 h-4 text-primary" /> Claim Your Address
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            {/* System check */}
            <div className="grid grid-cols-2 gap-2 text-xs font-mono">
              <div className={`flex items-center gap-2 p-2 rounded border ${status?.cfConfigured ? "border-green-500/30 text-green-400" : "border-yellow-500/30 text-yellow-400"}`}>
                {status?.cfConfigured ? <CheckCircle className="w-3 h-3" /> : <AlertCircle className="w-3 h-3" />}
                Cloudflare API
              </div>
              <div className={`flex items-center gap-2 p-2 rounded border ${status?.zoneFound ? "border-green-500/30 text-green-400" : "border-yellow-500/30 text-yellow-400"}`}>
                {status?.zoneFound ? <CheckCircle className="w-3 h-3" /> : <AlertCircle className="w-3 h-3" />}
                {status?.domain ?? "ayzen.tech"} Zone
              </div>
            </div>

            <div className="space-y-2">
              <Label className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Username</Label>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Input
                    placeholder="yourname"
                    value={username}
                    onChange={(e) => { setUsername(e.target.value); setAvailability(null); }}
                    onKeyDown={(e) => e.key === "Enter" && checkUsername()}
                    className="bg-input border-border font-mono focus-visible:ring-primary/50 focus-visible:border-primary pr-28"
                  />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-mono text-muted-foreground">@ayzen.tech</span>
                </div>
                <Button variant="outline" onClick={checkUsername} disabled={checking || !username.trim()} className="font-mono text-xs">
                  {checking ? <Loader2 className="w-3 h-3 animate-spin" /> : "Check"}
                </Button>
              </div>
              {availability && (
                <div className={`flex items-center gap-2 text-xs font-mono ${availability.available ? "text-green-400" : "text-red-400"}`}>
                  {availability.available ? <CheckCircle className="w-3 h-3" /> : <AlertCircle className="w-3 h-3" />}
                  {availability.available ? `${username}@ayzen.tech is available!` : (availability.reason ?? "Username not available")}
                </div>
              )}
            </div>

            <div className="space-y-2">
              <Label className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Forward Emails To</Label>
              <Input
                type="email"
                placeholder="your.real@email.com"
                value={forwardTo}
                onChange={(e) => setForwardTo(e.target.value)}
                className="bg-input border-border font-mono focus-visible:ring-primary/50 focus-visible:border-primary"
              />
              <p className="text-[10px] font-mono text-muted-foreground">Emails sent to your AYZEN address will be forwarded here.</p>
            </div>

            <Button
              className="w-full font-mono uppercase text-xs tracking-wider"
              disabled={!availability?.available || !forwardTo.trim() || claiming}
              onClick={claimEmail}
            >
              {claiming ? <Loader2 className="w-4 h-4 animate-spin" /> : "Claim Address"}
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Native mailbox */}
      {status?.ayzenEmail && (
        <Card className="bg-card border-card-border shadow-none">
          <CardHeader className="pb-3">
            <CardTitle className="font-mono text-sm uppercase tracking-wider flex items-center gap-2 text-foreground">
              <Inbox className="w-4 h-4 text-primary" /> Mailbox Mode
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {status.mode === "native" ? (
              <>
                <div className="flex items-center gap-2 text-xs font-mono text-primary">
                  <CheckCircle className="w-3.5 h-3.5" /> Native mode — mail is stored in a real inbox on AYZEN
                </div>
                <p className="text-[11px] font-mono text-muted-foreground">
                  Mail sent to {status.ayzenEmail} lands directly in your AYZEN mailbox, not just a forward.
                  {status.forwardTo && ` A copy still relays to ${status.forwardTo}.`}
                </p>
                <Button
                  className="w-full font-mono uppercase text-xs tracking-wider gap-1.5"
                  onClick={() => navigate("/mailbox")}
                >
                  Open Mailbox <ArrowRight className="w-3.5 h-3.5" />
                </Button>
              </>
            ) : (
              <>
                <p className="text-[11px] font-mono text-muted-foreground">
                  Right now mail only forwards to {status.forwardTo ?? "your inbox"}. Switch to native mode to get a
                  real, searchable inbox stored on AYZEN — nothing about your forward-to address changes.
                </p>
                <Button
                  className="w-full font-mono uppercase text-xs tracking-wider gap-1.5"
                  disabled={claimingNative}
                  onClick={claimNativeMailbox}
                >
                  {claimingNative ? <Loader2 className="w-4 h-4 animate-spin" /> : <>Switch to Native Mailbox <ArrowRight className="w-3.5 h-3.5" /></>}
                </Button>
              </>
            )}
          </CardContent>
        </Card>
      )}

      {/* Info card */}
      <Card className="bg-card border-card-border shadow-none">
        <CardContent className="pt-4 space-y-3 text-xs font-mono text-muted-foreground">
          <h3 className="text-foreground font-bold uppercase tracking-wider text-[10px]">How It Works</h3>
          <div className="space-y-2">
            <div className="flex gap-3">
              <span className="text-primary shrink-0">01</span>
              <span>Choose a unique username to create <span className="text-foreground">username@ayzen.tech</span></span>
            </div>
            <div className="flex gap-3">
              <span className="text-primary shrink-0">02</span>
              <span>Cloudflare Email Routing forwards all incoming mail to your real inbox</span>
            </div>
            <div className="flex gap-3">
              <span className="text-primary shrink-0">03</span>
              <span>Use your AYZEN address for airdrops, Discord, and Web3 sign-ups — protect your real email</span>
            </div>
            <div className="flex gap-3">
              <span className="text-primary shrink-0">04</span>
              <span>Cloudflare emails a one-time verification link to your forwarding address — mail won't deliver until you click it</span>
            </div>
          </div>
          <a href="https://developers.cloudflare.com/email-routing/" target="_blank" rel="noopener noreferrer"
            className="flex items-center gap-1 text-primary hover:underline mt-2">
            Cloudflare Email Routing docs <ExternalLink className="w-3 h-3" />
          </a>
        </CardContent>
      </Card>
    </div>
  );
}
