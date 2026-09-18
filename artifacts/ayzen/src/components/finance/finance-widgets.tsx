/**
 * components/finance/finance-widgets.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Reusable, self-contained (client-side computed) chart widgets + grouping
 * helpers shared across the finance pages (entry lists, assets, investments).
 * No new API calls — everything here derives from data the pages already fetch.
 */
import {
  PieChart, Pie, Cell, BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from "recharts";
import { FinanceCard } from "@/components/finance/finance-ui";
import type { FinanceEntry, FinanceCurrencyRate, NetWorthSnapshot } from "@/config/finance";
import { fmtMoney } from "@/config/finance";

/**
 * A currency→rateToBase lookup, as returned by GET /finance/currencies
 * (financeApi.listCurrencies) and shaped by rateMapFromCurrencies() below.
 * BDT always resolves to 1, mirroring the backend's getRateMap().
 */
export type FinanceRateMap = Record<string, number>;

export function rateMapFromCurrencies(rows: FinanceCurrencyRate[]): FinanceRateMap {
  const map: FinanceRateMap = { BDT: 1 };
  for (const r of rows) map[r.currency] = r.rateToBase;
  return map;
}

// Converts an entry's amount into the base currency before it's summed into
// a chart/stat total. Entries can be booked in different currencies
// (config/finance.ts's CURRENCY_OPTIONS), so summing raw `e.amount` across a
// mixed-currency entry list silently adds incompatible units together —
// same bug class the backend already guards against in routes/finance.ts
// via getRateMap/toBase. Defaults to 1 (i.e. treats the amount as already in
// base currency) when no rate map is supplied, so callers that haven't been
// updated yet keep their old behavior instead of breaking.
function toBase(entry: FinanceEntry, rates: FinanceRateMap): number {
  return entry.amount * (rates[entry.currency] ?? 1);
}

export const CHART_COLORS = [
  "hsl(var(--primary))", "hsl(var(--secondary))", "hsl(var(--success))",
  "hsl(var(--warning))", "hsl(var(--info))", "hsl(var(--danger))", "#f472b6", "#a78bfa",
];

export const chartTooltipStyle = {
  backgroundColor: "hsl(var(--popover))", borderColor: "hsl(var(--popover-border))", borderRadius: 8,
  fontFamily: "'Space Mono', monospace", fontSize: 11, boxShadow: "var(--shadow-elevation-3)",
};

/* ─── Grouping helpers ───────────────────────────────────────────────────── */

export function groupByMonth(entries: FinanceEntry[], monthsBack = 6, rates: FinanceRateMap = {}): { label: string; value: number }[] {
  const now = new Date();
  const buckets: { key: string; label: string; value: number }[] = [];
  for (let i = monthsBack - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    buckets.push({ key: `${d.getFullYear()}-${d.getMonth()}`, label: d.toLocaleDateString(undefined, { month: "short" }), value: 0 });
  }
  const byKey = new Map(buckets.map(b => [b.key, b]));
  for (const e of entries) {
    const d = new Date(e.occurredDate);
    const key = `${d.getFullYear()}-${d.getMonth()}`;
    const b = byKey.get(key);
    if (b) b.value += toBase(e, rates);
  }
  return buckets.map(({ label, value }) => ({ label, value }));
}

export function groupByStatus(entries: FinanceEntry[], rates: FinanceRateMap = {}): { label: string; value: number }[] {
  const map = new Map<string, number>();
  for (const e of entries) map.set(e.status, (map.get(e.status) ?? 0) + toBase(e, rates));
  return Array.from(map.entries()).map(([label, value]) => ({ label, value }));
}

export function groupByCategory(entries: FinanceEntry[], rates: FinanceRateMap = {}): { label: string; value: number }[] {
  const map = new Map<string, number>();
  for (const e of entries) {
    const cat = e.category?.trim() || "Uncategorized";
    map.set(cat, (map.get(cat) ?? 0) + toBase(e, rates));
  }
  return Array.from(map.entries()).map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);
}

export function computeEntryStats(entries: FinanceEntry[], rates: FinanceRateMap = {}) {
  const now = Date.now();
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime();
  const overdue = entries.filter(e => e.dueDate && e.status !== "paid" && e.status !== "closed" && new Date(e.dueDate).getTime() < now);
  const thisMonth = entries.filter(e => new Date(e.occurredDate).getTime() >= monthStart);
  return {
    count: entries.length,
    overdueCount: overdue.length,
    overdueAmount: overdue.reduce((s, e) => s + toBase(e, rates), 0),
    thisMonthAmount: thisMonth.reduce((s, e) => s + toBase(e, rates), 0),
    avgAmount: entries.length ? entries.reduce((s, e) => s + toBase(e, rates), 0) / entries.length : 0,
  };
}

/* ─── Donut breakdown ────────────────────────────────────────────────────── */

export function DonutBreakdown({
  title, data, colors = CHART_COLORS, valueFormatter = (v: number) => fmtMoney(v), height = 200, emptyLabel = "Kono data nei ekhono",
}: {
  title: string;
  data: { label: string; value: number }[];
  colors?: string[];
  valueFormatter?: (v: number) => string;
  height?: number;
  emptyLabel?: string;
}) {
  const filtered = data.filter(d => d.value > 0);
  return (
    <FinanceCard className="space-y-3">
      <p className="text-sm font-semibold">{title}</p>
      {filtered.length === 0 ? (
        <div className="h-40 flex items-center justify-center text-xs text-muted-foreground">{emptyLabel}</div>
      ) : (
        <>
          <div style={{ height }}>
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={filtered} dataKey="value" nameKey="label" cx="50%" cy="50%" innerRadius="50%" outerRadius="80%" paddingAngle={2}>
                  {filtered.map((_, i) => <Cell key={i} fill={colors[i % colors.length]} stroke="hsl(var(--card))" strokeWidth={2} />)}
                </Pie>
                <Tooltip contentStyle={chartTooltipStyle} formatter={(v: number) => valueFormatter(v)} />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-1.5">
            {filtered.map((d, i) => (
              <div key={d.label} className="flex items-center gap-1.5 text-[11px] text-muted-foreground capitalize">
                <span className="h-2 w-2 rounded-full shrink-0" style={{ background: colors[i % colors.length] }} />
                {d.label}
              </div>
            ))}
          </div>
        </>
      )}
    </FinanceCard>
  );
}

/* ─── Mini trend / breakdown bar chart ───────────────────────────────────── */

export function TrendMiniChart({
  title, data, color = "hsl(var(--primary))", valueFormatter = (v: number) => fmtMoney(v), height = 200, layout = "horizontal",
}: {
  title: string;
  data: { label: string; value: number }[];
  color?: string;
  valueFormatter?: (v: number) => string;
  height?: number;
  layout?: "horizontal" | "vertical";
}) {
  const hasData = data.some(d => d.value !== 0);
  return (
    <FinanceCard className="space-y-3">
      <p className="text-sm font-semibold">{title}</p>
      {!hasData ? (
        <div className="h-40 flex items-center justify-center text-xs text-muted-foreground">Kono data nei ekhono</div>
      ) : (
        <div style={{ height }}>
          <ResponsiveContainer width="100%" height="100%">
            {layout === "vertical" ? (
              <BarChart data={data} layout="vertical" margin={{ left: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis type="number" tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" />
                <YAxis type="category" dataKey="label" tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" width={80} />
                <Tooltip contentStyle={chartTooltipStyle} formatter={(v: number) => valueFormatter(v)} cursor={{ fill: "hsl(var(--muted))" }} />
                <Bar dataKey="value" fill={color} radius={[0, 4, 4, 0]} />
              </BarChart>
            ) : (
              <BarChart data={data}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis dataKey="label" tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" />
                <YAxis tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" />
                <Tooltip contentStyle={chartTooltipStyle} formatter={(v: number) => valueFormatter(v)} cursor={{ fill: "hsl(var(--muted))" }} />
                <Bar dataKey="value" fill={color} radius={[4, 4, 0, 0]} />
              </BarChart>
            )}
          </ResponsiveContainer>
        </div>
      )}
    </FinanceCard>
  );
}

/* ─── Grouped bar chart (two series, e.g. invested vs earned) ───────────── */

export function DualBarChart({
  title, data, seriesA, seriesB, colorA = "hsl(var(--primary))", colorB = "hsl(var(--success))", height = 220,
}: {
  title: string;
  data: Record<string, any>[];
  seriesA: { key: string; label: string };
  seriesB: { key: string; label: string };
  colorA?: string;
  colorB?: string;
  height?: number;
}) {
  const hasData = data.length > 0;
  return (
    <FinanceCard className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold">{title}</p>
        <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full" style={{ background: colorA }} />{seriesA.label}</span>
          <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full" style={{ background: colorB }} />{seriesB.label}</span>
        </div>
      </div>
      {!hasData ? (
        <div className="h-40 flex items-center justify-center text-xs text-muted-foreground">Kono data nei ekhono</div>
      ) : (
        <div style={{ height }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis dataKey="label" tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" />
              <YAxis tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" />
              <Tooltip contentStyle={chartTooltipStyle} formatter={(v: number) => fmtMoney(v)} cursor={{ fill: "hsl(var(--muted))" }} />
              <Bar dataKey={seriesA.key} name={seriesA.label} fill={colorA} radius={[4, 4, 0, 0]} />
              <Bar dataKey={seriesB.key} name={seriesB.label} fill={colorB} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </FinanceCard>
  );
}

/* ─── Gain/loss badge (assets) ───────────────────────────────────────────── */

export function GainLossBadge({ current, cost }: { current: number; cost: number | null }) {
  if (cost == null || cost === 0) return null;
  const diff = current - cost;
  const pct = (diff / cost) * 100;
  const positive = diff >= 0;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-mono font-semibold ring-1 ${
        positive ? "text-success bg-success-muted ring-success/20" : "text-danger bg-danger-muted ring-danger/20"
      }`}
    >
      {positive ? "+" : ""}{pct.toFixed(1)}% ({positive ? "+" : ""}{fmtMoney(diff)})
    </span>
  );
}

/* ─── Net worth trend (line chart over monthly snapshots) ───────────────── */

export function NetWorthTrendChart({ snapshots, height = 220 }: { snapshots: NetWorthSnapshot[]; height?: number }) {
  const data = snapshots.map(s => ({
    label: new Date(s.snapshotDate).toLocaleDateString(undefined, { month: "short", year: "2-digit" }),
    value: s.netWorth,
  }));
  const hasData = data.length >= 2;
  return (
    <FinanceCard className="space-y-3">
      <p className="text-sm font-semibold">Net Worth Trend</p>
      {!hasData ? (
        <div className="h-40 flex items-center justify-center text-xs text-muted-foreground text-center px-6">
          Aro ekta snapshot lagbe trend dekhate — "Snapshot Now" chapo, ba next month wait koro.
        </div>
      ) : (
        <div style={{ height }}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis dataKey="label" tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" />
              <YAxis tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" />
              <Tooltip contentStyle={chartTooltipStyle} formatter={(v: number) => fmtMoney(v)} cursor={{ stroke: "hsl(var(--border))" }} />
              <Line type="monotone" dataKey="value" stroke="hsl(var(--primary))" strokeWidth={2} dot={{ r: 3 }} activeDot={{ r: 5 }} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </FinanceCard>
  );
}
