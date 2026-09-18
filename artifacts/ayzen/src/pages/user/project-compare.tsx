// PHASE 6 — Project comparison view
// Read-only side-by-side comparison of 2–3 projects, selected from the
// /projects list (see the compare bar + checkboxes added there). Reuses the
// already-cached useListProjects query — no new list endpoint needed — and
// fetches live enrolled-entity counts the same way project-detail.tsx does.

import { useEffect, useMemo, useState } from "react";
import { useListProjects } from "@workspace/api-client-react";
import { Link, useSearch } from "wouter";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { ArrowLeft, Scale, X, Users, ExternalLink, BookOpen } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/use-auth";
import { TIER_COLORS, CATEGORY_COLORS } from "@/config/projects";
import { ProjectBadgeList, parseProjectBadges } from "@/components/project/project-badge-list";

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";

function daysRemaining(deadline: string | null | undefined) {
  if (!deadline) return null;
  const diff = new Date(deadline).getTime() - Date.now();
  if (diff < 0) return -1;
  return Math.ceil(diff / 86_400_000);
}

function DeadlineText({ deadline }: { deadline?: string | null }) {
  const days = daysRemaining(deadline);
  if (days === null) return <span className="text-muted-foreground/50">—</span>;
  if (days < 0) return <span className="text-red-400">Ended</span>;
  if (days === 0) return <span className="text-red-400">Last day</span>;
  return <span>{days}d left</span>;
}

// Row label in the left-most sticky column.
function RowLabel({ children }: { children: React.ReactNode }) {
  return (
    <TableCell className="sticky left-0 bg-card font-mono text-[10px] uppercase tracking-wider text-muted-foreground/60 whitespace-nowrap align-top pt-4">
      {children}
    </TableCell>
  );
}

export default function ProjectCompare() {
  const rawSearch = useSearch();
  const searchParams = new URLSearchParams(rawSearch.startsWith("?") ? rawSearch.slice(1) : rawSearch);
  const ids = useMemo(() => {
    const parsed = (searchParams.get("ids") ?? "")
      .split(",")
      .map(s => Number(s.trim()))
      .filter(n => Number.isFinite(n));
    // De-dupe while preserving selection order, cap at 3.
    return Array.from(new Set(parsed)).slice(0, 3);
  }, [rawSearch]);

  const { token } = useAuth();
  const { data, isLoading } = useListProjects({ limit: 200 });
  const allProjects = data?.projects ?? [];
  const projects = ids
    .map(id => allProjects.find((p: any) => p.id === id))
    .filter(Boolean) as any[];

  // Live enrolled-entity counts per project (same endpoint project-detail.tsx uses).
  const [counts, setCounts] = useState<Record<number, number | null>>({});
  useEffect(() => {
    let cancelled = false;
    ids.forEach(id => {
      fetch(`${BASE}/api/projects/${id}/enrollments`, {
        headers: { Authorization: `Bearer ${token}` },
      })
        .then(res => (res.ok ? res.json() : []))
        .then(list => { if (!cancelled) setCounts(prev => ({ ...prev, [id]: Array.isArray(list) ? list.length : null })); })
        .catch(() => { if (!cancelled) setCounts(prev => ({ ...prev, [id]: null })); });
    });
    return () => { cancelled = true; };
  }, [rawSearch, token]); // eslint-disable-line react-hooks/exhaustive-deps

  const [removed, setRemoved] = useState<Set<number>>(new Set());
  const visibleProjects = projects.filter(p => !removed.has(p.id));

  // Phase 7B — `badges` comes back from the API as a JSON string (same
  // convention as tutorialSteps), not a pre-parsed array, so this needs the
  // shared parser rather than an Array.isArray check on the raw field.
  const hasBadges = visibleProjects.some(p => parseProjectBadges((p as any).badges).length > 0);

  if (!isLoading && ids.length < 2) {
    return (
      <div className="space-y-4 page-enter">
        <Link href="/projects">
          <Button variant="outline" size="sm" className="font-mono text-xs gap-1.5"><ArrowLeft className="w-3 h-3" /> Back to Projects</Button>
        </Link>
        <div className="py-16 text-center font-mono text-muted-foreground bg-card border border-card-border rounded-lg">
          <Scale className="w-8 h-8 mx-auto mb-3 opacity-20" />
          <p className="text-sm">Pick 2 or 3 projects from the list to compare them.</p>
        </div>
      </div>
    );
  }

  if (!isLoading && visibleProjects.length < 2) {
    return (
      <div className="space-y-4 page-enter">
        <Link href="/projects">
          <Button variant="outline" size="sm" className="font-mono text-xs gap-1.5"><ArrowLeft className="w-3 h-3" /> Back to Projects</Button>
        </Link>
        <div className="py-16 text-center font-mono text-muted-foreground bg-card border border-card-border rounded-lg">
          <Scale className="w-8 h-8 mx-auto mb-3 opacity-20" />
          <p className="text-sm">Not enough projects left to compare.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4 page-enter">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold font-mono tracking-tighter uppercase text-glow flex items-center gap-2">
            <Scale className="w-5 h-5 text-primary" /> Compare Projects
          </h1>
          <p className="text-muted-foreground font-mono text-sm mt-0.5">
            {visibleProjects.length} projects · read-only view
          </p>
        </div>
        <Link href="/projects">
          <Button variant="outline" size="sm" className="font-mono text-xs gap-1.5"><ArrowLeft className="w-3 h-3" /> Back to Projects</Button>
        </Link>
      </div>

      {isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: ids.length || 2 }).map((_, i) => (
            <Skeleton key={i} className="h-64 w-full" />
          ))}
        </div>
      ) : (
        <div className="bg-card border border-card-border rounded-lg overflow-x-auto">
          <Table className="min-w-[500px]">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="sticky left-0 bg-card w-32" />
                {visibleProjects.map(project => (
                  <TableHead key={project.id} className="min-w-[220px] align-top py-4">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 min-w-0">
                          {project.thumbnailUrl && (
                            <img src={project.thumbnailUrl} alt="" className="w-6 h-6 rounded-md object-cover border border-card-border flex-shrink-0" />
                          )}
                          <span className="font-mono font-bold text-primary truncate">{project.name}</span>
                        </div>
                        <Link href={`/projects/${project.id}`} className="inline-flex items-center gap-1 text-[10px] font-mono text-muted-foreground/60 hover:text-primary mt-1">
                          View project <ExternalLink className="w-2.5 h-2.5" />
                        </Link>
                      </div>
                      <button
                        onClick={() => setRemoved(prev => new Set(prev).add(project.id))}
                        className="p-1 rounded text-muted-foreground/40 hover:text-red-400 transition-all flex-shrink-0"
                        title="Remove from comparison"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody className="font-mono text-xs">
              <TableRow>
                <RowLabel>Category</RowLabel>
                {visibleProjects.map(project => {
                  const category = project.category ?? "Other";
                  return (
                    <TableCell key={project.id} className="align-top pt-4">
                      <Badge variant="outline" className={cn("text-[9px] uppercase rounded-sm", CATEGORY_COLORS[category] ?? CATEGORY_COLORS.Other)}>
                        {category}
                      </Badge>
                    </TableCell>
                  );
                })}
              </TableRow>

              <TableRow>
                <RowLabel>Tier</RowLabel>
                {visibleProjects.map(project => (
                  <TableCell key={project.id} className="align-top pt-4">
                    <Badge variant="outline" className={cn("text-[10px] uppercase rounded-sm", TIER_COLORS[String(project.tier)] ?? "border-card-border")}>
                      T{project.tier}
                    </Badge>
                  </TableCell>
                ))}
              </TableRow>

              {hasBadges && (
                <TableRow>
                  <RowLabel>Badges</RowLabel>
                  {visibleProjects.map(project => {
                    const tags = parseProjectBadges((project as any).badges);
                    return (
                      <TableCell key={project.id} className="align-top pt-4">
                        {tags.length > 0 ? (
                          <ProjectBadgeList badges={tags} size="xs" />
                        ) : (
                          <span className="text-muted-foreground/40">—</span>
                        )}
                      </TableCell>
                    );
                  })}
                </TableRow>
              )}

              <TableRow>
                <RowLabel>Deadline</RowLabel>
                {visibleProjects.map(project => (
                  <TableCell key={project.id} className="align-top pt-4">
                    <DeadlineText deadline={project.deadline} />
                  </TableCell>
                ))}
              </TableRow>

              <TableRow>
                <RowLabel>Description</RowLabel>
                {visibleProjects.map(project => (
                  <TableCell key={project.id} className="align-top pt-4 max-w-[280px]">
                    <p className="text-muted-foreground whitespace-normal leading-relaxed">
                      {project.description || "No data provided."}
                    </p>
                  </TableCell>
                ))}
              </TableRow>

              <TableRow>
                <RowLabel>Est. Reward</RowLabel>
                {visibleProjects.map(project => (
                  <TableCell key={project.id} className="align-top pt-4 text-primary font-bold">
                    ${project.rewardEstimate?.toLocaleString() ?? "TBA"}
                  </TableCell>
                ))}
              </TableRow>

              <TableRow>
                <RowLabel>Funding</RowLabel>
                {visibleProjects.map(project => (
                  <TableCell key={project.id} className="align-top pt-4">
                    ${project.fundingAmount?.toLocaleString() ?? 0}
                  </TableCell>
                ))}
              </TableRow>

              {visibleProjects.some(p => p.xpPrice !== undefined) && (
                <TableRow>
                  <RowLabel>XP Price</RowLabel>
                  {visibleProjects.map(project => (
                    <TableCell key={project.id} className="align-top pt-4">
                      {project.xpPrice ?? "—"}
                    </TableCell>
                  ))}
                </TableRow>
              )}

              <TableRow>
                <RowLabel>Requirements</RowLabel>
                {visibleProjects.map(project => {
                  // tutorialSteps comes back as a JSON string (same shape project-detail.tsx parses).
                  let stepCount = 0;
                  try {
                    const raw = project.tutorialSteps;
                    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
                    if (Array.isArray(parsed)) stepCount = parsed.filter((s: any) => s && s.title).length;
                  } catch { /* malformed data — treat as no steps */ }
                  return (
                    <TableCell key={project.id} className="align-top pt-4">
                      {stepCount > 0 ? (
                        <span className="inline-flex items-center gap-1"><BookOpen className="w-3 h-3 text-muted-foreground/50" /> {stepCount} step{stepCount !== 1 ? "s" : ""}</span>
                      ) : project.tutorialLink ? (
                        <a href={project.tutorialLink} target="_blank" rel="noreferrer" className="text-primary hover:underline">Tutorial link</a>
                      ) : (
                        <span className="text-muted-foreground/40">—</span>
                      )}
                    </TableCell>
                  );
                })}
              </TableRow>

              <TableRow>
                <RowLabel>Entities Enrolled</RowLabel>
                {visibleProjects.map(project => (
                  <TableCell key={project.id} className="align-top pt-4">
                    <span className="inline-flex items-center gap-1">
                      <Users className="w-3 h-3 text-muted-foreground/50" />
                      {counts[project.id] ?? <Skeleton className="h-3 w-6 inline-block" />}
                    </span>
                  </TableCell>
                ))}
              </TableRow>
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
