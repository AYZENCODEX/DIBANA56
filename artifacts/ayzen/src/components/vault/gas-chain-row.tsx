import { Fuel, Send, Repeat } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { GasRiskBadge } from "@/components/vault/gas-risk-badge";
import type { GasChainSnapshot } from "@/lib/gas-health-api";

/**
 * One chain's gas row: balance, live gas price, and the real-time
 * simulation — how many more plain sends / ERC-20 transfers (USDT, USDC,
 * ARB, ...) the current native-coin balance can still pay for right now.
 */
export function GasChainRow({ snapshot }: { snapshot: GasChainSnapshot }) {
  const s = snapshot;
  return (
    <div className="bg-muted/10 rounded-lg border border-border/20 px-3 py-2.5 space-y-2">
      <div className="flex items-center gap-2">
        <Badge variant="outline" className="font-mono text-[9px] flex-shrink-0">{s.chain}</Badge>
        <span className="font-mono text-xs font-bold text-foreground">
          {s.balance.toLocaleString(undefined, { maximumFractionDigits: 5 })} {s.nativeSymbol}
        </span>
        <span className="font-mono text-[10px] text-muted-foreground/50">
          (${s.balanceUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })})
        </span>
        <GasRiskBadge risk={s.risk} className="ml-auto" />
      </div>

      {s.error ? (
        <p className="font-mono text-[9px] text-red-400/70">RPC error — {s.error}</p>
      ) : (
        <div className="flex items-center gap-4 font-mono text-[9.5px] text-muted-foreground/60">
          <span className="flex items-center gap-1">
            <Fuel className="w-3 h-3 text-primary/60" /> {s.gasPriceGwei.toLocaleString(undefined, { maximumFractionDigits: 2 })} gwei
          </span>
          <span className="flex items-center gap-1" title="Plain native-coin sends this balance can still pay for">
            <Send className="w-3 h-3 text-cyan-400/70" /> ~{s.nativeSendCapacity.toLocaleString()} sends left
          </span>
          <span className="flex items-center gap-1" title="ERC-20 transfer() calls (USDT/USDC/ARB/...) this balance can still pay for">
            <Repeat className="w-3 h-3 text-violet-400/70" /> ~{s.erc20TransferCapacity.toLocaleString()} token txs left
          </span>
        </div>
      )}
    </div>
  );
}
