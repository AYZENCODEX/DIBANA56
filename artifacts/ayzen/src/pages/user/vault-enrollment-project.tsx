/**
 * vault-enrollment-project.tsx
 * ─────────────────────────────────────────────
 * Enrollment → Project: lists all projects the user has entities enrolled in.
 * Click a project card to navigate to its dedicated detail page
 * (/vault/enrollment/project/:id) which shows the enrolled entities.
 */
import { useEffect, useState, useCallback } from "react";
import { useLocation } from "wouter";
import {
  FolderGit2, Loader2, ChevronRight,
  CheckCircle2, Activity, XCircle, Users,
} from "lucide-react";
import { customFetch } from "@workspace/api-client-react";
import { VaultSectionPage, VaultSectionEmptyState } from "@/components/layout/vault-sidebar";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

interface EnrolledProject {
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

const STATUS_ICON: Record<string, React.ElementType> = {
  active:    Activity,
  completed: CheckCircle2,
  cancelled: XCircle,
};

export default function VaultEnrollmentProject() {
  const [, navigate] = useLocation();
  const [projects, setProjects] = useState<EnrolledProject[]>([]);
  const [loading, setLoading] = useState(true);

  const loadProjects = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await customFetch<EnrolledProject[]>("/api/projects/enrolled");
      setProjects(Array.isArray(rows) ? rows : []);
    } catch {
      setProjects([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadProjects(); }, [loadProjects]);

  return (
    <VaultSectionPage
      title="Projects"
      description="Projects your entities are enrolled in — click to view enrolled entities"
      icon={FolderGit2}
    >
      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-5 h-5 text-primary animate-spin" />
        </div>
      ) : projects.length === 0 ? (
        <VaultSectionEmptyState
          icon={FolderGit2}
          title="No project enrollments"
          note="Enroll your entities into projects to see them here."
        />
      ) : (
        <div className="space-y-2">
          {projects.map(project => {
            const StatusIcon = STATUS_ICON[project.status ?? "active"] ?? Activity;
            const statusKey = project.status ?? "active";
            return (
              <button
                key={project.id}
                onClick={() => navigate(`/vault/enrollment/project/${project.id}`)}
                className="w-full bg-card border border-card-border rounded-xl p-3.5 flex items-center gap-3 hover:border-primary/30 hover:bg-primary/5 transition-all text-left group"
              >
                <div className="w-9 h-9 rounded-lg bg-primary/10 border border-primary/15 flex items-center justify-center flex-shrink-0 group-hover:bg-primary/20 group-hover:border-primary/30 transition-colors">
                  <FolderGit2 className="w-4 h-4 text-primary/70 group-hover:text-primary transition-colors" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-mono text-xs font-bold text-foreground truncate group-hover:text-primary transition-colors">
                    {project.name}
                  </p>
                  <p className="font-mono text-[9px] text-muted-foreground/50 mt-0.5">
                    {project.category ?? "Uncategorized"}
                  </p>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <div className="flex items-center gap-1 text-muted-foreground/50">
                    <Users className="w-3 h-3" />
                    <span className="font-mono text-[9px]">{project.enrolled_count}</span>
                  </div>
                  <div className={cn("flex items-center gap-1", STATUS_BADGE[statusKey])}>
                    <StatusIcon className="w-3 h-3" />
                    <Badge
                      variant="outline"
                      className={cn("font-mono text-[8px]", STATUS_BADGE[statusKey])}
                    >
                      {statusKey}
                    </Badge>
                  </div>
                </div>
                <ChevronRight className="w-3.5 h-3.5 text-muted-foreground/20 group-hover:text-primary/40 flex-shrink-0 transition-colors" />
              </button>
            );
          })}
        </div>
      )}
    </VaultSectionPage>
  );
}
