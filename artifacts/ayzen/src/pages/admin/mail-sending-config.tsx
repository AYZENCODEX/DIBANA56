/**
 * pages/admin/mail-sending-config.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Bounce + Complaint Handling (Phase 3 follow-up) — admin frontend for the
 * thresholds GET/PATCH /admin/mail-sending-config already exposed (see
 * artifacts/api-server/src/lib/mail-sending-config.ts). Phase 3 shipped
 * that API with no UI calling it; this is that UI.
 *
 * One singleton row, so this is a form, not a list — closer to
 * admin/settings.tsx's save-a-section pattern than admin/health-rules.tsx's
 * CRUD-list pattern, even though the icon/description conventions below
 * borrow from health-rules.tsx.
 */
import { useState, useEffect } from "react";
import { customFetch } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ShieldAlert, Loader2, Save } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

type SendingConfig = {
  bounceFlagThreshold: number;
  windowDays: number;
  minSampleSize: number;
  warningBounceRateBp: number;
  pauseBounceRateBp: number;
  pauseComplaintRateBp: number;
  complaintHardCap: number;
  digestTriggerCount: number;
  digestBurstMinutes: number;
};

// Basis points (500 = 5.00%) <-> the plain percentage the form shows —
// matches how the backend stores/compares these (see migrations/053's
// comment on why basis points instead of floats).
const bpToPct = (bp: number) => (bp / 100).toString();
const pctToBp = (pct: string) => Math.round((parseFloat(pct) || 0) * 100);

const FIELDS: { key: keyof SendingConfig; label: string; help: string; isRate?: boolean; suffix?: string }[] = [
  { key: "bounceFlagThreshold", label: "Bounce flag threshold", help: "Consecutive bounces before a single recipient is flagged", suffix: "bounces" },
  { key: "windowDays", label: "Rolling window", help: "How many days of sending the rates below are measured over", suffix: "days" },
  { key: "minSampleSize", label: "Minimum sample size", help: "Rates don't apply until at least this many messages were sent in the window", suffix: "sends" },
  { key: "warningBounceRateBp", label: "Warning bounce rate", help: "Bounce rate that marks an account \"Elevated\" (not yet paused)", isRate: true },
  { key: "pauseBounceRateBp", label: "Pause bounce rate", help: "Bounce rate that pauses an account's sending entirely", isRate: true },
  { key: "pauseComplaintRateBp", label: "Pause complaint rate", help: "Complaint rate that pauses an account's sending entirely", isRate: true },
  { key: "complaintHardCap", label: "Complaint hard cap", help: "This many complaints in the window pauses sending regardless of rate", suffix: "complaints" },
  { key: "digestTriggerCount", label: "Digest trigger count", help: "Individual bounce/complaint notifications allowed in a burst before switching to a batched summary (Phase 4)", suffix: "notices" },
  { key: "digestBurstMinutes", label: "Digest burst window", help: "How long a burst of notifications counts toward the trigger above", suffix: "minutes" },
];

export default function AdminMailSendingConfigPage() {
  const [config, setConfig] = useState<SendingConfig | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();

  const load = async () => {
    setLoading(true);
    try {
      const data = await customFetch<SendingConfig>("/admin/mail-sending-config");
      setConfig(data);
      setForm(Object.fromEntries(FIELDS.map((f) => [f.key, f.isRate ? bpToPct(data[f.key]) : String(data[f.key])])));
    } catch {
      toast({ title: "Failed to load sending config", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    setSaving(true);
    try {
      const body: Record<string, number> = {};
      for (const f of FIELDS) {
        const raw = form[f.key] ?? "";
        body[f.key] = f.isRate ? pctToBp(raw) : Math.max(0, Math.round(parseFloat(raw) || 0));
      }
      const updated = await customFetch<SendingConfig>("/admin/mail-sending-config", { method: "PATCH", body: JSON.stringify(body) });
      setConfig(updated);
      setForm(Object.fromEntries(FIELDS.map((f) => [f.key, f.isRate ? bpToPct(updated[f.key]) : String(updated[f.key])])));
      toast({ title: "Sending config saved" });
    } catch {
      toast({ title: "Failed to save", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const dirty = config !== null && FIELDS.some((f) => form[f.key] !== (f.isRate ? bpToPct(config[f.key]) : String(config[f.key])));

  return (
    <div className="p-6 max-w-2xl mx-auto space-y-5">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-bold text-foreground flex items-center gap-2">
            <ShieldAlert className="w-5 h-5 text-primary" /> Mail Sending Health Thresholds
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Controls when a recipient gets flagged (Bounce + Complaint Handling Phase 2) and
            when an account's own sending gets auto-paused (Phase 3). Applies platform-wide.
          </p>
        </div>
        <Button size="sm" onClick={save} disabled={saving || loading || !dirty} className="h-9 gap-2 flex-shrink-0">
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Save
        </Button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>
      ) : (
        <div className="space-y-4">
          {FIELDS.map((f) => (
            <div key={f.key} className="flex items-start justify-between gap-4 p-3 bg-card/60 border border-border/40 rounded-lg">
              <div className="min-w-0">
                <Label className="text-sm font-medium text-foreground">{f.label}</Label>
                <p className="text-xs text-muted-foreground mt-0.5">{f.help}</p>
              </div>
              <div className="flex items-center gap-1.5 flex-shrink-0">
                <Input
                  type="number" step={f.isRate ? "0.01" : "1"} min="0"
                  value={form[f.key] ?? ""}
                  onChange={(e) => setForm((prev) => ({ ...prev, [f.key]: e.target.value }))}
                  className="h-9 w-24 text-sm text-right bg-background/50"
                />
                <span className="text-xs text-muted-foreground w-14">{f.isRate ? "%" : f.suffix}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
