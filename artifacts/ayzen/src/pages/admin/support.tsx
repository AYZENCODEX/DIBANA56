import { useState, useEffect, useCallback, useRef } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import {
  MessageSquare, ChevronRight, CheckCircle, AlertCircle,
  Clock, Loader2, Send, ArrowLeft, User, Tag, Zap,
  BarChart3, TrendingUp,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface Ticket {
  id: number;
  userId: number;
  username: string;
  title: string;
  category: string;
  status: string;
  priority: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}
interface Message {
  id: number;
  authorId: number;
  authorRole: string;
  username: string;
  avatarUrl: string | null;
  content: string;
  createdAt: string;
}
interface Stats { total: number; open: number; inProgress: number; resolved: number }

const STATUS_STYLES: Record<string, string> = {
  open:        "border-sky-400/30 text-sky-400 bg-sky-400/5",
  in_progress: "border-amber-400/30 text-amber-400 bg-amber-400/5",
  resolved:    "border-emerald-400/30 text-emerald-400 bg-emerald-400/5",
  closed:      "border-muted-foreground/30 text-muted-foreground",
};
const PRIORITY_STYLES: Record<string, string> = {
  low: "text-muted-foreground", medium: "text-sky-400", high: "text-amber-400", urgent: "text-red-400",
};

export default function AdminSupport() {
  const { token } = useAuth() as any;
  const { toast } = useToast();
  const bottomRef = useRef<HTMLDivElement>(null);

  const [stats, setStats] = useState<Stats | null>(null);
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("all");
  const [view, setView] = useState<"list" | "thread">("list");
  const [active, setActive] = useState<(Ticket & { messages: Message[] }) | null>(null);
  const [threadLoading, setThreadLoading] = useState(false);
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);

  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [tRes, sRes] = await Promise.all([
        fetch("/api/support/tickets", { headers: { Authorization: `Bearer ${token}` } }),
        fetch("/api/support/stats", { headers: { Authorization: `Bearer ${token}` } }),
      ]);
      setTickets(await tRes.json());
      setStats(await sRes.json());
    } catch { toast({ title: "Failed to load", variant: "destructive" }); }
    finally { setLoading(false); }
  }, [token]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (view === "thread") bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [active?.messages, view]);

  const openThread = async (t: Ticket) => {
    setThreadLoading(true);
    setView("thread");
    try {
      const res = await fetch(`/api/support/tickets/${t.id}`, { headers: { Authorization: `Bearer ${token}` } });
      setActive(await res.json());
    } catch { toast({ title: "Failed to load", variant: "destructive" }); }
    finally { setThreadLoading(false); }
  };

  const updateStatus = async (id: number, status: string) => {
    await fetch(`/api/support/tickets/${id}`, { method: "PATCH", headers, body: JSON.stringify({ status }) });
    setActive(a => a ? { ...a, status } : null);
    setTickets(ts => ts.map(t => t.id === id ? { ...t, status } : t));
    toast({ title: `Ticket marked as ${status.replace("_", " ")}` });
  };

  const sendReply = async () => {
    if (!reply.trim() || !active) return;
    setSending(true);
    try {
      const res = await fetch(`/api/support/tickets/${active.id}/messages`, {
        method: "POST", headers, body: JSON.stringify({ content: reply }),
      });
      const msg = await res.json();
      setActive(a => a ? { ...a, messages: [...a.messages, msg], status: "in_progress" } : null);
      setTickets(ts => ts.map(t => t.id === active.id ? { ...t, status: "in_progress" } : t));
      setReply("");
    } catch { toast({ title: "Failed to send", variant: "destructive" }); }
    finally { setSending(false); }
  };

  const filtered = filter === "all" ? tickets : tickets.filter(t => t.status === filter);

  // ── Thread View ─────────────────────────────────────────────────────────
  if (view === "thread" && active) return (
    <div className="max-w-3xl mx-auto flex flex-col h-[calc(100vh-8rem)] page-enter">
      <div className="flex items-center gap-3 mb-4 flex-shrink-0">
        <button onClick={() => { setView("list"); setActive(null); }} className="text-muted-foreground hover:text-foreground transition-colors">
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div className="flex-1 min-w-0">
          <h2 className="font-mono font-bold text-foreground truncate">{active.title}</h2>
          <div className="flex items-center gap-2 mt-0.5">
            <User className="w-3 h-3 text-muted-foreground/40" />
            <span className="text-[10px] font-mono text-muted-foreground/60">@{(active as any).username}</span>
            <span className={cn("px-1.5 py-0.5 rounded border text-[9px] font-mono uppercase", STATUS_STYLES[active.status] ?? STATUS_STYLES.open)}>
              {active.status.replace("_", " ")}
            </span>
            <span className={cn("text-[10px] font-mono", PRIORITY_STYLES[active.priority])}>
              <Zap className="w-2.5 h-2.5 inline mr-0.5" />{active.priority}
            </span>
          </div>
        </div>
        <div className="flex gap-2 flex-shrink-0">
          {active.status !== "resolved" && (
            <button onClick={() => updateStatus(active.id, "resolved")}
              className="flex items-center gap-1.5 px-3 py-1.5 border border-emerald-400/30 text-emerald-400 rounded-lg text-xs font-mono hover:bg-emerald-400/10 transition-colors">
              <CheckCircle className="w-3 h-3" /> Resolve
            </button>
          )}
          {active.status !== "closed" && (
            <button onClick={() => updateStatus(active.id, "closed")}
              className="flex items-center gap-1.5 px-3 py-1.5 border border-border text-muted-foreground rounded-lg text-xs font-mono hover:text-foreground transition-colors">
              Close
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto space-y-3 pr-1">
        {threadLoading ? (
          <div className="flex items-center justify-center py-16"><Loader2 className="w-6 h-6 text-primary animate-spin" /></div>
        ) : active.messages.map((m, i) => {
          const isAdmin = m.authorRole === "admin";
          const initials = m.username.slice(0, 2).toUpperCase();
          return (
            <div key={m.id} className={cn("flex gap-3 animate-fade-up", isAdmin ? "flex-row-reverse" : "flex-row", `delay-${i * 30}`)}>
              <div className={cn("w-8 h-8 rounded-full flex-shrink-0 flex items-center justify-center text-xs font-mono font-bold", isAdmin ? "bg-secondary/15 text-secondary border border-secondary/30" : "bg-primary/15 text-primary border border-primary/30")}>
                {m.avatarUrl ? <img src={m.avatarUrl} className="w-full h-full rounded-full object-cover" /> : initials}
              </div>
              <div className={cn("max-w-[78%] space-y-1 flex flex-col", isAdmin ? "items-end" : "items-start")}>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-mono text-muted-foreground/60">{m.username}</span>
                  {isAdmin && <span className="px-1 py-0.5 bg-secondary/10 border border-secondary/20 rounded text-[8px] font-mono text-secondary uppercase">Admin</span>}
                  <span className="text-[10px] font-mono text-muted-foreground/40">{new Date(m.createdAt).toLocaleString()}</span>
                </div>
                <div className={cn("px-3 py-2.5 rounded-xl text-sm font-mono leading-relaxed whitespace-pre-wrap", isAdmin ? "bg-secondary/10 border border-secondary/20 text-foreground rounded-tr-sm" : "bg-card border border-card-border text-foreground rounded-tl-sm")}>
                  {m.content}
                </div>
              </div>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      {active.status !== "closed" && (
        <div className="flex gap-2 pt-4 border-t border-border flex-shrink-0">
          <textarea value={reply} onChange={e => setReply(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendReply(); } }}
            placeholder="Admin reply… (Enter to send)"
            rows={2}
            className="flex-1 bg-input border border-border rounded-lg px-3 py-2 text-sm font-mono focus:border-secondary/60 outline-none transition-colors resize-none" />
          <button onClick={sendReply} disabled={sending || !reply.trim()}
            className="px-3 bg-secondary text-secondary-foreground rounded-lg hover:bg-secondary/90 transition-colors disabled:opacity-30 self-end py-2">
            {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          </button>
        </div>
      )}
    </div>
  );

  // ── List View ───────────────────────────────────────────────────────────
  return (
    <div className="max-w-5xl mx-auto space-y-6 page-enter">
      <div>
        <h1 className="text-2xl font-mono font-bold tracking-tighter uppercase flex items-center gap-2">
          <MessageSquare className="w-6 h-6 text-primary" /> Support Center
        </h1>
        <p className="text-muted-foreground font-mono text-sm">Manage user support tickets</p>
      </div>

      {/* Stats */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[
            { label: "Total", value: stats.total, icon: BarChart3, color: "text-primary" },
            { label: "Open", value: stats.open, icon: AlertCircle, color: "text-sky-400" },
            { label: "In Progress", value: stats.inProgress, icon: TrendingUp, color: "text-amber-400" },
            { label: "Resolved", value: stats.resolved, icon: CheckCircle, color: "text-emerald-400" },
          ].map(s => (
            <div key={s.label} className="glass-card border rounded-xl p-4 animate-fade-up hover-lift">
              <div className={cn("flex items-center gap-2 mb-2", s.color)}>
                <s.icon className="w-4 h-4" />
                <span className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">{s.label}</span>
              </div>
              <p className={cn("text-2xl font-mono font-bold", s.color)}>{s.value}</p>
            </div>
          ))}
        </div>
      )}

      {/* Filter tabs */}
      <div className="flex gap-1 bg-card border border-card-border rounded-lg p-1 w-fit">
        {["all", "open", "in_progress", "resolved", "closed"].map(f => (
          <button key={f} onClick={() => setFilter(f)}
            className={cn("px-3 py-1.5 rounded text-[10px] font-mono uppercase tracking-wider transition-colors",
              filter === f ? "bg-primary/20 text-primary" : "text-muted-foreground hover:text-foreground")}>
            {f.replace("_", " ")}
          </button>
        ))}
      </div>

      {/* Ticket list */}
      {loading ? (
        <div className="flex items-center justify-center py-16"><Loader2 className="w-6 h-6 text-primary animate-spin" /></div>
      ) : filtered.length === 0 ? (
        <div className="glass-card border rounded-xl p-12 text-center">
          <MessageSquare className="w-10 h-10 text-muted-foreground/20 mx-auto mb-3" />
          <p className="font-mono text-muted-foreground">No {filter !== "all" ? filter : ""} tickets.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((t, i) => (
            <button key={t.id} onClick={() => openThread(t)}
              className={cn("w-full glass-card border rounded-xl p-4 text-left hover-lift hover-shimmer transition-all duration-200 animate-fade-up", `delay-${(i % 5) * 100}`)}>
              <div className="flex items-start gap-3">
                <div className={cn("flex-shrink-0 mt-0.5 w-5 h-5 flex items-center justify-center rounded-full", t.status === "resolved" ? "text-emerald-400" : t.status === "open" ? "text-sky-400" : "text-amber-400")}>
                  {t.status === "resolved" ? <CheckCircle className="w-4 h-4" /> : t.status === "open" ? <AlertCircle className="w-4 h-4" /> : <Clock className="w-4 h-4" />}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-mono font-bold text-sm">{t.title}</span>
                    <span className={cn("px-1.5 py-0.5 rounded border text-[9px] font-mono uppercase", STATUS_STYLES[t.status] ?? STATUS_STYLES.open)}>
                      {t.status.replace("_", " ")}
                    </span>
                    <span className={cn("text-[10px] font-mono", PRIORITY_STYLES[t.priority])}>
                      <Zap className="w-2.5 h-2.5 inline mr-0.5" />{t.priority}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 mt-1 text-[10px] font-mono text-muted-foreground/60">
                    <span><User className="w-2.5 h-2.5 inline mr-0.5" />@{t.username}</span>
                    <span><Tag className="w-2.5 h-2.5 inline mr-0.5" />{t.category}</span>
                    <span>{t.messageCount} msgs</span>
                    <span>{new Date(t.updatedAt).toLocaleDateString()}</span>
                  </div>
                </div>
                <ChevronRight className="w-4 h-4 text-muted-foreground/40 flex-shrink-0" />
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
