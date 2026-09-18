import { useState, useEffect } from "react";
import { customFetch } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  Users, CheckCircle2, XCircle, Clock, RefreshCw, Search,
  BarChart2, Crown, MessageCircle, FolderGit2, Shield, Loader2,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

type AdminTeam = {
  id: number;
  name: string;
  description?: string;
  status: string;
  owner_id: number;
  owner_username?: string;
  member_count: number;
  message_count: number;
  created_at: string;
};

type Filter = "all" | "pending" | "active" | "rejected";

export default function AdminTeamsPage() {
  const [teams, setTeams] = useState<AdminTeam[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [acting, setActing] = useState<Record<number, boolean>>({});
  const { toast } = useToast();

  const loadTeams = async () => {
    setLoading(true);
    try {
      const url = filter !== "all" ? `/api/admin/teams?status=${filter}` : "/api/admin/teams";
      const data = await customFetch<AdminTeam[]>(url);
      setTeams(Array.isArray(data) ? data : []);
    } catch { toast({ title: "Failed to load teams", variant: "destructive" }); } finally { setLoading(false); }
  };

  useEffect(() => { loadTeams(); }, [filter]);

  const updateTeam = async (id: number, status: string) => {
    setActing(a => ({ ...a, [id]: true }));
    try {
      await customFetch(`/api/admin/teams/${id}`, { method: "PATCH", body: JSON.stringify({ status }) });
      toast({ title: status === "active" ? "Team approved!" : "Team rejected" });
      setTeams(prev => prev.map(t => t.id === id ? { ...t, status } : t));
    } catch { toast({ title: "Failed", variant: "destructive" }); } finally { setActing(a => ({ ...a, [id]: false })); }
  };

  const FILTER_TABS: { id: Filter; label: string }[] = [
    { id: "all", label: "All Teams" },
    { id: "pending", label: "Pending" },
    { id: "active", label: "Active" },
    { id: "rejected", label: "Rejected" },
  ];

  const STATUS_STYLES: Record<string, string> = {
    pending: "border-amber-500/30 text-amber-400",
    active: "border-emerald-500/30 text-emerald-400",
    rejected: "border-red-500/30 text-red-400",
  };

  const filtered = teams.filter(t =>
    !search || t.name.toLowerCase().includes(search.toLowerCase()) || (t.owner_username || "").toLowerCase().includes(search.toLowerCase())
  );

  const pending = teams.filter(t => t.status === "pending");
  const active = teams.filter(t => t.status === "active");

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-bold font-mono tracking-tighter uppercase flex items-center gap-2">
          <Users className="h-6 w-6 text-primary" /> Team Management
        </h1>
        <p className="text-muted-foreground font-mono text-sm">Approve team requests, manage team status, and monitor performance</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { label: "Total Teams", value: teams.length, icon: Users, color: "text-cyan-400", bg: "bg-cyan-400/10" },
          { label: "Pending", value: pending.length, icon: Clock, color: "text-amber-400", bg: "bg-amber-400/10" },
          { label: "Active", value: active.length, icon: CheckCircle2, color: "text-emerald-400", bg: "bg-emerald-400/10" },
          { label: "Total Members", value: teams.reduce((s, t) => s + Number(t.member_count || 0), 0), icon: Crown, color: "text-violet-400", bg: "bg-violet-400/10" },
        ].map(s => (
          <div key={s.label} className="bg-card border border-border/40 rounded-xl p-4 flex items-start gap-3">
            <div className={cn("w-9 h-9 rounded-lg flex items-center justify-center", s.bg)}>
              <s.icon className={cn("w-4 h-4", s.color)} />
            </div>
            <div>
              <p className={cn("text-xl font-mono font-bold", s.color)}>{s.value}</p>
              <p className="text-[10px] text-muted-foreground font-mono">{s.label}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Pending Approvals Alert */}
      {pending.length > 0 && (
        <div className="flex items-center gap-3 p-4 bg-amber-500/5 border border-amber-500/20 rounded-xl">
          <Clock className="w-5 h-5 text-amber-400 shrink-0" />
          <div>
            <p className="text-sm font-semibold text-amber-400">{pending.length} team{pending.length > 1 ? "s" : ""} awaiting approval</p>
            <p className="text-xs text-muted-foreground font-mono">Review and approve or reject pending team requests below.</p>
          </div>
          <Button size="sm" variant="outline" className="ml-auto border-amber-500/30 text-amber-400 hover:bg-amber-500/10"
            onClick={() => setFilter("pending")}>
            View Pending
          </Button>
        </div>
      )}

      {/* Filters + Search */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3">
        <div className="flex gap-1 bg-card border border-border/40 rounded-lg p-1">
          {FILTER_TABS.map(f => (
            <button key={f.id} onClick={() => setFilter(f.id)}
              className={cn("px-3 py-1.5 text-xs font-mono rounded transition-all",
                filter === f.id ? "bg-primary/20 text-primary" : "text-muted-foreground hover:text-foreground")}>
              {f.label}
            </button>
          ))}
        </div>
        <div className="relative flex-1 max-w-xs">
          <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground/50" />
          <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search teams..." className="h-8 text-xs pl-8 bg-background/50" />
        </div>
        <Button size="sm" variant="ghost" onClick={loadTeams} className="h-8 text-xs gap-1 ml-auto">
          <RefreshCw className="w-3 h-3" /> Refresh
        </Button>
      </div>

      {/* Table */}
      <div className="border border-border/40 rounded-xl overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="border-border/40 hover:bg-transparent bg-muted/5">
              <TableHead className="font-mono uppercase text-[10px]">Team</TableHead>
              <TableHead className="font-mono uppercase text-[10px]">Owner</TableHead>
              <TableHead className="font-mono uppercase text-[10px]">Status</TableHead>
              <TableHead className="font-mono uppercase text-[10px]">Members</TableHead>
              <TableHead className="font-mono uppercase text-[10px]">Messages</TableHead>
              <TableHead className="font-mono uppercase text-[10px]">Created</TableHead>
              <TableHead className="font-mono uppercase text-[10px] text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell colSpan={7} className="text-center py-12">
                  <Loader2 className="w-5 h-5 animate-spin text-muted-foreground mx-auto" />
                </TableCell>
              </TableRow>
            ) : filtered.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="text-center py-12 font-mono text-muted-foreground text-sm">
                  No teams found
                </TableCell>
              </TableRow>
            ) : filtered.map(t => (
              <TableRow key={t.id} className="border-border/20 hover:bg-muted/10">
                <TableCell>
                  <div className="flex items-center gap-2">
                    <div className="w-8 h-8 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center text-primary font-bold font-mono text-sm">
                      {t.name[0].toUpperCase()}
                    </div>
                    <div>
                      <p className="font-semibold text-sm text-foreground">{t.name}</p>
                      {t.description && <p className="text-[10px] text-muted-foreground font-mono truncate max-w-[180px]">{t.description}</p>}
                    </div>
                  </div>
                </TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">{t.owner_username || `#${t.owner_id}`}</TableCell>
                <TableCell>
                  <Badge variant="outline" className={cn("text-[9px] capitalize", STATUS_STYLES[t.status] ?? "")}>
                    {t.status}
                  </Badge>
                </TableCell>
                <TableCell>
                  <span className="font-mono text-xs flex items-center gap-1">
                    <Users className="w-3 h-3 text-muted-foreground/50" />
                    {t.member_count}
                  </span>
                </TableCell>
                <TableCell>
                  <span className="font-mono text-xs flex items-center gap-1">
                    <MessageCircle className="w-3 h-3 text-muted-foreground/50" />
                    {t.message_count}
                  </span>
                </TableCell>
                <TableCell className="font-mono text-[10px] text-muted-foreground">
                  {new Date(t.created_at).toLocaleDateString()}
                </TableCell>
                <TableCell className="text-right">
                  {acting[t.id] ? (
                    <Loader2 className="w-4 h-4 animate-spin text-muted-foreground ml-auto" />
                  ) : (
                    <div className="flex items-center gap-1 justify-end">
                      {t.status !== "active" && (
                        <Button size="sm" variant="ghost" onClick={() => updateTeam(t.id, "active")}
                          className="h-7 px-2 text-[10px] gap-1 text-emerald-400 hover:bg-emerald-500/10">
                          <CheckCircle2 className="w-3 h-3" /> Approve
                        </Button>
                      )}
                      {t.status !== "rejected" && (
                        <Button size="sm" variant="ghost" onClick={() => updateTeam(t.id, "rejected")}
                          className="h-7 px-2 text-[10px] gap-1 text-red-400 hover:bg-red-500/10">
                          <XCircle className="w-3 h-3" /> Reject
                        </Button>
                      )}
                    </div>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
