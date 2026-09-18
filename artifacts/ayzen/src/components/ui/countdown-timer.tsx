import { useState, useEffect } from "react";
import { Timer, Clock, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";

interface CountdownTimerProps {
  deadline?: string | null;
  startedAt?: string | null;
  showElapsed?: boolean;
  className?: string;
  compact?: boolean;
}

function getDiff(deadline: Date) {
  const now = Date.now();
  const end = deadline.getTime();
  const diff = end - now;
  return diff;
}

function formatTime(ms: number) {
  if (ms <= 0) return { d: 0, h: 0, m: 0, s: 0 };
  const totalSec = Math.floor(ms / 1000);
  const d = Math.floor(totalSec / 86400);
  const h = Math.floor((totalSec % 86400) / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return { d, h, m, s };
}

function formatElapsed(startedAt: Date) {
  const ms = Date.now() - startedAt.getTime();
  const totalSec = Math.floor(ms / 1000);
  const d = Math.floor(totalSec / 86400);
  const h = Math.floor((totalSec % 86400) / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (d > 0) return `${d}d ${h}h running`;
  if (h > 0) return `${h}h ${m}m running`;
  if (m > 0) return `${m}m ${s}s running`;
  return `${s}s running`;
}

export function CountdownTimer({ deadline, startedAt, showElapsed, className, compact }: CountdownTimerProps) {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  if (!deadline && !startedAt) return null;

  // Elapsed mode
  if (!deadline && startedAt && showElapsed) {
    const start = new Date(startedAt);
    const label = formatElapsed(start);
    return (
      <div className={cn("flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground", className)}>
        <Clock className="w-3 h-3 text-primary/60" />
        <span>{label}</span>
      </div>
    );
  }

  if (!deadline) return null;

  const dl = new Date(deadline);
  const diff = getDiff(dl);
  const expired = diff <= 0;
  const urgent = !expired && diff < 86400000; // < 1 day
  const { d, h, m, s } = expired ? { d: 0, h: 0, m: 0, s: 0 } : formatTime(diff);

  if (expired) {
    return (
      <div className={cn("flex items-center gap-1.5 font-mono text-[10px] text-red-400", className)}>
        <AlertTriangle className="w-3 h-3" />
        <span>EXPIRED</span>
      </div>
    );
  }

  if (compact) {
    const label = d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m ${s}s`;
    return (
      <div className={cn(
        "flex items-center gap-1 font-mono text-[10px] px-1.5 py-0.5 rounded border",
        urgent
          ? "text-amber-400 border-amber-400/20 bg-amber-400/5"
          : "text-primary/70 border-primary/15 bg-primary/5",
        className
      )}>
        <Timer className="w-2.5 h-2.5" />
        <span>{label}</span>
      </div>
    );
  }

  return (
    <div className={cn("flex items-center gap-2", className)}>
      <Timer className={cn("w-3.5 h-3.5 flex-shrink-0", urgent ? "text-amber-400 animate-pulse" : "text-primary/60")} />
      <div className="flex items-center gap-1 font-mono text-xs">
        {d > 0 && (
          <div className="flex flex-col items-center">
            <span className={cn("text-sm font-bold tabular-nums", urgent ? "text-amber-400" : "text-foreground")}>{d}</span>
            <span className="text-[8px] text-muted-foreground/50">d</span>
          </div>
        )}
        {(d > 0 || h > 0) && (
          <div className="flex flex-col items-center">
            <span className={cn("text-sm font-bold tabular-nums", urgent ? "text-amber-400" : "text-foreground")}>{String(h).padStart(2, "0")}</span>
            <span className="text-[8px] text-muted-foreground/50">h</span>
          </div>
        )}
        <div className="flex flex-col items-center">
          <span className={cn("text-sm font-bold tabular-nums", urgent ? "text-amber-400" : "text-foreground")}>{String(m).padStart(2, "0")}</span>
          <span className="text-[8px] text-muted-foreground/50">m</span>
        </div>
        <div className="flex flex-col items-center">
          <span className={cn("text-sm font-bold tabular-nums", urgent ? "text-amber-400" : "text-foreground")}>{String(s).padStart(2, "0")}</span>
          <span className="text-[8px] text-muted-foreground/50">s</span>
        </div>
      </div>
    </div>
  );
}

export function TaskTimer({ deadline, timeLimitMinutes, submittedAt, className }: {
  deadline?: string | null;
  timeLimitMinutes?: number | null;
  submittedAt?: string | null;
  className?: string;
}) {
  if (deadline) return <CountdownTimer deadline={deadline} compact className={className} />;
  if (timeLimitMinutes && submittedAt) {
    const endTime = new Date(new Date(submittedAt).getTime() + timeLimitMinutes * 60000).toISOString();
    return <CountdownTimer deadline={endTime} compact className={className} />;
  }
  return null;
}
