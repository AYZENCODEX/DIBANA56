import { useState, useCallback } from "react";
import { useListUsers } from "@workspace/api-client-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Search, Users, ShieldCheck, Ban, Trash2, ChevronUp, ChevronDown, RefreshCw, UserCog, Eye, X } from "lucide-react";
import { format } from "date-fns";
import { cn } from "@/lib/utils";
import { useQueryClient } from "@tanstack/react-query";

type FilterStatus = "all" | "active" | "suspended" | "admin";

interface UserRow {
  id: number; username: string; email: string; role: string; status: string;
  totalRoi?: number; streak?: number; walletCount?: number; createdAt: string;
  referralCode?: string;
}

export default function AdminUsers() {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<FilterStatus>("all");
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [busy, setBusy] = useState<Record<number, boolean>>({});
  const [localOverrides, setLocalOverrides] = useState<Record<number, Partial<UserRow>>>({});

  const token = localStorage.getItem("ayzen_token") ?? "";

  const roleFilter = filter === "admin" ? "admin" : undefined;
  const statusFilter = filter === "suspended" ? "suspended" : filter === "active" ? "active" : undefined;

  const { data, isLoading, refetch } = useListUsers({ search, page: 1, limit: 100, ...(roleFilter ? { role: roleFilter } : {}), ...(statusFilter ? { status: statusFilter } : {}) });

  const users: UserRow[] = (data?.users ?? []).map(u => ({ ...u, ...localOverrides[u.id] }));

  const patch = useCallback(async (id: number, updates: Record<string, string>) => {
    setBusy(b => ({ ...b, [id]: true }));
    const res = await fetch(`/api/users/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(updates),
    });
    if (res.ok) {
      const user = await res.json() as UserRow;
      setLocalOverrides(o => ({ ...o, [id]: { ...o[id], ...user } }));
    }
    setBusy(b => ({ ...b, [id]: false }));
  }, [token]);

  const deleteUser = useCallback(async (id: number) => {
    if (!confirm("Permanently delete this user?")) return;
    setBusy(b => ({ ...b, [id]: true }));
    await fetch(`/api/users/${id}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
    refetch();
    setBusy(b => ({ ...b, [id]: false }));
  }, [token, refetch]);

  const statusCounts = {
    all: data?.total ?? 0,
    active: (data?.users ?? []).filter(u => u.status === "active").length,
    suspended: (data?.users ?? []).filter(u => u.status === "suspended").length,
    admin: (data?.users ?? []).filter(u => u.role === "admin").length,
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold font-mono tracking-tighter uppercase flex items-center gap-2">
            <Users className="h-6 w-6 text-primary" /> User Management
          </h1>
          <p className="text-muted-foreground font-mono text-sm">Monitor, promote, suspend, and manage operators</p>
        </div>
        <button onClick={() => refetch()} className="flex items-center gap-1.5 px-3 py-2 border border-border rounded-lg text-xs font-mono text-muted-foreground hover:text-primary hover:border-primary/40 transition-colors">
          <RefreshCw className={cn("w-3.5 h-3.5", isLoading && "animate-spin")} /> Refresh
        </button>
      </div>

      {/* Filter tabs + search */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input placeholder="Search by alias or email…" className="pl-9 font-mono bg-card border-card-border"
            value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <div className="flex gap-1 bg-card border border-card-border rounded-lg p-1">
          {(["all", "active", "suspended", "admin"] as FilterStatus[]).map(f => (
            <button key={f} onClick={() => setFilter(f)}
              className={cn("px-3 py-1.5 rounded text-[10px] font-mono uppercase transition-colors",
                filter === f ? "bg-primary/20 text-primary" : "text-muted-foreground hover:text-foreground")}>
              {f} <span className="ml-1 opacity-60">({statusCounts[f]})</span>
            </button>
          ))}
        </div>
      </div>

      {/* Table */}
      <div className="border border-card-border rounded-xl bg-card overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="border-card-border hover:bg-transparent">
              <TableHead className="font-mono uppercase text-[10px] w-8">#</TableHead>
              <TableHead className="font-mono uppercase text-[10px]">Operator</TableHead>
              <TableHead className="font-mono uppercase text-[10px]">Role</TableHead>
              <TableHead className="font-mono uppercase text-[10px]">Status</TableHead>
              <TableHead className="font-mono uppercase text-[10px] text-right">ROI</TableHead>
              <TableHead className="font-mono uppercase text-[10px] text-right">Streak</TableHead>
              <TableHead className="font-mono uppercase text-[10px]">Joined</TableHead>
              <TableHead className="font-mono uppercase text-[10px] text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 6 }).map((_, i) => (
                <TableRow key={i} className="border-card-border">
                  {Array.from({ length: 8 }).map((_, j) => (
                    <TableCell key={j}><Skeleton className="h-4 w-full" /></TableCell>
                  ))}
                </TableRow>
              ))
            ) : users.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="text-center py-12 font-mono text-muted-foreground">
                  No users match this filter.
                </TableCell>
              </TableRow>
            ) : (
              users.map(user => (
                <>
                  <TableRow key={user.id}
                    className={cn("border-card-border transition-colors", expandedId === user.id ? "bg-muted/40" : "hover:bg-muted/20")}
                    onClick={() => setExpandedId(expandedId === user.id ? null : user.id)}>
                    <TableCell className="font-mono text-[10px] text-muted-foreground/40">{user.id}</TableCell>
                    <TableCell>
                      <div>
                        <p className="font-mono font-bold text-sm text-foreground">{user.username}</p>
                        <p className="font-mono text-[10px] text-muted-foreground/60">{user.email}</p>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant={user.role === "admin" ? "default" : "secondary"}
                        className="font-mono text-[10px] uppercase rounded-sm">
                        {user.role}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1.5">
                        <span className={cn("w-1.5 h-1.5 rounded-full", user.status === "active" ? "bg-emerald-400" : "bg-destructive")} />
                        <span className={cn("font-mono text-[10px] uppercase", user.status === "active" ? "text-emerald-400" : "text-destructive")}>
                          {user.status}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm text-primary">${(user.totalRoi ?? 0).toFixed(0)}</TableCell>
                    <TableCell className="text-right font-mono text-sm text-amber-400">🔥{user.streak ?? 0}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {format(new Date(user.createdAt), "MMM dd, yyyy")}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1" onClick={e => e.stopPropagation()}>
                        {/* Ban / Unban */}
                        <button
                          onClick={() => patch(user.id, { status: user.status === "active" ? "suspended" : "active" })}
                          disabled={busy[user.id]}
                          title={user.status === "active" ? "Suspend user" : "Reactivate user"}
                          className={cn("p-1.5 rounded transition-colors",
                            user.status === "active"
                              ? "text-muted-foreground hover:text-amber-400 hover:bg-amber-400/10"
                              : "text-emerald-400 hover:bg-emerald-400/10")}>
                          <Ban className="w-3.5 h-3.5" />
                        </button>
                        {/* Promote / Demote */}
                        <button
                          onClick={() => patch(user.id, { role: user.role === "admin" ? "user" : "admin" })}
                          disabled={busy[user.id]}
                          title={user.role === "admin" ? "Demote to user" : "Promote to admin"}
                          className="p-1.5 rounded text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors">
                          <ShieldCheck className="w-3.5 h-3.5" />
                        </button>
                        {/* Delete */}
                        <button
                          onClick={() => deleteUser(user.id)}
                          disabled={busy[user.id]}
                          title="Delete user"
                          className="p-1.5 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors">
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                        {/* Expand */}
                        <button
                          onClick={() => setExpandedId(expandedId === user.id ? null : user.id)}
                          className="p-1.5 rounded text-muted-foreground hover:text-foreground transition-colors">
                          {expandedId === user.id ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                        </button>
                      </div>
                    </TableCell>
                  </TableRow>
                  {/* Expanded detail row */}
                  {expandedId === user.id && (
                    <TableRow key={`${user.id}-detail`} className="border-card-border bg-muted/10">
                      <TableCell colSpan={8} className="py-4 px-6">
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                          {[
                            { label: "User ID", value: `#${user.id}` },
                            { label: "Referral Code", value: user.referralCode ?? "—" },
                            { label: "Wallets", value: user.walletCount ?? 0 },
                            { label: "Streak", value: `${user.streak ?? 0} days` },
                          ].map(({ label, value }) => (
                            <div key={label}>
                              <p className="text-[9px] font-mono text-muted-foreground uppercase tracking-widest mb-1">{label}</p>
                              <p className="font-mono text-sm text-foreground">{value}</p>
                            </div>
                          ))}
                        </div>
                        <div className="flex gap-2 mt-4 flex-wrap">
                          <button onClick={() => patch(user.id, { status: user.status === "active" ? "suspended" : "active" })}
                            className={cn("px-3 py-1.5 rounded-lg border text-xs font-mono transition-colors",
                              user.status === "active"
                                ? "border-amber-400/30 text-amber-400 hover:bg-amber-400/10"
                                : "border-emerald-400/30 text-emerald-400 hover:bg-emerald-400/10")}>
                            {user.status === "active" ? "⚠ Suspend User" : "✓ Reactivate User"}
                          </button>
                          <button onClick={() => patch(user.id, { role: user.role === "admin" ? "user" : "admin" })}
                            className="px-3 py-1.5 rounded-lg border border-primary/30 text-primary text-xs font-mono hover:bg-primary/10 transition-colors">
                            {user.role === "admin" ? "↓ Demote to User" : "↑ Promote to Admin"}
                          </button>
                          <button onClick={() => deleteUser(user.id)}
                            className="px-3 py-1.5 rounded-lg border border-destructive/30 text-destructive text-xs font-mono hover:bg-destructive/10 transition-colors">
                            ✕ Delete Account
                          </button>
                        </div>
                      </TableCell>
                    </TableRow>
                  )}
                </>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
