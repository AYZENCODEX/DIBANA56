import { useState, useEffect, useCallback } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import {
  Mail, Plus, Trash2, Edit3, Star, Save, X,
  ChevronDown, ChevronUp, Eye, EyeOff, Copy, Check,
  Server, Lock, Tag, Globe, Send, Inbox, Loader2,
  RefreshCw, AlertCircle, CheckCircle, Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface EmailAccount {
  id: number;
  label: string;
  emailAddress: string;
  protocol: string;
  imapHost: string | null;
  imapPort: number | null;
  smtpHost: string | null;
  smtpPort: number | null;
  username: string | null;
  password: string | null;
  useSSL: boolean;
  isDefault: boolean;
  notes: string | null;
  tags: string | null;
  createdAt: string;
}

interface InboxMessage {
  uid: number;
  seqno: number;
  flags: string[];
  date: string;
  from: string;
  to: string;
  subject: string;
  preview: string;
}

const BLANK: Omit<EmailAccount, "id" | "createdAt"> = {
  label: "", emailAddress: "", protocol: "IMAP",
  imapHost: "", imapPort: 993, smtpHost: "", smtpPort: 587,
  username: "", password: "", useSSL: true, isDefault: false,
  notes: "", tags: "",
};

const PROTOCOL_PRESETS: Record<string, Partial<typeof BLANK>> = {
  Gmail:   { imapHost: "imap.gmail.com", imapPort: 993, smtpHost: "smtp.gmail.com", smtpPort: 587, useSSL: true },
  Outlook: { imapHost: "outlook.office365.com", imapPort: 993, smtpHost: "smtp.office365.com", smtpPort: 587, useSSL: true },
  Yahoo:   { imapHost: "imap.mail.yahoo.com", imapPort: 993, smtpHost: "smtp.mail.yahoo.com", smtpPort: 465, useSSL: true },
  ProtonMail: { imapHost: "127.0.0.1", imapPort: 1143, smtpHost: "127.0.0.1", smtpPort: 1025, useSSL: false },
  iCloud:  { imapHost: "imap.mail.me.com", imapPort: 993, smtpHost: "smtp.mail.me.com", smtpPort: 587, useSSL: true },
};

export default function EmailAccountsPage() {
  const { token } = useAuth() as any;
  const { toast } = useToast();

  const [accounts, setAccounts] = useState<EmailAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [form, setForm] = useState({ ...BLANK });
  const [saving, setSaving] = useState(false);
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  const [showPw, setShowPw] = useState<Record<number, boolean>>({});
  const [copied, setCopied] = useState<number | null>(null);

  // Inbox state
  const [inboxAcc, setInboxAcc] = useState<EmailAccount | null>(null);
  const [inboxMsgs, setInboxMsgs] = useState<InboxMessage[]>([]);
  const [inboxLoading, setInboxLoading] = useState(false);
  const [inboxError, setInboxError] = useState<string | null>(null);

  // Compose state
  const [composeAcc, setComposeAcc] = useState<EmailAccount | null>(null);
  const [composeTo, setComposeTo] = useState("");
  const [composeSubject, setComposeSubject] = useState("");
  const [composeBody, setComposeBody] = useState("");
  const [sending, setSending] = useState(false);

  // Test connection state
  const [testing, setTesting] = useState<number | null>(null);

  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/email-accounts", { headers: { Authorization: `Bearer ${token}` } });
      setAccounts(await res.json());
    } catch { toast({ title: "Failed to load accounts", variant: "destructive" }); }
    finally { setLoading(false); }
  }, [token]);

  useEffect(() => { load(); }, [load]);

  const openCreate = () => { setForm({ ...BLANK }); setEditId(null); setShowForm(true); };

  const openEdit = async (id: number) => {
    const res = await fetch(`/api/email-accounts/${id}`, { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json();
    setForm({ ...BLANK, ...data });
    setEditId(id);
    setShowForm(true);
  };

  const applyPreset = (provider: string) => {
    const preset = PROTOCOL_PRESETS[provider];
    if (preset) setForm(f => ({ ...f, ...preset, label: f.label || provider }));
  };

  const save = async () => {
    if (!form.label || !form.emailAddress) {
      toast({ title: "Label and email address are required", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const method = editId ? "PUT" : "POST";
      const url = editId ? `/api/email-accounts/${editId}` : "/api/email-accounts";
      const res = await fetch(url, { method, headers, body: JSON.stringify(form) });
      if (!res.ok) throw new Error();
      toast({ title: editId ? "Account updated" : "Account added", description: form.emailAddress });
      setShowForm(false);
      await load();
    } catch { toast({ title: "Failed to save", variant: "destructive" }); }
    finally { setSaving(false); }
  };

  const remove = async (id: number, label: string) => {
    if (!confirm(`Delete "${label}"?`)) return;
    await fetch(`/api/email-accounts/${id}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
    toast({ title: "Account removed" });
    setAccounts(a => a.filter(x => x.id !== id));
  };

  const setDefault = async (id: number) => {
    await fetch(`/api/email-accounts/${id}`, { method: "PUT", headers, body: JSON.stringify({ isDefault: true }) });
    await load();
  };

  const copyEmail = (id: number, email: string) => {
    navigator.clipboard.writeText(email);
    setCopied(id);
    setTimeout(() => setCopied(null), 2000);
  };

  const toggleExpand = (id: number) => setExpanded(e => ({ ...e, [id]: !e[id] }));
  const togglePw = (id: number) => setShowPw(p => ({ ...p, [id]: !p[id] }));

  // Test SMTP connection
  const testConnection = async (acc: EmailAccount) => {
    setTesting(acc.id);
    try {
      const res = await fetch(`/api/email-accounts/${acc.id}/test`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      if (res.ok) toast({ title: "✓ Connection OK", description: `SMTP verified for ${acc.emailAddress}` });
      else toast({ variant: "destructive", title: "Connection failed", description: data.error });
    } catch { toast({ variant: "destructive", title: "Test failed", description: "Network error" }); }
    setTesting(null);
  };

  // Open inbox
  const openInbox = async (acc: EmailAccount) => {
    setInboxAcc(acc);
    setInboxMsgs([]);
    setInboxError(null);
    setInboxLoading(true);
    try {
      const res = await fetch(`/api/email-accounts/${acc.id}/inbox?limit=20`, { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      if (res.ok) setInboxMsgs(data.messages ?? []);
      else setInboxError(data.error ?? "Failed to load inbox");
    } catch { setInboxError("Network error — could not connect"); }
    setInboxLoading(false);
  };

  // Send email
  const sendEmail = async () => {
    if (!composeAcc || !composeTo || !composeSubject || !composeBody) return;
    setSending(true);
    try {
      const res = await fetch(`/api/email-accounts/${composeAcc.id}/send`, {
        method: "POST", headers,
        body: JSON.stringify({ to: composeTo, subject: composeSubject, body: composeBody }),
      });
      const data = await res.json();
      if (res.ok) {
        toast({ title: "Email sent!", description: `To: ${composeTo}` });
        setComposeAcc(null); setComposeTo(""); setComposeSubject(""); setComposeBody("");
      } else {
        toast({ variant: "destructive", title: "Send failed", description: data.error });
      }
    } catch { toast({ variant: "destructive", title: "Error", description: "Network error" }); }
    setSending(false);
  };

  const tagColors = ["border-primary/30 text-primary", "border-secondary/30 text-secondary", "border-emerald-400/30 text-emerald-400", "border-amber-400/30 text-amber-400"];

  return (
    <div className="max-w-4xl mx-auto space-y-6 page-enter">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-mono font-bold tracking-tighter uppercase flex items-center gap-2">
            <Mail className="w-6 h-6 text-primary" /> Email Manager
          </h1>
          <p className="text-muted-foreground font-mono text-sm mt-0.5">Manage, send and receive from your airdrop email accounts</p>
        </div>
        <button
          onClick={openCreate}
          className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg font-mono text-sm font-bold hover:bg-primary/90 transition-all hover-lift animate-glow-pulse"
        >
          <Plus className="w-4 h-4" /> Add Account
        </button>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: "Total Accounts", value: accounts.length, color: "text-primary" },
          { label: "Default Set", value: accounts.some(a => a.isDefault) ? "Yes" : "No", color: "text-emerald-400" },
          { label: "Providers", value: [...new Set(accounts.map(a => a.imapHost?.split(".").slice(-2).join(".") ?? "custom"))].length, color: "text-secondary" },
        ].map(s => (
          <div key={s.label} className="glass-card rounded-xl p-4 border animate-fade-up">
            <p className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest mb-1">{s.label}</p>
            <p className={cn("text-2xl font-mono font-bold", s.color)}>{s.value}</p>
          </div>
        ))}
      </div>

      {/* Account list */}
      <div className="space-y-3">
        {loading ? (
          Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="glass-card border rounded-xl p-4 animate-pulse h-16" />
          ))
        ) : accounts.length === 0 ? (
          <div className="glass-card border rounded-xl p-12 text-center">
            <Mail className="w-10 h-10 text-muted-foreground/20 mx-auto mb-3" />
            <p className="font-mono text-muted-foreground">No email accounts yet.</p>
            <p className="font-mono text-xs text-muted-foreground/50 mt-1">Add your first account to get started.</p>
          </div>
        ) : accounts.map((acc, idx) => (
          <div key={acc.id} className={cn("glass-card border rounded-xl overflow-hidden hover-glow transition-all duration-300 animate-fade-up", `delay-${(idx % 6) * 100}`)}>
            {/* Card header */}
            <div className="flex items-center gap-3 px-4 py-3">
              <div className={cn("w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0", acc.isDefault ? "bg-primary/15 border border-primary/30" : "bg-muted/30 border border-border/50")}>
                <Mail className={cn("w-4 h-4", acc.isDefault ? "text-primary" : "text-muted-foreground")} />
              </div>

              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-mono font-bold text-sm text-foreground truncate">{acc.label}</span>
                  {acc.isDefault && (
                    <span className="px-1.5 py-0.5 bg-primary/10 border border-primary/20 rounded text-[9px] font-mono text-primary uppercase tracking-wider">Default</span>
                  )}
                  {acc.tags && acc.tags.split(",").slice(0, 2).map((tag, ti) => (
                    <span key={ti} className={cn("px-1.5 py-0.5 rounded border text-[9px] font-mono", tagColors[ti % tagColors.length])}>{tag.trim()}</span>
                  ))}
                </div>
                <div className="flex items-center gap-2 mt-0.5">
                  <span className="font-mono text-xs text-muted-foreground truncate">{acc.emailAddress}</span>
                  <span className="text-muted-foreground/30">·</span>
                  <span className="font-mono text-[10px] text-muted-foreground/50">{acc.protocol}</span>
                </div>
              </div>

              <div className="flex items-center gap-1 flex-shrink-0">
                {/* Inbox */}
                <button onClick={() => openInbox(acc)} title="View Inbox"
                  className="p-1.5 text-muted-foreground hover:text-primary transition-colors rounded">
                  <Inbox className="w-3.5 h-3.5" />
                </button>
                {/* Compose */}
                <button onClick={() => { setComposeAcc(acc); setComposeTo(""); setComposeSubject(""); setComposeBody(""); }} title="Compose Email"
                  className="p-1.5 text-muted-foreground hover:text-emerald-400 transition-colors rounded">
                  <Send className="w-3.5 h-3.5" />
                </button>
                {/* Test connection */}
                <button onClick={() => testConnection(acc)} title="Test SMTP" disabled={testing === acc.id}
                  className="p-1.5 text-muted-foreground hover:text-amber-400 transition-colors rounded disabled:opacity-50">
                  {testing === acc.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5" />}
                </button>
                <button onClick={() => copyEmail(acc.id, acc.emailAddress)} className="p-1.5 text-muted-foreground hover:text-primary transition-colors rounded">
                  {copied === acc.id ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                </button>
                {!acc.isDefault && (
                  <button onClick={() => setDefault(acc.id)} className="p-1.5 text-muted-foreground hover:text-amber-400 transition-colors rounded">
                    <Star className="w-3.5 h-3.5" />
                  </button>
                )}
                <button onClick={() => openEdit(acc.id)} className="p-1.5 text-muted-foreground hover:text-primary transition-colors rounded">
                  <Edit3 className="w-3.5 h-3.5" />
                </button>
                <button onClick={() => remove(acc.id, acc.label)} className="p-1.5 text-muted-foreground hover:text-destructive transition-colors rounded">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
                <button onClick={() => toggleExpand(acc.id)} className="p-1.5 text-muted-foreground hover:text-foreground transition-colors rounded">
                  {expanded[acc.id] ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                </button>
              </div>
            </div>

            {/* Expanded detail */}
            {expanded[acc.id] && (
              <div className="border-t border-border/50 px-4 py-3 bg-muted/10 grid grid-cols-2 md:grid-cols-3 gap-3 text-xs font-mono animate-fade-up">
                {acc.imapHost && (
                  <div>
                    <p className="text-muted-foreground/50 uppercase tracking-wider mb-0.5 text-[9px]"><Server className="w-3 h-3 inline mr-1" />IMAP</p>
                    <p className="text-foreground">{acc.imapHost}:{acc.imapPort}</p>
                  </div>
                )}
                {acc.smtpHost && (
                  <div>
                    <p className="text-muted-foreground/50 uppercase tracking-wider mb-0.5 text-[9px]"><Globe className="w-3 h-3 inline mr-1" />SMTP</p>
                    <p className="text-foreground">{acc.smtpHost}:{acc.smtpPort}</p>
                  </div>
                )}
                {acc.username && (
                  <div>
                    <p className="text-muted-foreground/50 uppercase tracking-wider mb-0.5 text-[9px]">Username</p>
                    <p className="text-foreground">{acc.username}</p>
                  </div>
                )}
                <div>
                  <p className="text-muted-foreground/50 uppercase tracking-wider mb-0.5 text-[9px]"><Lock className="w-3 h-3 inline mr-1" />Password</p>
                  <div className="flex items-center gap-1">
                    <span className="text-foreground">{showPw[acc.id] ? (acc.password ?? "—") : "••••••••"}</span>
                    <button onClick={() => togglePw(acc.id)} className="text-muted-foreground/40 hover:text-muted-foreground">
                      {showPw[acc.id] ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
                    </button>
                  </div>
                </div>
                {acc.notes && (
                  <div className="col-span-2">
                    <p className="text-muted-foreground/50 uppercase tracking-wider mb-0.5 text-[9px]">Notes</p>
                    <p className="text-muted-foreground">{acc.notes}</p>
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* ── INBOX MODAL ───────────────────────────────────────────────────────── */}
      {inboxAcc && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-background/80 backdrop-blur-md animate-fade-in">
          <div className="glass-card border rounded-2xl w-full max-w-2xl max-h-[85vh] flex flex-col animate-scale-in">
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-border bg-card/90 backdrop-blur-sm rounded-t-2xl">
              <div className="flex items-center gap-2">
                <Inbox className="w-4 h-4 text-primary" />
                <h2 className="font-mono font-bold text-primary uppercase tracking-widest text-sm">Inbox</h2>
                <span className="font-mono text-xs text-muted-foreground">— {inboxAcc.emailAddress}</span>
              </div>
              <div className="flex items-center gap-2">
                <button onClick={() => openInbox(inboxAcc)} disabled={inboxLoading}
                  className="p-1.5 text-muted-foreground hover:text-primary transition-colors disabled:opacity-50">
                  <RefreshCw className={cn("w-4 h-4", inboxLoading && "animate-spin")} />
                </button>
                <button onClick={() => setInboxAcc(null)} className="text-muted-foreground hover:text-foreground transition-colors">
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Body */}
            <div className="flex-1 overflow-y-auto p-4 space-y-2">
              {inboxLoading ? (
                <div className="flex flex-col items-center justify-center py-16 gap-3">
                  <Loader2 className="w-6 h-6 text-primary animate-spin" />
                  <p className="font-mono text-xs text-muted-foreground">Connecting to {inboxAcc.imapHost}…</p>
                </div>
              ) : inboxError ? (
                <div className="flex flex-col items-center justify-center py-12 gap-3 text-center">
                  <AlertCircle className="w-8 h-8 text-destructive" />
                  <p className="font-mono text-sm text-destructive">{inboxError}</p>
                  {inboxError.includes("Gmail") || inboxError.includes("credentials") ? (
                    <p className="font-mono text-xs text-muted-foreground max-w-sm">
                      Gmail requires an <span className="text-primary">App Password</span>. Go to Google Account → Security → 2-Step Verification → App passwords.
                    </p>
                  ) : null}
                </div>
              ) : inboxMsgs.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 gap-2">
                  <Inbox className="w-8 h-8 text-muted-foreground/20" />
                  <p className="font-mono text-sm text-muted-foreground">No messages found</p>
                </div>
              ) : inboxMsgs.map((msg) => (
                <div key={msg.uid} className={cn(
                  "p-3 rounded-lg border border-border/50 hover:border-primary/30 transition-colors cursor-default",
                  msg.flags.includes("\\Seen") ? "bg-muted/5" : "bg-primary/5 border-primary/20"
                )}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        {!msg.flags.includes("\\Seen") && <span className="w-1.5 h-1.5 bg-primary rounded-full flex-shrink-0" />}
                        <p className="font-mono text-xs font-bold text-foreground truncate">{msg.subject}</p>
                      </div>
                      <p className="font-mono text-[10px] text-muted-foreground mt-0.5 truncate">From: {msg.from}</p>
                      {msg.preview && (
                        <p className="font-mono text-[10px] text-muted-foreground/60 mt-1 line-clamp-2">{msg.preview}</p>
                      )}
                    </div>
                    <p className="font-mono text-[10px] text-muted-foreground/50 flex-shrink-0 text-right">
                      {msg.date ? new Date(msg.date).toLocaleDateString() : ""}
                    </p>
                  </div>
                </div>
              ))}
            </div>

            {/* Footer */}
            <div className="px-5 py-3 border-t border-border bg-card/90 rounded-b-2xl flex items-center justify-between">
              <p className="font-mono text-[10px] text-muted-foreground">{inboxMsgs.length} message{inboxMsgs.length !== 1 ? "s" : ""} loaded</p>
              <button
                onClick={() => { setComposeAcc(inboxAcc); setInboxAcc(null); }}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-primary text-primary-foreground rounded-lg font-mono text-xs hover:bg-primary/90 transition-colors"
              >
                <Send className="w-3 h-3" /> Compose
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── COMPOSE MODAL ─────────────────────────────────────────────────────── */}
      {composeAcc && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-background/80 backdrop-blur-md animate-fade-in">
          <div className="glass-card border rounded-2xl w-full max-w-lg animate-scale-in">
            <div className="flex items-center justify-between px-5 py-4 border-b border-border bg-card/90 backdrop-blur-sm rounded-t-2xl">
              <div className="flex items-center gap-2">
                <Send className="w-4 h-4 text-emerald-400" />
                <h2 className="font-mono font-bold text-sm uppercase tracking-widest">New Email</h2>
                <span className="font-mono text-xs text-muted-foreground">from {composeAcc.emailAddress}</span>
              </div>
              <button onClick={() => setComposeAcc(null)} className="text-muted-foreground hover:text-foreground transition-colors">
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-5 space-y-4">
              <div>
                <label className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest block mb-1">To *</label>
                <input
                  type="email"
                  placeholder="recipient@example.com"
                  value={composeTo}
                  onChange={e => setComposeTo(e.target.value)}
                  className="w-full bg-input border border-border rounded-lg px-3 py-2 text-sm font-mono focus:border-primary/60 outline-none transition-colors"
                />
              </div>
              <div>
                <label className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest block mb-1">Subject *</label>
                <input
                  type="text"
                  placeholder="Email subject"
                  value={composeSubject}
                  onChange={e => setComposeSubject(e.target.value)}
                  className="w-full bg-input border border-border rounded-lg px-3 py-2 text-sm font-mono focus:border-primary/60 outline-none transition-colors"
                />
              </div>
              <div>
                <label className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest block mb-1">Message *</label>
                <textarea
                  rows={6}
                  placeholder="Write your message here…"
                  value={composeBody}
                  onChange={e => setComposeBody(e.target.value)}
                  className="w-full bg-input border border-border rounded-lg px-3 py-2 text-sm font-mono focus:border-primary/60 outline-none transition-colors resize-none"
                />
              </div>
            </div>

            <div className="flex gap-2 px-5 py-4 border-t border-border bg-card/90 rounded-b-2xl">
              <button onClick={() => setComposeAcc(null)}
                className="flex-1 py-2 border border-border rounded-lg text-sm font-mono text-muted-foreground hover:text-foreground transition-colors">
                Cancel
              </button>
              <button
                onClick={sendEmail}
                disabled={sending || !composeTo || !composeSubject || !composeBody}
                className="flex-1 flex items-center justify-center gap-2 py-2 bg-emerald-500 text-white rounded-lg text-sm font-mono font-bold hover:bg-emerald-500/90 transition-colors disabled:opacity-50"
              >
                {sending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                {sending ? "Sending…" : "Send Email"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Add / Edit Form Modal ──────────────────────────────────────────────── */}
      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-background/80 backdrop-blur-md animate-fade-in">
          <div className="glass-card border rounded-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto animate-scale-in">
            <div className="sticky top-0 flex items-center justify-between px-5 py-4 border-b border-border bg-card/90 backdrop-blur-sm rounded-t-2xl">
              <h2 className="font-mono font-bold text-primary uppercase tracking-widest text-sm">
                {editId ? "Edit Account" : "Add Email Account"}
              </h2>
              <button onClick={() => setShowForm(false)} className="text-muted-foreground hover:text-foreground transition-colors">
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-5 space-y-4">
              {/* Quick presets */}
              {!editId && (
                <div>
                  <p className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest mb-2">Quick Preset</p>
                  <div className="flex flex-wrap gap-2">
                    {Object.keys(PROTOCOL_PRESETS).map(p => (
                      <button key={p} onClick={() => applyPreset(p)}
                        className="px-2.5 py-1 border border-border rounded-lg text-xs font-mono text-muted-foreground hover:border-primary/40 hover:text-primary transition-colors">
                        {p}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {[
                { key: "label", label: "Label *", placeholder: "e.g. Airdrop Gmail #1" },
                { key: "emailAddress", label: "Email Address *", placeholder: "example@gmail.com" },
                { key: "username", label: "IMAP/SMTP Username", placeholder: "Usually same as email" },
              ].map(({ key, label, placeholder }) => (
                <div key={key}>
                  <label className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest block mb-1">{label}</label>
                  <input value={(form as any)[key] ?? ""} onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
                    placeholder={placeholder}
                    className="w-full bg-input border border-border rounded-lg px-3 py-2 text-sm font-mono focus:border-primary/60 outline-none transition-colors" />
                </div>
              ))}

              <div>
                <label className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest block mb-1">Password / App Password</label>
                <input type="password" value={form.password ?? ""} onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
                  placeholder="Gmail: use App Password (not account password)"
                  className="w-full bg-input border border-border rounded-lg px-3 py-2 text-sm font-mono focus:border-primary/60 outline-none transition-colors" />
                <p className="text-[10px] font-mono text-muted-foreground/50 mt-1">For Gmail, generate an App Password at myaccount.google.com → Security</p>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest block mb-1">IMAP Host</label>
                  <input value={form.imapHost ?? ""} onChange={e => setForm(f => ({ ...f, imapHost: e.target.value }))}
                    placeholder="imap.gmail.com"
                    className="w-full bg-input border border-border rounded-lg px-3 py-2 text-sm font-mono focus:border-primary/60 outline-none transition-colors" />
                </div>
                <div>
                  <label className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest block mb-1">IMAP Port</label>
                  <input type="number" value={form.imapPort ?? 993} onChange={e => setForm(f => ({ ...f, imapPort: parseInt(e.target.value, 10) }))}
                    className="w-full bg-input border border-border rounded-lg px-3 py-2 text-sm font-mono focus:border-primary/60 outline-none transition-colors" />
                </div>
                <div>
                  <label className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest block mb-1">SMTP Host</label>
                  <input value={form.smtpHost ?? ""} onChange={e => setForm(f => ({ ...f, smtpHost: e.target.value }))}
                    placeholder="smtp.gmail.com"
                    className="w-full bg-input border border-border rounded-lg px-3 py-2 text-sm font-mono focus:border-primary/60 outline-none transition-colors" />
                </div>
                <div>
                  <label className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest block mb-1">SMTP Port</label>
                  <input type="number" value={form.smtpPort ?? 587} onChange={e => setForm(f => ({ ...f, smtpPort: parseInt(e.target.value, 10) }))}
                    className="w-full bg-input border border-border rounded-lg px-3 py-2 text-sm font-mono focus:border-primary/60 outline-none transition-colors" />
                </div>
              </div>

              <div>
                <label className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest block mb-1"><Tag className="w-3 h-3 inline mr-1" />Tags (comma separated)</label>
                <input value={form.tags ?? ""} onChange={e => setForm(f => ({ ...f, tags: e.target.value }))}
                  placeholder="airdrop, main, defi"
                  className="w-full bg-input border border-border rounded-lg px-3 py-2 text-sm font-mono focus:border-primary/60 outline-none transition-colors" />
              </div>

              <div>
                <label className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest block mb-1">Notes</label>
                <textarea value={form.notes ?? ""} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                  rows={2} placeholder="Any additional notes…"
                  className="w-full bg-input border border-border rounded-lg px-3 py-2 text-sm font-mono focus:border-primary/60 outline-none transition-colors resize-none" />
              </div>

              <div className="flex items-center gap-3">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={form.isDefault} onChange={e => setForm(f => ({ ...f, isDefault: e.target.checked }))}
                    className="rounded border-border accent-primary" />
                  <span className="text-xs font-mono text-muted-foreground">Set as default</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={form.useSSL} onChange={e => setForm(f => ({ ...f, useSSL: e.target.checked }))}
                    className="rounded border-border accent-primary" />
                  <span className="text-xs font-mono text-muted-foreground">Use SSL/TLS</span>
                </label>
              </div>
            </div>

            <div className="sticky bottom-0 flex gap-2 px-5 py-4 border-t border-border bg-card/90 backdrop-blur-sm rounded-b-2xl">
              <button onClick={() => setShowForm(false)}
                className="flex-1 py-2 border border-border rounded-lg text-sm font-mono text-muted-foreground hover:text-foreground transition-colors">
                Cancel
              </button>
              <button onClick={save} disabled={saving}
                className="flex-1 flex items-center justify-center gap-2 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-mono font-bold hover:bg-primary/90 transition-colors disabled:opacity-50">
                <Save className="w-3.5 h-3.5" />
                {saving ? "Saving…" : editId ? "Update" : "Add Account"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
