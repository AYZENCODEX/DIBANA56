/**
 * components/finance/finance-depreciation.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Depreciation schedule for a single fixed asset. If no schedule exists yet,
 * shows a small "Generate" form (method + useful life + salvage value); once
 * generated, shows the period table with a "Post" action per row — which
 * posts the real Depreciation Expense / Accumulated Depreciation journal
 * lines on the backend and syncs the asset's book value.
 * Mirrors finance-amortization.tsx.
 */
import { useEffect, useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Loader2, TrendingDown, CheckCircle2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { financeApi } from "@/lib/finance-api";
import type { FinanceAsset, DepreciationRow } from "@/config/finance";
import { fmtMoney } from "@/config/finance";

export function FinanceDepreciation({ asset, onAssetChanged }: { asset: FinanceAsset; onAssetChanged?: () => void }) {
  const { token } = useAuth();
  const { toast } = useToast();
  const [rows, setRows] = useState<DepreciationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [method, setMethod] = useState<"straight_line" | "declining_balance">(asset.depreciationMethod ?? "straight_line");
  const [usefulLife, setUsefulLife] = useState(String(asset.usefulLifeMonths ?? 36));
  const [salvage, setSalvage] = useState(String(asset.salvageValue ?? 0));
  const [generating, setGenerating] = useState(false);
  const [postingId, setPostingId] = useState<number | null>(null);

  const load = () => {
    setLoading(true);
    financeApi.listDepreciation(token, asset.id)
      .then(setRows)
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [asset.id]);

  const handleGenerate = async () => {
    const months = parseInt(usefulLife, 10);
    if (!months || months < 1) { toast({ variant: "destructive", title: "Useful life must be at least 1 month" }); return; }
    setGenerating(true);
    try {
      const generated = await financeApi.generateDepreciation(token, asset.id, {
        method, usefulLifeMonths: months, salvageValue: parseFloat(salvage) || 0,
      });
      setRows(generated);
      onAssetChanged?.();
      toast({ title: "Depreciation schedule generated" });
    } catch (e: any) {
      toast({ variant: "destructive", title: "Failed to generate schedule", description: e?.message });
    } finally {
      setGenerating(false);
    }
  };

  const handlePost = async (id: number) => {
    setPostingId(id);
    try {
      await financeApi.postDepreciationPeriod(token, id);
      load();
      onAssetChanged?.();
      toast({ title: "Depreciation posted" });
    } catch (e: any) {
      toast({ variant: "destructive", title: "Failed to post", description: e?.message });
    } finally {
      setPostingId(null);
    }
  };

  if (loading) {
    return <div className="flex justify-center py-6"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>;
  }

  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border p-4 space-y-3">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <TrendingDown className="h-4 w-4" />
          Kono depreciation schedule nei — method o useful life diye generate koro.
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Select value={method} onValueChange={v => setMethod(v as any)}>
            <SelectTrigger className="w-44 h-8 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="straight_line">Straight-line</SelectItem>
              <SelectItem value="declining_balance">Declining balance</SelectItem>
            </SelectContent>
          </Select>
          <Input
            type="number" min={1} value={usefulLife}
            onChange={e => setUsefulLife(e.target.value)}
            placeholder="Useful life (months)" className="w-40 h-8 text-xs"
          />
          <Input
            type="number" min={0} value={salvage}
            onChange={e => setSalvage(e.target.value)}
            placeholder="Salvage value" className="w-32 h-8 text-xs"
          />
          <Button size="sm" onClick={handleGenerate} disabled={generating}>
            {generating ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : null}
            Generate
          </Button>
        </div>
      </div>
    );
  }

  const postedCount = rows.filter(r => r.status === "posted").length;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-[10px] uppercase tracking-wide text-muted-foreground/70">
          Depreciation — {postedCount}/{rows.length} posted
        </p>
        <Button size="sm" variant="ghost" className="h-6 text-[11px] px-2" onClick={handleGenerate} disabled={generating}>
          {generating ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
          Regenerate
        </Button>
      </div>
      <div className="rounded-lg border border-card-border overflow-hidden overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">#</TableHead>
              <TableHead>Period</TableHead>
              <TableHead>Depreciation</TableHead>
              <TableHead>Accumulated</TableHead>
              <TableHead>Book Value</TableHead>
              <TableHead className="w-24" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map(r => (
              <TableRow key={r.id} className={cn(r.status === "posted" && "opacity-60")}>
                <TableCell className="font-mono text-xs">{r.periodNo}</TableCell>
                <TableCell className="text-xs">{new Date(r.periodDate).toLocaleDateString()}</TableCell>
                <TableCell className="font-mono text-xs">{fmtMoney(r.depreciationAmount)}</TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">{fmtMoney(r.accumulatedDepreciation)}</TableCell>
                <TableCell className="font-mono text-xs font-semibold">{fmtMoney(r.bookValue)}</TableCell>
                <TableCell>
                  {r.status === "posted" ? (
                    <Badge variant="outline" className="text-success border-success/30 bg-success/10 gap-1">
                      <CheckCircle2 className="h-3 w-3" /> Posted
                    </Badge>
                  ) : (
                    <Button
                      size="sm" variant="outline" className="h-6 text-[11px] px-2"
                      disabled={postingId === r.id}
                      onClick={() => handlePost(r.id)}
                    >
                      {postingId === r.id ? <Loader2 className="h-3 w-3 animate-spin" /> : "Post"}
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
