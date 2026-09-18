import { useState, useEffect, useCallback } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  Crown, Zap, Shield, Check, X, Loader2, RefreshCw,
  User, Calendar, CreditCard, Hash, Phone, Clock, ChevronDown,
  CheckCircle2, XCircle, AlertCircle, Coins, Filter,
} from "lucide-react";

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";

interface SubRecord {
  id: number;
  user_id: number;
  plan: string;
  status: string;
  coingate_order_id: string | null;
  payment_method: string | null;
  sender_number: string | null;
  rejection_reason: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
  username: string | null;
  email: string | null;
}

const METHOD_LABELS: Record<string, string> = {
  bkash: "bKash",
  nagad: "Nagad",
  binance_usdt: "Binance USDT",
};

const PLAN_COLORS: Record<string, string> = {
  free:       "text-muted-foreground border-border",
  pro:        "text-primary border-primary/40",
  enterprise: "text-amber-400 border-amber-400/40",
};

const PLAN_ICONS: Record<string, React.ElementType> = {
  free: Shield, pro: Zap, enterprise: Crown,
};

function StatusBadge({ status }: { status: string }) {
  if (status === "active")   return <Badge className="font-mono text-[10px] bg-emerald-500/10 text-emerald-400 border-emerald-500/30 gap-1"><CheckCircle2 className="w-3 h-3"/>Active</Badge>;
  if (status === "pending")  return <Badge className="font-mono text-[10px] bg-yellow-500/10 text-yellow-400 border-yellow-500/30 gap-1"><Clock className="w-3 h-3"/>Pending</Badge>;
  if (status === "rejected") return <Badge className="font-mono text-[10px] bg-red-500/10 text-red-400 border-red-500/30 gap-1"><XCircle className="w-3 h-3"/>Rejected</Badge>;
  return <Badge className="font-mono text-[10px]">{status}</Badge>;
}

export default function AdminSubscriptions() {
  const { token } = useAuth();
  const { toast } = useToast();
  const [subs, setSubs] = useState<SubRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"all" | "pending" | "active" | "rejected">("pending");
  const [search, setSearch] = useState("");
  const [actionLoading, setActionLoading] = useState<Record<number, string>>({});
  const [rejectReason, setRejectReason] = useState<Record<number, string>>({});
  const [showReject, setShowReject] = useState<Record<number, boolean>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${BASE}/api/admin/subscriptions`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) throw new Error("Failed");
      const data = await r.json();
      setSubs(data);
    } catch {
      toast({ title: "Failed to load subscriptions", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { load(); }, [load]);

  const handleApprove = async (userId: number) => {
    setActionLoading(p => ({ ...p, [userId]: "approve" }));
    try {
      const r = await fetch(`${BASE}/api/admin/subscriptions/${userId}/approve`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) throw new Error("Failed");
      toast({ title: "✓ Subscription approved", description: "User notified via email & real-time." });
      load();
    } catch {
      toast({ title: "Approval failed", variant: "destructive" });
    } finally {
      setActionLoading(p => ({ ...p, [userId]: "" }));
    }
  };

  const handleReject = async (userId: number) => {
    setActionLoading(p => ({ ...p, [userId]: "reject" }));
    try {
      const r = await fetch(`${BASE}/api/admin/subscriptions/${userId}/reject`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ reason: rejectReason[userId] ?? "" }),
      });
      if (!r.ok) throw new Error("Failed");
      toast({ title: "Subscription rejected", description: "User notified via email." });
      setShowReject(p => ({ ...p, [userId]: false }));
      load();
    } catch {
      toast({ title: "Rejection failed", variant: "destructive" });
    } finally {
      setActionLoading(p => ({ ...p, [userId]: "" }));
    }
  };

  const filtered = subs.filter(s => {
    if (filter !== "all" && s.status !== filter) return false;
    if (search) {
      const q = search.toLowerCase();
      return (s.username ?? "").toLowerCase().includes(q)
        || (s.email ?? "").toLowerCase().includes(q)
        || (s.coingate_order_id ?? "").toLowerCase().includes(q)
        || (s.sender_number ?? "").toLowerCase().includes(q);
    }
    return true;
  });

  const counts = {
    all: subs.length,
    pending: subs.filter(s => s.status === "pending").length,
    active: subs.filter(s => s.status === "active").length,
    rejected: subs.filter(s => s.status === "rejected").length,
  };

  return (
    <div className="space-y-6 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-mono font-bold tracking-widest uppercase text-foreground flex items-center gap-2">
            <CreditCard className="w-5 h-5 text-primary" />
            Subscription Approvals
          </h1>
          <p className="text-[11px] font-mono text-muted-foreground mt-1">
            Review and approve manual payment submissions (bKash / Nagad / USDT)
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={load} disabled={loading} className="font-mono text-[10px] gap-1.5 h-7">
          <RefreshCw className={cn("w-3 h-3", loading && "animate-spin")} /> Refresh
        </Button>
      </div>

      {/* Stat badges */}
      <div className="flex flex-wrap gap-2">
        {(["all", "pending", "active", "rejected"] as const).map(f => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={cn(
              "px-3 py-1.5 rounded-md border font-mono text-[10px] uppercase tracking-widest transition-all",
              filter === f
                ? "bg-primary/10 border-primary/40 text-primary"
                : "bg-card border-border text-muted-foreground hover:border-primary/20"
            )}
          >
            {f} <span className="ml-1 opacity-60">({counts[f]})</span>
          </button>
        ))}
        <div className="ml-auto flex items-center gap-2">
          <Input
            value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search user / ref..." className="font-mono text-xs h-7 w-48 bg-input"
          />
        </div>
      </div>

      {/* Table */}
      {loading ? (
        <div className="flex items-center justify-center h-40 text-muted-foreground font-mono text-sm gap-2">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading...
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-16 text-muted-foreground font-mono text-sm">
          <AlertCircle className="w-8 h-8 mx-auto mb-3 opacity-30" />
          No subscriptions found
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map(sub => {
            const PlanIcon = PLAN_ICONS[sub.plan] ?? Coins;
            const refId = sub.coingate_order_id?.replace("manual_", "") ?? "—";
            const isManual = sub.coingate_order_id?.startsWith("manual_");

            return (
              <div key={sub.id} className={cn(
                "border rounded-lg bg-card overflow-hidden transition-all",
                sub.status === "pending" ? "border-yellow-500/20" :
                sub.status === "active"  ? "border-emerald-500/20" : "border-red-500/20"
              )}>
                {/* Top bar */}
                <div className="flex items-center gap-4 px-4 py-3 border-b border-border/50 bg-muted/5">
                  <div className="flex items-center gap-2 min-w-0 flex-1">
                    <div className="w-8 h-8 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center flex-shrink-0">
                      <User className="w-4 h-4 text-primary" />
                    </div>
                    <div className="min-w-0">
                      <div className="font-mono text-sm font-bold text-foreground truncate">
                        {sub.username ?? `User #${sub.user_id}`}
                      </div>
                      <div className="font-mono text-[10px] text-muted-foreground truncate">
                        {sub.email ?? "—"}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className={cn("font-mono text-[10px] gap-1", PLAN_COLORS[sub.plan])}>
                      <PlanIcon className="w-3 h-3" />
                      {sub.plan.toUpperCase()}
                    </Badge>
                    <StatusBadge status={sub.status} />
                  </div>
                </div>

                {/* Body */}
                <div className="px-4 py-3 grid grid-cols-2 md:grid-cols-4 gap-3">
                  <div>
                    <div className="text-[9px] font-mono uppercase tracking-widest text-muted-foreground mb-0.5">Method</div>
                    <div className="font-mono text-xs text-foreground">
                      {isManual ? (METHOD_LABELS[sub.payment_method ?? ""] ?? sub.payment_method ?? "Manual") : "CoinGate"}
                    </div>
                  </div>
                  <div>
                    <div className="text-[9px] font-mono uppercase tracking-widest text-muted-foreground mb-0.5">
                      {isManual ? "TX / Reference ID" : "Order ID"}
                    </div>
                    <div className="font-mono text-xs text-primary break-all">{refId}</div>
                  </div>
                  <div>
                    <div className="text-[9px] font-mono uppercase tracking-widest text-muted-foreground mb-0.5">Sender No.</div>
                    <div className="font-mono text-xs text-foreground">{sub.sender_number || "—"}</div>
                  </div>
                  <div>
                    <div className="text-[9px] font-mono uppercase tracking-widest text-muted-foreground mb-0.5">Submitted</div>
                    <div className="font-mono text-xs text-foreground">
                      {new Date(sub.updated_at).toLocaleString()}
                    </div>
                  </div>
                </div>

                {sub.rejection_reason && (
                  <div className="px-4 pb-3">
                    <div className="text-[9px] font-mono uppercase tracking-widest text-red-400/70 mb-0.5">Rejection Reason</div>
                    <div className="font-mono text-xs text-red-300">{sub.rejection_reason}</div>
                  </div>
                )}

                {/* Actions */}
                {sub.status === "pending" && (
                  <div className="px-4 pb-3 flex flex-col gap-2">
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        onClick={() => handleApprove(sub.user_id)}
                        disabled={!!actionLoading[sub.user_id]}
                        className="font-mono text-[10px] uppercase gap-1.5 h-7 bg-emerald-600 hover:bg-emerald-500 text-white border-0"
                      >
                        {actionLoading[sub.user_id] === "approve"
                          ? <Loader2 className="w-3 h-3 animate-spin" />
                          : <CheckCircle2 className="w-3 h-3" />}
                        Approve & Activate
                      </Button>
                      <Button
                        size="sm" variant="outline"
                        onClick={() => setShowReject(p => ({ ...p, [sub.user_id]: !p[sub.user_id] }))}
                        disabled={!!actionLoading[sub.user_id]}
                        className="font-mono text-[10px] uppercase gap-1.5 h-7 border-red-500/30 text-red-400 hover:bg-red-500/10"
                      >
                        <XCircle className="w-3 h-3" /> Reject
                      </Button>
                    </div>
                    {showReject[sub.user_id] && (
                      <div className="flex gap-2 mt-1">
                        <Input
                          placeholder="Rejection reason (optional)..."
                          value={rejectReason[sub.user_id] ?? ""}
                          onChange={e => setRejectReason(p => ({ ...p, [sub.user_id]: e.target.value }))}
                          className="font-mono text-xs h-7 flex-1 bg-input"
                        />
                        <Button
                          size="sm" variant="destructive"
                          onClick={() => handleReject(sub.user_id)}
                          disabled={actionLoading[sub.user_id] === "reject"}
                          className="font-mono text-[10px] h-7 px-3"
                        >
                          {actionLoading[sub.user_id] === "reject" ? <Loader2 className="w-3 h-3 animate-spin" /> : "Confirm Reject"}
                        </Button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
