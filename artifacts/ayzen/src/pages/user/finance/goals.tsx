import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Plus, Trash2, Pencil, Target, TrendingDown, Landmark,
  ArrowDownToLine, ArrowUpFromLine, Camera, CircleCheck,
} from "lucide-react";
import { financeApi } from "@/lib/finance-api";
import type { FinanceGoal, NetWorthBreakdown, NetWorthSnapshot } from "@/config/finance";
import { fmtMoney, GOAL_TYPE_LABELS, GOAL_STATUS_STYLES, goalProgressPct } from "@/config/finance";
import { cn } from "@/lib/utils";
import {
  FinancePageHeader, FinanceHero, StatTile, SectionEyebrow, FinanceCard,
  FinanceEmptyState, FinanceLoader, FinanceProgress,
} from "@/components/finance/finance-ui";
import { NetWorthTrendChart } from "@/components/finance/finance-widgets";
import { FinanceGoalDialog } from "@/components/finance/finance-goal-dialog";

function ContributeRow({ goal, onContributed }: { goal: FinanceGoal; onContributed: () => void }) {
  const { token } = useAuth();
  const { toast } = useToast();
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);

  if (goal.linkedAssetId != null || goal.status !== "active") return null;

  const submit = async () => {
    const val = parseFloat(amount);
    if (!val || val <= 0) return;
    setBusy(true);
    try {
      await financeApi.contributeToGoal(token, goal.id, val);
      setAmount("");
      onContributed();
    } catch (e: any) {
      toast({ variant: "destructive", title: "Failed", description: e?.message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-2">
      <Input type="number" placeholder="Contribute amount" value={amount} onChange={e => setAmount(e.target.value)} className="h-8 text-sm" />
      <Button size="sm" className="h-8 shrink-0" disabled={busy} onClick={submit}>Add</Button>
    </div>
  );
}

export default function FinanceGoalsPage() {
  const { token, isLoading: authLoading } = useAuth();
  const { toast } = useToast();
  const [goals, setGoals] = useState<FinanceGoal[]>([]);
  const [breakdown, setBreakdown] = useState<NetWorthBreakdown | null>(null);
  const [history, setHistory] = useState<NetWorthSnapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<FinanceGoal | null>(null);
  const [snapshotting, setSnapshotting] = useState(false);

  const load = useCallback(() => {
    if (authLoading || !token) return;
    setLoading(true);
    Promise.all([
      financeApi.listGoals(token),
      financeApi.netWorth(token),
      financeApi.netWorthHistory(token, 12),
    ]).then(([g, b, h]) => { setGoals(g); setBreakdown(b); setHistory(h); }).catch(() => {}).finally(() => setLoading(false));
  }, [token, authLoading]);

  useEffect(() => { load(); }, [load]);

  const handleDelete = async (id: number) => {
    if (!confirm("Delete this goal?")) return;
    try {
      await financeApi.deleteGoal(token, id);
      toast({ title: "Deleted" });
      load();
    } catch (e: any) {
      toast({ variant: "destructive", title: "Failed", description: e?.message });
    }
  };

  const handleSnapshot = async () => {
    setSnapshotting(true);
    try {
      await financeApi.snapshotNetWorthNow(token);
      toast({ title: "Net worth snapshotted" });
      load();
    } catch (e: any) {
      toast({ variant: "destructive", title: "Failed", description: e?.message });
    } finally {
      setSnapshotting(false);
    }
  };

  if (loading) return <FinanceLoader />;

  const activeGoals = goals.filter(g => g.status === "active");
  const achievedGoals = goals.filter(g => g.status === "achieved");

  return (
    <div className="space-y-6 page-enter">
      <FinancePageHeader
        eyebrow="Finance · Goals"
        title="Goals & Net Worth"
        description="Savings/debt-payoff targets ar time-er sathe net worth trend"
        actions={
          <>
            <Button size="sm" variant="outline" disabled={snapshotting} onClick={handleSnapshot}>
              <Camera className="h-4 w-4 mr-1.5" /> Snapshot Now
            </Button>
            <Button size="sm" onClick={() => { setEditing(null); setDialogOpen(true); }}>
              <Plus className="h-4 w-4 mr-1.5" /> New Goal
            </Button>
          </>
        }
      />

      {breakdown && (
        <FinanceHero
          eyebrow="Current"
          label="Net Worth"
          value={fmtMoney(breakdown.netWorth)}
          tone={breakdown.netWorth >= 0 ? "success" : "danger"}
        >
          <div className="grid grid-cols-2 gap-2 text-right">
            <div>
              <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Assets</p>
              <p className="font-mono text-sm text-success">{fmtMoney(breakdown.totalAssets)}</p>
            </div>
            <div>
              <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Owed</p>
              <p className="font-mono text-sm text-danger">{fmtMoney(breakdown.totalPayable + breakdown.totalBorrowed)}</p>
            </div>
          </div>
        </FinanceHero>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatTile icon={Landmark} label="Assets" value={fmtMoney(breakdown?.totalAssets ?? 0)} tone="success" />
        <StatTile icon={ArrowDownToLine} label="Receivable" value={fmtMoney(breakdown?.totalReceivable ?? 0)} tone="info" />
        <StatTile icon={ArrowUpFromLine} label="Payable" value={fmtMoney(breakdown?.totalPayable ?? 0)} tone="warning" />
        <StatTile icon={TrendingDown} label="Borrowed" value={fmtMoney(breakdown?.totalBorrowed ?? 0)} tone="danger" />
      </div>

      <NetWorthTrendChart snapshots={history} />

      <div className="space-y-2.5">
        <SectionEyebrow icon={Target}>Active Goals</SectionEyebrow>
        {activeGoals.length === 0 ? (
          <FinanceEmptyState icon={Target} title="Kono active goal nei" description="Ekta savings ba debt-payoff goal create koro." />
        ) : (
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {activeGoals.map((g, i) => {
              const pct = goalProgressPct(g);
              return (
                <FinanceCard key={g.id} className="animate-fade-up space-y-3" hover>
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="font-semibold">{g.title}</p>
                      <Badge variant="outline" className="mt-1 text-[10px]">{GOAL_TYPE_LABELS[g.goalType]}</Badge>
                    </div>
                    <div className="flex gap-1 shrink-0">
                      <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => { setEditing(g); setDialogOpen(true); }}><Pencil className="h-3.5 w-3.5" /></Button>
                      <Button variant="ghost" size="icon" className="h-7 w-7 text-danger" onClick={() => handleDelete(g.id)}><Trash2 className="h-3.5 w-3.5" /></Button>
                    </div>
                  </div>
                  <FinanceProgress pct={pct} tone={pct >= 100 ? "success" : pct > 60 ? "primary" : "warning"} />
                  <div className="flex justify-between text-xs">
                    <span className="font-mono text-foreground font-semibold">{fmtMoney(g.currentAmount, g.currency)}</span>
                    <span className="text-muted-foreground font-mono">of {fmtMoney(g.targetAmount, g.currency)}</span>
                  </div>
                  {g.targetDate && (
                    <p className="text-[11px] text-muted-foreground">Target: {new Date(g.targetDate).toLocaleDateString()}</p>
                  )}
                  <ContributeRow goal={g} onContributed={load} />
                </FinanceCard>
              );
            })}
          </div>
        )}
      </div>

      {achievedGoals.length > 0 && (
        <div className="space-y-2.5">
          <SectionEyebrow icon={CircleCheck}>Achieved</SectionEyebrow>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {achievedGoals.map(g => (
              <FinanceCard key={g.id} className="space-y-2 opacity-80" hover={false}>
                <div className="flex items-center justify-between">
                  <p className="font-semibold">{g.title}</p>
                  <Badge className={cn("text-[10px]", GOAL_STATUS_STYLES.achieved)}>Achieved</Badge>
                </div>
                <p className="text-xs font-mono text-success">{fmtMoney(g.currentAmount, g.currency)} / {fmtMoney(g.targetAmount, g.currency)}</p>
              </FinanceCard>
            ))}
          </div>
        </div>
      )}

      <FinanceGoalDialog open={dialogOpen} onOpenChange={setDialogOpen} goal={editing} onSaved={load} />
    </div>
  );
}
