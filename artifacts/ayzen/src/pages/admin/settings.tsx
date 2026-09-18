import { useState, useEffect } from "react";
import { useGetSettings } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Settings as SettingsIcon, Mail, Send, CheckCircle2, Eye, EyeOff, Loader2, AlertTriangle, Globe, Info, Wallet } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";

export default function AdminSettings() {
  const { data: settings, isLoading, refetch } = useGetSettings();
  const { toast } = useToast();
  const token = localStorage.getItem("ayzen_token") || "";

  const [smtpForm, setSmtpForm] = useState({ smtpHost: "", smtpPort: "587", smtpUser: "", smtpPassword: "", smtpFrom: "" });
  const [showPass, setShowPass] = useState(false);
  const [testEmail, setTestEmail] = useState("");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [customDomain, setCustomDomain] = useState("");
  const [savingDomain, setSavingDomain] = useState(false);
  const [payForm, setPayForm] = useState({ bkashNumber: "", nagadNumber: "", usdtAddress: "", usdtNetwork: "TRC20" });
  const [savingPay, setSavingPay] = useState(false);

  useEffect(() => {
    if (settings) {
      setSmtpForm({
        smtpHost: settings.smtpHost ?? "",
        smtpPort: String(settings.smtpPort ?? 587),
        smtpUser: settings.smtpUser ?? "",
        smtpPassword: "",
        smtpFrom: (settings as any).smtpFrom ?? "",
      });
      setCustomDomain((settings as any).customDomain ?? "");
      setPayForm({
        bkashNumber: (settings as any).bkashNumber ?? "",
        nagadNumber: (settings as any).nagadNumber ?? "",
        usdtAddress: (settings as any).usdtAddress ?? "",
        usdtNetwork: (settings as any).usdtNetwork ?? "TRC20",
      });
    }
  }, [settings]);

  const savePaymentConfig = async () => {
    setSavingPay(true);
    try {
      const res = await fetch(`${BASE}/api/settings`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(payForm),
      });
      if (res.ok) { toast({ title: "Payment methods saved" }); refetch(); }
      else toast({ variant: "destructive", title: "Failed to save payment methods" });
    } finally { setSavingPay(false); }
  };

  const saveDomain = async () => {
    setSavingDomain(true);
    try {
      const res = await fetch(`${BASE}/api/settings`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ customDomain }),
      });
      if (res.ok) { toast({ title: "Domain saved" }); refetch(); }
      else toast({ variant: "destructive", title: "Failed to save domain" });
    } finally { setSavingDomain(false); }
  };

  const saveSmtp = async () => {
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        smtpHost: smtpForm.smtpHost,
        smtpPort: parseInt(smtpForm.smtpPort, 10),
        smtpUser: smtpForm.smtpUser,
        smtpFrom: smtpForm.smtpFrom,
      };
      if (smtpForm.smtpPassword) body.smtpPassword = smtpForm.smtpPassword;

      const res = await fetch(`${BASE}/api/settings`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        toast({ title: "SMTP settings saved" });
        refetch();
        setSmtpForm(f => ({ ...f, smtpPassword: "" }));
      } else {
        toast({ variant: "destructive", title: "Failed to save settings" });
      }
    } finally { setSaving(false); }
  };

  const sendTest = async () => {
    if (!testEmail) { toast({ variant: "destructive", title: "Enter a test email address" }); return; }
    setTesting(true);
    try {
      const res = await fetch(`${BASE}/api/settings/email/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ to: testEmail }),
      });
      const data = await res.json();
      if (res.ok) toast({ title: "Test email sent!", description: `Check ${testEmail} for the AYZEN test message.` });
      else toast({ variant: "destructive", title: data.error || "Failed to send" });
    } finally { setTesting(false); }
  };

  if (isLoading) return (
    <div className="space-y-6">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-64 w-full" />
    </div>
  );

  const smtpConfigured = !!(settings?.smtpHost && settings?.smtpUser);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold font-mono tracking-tighter uppercase">System Configuration</h1>
        <p className="text-muted-foreground font-mono text-xs mt-1">Platform settings and external integrations</p>
      </div>

      {/* Platform Info */}
      <Card className="bg-card border-card-border shadow-none">
        <CardHeader>
          <CardTitle className="font-mono uppercase text-xs flex items-center gap-2">
            <SettingsIcon className="h-4 w-4 text-primary" /> Core Parameters
          </CardTitle>
        </CardHeader>
        <CardContent className="font-mono text-sm space-y-3">
          {[
            { label: "Platform Name", value: settings?.platformName || "AYZEN" },
            { label: "Primary Accent", value: settings?.primaryColor || "#06b6d4" },
            { label: "2FA Issuer", value: settings?.twoFaIssuerName || "AYZEN" },
            { label: "Telegram Bot", value: settings?.telegramBotUsername || "Not configured" },
          ].map(({ label, value }) => (
            <div key={label} className="flex justify-between items-center border-b border-card-border pb-2 last:border-0 last:pb-0">
              <span className="text-muted-foreground text-xs">{label}</span>
              <span className="text-xs font-medium">{value}</span>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Custom Domain */}
      <Card className="bg-card border-card-border shadow-none">
        <CardHeader>
          <CardTitle className="font-mono uppercase text-xs flex items-center gap-2">
            <Globe className="h-4 w-4 text-primary" /> Custom Domain
            {customDomain
              ? <Badge className="ml-auto text-[9px] bg-green-500/20 text-green-400 border-green-500/30 font-mono">SET</Badge>
              : <Badge variant="secondary" className="ml-auto text-[9px] font-mono">NOT SET</Badge>
            }
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Branded Domain</Label>
            <Input
              value={customDomain}
              onChange={e => setCustomDomain(e.target.value)}
              className="font-mono text-xs h-10 bg-input border-border"
              placeholder="app.yourbrand.com"
            />
          </div>
          <div className="bg-primary/5 border border-primary/15 rounded-md p-3 flex gap-2">
            <Info className="w-3.5 h-3.5 text-primary flex-shrink-0 mt-0.5" />
            <p className="text-[10px] font-mono text-muted-foreground leading-relaxed">
              This value is used for display/branding (emails, shared links) only. To actually point a real domain
              at AYZEN, add it under Replit's <span className="text-primary">Deployments → Settings → Domains</span> panel
              and configure the DNS records shown there — domain binding happens at the deployment layer, not here.
            </p>
          </div>
          <Button onClick={saveDomain} disabled={savingDomain} className="font-mono text-xs gap-2">
            {savingDomain ? <Loader2 className="w-3 h-3 animate-spin" /> : <Globe className="w-3 h-3" />}
            {savingDomain ? "Saving..." : "Save Domain"}
          </Button>
        </CardContent>
      </Card>

      {/* Admin Payment Methods */}
      <Card className="bg-card border-card-border shadow-none">
        <CardHeader>
          <CardTitle className="font-mono uppercase text-xs flex items-center gap-2">
            <Wallet className="h-4 w-4 text-primary" /> Payment Methods (AZN Credit Purchases)
            {payForm.bkashNumber || payForm.nagadNumber || payForm.usdtAddress
              ? <Badge className="ml-auto text-[9px] bg-green-500/20 text-green-400 border-green-500/30 font-mono">CONFIGURED</Badge>
              : <Badge variant="secondary" className="ml-auto text-[9px] font-mono">NOT SET</Badge>
            }
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="bg-primary/5 border border-primary/15 rounded-md p-3 flex gap-2">
            <Info className="w-3.5 h-3.5 text-primary flex-shrink-0 mt-0.5" />
            <p className="text-[10px] font-mono text-muted-foreground leading-relaxed">
              These are the destinations shown to users when they buy AZN credits directly from the platform.
              Users send payment here, then submit the transaction reference for you to confirm on the Credits admin page.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">bKash Number</Label>
              <Input value={payForm.bkashNumber} onChange={e => setPayForm(f => ({ ...f, bkashNumber: e.target.value }))} className="font-mono text-xs h-10 bg-input border-border" placeholder="01XXXXXXXXX" />
            </div>
            <div className="space-y-1.5">
              <Label className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Nagad Number</Label>
              <Input value={payForm.nagadNumber} onChange={e => setPayForm(f => ({ ...f, nagadNumber: e.target.value }))} className="font-mono text-xs h-10 bg-input border-border" placeholder="01XXXXXXXXX" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">USDT Address</Label>
              <Input value={payForm.usdtAddress} onChange={e => setPayForm(f => ({ ...f, usdtAddress: e.target.value }))} className="font-mono text-xs h-10 bg-input border-border" placeholder="T..." />
            </div>
            <div className="space-y-1.5">
              <Label className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">USDT Network</Label>
              <Input value={payForm.usdtNetwork} onChange={e => setPayForm(f => ({ ...f, usdtNetwork: e.target.value }))} className="font-mono text-xs h-10 bg-input border-border" placeholder="TRC20" />
            </div>
          </div>
          <Button onClick={savePaymentConfig} disabled={savingPay} className="font-mono text-xs gap-2">
            {savingPay ? <Loader2 className="w-3 h-3 animate-spin" /> : <Wallet className="w-3 h-3" />}
            {savingPay ? "Saving..." : "Save Payment Methods"}
          </Button>
        </CardContent>
      </Card>

      {/* SMTP Config */}
      <Card className="bg-card border-card-border shadow-none">
        <CardHeader>
          <CardTitle className="font-mono uppercase text-xs flex items-center gap-2">
            <Mail className="h-4 w-4 text-primary" /> SMTP Email Configuration
            {smtpConfigured
              ? <Badge className="ml-auto text-[9px] bg-green-500/20 text-green-400 border-green-500/30 font-mono">CONFIGURED</Badge>
              : <Badge variant="secondary" className="ml-auto text-[9px] font-mono">NOT SET</Badge>
            }
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">SMTP Host</Label>
              <Input value={smtpForm.smtpHost} onChange={e => setSmtpForm(f => ({ ...f, smtpHost: e.target.value }))} className="font-mono text-xs h-10 bg-input border-border" placeholder="smtp.gmail.com" />
            </div>
            <div className="space-y-1.5">
              <Label className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Port</Label>
              <Input value={smtpForm.smtpPort} onChange={e => setSmtpForm(f => ({ ...f, smtpPort: e.target.value }))} className="font-mono text-xs h-10 bg-input border-border" placeholder="587" />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">SMTP Username / Email</Label>
            <Input type="email" value={smtpForm.smtpUser} onChange={e => setSmtpForm(f => ({ ...f, smtpUser: e.target.value }))} className="font-mono text-xs h-10 bg-input border-border" placeholder="noreply@yourdomain.com" />
          </div>
          <div className="space-y-1.5">
            <Label className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Password / App Password</Label>
            <div className="relative">
              <Input
                type={showPass ? "text" : "password"}
                value={smtpForm.smtpPassword}
                onChange={e => setSmtpForm(f => ({ ...f, smtpPassword: e.target.value }))}
                className="font-mono text-xs h-10 bg-input border-border pr-10"
                placeholder={smtpConfigured ? "Leave blank to keep current" : "App password or SMTP password"}
              />
              <button onClick={() => setShowPass(s => !s)} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                {showPass ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">From Address <span className="text-muted-foreground/50">(optional)</span></Label>
            <Input type="email" value={smtpForm.smtpFrom} onChange={e => setSmtpForm(f => ({ ...f, smtpFrom: e.target.value }))} className="font-mono text-xs h-10 bg-input border-border" placeholder="AYZEN <noreply@yourdomain.com>" />
          </div>

          <div className="bg-muted/20 border border-border rounded-md p-3 text-[10px] font-mono text-muted-foreground space-y-1">
            <div className="text-primary font-bold uppercase tracking-widest mb-2">Gmail Setup Guide</div>
            <div>1. Go to Google Account → Security → 2-Step Verification</div>
            <div>2. Scroll to "App passwords" → Generate for "Mail"</div>
            <div>3. Use smtp.gmail.com · Port 587 · your@gmail.com · App Password</div>
          </div>

          <Button onClick={saveSmtp} disabled={saving} className="font-mono text-xs gap-2">
            {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <SettingsIcon className="w-3 h-3" />}
            {saving ? "Saving..." : "Save SMTP Config"}
          </Button>
        </CardContent>
      </Card>

      {/* Email Test */}
      <Card className="bg-card border-card-border shadow-none">
        <CardHeader>
          <CardTitle className="font-mono uppercase text-xs flex items-center gap-2">
            <Send className="h-4 w-4 text-primary" /> Send Test Email
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {!smtpConfigured && (
              <div className="bg-yellow-500/10 border border-yellow-500/20 rounded-md px-3 py-2 flex items-center gap-2">
                <AlertTriangle className="w-3.5 h-3.5 text-yellow-400 flex-shrink-0" />
                <p className="text-[10px] font-mono text-yellow-400">Configure SMTP settings above before sending a test email.</p>
              </div>
            )}
            {smtpConfigured && (
              <div className="bg-primary/5 border border-primary/15 rounded-md px-3 py-2 flex items-center gap-2">
                <CheckCircle2 className="w-3.5 h-3.5 text-primary flex-shrink-0" />
                <p className="text-[10px] font-mono text-primary">Ready — will send via {settings?.smtpHost}</p>
              </div>
            )}
            <div className="flex gap-3">
              <Input
                type="email"
                value={testEmail}
                onChange={e => setTestEmail(e.target.value)}
                className="font-mono text-xs h-10 bg-input border-border flex-1"
                placeholder="your@email.com"
                onKeyDown={e => e.key === "Enter" && sendTest()}
              />
              <Button onClick={sendTest} disabled={testing || !smtpConfigured} className="font-mono text-xs gap-2 flex-shrink-0">
                {testing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
                {testing ? "Sending..." : "Send Test"}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
