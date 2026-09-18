import { useState, useEffect, useCallback } from "react";
import { Share2, Users, DollarSign, CheckCircle, Trophy, Filter, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { format } from "date-fns";

interface AdminReferral {
  id: number; referrerId: number; referredId: number;
  referrerUsername: string; referredUsername: string;
  codeUsed: string; rewardAmount: number; rewardPaid: boolean;
  createdAt: string; paidAt: string | null;
}
interface AdminStats {
  totalReferrals: number; paidReferrals: number;
  uniqueReferrers: number; totalRewardsPaid: number;
}
interface LeaderItem {
  referrerId: number; username: string; code: string;
  totalReferrals: number; paidReferrals: number; totalEarnings: number;
}

export default function AdminReferrals() {
  const [referrals, setReferrals] = useState<AdminReferral[]>([]);
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [leaders, setLeaders] = useState<LeaderItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"all" | "pending" | "paid">("all");
  const [payingId, setPayingId] = useState<number | null>(null);

  const token = localStorage.getItem("ayzen_token") ?? "";

  const load = useCallback(async () => {
    setLoading(true);
    const [refRes, ldRes] = await Promise.all([
      fetch("/api/admin/referrals", { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json()),
      fetch("/api/admin/referrals/leaderboard", { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json()),
    ]);
    setReferrals(Array.isArray(refRes.referrals) ? refRes.referrals : []);
    setStats(refRes.stats ?? null);
    setLeaders(Array.isArray(ldRes) ? ldRes : []);
    setLoading(false);
  }, [token]);

  useEffect(() => { load(); }, [load]);

  const markPaid = async (id: number) => {
    setPayingId(id);
    await fetch(`/api/admin/referrals/${id}/reward`, { method: "PATCH", headers: { Authorization: `Bearer ${token}` } });
    setReferrals(r => r.map(x => x.id === id ? { ...x, rewardPaid: true, paidAt: new Date().toISOString() } : x));
    if (stats) setStats({ ...stats, paidReferrals: stats.paidReferrals + 1 });
    setPayingId(null);
  };

  const filtered = referrals.filter(r => filter === "all" ? true : filter === "paid" ? r.rewardPaid : !r.rewardPaid);

  const statCards = [
    { label: "Total Referrals", value: stats?.totalReferrals ?? 0, icon: Users, color: "text-primary", bg: "border-primary/20 bg-primary/5" },
    { label: "Unique Referrers", value: stats?.uniqueReferrers ?? 0, icon: Share2, color: "text-violet-400", bg: "border-violet-400/20 bg-violet-400/5" },
    { label: "Rewards Paid", value: stats?.paidReferrals ?? 0, icon: CheckCircle, color: "text-emerald-400", bg: "border-emerald-400/20 bg-emerald-400/5" },
    { label: "Total Paid Out", value: `$${(stats?.totalRewardsPaid ?? 0).toFixed(2)}`, icon: DollarSign, color: "text-amber-400", bg: "border-amber-400/20 bg-amber-400/5" },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold font-mono tracking-tighter uppercase flex items-center gap-2">
            <Share2 className="h-6 w-6 text-primary" /> Referral Management
          </h1>
          <p className="text-muted-foreground font-mono text-sm">Track, verify, and process referral rewards</p>
        </div>
        <button onClick={load} className="flex items-center gap-1.5 px-3 py-2 border border-border rounded-lg text-xs font-mono text-muted-foreground hover:text-primary hover:border-primary/40 transition-colors">
          <RefreshCw className={cn("w-3.5 h-3.5", loading && "animate-spin")} /> Refresh
        </button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {statCards.map(s => (
          <div key={s.label} className={cn("rounded-xl border p-4 animate-fade-up", s.bg)}>
            <div className="flex items-center gap-1.5 mb-2">
              <s.icon className={cn("w-3.5 h-3.5", s.color)} />
              <span className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">{s.label}</span>
            </div>
            {loading ? <Skeleton className="h-7 w-12" /> : <p className={cn("text-2xl font-mono font-bold", s.color)}>{s.value}</p>}
          </div>
        ))}
      </div>

      {/* Leaderboard */}
      {leaders.length > 0 && (
        <div className="border border-card-border rounded-xl bg-card overflow-hidden">
          <div className="px-4 py-3 border-b border-card-border flex items-center gap-2">
            <Trophy className="w-4 h-4 text-amber-400" />
            <span className="font-mono text-sm font-bold">Top Referrers</span>
          </div>
          <div className="flex gap-3 p-4 overflow-x-auto">
            {leaders.slice(0, 5).map((l, i) => (
              <div key={l.referrerId} className={cn("flex-shrink-0 rounded-xl border p-3 min-w-[160px]",
                i === 0 ? "border-amber-400/30 bg-amber-400/5" : i === 1 ? "border-slate-400/30 bg-slate-400/5" : "border-card-border bg-muted/20")}>
                <div className="flex items-center gap-1.5 mb-2">
                  <span className={cn("text-sm font-mono font-black", i === 0 ? "text-amber-400" : i === 1 ? "text-slate-300" : "text-muted-foreground")}>
                    #{i + 1}
                  </span>
                  <span className="font-mono text-xs font-bold text-foreground truncate">{l.username}</span>
                </div>
                <p className="font-mono text-[10px] text-muted-foreground/60 mb-1 truncate">{l.code}</p>
                <p className="font-mono text-lg font-bold text-primary">{l.totalReferrals}</p>
                <p className="font-mono text-[10px] text-muted-foreground">referrals</p>
                <p className="font-mono text-xs text-emerald-400 mt-1">${l.totalEarnings.toFixed(0)} earned</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Referrals table */}
      <div className="border border-card-border rounded-xl bg-card overflow-hidden">
        <div className="px-4 py-3 border-b border-card-border flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <Filter className="w-3.5 h-3.5 text-muted-foreground" />
            <span className="font-mono text-sm font-bold">All Referrals</span>
            <Badge variant="outline" className="font-mono text-[10px]">{filtered.length}</Badge>
          </div>
          <div className="flex gap-1">
            {(["all", "pending", "paid"] as const).map(f => (
              <button key={f} onClick={() => setFilter(f)}
                className={cn("px-3 py-1 rounded text-[10px] font-mono uppercase transition-colors",
                  filter === f ? "bg-primary/20 text-primary border border-primary/30" : "text-muted-foreground hover:text-foreground border border-transparent")}>
                {f}
              </button>
            ))}
          </div>
        </div>
        {loading ? (
          <div className="p-4 space-y-2">{[1,2,3,4].map(i => <Skeleton key={i} className="h-12 w-full" />)}</div>
        ) : filtered.length === 0 ? (
          <div className="py-12 text-center font-mono text-muted-foreground">No referrals match this filter.</div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="border-card-border hover:bg-transparent">
                <TableHead className="font-mono uppercase text-[10px]">Referrer</TableHead>
                <TableHead className="font-mono uppercase text-[10px]">Referred</TableHead>
                <TableHead className="font-mono uppercase text-[10px]">Code</TableHead>
                <TableHead className="font-mono uppercase text-[10px]">Date</TableHead>
                <TableHead className="font-mono uppercase text-[10px] text-right">Reward</TableHead>
                <TableHead className="font-mono uppercase text-[10px]">Status</TableHead>
                <TableHead className="font-mono uppercase text-[10px] text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map(r => (
                <TableRow key={r.id} className="border-card-border hover:bg-muted/30">
                  <TableCell className="font-mono text-sm font-bold text-foreground">{r.referrerUsername}</TableCell>
                  <TableCell className="font-mono text-sm text-muted-foreground">{r.referredUsername}</TableCell>
                  <TableCell>
                    <span className="font-mono text-[10px] px-2 py-0.5 bg-primary/10 text-primary border border-primary/20 rounded">
                      {r.codeUsed}
                    </span>
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {format(new Date(r.createdAt), "MMM dd, yyyy")}
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm font-bold text-foreground">
                    ${r.rewardAmount.toFixed(2)}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className={cn("font-mono text-[10px] uppercase rounded-sm",
                      r.rewardPaid ? "border-emerald-400/40 text-emerald-400" : "border-amber-400/40 text-amber-400")}>
                      {r.rewardPaid ? `Paid ${r.paidAt ? format(new Date(r.paidAt), "MMM d") : ""}` : "Pending"}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    {!r.rewardPaid && (
                      <button
                        onClick={() => markPaid(r.id)}
                        disabled={payingId === r.id}
                        className="px-2.5 py-1 border border-emerald-400/30 text-emerald-400 rounded text-[10px] font-mono hover:bg-emerald-400/10 disabled:opacity-40 transition-colors">
                        {payingId === r.id ? "…" : "Mark Paid"}
                      </button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
}
