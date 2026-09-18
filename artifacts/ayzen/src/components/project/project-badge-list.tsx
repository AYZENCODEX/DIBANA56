// Phase 7B — Project badge/tag system: consumer rendering.
//
// Phase 7A persisted `project.badges` server-side as a JSON-stringified
// array (same string-or-array-in, JSON-string-out convention as
// tutorialSteps — see api-server/src/routes/projects.ts). Every consumer
// that reads it back needs the same defensive parse admin/project-detail.tsx
// already uses for its edit form. This file is the single shared place for
// that parse + the actual rendering, so projects.tsx (cards), project-detail.tsx
// (header), and project-compare.tsx (compare row) stay in sync instead of
// growing three slightly-different implementations.

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * Normalize a raw `project.badges` value into a clean string[].
 * Accepts the JSON-string-from-API shape, an already-parsed array (e.g. a
 * component mid-edit before save), or null/undefined — anything malformed
 * quietly resolves to [] rather than throwing.
 */
export function parseProjectBadges(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.filter((b): b is string => typeof b === "string" && b.trim().length > 0);
  }
  if (typeof raw === "string" && raw.trim().length > 0) {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed)
        ? parsed.filter((b): b is string => typeof b === "string" && b.trim().length > 0)
        : [];
    } catch {
      return [];
    }
  }
  return [];
}

interface ProjectBadgeListProps {
  /** Raw `project.badges` field — string (JSON), string[], or null/undefined. */
  badges: unknown;
  className?: string;
  /** Size variant — "sm" for dense contexts (cards, header), "xs" for tight table rows. */
  size?: "sm" | "xs";
}

/**
 * Renders a project's badges/tags as a row of pills. Renders nothing at all
 * (not even an empty container) when there are no badges, so callers never
 * need their own empty-state branching — required by the 7B acceptance
 * criteria that a zero-badge project shows cleanly with no broken layout.
 */
export function ProjectBadgeList({ badges, className, size = "sm" }: ProjectBadgeListProps) {
  const tags = parseProjectBadges(badges);
  if (tags.length === 0) return null;

  return (
    <div className={cn("flex flex-wrap items-center gap-1", className)}>
      {tags.map(tag => (
        <Badge
          key={tag}
          variant="outline"
          className={cn(
            "font-mono uppercase rounded-sm border-primary/25 text-primary/80 bg-primary/5",
            size === "xs" ? "text-[9px]" : "text-[9px] sm:text-[10px]"
          )}
        >
          {tag}
        </Badge>
      ))}
    </div>
  );
}
