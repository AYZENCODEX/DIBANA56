import { useEffect, useState } from "react";
import { Link } from "wouter";
import { useAuth } from "@/hooks/use-auth";
import { Badge } from "@/components/ui/badge";
import {
  ArrowDownToLine, ArrowUpFromLine, Landmark, Handshake, Wallet, TrendingUp, TrendingDown,
  Percent, Sparkles, PiggyBank, Receipt, Clock, ArrowRight,
} from "lucide-react";
import { financeApi } from "@/lib/finance-api";
import { fmtMoney } from "@/config/finance";
import { cn } from "@/lib/utils";
import { FinanceInsightsWidget } from "@/components/finance/finance-insights";
import {
  FinancePageHeader, FinanceHero, StatTile, SectionEyebrow, FinanceEmptyState, FinanceLoader,
} from "@/components/finance/finance-ui";

interface Summary {
  totalBorrowed: number; totalReceivable: number; totalPayable: number; totalLending: number;
  totalInvested: number; totalExpense: number; totalIncome: number;
  currentBalance: number; netWorth: number; interestPaid: number; interestOwed: number;
  upcoming: Array<{ id: number; title: string; amount: number; currency: string; dueDate: string; kind: string }>;
}

const QUICK_LINKS = [
  { href: "/finance/receivables", label: "Receivables" },
  { href: "/finance/payables", label: "Payables" },
  { href: "/finance/assets", label: "Assets" },
  { href: "/finance/goals", label: "Goals" },
  { href: "/finance/projections", label: "Projections" },
];

export default function FinanceDashboardPage() {
  const { token, isLoading: authLoading } = useAuth();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (authLoading || !token) return;
    financeApi.summary(token).then(setSummary).catch(() => {}).finally(() => setLoading(false));
  }, [token, authLoading]);

  if (loading) return <FinanceLoader />;
  if (!summary) return <FinanceEmptyState icon={Wallet} title="Could not load finance summary" description="Try refreshing the page." />;

  return (
    <div className="space-y-6 page-enter">
      <FinancePageHeader
        eyebrow="Finance"
        title="Dashboard"
        description="Sob module theke ekta ekta metric — bird's eye view"
      />

      <FinanceHero
        eyebrow="Net Worth"
        label="Assets minus what's owed, right now"
        value={fmtMoney(summary.netWorth)}
        tone={summary.netWorth >= 0 ? "success" : "danger"}
        trend={
          <div className="flex items-center gap-2 flex-wrap">
            <Badge variant="outline" className="font-mono gap-1"><Wallet className="h-3 w-3" /> Balance {fmtMoney(summary.currentBalance)}</Badge>
            {summary.netWorth >= 0
              ? <Badge variant="success" className="gap-1"><TrendingUp className="h-3 w-3" /> Positive</Badge>
              : <Badge variant="warning" className="gap-1"><TrendingDown className="h-3 w-3" /> Negative</Badge>}
          </div>
        }
      >
        <div className="hidden sm:flex flex-col gap-1.5 shrink-0">
          {QUICK_LINKS.map(q => (
            <Link key={q.href} href={q.href} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary transition-colors">
              {q.label} <ArrowRight className="h-3 w-3" />
            </Link>
          ))}
        </div>
      </FinanceHero>

      <FinanceInsightsWidget />

      <div className="space-y-2.5">
        <SectionEyebrow icon={Percent}>Position</SectionEyebrow>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <StatTile icon={Landmark} label="Total Borrowed" value={fmtMoney(summary.totalBorrowed)} tone="warning" delay={0} />
          <StatTile icon={ArrowDownToLine} label="Total Receivable" value={fmtMoney(summary.totalReceivable)} tone="success" delay={40} />
          <StatTile icon={ArrowUpFromLine} label="Total Payable" value={fmtMoney(summary.totalPayable)} tone="danger" delay={80} />
          <StatTile icon={Handshake} label="Total Lending" value={fmtMoney(summary.totalLending)} tone="info" delay={120} />
          <StatTile icon={PiggyBank} label="Total Invested" value={fmtMoney(summary.totalInvested)} tone="secondary" delay={160} />
          <StatTile icon={Receipt} label="Total Expense" value={fmtMoney(summary.totalExpense)} tone="neutral" delay={200} />
          <StatTile icon={Percent} label="Interest Paid" value={fmtMoney(summary.interestPaid)} tone="primary" delay={240} />
          <StatTile icon={TrendingDown} label="Interest Owed" value={fmtMoney(summary.interestOwed)} tone="warning" delay={280} />
        </div>
      </div>

      <div className="space-y-2.5">
        <SectionEyebrow icon={Clock}>Upcoming (next 30 days)</SectionEyebrow>
        {summary.upcoming.length === 0 ? (
          <FinanceEmptyState icon={Sparkles} title="Kono upcoming due nei" description="Sob shomoy moto paid — porer 30 diner jonno kichu track korte hobe na." />
        ) : (
          <div className="rounded-xl border border-card-border bg-card divide-y divide-border overflow-hidden elevation-1">
            {summary.upcoming.map(u => {
              const days = Math.ceil((new Date(u.dueDate).getTime() - Date.now()) / 86400000);
              const isPayable = u.kind === "payable" || u.kind === "borrowed";
              return (
                <div key={u.id} className="flex items-center justify-between p-3.5 text-sm table-row-premium">
                  <div className="flex items-center gap-3">
                    <div className={cn("flex h-8 w-8 items-center justify-center rounded-lg ring-1 shrink-0",
                      isPayable ? "bg-danger-muted text-danger ring-danger/20" : "bg-success-muted text-success ring-success/20")}>
                      {isPayable ? <ArrowUpFromLine className="h-4 w-4" /> : <ArrowDownToLine className="h-4 w-4" />}
                    </div>
                    <div>
                      <p className="font-medium">{u.title}</p>
                      <p className="text-xs text-muted-foreground capitalize">{u.kind}</p>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className={cn("font-mono font-semibold", isPayable ? "text-danger" : "text-success")}>{fmtMoney(u.amount, u.currency)}</p>
                    <Badge variant="outline" className={cn("text-[10px]", days <= 3 ? "text-danger border-danger/30" : "text-warning border-warning/30")}>
                      Due in {days}d
                    </Badge>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
