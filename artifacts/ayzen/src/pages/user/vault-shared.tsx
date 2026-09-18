/**
 * vault-shared.tsx
 * ─────────────────────────────────────────────
 * Vault → Other → Shared.
 *
 * Groups all outgoing shares by entity. Each entity card is clickable →
 * navigates to /vault/shared/entity/:entityId where you can manage all
 * shares for that specific entity.
 */
import { useState, useEffect, useCallback } from "react";
import { useLocation } from "wouter";
import { Share2, Loader2, Users, ChevronRight, Eye, Pencil } from "lucide-react";
import { customFetch } from "@workspace/api-client-react";
import { VaultSectionPage, VaultSectionEmptyState } from "@/components/layout/vault-sidebar";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

export interface SharedEntry {
  id: number;
  entityType: string;
  entityId: number;
  entityLabel: string;
  sharedWithUserId: number;
  sharedWithUsername: string;
  permission: "view" | "edit";
  fieldPermissions: Record<string, "view" | "edit"> | null;
  isActive: boolean;
  createdAt: string;
}

interface EntityGroup {
  entityType: string;
  entityId: number;
  entityLabel: string;
  shares: SharedEntry[];
}

function groupByEntity(shares: SharedEntry[]): EntityGroup[] {
  const map = new Map<string, EntityGroup>();
  for (const s of shares) {
    const key = `${s.entityType}:${s.entityId}`;
    if (!map.has(key)) {
      map.set(key, { entityType: s.entityType, entityId: s.entityId, entityLabel: s.entityLabel, shares: [] });
    }
    map.get(key)!.shares.push(s);
  }
  return [...map.values()].sort((a, b) => a.entityLabel.localeCompare(b.entityLabel));
}

export default function VaultShared() {
  const [, navigate] = useLocation();
  const [shares, setShares] = useState<SharedEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const { toast } = useToast();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await customFetch<SharedEntry[]>("/api/vault-shares/sent");
      setShares(Array.isArray(data) ? data : []);
    } catch {
      toast({ variant: "destructive", title: "Failed to load shared entities" });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  const groups = groupByEntity(shares);

  return (
    <VaultSectionPage title="Shared" description="Entities you've shared — tap to manage" icon={Share2}>
      {loading ? (
        <div className="flex items-center justify-center py-16"><Loader2 className="w-5 h-5 text-primary animate-spin" /></div>
      ) : groups.length === 0 ? (
        <VaultSectionEmptyState
          icon={Share2}
          title="Nothing shared yet"
          note="Entities you share from the Vault entity list will appear here, grouped by entity."
        />
      ) : (
        <div className="space-y-2">
          {groups.map(g => {
            const activeCount = g.shares.filter(s => s.isActive).length;
            const editCount   = g.shares.filter(s => !s.fieldPermissions && s.permission === "edit").length;
            const fieldRestrictedCount = g.shares.filter(s => !!s.fieldPermissions).length;
            return (
              <div
                key={`${g.entityType}:${g.entityId}`}
                onClick={() => navigate(`/vault/shared/${g.entityType}/${g.entityId}`)}
                className="bg-card border border-card-border rounded-lg px-3 py-3 flex items-center gap-3 cursor-pointer hover:border-primary/30 transition-all group"
              >
                {/* Icon */}
                <div className="w-8 h-8 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center flex-shrink-0 group-hover:bg-primary/15 transition-colors">
                  <Users className="w-3.5 h-3.5 text-primary" />
                </div>

                {/* Label + share summary */}
                <div className="min-w-0 flex-1">
                  <p className="font-mono text-xs font-bold text-foreground truncate">{g.entityLabel}</p>
                  <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                    <span className="font-mono text-[9px] text-muted-foreground/50">
                      {g.shares.length} share{g.shares.length !== 1 ? "s" : ""}
                    </span>
                    {editCount > 0 && (
                      <Badge variant="outline" className={cn("font-mono text-[8px] px-1.5 gap-1", "text-amber-400 border-amber-400/30 bg-amber-400/5")}>
                        <Pencil className="w-2 h-2" />{editCount} edit
                      </Badge>
                    )}
                    {(g.shares.length - editCount - fieldRestrictedCount) > 0 && (
                      <Badge variant="outline" className="font-mono text-[8px] px-1.5 gap-1 text-blue-400 border-blue-400/30 bg-blue-400/5">
                        <Eye className="w-2 h-2" />{g.shares.length - editCount - fieldRestrictedCount} view
                      </Badge>
                    )}
                    {fieldRestrictedCount > 0 && (
                      <Badge variant="outline" className="font-mono text-[8px] px-1.5 gap-1 text-violet-400 border-violet-400/30 bg-violet-400/5">
                        {fieldRestrictedCount} per-field
                      </Badge>
                    )}
                    {activeCount < g.shares.length && (
                      <Badge variant="outline" className="font-mono text-[8px] px-1.5 text-muted-foreground/50 border-border/30">
                        {g.shares.length - activeCount} inactive
                      </Badge>
                    )}
                  </div>
                </div>

                <ChevronRight className="w-4 h-4 text-muted-foreground/30 flex-shrink-0 group-hover:text-primary/40 transition-colors" />
              </div>
            );
          })}
        </div>
      )}
    </VaultSectionPage>
  );
}
