import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { customFetch } from "@workspace/api-client-react";
import { cn } from "@/lib/utils";
import {
  ShieldCheck, Building2, CheckCircle2, XCircle, Ban,
  DollarSign, TrendingUp, BarChart2, RefreshCw,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { KYC_CATEGORIES, getKycCategoryMeta, KYC_CATEGORY_ICON } from "@/config/vault-kyc";
import { VaultLoadingIntro } from "@/components/vault/vault-loading-intro";

// Same shape as components/kyc-entries.tsx's KycEntry — kept narrow here to
// only the fields the dashboard actually reads.
interface KycEntryRow {
  id: number;
  category: string;
  username: string | null;
  name: string | null;
  seller_name: string | null;
  account_worth: number | null;
  buy_price: number | null;
  paid: boolean;
  status?: string | null;
  created_at: string;
}

function calcROI(worth: number, buy: number): number | null {
  if (!buy || buy === 0) return null;
  return ((worth - buy) / buy) * 100;
}

function ROIBadge({ worth, buy }: { worth: number; buy: number }) {
  const roi = calcROI(worth, buy);
  if (roi === null) return <span className="text-muted-foreground/40 font-mono text-[10px]">—</span>;
  const pos = roi >= 0;
  return (
    <span className={cn("font-mono text-[10px] font-bold", pos ? "text-emerald-400" : "text-red-400")}>
      {pos ? "+" : ""}{roi.toFixed(0)}%
    </span>
  );
}

// Dashboard-card meta per KYC category — reuses the hex color already
// defined in KYC_CATEGORIES (config/vault-kyc.ts) so a new platform added
// there shows up here automatically, no second config to maintain.
function catStyle(color: string) {
  return {
    icon: { color },
    chip: { backgroundColor: `${color}1a`, border: `1px solid ${color}40` },
    text: { color },
  };
}

// ─── Overview Tab ───────────────────────────────────────────────────────────
function OverviewTab({ entries, onSelectCategory }: { entries: KycEntryRow[]; onSelectCategory: (cat: string) => void }) {
  const cats = [...new Set(entries.map(e => e.category))].sort();
  const total = entries.length;
  const paid = entries.filter(e => e.paid).length;
  const unpaid = total - paid;
  const banned = entries.filter(e => e.status === "banned").length;
  const totalWorth = entries.reduce((s, e) => s + (e.account_worth ?? 0), 0);
  const totalInvested = entries.reduce((s, e) => s + (e.buy_price ?? 0), 0);
  const overallROI = calcROI(totalWorth, totalInvested);

  return (
    <div className="space-y-5">
      {/* Summary strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: "Total Entities", value: total.toString(), icon: ShieldCheck, color: "text-cyan-400" },
          { label: "Paid", value: paid.toString(), icon: CheckCircle2, color: "text-emerald-400" },
          { label: "Unpaid", value: unpaid.toString(), icon: XCircle, color: "text-amber-400" },
          { label: "Banned", value: banned.toString(), icon: Ban, color: "text-red-400" },
        ].map(s => (
          <div key={s.label} className="bg-card border border-card-border rounded-xl p-3.5 flex items-start gap-3">
            <div className={cn("w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0", s.color.replace("text-", "bg-").replace("400", "400/10"))}>
              <s.icon className={cn("w-4 h-4", s.color)} />
            </div>
            <div>
              <p className={cn("text-base font-bold font-mono", s.color)}>{s.value}</p>
              <p className="text-[10px] text-muted-foreground/60 font-mono mt-0.5">{s.label}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Worth / invested / ROI strip */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {[
          { label: "Total Worth", value: `$${totalWorth.toFixed(2)}`, icon: DollarSign, color: "text-emerald-400" },
          { label: "Total Invested", value: `$${totalInvested.toFixed(2)}`, icon: TrendingUp, color: "text-amber-400" },
          { label: "Overall ROI", value: overallROI !== null ? `${overallROI >= 0 ? "+" : ""}${overallROI.toFixed(1)}%` : "—", icon: BarChart2, color: overallROI !== null && overallROI >= 0 ? "text-emerald-400" : "text-red-400" },
        ].map(s => (
          <div key={s.label} className="bg-card border border-card-border rounded-xl p-3.5 flex items-start gap-3">
            <div className={cn("w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0", s.color.replace("text-", "bg-").replace("400", "400/10"))}>
              <s.icon className={cn("w-4 h-4", s.color)} />
            </div>
            <div>
              <p className={cn("text-base font-bold font-mono", s.color)}>{s.value}</p>
              <p className="text-[10px] text-muted-foreground/60 font-mono mt-0.5">{s.label}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Per-category progress cards */}
      {cats.length === 0 && (
        <div className="text-center py-16 text-muted-foreground/50 font-mono text-xs">No KYC entities yet</div>
      )}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {cats.map(cat => {
          const group = entries.filter(e => e.category === cat);
          const meta = getKycCategoryMeta(cat);
          const style = catStyle(meta.color);
          const gPaid = group.filter(e => e.paid).length;
          const gWorth = group.reduce((s, e) => s + (e.account_worth ?? 0), 0);
          const gBuy = group.reduce((s, e) => s + (e.buy_price ?? 0), 0);
          const roi = calcROI(gWorth, gBuy);
          const paidPct = group.length > 0 ? (gPaid / group.length) * 100 : 0;
          return (
            <div
              key={cat}
              onClick={() => onSelectCategory(cat)}
              role="button"
              tabIndex={0}
              onKeyDown={e => { if (e.key === "Enter" || e.key === " ") onSelectCategory(cat); }}
              className="bg-card border rounded-xl p-4 space-y-3 cursor-pointer transition-all hover:-translate-y-0.5"
              style={{ borderColor: `${meta.color}30` }}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="w-7 h-7 rounded-lg flex items-center justify-center" style={style.chip}>
                    <KYC_CATEGORY_ICON className="w-3.5 h-3.5" style={style.icon} />
                  </div>
                  <span className="font-mono text-xs font-bold" style={style.text}>{meta.name}</span>
                </div>
                <Badge variant="outline" className="font-mono text-[10px]">{group.length} entities</Badge>
              </div>

              <div className="grid grid-cols-3 gap-2 text-center">
                <div>
                  <p className="font-mono text-sm font-bold text-emerald-400">{gPaid}</p>
                  <p className="font-mono text-[9px] text-muted-foreground/50 uppercase">Paid</p>
                </div>
                <div>
                  <p className="font-mono text-sm font-bold text-emerald-400">${gWorth.toFixed(2)}</p>
                  <p className="font-mono text-[9px] text-muted-foreground/50 uppercase">Worth</p>
                </div>
                <div>
                  <p className={cn("font-mono text-sm font-bold", roi === null ? "text-muted-foreground/40" : roi >= 0 ? "text-emerald-400" : "text-red-400")}>
                    {roi !== null ? `${roi >= 0 ? "+" : ""}${roi.toFixed(0)}%` : "—"}
                  </p>
                  <p className="font-mono text-[9px] text-muted-foreground/50 uppercase">ROI</p>
                </div>
              </div>

              {/* Paid progress bar */}
              <div className="space-y-1">
                <div className="flex items-center justify-between text-[9px] font-mono text-muted-foreground/50">
                  <span>Paid progress</span>
                  <span>{gPaid}/{group.length}</span>
                </div>
                <div className="h-1 bg-muted/20 rounded-full overflow-hidden">
                  <div className="h-full rounded-full bg-emerald-400" style={{ width: `${paidPct}%` }} />
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Category Tab ───────────────────────────────────────────────────────────
function CategoryTab({ entries, selected, onSelectedChange }: { entries: KycEntryRow[]; selected: string; onSelectedChange: (cat: string) => void }) {
  const [, navigate] = useLocation();
  const cats = [...new Set(entries.map(e => e.category))].sort();

  useEffect(() => {
    if (cats.length && !cats.includes(selected)) onSelectedChange(cats[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cats.join(",")]);

  if (cats.length === 0) {
    return <div className="text-center py-16 text-muted-foreground/50 font-mono text-xs">No KYC entities yet</div>;
  }

  const activeSelected = cats.includes(selected) ? selected : cats[0];
  const group = entries.filter(e => e.category === activeSelected);
  const meta = getKycCategoryMeta(activeSelected);
  const style = catStyle(meta.color);
  const gPaid = group.filter(e => e.paid).length;

  return (
    <div className="space-y-4">
      {/* Category picker — switch between exchange/platform categories */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        {cats.map(cat => {
          const m = getKycCategoryMeta(cat);
          const s = catStyle(m.color);
          const catGroup = entries.filter(e => e.category === cat);
          const isActive = activeSelected === cat;
          return (
            <button
              key={cat}
              onClick={() => onSelectedChange(cat)}
              className={cn(
                "flex flex-col items-start gap-1.5 p-3 rounded-xl border font-mono text-left transition-all hover:-translate-y-0.5",
                isActive ? "shadow-sm" : "bg-card border-card-border hover:border-border"
              )}
              style={isActive ? { backgroundColor: `${m.color}12`, borderColor: `${m.color}50` } : undefined}
            >
              <div className="flex items-center justify-between w-full">
                <div className="w-6 h-6 rounded-lg flex items-center justify-center" style={s.chip}>
                  <KYC_CATEGORY_ICON className="w-3 h-3" style={s.icon} />
                </div>
                <span
                  className="text-[9px] px-1.5 py-0.5 rounded-full font-bold"
                  style={isActive ? { backgroundColor: `${m.color}22`, color: m.color } : undefined}
                >
                  {catGroup.length}
                </span>
              </div>
              <div>
                <div className="text-xs font-bold" style={isActive ? { color: m.color } : undefined}>{cat}</div>
                <div className="text-[9px] text-muted-foreground/50">{catGroup.filter(e => e.paid).length}/{catGroup.length} paid</div>
              </div>
            </button>
          );
        })}
      </div>

      {/* Selected category detail */}
      <div className="space-y-3">
        <div className="rounded-xl border p-4 flex items-center gap-3" style={{ borderColor: `${meta.color}40`, backgroundColor: `${meta.color}0d` }}>
          <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-background/30">
            <KYC_CATEGORY_ICON className="w-5 h-5" style={style.icon} />
          </div>
          <div>
            <p className="font-mono text-sm font-bold" style={style.text}>{meta.name}</p>
            <p className="font-mono text-[10px] text-muted-foreground/60">
              {group.length} entities · <span style={style.text}>{gPaid} paid</span>
            </p>
          </div>
          <div className="ml-auto text-right">
            <p className="font-mono text-base font-bold text-foreground">
              ${group.reduce((s, e) => s + (e.account_worth ?? 0), 0).toFixed(2)}
            </p>
            <p className="font-mono text-[9px] text-muted-foreground/50">Total Worth</p>
          </div>
        </div>

        <div className="bg-card border border-card-border rounded-xl overflow-hidden">
          <div className="grid grid-cols-[1fr_auto_auto_auto] gap-3 px-4 py-2 border-b border-border/30">
            <span className="font-mono text-[9px] uppercase tracking-widest text-muted-foreground/40">Entity</span>
            <span className="font-mono text-[9px] uppercase tracking-widest text-muted-foreground/40">Status</span>
            <span className="font-mono text-[9px] uppercase tracking-widest text-muted-foreground/40">Worth</span>
            <span className="font-mono text-[9px] uppercase tracking-widest text-muted-foreground/40">ROI</span>
          </div>
          {group.length === 0 ? (
            <div className="py-8 text-center text-muted-foreground/40 font-mono text-xs">No entities in this category</div>
          ) : (
            group.map(e => (
              <div
                key={e.id}
                onClick={() => navigate(`/vault/kyc/${e.id}`)}
                className="grid grid-cols-[1fr_auto_auto_auto] gap-3 items-center px-4 py-3 border-b border-border/20 last:border-0 hover:bg-muted/10 transition-colors cursor-pointer"
              >
                <div>
                  <p className="font-mono text-xs font-medium text-foreground">{e.name ?? e.username ?? e.seller_name ?? `Entity #${e.id}`}</p>
                </div>
                <span className={cn(
                  "font-mono text-[9px] px-1.5 py-0.5 rounded border w-fit flex items-center gap-1",
                  e.status === "banned"
                    ? "bg-red-400/10 text-red-400 border-red-400/20"
                    : e.paid
                    ? "bg-emerald-400/10 text-emerald-400 border-emerald-400/20"
                    : "bg-amber-400/10 text-amber-400 border-amber-400/20"
                )}>
                  {e.status === "banned" ? <Ban className="w-2.5 h-2.5" /> : e.paid ? <CheckCircle2 className="w-2.5 h-2.5" /> : <XCircle className="w-2.5 h-2.5" />}
                  {e.status === "banned" ? "BANNED" : e.paid ? "PAID" : "UNPAID"}
                </span>
                <span className="font-mono text-xs text-emerald-400">${(e.account_worth ?? 0).toFixed(2)}</span>
                <ROIBadge worth={e.account_worth ?? 0} buy={e.buy_price ?? 0} />
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Main dashboard ─────────────────────────────────────────────────────────
export default function VaultKycDashboard() {
  const [entries, setEntries] = useState<KycEntryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<"overview" | "category">("overview");
  const [selectedCategory, setSelectedCategory] = useState<string>("");

  const load = () => {
    setLoading(true);
    customFetch<KycEntryRow[]>("/api/kyc-entries")
      .then(d => setEntries(Array.isArray(d) ? d : []))
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  const openCategory = (cat: string) => {
    setSelectedCategory(cat);
    setTab("category");
  };

  return (
    <div className="space-y-4">
      {/* Category switch — Overview / Category, same pattern as Local Entity dashboard */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1 bg-muted/20 rounded-lg p-1">
          {(["overview", "category"] as const).map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={cn(
                "px-4 py-1.5 rounded-md font-mono text-xs transition-all capitalize",
                tab === t ? "bg-card text-primary shadow-sm font-bold" : "text-muted-foreground/60 hover:text-muted-foreground"
              )}
            >
              {t}
            </button>
          ))}
        </div>
        <button onClick={load} className="text-muted-foreground/40 hover:text-primary transition-colors p-1.5">
          <RefreshCw className={cn("w-3.5 h-3.5", loading && "animate-spin")} />
        </button>
      </div>

      {loading ? (
        <VaultLoadingIntro title="Loading KYC dashboard" done={!loading} />
      ) : tab === "overview" ? (
        <OverviewTab entries={entries} onSelectCategory={openCategory} />
      ) : (
        <CategoryTab entries={entries} selected={selectedCategory} onSelectedChange={setSelectedCategory} />
      )}
    </div>
  );
}
