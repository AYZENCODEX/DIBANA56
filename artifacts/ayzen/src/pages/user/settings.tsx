import { useState, useEffect, useCallback } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  Settings, Send, Link2, Unlink, RefreshCw, CheckCircle2,
  ExternalLink, Bell, ShieldCheck, ShieldAlert, Mail, Plus, Loader2, Server, Undo2,
} from "lucide-react";
import { Link } from "wouter";
import { cn } from "@/lib/utils";
import { ImapSmtpForm, type EmailAccount } from "@/components/mail/imap-smtp-form";

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";

interface TelegramStatus {
  linked: boolean;
  chatId: string | null;
  username: string | null;
}

function Section({ title, icon: Icon, children }: { title: string; icon: React.ElementType; children: React.ReactNode }) {
  return (
    <div className="bg-card border border-card-border rounded-lg overflow-hidden">
      <div className="bg-primary/5 border-b border-card-border px-5 py-4 flex items-center gap-3">
        <div className="w-8 h-8 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center">
          <Icon className="w-4 h-4 text-primary" />
        </div>
        <div className="font-mono font-bold text-sm text-foreground">{title}</div>
      </div>
      <div className="px-5 py-5">{children}</div>
    </div>
  );
}

export default function UserSettings() {
  const { token, user } = useAuth() as any;
  const { toast } = useToast();

  const [tgStatus, setTgStatus] = useState<TelegramStatus | null>(null);
  const [tgLoading, setTgLoading] = useState(true);
  const [code, setCode] = useState("");
  const [linking, setLinking] = useState(false);
  const [unlinking, setUnlinking] = useState(false);
  const [botName, setBotName] = useState<string | null>(null);

  // Phase 7: Notification Bus channel matrix — one row per app category,
  // four channel toggles each. Replaces the previous notifBroadcast/
  // notifTask toggles that used to live in this section, which rendered
  // but were never actually persisted or read by anything server-side
  // (see notification-bus.ts's opt-out default: no row here = every
  // channel on).
  type NotifCategory = "ryft" | "skarn" | "verve" | "warde" | "sylo" | "wisp" | "system";
  type ChannelFlags = { inApp: boolean; telegram: boolean; email: boolean; astra: boolean };
  const NOTIF_CATEGORY_LABELS: Record<NotifCategory, string> = {
    ryft: "Ryft (wallet + finance)", skarn: "Skarn (protocols/airdrops)", verve: "Verve (marketplace)",
    warde: "Warde (teams)", sylo: "Sylo (vault)", wisp: "Wisp (mail)", system: "System / broadcasts",
  };
  const [channelPrefs, setChannelPrefs] = useState<Record<string, ChannelFlags>>({});
  const [channelPrefsLoading, setChannelPrefsLoading] = useState(true);
  const [channelPrefSaving, setChannelPrefSaving] = useState<string | null>(null);

  // ── Vault digest frequency ── daily/weekly/monthly (scan itself runs
  // every 6h regardless — see routes/digest-settings.ts)
  const [digestFrequency, setDigestFrequency] = useState<"daily" | "weekly" | "monthly">("daily");
  const [digestSaving, setDigestSaving] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`${BASE}/api/users/me/digest`, { headers: { Authorization: `Bearer ${token}` } });
        if (res.ok) {
          const data = await res.json();
          if (data.digestFrequency) setDigestFrequency(data.digestFrequency);
        }
      } catch { }
    })();
  }, [token]);

  // Phase 7 — Notification Bus channel matrix
  useEffect(() => {
    (async () => {
      setChannelPrefsLoading(true);
      try {
        const res = await fetch(`${BASE}/api/notification-preferences`, { headers: { Authorization: `Bearer ${token}` } });
        if (res.ok) {
          const rows: Array<{ category: string } & ChannelFlags> = await res.json();
          const map: Record<string, ChannelFlags> = {};
          for (const r of rows) map[r.category] = { inApp: r.inApp, telegram: r.telegram, email: r.email, astra: r.astra };
          setChannelPrefs(map);
        }
      } catch { }
      setChannelPrefsLoading(false);
    })();
  }, [token]);

  const toggleChannel = async (category: NotifCategory, channel: keyof ChannelFlags) => {
    const current = channelPrefs[category] ?? { inApp: true, telegram: true, email: true, astra: true };
    const next = { ...current, [channel]: !current[channel] };
    setChannelPrefs(prev => ({ ...prev, [category]: next }));
    setChannelPrefSaving(category);
    try {
      const res = await fetch(`${BASE}/api/notification-preferences/${category}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(next),
      });
      if (!res.ok) {
        setChannelPrefs(prev => ({ ...prev, [category]: current }));
        toast({ variant: "destructive", title: "Failed to update notification channel" });
      }
    } catch {
      setChannelPrefs(prev => ({ ...prev, [category]: current }));
      toast({ variant: "destructive", title: "Connection error" });
    }
    setChannelPrefSaving(null);
  };

  const updateDigestFrequency = async (freq: "daily" | "weekly" | "monthly") => {
    if (freq === digestFrequency || digestSaving) return;
    setDigestSaving(true);
    const prev = digestFrequency;
    setDigestFrequency(freq);
    try {
      const res = await fetch(`${BASE}/api/users/me/digest`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ frequency: freq }),
      });
      if (!res.ok) { setDigestFrequency(prev); toast({ variant: "destructive", title: "Failed to update digest frequency" }); }
    } catch {
      setDigestFrequency(prev);
      toast({ variant: "destructive", title: "Connection error" });
    }
    setDigestSaving(false);
  };

  // ── Undo Send window ── Gmail-style 5/10/20/30s (Phase 2 — Phase 1 was a
  // single operator-set env var applied to every user; see
  // routes/mail-undo-send-settings.ts / lib/mail-send-queue.ts). Same
  // optimistic-update-then-revert-on-failure pattern as digest frequency
  // above; choices come from the server rather than being hardcoded here so
  // the two can't drift if the supported range ever changes.
  const [undoSendWindowMs, setUndoSendWindowMs] = useState<number>(8000);
  const [undoSendChoices, setUndoSendChoices] = useState<number[]>([5000, 10000, 20000, 30000]);
  const [undoSendSaving, setUndoSendSaving] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`${BASE}/api/users/me/undo-send-window`, { headers: { Authorization: `Bearer ${token}` } });
        if (res.ok) {
          const data = await res.json();
          if (data.undoSendWindowMs) setUndoSendWindowMs(data.undoSendWindowMs);
          if (Array.isArray(data.choices) && data.choices.length) setUndoSendChoices(data.choices);
        }
      } catch { }
    })();
  }, [token]);

  const updateUndoSendWindow = async (ms: number) => {
    if (ms === undoSendWindowMs || undoSendSaving) return;
    setUndoSendSaving(true);
    const prev = undoSendWindowMs;
    setUndoSendWindowMs(ms);
    try {
      const res = await fetch(`${BASE}/api/users/me/undo-send-window`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ undoSendWindowMs: ms }),
      });
      if (!res.ok) { setUndoSendWindowMs(prev); toast({ variant: "destructive", title: "Failed to update Undo Send window" }); }
    } catch {
      setUndoSendWindowMs(prev);
      toast({ variant: "destructive", title: "Connection error" });
    }
    setUndoSendSaving(false);
  };

  // ── Sending health ── Bounce + Complaint Handling (Phase 3) — the
  // account-wide counterpart to the per-recipient list below. Backed by
  // GET/POST /ayzen-email/mailbox/sending-health (see
  // lib/mail-sending-health.ts); this is also what POST /send itself
  // checks before every send.
  interface SendingHealth {
    status: "healthy" | "warning" | "paused";
    pausedAt: string | null; pausedReason: string | null;
    sentInWindow: number; bouncedInWindow: number; complainedInWindow: number;
    totalSent: number; totalBounced: number; totalComplained: number;
    bounceRateBp: number; complaintRateBp: number; windowDays: number;
    // Bounce + Complaint Handling (Phase 4)
    digestPendingBounces: number; digestPendingComplaints: number; lastDigestSentAt: string | null;
  }
  const [sendingHealth, setSendingHealth] = useState<SendingHealth | null>(null);
  const [resuming, setResuming] = useState(false);

  const loadSendingHealth = useCallback(async () => {
    try {
      const res = await fetch(`${BASE}/api/ayzen-email/mailbox/sending-health`, { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) setSendingHealth(await res.json());
    } catch { }
  }, [token]);

  useEffect(() => { loadSendingHealth(); }, [loadSendingHealth]);

  const resumeSending = async () => {
    setResuming(true);
    try {
      const res = await fetch(`${BASE}/api/ayzen-email/mailbox/sending-health/resume`, {
        method: "POST", headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (res.ok && data.resumed) {
        toast({ title: "Sending resumed" });
        loadSendingHealth();
      } else if (res.ok) {
        toast({ variant: "destructive", title: "Still paused", description: "Rates are still over the limit — clear a few problematic recipients first." });
        loadSendingHealth();
      } else {
        toast({ variant: "destructive", title: "Couldn't resume", description: "Try again" });
      }
    } catch {
      toast({ variant: "destructive", title: "Connection error" });
    }
    setResuming(false);
  };

  // ── Problematic recipients ── Bounce + Complaint Handling (Phase 2) —
  // read/manage view for the flagged ('bounced repeatedly') and blocked
  // ('spam complaint') recipient list POST /send now enforces against (see
  // routes/ayzen-mailbox.ts and lib/mail-recipient-reputation.ts). Mirrors
  // the digest-frequency/undo-send fetch-on-mount pattern above.
  interface ProblematicRecipient {
    email: string; status: "flagged" | "blocked";
    bounceCount: number; consecutiveBounces: number; complaintCount: number;
    lastBounceAt: string | null; lastComplaintAt: string | null; flaggedAt: string | null;
  }
  const [problematicRecipients, setProblematicRecipients] = useState<ProblematicRecipient[]>([]);
  const [problematicLoading, setProblematicLoading] = useState(true);
  const [clearingEmail, setClearingEmail] = useState<string | null>(null);

  const loadProblematicRecipients = useCallback(async () => {
    try {
      const res = await fetch(`${BASE}/api/ayzen-email/mailbox/problematic-recipients`, { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) {
        const data = await res.json();
        setProblematicRecipients(data.recipients ?? []);
      }
    } catch { }
    setProblematicLoading(false);
  }, [token]);

  useEffect(() => { loadProblematicRecipients(); }, [loadProblematicRecipients]);

  const clearProblematicRecipient = async (email: string) => {
    setClearingEmail(email);
    try {
      const res = await fetch(`${BASE}/api/ayzen-email/mailbox/problematic-recipients/${encodeURIComponent(email)}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        setProblematicRecipients((prev) => prev.filter((r) => r.email !== email));
        toast({ title: "Cleared", description: `${email} can receive mail again` });
      } else {
        toast({ variant: "destructive", title: "Couldn't clear", description: "Try again" });
      }
    } catch {
      toast({ variant: "destructive", title: "Connection error" });
    }
    setClearingEmail(null);
  };

  // ── Mail Accounts ── lists/adds/edits accounts via /api/email-accounts,
  // the same single source of truth the Mail Hub Overview and the Vault
  // entity/local/KYC "Email Settings" actions all read from and write to —
  // so anything added here shows up there immediately, no separate cache.
  const [mailAccounts, setMailAccounts] = useState<EmailAccount[]>([]);
  const [mailAccountsLoading, setMailAccountsLoading] = useState(true);
  const [mailDialogOpen, setMailDialogOpen] = useState(false);
  const [editingAccount, setEditingAccount] = useState<EmailAccount | null>(null);
  const [newEmail, setNewEmail] = useState("");

  const fetchMailAccounts = useCallback(async () => {
    setMailAccountsLoading(true);
    try {
      const res = await fetch(`${BASE}/api/email-accounts`, { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) setMailAccounts(await res.json());
    } catch { } finally { setMailAccountsLoading(false); }
  }, [token]);

  useEffect(() => { fetchMailAccounts(); }, [fetchMailAccounts]);

  const openAddMail = () => { setEditingAccount(null); setNewEmail(""); setMailDialogOpen(true); };
  const openEditMail = (acc: EmailAccount) => { setEditingAccount(acc); setNewEmail(acc.emailAddress); setMailDialogOpen(true); };

  const fetchTgStatus = useCallback(async () => {
    setTgLoading(true);
    try {
      const res = await fetch(`${BASE}/api/telegram/me`, { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) setTgStatus(await res.json());
    } catch { }
    setTgLoading(false);
  }, [token]);

  const fetchBotInfo = useCallback(async () => {
    try {
      const res = await fetch(`${BASE}/api/telegram/status`, { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) {
        const data = await res.json();
        if (data.online) setBotName(data.username);
      }
    } catch { }
  }, [token]);

  useEffect(() => { fetchTgStatus(); fetchBotInfo(); }, [fetchTgStatus, fetchBotInfo]);

  const handleLink = async () => {
    if (!code.trim() || code.trim().length !== 6) {
      toast({ variant: "destructive", title: "Enter the 6-digit code from the bot" });
      return;
    }
    setLinking(true);
    try {
      const res = await fetch(`${BASE}/api/telegram/connect/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ code: code.trim() }),
      });
      const data = await res.json();
      if (res.ok) {
        toast({ title: "✅ Telegram linked!", description: "Your Telegram account is now connected to AYZEN." });
        setCode("");
        await fetchTgStatus();
      } else {
        toast({ variant: "destructive", title: "Link failed", description: data.error });
      }
    } catch {
      toast({ variant: "destructive", title: "Connection error" });
    }
    setLinking(false);
  };

  const handleUnlink = async () => {
    setUnlinking(true);
    try {
      const res = await fetch(`${BASE}/api/telegram/disconnect`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        toast({ title: "Telegram disconnected" });
        await fetchTgStatus();
      }
    } catch {
      toast({ variant: "destructive", title: "Error disconnecting" });
    }
    setUnlinking(false);
  };

  const ToggleRow = ({ label, sub, value, onChange }: { label: string; sub: string; value: boolean; onChange: (v: boolean) => void }) => (
    <div className="flex items-center justify-between py-3 border-b border-card-border last:border-b-0">
      <div>
        <div className="font-mono text-xs text-foreground font-medium">{label}</div>
        <div className="font-mono text-[10px] text-muted-foreground mt-0.5">{sub}</div>
      </div>
      <button
        onClick={() => onChange(!value)}
        className={cn(
          "w-10 h-5 rounded-full transition-all duration-200 relative",
          value ? "bg-primary" : "bg-muted"
        )}
      >
        <span className={cn(
          "absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all duration-200",
          value ? "left-5" : "left-0.5"
        )} />
      </button>
    </div>
  );

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold font-mono tracking-tighter uppercase flex items-center gap-2">
          <Settings className="w-6 h-6 text-primary" /> Settings
        </h1>
        <p className="text-muted-foreground font-mono text-xs mt-1">
          Account: <span className="text-primary">{user?.username ?? "..."}</span> · {user?.email ?? ""}
        </p>
      </div>

      {/* ── Telegram Connect ── */}
      <div className="bg-card border border-card-border rounded-lg overflow-hidden">
        <div className="bg-[#229ED9]/5 border-b border-card-border px-5 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-[#229ED9]/10 border border-[#229ED9]/20 flex items-center justify-center">
              <Send className="w-4 h-4 text-[#229ED9]" />
            </div>
            <div>
              <div className="font-mono font-bold text-sm text-foreground">Telegram Bot</div>
              <div className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider">
                {botName ? <>Bot: <a href={`https://t.me/${botName}`} target="_blank" rel="noopener noreferrer" className="text-[#229ED9] hover:underline inline-flex items-center gap-0.5">@{botName} <ExternalLink className="w-2.5 h-2.5" /></a></> : "Notifications & Commands"}
              </div>
            </div>
          </div>
          {tgLoading ? (
            <div className="w-16 h-5 bg-muted/30 rounded animate-pulse" />
          ) : tgStatus?.linked ? (
            <Badge className="bg-emerald-500/10 text-emerald-400 border-emerald-500/20 font-mono text-[10px] uppercase tracking-wider">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 mr-1.5 animate-pulse inline-block" />
              Linked
            </Badge>
          ) : (
            <Badge variant="outline" className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              Not linked
            </Badge>
          )}
        </div>

        <div className="px-5 py-5 space-y-5">
          {tgStatus?.linked ? (
            <div className="space-y-4">
              <div className="bg-emerald-500/5 border border-emerald-500/15 rounded-md px-4 py-3 flex items-center gap-3">
                <CheckCircle2 className="w-5 h-5 text-emerald-400 flex-shrink-0" />
                <div>
                  <div className="font-mono text-sm text-emerald-400 font-medium">Account connected</div>
                  {tgStatus.username && (
                    <div className="font-mono text-xs text-muted-foreground mt-0.5">@{tgStatus.username}</div>
                  )}
                </div>
              </div>
              <div className="text-xs font-mono text-muted-foreground space-y-1.5">
                <div>✓ Task approvals → Telegram notification</div>
                <div>✓ Broadcast alerts from admin</div>
                <div>✓ Commands: /tasks · /done &lt;id&gt; · /mytasks · /me</div>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="font-mono text-xs border-red-500/20 text-red-400 hover:bg-red-500/10 hover:border-red-500/30 gap-2"
                onClick={handleUnlink}
                disabled={unlinking}
              >
                <Unlink className="w-3.5 h-3.5" />
                {unlinking ? "Disconnecting..." : "Disconnect Telegram"}
              </Button>
            </div>
          ) : (
            <div className="space-y-5">
              <div className="space-y-2.5">
                <p className="font-mono text-[11px] text-muted-foreground uppercase tracking-widest mb-3">How to connect</p>
                {[
                  {
                    n: "1",
                    text: botName
                      ? <>Open <a href={`https://t.me/${botName}`} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline inline-flex items-center gap-0.5 font-bold">@{botName} <ExternalLink className="w-3 h-3" /></a> on Telegram</>
                      : "Open the AYZEN bot on Telegram",
                  },
                  { n: "2", text: <>Send <span className="bg-muted px-1.5 py-0.5 rounded font-mono text-primary">/connect</span> — the bot replies with a 6-digit code</> },
                  { n: "3", text: "Paste that code below and click Link Account" },
                ].map(({ n, text }) => (
                  <div key={n} className="flex items-start gap-3">
                    <div className="w-5 h-5 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center text-[10px] font-mono font-bold text-primary flex-shrink-0 mt-0.5">{n}</div>
                    <p className="text-xs font-mono text-muted-foreground leading-relaxed">{text}</p>
                  </div>
                ))}
              </div>

              <div className="space-y-2">
                <label className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">6-Digit Code from Bot</label>
                <div className="flex gap-2">
                  <Input
                    value={code}
                    onChange={e => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                    placeholder="123456"
                    maxLength={6}
                    className="font-mono tracking-[0.4em] text-center text-lg h-11 bg-input border-border focus-visible:ring-primary/50 focus-visible:border-primary max-w-[160px]"
                    onKeyDown={e => e.key === "Enter" && handleLink()}
                  />
                  <Button
                    onClick={handleLink}
                    disabled={linking || code.length !== 6}
                    className="font-mono text-xs gap-2 h-11"
                  >
                    {linking ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Link2 className="w-3.5 h-3.5" />}
                    {linking ? "Linking..." : "Link Account"}
                  </Button>
                </div>
                <p className="text-[10px] font-mono text-muted-foreground/50">Code expires in 10 minutes</p>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── Mail Accounts ── */}
      <Section title="Mail Accounts" icon={Mail}>
        <div className="space-y-3">
          {mailAccountsLoading ? (
            <div className="flex justify-center py-6"><Loader2 className="w-4 h-4 animate-spin text-primary" /></div>
          ) : mailAccounts.length === 0 ? (
            <p className="font-mono text-xs text-muted-foreground/60 text-center py-4">No mail accounts configured yet.</p>
          ) : (
            <div className="space-y-2">
              {mailAccounts.map(acc => (
                <button
                  key={acc.id}
                  onClick={() => openEditMail(acc)}
                  className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border border-card-border hover:border-primary/40 transition-colors text-left"
                >
                  <div className="w-7 h-7 rounded-md bg-primary/10 border border-primary/20 flex items-center justify-center flex-shrink-0">
                    <Server className="w-3.5 h-3.5 text-primary" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="font-mono text-xs font-bold text-foreground truncate">{acc.label}</div>
                    <div className="font-mono text-[10px] text-muted-foreground truncate">{acc.emailAddress}</div>
                  </div>
                  {acc.isDefault && (
                    <Badge className="bg-primary/10 text-primary border-primary/20 font-mono text-[9px] uppercase tracking-wider flex-shrink-0">Default</Badge>
                  )}
                </button>
              ))}
            </div>
          )}
          <Button onClick={openAddMail} size="sm" className="font-mono text-xs gap-2">
            <Plus className="w-3.5 h-3.5" /> Add Mail Account
          </Button>
        </div>
      </Section>

      {/* ── Notification Preferences ── */}
      <Section title="Notification Channels" icon={Bell}>
        <p className="text-[10px] font-mono text-muted-foreground/40 mb-3">
          Per-app, per-channel. Astra is the browser-extension toolbar badge — install AYZEN Astra
          to receive it. A category with no changes yet defaults to every channel on.
        </p>
        {channelPrefsLoading ? (
          <div className="text-xs font-mono text-muted-foreground py-4 text-center">Loading…</div>
        ) : (
          <div className="space-y-1">
            <div className="grid grid-cols-[1fr_repeat(4,48px)] gap-2 items-center px-1 pb-2">
              <div />
              {(["inApp", "telegram", "email", "astra"] as const).map((ch) => (
                <div key={ch} className="text-center text-[9px] font-mono uppercase tracking-widest text-muted-foreground/50">
                  {ch === "inApp" ? "Bell" : ch}
                </div>
              ))}
            </div>
            {(Object.keys(NOTIF_CATEGORY_LABELS) as NotifCategory[]).map((category) => {
              const flags = channelPrefs[category] ?? { inApp: true, telegram: true, email: true, astra: true };
              return (
                <div
                  key={category}
                  className="grid grid-cols-[1fr_repeat(4,48px)] gap-2 items-center py-2.5 border-b border-card-border last:border-b-0"
                >
                  <div className="font-mono text-xs text-foreground">{NOTIF_CATEGORY_LABELS[category]}</div>
                  {(["inApp", "telegram", "email", "astra"] as const).map((channel) => (
                    <button
                      key={channel}
                      onClick={() => toggleChannel(category, channel)}
                      disabled={channelPrefSaving === category}
                      className={cn(
                        "w-8 h-4 rounded-full mx-auto transition-all duration-200 relative",
                        flags[channel] ? "bg-primary" : "bg-muted"
                      )}
                    >
                      <span className={cn(
                        "absolute top-0.5 w-3 h-3 rounded-full bg-white shadow transition-all duration-200",
                        flags[channel] ? "left-4" : "left-0.5"
                      )} />
                    </button>
                  ))}
                </div>
              );
            })}
          </div>
        )}
        <p className="text-[10px] font-mono text-muted-foreground/40 mt-3">
          Telegram and email notifications require a linked Telegram account / verified email respectively.
        </p>
      </Section>

      {/* ── Vault Digest Frequency ── */}
      <Section title="Vault Digest" icon={ShieldCheck}>
        <div className="flex items-center justify-between py-1">
          <div>
            <div className="text-sm font-mono text-foreground">Digest frequency</div>
            <div className="text-xs font-mono text-muted-foreground mt-0.5">
              The vault health scan itself runs every 6h so risk data stays fresh — this only controls
              how often you're actually pinged via Telegram + email.
            </div>
          </div>
          <div className="flex gap-1.5">
            {(["daily", "weekly", "monthly"] as const).map((freq) => (
              <button
                key={freq}
                onClick={() => updateDigestFrequency(freq)}
                disabled={digestSaving}
                className={cn(
                  "px-3 py-1.5 rounded-md border text-xs font-mono capitalize transition-colors",
                  digestFrequency === freq
                    ? "bg-primary/15 border-primary/40 text-primary"
                    : "bg-transparent border-card-border text-muted-foreground hover:border-primary/30"
                )}
              >
                {freq}
              </button>
            ))}
          </div>
        </div>
      </Section>

      {/* ── Undo Send window (Phase 2) ── */}
      <Section title="Undo Send" icon={Undo2}>
        <div className="flex items-center justify-between py-1">
          <div>
            <div className="text-sm font-mono text-foreground">Undo window</div>
            <div className="text-xs font-mono text-muted-foreground mt-0.5">
              How long you have to undo a message after hitting Send, before it actually goes out.
              Scheduled Send is unaffected — you can always cancel or reschedule it right up until it fires.
            </div>
          </div>
          <div className="flex gap-1.5">
            {undoSendChoices.map((ms) => (
              <button
                key={ms}
                onClick={() => updateUndoSendWindow(ms)}
                disabled={undoSendSaving}
                className={cn(
                  "px-3 py-1.5 rounded-md border text-xs font-mono transition-colors",
                  undoSendWindowMs === ms
                    ? "bg-primary/15 border-primary/40 text-primary"
                    : "bg-transparent border-card-border text-muted-foreground hover:border-primary/30"
                )}
              >
                {ms / 1000}s
              </button>
            ))}
          </div>
        </div>
      </Section>

      <Section title="Sending Health" icon={ShieldAlert}>
        {!sendingHealth ? (
          <div className="flex items-center gap-2 text-xs font-mono text-muted-foreground py-2">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading…
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Badge
                  variant={sendingHealth.status === "paused" ? "destructive" : sendingHealth.status === "warning" ? "warning" : "success"}
                  className="text-[9px] font-mono"
                >
                  {sendingHealth.status === "paused" ? "Paused" : sendingHealth.status === "warning" ? "Elevated" : "Healthy"}
                </Badge>
                {sendingHealth.status === "paused" && sendingHealth.pausedReason && (
                  <span className="text-[10px] font-mono text-muted-foreground/60">{sendingHealth.pausedReason}</span>
                )}
              </div>
              {sendingHealth.status === "paused" && (
                <Button size="sm" variant="outline" disabled={resuming} onClick={resumeSending} className="font-mono text-xs">
                  {resuming ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Resume sending"}
                </Button>
              )}
            </div>
            <div className="grid grid-cols-3 gap-3 text-center">
              <div className="border border-card-border rounded-md py-2">
                <div className="text-sm font-mono text-foreground">{sendingHealth.sentInWindow}</div>
                <div className="text-[9px] font-mono text-muted-foreground/60 mt-0.5">Sent (last {sendingHealth.windowDays}d)</div>
              </div>
              <div className="border border-card-border rounded-md py-2">
                <div className="text-sm font-mono text-foreground">{(sendingHealth.bounceRateBp / 100).toFixed(2)}%</div>
                <div className="text-[9px] font-mono text-muted-foreground/60 mt-0.5">Bounce rate</div>
              </div>
              <div className="border border-card-border rounded-md py-2">
                <div className="text-sm font-mono text-foreground">{(sendingHealth.complaintRateBp / 100).toFixed(2)}%</div>
                <div className="text-[9px] font-mono text-muted-foreground/60 mt-0.5">Complaint rate</div>
              </div>
            </div>
            <div className="text-[10px] font-mono text-muted-foreground/50">
              Lifetime: {sendingHealth.totalSent} sent · {sendingHealth.totalBounced} bounced · {sendingHealth.totalComplained} complaints
            </div>
            {(sendingHealth.digestPendingBounces > 0 || sendingHealth.digestPendingComplaints > 0) && (
              <div className="text-[10px] font-mono text-amber-400/70">
                Volume is high — {sendingHealth.digestPendingBounces + sendingHealth.digestPendingComplaints} notification{sendingHealth.digestPendingBounces + sendingHealth.digestPendingComplaints === 1 ? "" : "s"} batched, arriving as a summary shortly
              </div>
            )}
          </div>
        )}
      </Section>

      <Section title="Problematic Recipients" icon={ShieldAlert}>
        <div className="text-xs font-mono text-muted-foreground mb-4">
          Addresses that have bounced repeatedly (flagged) or reported one of your
          messages as spam (blocked). Sending to a flagged address asks you to
          confirm first; a blocked address can't be sent to until you clear it here.
        </div>
        {problematicLoading ? (
          <div className="flex items-center gap-2 text-xs font-mono text-muted-foreground py-2">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading…
          </div>
        ) : problematicRecipients.length === 0 ? (
          <div className="text-xs font-mono text-muted-foreground/60 py-2">No flagged or blocked recipients right now.</div>
        ) : (
          <div className="space-y-2">
            {problematicRecipients.map((r) => (
              <div key={r.email} className="flex items-center justify-between gap-3 border border-card-border rounded-md px-3 py-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-mono text-foreground truncate">{r.email}</span>
                    <Badge variant={r.status === "blocked" ? "destructive" : "warning"} className="text-[9px] font-mono">
                      {r.status === "blocked" ? "Blocked" : "Flagged"}
                    </Badge>
                  </div>
                  <div className="text-[10px] font-mono text-muted-foreground/60 mt-0.5">
                    {r.status === "blocked"
                      ? `${r.complaintCount} spam complaint${r.complaintCount === 1 ? "" : "s"}`
                      : `${r.consecutiveBounces} bounces in a row (${r.bounceCount} total)`}
                    {r.flaggedAt && ` · since ${new Date(r.flaggedAt).toLocaleDateString()}`}
                  </div>
                </div>
                <Button
                  size="sm" variant="outline"
                  disabled={clearingEmail === r.email}
                  onClick={() => clearProblematicRecipient(r.email)}
                  className="font-mono text-xs flex-shrink-0"
                >
                  {clearingEmail === r.email ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Clear"}
                </Button>
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* ── Security shortcut ── */}
      <Link href="/security">
        <div className="bg-card border border-card-border rounded-lg overflow-hidden hover:border-primary/40 transition-colors cursor-pointer">
          <div className="px-5 py-4 flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center">
              <ShieldCheck className="w-4 h-4 text-primary" />
            </div>
            <div className="flex-1">
              <div className="font-mono font-bold text-sm text-foreground">Security Center</div>
              <div className="text-[10px] font-mono text-muted-foreground">Password, 2FA, backup codes, magic codes & recovery email</div>
            </div>
            <ExternalLink className="w-4 h-4 text-muted-foreground" />
          </div>
        </div>
      </Link>

      {/* ── Add / Edit Mail Account Dialog ── */}
      <Dialog open={mailDialogOpen} onOpenChange={setMailDialogOpen}>
        <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="font-mono text-sm flex items-center gap-2">
              <Mail className="w-4 h-4 text-primary" /> {editingAccount ? "Edit Mail Account" : "Add Mail Account"}
            </DialogTitle>
          </DialogHeader>
          {!editingAccount && (
            <div className="space-y-1.5">
              <label className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Email Address</label>
              <Input
                value={newEmail}
                onChange={e => setNewEmail(e.target.value)}
                placeholder="you@example.com"
                type="email"
                className="font-mono text-xs h-9 bg-input"
              />
            </div>
          )}
          {(editingAccount || newEmail.includes("@")) && (
            <ImapSmtpForm
              emailAddress={editingAccount ? editingAccount.emailAddress : newEmail}
              existingAccount={editingAccount}
              token={token}
              onSaved={() => { fetchMailAccounts(); setMailDialogOpen(false); }}
              onDeleted={() => { fetchMailAccounts(); setMailDialogOpen(false); }}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
