/**
 * vault-enrollment-entity.tsx
 * ─────────────────────────────────────────────
 * Vault → Enrollment → Entity — now its own 3-item hierarchy in the Vault
 * sidebar (Entity Overview / Entity Ongoing / Entity Past — see ENROLL_ITEMS
 * in components/layout/vault-sidebar.tsx), replacing the old single-list
 * "Entity" page (pages/user/vault-enroll.tsx). One component, one dataset
 * (GET /projects/mine/enrolled-entities), three views selected by the
 * :view route param:
 *
 *   overview — every entity enrolled into at least one project
 *   ongoing  — entities with at least one project whose own lifecycle
 *              status (projects.status) is "active" or "paused"
 *   past     — entities with at least one project whose status is
 *              "completed" or "archived"
 *
 * An entity can show up under both Ongoing and Past if it has projects in
 * each bucket — that's expected, not a bug, since the split is per-project
 * status rather than a single flag on the entity.
 */
import { useEffect, useState, useCallback } from "react";
import { useParams, Link } from "wouter";
import { Shield, Loader2, Activity, History, LayoutDashboard } from "lucide-react";
import { customFetch } from "@workspace/api-client-react";
import { VaultSectionPage, VaultSectionEmptyState } from "@/components/layout/vault-sidebar";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

interface EntityProjectRow {
  projectId: number;
  projectName: string;
  projectStatus: string | null;
  enrollmentStatus: string;
  enrolledAt: string;
}

interface EnrolledEntity {
  vaultEntryId: number;
  entityName: string | null;
  entitySerial: string | null;
  category: string | null;
  projects: EntityProjectRow[];
  hasOngoing: boolean;
  hasPast: boolean;
}

const ONGOING_STATUSES = new Set(["active", "paused"]);
const PAST_STATUSES = new Set(["completed", "archived"]);

type View = "overview" | "ongoing" | "past";

const VIEW_META: Record<View, { title: string; description: string; icon: React.ElementType; empty: string; note: string }> = {
  overview: {
    title: "Entity — Overview",
    description: "Every entity enrolled into at least one project",
    icon: LayoutDashboard,
    empty: "No enrolled entities yet",
    note: "Enroll an entity into a project — it'll show up here.",
  },
  ongoing: {
    title: "Entity — Ongoing",
    description: "Entities with at least one project that's still active or paused",
    icon: Activity,
    empty: "No entities in an ongoing project",
    note: "Once one of an entity's projects is active or paused, it'll show up here.",
  },
  past: {
    title: "Entity — Past",
    description: "Entities with at least one project that's completed or archived",
    icon: History,
    empty: "No entities with a past project yet",
    note: "Once one of an entity's projects wraps up (completed/archived), it'll show up here.",
  },
};

function useAuthedEntities() {
  const [entities, setEntities] = useState<EnrolledEntity[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await customFetch<EnrolledEntity[]>("/api/projects/mine/enrolled-entities");
      setEntities(Array.isArray(rows) ? rows : []);
    } catch {
      setEntities([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  return { entities, loading };
}

export default function VaultEnrollmentEntity() {
  const params = useParams<{ view?: string }>();
  const view: View = params.view === "ongoing" || params.view === "past" ? (params.view as View) : "overview";
  const meta = VIEW_META[view];
  const { entities, loading } = useAuthedEntities();

  const filtered = entities.filter(e =>
    view === "overview" ? true : view === "ongoing" ? e.hasOngoing : e.hasPast
  );

  return (
    <VaultSectionPage title={meta.title} description={meta.description} icon={meta.icon}>
      {loading ? (
        <div className="flex items-center justify-center py-16"><Loader2 className="w-5 h-5 text-primary animate-spin" /></div>
      ) : filtered.length === 0 ? (
        <VaultSectionEmptyState icon={meta.icon} title={meta.empty} note={meta.note} />
      ) : (
        <div className="space-y-2">
          {filtered.map(e => {
            const shownProjects = view === "overview"
              ? e.projects
              : e.projects.filter(p =>
                  view === "ongoing" ? ONGOING_STATUSES.has(p.projectStatus ?? "active") : PAST_STATUSES.has(p.projectStatus ?? "active")
                );
            return (
              <div key={e.vaultEntryId} className="bg-card border border-card-border rounded-lg p-3">
                <div className="flex items-center gap-3">
                  <Shield className="w-3.5 h-3.5 text-primary/70 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="font-mono text-xs font-bold truncate">{e.entityName || `Entity #${e.vaultEntryId}`}</p>
                    <p className="font-mono text-[9px] text-muted-foreground/50 truncate">{e.entitySerial}</p>
                  </div>
                  <Badge
                    variant="outline"
                    className="font-mono text-[9px] flex-shrink-0 text-emerald-400 border-emerald-400/30 bg-emerald-400/5"
                  >
                    {e.projects.length} project{e.projects.length !== 1 ? "s" : ""}
                  </Badge>
                </div>
                {shownProjects.length > 0 && (
                  <div className="mt-2 pl-6 flex flex-wrap gap-1.5">
                    {shownProjects.map(p => (
                      <Link key={p.projectId} href={`/vault/enrollment/project/${p.projectId}`}>
                        <span
                          className={cn(
                            "font-mono text-[9px] px-2 py-0.5 rounded-full border cursor-pointer transition-colors",
                            ONGOING_STATUSES.has(p.projectStatus ?? "active")
                              ? "border-emerald-400/30 text-emerald-400 hover:bg-emerald-400/10"
                              : "border-border/40 text-muted-foreground/60 hover:bg-muted/20"
                          )}
                        >
                          {p.projectName} · {p.projectStatus ?? "active"}
                        </span>
                      </Link>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </VaultSectionPage>
  );
}
