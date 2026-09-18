/**
 * vault-shared-entity.tsx
 * ─────────────────────────────────────────────
 * Vault → Other → Shared → Entity detail.
 *
 * Route: /vault/shared/:entityType/:entityId
 *
 * Shows all shares for a single entity and lets the user:
 *  • Change permission (view / edit)
 *  • Toggle active / inactive
 *  • Revoke (delete) a share
 */
import { useState, useEffect, useCallback } from "react";
import { useParams, useLocation } from "wouter";
import {
  Share2, Loader2, Trash2, ChevronLeft,
  Eye, Pencil, Users, ToggleLeft, ToggleRight,
  CheckCircle2, XCircle,
} from "lucide-react";
import { customFetch } from "@workspace/api-client-react";
import { VaultSectionPage, VaultSectionEmptyState } from "@/components/layout/vault-sidebar";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import type { SharedEntry } from "./vault-shared";

export default function VaultSharedEntity() {
  const { entityType, entityId } = useParams<{ entityType: string; entityId: string }>();
  const [, navigate] = useLocation();
  const [allShares, setAllShares] = useState<SharedEntry[]>([]);
  const [shares, setShares] = useState<SharedEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<number | null>(null);
  const { toast } = useToast();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await customFetch<SharedEntry[]>("/api/vault-shares/sent");
      const all = Array.isArray(data) ? data : [];
      setAllShares(all);
      setShares(all.filter(s => String(s.entityId) === entityId && s.entityType === entityType));
    } catch {
      toast({ variant: "destructive", title: "Failed to load shares" });
    } finally {
      setLoading(false);
    }
  }, [entityType, entityId, toast]);

  useEffect(() => { load(); }, [load]);

  const entityLabel = shares[0]?.entityLabel ?? allShares.find(
    s => String(s.entityId) === entityId && s.entityType === entityType
  )?.entityLabel ?? `Entity #${entityId}`;

  const updatePermission = async (share: SharedEntry, permission: "view" | "edit") => {
    if (permission === share.permission) return;
    const prev = share.permission;
    setBusyId(share.id);
    setShares(p => p.map(s => s.id === share.id ? { ...s, permission } : s));
    try {
      await customFetch(`/api/vault-shares/${share.id}`, { method: "PATCH", body: JSON.stringify({ permission }) });
      toast({ title: "Permission updated", description: `${share.sharedWithUsername} — ${permission === "edit" ? "Full access" : "Read-only"}` });
    } catch {
      setShares(p => p.map(s => s.id === share.id ? { ...s, permission: prev } : s));
      toast({ variant: "destructive", title: "Failed to update permission" });
    } finally {
      setBusyId(null);
    }
  };

  const toggleActive = async (share: SharedEntry, next: boolean) => {
    setBusyId(share.id);
    setShares(p => p.map(s => s.id === share.id ? { ...s, isActive: next } : s));
    try {
      await customFetch(`/api/vault-shares/${share.id}`, { method: "PATCH", body: JSON.stringify({ isActive: next }) });
      toast({ title: next ? "Access turned on" : "Access turned off", description: share.sharedWithUsername });
    } catch {
      setShares(p => p.map(s => s.id === share.id ? { ...s, isActive: !next } : s));
      toast({ variant: "destructive", title: "Failed to update" });
    } finally {
      setBusyId(null);
    }
  };

  const removeShare = async (share: SharedEntry) => {
    setBusyId(share.id);
    try {
      await customFetch(`/api/vault-shares/${share.id}`, { method: "DELETE" });
      setShares(p => p.filter(s => s.id !== share.id));
      toast({ title: "Share removed", description: share.sharedWithUsername });
      // If no shares left, go back
      if (shares.length <= 1) navigate("/vault/shared");
    } catch {
      toast({ variant: "destructive", title: "Failed to remove share" });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <VaultSectionPage
      title={entityLabel}
      description="Manage who has access to this entity"
      icon={Users}
      headerExtra={
        <button
          onClick={() => navigate("/vault/shared")}
          className="flex items-center gap-1 font-mono text-[10px] text-muted-foreground/50 hover:text-primary transition-colors"
        >
          <ChevronLeft className="w-3 h-3" /> Shared
        </button>
      }
    >
      {loading ? (
        <div className="flex items-center justify-center py-16"><Loader2 className="w-5 h-5 text-primary animate-spin" /></div>
      ) : shares.length === 0 ? (
        <VaultSectionEmptyState
          icon={Share2}
          title="No active shares"
          note="All shares for this entity have been removed."
        />
      ) : (
        <div className="space-y-2">
          {shares.map(s => (
            <div key={s.id} className="bg-card border border-card-border rounded-xl p-4 space-y-3">
              {/* User row */}
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center flex-shrink-0">
                  <Users className="w-3.5 h-3.5 text-primary" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-mono text-xs font-bold text-foreground truncate">
                    {s.sharedWithUsername}
                  </p>
                  <p className="font-mono text-[9px] text-muted-foreground/50">
                    Since {new Date(s.createdAt).toLocaleDateString()}
                  </p>
                </div>
                {/* Active status badge */}
                <Badge
                  variant="outline"
                  className={cn(
                    "font-mono text-[8px] px-1.5 flex-shrink-0",
                    s.isActive
                      ? "text-emerald-400 border-emerald-400/30 bg-emerald-400/5"
                      : "text-muted-foreground/40 border-border/30"
                  )}
                >
                  {s.isActive ? <><CheckCircle2 className="w-2 h-2 mr-0.5 inline" />Active</> : <><XCircle className="w-2 h-2 mr-0.5 inline" />Inactive</>}
                </Badge>
              </div>

              {/* Controls row */}
              <div className="flex items-center gap-2 flex-wrap">
                {/* Permission selector — hidden for per-field shares, where access is
                    controlled field-by-field instead of one whole-entity level. */}
                {s.fieldPermissions ? (
                  <Badge
                    variant="outline"
                    className="font-mono text-[10px] h-8 px-3 flex items-center gap-1.5 flex-shrink-0 text-violet-400 border-violet-400/30 bg-violet-400/5"
                    title={Object.entries(s.fieldPermissions).map(([f, p]) => `${f}: ${p}`).join(", ")}
                  >
                    {Object.keys(s.fieldPermissions).length} field{Object.keys(s.fieldPermissions).length === 1 ? "" : "s"} shared
                  </Badge>
                ) : (
                  <Select
                    value={s.permission}
                    onValueChange={(v: "view" | "edit") => updatePermission(s, v)}
                    disabled={busyId === s.id}
                  >
                    <SelectTrigger className="font-mono text-[10px] h-8 w-[140px] flex-shrink-0">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="view" className="font-mono text-xs">
                        <span className="flex items-center gap-1.5"><Eye className="w-3 h-3" /> Read-only</span>
                      </SelectItem>
                      <SelectItem value="edit" className="font-mono text-xs">
                        <span className="flex items-center gap-1.5"><Pencil className="w-3 h-3" /> Full access</span>
                      </SelectItem>
                    </SelectContent>
                  </Select>
                )}

                {/* Active toggle */}
                <button
                  disabled={busyId === s.id}
                  onClick={() => toggleActive(s, !s.isActive)}
                  className={cn(
                    "flex items-center gap-1.5 px-3 h-8 rounded-lg border font-mono text-[10px] transition-all flex-shrink-0",
                    s.isActive
                      ? "border-emerald-400/30 bg-emerald-400/5 text-emerald-400 hover:bg-emerald-400/10"
                      : "border-border/40 text-muted-foreground/50 hover:border-primary/30"
                  )}
                >
                  {s.isActive
                    ? <><ToggleRight className="w-3.5 h-3.5" /> On</>
                    : <><ToggleLeft className="w-3.5 h-3.5" /> Off</>
                  }
                </button>

                {/* Spacer */}
                <div className="flex-1" />

                {/* Revoke */}
                <button
                  disabled={busyId === s.id}
                  onClick={() => removeShare(s)}
                  className="flex items-center gap-1.5 px-3 h-8 rounded-lg border border-red-400/20 bg-red-400/5 text-red-400 font-mono text-[10px] hover:bg-red-400/10 transition-all flex-shrink-0 disabled:opacity-40"
                >
                  <Trash2 className="w-3 h-3" /> Revoke
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </VaultSectionPage>
  );
}
