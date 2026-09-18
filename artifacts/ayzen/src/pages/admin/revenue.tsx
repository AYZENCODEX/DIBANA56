import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from "@/components/ui/table";
import { Wallet, RefreshCw, Loader2 } from "lucide-react";

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";
const tok = () => localStorage.getItem("ayzen_token") ?? "";
const api = (path: string) =>
  fetch(`${BASE}/api${path}`, { headers: { Authorization: `Bearer ${tok()}` } });

interface LedgerRow {
  id: number;
  source: string;
  amount: number;
  currency: string;
  refId: string | null;
  userId: number | null;
  note: string | null;
  createdAt: string;
}
interface Summary {
  balances: { currency: string; total: number }[];
  recent: LedgerRow[];
}

const SOURCE_LABEL: Record<string, string> = {
  marketplace_fee: "Marketplace fee",
  subscription: "Subscription",
  account_sale: "Account sale",
  otp_sale: "OTP sale",
  manual: "Manual adjustment",
};

export default function AdminRevenue() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api("/admin/wallet");
      const data = await res.json();
      setSummary(res.ok ? data : null);
    } catch {
      setSummary(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <Wallet className="w-5 h-5 text-primary" /> Admin Wallet
          </h1>
          <p className="text-sm text-muted-foreground font-mono">
            Platform revenue — marketplace fees, subscriptions, and AYZEN account/OTP store sales
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
        </Button>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {(summary?.balances.length ? summary.balances : [{ currency: "AZN", total: 0 }]).map(b => (
          <Card key={b.currency}>
            <CardHeader className="pb-2">
              <CardTitle className="text-xs font-mono uppercase text-muted-foreground">{b.currency} balance</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold font-mono text-primary">{b.total.toLocaleString(undefined, { maximumFractionDigits: 2 })}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader><CardTitle className="text-sm">Recent ledger entries</CardTitle></CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Source</TableHead>
                <TableHead>Amount</TableHead>
                <TableHead>Ref</TableHead>
                <TableHead>User</TableHead>
                <TableHead>Note</TableHead>
                <TableHead>Date</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(summary?.recent ?? []).map(r => (
                <TableRow key={r.id}>
                  <TableCell><Badge variant="outline" className="font-mono text-[10px]">{SOURCE_LABEL[r.source] ?? r.source}</Badge></TableCell>
                  <TableCell className="font-mono">{r.amount.toFixed(2)} {r.currency}</TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">{r.refId ?? "—"}</TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">{r.userId ?? "—"}</TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">{r.note ?? "—"}</TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">{new Date(r.createdAt).toLocaleString()}</TableCell>
                </TableRow>
              ))}
              {(!summary || summary.recent.length === 0) && !loading && (
                <TableRow><TableCell colSpan={6} className="text-center text-sm text-muted-foreground py-6">No revenue recorded yet.</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
