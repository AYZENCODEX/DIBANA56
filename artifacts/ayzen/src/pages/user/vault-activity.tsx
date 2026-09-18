/**
 * vault-activity.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Vault → Other → Activity Log.
 *
 * Shows the current user's own Vault activity feed only — "at this time,
 * this happened, on this entity/page" — sourced from GET /vault/activity
 * (vault_activity_log rows scoped to this user). Distinct from the
 * platform-wide Activity Log at /admin/activity (all users, all actions)
 * and from an entity's own timeline at /vault/entity/:id (one entity only).
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { History, Eye, PlusCircle, Pencil, Trash2, KeyRound, Wallet, RefreshCw, ChevronRight, ChevronLeft } from "lucide-react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { VaultSectionPage, VaultSectionEmptyState } from "@/components/layout/vault-sidebar";
import { getVaultActivity, type VaultActivityEntry } from "@/lib/vault-security-api";
import { VaultLoadingIntro } from "@/components/vault/vault-loading-intro";
import { cn } from "@/lib/utils";

const ACTION_META: Record<string, { label: string; icon: React.ElementType; color: string }> = {
  viewed:          { label: "Viewed",          icon: Eye,        color: "text-primary bg-primary/10 border-primary/20" },
  created:         { label: "Created",         icon: PlusCircle, color: "text-emerald-400 bg-emerald-500/10 border-emerald-500/20" },
  updated:         { label: "Updated",         icon: Pencil,     color: "text-blue-400 bg-blue-500/10 border-blue-500/20" },
  deleted:         { label: "Deleted",         icon: Trash2,     color: "text-red-400 bg-red-500/10 border-red-500/20" },
  status_changed:  { label: "Status changed",  icon: RefreshCw,  color: "text-amber-400 bg-amber-500/10 border-amber-500/20" },
  seed_revealed:   { label: "Seed revealed",   icon: KeyRound,   color: "text-violet-400 bg-violet-500/10 border-violet-500/20" },
  drive_wallet_set:{ label: "Drive wallet set",icon: Wallet,     color: "text-cyan-400 bg-cyan-500/10 border-cyan-500/20" },
};

function metaFor(action: string) {
  return ACTION_META[action] ?? { label: action.replace(/_/g, " "), icon: History, color: "text-muted-foreground bg-muted/20 border-border/40" };
}

function formatWhen(iso: string): { date: string; time: string; relative: string } {
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  const s = Math.floor(diff / 1000);
  let relative: string;
  if (s < 60) relative = `${s}s ago`;
  else if (s < 3600) relative = `${Math.floor(s / 60)}m ago`;
  else if (s < 86400) relative = `${Math.floor(s / 3600)}h ago`;
  else relative = `${Math.floor(s / 86400)}d ago`;
  return {
    date: d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }),
    time: d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }),
    relative,
  };
}

function ActivityRow({ entry, onOpenEntity }: { entry: VaultActivityEntry; onOpenEntity: () => void }) {
  const meta = metaFor(entry.action);
  const Icon = meta.icon;
  const { date, time, relative } = formatWhen(entry.createdAt);

  return (
    <div className="flex items-start gap-3 bg-card border border-border/40 rounded-lg px-3 py-2.5">
      <div className={cn("w-7 h-7 rounded-md border flex items-center justify-center flex-shrink-0", meta.color)}>
        <Icon className="w-3.5 h-3.5" />
      </div>
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex items-center gap-2 flex-wrap">
          <Badge variant="outline" className={cn("font-mono text-[9px] uppercase tracking-wider px-1.5", meta.color)}>
            {meta.label}
          </Badge>
          {entry.entitySerial && (
            <span className="font-mono text-xs font-bold text-foreground truncate">{entry.entitySerial}</span>
          )}
          {!entry.entitySerial && entry.entityId && (
            <span className="font-mono text-xs text-muted-foreground/70">Entity #{entry.entityId}</span>
          )}
        </div>
        {entry.detail && (
          <p className="font-mono text-[10px] text-muted-foreground/60 truncate">{entry.detail}</p>
        )}
        <p className="font-mono text-[9px] text-muted-foreground/40">
          {date} · {time} ({relative})
        </p>
      </div>
      {entry.entityId && (
        <button
          onClick={onOpenEntity}
          className="flex-shrink-0 text-muted-foreground/40 hover:text-foreground transition-colors"
          aria-label="Open entity"
        >
          <ChevronRight className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );
}

export default function VaultActivity() {
  const [, navigate] = useLocation();
  const [page, setPage] = useState(1);
  const limit = 30;

  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ["vault-activity", page],
    queryFn: () => getVaultActivity(page, limit),
  });

  const entries = data?.entries ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / limit));

  return (
    <VaultSectionPage
      title="Activity Log"
      description="Everything you've done inside Vault — what happened, when, and where"
      icon={History}
      headerExtra={
        <Button variant="outline" size="sm" className="font-mono text-xs gap-1.5" onClick={() => refetch()} disabled={isFetching}>
          <RefreshCw className={cn("w-3.5 h-3.5", isFetching && "animate-spin")} /> Refresh
        </Button>
      }
    >
      {isLoading ? (
        <VaultLoadingIntro title="Loading activity log" done={!isLoading} />
      ) : entries.length === 0 ? (
        <VaultSectionEmptyState
          icon={History}
          title="No activity yet"
          note="Every time you view, create, edit, or change an entity's status inside Vault, it'll show up here with the exact time and which entity was touched."
        />
      ) : (
        <div className="space-y-4">
          <div className="space-y-1.5">
            {entries.map(entry => (
              <ActivityRow
                key={entry.id}
                entry={entry}
                onOpenEntity={() => entry.entityId && navigate(`/vault/entity/${entry.entityId}`)}
              />
            ))}
          </div>

          {totalPages > 1 && (
            <div className="flex items-center justify-between pt-2">
              <p className="font-mono text-[10px] text-muted-foreground/50">
                Page {page} of {totalPages} · {total.toLocaleString()} events
              </p>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline" size="sm" className="font-mono text-xs gap-1"
                  disabled={page <= 1} onClick={() => setPage(p => Math.max(1, p - 1))}
                >
                  <ChevronLeft className="w-3.5 h-3.5" /> Prev
                </Button>
                <Button
                  variant="outline" size="sm" className="font-mono text-xs gap-1"
                  disabled={page >= totalPages} onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                >
                  Next <ChevronRight className="w-3.5 h-3.5" />
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </VaultSectionPage>
  );
}
