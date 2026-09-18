// entity-dashboard.tsx
// ─────────────────────────────────────────────
// Phase 10B — Enroll: entity dedicated dashboard
//
// Each entity in the Phase 10A list (pages/user/enroll-entities.tsx,
// OthersEntitiesTab via its onSelect prop) is clickable and opens here — its
// own deep-linkable URL (/enroll/entities/:id), mirroring Phase 9B's
// project-dashboard.tsx pattern for projects. Unlike project-dashboard.tsx,
// there's no separate stats panel to build here: the header just identifies
// the entity, and the body is entirely components/entity-dashboard-tabs.tsx
// (EntityDashboardTabs) scoped to this vaultEntryId — the same component
// vault-entity-detail.tsx already uses for its "Dashboard" tab. Zero
// duplicate dashboard code.
import { useParams, useLocation } from "wouter";
import { useListVaultEntries } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ChevronLeft, Loader2, Shield } from "lucide-react";
import { cn } from "@/lib/utils";
import EntityDashboardTabs from "@/components/entity-dashboard-tabs";

type EntryAny = any;

export default function EntityDashboardPage() {
  const { id } = useParams<{ id: string }>();
  const vaultEntryId = Number(id);
  const [, navigate] = useLocation();
  const { data, isLoading } = useListVaultEntries();

  const entries: EntryAny[] = (data as EntryAny[] | undefined) ?? [];
  const entry = entries.find(e => String(e.id) === String(id));

  return (
    <div className="space-y-5 page-enter">
      <div>
        <Button variant="ghost" size="sm" onClick={() => navigate("/enroll/entities")} className="font-mono text-xs gap-1.5 mb-3 -ml-2">
          <ChevronLeft className="w-3.5 h-3.5" /> Back to Entities
        </Button>
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center flex-shrink-0">
            <Shield className="w-4 h-4 text-primary" />
          </div>
          <div className="min-w-0">
            <h1 className="text-xl font-bold font-mono tracking-tighter truncate">
              {isLoading ? "Loading..." : entry?.projectName ?? `Entity #${vaultEntryId}`}
            </h1>
            {entry?.entitySerial && (
              <div className="flex items-center gap-2 mt-0.5">
                <span className="font-mono text-[10px] text-muted-foreground/50">{entry.entitySerial}</span>
              </div>
            )}
          </div>
        </div>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-16"><Loader2 className="w-5 h-5 text-primary animate-spin" /></div>
      ) : (
        <EntityDashboardTabs vaultEntryId={vaultEntryId} />
      )}
    </div>
  );
}
