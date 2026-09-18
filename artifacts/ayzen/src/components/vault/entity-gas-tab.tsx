import { useState, useEffect, useCallback } from "react";
import { Fuel, RefreshCw, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { getEntityGas, type EntityGasDetail } from "@/lib/gas-health-api";
import { GasRiskBadge } from "@/components/vault/gas-risk-badge";
import { GasChainRow } from "@/components/vault/gas-chain-row";

/**
 * Gas tab for a single Vault entity's detail page — live per-chain native-coin
 * balance, current gas price, and a real-time simulation of how many more
 * sends/token transfers that entity's wallet(s) can still afford. Mirrors the
 * "Live Wallet Worth" panel on the Wallet tab, but for gas instead of total worth.
 */
export function EntityGasTab({ entryId }: { entryId: number }) {
  const [data, setData] = useState<EntityGasDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (isRefresh = false) => {
    isRefresh ? setRefreshing(true) : setLoading(true);
    try {
      const result = await getEntityGas(entryId);
      setData(result);
    } finally {
      isRefresh ? setRefreshing(false) : setLoading(false);
    }
  }, [entryId]);

  useEffect(() => { load(); }, [load]);

  if (loading) {
    return <div className="flex items-center justify-center py-16"><Loader2 className="w-5 h-5 text-primary animate-spin" /></div>;
  }

  const chainsWithBalance = (data?.chains ?? []).filter((c) => c.balance > 0 || c.error);

  return (
    <div className="space-y-4">
      <div className="bg-card border border-card-border rounded-xl px-4 py-3 flex items-center justify-between gap-3">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground/50 flex items-center gap-1.5">
            <Fuel className="w-3 h-3" /> Gas On Hand
          </p>
          <div className="flex items-center gap-2 mt-0.5">
            <p className="font-mono text-lg font-bold text-foreground">
              ${(data?.totalUsd ?? 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}
            </p>
            {data && <GasRiskBadge risk={data.risk} />}
          </div>
        </div>
        <Button
          size="sm" variant="outline" disabled={refreshing}
          onClick={() => load(true)}
          className="font-mono text-[10px] gap-1.5 flex-shrink-0"
        >
          <RefreshCw className={cn("w-3 h-3", refreshing && "animate-spin")} />
          {refreshing ? "Checking chains…" : "Refresh"}
        </Button>
      </div>

      {data?.message ? (
        <div className="bg-card border border-card-border rounded-xl p-8 text-center">
          <Fuel className="w-8 h-8 text-muted-foreground/20 mx-auto mb-2" />
          <p className="font-mono text-xs text-muted-foreground/40">{data.message}</p>
        </div>
      ) : chainsWithBalance.length === 0 ? (
        <div className="bg-card border border-card-border rounded-xl p-8 text-center">
          <Fuel className="w-8 h-8 text-muted-foreground/20 mx-auto mb-2" />
          <p className="font-mono text-xs text-muted-foreground/40">No native-coin gas found on any watched chain yet</p>
        </div>
      ) : (
        <div className="space-y-2">
          <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground/40 px-1">
            Per-Chain Gas — real-time simulation
          </p>
          {chainsWithBalance.map((c) => <GasChainRow key={`${c.chain}-${c.address}`} snapshot={c} />)}
        </div>
      )}

      <p className="font-mono text-[9px] text-muted-foreground/30 leading-relaxed px-1">
        "Sends left" / "token txs left" are estimated from the current live gas price and native balance —
        gas prices move constantly, so treat these as a real-time estimate, not a guarantee.
      </p>
    </div>
  );
}
