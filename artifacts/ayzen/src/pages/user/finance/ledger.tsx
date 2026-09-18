import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Loader2, Download, Upload, FileText, ScrollText } from "lucide-react";
import { financeApi } from "@/lib/finance-api";
import type { FinanceEntry, FinanceKind } from "@/config/finance";
import { fmtMoney, KIND_LABELS, STATUS_STYLES } from "@/config/finance";
import { cn } from "@/lib/utils";
import { FinancePageHeader, FinanceEmptyState, FinanceLoader } from "@/components/finance/finance-ui";

export default function FinanceLedgerPage() {
  const { token, isLoading: authLoading } = useAuth();
  const { toast } = useToast();
  const [entries, setEntries] = useState<FinanceEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [kindFilter, setKindFilter] = useState<string>("all");
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const load = () => {
    if (authLoading || !token) return;
    setLoading(true);
    financeApi.listEntries(token, kindFilter !== "all" ? { kind: kindFilter } : {})
      .then(setEntries)
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, [token, authLoading, kindFilter]);

  const handleExport = async (format: "csv" | "pdf") => {
    setExporting(true);
    try {
      await financeApi.downloadExport(token, kindFilter !== "all" ? kindFilter : undefined, format);
    } catch (e: any) {
      toast({ variant: "destructive", title: "Export failed", description: e?.message });
    } finally {
      setExporting(false);
    }
  };

  const handleImportFile = async (file: File) => {
    setImporting(true);
    try {
      const text = await file.text();
      const result = await financeApi.importCsv(token, text);
      toast({
        title: `Imported ${result.inserted} entr${result.inserted === 1 ? "y" : "ies"}`,
        description: result.failed > 0 ? `${result.failed} row(s) skipped — check formatting` : undefined,
      });
      load();
    } catch (e: any) {
      toast({ variant: "destructive", title: "Import failed", description: e?.message });
    } finally {
      setImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  return (
    <div className="space-y-5 page-enter">
      <FinancePageHeader
        eyebrow="Finance"
        title="Ledger / Transactions"
        description="Raw audit trail — shob transaction ekjaigay"
        actions={
          <div className="flex items-center gap-2 flex-wrap">
            <Select value={kindFilter} onValueChange={setKindFilter}>
              <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All types</SelectItem>
                {(Object.keys(KIND_LABELS) as FinanceKind[]).map(k => (
                  <SelectItem key={k} value={k}>{KIND_LABELS[k]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <input ref={fileInputRef} type="file" accept=".csv" className="hidden" onChange={e => e.target.files?.[0] && handleImportFile(e.target.files[0])} />
            <Button size="sm" variant="outline" onClick={() => fileInputRef.current?.click()} disabled={importing}>
              {importing ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Upload className="h-4 w-4 mr-1.5" />}
              Import CSV
            </Button>
            <Button size="sm" variant="outline" onClick={() => handleExport("csv")} disabled={exporting}>
              <Download className="h-4 w-4 mr-1.5" /> CSV
            </Button>
            <Button size="sm" variant="outline" onClick={() => handleExport("pdf")} disabled={exporting}>
              <FileText className="h-4 w-4 mr-1.5" /> PDF
            </Button>
          </div>
        }
      />

      <p className="text-xs text-muted-foreground">
        CSV import columns: <code className="font-mono rounded bg-muted px-1 py-0.5">kind,title,amount,currency,category,dueDate,status,interestRate,notes</code>
      </p>

      {loading ? (
        <FinanceLoader />
      ) : entries.length === 0 ? (
        <FinanceEmptyState icon={ScrollText} title="No transactions yet" description="Ledger entries appear here as soon as anything is recorded." />
      ) : (
        <div className="rounded-xl border border-card-border bg-card overflow-hidden overflow-x-auto elevation-1">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Title</TableHead>
                <TableHead>Amount</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map(e => (
                <TableRow key={e.id} className="table-row-premium">
                  <TableCell className="text-xs text-muted-foreground whitespace-nowrap">{new Date(e.occurredDate).toLocaleDateString()}</TableCell>
                  <TableCell><Badge variant="outline">{KIND_LABELS[e.kind]}</Badge></TableCell>
                  <TableCell className="font-medium">{e.title}</TableCell>
                  <TableCell className="font-mono">{fmtMoney(e.amount, e.currency)}</TableCell>
                  <TableCell><Badge variant="outline" className={cn("capitalize", STATUS_STYLES[e.status])}>{e.status}</Badge></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
