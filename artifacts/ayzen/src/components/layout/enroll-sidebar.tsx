/**
 * enroll-sidebar.tsx
 * ─────────────────────────────────────────────
 * Phase 9A — Enroll sidebar shell + Projects Overview
 *
 * Second, page-local sidebar for the new "Enroll" area — modeled directly
 * on components/layout/vault-sidebar.tsx (same nav-item/active-state/shell
 * pattern). Two sections:
 *
 *   Projects — Overview (8-9 stat widgets + pie/bar/heatmap charts, sourced
 *              from the Phase 4 activity_log via GET /projects/mine/overview)
 *              plus the Project list (reuses the existing enrolled-projects
 *              list logic from pages/user/project-entities.tsx). Both live
 *              on one page (pages/user/enroll-projects.tsx) toggled by tab.
 *   Entities — wired up in Phase 10; placeholder link until then.
 */
import { Link, useLocation } from "wouter";
import { FolderGit2, Users } from "lucide-react";
import { cn } from "@/lib/utils";

export interface EnrollSidebarItem {
  href: string;
  label: string;
  icon: React.ElementType;
  description: string;
}

export const ENROLL_SIDEBAR_ITEMS: EnrollSidebarItem[] = [
  { href: "/enroll/projects", label: "Projects", icon: FolderGit2, description: "Overview + enrolled project list" },
  { href: "/enroll/entities", label: "Entities",  icon: Users,      description: "Overview + enrolled entity list" },
];

export function EnrollSidebar() {
  const [location] = useLocation();
  return (
    <nav aria-label="Enroll sections" className="w-full sm:w-52 flex-shrink-0 space-y-1">
      {ENROLL_SIDEBAR_ITEMS.map(item => {
        const active = location === item.href;
        const Icon = item.icon;
        return (
          <Link key={item.href} href={item.href}>
            <div
              className={cn(
                "flex items-center gap-2.5 px-3 py-2.5 rounded-lg font-mono text-xs uppercase tracking-wider transition-all cursor-pointer border group",
                active
                  ? "bg-primary/10 text-primary border-primary/25 font-bold shadow-[inset_0_1px_0_rgba(34,211,238,0.1)]"
                  : "text-muted-foreground/60 border-transparent hover:bg-muted/20 hover:text-foreground hover:border-border/30"
              )}
            >
              <div className={cn(
                "w-6 h-6 rounded-md flex items-center justify-center flex-shrink-0 transition-all",
                active ? "bg-primary/20 border border-primary/30" : "bg-muted/30 border border-transparent group-hover:bg-muted/60 group-hover:border-border/30"
              )}>
                <Icon className={cn("w-3.5 h-3.5", active ? "text-primary" : "text-current")} />
              </div>
              <span className="truncate">{item.label}</span>
              {active && <span className="ml-auto w-1 h-1 rounded-full bg-primary flex-shrink-0" />}
            </div>
          </Link>
        );
      })}
    </nav>
  );
}

// Shared page shell for every Enroll-sidebar section — mirrors
// VaultSectionPage's header + sidebar/content split so the two page-local
// sidebars (Vault, Enroll) look and behave identically.
export function EnrollSectionPage({
  title, description, icon: Icon, children,
}: {
  title: string;
  description: string;
  icon: React.ElementType;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-5 page-enter">
      <div>
        <h1 className="text-2xl font-bold font-mono tracking-tighter uppercase flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center">
            <Icon className="w-4 h-4 text-primary" />
          </div>
          {title}
        </h1>
        <p className="text-muted-foreground font-mono text-xs mt-1 pl-0.5">{description}</p>
      </div>

      <div className="flex flex-col sm:flex-row gap-5 min-h-0">
        <EnrollSidebar />
        <div className="flex-1 min-w-0">{children}</div>
      </div>
    </div>
  );
}

// Generic static/empty state used by placeholder sections until their
// functionality is wired up in a later phase (Entities — Phase 10).
export function EnrollSectionEmptyState({
  icon: Icon, title, note,
}: {
  icon: React.ElementType;
  title: string;
  note: string;
}) {
  return (
    <div className="text-center py-20 space-y-3 border border-dashed border-border/40 rounded-xl">
      <div className="w-14 h-14 rounded-2xl bg-primary/5 border border-primary/10 flex items-center justify-center mx-auto">
        <Icon className="w-6 h-6 text-primary/40" />
      </div>
      <p className="font-mono text-sm text-muted-foreground/60">{title}</p>
      <p className="font-mono text-[10px] text-muted-foreground/40 max-w-xs mx-auto leading-relaxed">{note}</p>
    </div>
  );
}
