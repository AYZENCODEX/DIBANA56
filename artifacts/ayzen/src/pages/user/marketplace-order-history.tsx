// Season 1 / Phase 2 — Market-level Order History page.
// This is distinct from the Polymarket-internal order history tab
// (/marketplace/polymarket?tab=order-history) — this page aggregates orders
// across every marketplace surface. Keep the labeling clear so the two aren't
// confused in the UI.
// TODO(backend): needs a real cross-market orders endpoint. All rows below are mock.
import { useState, useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { History } from "lucide-react";
import { ORDER_SOURCE_META, ORDER_STATUS_COLOR, type OrderSource } from "@/config/marketplace";
import { ORDER_HISTORY_COLUMNS } from "@/config/columns/order-history";

// Source label/icon/color and status color now live in
// @/config/marketplace.ts as ORDER_SOURCE_META / ORDER_STATUS_COLOR.
// Column labels live in @/config/columns/order-history.ts as
// ORDER_HISTORY_COLUMNS. Adding a market source, a status color, or a
// column is one entry in the relevant file.

// TODO(backend): replace with GET /api/marketplace/order-history (aggregated across sources)
const ORDER_MOCKS = [
  { id: 1, source: "azn",        product: "AZN Deposit",             type: "deposit",  amount: "+200 AZN",   status: "completed", date: "2026-07-10 14:22" },
  { id: 2, source: "nft",        product: "Genesis Badge #0442",     type: "purchase", amount: "-45 AZN",    status: "completed", date: "2026-07-09 09:03" },
  { id: 3, source: "vault",      product: "Gmail Entry Listing",     type: "sale",     amount: "+18 AZN",    status: "pending",   date: "2026-07-11 08:47" },
  { id: 4, source: "p2p",        product: "P2P Buy from AlphaTrader",type: "trade",    amount: "+50 USD",    status: "completed", date: "2026-07-08 19:15" },
  { id: 5, source: "polymarket", product: "BTC above $120k? · YES",  type: "trade",    amount: "-31 USD",    status: "completed", date: "2026-07-08 11:02" },
  { id: 6, source: "p2p",        product: "P2P Sell to NovaExchange",type: "trade",    amount: "-25 USD",    status: "failed",    date: "2026-07-06 16:40" },
  { id: 7, source: "azn",        product: "AZN Withdraw",            type: "withdraw", amount: "-75 AZN",    status: "completed", date: "2026-07-05 12:11" },
];

export default function MarketplaceOrderHistory() {
  const [sourceFilter, setSourceFilter] = useState<OrderSource | "all">("all");

  const orders = useMemo(
    () => sourceFilter === "all" ? ORDER_MOCKS : ORDER_MOCKS.filter(o => o.source === sourceFilter),
    [sourceFilter]
  );

  return (
    <div className="space-y-6 page-enter">
      <div>
        <h1 className="text-2xl font-bold font-mono tracking-tighter uppercase text-glow flex items-center gap-2">
          <History className="w-6 h-6 text-primary" /> Order History
        </h1>
        <p className="text-muted-foreground font-mono text-sm mt-0.5">
          Marketplace-wide orders across AZN, NFT, Vault, P2P &amp; Polymarket · preview data
          {" — "}
          for Polymarket-only order history see the Order History tab inside{" "}
          <span className="text-primary">Polymarket</span>.
        </p>
      </div>

      {/* Source filter chips */}
      <div className="overflow-x-auto -mx-1 px-1 pb-1">
        <div className="flex gap-1.5 min-w-max">
          <button
            onClick={() => setSourceFilter("all")}
            className={cn(
              "px-3 py-1.5 rounded-md text-[11px] font-mono font-medium border transition-all whitespace-nowrap",
              sourceFilter === "all"
                ? "bg-primary/15 border-primary/40 text-primary"
                : "bg-card/50 border-border/40 text-muted-foreground hover:border-border hover:text-foreground"
            )}
          >
            All Sources
          </button>
          {(Object.keys(ORDER_SOURCE_META) as OrderSource[]).map(src => {
            const meta = ORDER_SOURCE_META[src];
            const isActive = sourceFilter === src;
            return (
              <button
                key={src}
                onClick={() => setSourceFilter(src)}
                className={cn(
                  "flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[11px] font-mono font-medium border transition-all whitespace-nowrap",
                  isActive
                    ? "bg-primary/15 border-primary/40 text-primary"
                    : "bg-card/50 border-border/40 text-muted-foreground hover:border-border hover:text-foreground"
                )}
              >
                <meta.icon className="w-3 h-3" /> {meta.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="bg-card border border-card-border rounded-lg overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="border-card-border hover:bg-transparent">
              {ORDER_HISTORY_COLUMNS.map(col => (
                <TableHead key={col.key} className="font-mono text-[10px] uppercase text-muted-foreground/60">
                  {col.label}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {orders.length === 0 ? (
              <TableRow>
                <TableCell colSpan={ORDER_HISTORY_COLUMNS.length} className="text-center py-10 font-mono text-sm text-muted-foreground">
                  No orders for this source yet.
                </TableCell>
              </TableRow>
            ) : orders.map(o => {
              const meta = ORDER_SOURCE_META[o.source as OrderSource];
              return (
                <TableRow key={o.id} className="border-card-border">
                  <TableCell>
                    <span className={cn("flex items-center gap-1.5 font-mono text-xs", meta.color)}>
                      <meta.icon className="w-3.5 h-3.5" /> {meta.label}
                    </span>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{o.product}</TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground capitalize">{o.type}</TableCell>
                  <TableCell className={cn("font-mono text-xs font-bold", o.amount.startsWith("+") ? "text-emerald-400" : "text-red-400")}>{o.amount}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className={cn("font-mono text-[9px] uppercase", ORDER_STATUS_COLOR[o.status])}>{o.status}</Badge>
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">{o.date}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

