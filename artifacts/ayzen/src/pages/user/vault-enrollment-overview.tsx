/**
 * vault-enrollment-overview.tsx
 * ─────────────────────────────────────────────
 * Enrollment → Overview: roll-up of every vault entity that is enrolled in
 * at least one project. Shows a summary dashboard bar at the top, then
 * individual entity cards — click any card to open the entity detail page.
 */
import { useEffect, useState, useCallback } from "react";
import { useLocation } from "wouter";
import {
  LayoutDashboard, Shield, FolderGit2,
  TrendingUp, Users, CheckCircle2, Activity,
} from "lucide-react";
import { useListVaultEntries, customFetch } from "@workspace/api-client-react";
import { VaultSectionPage, VaultSectionEmptyState } from "@/components/layout/vault-sidebar";
import { VaultLoadingIntro } from "@/components/vault/vault-loading-intro";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

type EntryAny = any;

interface LeaderboardRow {
  vaultEntryId: number;
  totalProjects: number;
  activeProjects: number;
  completedProjects: number;
  totalReward: number;
}

export default function VaultEnrollmentOverview() {
  const [, navigate] = useLocation();
  const { data, isLoading } = useListVaultEntries();
  const entries: EntryAny[] = (data as EntryAny[] | undefined) ?? [];
  const [lb, setLb] = useState<LeaderboardRow[]>([]);
  const [lbLoading, setLbLoading] = useState(true);

  const loadLb = useCallback(async () => {
    setLbLoading(true);
    try {
      const rows = await customFetch<LeaderboardRow[]>("/api/projects/entity-leaderboard");
      setLb(Array.isArray(rows) ? rows : []);
    } catch {
      setLb([]);
    } finally {
      setLbLoading(false);
    }
  }, []);

  useEffect(() => { loadLb(); }, [loadLb]);

  const loading = isLoading || lbLoading;

  // Build map for fast lookup
  const lbMap = new Map<number, LeaderboardRow>(lb.map(r => [r.vaultEntryId, r]));

  // Only show entities that are actually enrolled somewhere
  const enrolled = entries.filter(e => (lbMap.get(e.id)?.totalProjects ?? 0) > 0);
  const notEnrolled = entries.length - enrolled.length;

  // Dashboard stats
  const totalEnrolled = enrolled.length;
  const totalProjects = lb.reduce((s, r) => s + r.totalProjects, 0);
  const totalActive = lb.reduce((s, r) => s + r.activeProjects, 0);
  const totalCompleted = lb.reduce((s, r) => s + r.completedProjects, 0);

  return (
    <VaultSectionPage
      title="Enrollment"
      description="All enrolled entities — click any card to view details"
      icon={LayoutDashboard}
    >
      {loading ? (
        <VaultLoadingIntro title="Loading enrollment overview" done={!loading} />
      ) : (
        <div className="space-y-5">
          {/* Dashboard summary */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              { label: "Enrolled Entities", value: totalEnrolled, icon: Users, color: "text-cyan-400", bg: "bg-cyan-400/10" },
              { label: "Total Enrollments", value: totalProjects, icon: FolderGit2, color: "text-violet-400", bg: "bg-violet-400/10" },
              { label: "Active", value: totalActive, icon: Activity, color: "text-emerald-400", bg: "bg-emerald-400/10" },
              { label: "Completed", value: totalCompleted, icon: CheckCircle2, color: "text-amber-400", bg: "bg-amber-400/10" },
            ].map(s => (
              <div key={s.label} className="bg-card border border-card-border rounded-xl p-3.5 flex items-start gap-3">
                <div className={cn("w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0", s.bg)}>
                  <s.icon className={cn("w-4 h-4", s.color)} />
                </div>
                <div>
                  <p className={cn("text-lg font-bold font-mono", s.color)}>{s.value}</p>
                  <p className="text-[10px] text-muted-foreground/60 font-mono mt-0.5 leading-tight">{s.label}</p>
                </div>
              </div>
            ))}
          </div>

          {enrolled.length === 0 ? (
            <VaultSectionEmptyState
              icon={Shield}
              title="No enrolled entities yet"
              note={entries.length === 0
                ? "Add entities to your vault first, then enroll them into projects."
                : `You have ${entries.length} ${entries.length === 1 ? "entity" : "entities"} — enroll them into projects to see them here.`}
            />
          ) : (
            <>
              {notEnrolled > 0 && (
                <p className="font-mono text-[10px] text-muted-foreground/40">
                  {notEnrolled} {notEnrolled === 1 ? "entity" : "entities"} not yet enrolled — showing enrolled only
                </p>
              )}
              <div className="space-y-2">
                {enrolled.map(e => {
                  const row = lbMap.get(e.id);
                  return (
                    <button
                      key={e.id}
                      onClick={() => navigate(`/vault/entity/${e.id}`)}
                      className="w-full bg-card border border-card-border rounded-lg p-3.5 flex items-center gap-3 hover:border-primary/30 hover:bg-primary/5 transition-all text-left group"
                    >
                      <div className="w-9 h-9 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center flex-shrink-0">
                        <Shield className="w-4 h-4 text-primary" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="font-mono text-xs font-bold text-foreground truncate group-hover:text-primary transition-colors">
                          {e.projectName || `Entity #${e.id}`}
                        </p>
                        <p className="font-mono text-[9px] text-muted-foreground/50 truncate mt-0.5">
                          {e.entitySerial ?? ""}
                          {e.twitterUsername ? ` · @${e.twitterUsername}` : ""}
                        </p>
                      </div>
                      <div className="flex flex-col items-end gap-1 flex-shrink-0">
                        <Badge
                          variant="outline"
                          className="font-mono text-[9px] text-violet-400 border-violet-400/30 bg-violet-400/5"
                        >
                          {row?.totalProjects ?? 0} project{(row?.totalProjects ?? 0) === 1 ? "" : "s"}
                        </Badge>
                        {(row?.activeProjects ?? 0) > 0 && (
                          <Badge
                            variant="outline"
                            className="font-mono text-[9px] text-emerald-400 border-emerald-400/30 bg-emerald-400/5"
                          >
                            {row!.activeProjects} active
                          </Badge>
                        )}
                      </div>
                      <TrendingUp className="w-3.5 h-3.5 text-muted-foreground/20 group-hover:text-primary/40 transition-colors flex-shrink-0" />
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}
    </VaultSectionPage>
  );
}
