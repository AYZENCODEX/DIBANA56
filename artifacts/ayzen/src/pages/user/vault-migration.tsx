/**
 * vault-migration.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Feature 13 — Import/Export Migration Tool.
 *
 * Export: caller's own active Vault entries as CSV or JSON (portable,
 * NOT encrypted — see vault-snapshot.tsx for the encrypted full backup).
 * Import: AYZEN's own CSV/JSON format, or a raw CSV export from 1Password,
 * Bitwarden, or LastPass. Row-level failures are reported individually.
 */
import { useRef, useState } from "react";
import { ArrowDownToLine, ArrowUpFromLine, FileJson, FileSpreadsheet, Loader2, Upload, CheckCircle2, AlertTriangle } from "lucide-react";
import { VaultSectionPage } from "@/components/layout/vault-sidebar";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import {
  exportVault, importVault, fileToText,
  type ImportFormat, type ImportResult,
} from "@/lib/vault-migration-api";

const IMPORT_SOURCES: { id: ImportFormat; label: string; hint: string }[] = [
  { id: "ayzen_csv", label: "AYZEN CSV", hint: "Re-import a CSV you exported from AYZEN" },
  { id: "ayzen_json", label: "AYZEN JSON", hint: "Re-import a JSON export from AYZEN" },
  { id: "1password", label: "1Password", hint: "1Password's \"Export as CSV\" logins file" },
  { id: "bitwarden", label: "Bitwarden", hint: "Bitwarden's \"Export vault\" CSV file" },
  { id: "lastpass", label: "LastPass", hint: "LastPass's \"Export\" CSV file" },
];

export default function VaultMigration() {
  const { toast } = useToast();
  const [exporting, setExporting] = useState<"csv" | "json" | null>(null);
  const [source, setSource] = useState<ImportFormat>("ayzen_csv");
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function handleExport(format: "csv" | "json") {
    setExporting(format);
    try {
      await exportVault(format);
      toast({ title: `Export ready`, description: `Your Vault entries were downloaded as ${format.toUpperCase()}.` });
    } catch {
      toast({ title: "Export failed", variant: "destructive" });
    } finally {
      setExporting(null);
    }
  }

  async function handleFilePicked(file: File) {
    setImporting(true);
    setResult(null);
    try {
      const text = await fileToText(file);
      const res = await importVault(source, text);
      setResult(res);
      if (res.imported > 0) {
        toast({ title: `Imported ${res.imported} ${res.imported === 1 ? "entry" : "entries"}`, description: res.skipped ? `${res.skipped} row(s) skipped — see details below.` : undefined });
      } else {
        toast({ title: "Nothing was imported", description: "Check the file format matches the source you selected.", variant: "destructive" });
      }
    } catch (err: any) {
      toast({ title: "Import failed", description: err?.message, variant: "destructive" });
    } finally {
      setImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  return (
    <VaultSectionPage
      title="Import / Export"
      description="Move Vault entries in from another tool, or out to a CSV/JSON file"
      icon={ArrowDownToLine}
    >
      <div className="space-y-4">
        {/* ── Export ──────────────────────────────────────────────────── */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-mono uppercase tracking-wide flex items-center gap-2">
              <ArrowDownToLine className="w-4 h-4 text-primary/70" /> Export Vault
            </CardTitle>
            <CardDescription className="font-mono text-xs">
              Download your active Vault entries in a portable, unencrypted format —
              for a fully encrypted full-vault backup, use Snapshot Backup instead.
            </CardDescription>
          </CardHeader>
          <CardFooter className="flex gap-2 flex-wrap">
            <Button
              variant="outline" size="sm" className="font-mono text-xs gap-1.5"
              disabled={exporting !== null}
              onClick={() => handleExport("csv")}
            >
              {exporting === "csv" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FileSpreadsheet className="w-3.5 h-3.5" />}
              Export as CSV
            </Button>
            <Button
              variant="outline" size="sm" className="font-mono text-xs gap-1.5"
              disabled={exporting !== null}
              onClick={() => handleExport("json")}
            >
              {exporting === "json" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FileJson className="w-3.5 h-3.5" />}
              Export as JSON
            </Button>
          </CardFooter>
        </Card>

        {/* ── Import ──────────────────────────────────────────────────── */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-mono uppercase tracking-wide flex items-center gap-2">
              <ArrowUpFromLine className="w-4 h-4 text-primary/70" /> Import Into Vault
            </CardTitle>
            <CardDescription className="font-mono text-xs">
              Imports are additive — new entries are created, nothing existing is overwritten.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-1.5">
              <Label className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground/60">Source</Label>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {IMPORT_SOURCES.map(s => (
                  <button
                    key={s.id}
                    onClick={() => setSource(s.id)}
                    className={`text-left px-3 py-2 rounded-lg border font-mono text-xs transition-colors ${
                      source === s.id
                        ? "bg-primary/10 border-primary/30 text-primary font-bold"
                        : "border-border/30 text-muted-foreground/70 hover:border-border/50 hover:text-foreground"
                    }`}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
              <p className="font-mono text-[10px] text-muted-foreground/45">
                {IMPORT_SOURCES.find(s => s.id === source)?.hint}
              </p>
            </div>

            {result && (
              <div className="rounded-lg border border-border/30 bg-muted/10 p-3 space-y-2">
                <div className="flex items-center gap-2 font-mono text-xs">
                  <CheckCircle2 className="w-4 h-4 text-emerald-400 flex-shrink-0" />
                  <span>{result.imported} imported</span>
                  {result.skipped > 0 && (
                    <span className="text-amber-400 flex items-center gap-1">
                      <AlertTriangle className="w-3.5 h-3.5" /> {result.skipped} skipped
                    </span>
                  )}
                </div>
                {result.errors.length > 0 && (
                  <div className="space-y-1 max-h-40 overflow-y-auto">
                    {result.errors.map((e, i) => (
                      <p key={i} className="font-mono text-[10px] text-muted-foreground/60">
                        Row {e.row ?? e.index}: {e.reason}
                      </p>
                    ))}
                  </div>
                )}
              </div>
            )}
          </CardContent>
          <CardFooter>
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,.json,text/csv,application/json"
              className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFilePicked(f); }}
            />
            <Button
              size="sm" className="font-mono text-xs gap-1.5"
              disabled={importing}
              onClick={() => fileInputRef.current?.click()}
            >
              {importing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
              Choose File & Import
            </Button>
          </CardFooter>
        </Card>
      </div>
    </VaultSectionPage>
  );
}
