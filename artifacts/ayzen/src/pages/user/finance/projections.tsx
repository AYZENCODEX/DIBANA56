import { useEffect, useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { Sparkles, Wallet } from "lucide-react";
import { financeApi } from "@/lib/finance-api";
import { fmtMoney } from "@/config/finance";
import { cn } from "@/lib/utils";
import { FinancePageHeader, StatTile, SectionEyebrow, FinanceCard, FinanceLoader, FinanceEmptyState } from "@/components/finance/finance-ui";

interface Scenario { months: number; currentTrend: number; allReceivablesCollected: number; allPayablesPaid: number; }
interface Projections { monthlyIncome: number; monthlyExpense: number; monthlyNet: number; currentBalance: number; scenarios: Scenario[]; }

export default function FinanceProjectionsPage() {
  const { token, isLoading: authLoading } = useAuth();
  const [data, setData] = useState<Projections | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (authLoading || !token) return;
    financeApi.projections(token).then(setData).catch(() => {}).finally(() => setLoading(false));
  }, [token, authLoading]);

  if (loading) return <FinanceLoader />;
  if (!data) return <FinanceEmptyState icon={Sparkles} title="Could not load projections" />;

  return (
    <div className="space-y-6 page-enter">
      <FinancePageHeader
        eyebrow="Finance"
        title="Projections"
        description="Koto THAKBE samne jodi eivabe kaj cholte thake — last 6 mash er avg trend diye"
      />

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatTile icon={Wallet} label="Current Balance" value={fmtMoney(data.currentBalance)} tone="primary" />
        <StatTile icon={Sparkles} label="Avg Monthly Income" value={fmtMoney(data.monthlyIncome)} tone="success" />
        <StatTile icon={Sparkles} label="Avg Monthly Expense" value={fmtMoney(data.monthlyExpense)} tone="danger" />
        <StatTile icon={Sparkles} label="Monthly Net" value={fmtMoney(data.monthlyNet)} tone={data.monthlyNet >= 0 ? "success" : "danger"} />
      </div>

      <div className="space-y-2.5">
        <SectionEyebrow icon={Sparkles}>Scenarios</SectionEyebrow>
        <div className="grid sm:grid-cols-3 gap-3">
          {data.scenarios.map((s, i) => (
            <FinanceCard key={s.months} className="animate-fade-up space-y-3.5" hover>
              <div className="flex items-center justify-between">
                <p className="text-sm font-semibold">{s.months} months out</p>
                <span className="text-[10px] font-mono text-muted-foreground rounded-full border border-border px-2 py-0.5">+{s.months}mo</span>
              </div>
              <div>
                <p className="text-[11px] text-muted-foreground">Current trend only</p>
                <p className="font-mono font-bold text-lg">{fmtMoney(s.currentTrend)}</p>
              </div>
              <div className="divider-glow" />
              <div>
                <p className="text-[11px] text-muted-foreground">If all receivables collected</p>
                <p className="font-mono font-bold text-success">{fmtMoney(s.allReceivablesCollected)}</p>
              </div>
              <div>
                <p className="text-[11px] text-muted-foreground">If all payables paid</p>
                <p className="font-mono font-bold text-danger">{fmtMoney(s.allPayablesPaid)}</p>
              </div>
            </FinanceCard>
          ))}
        </div>
      </div>
    </div>
  );
}
