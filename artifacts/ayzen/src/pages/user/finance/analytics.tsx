import { useEffect, useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import {
  LineChart, Line, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from "recharts";
import { LineChart as LineChartIcon } from "lucide-react";
import { financeApi } from "@/lib/finance-api";
import { fmtMoney, ASSET_TYPE_LABELS } from "@/config/finance";
import { FinancePageHeader, ChartCard, FinanceLoader, FinanceEmptyState } from "@/components/finance/finance-ui";

const PIE_COLORS = ["hsl(var(--primary))", "hsl(var(--secondary))", "hsl(var(--success))", "hsl(var(--warning))", "hsl(var(--info))", "hsl(var(--danger))", "#f472b6"];
const tooltipStyle = {
  backgroundColor: "hsl(var(--popover))", borderColor: "hsl(var(--popover-border))", borderRadius: 8,
  fontFamily: "'Space Mono', monospace", fontSize: 11, boxShadow: "var(--shadow-elevation-3)",
};

interface Analytics {
  monthlyTrend: Array<{ month: string; income: number; expense: number; net: number }>;
  expenseByCategory: Array<{ category: string; value: number }>;
  assetAllocation: Array<{ assetType: string; value: number }>;
  projectPnl: Array<{ projectId: number; projectName: string; pnl: number }>;
}

export default function FinanceAnalyticsPage() {
  const { token, isLoading: authLoading } = useAuth();
  const [data, setData] = useState<Analytics | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (authLoading || !token) return;
    financeApi.analytics(token).then(setData).catch(() => setData(null)).finally(() => setLoading(false));
  }, [token, authLoading]);

  if (loading) return <FinanceLoader />;
  if (!data) return <FinanceEmptyState icon={LineChartIcon} title="Could not load analytics" />;

  const pnlData = data.projectPnl.map(p => ({ ...p, fill: p.pnl >= 0 ? "hsl(var(--success))" : "hsl(var(--danger))" }));

  return (
    <div className="space-y-6 page-enter">
      <FinancePageHeader
        eyebrow="Finance"
        title="Analytics"
        description="Last 12 months — income/expense trend, category breakdown, asset allocation, per-project PnL"
      />

      <ChartCard title="Income vs Expense (12 months)">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data.monthlyTrend}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
            <XAxis dataKey="month" tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" />
            <YAxis tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" />
            <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => fmtMoney(v)} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Line type="monotone" dataKey="income" stroke="hsl(var(--success))" strokeWidth={2} dot={false} name="Income" />
            <Line type="monotone" dataKey="expense" stroke="hsl(var(--danger))" strokeWidth={2} dot={false} name="Expense" />
            <Line type="monotone" dataKey="net" stroke="hsl(var(--primary))" strokeWidth={2} strokeDasharray="4 3" dot={false} name="Net" />
          </LineChart>
        </ResponsiveContainer>
      </ChartCard>

      <div className="grid lg:grid-cols-2 gap-4">
        <ChartCard title="Expense by Category">
          {data.expenseByCategory.length === 0 ? (
            <div className="h-full flex items-center justify-center text-sm text-muted-foreground">Kono expense data nei.</div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data.expenseByCategory} layout="vertical" margin={{ left: 24 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis type="number" tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" />
                <YAxis type="category" dataKey="category" tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" width={90} />
                <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => fmtMoney(v)} cursor={{ fill: "hsl(var(--muted))" }} />
                <Bar dataKey="value" fill="hsl(var(--primary))" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </ChartCard>

        <ChartCard title="Asset Allocation (my share)">
          {data.assetAllocation.length === 0 ? (
            <div className="h-full flex items-center justify-center text-sm text-muted-foreground">Kono asset add kora hoyni.</div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={data.assetAllocation.map(a => ({ name: ASSET_TYPE_LABELS[a.assetType as keyof typeof ASSET_TYPE_LABELS] ?? a.assetType, value: a.value }))}
                  dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={44} outerRadius={80} paddingAngle={2} label={({ name }) => name}
                >
                  {data.assetAllocation.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} stroke="hsl(var(--card))" strokeWidth={2} />)}
                </Pie>
                <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => fmtMoney(v)} />
              </PieChart>
            </ResponsiveContainer>
          )}
        </ChartCard>
      </div>

      <ChartCard title="Per-Project PnL">
        {pnlData.length === 0 ? (
          <div className="h-full flex items-center justify-center text-sm text-muted-foreground">Kono project-linked data nei.</div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={pnlData}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis dataKey="projectName" tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" />
              <YAxis tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" />
              <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => fmtMoney(v)} cursor={{ fill: "hsl(var(--muted))" }} />
              <Bar dataKey="pnl" name="Net PnL" radius={[4, 4, 0, 0]}>
                {pnlData.map((p, i) => <Cell key={i} fill={p.fill} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )}
      </ChartCard>
    </div>
  );
}
