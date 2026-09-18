import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Plus, Pencil, Trash2, Users, Wallet, Landmark, Smartphone, Lock, Boxes, TrendingUp, TrendingDown, CalendarClock, Droplets } from "lucide-react";
import { financeApi } from "@/lib/finance-api";
import { FinanceAssetDialog } from "@/components/finance/finance-asset-dialog";
import { FinanceDepreciation } from "@/components/finance/finance-depreciation";
import type { AssetType, FinanceAsset } from "@/config/finance";
import { ASSET_TYPE_LABELS, ASSET_TYPE_LIQUIDITY_HINT, fmtMoney, myShareOf } from "@/config/finance";
import { FinancePageHeader, FinanceHero, FinanceCard, StatTile, FinanceEmptyState, FinanceLoader } from "@/components/finance/finance-ui";
import { DonutBreakdown, GainLossBadge } from "@/components/finance/finance-widgets";
import { cn } from "@/lib/utils";

const TABS: { value: AssetType | "all"; label: string; icon: any }[] = [
  { value: "all", label: "Overview", icon: Wallet },
  { value: "cash", label: "Cash", icon: Wallet },
  { value: "bank", label: "Bank", icon: Landmark },
  { value: "online", label: "Online", icon: Smartphone },
  { value: "mutual_fund", label: "Mutual Funds", icon: Boxes },
  { value: "locked", label: "Locked", icon: Lock },
  { value: "other", label: "Other", icon: Boxes },
];

function AssetCard({ asset, onEdit, onDelete, expanded, onToggleExpand, onAssetChanged }: {
  asset: FinanceAsset; onEdit: () => void; onDelete: () => void;
  expanded: boolean; onToggleExpand: () => void; onAssetChanged: () => void;
}) {
  const mine = myShareOf(asset);
  const isJoint = asset.owners.length > 1 || asset.owners.some(o => o.partyId != null);
  return (
    <FinanceCard className="animate-fade-up space-y-2.5" hover>
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="font-semibold">{asset.name}</p>
          {asset.provider && <p className="text-xs text-muted-foreground">{asset.provider}</p>}
        </div>
        <div className="flex gap-1">
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onToggleExpand} title="Depreciation">
            <TrendingDown className={cn("h-3.5 w-3.5", asset.depreciationMethod && "text-primary")} />
          </Button>
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onEdit}><Pencil className="h-3.5 w-3.5" /></Button>
          <Button variant="ghost" size="icon" className="h-7 w-7 text-danger" onClick={onDelete}><Trash2 className="h-3.5 w-3.5" /></Button>
        </div>
      </div>

      <div className="flex items-baseline gap-2 flex-wrap">
        <span className="text-lg font-bold font-mono">{fmtMoney(mine)}</span>
        {isJoint && <span className="text-xs text-muted-foreground">of {fmtMoney(asset.totalValue)} total</span>}
        <GainLossBadge current={asset.totalValue} cost={asset.purchasedValue} />
      </div>

      {isJoint && (
        <div className="flex items-center gap-1.5 flex-wrap pt-1">
          <Users className="h-3 w-3 text-muted-foreground" />
          {asset.owners.map((o, i) => (
            <Badge key={i} variant="outline" className="text-[10px]">
              {o.partyId == null ? "You" : o.ownerName} · {o.ownershipPercent}%
            </Badge>
          ))}
        </div>
      )}

      {asset.interestRate != null && (
        <p className="text-xs text-muted-foreground">
          Rate: {asset.interestRate}%{asset.maturityDate && ` · matures ${new Date(asset.maturityDate).toLocaleDateString()}`}
        </p>
      )}
      {asset.liquidity && <p className="text-xs text-muted-foreground">Liquidity: {asset.liquidity}</p>}

      {expanded && (
        <div className="pt-2 border-t border-border">
          <FinanceDepreciation asset={asset} onAssetChanged={onAssetChanged} />
        </div>
      )}
    </FinanceCard>
  );
}

export default function FinanceAssetsPage() {
  const { token, isLoading: authLoading } = useAuth();
  const { toast } = useToast();
  const [assets, setAssets] = useState<FinanceAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<string>("all");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editAsset, setEditAsset] = useState<FinanceAsset | null>(null);
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const load = useCallback(() => {
    if (authLoading || !token) return;
    setLoading(true);
    financeApi.listAssets(token).then(setAssets).catch(() => {}).finally(() => setLoading(false));
  }, [token, authLoading]);

  useEffect(() => { load(); }, [load]);

  const filtered = tab === "all" ? assets : assets.filter(a => a.assetType === tab);
  const myTotal = assets.reduce((s, a) => s + myShareOf(a), 0);

  const byType = (Object.keys(ASSET_TYPE_LABELS) as AssetType[]).map(t => ({
    type: t,
    value: assets.filter(a => a.assetType === t).reduce((s, a) => s + myShareOf(a), 0),
  })).filter(x => x.value > 0);

  const allocationData = byType.map(x => ({ label: ASSET_TYPE_LABELS[x.type], value: x.value }));

  const liquidityTotals = assets.reduce<Record<string, number>>((acc, a) => {
    const hint = a.liquidity || ASSET_TYPE_LIQUIDITY_HINT[a.assetType] || "Varies";
    acc[hint] = (acc[hint] ?? 0) + myShareOf(a);
    return acc;
  }, {});

  const totalCost = assets.reduce((s, a) => s + (a.purchasedValue ?? a.totalValue), 0);
  const totalCurrent = assets.reduce((s, a) => s + a.totalValue, 0);
  const totalGain = totalCurrent - totalCost;
  const gainPct = totalCost > 0 ? (totalGain / totalCost) * 100 : 0;

  const upcomingMaturities = assets
    .filter(a => a.maturityDate && new Date(a.maturityDate).getTime() - Date.now() <= 90 * 86400000)
    .sort((a, b) => new Date(a.maturityDate!).getTime() - new Date(b.maturityDate!).getTime());

  const handleDelete = async (id: number) => {
    if (!confirm("Delete this asset?")) return;
    try {
      await financeApi.deleteAsset(token, id);
      toast({ title: "Deleted" });
      load();
    } catch (e: any) {
      toast({ variant: "destructive", title: "Failed", description: e?.message });
    }
  };

  return (
    <div className="space-y-5 page-enter">
      <FinancePageHeader
        eyebrow="Finance"
        title="Assets"
        description="Amar hate/account e ekhon ki ase — cash theke mutual fund porjonto"
        actions={<Button size="sm" onClick={() => { setEditAsset(null); setDialogOpen(true); }}><Plus className="h-4 w-4 mr-1.5" /> Add Asset</Button>}
      />

      <FinanceHero eyebrow="Net Asset Value" label="My share across every asset" value={fmtMoney(myTotal)} tone="success" />

      {!loading && assets.length > 0 && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <StatTile icon={Boxes} label="Assets" value={assets.length} tone="neutral" />
            <StatTile
              icon={totalGain >= 0 ? TrendingUp : TrendingDown}
              label="Unrealized Gain/Loss"
              value={fmtMoney(totalGain)}
              sublabel={`${totalGain >= 0 ? "+" : ""}${gainPct.toFixed(1)}%`}
              tone={totalGain >= 0 ? "success" : "danger"}
            />
            {Object.entries(liquidityTotals).slice(0, 2).map(([label, value]) => (
              <StatTile key={label} icon={Droplets} label={`${label} Liquidity`} value={fmtMoney(value)} tone="info" />
            ))}
          </div>

          <div className="grid lg:grid-cols-2 gap-4">
            <DonutBreakdown title="Allocation by Type" data={allocationData} />
            <FinanceCard className="space-y-3">
              <p className="text-sm font-semibold flex items-center gap-1.5"><CalendarClock className="h-4 w-4 text-primary" /> Upcoming Maturities (90d)</p>
              {upcomingMaturities.length === 0 ? (
                <div className="h-40 flex items-center justify-center text-xs text-muted-foreground">Kono upcoming maturity nei</div>
              ) : (
                <div className="divide-y divide-border">
                  {upcomingMaturities.map(a => {
                    const days = Math.ceil((new Date(a.maturityDate!).getTime() - Date.now()) / 86400000);
                    return (
                      <div key={a.id} className="flex items-center justify-between py-2 text-sm">
                        <div>
                          <p className="font-medium">{a.name}</p>
                          <p className="text-xs text-muted-foreground">{ASSET_TYPE_LABELS[a.assetType]}</p>
                        </div>
                        <div className="text-right">
                          <p className="font-mono text-sm">{fmtMoney(a.totalValue)}</p>
                          <p className={cn("text-[10px]", days <= 7 ? "text-danger" : "text-warning")}>
                            {days < 0 ? `Overdue ${Math.abs(days)}d` : `In ${days}d`}
                          </p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </FinanceCard>
          </div>
        </>
      )}

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="flex-wrap h-auto">
          {TABS.map(t => (
            <TabsTrigger key={t.value} value={t.value} className="gap-1.5">
              <t.icon className="h-3.5 w-3.5" /> {t.label}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value={tab} className="mt-4">
          {tab === "all" && byType.length > 0 && (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-4">
              {byType.map(x => (
                <FinanceCard key={x.type} className="p-3" hover>
                  <p className="text-xs text-muted-foreground">{ASSET_TYPE_LABELS[x.type]}</p>
                  <p className="font-mono font-semibold">{fmtMoney(x.value)}</p>
                </FinanceCard>
              ))}
            </div>
          )}

          {loading ? (
            <FinanceLoader />
          ) : filtered.length === 0 ? (
            <FinanceEmptyState icon={Wallet} title="Kono asset add kora hoyni ekhono ei category te" />
          ) : (
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {filtered.map(a => (
                <AssetCard
                  key={a.id}
                  asset={a}
                  onEdit={() => { setEditAsset(a); setDialogOpen(true); }}
                  onDelete={() => handleDelete(a.id)}
                  expanded={expandedId === a.id}
                  onToggleExpand={() => setExpandedId(id => id === a.id ? null : a.id)}
                  onAssetChanged={load}
                />
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>

      <FinanceAssetDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        defaultType={tab === "all" ? "cash" : (tab as AssetType)}
        asset={editAsset}
        onSaved={load}
      />
    </div>
  );
}
