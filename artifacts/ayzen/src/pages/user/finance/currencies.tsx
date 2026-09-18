import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2, Save, Coins, Plus } from "lucide-react";
import { financeApi } from "@/lib/finance-api";
import type { FinanceCurrencyRate } from "@/config/finance";
import { CURRENCY_OPTIONS, CRYPTO_CURRENCY_OPTIONS, CURRENCY_SYMBOLS } from "@/config/finance";
import { FinancePageHeader, FinanceLoader } from "@/components/finance/finance-ui";

export default function FinanceCurrenciesPage() {
  const { token, isLoading: authLoading } = useAuth();
  const { toast } = useToast();
  const [rates, setRates] = useState<FinanceCurrencyRate[]>([]);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [newCode, setNewCode] = useState("");

  const load = useCallback(() => {
    if (authLoading || !token) return;
    setLoading(true);
    financeApi.listCurrencies(token).then((data: FinanceCurrencyRate[]) => {
      setRates(data);
      setEdits(Object.fromEntries(data.map(r => [r.currency, String(r.rateToBase)])));
    }).catch(() => {}).finally(() => setLoading(false));
  }, [token, authLoading]);

  useEffect(() => { load(); }, [load]);

  // Known presets (fiat + the wallet's supported crypto tokens) that don't
  // yet have a saved rate, plus any currency the user has added on the fly
  // (via "Add currency" below) that isn't a preset and has no saved rate yet.
  const presets = [...CURRENCY_OPTIONS, ...CRYPTO_CURRENCY_OPTIONS];
  const missingPresets = presets.filter(c => !rates.some(r => r.currency === c));
  const pendingCustom = Object.keys(edits).filter(
    c => !rates.some(r => r.currency === c) && !presets.includes(c)
  );
  const allCurrencies = [...rates.map(r => r.currency), ...missingPresets, ...pendingCustom];

  const addCurrency = () => {
    const code = newCode.trim().toUpperCase();
    if (!code) return;
    if (!/^[A-Z0-9]{2,10}$/.test(code)) {
      toast({ variant: "destructive", title: "Use letters/numbers only, e.g. ETH or USDT" });
      return;
    }
    if (allCurrencies.includes(code)) {
      toast({ variant: "destructive", title: `${code} is already in the list below` });
      setNewCode("");
      return;
    }
    setEdits(prev => ({ ...prev, [code]: prev[code] ?? "" }));
    setNewCode("");
  };

  const save = async (currency: string) => {
    if (currency === "BDT") return;
    const rate = parseFloat(edits[currency] ?? "");
    if (!rate || rate <= 0) { toast({ variant: "destructive", title: "Enter a valid rate" }); return; }
    setSavingKey(currency);
    try {
      await financeApi.setCurrencyRate(token, currency, rate);
      toast({ title: `${currency} rate saved` });
      load();
    } catch (e: any) {
      toast({ variant: "destructive", title: "Failed", description: e?.message });
    } finally {
      setSavingKey(null);
    }
  };

  if (loading) return <FinanceLoader />;

  return (
    <div className="space-y-5 max-w-lg page-enter">
      <FinancePageHeader
        eyebrow="Finance"
        title="Currency Rates"
        description="BDT holo base currency. Onno currency-r entry gula dashboard/analytics e BDT-e convert korte ei rate use hoy — manually update rakho."
      />

      <div className="flex items-center gap-2">
        <Input
          value={newCode}
          onChange={e => setNewCode(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); addCurrency(); } }}
          placeholder="Add a currency code, e.g. ETH, USDT, BTC"
          className="flex-1"
        />
        <Button size="icon" variant="outline" className="h-9 w-9 shrink-0" onClick={addCurrency}>
          <Plus className="h-4 w-4" />
        </Button>
      </div>
      <p className="text-xs text-muted-foreground -mt-3">
        Add any currency or crypto token code (e.g. wallet deposits/withdrawals like ETH, USDT, BNB) so it has a
        conversion rate — otherwise it's treated as 1:1 with BDT everywhere.
      </p>

      <div className="rounded-xl border border-card-border bg-card divide-y divide-border overflow-hidden elevation-1">
        {allCurrencies.map(currency => (
          <div key={currency} className="flex items-center gap-3 p-3.5 table-row-premium">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary ring-1 ring-primary/20">
              <Coins className="h-4 w-4" />
            </div>
            <div className="w-16 shrink-0">
              <p className="font-semibold">{currency}</p>
              <p className="text-xs text-muted-foreground">{CURRENCY_SYMBOLS[currency] ?? currency}</p>
            </div>
            {currency === "BDT" ? (
              <p className="text-sm text-muted-foreground flex-1">Base currency — always 1</p>
            ) : (
              <>
                <div className="flex-1 flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">1 {currency} =</span>
                  <Input
                    type="number"
                    className="w-32"
                    value={edits[currency] ?? ""}
                    onChange={e => setEdits(prev => ({ ...prev, [currency]: e.target.value }))}
                    placeholder="e.g. 122"
                  />
                  <span className="text-xs text-muted-foreground">BDT</span>
                </div>
                <Button size="icon" variant="outline" className="h-8 w-8 shrink-0" onClick={() => save(currency)} disabled={savingKey === currency}>
                  {savingKey === currency ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                </Button>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
