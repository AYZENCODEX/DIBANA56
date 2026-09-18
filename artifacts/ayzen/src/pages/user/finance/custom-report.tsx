import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Switch } from "@/components/ui/switch";
import { Download, FileText, Loader2, BarChart2, CalendarClock, Plus, Trash2 } from "lucide-react";
import { financeApi } from "@/lib/finance-api";
import type { CustomReportResult, ReportGroupBy, FinanceBook, FinanceReportSchedule, ScheduledReportType } from "@/config/finance";
import { fmtMoney } from "@/config/finance";
import { FinancePageHeader, SectionEyebrow, FinanceEmptyState, FinanceLoader, FinanceCard } from "@/components/finance/finance-ui";

const GROUP_BY_OPTIONS: { value: ReportGroupBy; label: string }[] = [
  { value: "kind", label: "Kind" },
  { value: "category", label: "Category" },
  { value: "party", label: "Party" },
  { value: "month", label: "Month" },
  { value: "status", label: "Status" },
  { value: "currency", label: "Currency" },
];

const SCHEDULE_TYPE_OPTIONS: { value: ScheduledReportType; label: string }[] = [
  { value: "income_statement", label: "Income Statement" },
  { value: "balance_sheet", label: "Balance Sheet" },
  { value: "trial_balance", label: "Trial Balance" },
  { value: "cash_flow", label: "Cash Flow" },
];

function ReportBuilder() {
  const { token } = useAuth();
  const { toast } = useToast();
  const [books, setBooks] = useState<FinanceBook[]>([]);
  const [bookId, setBookId] = useState<string>("all");
  const [groupBy, setGroupBy] = useState<ReportGroupBy>("category");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [result, setResult] = useState<CustomReportResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);

  useEffect(() => { financeApi.listBooks(token).then(setBooks).catch(() => setBooks([])); }, [token]);

  const params = useCallback(() => ({
    groupBy, from: from || undefined, to: to || undefined,
    bookId: bookId !== "all" ? Number(bookId) : undefined,
  }), [groupBy, from, to, bookId]);

  const run = useCallback(() => {
    setLoading(true);
    financeApi.customReport(token, params()).then(setResult).catch((e) => {
      toast({ variant: "destructive", title: "Failed to build report", description: e?.message });
    }).finally(() => setLoading(false));
  }, [token, params, toast]);

  useEffect(() => { run(); }, [run]);

  const handleExport = async (format: "csv" | "pdf") => {
    setExporting(true);
    try {
      await financeApi.downloadCustomReport(token, params() as Record<string, string | number | undefined>, format);
    } catch (e: any) {
      toast({ variant: "destructive", title: "Export failed", description: e?.message });
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="space-y-4">
      <FinanceCard className="space-y-3">
        <div className="grid sm:grid-cols-4 gap-3">
          <div>
            <Label>Group by</Label>
            <Select value={groupBy} onValueChange={v => setGroupBy(v as ReportGroupBy)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {GROUP_BY_OPTIONS.map(o => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Book</Label>
            <Select value={bookId} onValueChange={setBookId}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Default book</SelectItem>
                {books.map(b => <SelectItem key={b.id} value={String(b.id)}>{b.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>From</Label>
            <Input type="date" value={from} onChange={e => setFrom(e.target.value)} />
          </div>
          <div>
            <Label>To</Label>
            <Input type="date" value={to} onChange={e => setTo(e.target.value)} />
          </div>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => handleExport("csv")} disabled={exporting || !result}>
            {exporting ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Download className="h-3.5 w-3.5 mr-1.5" />} CSV
          </Button>
          <Button size="sm" variant="outline" onClick={() => handleExport("pdf")} disabled={exporting || !result}>
            {exporting ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <FileText className="h-3.5 w-3.5 mr-1.5" />} PDF
          </Button>
        </div>
      </FinanceCard>

      {loading ? (
        <FinanceLoader />
      ) : !result || result.groups.length === 0 ? (
        <FinanceEmptyState icon={BarChart2} title="No data for this filter" description="Ei date range ba book e kono finance entry nei." />
      ) : (
        <div className="rounded-xl border border-card-border bg-card overflow-hidden overflow-x-auto elevation-1">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{GROUP_BY_OPTIONS.find(o => o.value === result.groupBy)?.label ?? "Group"}</TableHead>
                <TableHead>Entries</TableHead>
                <TableHead className="text-right">Total (BDT)</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.groups.map(g => (
                <TableRow key={g.label} className="table-row-premium">
                  <TableCell className="font-medium">{g.label}</TableCell>
                  <TableCell className="text-muted-foreground text-xs">{g.count}</TableCell>
                  <TableCell className="text-right font-mono text-xs font-semibold">{fmtMoney(g.total)}</TableCell>
                </TableRow>
              ))}
              <TableRow>
                <TableCell className="font-semibold">Grand Total</TableCell>
                <TableCell className="text-muted-foreground text-xs">{result.entryCount}</TableCell>
                <TableCell className="text-right font-mono text-sm font-bold">{fmtMoney(result.grandTotal)}</TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

function ScheduledReports() {
  const { token } = useAuth();
  const { toast } = useToast();
  const [books, setBooks] = useState<FinanceBook[]>([]);
  const [schedules, setSchedules] = useState<FinanceReportSchedule[]>([]);
  const [loading, setLoading] = useState(true);
  const [reportType, setReportType] = useState<ScheduledReportType>("income_statement");
  const [bookId, setBookId] = useState<string>("all");
  const [dayOfMonth, setDayOfMonth] = useState("1");
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([financeApi.listReportSchedules(token), financeApi.listBooks(token)])
      .then(([s, b]) => { setSchedules(s); setBooks(b); })
      .finally(() => setLoading(false));
  }, [token]);

  useEffect(() => { load(); }, [load]);

  const bookName = (id: number | null) => id ? (books.find(b => b.id === id)?.name ?? `Book #${id}`) : "All books";

  const create = async () => {
    setSaving(true);
    try {
      await financeApi.createReportSchedule(token, {
        reportType, bookId: bookId !== "all" ? Number(bookId) : undefined, dayOfMonth: Number(dayOfMonth) || 1,
      });
      toast({ title: "Schedule created" });
      load();
    } catch (e: any) {
      toast({ variant: "destructive", title: "Failed", description: e?.message });
    } finally {
      setSaving(false);
    }
  };

  const toggleActive = async (s: FinanceReportSchedule) => {
    try {
      await financeApi.updateReportSchedule(token, s.id, { active: !s.active });
      load();
    } catch (e: any) {
      toast({ variant: "destructive", title: "Failed", description: e?.message });
    }
  };

  const remove = async (id: number) => {
    if (!confirm("Delete this schedule?")) return;
    try {
      await financeApi.deleteReportSchedule(token, id);
      toast({ title: "Deleted" });
      load();
    } catch (e: any) {
      toast({ variant: "destructive", title: "Failed", description: e?.message });
    }
  };

  return (
    <div className="space-y-4">
      <FinanceCard className="space-y-3">
        <p className="text-sm font-medium">New monthly email schedule</p>
        <div className="grid sm:grid-cols-4 gap-3">
          <div>
            <Label>Report</Label>
            <Select value={reportType} onValueChange={v => setReportType(v as ScheduledReportType)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {SCHEDULE_TYPE_OPTIONS.map(o => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Book</Label>
            <Select value={bookId} onValueChange={setBookId}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All books</SelectItem>
                {books.map(b => <SelectItem key={b.id} value={String(b.id)}>{b.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Day of month</Label>
            <Input type="number" min={1} max={28} value={dayOfMonth} onChange={e => setDayOfMonth(e.target.value)} />
          </div>
          <div className="flex items-end">
            <Button size="sm" className="w-full" onClick={create} disabled={saving}>
              {saving ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Plus className="h-3.5 w-3.5 mr-1.5" />} Add schedule
            </Button>
          </div>
        </div>
      </FinanceCard>

      {loading ? (
        <FinanceLoader />
      ) : schedules.length === 0 ? (
        <FinanceEmptyState icon={CalendarClock} title="No scheduled reports" description="Ekta report add koro — proti mash oi din PDF email hoye jabe." />
      ) : (
        <div className="space-y-2">
          {schedules.map(s => (
            <FinanceCard key={s.id} className="flex items-center justify-between py-3">
              <div>
                <p className="font-medium text-sm">{SCHEDULE_TYPE_OPTIONS.find(o => o.value === s.reportType)?.label ?? s.reportType}</p>
                <p className="text-xs text-muted-foreground">{bookName(s.bookId)} · Day {s.dayOfMonth} of every month{s.lastSentAt ? ` · last sent ${new Date(s.lastSentAt).toLocaleDateString()}` : ""}</p>
              </div>
              <div className="flex items-center gap-3">
                <Switch checked={!!s.active} onCheckedChange={() => toggleActive(s)} />
                <Button variant="ghost" size="icon" className="h-7 w-7 text-danger" onClick={() => remove(s.id)}><Trash2 className="h-3.5 w-3.5" /></Button>
              </div>
            </FinanceCard>
          ))}
        </div>
      )}
    </div>
  );
}

export default function FinanceCustomReportPage() {
  return (
    <div className="space-y-6 page-enter">
      <FinancePageHeader
        eyebrow="Finance · Accounting · Reports"
        title="Custom Report Builder"
        description="Pivot your entries by kind, category, party, month, status, or currency — export as CSV/PDF, or schedule a monthly email"
      />

      <div className="space-y-2.5">
        <SectionEyebrow icon={BarChart2}>Build a report</SectionEyebrow>
        <ReportBuilder />
      </div>

      <div className="space-y-2.5">
        <SectionEyebrow icon={CalendarClock}>Scheduled monthly reports</SectionEyebrow>
        <ScheduledReports />
      </div>
    </div>
  );
}
