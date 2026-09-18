import { useState, useEffect, useCallback, useRef } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import {
  MessageSquare, Plus, ChevronRight, Clock, CheckCircle,
  AlertCircle, Loader2, Send, ArrowLeft, Tag, Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface Ticket {
  id: number;
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

const STATUS_STYLES: Record<string, string> = {
  open:        "border-sky-400/30 text-sky-400 bg-sky-400/5",
  in_progress: "border-amber-400/30 text-amber-400 bg-amber-400/5",
  resolved:    "border-emerald-400/30 text-emerald-400 bg-emerald-400/5",
  closed:      "border-muted-foreground/30 text-muted-foreground bg-muted/5",
};
const PRIORITY_STYLES: Record<string, string> = {
  low:    "text-muted-foreground",
  medium: "text-sky-400",
  high:   "text-amber-400",
  urgent: "text-red-400",
};

const CATEGORIES = ["general", "account", "project", "task", "vault", "billing", "bug", "feature"];

export default function SupportPage() {
  const { token, user } = useAuth() as any;
  const { toast } = useToast();
  const bottomRef = useRef<HTMLDivElement>(null);

  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<"list" | "create" | "thread">("list");
  const [activeTicket, setActiveTicket] = useState<(Ticket & { messages: Message[] }) | null>(null);
  const [threadLoading, setThreadLoading] = useState(false);
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);

  const [newForm, setNewForm] = useState({ title: "", category: "general", priority: "medium", message: "" });
  const [creating, setCreating] = useState(false);

  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const loadTickets = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/support/tickets", { headers: { Authorization: `Bearer ${token}` } });
      setTickets(await res.json());
    } catch { toast({ title: "Failed to load tickets", variant: "destructive" }); }
    finally { setLoading(false); }
  }, [token]);

  useEffect(() => { loadTickets(); }, [loadTickets]);

  useEffect(() => {
    if (view === "thread") bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [activeTicket?.messages, view]);

  const openThread = async (ticket: Ticket) => {
    setThreadLoading(true);
    setView("thread");
    try {
      const res = await fetch(`/api/support/tickets/${ticket.id}`, { headers: { Authorization: `Bearer ${token}` } });
      setActiveTicket(await res.json());
    } catch { toast({ title: "Failed to load thread", variant: "destructive" }); }
    finally { setThreadLoading(false); }
  };

  const createTicket = async () => {
    if (!newForm.title.trim() || !newForm.message.trim()) {
      toast({ title: "Title and message are required", variant: "destructive" });
      return;
    }
    setCreating(true);
    try {
      const res = await fetch("/api/support/tickets", { method: "POST", headers, body: JSON.stringify(newForm) });
      if (!res.ok) throw new Error();
      toast({ title: "Ticket created!", description: "Our team will reply soon." });
      setNewForm({ title: "", category: "general", priority: "medium", message: "" });
      setView("list");
      await loadTickets();
    } catch { toast({ title: "Failed to create ticket", variant: "destructive" }); }
    finally { setCreating(false); }
  };

  const sendReply = async () => {
    if (!reply.trim() || !activeTicket) return;
    setSending(true);
    try {
      const res = await fetch(`/api/support/tickets/${activeTicket.id}/messages`, {
        method: "POST", headers, body: JSON.stringify({ content: reply }),
      });
      const msg = await res.json();
      setActiveTicket(t => t ? { ...t, messages: [...t.messages, msg] } : null);
      setReply("");
    } catch { toast({ title: "Failed to send reply", variant: "destructive" }); }
    finally { setSending(false); }
  };

  // ── List View ───────────────────────────────────────────────────────────
  if (view === "list") return (
    <div className="max-w-3xl mx-auto space-y-6 page-enter">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-mono font-bold tracking-tighter uppercase flex items-center gap-2">
            <MessageSquare className="w-6 h-6 text-primary" /> Support
          </h1>
          <p className="text-muted-foreground font-mono text-sm">Get help from the AYZEN team</p>
        </div>
        <button onClick={() => setView("create")}
          className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg font-mono text-sm font-bold hover:bg-primary/90 transition-all hover-lift animate-glow-pulse">
          <Plus className="w-4 h-4" /> New Ticket
        </button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="w-6 h-6 text-primary animate-spin" />
        </div>
      ) : tickets.length === 0 ? (
        <div className="glass-card border rounded-xl p-12 text-center animate-fade-up">
          <MessageSquare className="w-10 h-10 text-muted-foreground/20 mx-auto mb-3" />
          <p className="font-mono text-muted-foreground">No tickets yet</p>
          <p className="font-mono text-xs text-muted-foreground/50 mt-1">Create a ticket to get support from the AYZEN team.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {tickets.map((t, i) => (
            <button key={t.id} onClick={() => openThread(t)}
              className={cn("w-full glass-card border rounded-xl p-4 text-left hover-lift hover-shimmer transition-all duration-200 animate-fade-up", `delay-${(i % 5) * 100}`)}>
              <div className="flex items-start gap-3">
                <div className={cn("flex-shrink-0 mt-0.5 w-5 h-5 flex items-center justify-center rounded-full", t.status === "resolved" ? "text-emerald-400" : t.status === "open" ? "text-sky-400" : "text-amber-400")}>
                  {t.status === "resolved" ? <CheckCircle className="w-4 h-4" /> : t.status === "open" ? <AlertCircle className="w-4 h-4" /> : <Clock className="w-4 h-4" />}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-mono font-bold text-sm text-foreground">{t.title}</span>
                    <span className={cn("px-1.5 py-0.5 rounded border text-[9px] font-mono uppercase", STATUS_STYLES[t.status] ?? STATUS_STYLES.open)}>
                      {t.status.replace("_", " ")}
                    </span>
                    <span className={cn("text-[10px] font-mono", PRIORITY_STYLES[t.priority])}>
                      <Zap className="w-2.5 h-2.5 inline mr-0.5" />{t.priority}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 mt-1 text-[10px] font-mono text-muted-foreground/60">
                    <span><Tag className="w-2.5 h-2.5 inline mr-0.5" />{t.category}</span>
                    <span>{t.messageCount} message{t.messageCount !== 1 ? "s" : ""}</span>
                    <span>{new Date(t.updatedAt).toLocaleDateString()}</span>
                  </div>
                </div>
                <ChevronRight className="w-4 h-4 text-muted-foreground/40 flex-shrink-0 mt-0.5" />
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );

  // ── Create View ─────────────────────────────────────────────────────────
  if (view === "create") return (
    <div className="max-w-2xl mx-auto space-y-6 page-enter">
      <div className="flex items-center gap-3">
        <button onClick={() => setView("list")} className="text-muted-foreground hover:text-foreground transition-colors">
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div>
          <h1 className="text-xl font-mono font-bold tracking-tighter uppercase">New Support Ticket</h1>
          <p className="text-muted-foreground font-mono text-xs">Describe your issue and our team will respond ASAP</p>
        </div>
      </div>

      <div className="glass-card border rounded-xl p-6 space-y-4 animate-fade-up">
        <div>
          <label className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest block mb-1.5">Title *</label>
          <input value={newForm.title} onChange={e => setNewForm(f => ({ ...f, title: e.target.value }))}
            placeholder="Brief description of your issue"
            className="w-full bg-input border border-border rounded-lg px-3 py-2.5 text-sm font-mono focus:border-primary/60 outline-none transition-colors" />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest block mb-1.5">Category</label>
            <select value={newForm.category} onChange={e => setNewForm(f => ({ ...f, category: e.target.value }))}
              className="w-full bg-input border border-border rounded-lg px-3 py-2.5 text-sm font-mono focus:border-primary/60 outline-none transition-colors capitalize">
              {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div>
            <label className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest block mb-1.5">Priority</label>
            <select value={newForm.priority} onChange={e => setNewForm(f => ({ ...f, priority: e.target.value }))}
              className="w-full bg-input border border-border rounded-lg px-3 py-2.5 text-sm font-mono focus:border-primary/60 outline-none transition-colors">
              {["low", "medium", "high", "urgent"].map(p => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
        </div>

        <div>
          <label className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest block mb-1.5">Message *</label>
          <textarea value={newForm.message} onChange={e => setNewForm(f => ({ ...f, message: e.target.value }))}
            rows={5} placeholder="Describe your issue in detail…"
            className="w-full bg-input border border-border rounded-lg px-3 py-2.5 text-sm font-mono focus:border-primary/60 outline-none transition-colors resize-none" />
        </div>

        <div className="flex gap-3">
          <button onClick={() => setView("list")} className="flex-1 py-2.5 border border-border rounded-lg font-mono text-sm text-muted-foreground hover:text-foreground transition-colors">
            Cancel
          </button>
          <button onClick={createTicket} disabled={creating}
            className="flex-1 flex items-center justify-center gap-2 py-2.5 bg-primary text-primary-foreground rounded-lg font-mono text-sm font-bold hover:bg-primary/90 transition-colors disabled:opacity-50">
            {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            {creating ? "Submitting…" : "Submit Ticket"}
          </button>
        </div>
      </div>
    </div>
  );

  // ── Thread View ─────────────────────────────────────────────────────────
  return (
    <div className="max-w-2xl mx-auto flex flex-col h-[calc(100vh-8rem)] page-enter">
      <div className="flex items-center gap-3 mb-4 flex-shrink-0">
        <button onClick={() => { setView("list"); setActiveTicket(null); }} className="text-muted-foreground hover:text-foreground transition-colors">
          <ArrowLeft className="w-5 h-5" />
        </button>
        {activeTicket && (
          <div className="flex-1 min-w-0">
            <h1 className="font-mono font-bold text-foreground truncate">{activeTicket.title}</h1>
            <div className="flex items-center gap-2 mt-0.5">
              <span className={cn("px-1.5 py-0.5 rounded border text-[9px] font-mono uppercase", STATUS_STYLES[activeTicket.status] ?? STATUS_STYLES.open)}>
                {activeTicket.status.replace("_", " ")}
              </span>
              <span className="text-[10px] font-mono text-muted-foreground/60">#{activeTicket.id}</span>
            </div>
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto space-y-3 pr-1">
        {threadLoading ? (
          <div className="flex items-center justify-center py-16"><Loader2 className="w-6 h-6 text-primary animate-spin" /></div>
        ) : activeTicket?.messages.map((m, i) => {
          const isUser = m.authorRole === "user";
          const initials = m.username.slice(0, 2).toUpperCase();
          return (
            <div key={m.id} className={cn("flex gap-3 animate-fade-up", isUser ? "flex-row-reverse" : "flex-row", `delay-${i * 50}`)}>
              <div className={cn("w-8 h-8 rounded-full flex-shrink-0 flex items-center justify-center text-xs font-mono font-bold", isUser ? "bg-primary/15 text-primary border border-primary/30" : "bg-secondary/15 text-secondary border border-secondary/30")}>
                {m.avatarUrl ? <img src={m.avatarUrl} className="w-full h-full rounded-full object-cover" /> : initials}
              </div>
              <div className={cn("max-w-[80%] space-y-1", isUser ? "items-end" : "items-start", "flex flex-col")}>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-mono text-muted-foreground/60">{m.username}</span>
                  {!isUser && <span className="px-1 py-0.5 bg-secondary/10 border border-secondary/20 rounded text-[8px] font-mono text-secondary uppercase">Admin</span>}
                  <span className="text-[10px] font-mono text-muted-foreground/40">{new Date(m.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                </div>
                <div className={cn("px-3 py-2.5 rounded-xl text-sm font-mono leading-relaxed whitespace-pre-wrap", isUser ? "bg-primary/10 border border-primary/20 text-foreground rounded-tr-sm" : "bg-card border border-card-border text-foreground rounded-tl-sm")}>
                  {m.content}
                </div>
              </div>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      {activeTicket?.status !== "resolved" && activeTicket?.status !== "closed" && (
        <div className="flex gap-2 pt-4 border-t border-border flex-shrink-0">
          <textarea value={reply} onChange={e => setReply(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendReply(); } }}
            placeholder="Type your reply… (Enter to send)"
            rows={2}
            className="flex-1 bg-input border border-border rounded-lg px-3 py-2 text-sm font-mono focus:border-primary/60 outline-none transition-colors resize-none" />
          <button onClick={sendReply} disabled={sending || !reply.trim()}
            className="px-3 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-30 self-end py-2">
            {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          </button>
        </div>
      )}

      {(activeTicket?.status === "resolved" || activeTicket?.status === "closed") && (
        <div className="pt-4 border-t border-border text-center">
          <span className="text-xs font-mono text-muted-foreground">This ticket is {activeTicket.status}. Open a new ticket if you need further help.</span>
        </div>
      )}
    </div>
  );
}
