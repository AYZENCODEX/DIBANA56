/**
 * vault-compliance.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Feature 14 — Compliance Audit Report Export.
 *
 * Date-ranged CSV/PDF export of the caller's own activity, merging the
 * account-level (user_activity) and Vault-level (vault_activity_log) audit
 * trails into one timeline. See routes/compliance-report.ts.
 */
import { useState } from "react";
import { FileBarChart, Loader2, FileText, FileSpreadsheet } from "lucide-react";
import { VaultSectionPage } from "@/components/layout/vault-sidebar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { downloadComplianceReport, type ReportFormat } from "@/lib/compliance-report-api";

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export default function VaultCompliance() {
  const { toast } = useToast();
  const [from, setFrom] = useState(isoDate(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)));
  const [to, setTo] = useState(isoDate(new Date()));
  const [downloading, setDownloading] = useState<ReportFormat | null>(null);

  async function handleDownload(format: ReportFormat) {
    if (!from || !to) { toast({ title: "Choose a start and end date", variant: "destructive" }); return; }
    if (from > to) { toast({ title: "Start date must be before end date", variant: "destructive" }); return; }
    setDownloading(format);
    try {
      await downloadComplianceReport(from, to, format);
      toast({ title: "Report downloaded" });
    } catch (err: any) {
      toast({ title: "Couldn't generate report", description: err?.message, variant: "destructive" });
    } finally {
      setDownloading(null);
    }
  }

  return (
    <VaultSectionPage
      title="Compliance Report"
      description="Export your account & Vault activity for a date range as CSV or PDF"
      icon={FileBarChart}
    >
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-mono uppercase tracking-wide flex items-center gap-2">
            <FileBarChart className="w-4 h-4 text-primary/70" /> Activity Report
          </CardTitle>
          <CardDescription className="font-mono text-xs">
            Combines your account activity log and Vault entity activity log into one timeline.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid sm:grid-cols-2 gap-3 max-w-md">
            <div className="space-y-1.5">
              <Label className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground/60">From</Label>
              <Input type="date" value={from} onChange={e => setFrom(e.target.value)} className="font-mono text-sm" />
            </div>
            <div className="space-y-1.5">
              <Label className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground/60">To</Label>
              <Input type="date" value={to} onChange={e => setTo(e.target.value)} className="font-mono text-sm" />
            </div>
          </div>
        </CardContent>
        <CardFooter className="flex gap-2 flex-wrap">
          <Button
            variant="outline" size="sm" className="font-mono text-xs gap-1.5"
            disabled={downloading !== null}
            onClick={() => handleDownload("csv")}
          >
            {downloading === "csv" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FileSpreadsheet className="w-3.5 h-3.5" />}
            Download CSV
          </Button>
          <Button
            size="sm" className="font-mono text-xs gap-1.5"
            disabled={downloading !== null}
            onClick={() => handleDownload("pdf")}
          >
            {downloading === "pdf" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FileText className="w-3.5 h-3.5" />}
            Download PDF
          </Button>
        </CardFooter>
      </Card>
    </VaultSectionPage>
  );
}
