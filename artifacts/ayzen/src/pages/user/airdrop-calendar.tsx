/**
 * airdrop-calendar.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Centralized airdrop calendar — every project's important dates (token
 * snapshot, TGE, claim deadline, whitelist deadline) together in one place,
 * instead of tracking each project separately. Sourced from GET
 * /project-dates (routes/project-dates.ts). The 1-day-ahead Telegram
 * reminder is sent automatically by lib/airdrop-reminder-cron.ts — this page
 * is just the read-only view of the same data.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Calendar, Clock, AlertTriangle, Camera, Rocket, Gift, CalendarClock } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { customFetch } from "@workspace/api-client-react";
import { cn } from "@/lib/utils";

interface CalendarDate {
  id: number;
  projectId: number;
  projectName: string | null;
  thumbnailUrl: string | null;
  label: string;
  eventType: string;
  eventDate: string;
  notes: string | null;
  remindedAt: string | null;
}

const TYPE_META: Record<string, { icon: React.ElementType; color: string; label: string }> = {
  snapshot: { icon: Camera, color: "text-primary bg-primary/10 border-primary/20", label: "Snapshot" },
  tge:      { icon: Rocket, color: "text-emerald-400 bg-emerald-500/10 border-emerald-500/20", label: "TGE" },
  deadline: { icon: AlertTriangle, color: "text-red-400 bg-red-500/10 border-red-500/20", label: "Deadline" },
  claim:    { icon: Gift, color: "text-amber-400 bg-amber-500/10 border-amber-500/20", label: "Claim" },
  other:    { icon: CalendarClock, color: "text-muted-foreground bg-muted/20 border-border/40", label: "Date" },
};

function metaFor(type: string) {
  return TYPE_META[type] ?? TYPE_META.other;
}

function countdown(iso: string): { text: string; urgent: boolean; past: boolean } {
  const diffMs = new Date(iso).getTime() - Date.now();
  const hours = diffMs / (1000 * 60 * 60);
  if (hours < 0) return { text: "Passed", urgent: false, past: true };
  if (hours < 24) return { text: `In ${Math.max(1, Math.round(hours))}h — tomorrow or sooner`, urgent: true, past: false };
  const days = Math.round(hours / 24);
  return { text: `In ${days} day${days === 1 ? "" : "s"}`, urgent: days <= 2, past: false };
}

export default function AirdropCalendar() {
  const [, navigate] = useLocation();
  const [filter, setFilter] = useState<"mine" | "all">("mine");

  const { data, isLoading } = useQuery({
    queryKey: ["project-dates", filter],
    queryFn: () => customFetch<CalendarDate[]>(`/api/project-dates?${filter === "mine" ? "mine=true" : ""}`),
  });

  const dates = (data ?? []).slice().sort((a, b) => new Date(a.eventDate).getTime() - new Date(b.eventDate).getTime());
  const upcoming = dates.filter((d) => !countdown(d.eventDate).past);
  const past = dates.filter((d) => countdown(d.eventDate).past);

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2">
          <Calendar className="w-4 h-4 text-primary" />
          <p className="text-muted-foreground font-mono text-sm">
            Every project's snapshot / TGE / deadline dates, in one place — a reminder goes out on Telegram ~1 day before each one.
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <Button size="sm" variant={filter === "mine" ? "default" : "outline"} className="font-mono text-[11px]" onClick={() => setFilter("mine")}>
            My Projects
          </Button>
          <Button size="sm" variant={filter === "all" ? "default" : "outline"} className="font-mono text-[11px]" onClick={() => setFilter("all")}>
            All Projects
          </Button>
        </div>
      </div>

      {isLoading ? (
        <div className="text-center py-12 font-mono text-xs text-muted-foreground/40">Loading calendar…</div>
      ) : upcoming.length === 0 ? (
        <div className="bg-card border border-card-border rounded-xl p-10 text-center">
          <Calendar className="w-8 h-8 text-muted-foreground/20 mx-auto mb-2" />
          <p className="font-mono text-xs text-muted-foreground/40">
            {filter === "mine" ? "No upcoming dates for your enrolled projects" : "No upcoming dates yet"}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {upcoming.map((d) => {
            const meta = metaFor(d.eventType);
            const Icon = meta.icon;
            const cd = countdown(d.eventDate);
            return (
              <div
                key={d.id}
                onClick={() => navigate(`/projects/${d.projectId}`)}
                className={cn(
                  "bg-card border rounded-xl px-4 py-3 flex items-center gap-3 cursor-pointer transition-colors hover:border-primary/30",
                  cd.urgent ? "border-red-400/30" : "border-card-border",
                )}
              >
                <div className={cn("w-9 h-9 rounded-lg border flex items-center justify-center flex-shrink-0", meta.color)}>
                  <Icon className="w-4 h-4" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm font-bold text-foreground/90 truncate">{d.projectName ?? "Unknown project"}</span>
                    <Badge variant="outline" className={cn("font-mono text-[9px] px-1.5", meta.color)}>{meta.label}</Badge>
                  </div>
                  <p className="font-mono text-[11px] text-muted-foreground/60 truncate">{d.label}{d.notes ? ` — ${d.notes}` : ""}</p>
                </div>
                <div className="text-right flex-shrink-0">
                  <p className="font-mono text-[11px] text-foreground/70">{new Date(d.eventDate).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</p>
                  <p className={cn("font-mono text-[10px] flex items-center gap-1 justify-end", cd.urgent ? "text-red-400 font-bold" : "text-muted-foreground/40")}>
                    <Clock className="w-2.5 h-2.5" /> {cd.text}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {past.length > 0 && (
        <div className="pt-2">
          <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground/40 mb-2">Past</p>
          <div className="space-y-1.5 opacity-50">
            {past.slice(0, 10).map((d) => (
              <div key={d.id} className="flex items-center gap-3 px-4 py-2 text-xs font-mono text-muted-foreground/50">
                <span className="flex-1 truncate">{d.projectName} — {d.label}</span>
                <span>{new Date(d.eventDate).toLocaleDateString()}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
