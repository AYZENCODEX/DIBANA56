import { useState, useEffect } from "react";
import { Inbox, Send, Server, Wifi, Save, Trash2, Loader2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";

// Shared by pages/user/vault-mail.tsx (Mail Hub) and pages/user/vault.tsx
// (Entity Create/Edit dialog's "Email" tab) so every place that lets someone
// configure IMAP/SMTP for an address goes through the exact same UI and the
// exact same save path — POST/PUT /api/email-accounts. Moved out of
// vault-mail.tsx (rather than exported from it) so vault.tsx importing it
// doesn't defeat vault-mail's lazy-loading in App.tsx.

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";

export interface EmailAccount {
  id: number;
  label: string;
  emailAddress: string;
  provider?: string | null;
  imapHost?: string | null;
  imapPort?: number | null;
  smtpHost?: string | null;
  smtpPort?: number | null;
  username?: string | null;
  password?: string | null;
  authKey?: string | null;
  sessionPooler?: string | null;
  useSSL: boolean;
  isDefault: boolean;
}

export interface ImapSmtpFormState {
  label: string;
  provider: string;
  imapHost: string; imapPort: string;
  smtpHost: string; smtpPort: string;
  username: string; password: string; authKey: string; sessionPooler: string;
  useSSL: boolean;
}

export const PROVIDERS = [
  { id: "gmail", label: "Gmail",     imap: "imap.gmail.com",          smtp: "smtp.gmail.com",          iport: "993", sport: "587" },
  { id: "outlook", label: "Outlook / Hotmail", imap: "outlook.office365.com", smtp: "smtp.office365.com", iport: "993", sport: "587" },
  { id: "yahoo", label: "Yahoo",     imap: "imap.mail.yahoo.com",     smtp: "smtp.mail.yahoo.com",     iport: "993", sport: "587" },
  { id: "protonmail", label: "ProtonMail",imap: "127.0.0.1",          smtp: "127.0.0.1",               iport: "1143",sport: "1025" },
  { id: "icloud", label: "iCloud",    imap: "imap.mail.me.com",        smtp: "smtp.mail.me.com",        iport: "993", sport: "587" },
  { id: "zoho", label: "Zoho",      imap: "imap.zoho.com",           smtp: "smtp.zoho.com",           iport: "993", sport: "587" },
  { id: "fastmail", label: "Fastmail",  imap: "imap.fastmail.com",       smtp: "smtp.fastmail.com",       iport: "993", sport: "587" },
];

const DOMAIN_PROVIDER_MAP: Record<string, string> = {
  "gmail.com": "gmail", "googlemail.com": "gmail",
  "outlook.com": "outlook", "hotmail.com": "outlook", "live.com": "outlook",
  "msn.com": "outlook", "outlook.office365.com": "outlook",
  "yahoo.com": "yahoo", "ymail.com": "yahoo", "yahoo.co.uk": "yahoo",
  "protonmail.com": "protonmail", "proton.me": "protonmail", "pm.me": "protonmail",
  "icloud.com": "icloud", "me.com": "icloud", "mac.com": "icloud",
  "zoho.com": "zoho", "zohomail.com": "zoho",
  "fastmail.com": "fastmail", "fastmail.fm": "fastmail",
};

export function detectProviderFromEmail(email: string): typeof PROVIDERS[0] | null {
  const domain = email.split("@")[1]?.toLowerCase().trim();
  if (!domain) return null;
  const providerId = DOMAIN_PROVIDER_MAP[domain];
  return providerId ? PROVIDERS.find(p => p.id === providerId) ?? null : null;
}

function emptyForm(email?: string): ImapSmtpFormState {
  const detected = email ? detectProviderFromEmail(email) : null;
  return {
    label: email ? email.split("@")[1]?.split(".")[0] ?? email : "",
    provider: detected?.id ?? "custom",
    imapHost: detected?.imap ?? "", imapPort: detected?.iport ?? "993",
    smtpHost: detected?.smtp ?? "", smtpPort: detected?.sport ?? "587",
    username: email ?? "", password: "", authKey: "", sessionPooler: "", useSSL: true,
  };
}

function accountToForm(a: EmailAccount): ImapSmtpFormState {
  return {
    label: a.label,
    provider: a.provider ?? "custom",
    imapHost: a.imapHost ?? "", imapPort: String(a.imapPort ?? 993),
    smtpHost: a.smtpHost ?? "", smtpPort: String(a.smtpPort ?? 587),
    username: a.username ?? "", password: "", authKey: "", sessionPooler: "",
    useSSL: a.useSSL,
  };
}

// ─── IMAP/SMTP Inline Config Form ─────────────────────────────────────────────
export function ImapSmtpForm({
  emailAddress, existingAccount, token, onSaved, onDeleted, compact = false, apiBase = "/api/email-accounts",
}: {
  emailAddress: string;
  existingAccount: EmailAccount | null;
  token: string | null;
  onSaved: () => void;
  onDeleted?: () => void;
  compact?: boolean;
  // Phase 13B — team mailbox passes `/api/teams/${teamId}/email-accounts` here
  // so the exact same form/UX works for both personal Vault Mail and a
  // team's shared mailbox; defaults to the personal endpoint unchanged.
  apiBase?: string;
}) {
  const { toast } = useToast();
  const [form, setForm] = useState<ImapSmtpFormState>(() =>
    existingAccount ? accountToForm(existingAccount) : emptyForm(emailAddress)
  );
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // Tracks whether the person has manually picked a provider or edited a host
  // field, so auto-detection (below) never clobbers an intentional choice.
  const [providerTouched, setProviderTouched] = useState(!!existingAccount);

  const set = (key: keyof ImapSmtpFormState) => (e: React.ChangeEvent<HTMLInputElement>) => {
    if (key === "imapHost" || key === "smtpHost") setProviderTouched(true);
    setForm(f => ({ ...f, [key]: e.target.value }));
  };
  const quickFill = (p: typeof PROVIDERS[0]) => {
    setProviderTouched(true);
    setForm(f => ({ ...f, provider: p.id, imapHost: p.imap, imapPort: p.iport, smtpHost: p.smtp, smtpPort: p.sport }));
  };

  // As the person keeps typing a new email address (e.g. finishing "@gmail.com"),
  // auto-detect the provider and preset IMAP/SMTP — unless they've already
  // stepped in and chosen something themselves.
  useEffect(() => {
    if (existingAccount || providerTouched) return;
    const detected = detectProviderFromEmail(emailAddress);
    if (detected) {
      setForm(f => ({ ...f, provider: detected.id, imapHost: detected.imap, imapPort: detected.iport, smtpHost: detected.smtp, smtpPort: detected.sport }));
    }
  }, [emailAddress, existingAccount, providerTouched]);

  const testConnection = async () => {
    setTesting(true);
    try {
      const res = await fetch(`${BASE}${apiBase}/test-config`, {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          ...(existingAccount ? { accountId: existingAccount.id } : {}),
          emailAddress, imapHost: form.imapHost, imapPort: Number(form.imapPort),
          smtpHost: form.smtpHost, smtpPort: Number(form.smtpPort),
          username: form.username || emailAddress, password: form.password || undefined,
          authKey: form.authKey || undefined, useSSL: form.useSSL,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail ?? data.error ?? "Connection failed");
      toast({ title: "Connection verified", description: "IMAP and SMTP are ready to use." });
      return true;
    } catch (err: any) {
      toast({ variant: "destructive", title: "Connection failed", description: err?.message ?? "Check the provider settings." });
      return false;
    } finally { setTesting(false); }
  };

  const save = async () => {
    setSaving(true);
    try {
      const verified = await testConnection();
      if (!verified) return;
      const body = {
        label: form.label || emailAddress,
        emailAddress,
        provider: form.provider,
        imapHost: form.imapHost, imapPort: Number(form.imapPort),
        smtpHost: form.smtpHost, smtpPort: Number(form.smtpPort),
        username: form.username || emailAddress,
        password: form.password || undefined,
        authKey: form.authKey || undefined,
        sessionPooler: form.sessionPooler || undefined,
        useSSL: form.useSSL,
      };
      const url = existingAccount
        ? `${BASE}${apiBase}/${existingAccount.id}`
        : `${BASE}${apiBase}`;
      const method = existingAccount ? "PUT" : "POST";
      const res = await fetch(url, {
        method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(await res.text());
      toast({ title: existingAccount ? "Config updated" : "Config saved", description: `IMAP/SMTP saved for ${emailAddress}` });
      onSaved();
    } catch {
      toast({ variant: "destructive", title: "Save failed", description: "Check your settings and try again." });
    } finally { setSaving(false); }
  };

  const remove = async () => {
    if (!existingAccount) return;
    setDeleting(true);
    try {
      await fetch(`${BASE}${apiBase}/${existingAccount.id}`, {
        method: "DELETE", headers: { Authorization: `Bearer ${token}` },
      });
      toast({ title: "Config removed", description: `IMAP/SMTP removed for ${emailAddress}` });
      onDeleted?.();
    } catch {
      toast({ variant: "destructive", title: "Delete failed" });
    } finally { setDeleting(false); }
  };

  return (
    <div className={cn("space-y-3", compact ? "p-3" : "p-4")}>
      {/* Quick-fill providers */}
      <div>
        <p className="font-mono text-[9px] uppercase tracking-widest text-muted-foreground/40 mb-1.5">Quick-fill provider</p>
        <div className="flex flex-wrap gap-1.5">
          {PROVIDERS.map(p => (
            <button key={p.label} onClick={() => quickFill(p)}
              className="px-2 py-1 rounded border border-border/40 font-mono text-[9px] hover:border-primary/50 hover:text-primary transition-all text-muted-foreground/50">
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-1">
        <Label className="font-mono text-[9px] uppercase text-muted-foreground/50">Provider</Label>
        <select value={form.provider} onChange={e => { setProviderTouched(true); setForm(f => ({ ...f, provider: e.target.value })); }}
          className="w-full h-7 rounded-md border border-input bg-input px-2 font-mono text-[10px]">
          <option value="custom">Other / Custom</option>
          {PROVIDERS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
      </div>

      <div className="grid grid-cols-2 gap-3">
        {/* IMAP */}
        <div className="space-y-2 p-3 bg-muted/5 rounded-lg border border-border/20">
          <div className="flex items-center gap-1.5 mb-2">
            <Inbox className="w-3 h-3 text-violet-400" />
            <p className="font-mono text-[10px] font-bold text-violet-400 uppercase tracking-wide">IMAP</p>
          </div>
          <div className="space-y-1">
            <Label className="font-mono text-[9px] uppercase text-muted-foreground/50">Host</Label>
            <Input value={form.imapHost} onChange={set("imapHost")} placeholder="imap.gmail.com" className="font-mono text-[10px] h-7 bg-input" />
          </div>
          <div className="space-y-1">
            <Label className="font-mono text-[9px] uppercase text-muted-foreground/50">Port</Label>
            <Input value={form.imapPort} onChange={set("imapPort")} placeholder="993" type="number" className="font-mono text-[10px] h-7 bg-input" />
          </div>
        </div>
        {/* SMTP */}
        <div className="space-y-2 p-3 bg-muted/5 rounded-lg border border-border/20">
          <div className="flex items-center gap-1.5 mb-2">
            <Send className="w-3 h-3 text-emerald-400" />
            <p className="font-mono text-[10px] font-bold text-emerald-400 uppercase tracking-wide">SMTP</p>
          </div>
          <div className="space-y-1">
            <Label className="font-mono text-[9px] uppercase text-muted-foreground/50">Host</Label>
            <Input value={form.smtpHost} onChange={set("smtpHost")} placeholder="smtp.gmail.com" className="font-mono text-[10px] h-7 bg-input" />
          </div>
          <div className="space-y-1">
            <Label className="font-mono text-[9px] uppercase text-muted-foreground/50">Port</Label>
            <Input value={form.smtpPort} onChange={set("smtpPort")} placeholder="587" type="number" className="font-mono text-[10px] h-7 bg-input" />
          </div>
        </div>
      </div>

      {form.provider === "outlook" && (
        <div className="grid grid-cols-2 gap-3 p-3 rounded-lg border border-blue-400/20 bg-blue-400/5">
          <div className="space-y-1">
            <Label className="font-mono text-[9px] uppercase text-blue-300/70">Session Pooler</Label>
            <Input value={form.sessionPooler} onChange={set("sessionPooler")} placeholder="Optional pooler / tenant" className="font-mono text-[10px] h-7 bg-input" />
          </div>
          <div className="space-y-1">
            <Label className="font-mono text-[9px] uppercase text-blue-300/70">Auth Key</Label>
            <Input value={form.authKey} onChange={set("authKey")} type="password" placeholder="OAuth/app auth key" className="font-mono text-[10px] h-7 bg-input" />
          </div>
          <p className="col-span-2 text-[9px] font-mono text-muted-foreground/50">Use Outlook App Password or Auth Key when basic password authentication is disabled.</p>
        </div>
      )}

      {/* Auth */}
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label className="font-mono text-[9px] uppercase text-muted-foreground/50">Username / Email</Label>
          <Input value={form.username} onChange={set("username")} placeholder={emailAddress} className="font-mono text-[10px] h-7 bg-input" />
        </div>
        <div className="space-y-1">
          <Label className="font-mono text-[9px] uppercase text-muted-foreground/50">
            {existingAccount ? "New Password (leave blank to keep)" : "Password / App Password"}
          </Label>
          <Input value={form.password} onChange={set("password")} type="password" placeholder="••••••••" className="font-mono text-[10px] h-7 bg-input" />
        </div>
      </div>

      <div className="flex items-center gap-2 p-2 bg-muted/10 rounded-lg border border-border/20 text-[9px] font-mono text-muted-foreground/40">
        <Server className="w-3 h-3 flex-shrink-0" />
        IMAP 993 (SSL) · 143 (STARTTLS) · SMTP 465 (SSL) · 587 (TLS) · Use App Passwords for Gmail/Outlook
      </div>

      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" onClick={testConnection} disabled={testing || saving || !form.imapHost || !form.smtpHost} className="font-mono text-[10px] gap-1.5 h-7">
          {testing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Wifi className="w-3 h-3" />}
          Test Connection
        </Button>
        <Button size="sm" onClick={save} disabled={saving || testing || !form.imapHost || !form.smtpHost} className="font-mono text-[10px] gap-1.5 h-7">
          {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
          {existingAccount ? "Update" : "Save Config"}
        </Button>
        {existingAccount && onDeleted && (
          <Button size="sm" variant="ghost" onClick={remove} disabled={deleting} className="font-mono text-[10px] gap-1.5 h-7 text-red-400 hover:text-red-300 hover:bg-red-400/10">
            {deleting ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
            Remove
          </Button>
        )}
      </div>
    </div>
  );
}
