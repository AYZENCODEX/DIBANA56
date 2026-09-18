/**
 * components/project-dates-manager.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Admin-only widget for managing a project's airdrop-calendar dates (token
 * snapshot, TGE, claim deadline, etc) — plugs into the Settings tab of
 * pages/admin/project-detail.tsx. Backed by routes/project-dates.ts; every
 * date added here shows up on the user-facing /calendar page and gets a
 * 1-day-ahead Telegram reminder from lib/airdrop-reminder-cron.ts.
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2, CalendarClock } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { customFetch } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";

interface ProjectDate {
  id: number;
  label: string;
  eventType: string;
  eventDate: string;
  notes: string | null;
  remindedAt: string | null;
}

const EVENT_TYPES = [
  { value: "snapshot", label: "Token Snapshot" },
  { value: "tge", label: "TGE / Launch" },
  { value: "deadline", label: "Deadline" },
  { value: "claim", label: "Claim Window" },
  { value: "other", label: "Other" },
];

export function ProjectDatesManager({ projectId }: { projectId: number }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [form, setForm] = useState({ label: "", eventType: "snapshot", eventDate: "", notes: "" });
  const [saving, setSaving] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["project-dates", "project", projectId],
    queryFn: () => customFetch<ProjectDate[]>(`/api/projects/${projectId}/dates`),
    enabled: !!projectId,
  });

  const dates = (data ?? []).slice().sort((a, b) => new Date(a.eventDate).getTime() - new Date(b.eventDate).getTime());

  async function addDate() {
    if (!form.label.trim() || !form.eventDate) {
      toast({ title: "Label and date are required", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      await customFetch(`/api/projects/${projectId}/dates`, {
        method: "POST",
        body: JSON.stringify({ ...form, eventDate: new Date(form.eventDate).toISOString() }),
      });
      setForm({ label: "", eventType: "snapshot", eventDate: "", notes: "" });
      queryClient.invalidateQueries({ queryKey: ["project-dates"] });
      toast({ title: "Date added to calendar" });
    } catch (err: any) {
      toast({ title: "Failed to add date", description: err?.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  async function removeDate(id: number) {
    try {
      await customFetch(`/api/project-dates/${id}`, { method: "DELETE" });
      queryClient.invalidateQueries({ queryKey: ["project-dates"] });
    } catch (err: any) {
      toast({ title: "Failed to remove date", description: err?.message, variant: "destructive" });
    }
  }

  return (
    <Card className="bg-card border-card-border shadow-none">
      <CardHeader className="pb-3">
        <CardTitle className="font-mono text-xs uppercase text-primary/60 flex items-center gap-2">
          <CalendarClock className="w-3.5 h-3.5" /> Airdrop Calendar Dates
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="font-mono text-[10px] text-muted-foreground/50">
          Snapshot, TGE, claim, or deadline dates for this project — shown on every enrolled user's centralized calendar, with an automatic Telegram reminder ~1 day before.
        </p>

        {isLoading ? (
          <p className="font-mono text-[11px] text-muted-foreground/40">Loading…</p>
        ) : dates.length === 0 ? (
          <p className="font-mono text-[11px] text-muted-foreground/40">No dates added yet.</p>
        ) : (
          <div className="space-y-1.5">
            {dates.map((d) => (
              <div key={d.id} className="flex items-center gap-2 bg-muted/10 border border-border/30 rounded-lg px-3 py-2">
                <div className="flex-1 min-w-0">
                  <p className="font-mono text-xs text-foreground/90 truncate">{d.label}</p>
                  <p className="font-mono text-[10px] text-muted-foreground/50">
                    {EVENT_TYPES.find((t) => t.value === d.eventType)?.label ?? d.eventType} · {new Date(d.eventDate).toLocaleString()}
                    {d.remindedAt && " · reminder sent"}
                  </p>
                </div>
                <Button size="icon" variant="ghost" className="h-7 w-7 text-muted-foreground/40 hover:text-red-400" onClick={() => removeDate(d.id)}>
                  <Trash2 className="w-3.5 h-3.5" />
                </Button>
              </div>
            ))}
          </div>
        )}

        <div className="grid grid-cols-2 gap-2 pt-2 border-t border-border/30">
          <div className="space-y-1 col-span-2">
            <Label className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Label</Label>
            <Input
              value={form.label}
              onChange={(e) => setForm((p) => ({ ...p, label: e.target.value }))}
              placeholder="e.g. Token Snapshot #2"
              className="font-mono text-xs h-8 bg-input"
            />
          </div>
          <div className="space-y-1">
            <Label className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Type</Label>
            <Select value={form.eventType} onValueChange={(v) => setForm((p) => ({ ...p, eventType: v }))}>
              <SelectTrigger className="font-mono text-xs h-8 bg-input"><SelectValue /></SelectTrigger>
              <SelectContent>
                {EVENT_TYPES.map((t) => <SelectItem key={t.value} value={t.value} className="font-mono text-xs">{t.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Date & Time</Label>
            <Input
              type="datetime-local"
              value={form.eventDate}
              onChange={(e) => setForm((p) => ({ ...p, eventDate: e.target.value }))}
              className="font-mono text-xs h-8 bg-input"
            />
          </div>
          <div className="space-y-1 col-span-2">
            <Label className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Notes (optional)</Label>
            <Input
              value={form.notes}
              onChange={(e) => setForm((p) => ({ ...p, notes: e.target.value }))}
              placeholder="Anything users should know"
              className="font-mono text-xs h-8 bg-input"
            />
          </div>
          <Button size="sm" disabled={saving} onClick={addDate} className="col-span-2 font-mono text-[11px] gap-1.5 mt-1">
            <Plus className="w-3.5 h-3.5" /> {saving ? "Adding…" : "Add Date"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
