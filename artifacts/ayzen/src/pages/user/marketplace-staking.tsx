import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { Lock, Sparkles, TrendingUp, Unlock, X } from "lucide-react";

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";
const token = () => localStorage.getItem("ayzen_token") ?? "";
const api = (path: string, opts?: RequestInit) =>
  fetch(`${BASE}/api${path}`, { ...opts, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token()}`, ...(opts?.headers ?? {}) } });

export default function StakingPage() {
  const { toast } = useToast();
  const [pools, setPools] = useState<any[]>([]);
  const [positions, setPositions] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [activePool, setActivePool] = useState<any>(null);
  const [amount, setAmount] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [p, pos] = await Promise.all([
        api("/spot/staking/pools").then(r => r.json()),
        api("/spot/staking/positions").then(r => r.json()),
      ]);
      setPools(Array.isArray(p) ? p : []);
      setPositions(Array.isArray(pos) ? pos : []);
    } catch {}
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const stake = async () => {
    if (!activePool || !amount || Number(amount) <= 0) { toast({ variant: "destructive", title: "Enter a valid amount" }); return; }
    setSubmitting(true);
    try {
      const r = await api("/spot/staking/stake", { method: "POST", body: JSON.stringify({ pool_id: activePool.id, amount: Number(amount) }) });
      const d = await r.json();
      if (!r.ok) toast({ variant: "destructive", title: d.error });
      else { toast({ title: `Staked ${amount} ${activePool.symbol.split("-")[0]}` }); setAmount(""); setActivePool(null); load(); }
    } catch { toast({ variant: "destructive", title: "Network error" }); }
    setSubmitting(false);
  };

  const unstake = async (id: number) => {
    const r = await api(`/spot/staking/unstake/${id}`, { method: "POST" });
    const d = await r.json();
    if (!r.ok) toast({ variant: "destructive", title: d.error });
    else toast({ title: d.matured ? `Unstaked — reward ${d.reward.toFixed(4)}` : "Unstaked early (no reward — lock hadn't matured)" });
    load();
  };

  const activePositions = positions.filter(p => p.status === "active");

  return (
    <div className="space-y-6 page-enter">
      <div className="flex items-center gap-2">
        <div className="w-8 h-8 rounded-lg bg-amber-500/15 border border-amber-500/30 flex items-center justify-center">
          <Sparkles className="w-4 h-4 text-amber-400" />
        </div>
        <h1 className="text-2xl font-bold font-mono tracking-tighter uppercase">Staking / Earn</h1>
      </div>
      <p className="text-muted-foreground font-mono text-sm -mt-4">Lock AZN or USDT to earn a fixed APY, like Binance Earn.</p>

      <div className="grid md:grid-cols-2 gap-4">
        {loading ? Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-32 rounded-xl" />) :
          pools.map(pool => (
            <div key={pool.id} className="bg-card border border-card-border rounded-xl p-4 flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className="font-mono text-sm font-bold">{pool.label}</span>
                  <Badge className="font-mono text-[9px] bg-amber-500/15 text-amber-400 border-amber-500/30">{pool.apy}% APY</Badge>
                </div>
                <div className="text-[10px] font-mono text-muted-foreground/60">
                  {pool.min_lock_days > 0 ? `${pool.min_lock_days}-day lock` : "Flexible — unstake anytime"} · min {pool.min_amount} {pool.symbol.split("-")[0]}
                </div>
              </div>
              <Button size="sm" onClick={() => { setActivePool(pool); setAmount(""); }} className="w-full mt-3 font-mono text-[10px] gap-1 bg-amber-600 hover:bg-amber-700">
                <Lock className="w-3 h-3" /> Stake
              </Button>
            </div>
          ))}
      </div>

      {activePool && (
        <div className="bg-card border border-amber-500/30 rounded-xl p-5 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="font-mono text-xs uppercase tracking-widest text-amber-400 font-bold">Stake into {activePool.label}</h3>
            <button onClick={() => setActivePool(null)}><X className="w-4 h-4 text-muted-foreground" /></button>
          </div>
          <div className="flex gap-3">
            <Input value={amount} onChange={e => setAmount(e.target.value)} placeholder={`Amount (${activePool.symbol.split("-")[0]})`} className="font-mono text-sm flex-1" />
            <Button onClick={stake} disabled={submitting} className="font-mono text-xs min-w-24 bg-amber-600 hover:bg-amber-700">
              {submitting ? "..." : "Confirm"}
            </Button>
          </div>
        </div>
      )}

      <div>
        <h2 className="font-mono text-xs uppercase tracking-widest text-muted-foreground mb-3">My Staked Positions</h2>
        {activePositions.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground/40 font-mono text-xs border border-dashed border-border/30 rounded-lg">No active stakes yet</div>
        ) : (
          <div className="space-y-2">
            {activePositions.map(p => {
              const matured = new Date(p.unlock_at).getTime() <= Date.now();
              return (
                <div key={p.id} className="bg-card border border-card-border rounded-lg px-4 py-3 flex items-center gap-3">
                  <TrendingUp className="w-4 h-4 text-amber-400 flex-shrink-0" />
                  <div className="flex-1 min-w-0 font-mono text-xs">
                    <div className="font-bold">{p.amount.toFixed(2)} {p.symbol.split("-")[0]} @ {p.apy}% APY</div>
                    <div className="text-[9px] text-muted-foreground/60">
                      {matured ? "Unlocked — ready to withdraw" : `Unlocks ${new Date(p.unlock_at).toLocaleDateString()}`}
                    </div>
                  </div>
                  <Button size="sm" variant="outline" onClick={() => unstake(p.id)} className={cn("font-mono text-[9px] gap-1", matured ? "text-emerald-400 border-emerald-500/30" : "text-muted-foreground border-border/30")}>
                    <Unlock className="w-3 h-3" /> {matured ? "Claim" : "Early exit"}
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
