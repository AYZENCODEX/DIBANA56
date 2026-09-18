import { useState } from "react";
import { Calculator, DollarSign, TrendingUp, Percent, RefreshCw, Info } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

interface Scenario {
  name: string;
  price: number;
  probability: number;
}

function fmt(n: number, decimals = 2) {
  if (!isFinite(n) || isNaN(n)) return "—";
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(2)}K`;
  return `$${n.toFixed(decimals)}`;
}

function pct(n: number) {
  if (!isFinite(n) || isNaN(n)) return "—";
  return `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
}

export default function CalculatorPage() {
  const [invest, setInvest] = useState("100");
  const [gasCost, setGasCost] = useState("5");
  const [timeHours, setTimeHours] = useState("2");
  const [hourlyRate, setHourlyRate] = useState("10");
  const [taxRate, setTaxRate] = useState("20");
  const [scenarios, setScenarios] = useState<Scenario[]>([
    { name: "Bear",   price: 0.01,  probability: 40 },
    { name: "Base",   price: 0.05,  probability: 40 },
    { name: "Bull",   price: 0.20,  probability: 15 },
    { name: "Mega",   price: 1.00,  probability:  5 },
  ]);
  const [tokens, setTokens] = useState("10000");
  const [allocation, setAllocation] = useState("1");

  const totalInvested = parseFloat(invest || "0") + parseFloat(gasCost || "0");
  const timeCost = parseFloat(timeHours || "0") * parseFloat(hourlyRate || "0");
  const fullCost = totalInvested + timeCost;
  const tax = parseFloat(taxRate || "0") / 100;
  const tokensN = parseFloat(tokens || "0");

  const calcScenario = (s: Scenario) => {
    const gross = tokensN * s.price;
    const profit = gross - fullCost;
    const afterTax = profit > 0 ? profit * (1 - tax) : profit;
    const roi = fullCost > 0 ? (afterTax / fullCost) * 100 : 0;
    return { gross, profit, afterTax, roi };
  };

  const expectedValue = scenarios.reduce((sum, s) => {
    const { afterTax } = calcScenario(s);
    return sum + afterTax * (s.probability / 100);
  }, 0);

  const breakEven = fullCost > 0 && tokensN > 0 ? fullCost / tokensN : null;

  const updateScenario = (i: number, key: keyof Scenario, val: string) => {
    setScenarios(prev => prev.map((s, idx) => idx === i ? { ...s, [key]: key === "name" ? val : parseFloat(val) || 0 } : s));
  };

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="flex items-center gap-3 mb-6">
        <div className="w-10 h-10 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center">
          <Calculator className="w-5 h-5 text-primary" />
        </div>
        <div>
          <h1 className="font-mono font-bold text-xl uppercase tracking-wider text-foreground">ROI Calculator</h1>
          <p className="font-mono text-xs text-muted-foreground/60">Model airdrop return scenarios with full cost accounting</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Input section */}
        <div className="space-y-4">
          <div className="bg-card border border-card-border rounded-xl p-5 space-y-4">
            <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground/50 border-b border-border/30 pb-2">
              Cost Inputs
            </div>

            {[
              { label: "Direct Investment ($)", value: invest, set: setInvest, placeholder: "100", icon: DollarSign },
              { label: "Total Gas Fees ($)", value: gasCost, set: setGasCost, placeholder: "5", icon: DollarSign },
              { label: "Time Invested (hours)", value: timeHours, set: setTimeHours, placeholder: "2", icon: RefreshCw },
              { label: "Your Hourly Rate ($/hr)", value: hourlyRate, set: setHourlyRate, placeholder: "10", icon: DollarSign },
              { label: "Tax Rate (%)", value: taxRate, set: setTaxRate, placeholder: "20", icon: Percent },
            ].map(({ label, value, set, placeholder }) => (
              <div key={label} className="space-y-1">
                <Label className="font-mono text-[10px] text-muted-foreground/60 uppercase tracking-wider">{label}</Label>
                <Input
                  type="number"
                  value={value}
                  onChange={e => set(e.target.value)}
                  placeholder={placeholder}
                  className="font-mono text-sm h-9 bg-input"
                />
              </div>
            ))}
          </div>

          <div className="bg-card border border-card-border rounded-xl p-5 space-y-4">
            <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground/50 border-b border-border/30 pb-2">
              Token Allocation
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="font-mono text-[10px] text-muted-foreground/60 uppercase tracking-wider">Tokens Received</Label>
                <Input type="number" value={tokens} onChange={e => setTokens(e.target.value)} className="font-mono text-sm h-9 bg-input" />
              </div>
              <div className="space-y-1">
                <Label className="font-mono text-[10px] text-muted-foreground/60 uppercase tracking-wider">Allocation %</Label>
                <Input type="number" value={allocation} onChange={e => setAllocation(e.target.value)} className="font-mono text-sm h-9 bg-input" placeholder="1" />
              </div>
            </div>
          </div>

          {/* Cost summary */}
          <div className="bg-card border border-card-border rounded-xl p-4 space-y-2">
            <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground/50 mb-2">Total Cost Breakdown</div>
            {[
              { label: "Direct + Gas", val: totalInvested },
              { label: "Time Opportunity Cost", val: timeCost },
              { label: "TOTAL ALL-IN", val: fullCost, bold: true },
            ].map(({ label, val, bold }) => (
              <div key={label} className={cn("flex justify-between items-center", bold && "border-t border-border/40 pt-2 mt-2")}>
                <span className={cn("font-mono text-xs text-muted-foreground", bold && "text-foreground font-bold")}>{label}</span>
                <span className={cn("font-mono text-sm", bold ? "text-foreground font-bold" : "text-muted-foreground")}>{fmt(val)}</span>
              </div>
            ))}
            {breakEven !== null && (
              <div className="flex justify-between items-center pt-1">
                <span className="font-mono text-xs text-amber-400">Break-even Price</span>
                <span className="font-mono text-sm text-amber-400">${breakEven.toFixed(4)}</span>
              </div>
            )}
          </div>
        </div>

        {/* Scenarios section */}
        <div className="space-y-4">
          <div className="bg-card border border-card-border rounded-xl p-5 space-y-3">
            <div className="flex items-center justify-between border-b border-border/30 pb-2">
              <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground/50">Price Scenarios</span>
              <span className="font-mono text-[10px] text-muted-foreground/40">prob must total 100%</span>
            </div>
            {scenarios.map((s, i) => (
              <div key={i} className="grid grid-cols-3 gap-2 items-center">
                <Input value={s.name} onChange={e => updateScenario(i, "name", e.target.value)} className="font-mono text-xs h-8 bg-input" />
                <div className="relative">
                  <span className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground/40 font-mono text-xs">$</span>
                  <Input type="number" value={s.price} onChange={e => updateScenario(i, "price", e.target.value)} className="font-mono text-xs h-8 bg-input pl-5" />
                </div>
                <div className="relative">
                  <Input type="number" value={s.probability} onChange={e => updateScenario(i, "probability", e.target.value)} className="font-mono text-xs h-8 bg-input pr-5" />
                  <span className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground/40 font-mono text-xs">%</span>
                </div>
              </div>
            ))}
          </div>

          {/* Results */}
          <div className="space-y-3">
            {scenarios.map((s, i) => {
              const { gross, afterTax, roi } = calcScenario(s);
              const positive = afterTax >= 0;
              return (
                <div key={i} className={cn(
                  "bg-card border rounded-xl p-4 transition-all",
                  positive ? "border-card-border hover:border-emerald-500/20" : "border-card-border hover:border-red-500/20"
                )}>
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <span className="font-mono font-bold text-sm text-foreground">{s.name}</span>
                      <Badge variant="outline" className="font-mono text-[9px]">${s.price} / token</Badge>
                      <Badge variant="outline" className="font-mono text-[9px] text-muted-foreground">{s.probability}% likely</Badge>
                    </div>
                  </div>
                  <div className="grid grid-cols-3 gap-3">
                    <div>
                      <div className="font-mono text-[9px] text-muted-foreground/50 uppercase">Gross</div>
                      <div className="font-mono text-sm font-bold text-foreground">{fmt(gross)}</div>
                    </div>
                    <div>
                      <div className="font-mono text-[9px] text-muted-foreground/50 uppercase">After Tax</div>
                      <div className={cn("font-mono text-sm font-bold", positive ? "text-emerald-400" : "text-red-400")}>{fmt(afterTax)}</div>
                    </div>
                    <div>
                      <div className="font-mono text-[9px] text-muted-foreground/50 uppercase">ROI</div>
                      <div className={cn("font-mono text-sm font-bold", positive ? "text-emerald-400" : "text-red-400")}>{pct(roi)}</div>
                    </div>
                  </div>
                  {/* Progress bar */}
                  <div className="mt-2 h-1 bg-muted/20 rounded-full overflow-hidden">
                    <div
                      className={cn("h-full rounded-full transition-all", positive ? "bg-emerald-400" : "bg-red-400")}
                      style={{ width: `${Math.min(Math.abs(roi) / 5, 100)}%` }}
                    />
                  </div>
                </div>
              );
            })}

            {/* Expected Value */}
            <div className={cn(
              "border rounded-xl p-4",
              expectedValue >= 0 ? "bg-emerald-500/5 border-emerald-500/20" : "bg-red-500/5 border-red-500/20"
            )}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <TrendingUp className={cn("w-4 h-4", expectedValue >= 0 ? "text-emerald-400" : "text-red-400")} />
                  <span className="font-mono font-bold text-sm uppercase tracking-wider text-foreground">Expected Value</span>
                </div>
                <div className="text-right">
                  <div className={cn("font-mono font-bold text-xl", expectedValue >= 0 ? "text-emerald-400" : "text-red-400")}>
                    {fmt(expectedValue)}
                  </div>
                  <div className="font-mono text-[10px] text-muted-foreground/50">probability-weighted profit</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
