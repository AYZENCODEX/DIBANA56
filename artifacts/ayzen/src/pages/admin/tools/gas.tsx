import { useEffect, useState, useCallback } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Fuel, RefreshCw, TrendingUp, Radio, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";
const AUTO_REFRESH_INTERVAL = 30_000;

const NETWORK_UNITS: Record<string, string> = {
  ethereum: "Gwei", bsc: "Gwei", polygon: "Gwei", avalanche: "nAVAX",
  fantom: "Gwei", moonbeam: "Gwei", cronos: "Gwei", klaytn: "Ston",
  default: "Gwei",
};

const NETWORK_COLORS: Record<string, string> = {
  ethereum: "text-blue-400", arbitrum: "text-blue-300", optimism: "text-red-400",
  polygon: "text-purple-400", bsc: "text-yellow-400", avalanche: "text-red-500",
  zksync: "text-violet-400", base: "text-blue-500", scroll: "text-yellow-300",
  linea: "text-green-400", blast: "text-yellow-500", berachain: "text-orange-400",
  sei: "text-cyan-400", starknet: "text-purple-300", mantle: "text-teal-400",
  default: "text-primary",
};

interface GasPrice {
  network: string; networkId: string; baseGas: number;
  slow: number; standard: number; fast: number;
  usdPerTx: number; nativePrice: number; source?: string;
  updatedAt: string;
}

function fmtGas(val: number): string {
  if (val === 0) return "0";
  if (val < 0.001) return val.toExponential(2);
  if (val < 1) return val.toFixed(4);
  if (val < 100) return val.toFixed(2);
  return Math.round(val).toLocaleString();
}

function getUnit(networkId: string): string { return NETWORK_UNITS[networkId] ?? NETWORK_UNITS.default; }
function getColor(networkId: string): string { return NETWORK_COLORS[networkId] ?? NETWORK_COLORS.default; }
function getUsdClass(usd: number): string {
  if (usd < 0.10) return "text-green-400";
  if (usd < 1.00) return "text-yellow-400";
  return "text-red-400";
}

export default function AdminGas() {
  const [prices, setPrices] = useState<GasPrice[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [live, setLive] = useState(false);
  const [countdown, setCountdown] = useState(AUTO_REFRESH_INTERVAL / 1000);
  const token = localStorage.getItem("ayzen_token") ?? "";

  const fetchGas = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${BASE}/api/tools/gas`, { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      setPrices(Array.isArray(data) ? data : []);
      setUpdatedAt(new Date());
      setLive(true);
    } catch {
      setLive(false);
    } finally {
      setLoading(false);
      setCountdown(AUTO_REFRESH_INTERVAL / 1000);
    }
  }, [token]);

  useEffect(() => { fetchGas(); }, [fetchGas]);

  // Auto-refresh every 30s
  useEffect(() => {
    const interval = setInterval(fetchGas, AUTO_REFRESH_INTERVAL);
    return () => clearInterval(interval);
  }, [fetchGas]);

  // Countdown ticker
  useEffect(() => {
    const tick = setInterval(() => setCountdown(c => Math.max(0, c - 1)), 1000);
    return () => clearInterval(tick);
  }, []);

  const eth = prices?.find(p => p.networkId === "ethereum");
  const cheapest = prices ? [...prices].sort((a, b) => (a.usdPerTx ?? 0) - (b.usdPerTx ?? 0))[0] : null;
  const avgUsd = prices ? prices.reduce((s, p) => s + (p.usdPerTx ?? 0), 0) / prices.length : 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold font-mono tracking-tighter uppercase flex items-center gap-2">
            <Fuel className="w-6 h-6 text-primary" />
            Gas Tracker
          </h1>
          <div className="flex items-center gap-3 mt-1">
            <div className={cn(
              "flex items-center gap-1.5 px-2 py-0.5 rounded border text-[10px] font-mono",
              live ? "bg-emerald-400/10 border-emerald-400/20 text-emerald-400" : "bg-red-400/10 border-red-400/20 text-red-400"
            )}>
              <Radio className={cn("w-3 h-3", live && "animate-pulse")} />
              {live ? "LIVE" : "OFFLINE"}
            </div>
            <p className="text-muted-foreground font-mono text-xs">
              {prices?.length ?? 0} chains · ETH source: Etherscan
              {updatedAt && <span className="ml-2 text-muted-foreground/50">· Updated {updatedAt.toLocaleTimeString()}</span>}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="font-mono text-[11px] text-muted-foreground/50 border border-card-border rounded px-2 py-1">
            Refresh in {countdown}s
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={fetchGas}
            className="font-mono uppercase text-xs border-card-border"
            disabled={loading}
          >
            <RefreshCw className={cn("h-4 w-4 mr-2", loading && "animate-spin")} />
            Refresh Now
          </Button>
        </div>
      </div>

      {/* Summary row */}
      {prices && prices.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          {eth && (
            <Card className="bg-card border-card-border shadow-none">
              <CardContent className="p-4">
                <div className="text-[10px] font-mono uppercase text-muted-foreground mb-1">Ethereum Standard</div>
                <div className="text-2xl font-mono font-bold text-blue-400">{fmtGas(eth.standard)} Gwei</div>
                <div className={cn("text-xs font-mono mt-1", getUsdClass(eth.usdPerTx))}>≈ ${eth.usdPerTx.toFixed(3)} per swap</div>
                {eth.nativePrice > 0 && <div className="text-[10px] font-mono text-muted-foreground/50 mt-1">ETH = ${eth.nativePrice.toLocaleString()}</div>}
              </CardContent>
            </Card>
          )}
          {cheapest && (
            <Card className="bg-card border-card-border shadow-none">
              <CardContent className="p-4">
                <div className="text-[10px] font-mono uppercase text-muted-foreground mb-1 flex items-center gap-1">
                  <TrendingUp className="w-3 h-3 text-green-400" /> Cheapest Chain
                </div>
                <div className={cn("text-2xl font-mono font-bold", getColor(cheapest.networkId))}>{cheapest.network}</div>
                <div className="text-green-400 text-xs font-mono mt-1">≈ ${cheapest.usdPerTx.toFixed(4)} per swap</div>
              </CardContent>
            </Card>
          )}
          <Card className="bg-card border-card-border shadow-none">
            <CardContent className="p-4">
              <div className="text-[10px] font-mono uppercase text-muted-foreground mb-1 flex items-center gap-1">
                <Zap className="w-3 h-3 text-amber-400" /> Avg Swap Cost
              </div>
              <div className={cn("text-2xl font-mono font-bold", getUsdClass(avgUsd))}>${avgUsd.toFixed(3)}</div>
              <div className="text-[10px] font-mono text-muted-foreground/50 mt-1">across {prices.length} networks</div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Network cards */}
      {loading && !prices ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
          {Array.from({ length: 12 }).map((_, i) => <Skeleton key={i} className="h-32 w-full" />)}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
          {prices?.map((p) => {
            const color = getColor(p.networkId);
            const unit = getUnit(p.networkId);
            return (
              <Card key={p.networkId} className="bg-card border-card-border shadow-none hover:border-primary/20 transition-colors">
                <CardContent className="p-4">
                  <div className="flex items-center justify-between mb-3">
                    <span className={cn("font-mono font-bold text-sm", color)}>{p.network}</span>
                    <div className="flex items-center gap-1">
                      {p.source === "etherscan" && (
                        <span className="text-[8px] font-mono text-emerald-400 bg-emerald-400/10 border border-emerald-400/20 rounded px-1">LIVE</span>
                      )}
                      <span className={cn("text-[10px] font-mono font-bold", getUsdClass(p.usdPerTx))}>
                        ${p.usdPerTx < 0.001 ? p.usdPerTx.toExponential(2) : p.usdPerTx.toFixed(3)}
                      </span>
                    </div>
                  </div>
                  <div className="space-y-1">
                    {[
                      { label: "Slow", val: p.slow, cls: "text-muted-foreground" },
                      { label: "Standard", val: p.standard, cls: "text-foreground font-bold" },
                      { label: "Fast", val: p.fast, cls: "text-amber-400" },
                    ].map(row => (
                      <div key={row.label} className="flex justify-between items-center">
                        <span className="font-mono text-[10px] text-muted-foreground/60 uppercase">{row.label}</span>
                        <span className={cn("font-mono text-[11px]", row.cls)}>{fmtGas(row.val)} {unit}</span>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {loading && prices && (
        <div className="flex items-center justify-center gap-2 text-xs font-mono text-muted-foreground py-2">
          <RefreshCw className="w-3 h-3 animate-spin" /> Fetching live prices...
        </div>
      )}
    </div>
  );
}
