import { useState, useEffect, useCallback } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  Flame, Zap, Trophy, Star, Calendar, CheckCircle2,
  Loader2, Coins, Clock, Gift,
} from "lucide-react";

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";

interface CheckinStatus {
  checkedInToday: boolean;
  currentStreak: number;
  nextStreak: number;
  nextXP: number;
  nextAZN: number;
  nextMilestone: string | null;
  totalDays: number;
  totalXP: number;
  totalAZN: number;
  recentDates: string[];
}

const MILESTONES = [
  { day: 3,   label: "3-Day Streak",    icon: Flame,   color: "text-orange-400", bg: "border-orange-400/20 bg-orange-400/5" },
  { day: 7,   label: "1-Week Champion", icon: Zap,     color: "text-yellow-400", bg: "border-yellow-400/20 bg-yellow-400/5" },
  { day: 14,  label: "2-Week Veteran",  icon: Star,    color: "text-violet-400", bg: "border-violet-400/20 bg-violet-400/5" },
  { day: 30,  label: "30-Day Legend",   icon: Trophy,  color: "text-primary",    bg: "border-primary/20 bg-primary/5" },
];

function xpForDay(d: number) {
  if (d >= 30) return 150;
  if (d >= 14) return 75;
  if (d >= 7)  return 50;
  if (d >= 3)  return 25;
  return 10;
}

function aznForDay(d: number) {
  if (d >= 30) return 5;
  if (d >= 14) return 2;
  if (d >= 7)  return 1;
  if (d >= 3)  return 0.5;
  return 0.1;
}

export default function CheckinPage() {
  const { token } = useAuth() as any;
  const { toast } = useToast();
  const [status, setStatus] = useState<CheckinStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [justChecked, setJustChecked] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`${BASE}/api/checkin/status`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (r.ok) setStatus(await r.json());
    } catch { }
    setLoading(false);
  }, [token]);

  useEffect(() => { load(); }, [load]);

  const doCheckin = async () => {
    setChecking(true);
    try {
      const r = await fetch(`${BASE}/api/checkin`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      const d = await r.json();
      if (!r.ok) { toast({ title: d.error, variant: "destructive" }); return; }
      toast({ title: d.message });
      setJustChecked(true);
      await load();
    } catch { toast({ title: "Connection error", variant: "destructive" }); }
    setChecking(false);
  };

  if (loading) return (
    <div className="min-h-[60vh] flex items-center justify-center">
      <Loader2 className="w-6 h-6 animate-spin text-primary" />
    </div>
  );

  const streak = status?.currentStreak ?? 0;
  const todayDone = status?.checkedInToday ?? false;
  const nextDay = (streak < 1 && !todayDone) ? 1 : (todayDone ? streak : streak + 1);

  // Build last 7-day calendar
  const today = new Date();
  const last7 = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(today);
    d.setDate(d.getDate() - (6 - i));
    return d.toISOString().slice(0, 10);
  });
  const checkedDates = new Set(status?.recentDates ?? []);

  return (
    <div className="max-w-2xl mx-auto space-y-6 py-2">
      {/* ── Header ── */}
      <div>
        <h1 className="font-mono font-black text-2xl text-foreground">Daily Check-in</h1>
        <p className="text-xs font-mono text-muted-foreground mt-1">Check in every day to earn XP and AZN rewards. Don't break your streak!</p>
      </div>

      {/* ── Streak hero ── */}
      <div className={cn(
        "relative overflow-hidden rounded-2xl border p-6 text-center transition-all",
        todayDone
          ? "border-emerald-500/30 bg-emerald-500/5"
          : "border-primary/30 bg-primary/5"
      )}>
        {/* Glow */}
        <div className={cn(
          "absolute inset-0 opacity-10 pointer-events-none",
          todayDone ? "bg-emerald-400" : "bg-primary"
        )} style={{ filter: "blur(60px)" }} />

        <div className="relative space-y-3">
          {/* Streak number */}
          <div className="flex items-center justify-center gap-3">
            <Flame className={cn("w-8 h-8", streak >= 3 ? "text-orange-400" : "text-muted-foreground/30")} />
            <div>
              <div className={cn(
                "font-mono font-black text-5xl tabular-nums transition-all",
                streak >= 7 ? "text-yellow-400" : streak >= 3 ? "text-orange-400" : "text-foreground"
              )}>
                {streak}
              </div>
              <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">day streak</div>
            </div>
          </div>

          {/* Status */}
          {todayDone ? (
            <div className="flex items-center justify-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-400" />
              <span className="font-mono text-sm text-emerald-400 font-bold">
                {justChecked ? "Just checked in! Come back tomorrow." : "Checked in today ✓"}
              </span>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center justify-center gap-4 text-sm font-mono">
                <div className="text-center">
                  <div className="text-primary font-bold text-lg">+{xpForDay(nextDay)} XP</div>
                  <div className="text-muted-foreground text-[10px] uppercase">Today's reward</div>
                </div>
                <div className="text-muted-foreground/30">·</div>
                <div className="text-center">
                  <div className="text-amber-400 font-bold text-lg">+{aznForDay(nextDay)} AZN</div>
                  <div className="text-muted-foreground text-[10px] uppercase">Token reward</div>
                </div>
              </div>
              {status?.nextMilestone && (
                <Badge className="bg-yellow-400/10 text-yellow-400 border-yellow-400/20 font-mono text-[10px] gap-1 mx-auto">
                  <Gift className="w-3 h-3" /> Milestone today: {status.nextMilestone}
                </Badge>
              )}
              <Button
                onClick={doCheckin}
                disabled={checking}
                size="lg"
                className="font-mono font-bold gap-2 px-10 text-sm"
              >
                {checking
                  ? <><Loader2 className="w-4 h-4 animate-spin" /> Claiming...</>
                  : <><Zap className="w-4 h-4" /> Claim Today's Reward</>
                }
              </Button>
            </div>
          )}
        </div>
      </div>

      {/* ── 7-day calendar ── */}
      <div className="bg-card border border-card-border rounded-xl p-4">
        <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground/50 mb-3">Last 7 Days</div>
        <div className="grid grid-cols-7 gap-1.5">
          {last7.map((dateStr, i) => {
            const isToday = i === 6;
            const done = checkedDates.has(dateStr);
            const d = new Date(dateStr);
            const dayLabel = d.toLocaleDateString("en", { weekday: "short" }).toUpperCase().slice(0, 2);
            return (
              <div key={dateStr} className="flex flex-col items-center gap-1">
                <span className="font-mono text-[9px] text-muted-foreground/40">{dayLabel}</span>
                <div className={cn(
                  "w-9 h-9 rounded-lg flex items-center justify-center border transition-all",
                  done
                    ? "bg-primary/20 border-primary/40"
                    : isToday && !done
                    ? "border-primary/30 border-dashed bg-primary/5"
                    : "border-border/30 bg-muted/10"
                )}>
                  {done
                    ? <CheckCircle2 className="w-4 h-4 text-primary" />
                    : <span className="font-mono text-[10px] text-muted-foreground/30">{d.getDate()}</span>
                  }
                </div>
                {isToday && (
                  <span className="font-mono text-[8px] text-primary uppercase">today</span>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Stats row ── */}
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: "Total Days", value: status?.totalDays ?? 0, icon: Calendar, color: "text-primary" },
          { label: "Total XP", value: `${status?.totalXP ?? 0}`, icon: Zap, color: "text-yellow-400" },
          { label: "AZN Earned", value: `${(status?.totalAZN ?? 0).toFixed(1)}`, icon: Coins, color: "text-amber-400" },
        ].map(stat => {
          const Icon = stat.icon;
          return (
            <div key={stat.label} className="bg-card border border-card-border rounded-xl p-4 text-center">
              <Icon className={cn("w-5 h-5 mx-auto mb-2", stat.color)} />
              <div className={cn("font-mono font-bold text-xl tabular-nums", stat.color)}>{stat.value}</div>
              <div className="font-mono text-[9px] uppercase tracking-widest text-muted-foreground/50 mt-0.5">{stat.label}</div>
            </div>
          );
        })}
      </div>

      {/* ── Milestone roadmap ── */}
      <div className="bg-card border border-card-border rounded-xl p-4">
        <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground/50 mb-4">Milestone Roadmap</div>
        <div className="space-y-2">
          {MILESTONES.map(m => {
            const Icon = m.icon;
            const reached = streak >= m.day && todayDone ? true : (streak > m.day);
            const active = !todayDone && (streak + 1) === m.day;
            return (
              <div key={m.day} className={cn(
                "flex items-center gap-3 p-3 rounded-lg border transition-all",
                reached ? "border-emerald-500/20 bg-emerald-500/5" :
                active  ? `${m.bg} animate-pulse` :
                          "border-border/20 bg-muted/5 opacity-50"
              )}>
                <div className={cn(
                  "w-9 h-9 rounded-lg flex items-center justify-center border flex-shrink-0",
                  reached ? "border-emerald-500/30 bg-emerald-500/10" :
                  active  ? m.bg : "border-border/20"
                )}>
                  {reached
                    ? <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                    : <Icon className={cn("w-4 h-4", reached || active ? m.color : "text-muted-foreground/30")} />
                  }
                </div>
                <div className="flex-1 min-w-0">
                  <div className={cn("font-mono text-xs font-bold", reached ? "text-emerald-400" : active ? m.color : "text-muted-foreground/40")}>
                    Day {m.day} — {m.label}
                  </div>
                  <div className="font-mono text-[10px] text-muted-foreground/40">
                    +{xpForDay(m.day)} XP · +{aznForDay(m.day)} AZN per day after this
                  </div>
                </div>
                {reached && <Badge className="text-[9px] bg-emerald-500/10 text-emerald-400 border-emerald-500/20">Reached</Badge>}
                {active  && <Badge className={cn("text-[9px]", m.bg, m.color, "border")}>Today!</Badge>}
                {!reached && !active && (
                  <div className="font-mono text-[9px] text-muted-foreground/30 flex items-center gap-1 flex-shrink-0">
                    <Clock className="w-3 h-3" /> {m.day - streak}d left
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
