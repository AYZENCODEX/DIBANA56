import { useState, useEffect, useCallback } from "react";
import { useParams, useLocation } from "wouter";
import { useAuth } from "@/hooks/use-auth";
import { cn } from "@/lib/utils";
import {
  Mail, Inbox, Loader2, RefreshCw, AlertCircle, ChevronLeft,
  MailOpen, Circle, Wifi, Server, Settings,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";

interface InboxMessage {
  uid: number; seqno: number; seen: boolean;
  date: string; from: string; to: string; subject: string;
}

interface EmailAccount {
  id: number;
  label: string;
  emailAddress: string;
  provider?: string | null;
  imapHost?: string | null;
  imapPort?: number | null;
  smtpHost?: string | null;
  smtpPort?: number | null;
  useSSL: boolean;
  isDefault: boolean;
}

function formatFrom(from: string) {
  const match = from.match(/"?([^"<]+)"?\s*<?([^>]*)>?/);
  return match ? { name: match[1].trim(), email: match[2].trim() } : { name: from, email: "" };
}

function formatDate(dateStr: string) {
  try { return new Date(dateStr).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }); }
  catch { return dateStr; }
}

// ─── Full-page mailbox: lists messages for one configured account ─────────────
export default function VaultMailInbox() {
  const params = useParams<{ accountId: string }>();
  const [, navigate] = useLocation();
  const { token } = useAuth();

  const [account, setAccount] = useState<EmailAccount | null>(null);
  const [accountLoading, setAccountLoading] = useState(true);
  const [messages, setMessages] = useState<InboxMessage[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const accountId = params.accountId;

  useEffect(() => {
    setAccountLoading(true);
    fetch(`${BASE}/api/email-accounts/${accountId}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.ok ? r.json() : null)
      .then(setAccount)
      .catch(() => setAccount(null))
      .finally(() => setAccountLoading(false));
  }, [accountId, token]);

  const fetchInbox = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await fetch(`${BASE}/api/email-accounts/${accountId}/fetch-inbox`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ limit: 50 }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.detail ?? data.error ?? "Failed"); return; }
      setMessages(data.messages ?? []);
      setTotal(data.total ?? 0);
      setLoaded(true);
    } catch (e: any) {
      setError(e.message ?? "Network error");
    } finally { setLoading(false); }
  }, [accountId, token]);

  // Auto-load the inbox the moment we land on the full page.
  useEffect(() => {
    if (!accountLoading && account) fetchInbox();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountLoading, account]);

  const unread = messages.filter(m => !m.seen).length;

  const goBack = () => navigate("/vault?tab=mail&view=mail");

  if (accountLoading) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <Loader2 className="w-6 h-6 text-primary animate-spin" />
      </div>
    );
  }

  if (!account) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" size="sm" onClick={goBack} className="font-mono text-xs gap-1.5">
          <ChevronLeft className="w-3.5 h-3.5" /> Back to Mail Hub
        </Button>
        <div className="text-center py-20">
          <Mail className="w-10 h-10 text-muted-foreground/20 mx-auto mb-3" />
          <p className="font-mono text-sm text-muted-foreground/60">Mail account not found</p>
        </div>
      </div>
    );
  }

  const notConfigured = !account.imapHost;

  return (
    <div className="space-y-4 page-enter">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <Button variant="ghost" size="sm" onClick={goBack} className="font-mono text-xs gap-1.5 -ml-2 mb-2">
            <ChevronLeft className="w-3.5 h-3.5" /> Back to Mail Hub
          </Button>
          <h1 className="text-xl font-bold font-mono tracking-tighter flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center flex-shrink-0">
              <Mail className="w-4 h-4 text-primary" />
            </div>
            <span className="truncate">{account.emailAddress}</span>
            {account.imapHost && (
              <span className="flex items-center gap-0.5 font-mono text-[9px] px-1.5 py-0.5 rounded bg-emerald-400/10 text-emerald-400 border border-emerald-400/20 flex-shrink-0">
                <Wifi className="w-2.5 h-2.5" /> IMAP
              </span>
            )}
          </h1>
          <p className="font-mono text-[10px] text-muted-foreground/50 mt-1 pl-0.5">
            {account.label} · {account.provider ?? "custom"}{account.imapHost ? ` · ${account.imapHost}` : ""}
          </p>
        </div>
        {!notConfigured && (
          <Button size="sm" variant="outline" onClick={fetchInbox} disabled={loading} className="font-mono text-xs gap-1.5">
            <RefreshCw className={cn("w-3.5 h-3.5", loading && "animate-spin")} />
            {loading ? "Fetching…" : "Refresh"}
          </Button>
        )}
      </div>

      {notConfigured ? (
        <div className="text-center py-20 space-y-3 bg-card border border-dashed border-border/40 rounded-xl">
          <Server className="w-8 h-8 text-muted-foreground/20 mx-auto" />
          <p className="font-mono text-sm text-muted-foreground/60">This account isn't connected yet</p>
          <Button size="sm" variant="outline" onClick={() => navigate("/vault?tab=mail&view=settings")} className="font-mono text-xs gap-1.5">
            <Settings className="w-3.5 h-3.5" /> Configure IMAP/SMTP
          </Button>
        </div>
      ) : (
        <div className="bg-card border border-card-border rounded-xl overflow-hidden">
          <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border/20">
            <Inbox className="w-3.5 h-3.5 text-violet-400" />
            <span className="font-mono text-[10px] font-bold text-violet-400 uppercase tracking-wide">Inbox</span>
            {total > 0 && <span className="font-mono text-[9px] text-muted-foreground/40">({total} total)</span>}
            {unread > 0 && <Badge className="ml-1 text-[8px] px-1 py-0 bg-red-500/15 border-red-500/30 text-red-400">{unread} unread</Badge>}
          </div>

          {error && (
            <div className="px-4 py-3 flex items-start gap-2 text-red-400 bg-red-500/5">
              <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
              <div>
                <p className="font-mono text-[10px] font-bold">Connection failed</p>
                <p className="font-mono text-[9px] text-muted-foreground/60 mt-0.5">{error}</p>
                <p className="font-mono text-[9px] text-muted-foreground/40 mt-1">Tip: Gmail requires an App Password (not your main password). Enable IMAP in Gmail Settings first.</p>
              </div>
            </div>
          )}

          {loading && (
            <div className="px-4 py-14 flex items-center justify-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin text-primary" />
              <span className="font-mono text-[10px] text-muted-foreground/50">Connecting to IMAP…</span>
            </div>
          )}

          {!loading && !error && loaded && messages.length === 0 && (
            <div className="px-4 py-14 text-center">
              <Inbox className="w-6 h-6 text-muted-foreground/20 mx-auto mb-2" />
              <p className="font-mono text-[10px] text-muted-foreground/40">No messages in this mailbox</p>
            </div>
          )}

          {!loading && messages.length > 0 && (
            <div className="divide-y divide-border/10">
              {messages.map(msg => {
                const from = formatFrom(msg.from);
                return (
                  <button
                    key={msg.uid}
                    onClick={() => navigate(`/vault/mail/${accountId}/${msg.seqno}`)}
                    className={cn("w-full flex items-start gap-3 px-4 py-3 text-left hover:bg-muted/10 transition-colors", !msg.seen && "bg-primary/3")}
                  >
                    <div className="flex-shrink-0 mt-1">
                      {msg.seen
                        ? <MailOpen className="w-3.5 h-3.5 text-muted-foreground/30" />
                        : <Circle className="w-3.5 h-3.5 text-primary fill-primary/40" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-baseline gap-2">
                        <span className={cn("font-mono text-xs truncate flex-1", msg.seen ? "text-muted-foreground/60" : "font-bold text-foreground")}>
                          {from.name || from.email || msg.from}
                        </span>
                        <span className="font-mono text-[9px] text-muted-foreground/30 flex-shrink-0">{formatDate(msg.date)}</span>
                      </div>
                      <p className={cn("font-mono text-[10px] truncate mt-0.5", msg.seen ? "text-muted-foreground/40" : "text-foreground/70")}>
                        {msg.subject}
                      </p>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
