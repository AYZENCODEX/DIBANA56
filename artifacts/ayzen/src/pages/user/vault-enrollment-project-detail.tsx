/**
 * vault-enrollment-project-detail.tsx
 * ─────────────────────────────────────────────
 * Enrollment → Project → [project detail]: shows all vault entities enrolled
 * in a specific project. Each entity card is clickable → entity detail page.
 */
import { useEffect, useState, useCallback } from "react";
import { useLocation, useParams } from "wouter";
import {
  FolderGit2, Shield, Loader2, ChevronRight,
  ChevronLeft, Activity, CheckCircle2, XCircle,
  Users, AlertCircle,
} from "lucide-react";
import { customFetch } from "@workspace/api-client-react";
import { VaultSectionPage, VaultSectionEmptyState } from "@/components/layout/vault-sidebar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface EnrolledEntity {
  id: number;
  project_name: string;
  category: string;
  entity_serial: string | null;
  status: string;
  twitter_username: string | null;
  discord_username: string | null;
  telegram_username: string | null;
  enrollment_status: string;
}

interface ProjectInfo {
  id: number;
  name: string;
  category: string | null;
  status: string | null;
  enrolled_count: number;
}

const STATUS_BADGE: Record<string, string> = {
  active:       "text-emerald-400 border-emerald-400/30 bg-emerald-400/5",
  completed:    "text-amber-400 border-amber-400/30 bg-amber-400/5",
  disqualified: "text-red-400 border-red-400/30 bg-red-400/5",
  banned:       "text-red-500 border-red-500/30 bg-red-500/5",
  cancelled:    "text-muted-foreground/40 border-border/30",
};

function entitySub(e: EnrolledEntity): string {
  const parts: string[] = [e.category];
  if (e.twitter_username) parts.push(`@${e.twitter_username}`);
  else if (e.discord_username) parts.push(e.discord_username);
  else if (e.telegram_username) parts.push(`@${e.telegram_username}`);
  if (e.entity_serial) parts.push(e.entity_serial);
  return parts.join(" · ");
}

export default function VaultEnrollmentProjectDetail() {
  const params = useParams<{ id: string }>();
  const projectId = Number(params.id);
  const [, navigate] = useLocation();

  const [project, setProject] = useState<ProjectInfo | null>(null);
  const [entities, setEntities] = useState<EnrolledEntity[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    setError(false);
    try {
      // Load project info + enrolled entities in parallel
      const [projects, ents] = await Promise.all([
        customFetch<ProjectInfo[]>("/api/projects/enrolled"),
        customFetch<EnrolledEntity[]>(`/api/projects/${projectId}/enrolled-entities`),
      ]);
      const proj = Array.isArray(projects)
        ? projects.find(p => p.id === projectId) ?? null
        : null;
      setProject(proj);
      setEntities(Array.isArray(ents) ? ents : []);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  return (
    <VaultSectionPage
      title={project?.name ?? "Project"}
      description="Entities enrolled in this project — click to view details"
      icon={FolderGit2}
    >
      {/* Back nav */}
      <div className="mb-4">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => navigate("/vault/enrollment/project")}
          className="font-mono text-xs text-muted-foreground/60 hover:text-foreground gap-1.5 pl-1"
        >
          <ChevronLeft className="w-3.5 h-3.5" />
          All Projects
        </Button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-5 h-5 text-primary animate-spin" />
        </div>
      ) : error ? (
        <div className="flex flex-col items-center justify-center py-20 gap-3">
          <AlertCircle className="w-8 h-8 text-red-400/50" />
          <p className="font-mono text-xs text-muted-foreground/50">Failed to load project</p>
          <Button variant="outline" size="sm" onClick={load} className="font-mono text-xs">
            Retry
          </Button>
        </div>
      ) : (
        <div className="space-y-4">
          {/* Project header card */}
          {project && (
            <div className="bg-card border border-primary/20 rounded-xl p-4 flex items-center gap-4">
              <div className="w-10 h-10 rounded-xl bg-primary/15 border border-primary/25 flex items-center justify-center flex-shrink-0">
                <FolderGit2 className="w-5 h-5 text-primary" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-mono text-sm font-bold text-foreground truncate">{project.name}</p>
                <p className="font-mono text-[10px] text-muted-foreground/50 mt-0.5">
                  {project.category ?? "Uncategorized"} · {project.enrolled_count} entit{project.enrolled_count === 1 ? "y" : "ies"} enrolled
                </p>
              </div>
              <Badge
                variant="outline"
                className={cn("font-mono text-[9px] flex-shrink-0", STATUS_BADGE[project.status ?? "active"] ?? STATUS_BADGE.active)}
              >
                {project.status ?? "active"}
              </Badge>
            </div>
          )}

          {/* Entity list */}
          {entities.length === 0 ? (
            <VaultSectionEmptyState
              icon={Users}
              title="No entities enrolled"
              note="Enroll vault entities into this project to see them here."
            />
          ) : (
            <div className="space-y-2">
              <p className="font-mono text-[9px] uppercase tracking-widest text-muted-foreground/40 px-1">
                {entities.length} Enrolled {entities.length === 1 ? "Entity" : "Entities"}
              </p>
              {entities.map(entity => {
                const EnrollIcon =
                  entity.enrollment_status === "active" ? Activity :
                  entity.enrollment_status === "completed" ? CheckCircle2 :
                  XCircle;
                const enrollColor =
                  entity.enrollment_status === "active" ? "text-emerald-400" :
                  entity.enrollment_status === "completed" ? "text-amber-400" :
                  "text-red-400/60";

                return (
                  <button
                    key={entity.id}
                    onClick={() => navigate(`/vault/entity/${entity.id}`)}
                    className="w-full bg-card border border-card-border rounded-lg p-3.5 flex items-center gap-3 hover:border-primary/30 hover:bg-primary/5 transition-all text-left group"
                  >
                    <div className="w-9 h-9 rounded-lg bg-muted/20 border border-border/30 flex items-center justify-center flex-shrink-0 group-hover:bg-primary/10 group-hover:border-primary/20 transition-colors">
                      <Shield className="w-4 h-4 text-muted-foreground/50 group-hover:text-primary/70 transition-colors" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-mono text-xs font-bold text-foreground truncate group-hover:text-primary transition-colors">
                        {entity.project_name || `Entity #${entity.id}`}
                      </p>
                      <p className="font-mono text-[9px] text-muted-foreground/50 truncate mt-0.5">
                        {entitySub(entity)}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <div className={cn("flex items-center gap-1", enrollColor)}>
                        <EnrollIcon className="w-3 h-3" />
                        <Badge
                          variant="outline"
                          className={cn("font-mono text-[8px]", STATUS_BADGE[entity.enrollment_status] ?? STATUS_BADGE.active)}
                        >
                          {entity.enrollment_status}
                        </Badge>
                      </div>
                    </div>
                    <ChevronRight className="w-3.5 h-3.5 text-muted-foreground/20 group-hover:text-primary/40 flex-shrink-0 transition-colors" />
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </VaultSectionPage>
  );
}
