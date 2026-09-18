import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { History, User, Search, Filter, RefreshCw, ChevronRight, Activity } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";

const ACTION_COLORS: Record<string, string> = {
  task_submitted:  "text-blue-400 bg-blue-500/10 border-blue-500/20",
  task_approved:   "text-emerald-400 bg-emerald-500/10 border-emerald-500/20",
  task_rejected:   "text-red-400 bg-red-500/10 border-red-500/20",
  project_joined:  "text-violet-400 bg-violet-500/10 border-violet-500/20",
  login:           "text-primary bg-primary/10 border-primary/20",
  register:        "text-amber-400 bg-amber-500/10 border-amber-500/20",
  vault_created:   "text-cyan-400 bg-cyan-500/10 border-cyan-500/20",
  default:         "text-muted-foreground bg-muted/20 border-border/40",
};

function getActionColor(action: string) {
  return ACTION_COLORS[action] ?? ACTION_COLORS.default;
}

function timeAgo(dateStr: string) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function formatAction(action: string) {
  return action.replace(/_/g, " ");
}

export default function AdminActivity() {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const limit = 30;

  const token = localStorage.getItem("ayzen_token") ?? "";

  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ["admin-activity", page, search],
    queryFn: async () => {
      const params = new URLSearchParams({ page: String(page), limit: String(limit) });
      if (search) params.set("action", search);
      const res = await fetch(`${BASE}/api/admin/history?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error("Failed to fetch");
      return res.json();
    },
    refetchInterval: 30000,
  });

  const entries: any[] = data?.entries ?? data ?? [];
  const total = data?.total ?? entries.length;

  const totalPages = Math.ceil(total / limit);

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <History className="w-5 h-5 text-primary" />
            <h1 className="font-mono font-bold text-xl tracking-tight text-foreground">Activity Log</h1>
          </div>
          <p className="text-sm text-muted-foreground font-mono">
            All platform activity — {total.toLocaleString()} events recorded
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => refetch()}
          disabled={isFetching}
          className="font-mono text-xs gap-2 border-border"
        >
          <RefreshCw className={cn("w-3.5 h-3.5", isFetching && "animate-spin")} />
          Refresh
        </Button>
      </div>

      {/* Search */}
      <div className="flex gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <Input
            placeholder="Filter by action..."
            value={search}
            onChange={e => { setSearch(e.target.value); setPage(1); }}
            className="pl-9 font-mono text-xs h-9 bg-input border-border"
          />
        </div>
        <div className="flex items-center gap-2 px-3 py-2 rounded-md bg-card border border-border text-xs font-mono text-muted-foreground">
          <Activity className="w-3.5 h-3.5 text-primary" />
          Live · Updates every 30s
        </div>
      </div>

      {/* Table */}
      <div className="bg-card border border-card-border rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs font-mono">
            <thead>
              <tr className="border-b border-border bg-muted/20">
                <th className="text-left px-4 py-3 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Time</th>
                <th className="text-left px-4 py-3 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">User</th>
                <th className="text-left px-4 py-3 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Action</th>
                <th className="text-left px-4 py-3 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Entity</th>
                <th className="text-left px-4 py-3 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Detail</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                Array.from({ length: 8 }).map((_, i) => (
                  <tr key={i} className="border-b border-border/40">
                    {Array.from({ length: 5 }).map((_, j) => (
                      <td key={j} className="px-4 py-3">
                        <div className="h-3 bg-muted/40 rounded animate-pulse" style={{ width: `${60 + Math.random() * 40}%` }} />
                      </td>
                    ))}
                  </tr>
                ))
              ) : entries.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-12 text-center text-muted-foreground">
                    No activity recorded yet.
                  </td>
                </tr>
              ) : (
                entries.map((entry: any) => (
                  <tr key={entry.id} className="border-b border-border/30 hover:bg-muted/10 transition-colors group">
                    <td className="px-4 py-3 text-muted-foreground/60 whitespace-nowrap">
                      <div title={new Date(entry.created_at).toLocaleString()}>{timeAgo(entry.created_at)}</div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <div className="w-6 h-6 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center flex-shrink-0 text-[9px] font-bold text-primary uppercase">
                          {(entry.username || entry.user_id || "?").toString()[0]}
                        </div>
                        <div>
                          <div className="text-foreground font-medium">{entry.username || `#${entry.user_id}`}</div>
                          {entry.email && <div className="text-[10px] text-muted-foreground/60">{entry.email}</div>}
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant="outline" className={cn("font-mono text-[10px] uppercase", getActionColor(entry.action))}>
                        {formatAction(entry.action)}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {entry.entity_type && (
                        <div className="flex items-center gap-1">
                          <span className="text-muted-foreground/50">{entry.entity_type}</span>
                          {entry.entity_name && (
                            <>
                              <ChevronRight className="w-3 h-3 text-muted-foreground/30" />
                              <span className="text-foreground/80 truncate max-w-[120px]">{entry.entity_name}</span>
                            </>
                          )}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground/50 max-w-[200px] truncate">
                      {entry.meta ? (typeof entry.meta === "string" ? entry.meta : JSON.stringify(entry.meta)).slice(0, 80) : "—"}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="border-t border-border px-4 py-3 flex items-center justify-between">
            <span className="font-mono text-[10px] text-muted-foreground">
              Page {page} of {totalPages} · {total} total events
            </span>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1} className="font-mono text-xs h-7">Prev</Button>
              <Button variant="outline" size="sm" onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page >= totalPages} className="font-mono text-xs h-7">Next</Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
