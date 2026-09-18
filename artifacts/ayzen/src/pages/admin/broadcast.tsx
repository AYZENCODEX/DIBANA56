import { useState, useEffect, useCallback } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import {
  MessageSquare, Plus, Send, X, Loader2, Radio, Users,
  Mail, BotMessageSquare, Globe, CheckCircle2, Clock, RefreshCw,
} from "lucide-react";
import { cn } from "@/lib/utils";

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";

const CHANNEL_OPTIONS = [
  { id: "telegram", label: "Telegram", icon: BotMessageSquare, color: "text-sky-400 border-sky-400/30 bg-sky-400/5" },
  { id: "email", label: "Email", icon: Mail, color: "text-amber-400 border-amber-400/30 bg-amber-400/5" },
  { id: "inapp", label: "In-App", icon: Radio, color: "text-primary border-primary/30 bg-primary/5" },
  { id: "all", label: "All Channels", icon: Globe, color: "text-emerald-400 border-emerald-400/30 bg-emerald-400/5" },
];

const STATUS_BADGE: Record<string, string> = {
  sent: "bg-emerald-400/10 text-emerald-400 border-emerald-400/20",
  scheduled: "bg-amber-400/10 text-amber-400 border-amber-400/20",
  draft: "bg-card text-muted-foreground border-card-border",
  failed: "bg-red-400/10 text-red-400 border-red-400/20",
};

interface Broadcast {
  id: number;
  title: string;
  message: string;
  channel: string;
  status: string;
  recipientCount: number;
  createdAt: string;
  scheduledAt: string | null;
}

interface ComposeForm {
  title: string;
  message: string;
  channel: string;
  recipientFilter: string;
  scheduledAt: string;
}

export default function AdminBroadcast() {
  const { token } = useAuth();
  const { toast } = useToast();
  const [broadcasts, setBroadcasts] = useState<Broadcast[]>([]);
  const [loading, setLoading] = useState(true);
  const [composing, setComposing] = useState(false);
  const [sending, setSending] = useState(false);
  const [form, setForm] = useState<ComposeForm>({
    title: "", message: "", channel: "telegram", recipientFilter: "all", scheduledAt: "",
  });

  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };

  const fetchBroadcasts = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${BASE}/api/broadcast`, { headers: { Authorization: `Bearer ${token}` } });
      if (r.ok) setBroadcasts(await r.json());
    } catch { }
    setLoading(false);
  }, [token]);

  useEffect(() => { fetchBroadcasts(); }, [fetchBroadcasts]);

  const handleSend = async () => {
    if (!form.title.trim() || !form.message.trim()) {
      toast({ variant: "destructive", title: "Title and message are required" });
      return;
    }
    setSending(true);
    try {
      const body: any = { title: form.title, message: form.message, channel: form.channel, recipientFilter: form.recipientFilter };
      if (form.scheduledAt) body.scheduledAt = form.scheduledAt;
      const r = await fetch(`${BASE}/api/broadcast`, { method: "POST", headers, body: JSON.stringify(body) });
      if (r.ok) {
        toast({ title: "📡 Broadcast sent!", description: `Channel: ${form.channel}` });
        setComposing(false);
        setForm({ title: "", message: "", channel: "telegram", recipientFilter: "all", scheduledAt: "" });
        fetchBroadcasts();
      } else {
        const d = await r.json();
        toast({ variant: "destructive", title: d.error ?? "Failed to send broadcast" });
      }
    } catch { toast({ variant: "destructive", title: "Connection error" }); }
    setSending(false);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold font-mono tracking-tighter uppercase flex items-center gap-2">
            <Radio className="w-6 h-6 text-primary" /> Comms Broadcast
          </h1>
          <p className="text-muted-foreground font-mono text-sm">System-wide operator notifications</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={fetchBroadcasts} disabled={loading} className="font-mono text-xs gap-1.5">
            <RefreshCw className={cn("w-3.5 h-3.5", loading && "animate-spin")} />
          </Button>
          <Button onClick={() => setComposing(true)} className="font-mono uppercase text-xs tracking-wider gap-2">
            <Plus className="h-4 w-4" /> New Broadcast
          </Button>
        </div>
      </div>

      {/* ── Compose Modal ──────────────────────────────────────────────────── */}
      {composing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={() => setComposing(false)}>
          <div className="bg-card border border-primary/20 rounded-xl w-full max-w-lg mx-4 shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-card-border">
              <div className="flex items-center gap-2">
                <Send className="w-4 h-4 text-primary" />
                <span className="font-mono font-bold text-sm text-foreground">Compose Broadcast</span>
              </div>
              <button onClick={() => setComposing(false)} className="text-muted-foreground hover:text-foreground transition-colors">
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="px-5 py-5 space-y-4">
              {/* Channel selector */}
              <div className="space-y-2">
                <label className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Channel</label>
                <div className="grid grid-cols-4 gap-2">
                  {CHANNEL_OPTIONS.map(ch => (
                    <button
                      key={ch.id}
                      onClick={() => setForm(f => ({ ...f, channel: ch.id }))}
                      className={cn(
                        "flex flex-col items-center gap-1 px-3 py-2.5 border rounded-lg text-[10px] font-mono uppercase transition-all",
                        form.channel === ch.id ? ch.color : "border-card-border text-muted-foreground hover:bg-muted/30"
                      )}
                    >
                      <ch.icon className="w-3.5 h-3.5" />
                      {ch.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Title */}
              <div className="space-y-1.5">
                <label className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Title <span className="text-red-400">*</span></label>
                <Input
                  value={form.title}
                  onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
                  placeholder="Broadcast title..."
                  className="font-mono text-xs h-10 bg-input border-border"
                />
              </div>

              {/* Message */}
              <div className="space-y-1.5">
                <label className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Message <span className="text-red-400">*</span></label>
                <Textarea
                  value={form.message}
                  onChange={e => setForm(f => ({ ...f, message: e.target.value }))}
                  placeholder="Write your message..."
                  rows={4}
                  className="font-mono text-xs bg-input border-border resize-none"
                />
                <div className="flex justify-between font-mono text-[9px] text-muted-foreground/50">
                  <span>{form.message.length} chars</span>
                  <span>Markdown supported for Telegram</span>
                </div>
              </div>

              {/* Recipients + Schedule */}
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <label className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Recipients</label>
                  <select
                    value={form.recipientFilter}
                    onChange={e => setForm(f => ({ ...f, recipientFilter: e.target.value }))}
                    className="w-full bg-input border border-border rounded-md px-3 py-2 text-xs font-mono text-foreground focus:outline-none focus:border-primary/50"
                  >
                    <option value="all">All Users</option>
                    <option value="pro">Pro+ Only</option>
                    <option value="enterprise">Enterprise Only</option>
                    <option value="active">Active (7d)</option>
                  </select>
                </div>
                <div className="space-y-1.5">
                  <label className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Schedule (optional)</label>
                  <Input
                    type="datetime-local"
                    value={form.scheduledAt}
                    onChange={e => setForm(f => ({ ...f, scheduledAt: e.target.value }))}
                    className="font-mono text-xs h-10 bg-input border-border"
                  />
                </div>
              </div>

              <div className="flex gap-3 pt-1">
                <Button variant="outline" onClick={() => setComposing(false)} className="flex-1 font-mono text-xs">Cancel</Button>
                <Button onClick={handleSend} disabled={sending || !form.title.trim() || !form.message.trim()} className="flex-1 font-mono text-xs gap-2">
                  {sending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                  {form.scheduledAt ? "Schedule" : "Send Now"}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Stats Row ──────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: "Total Sent", value: broadcasts.filter(b => b.status === "sent").length, icon: CheckCircle2, color: "text-emerald-400" },
          { label: "Scheduled", value: broadcasts.filter(b => b.status === "scheduled").length, icon: Clock, color: "text-amber-400" },
          { label: "Total Broadcasts", value: broadcasts.length, icon: MessageSquare, color: "text-primary" },
        ].map(s => (
          <div key={s.label} className="bg-card border border-card-border rounded-xl px-4 py-4">
            <div className="flex items-center gap-1.5 mb-1">
              <s.icon className={cn("w-3.5 h-3.5", s.color)} />
              <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">{s.label}</span>
            </div>
            <div className={cn("font-mono text-2xl font-bold", s.color)}>{s.value}</div>
          </div>
        ))}
      </div>

      {/* ── History table ──────────────────────────────────────────────────── */}
      <div className="border border-card-border rounded-xl bg-card overflow-hidden">
        <div className="px-4 py-3 border-b border-card-border">
          <span className="font-mono text-xs font-bold text-muted-foreground/60 uppercase tracking-widest">Transmission History</span>
        </div>
        <Table>
          <TableHeader>
            <TableRow className="border-card-border hover:bg-transparent">
              <TableHead className="font-mono uppercase text-[10px]">Title</TableHead>
              <TableHead className="font-mono uppercase text-[10px]">Channel</TableHead>
              <TableHead className="font-mono uppercase text-[10px]">Recipients</TableHead>
              <TableHead className="font-mono uppercase text-[10px]">Status</TableHead>
              <TableHead className="font-mono uppercase text-[10px]">Date</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              Array.from({ length: 3 }).map((_, i) => (
                <TableRow key={i} className="border-card-border">
                  {Array.from({ length: 5 }).map((_, j) => <TableCell key={j}><Skeleton className="h-4 w-full" /></TableCell>)}
                </TableRow>
              ))
            ) : broadcasts.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center py-12 font-mono text-muted-foreground/50">
                  <Radio className="w-8 h-8 mx-auto mb-2 opacity-20" />
                  No transmissions yet.
                </TableCell>
              </TableRow>
            ) : (
              broadcasts.map(b => (
                <TableRow key={b.id} className="border-card-border hover:bg-muted/30">
                  <TableCell className="font-mono text-sm font-medium">{b.title}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className="font-mono text-[10px] uppercase">{b.channel}</Badge>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1 font-mono text-xs text-muted-foreground">
                      <Users className="w-3 h-3" /> {b.recipientCount?.toLocaleString() ?? "—"}
                    </div>
                  </TableCell>
                  <TableCell>
                    <span className={cn("px-2 py-0.5 rounded border text-[10px] font-mono uppercase", STATUS_BADGE[b.status] ?? STATUS_BADGE.draft)}>
                      {b.status}
                    </span>
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {new Date(b.createdAt).toLocaleString()}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
