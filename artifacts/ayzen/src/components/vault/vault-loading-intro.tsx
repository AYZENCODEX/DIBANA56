import { useEffect, useRef, useState } from "react";
import { Lock, Cookie, Globe, ShieldCheck, Sparkles, CheckCircle2, Fingerprint } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * components/vault/vault-loading-intro.tsx
 * ───────────────────────────────────────────────────────────────────────────
 * Replaces the plain `<Loader2 className="animate-spin" />` that used to sit
 * on Vault's initial entity load and its lazy dashboard Suspense fallbacks
 * with a small "intro" — a progress bar that advances through a fixed list
 * of checkpoints (collecting cookies, browser call, decrypting, etc.)
 * instead of one static spinner the whole time.
 *
 * Two modes, controlled by whether `done` is passed:
 *  - `done` provided (the isLoading-gated case, e.g. Vault's entity grid):
 *    progress is capped at 92% until `done` flips true, then finishes to
 *    100% and calls `onFinished` after the fill/checkmark settle — so the
 *    bar never looks stuck on a slow fetch, and never rushes past its own
 *    checkpoints on a fast one.
 *  - `done` omitted (a Suspense fallback, which has no such signal):
 *    the same checkpoint sequence loops continuously; React swaps it out
 *    the moment the lazy chunk resolves, same as the old spinner did.
 */

interface Checkpoint {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

const CHECKPOINTS: Checkpoint[] = [
  { label: "Establishing secure session", icon: Lock },
  { label: "Collecting cookies", icon: Cookie },
  { label: "Browser call successful", icon: Globe },
  { label: "Verifying vault integrity", icon: ShieldCheck },
  { label: "Decrypting entries", icon: Fingerprint },
  { label: "Finalizing", icon: Sparkles },
];

export function VaultLoadingIntro({
  done,
  title = "Opening your Vault",
  onFinished,
  className,
}: {
  /** Omit for a Suspense fallback (loops); pass isLoading-derived state to finish the bar once real data arrives. */
  done?: boolean;
  title?: string;
  onFinished?: () => void;
  className?: string;
}) {
  const [progress, setProgress] = useState(0);
  const doneRef = useRef(done);
  doneRef.current = done;
  const finishedRef = useRef(false);
  const onFinishedRef = useRef(onFinished);
  onFinishedRef.current = onFinished;
  const looping = done === undefined;

  useEffect(() => {
    const interval = setInterval(() => {
      setProgress(p => {
        if (looping) {
          // No completion signal (Suspense fallback) — ease toward 96%, then
          // loop back so the checkpoints keep visibly cycling for as long
          // as the fallback stays mounted.
          if (p >= 96) return 4;
          return p + (96 - p) * 0.12 + 0.8;
        }
        const ceiling = doneRef.current ? 100 : 92;
        if (p >= ceiling) {
          if (ceiling === 100 && !finishedRef.current) {
            finishedRef.current = true;
            onFinishedRef.current?.();
          }
          return p;
        }
        return Math.min(p + (ceiling - p) * 0.18 + 0.6, ceiling);
      });
    }, 110);
    return () => clearInterval(interval);
  }, [looping]);

  const stepIndex = Math.min(CHECKPOINTS.length - 1, Math.floor((progress / 100) * CHECKPOINTS.length));

  return (
    <div className={cn("flex flex-col items-center justify-center py-20", className)}>
      <div className="w-full max-w-xs space-y-5">
        <div className="text-center space-y-1">
          <p className="text-sm font-medium text-foreground">{title}</p>
          <p className="text-xs text-muted-foreground font-mono tabular-nums">{Math.round(progress)}%</p>
        </div>
        <div className="h-1.5 w-full rounded-full bg-muted/40 overflow-hidden">
          <div className="h-full rounded-full bg-primary transition-[width] duration-200 ease-out" style={{ width: `${progress}%` }} />
        </div>
        <div className="space-y-2">
          {CHECKPOINTS.map((cp, i) => {
            const Icon = cp.icon;
            const state = i < stepIndex ? "done" : i === stepIndex ? "active" : "pending";
            return (
              <div
                key={cp.label}
                className={cn(
                  "flex items-center gap-2 text-xs transition-colors duration-300",
                  state === "pending" && "text-muted-foreground/35",
                  state === "active" && "text-foreground",
                  state === "done" && "text-success",
                )}
              >
                {state === "done" ? (
                  <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                ) : (
                  <Icon className={cn("w-3.5 h-3.5 shrink-0", state === "active" && "animate-pulse")} />
                )}
                <span>{cp.label}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
