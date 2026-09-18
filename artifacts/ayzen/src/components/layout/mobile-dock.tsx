import { Link, useLocation } from "wouter";
import { Home, FolderGit2, Store, Shield, Users } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/use-auth";

const DOCK_ITEMS = [
  { href: "/home",        icon: Home,       label: "Home",    authRequired: "/home" },
  { href: "/projects",    icon: FolderGit2, label: "Projects", authRequired: "/projects" },
  { href: "/marketplace", icon: Store,      label: "Market",  authRequired: "/marketplace" },
  { href: "/vault?tab=entity", icon: Shield, label: "Vault",  authRequired: "/vault" },
  { href: "/teams",       icon: Users,      label: "Teams",   authRequired: "/teams" },
] as const;

export function MobileDock() {
  const [location] = useLocation();
  const { user } = useAuth();

  const isActive = (href: string) => {
    const path = href.split("?")[0];
    return location === path || location.startsWith(path + "/");
  };

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-50 bg-sidebar/95 backdrop-blur-xl border-t border-sidebar-border safe-area-pb md:hidden">
      <div className="flex items-center justify-around px-2 py-2">
        {DOCK_ITEMS.map(item => {
          const Icon = item.icon;
          const active = isActive(item.href);
          // If not logged in, redirect to landing (root)
          const href = user ? item.href : "/";

          return (
            <Link key={item.href} href={href}>
              <button className="flex flex-col items-center gap-1 px-3 py-1.5 min-w-[56px] relative group">
                {active && (
                  <span className="absolute -top-2 left-1/2 -translate-x-1/2 w-8 h-0.5 rounded-full bg-primary" />
                )}
                <div className={cn(
                  "w-10 h-10 rounded-xl flex items-center justify-center transition-all duration-200",
                  active
                    ? "bg-primary/15 border border-primary/30 shadow-[0_0_12px_rgba(34,211,238,0.15)]"
                    : "bg-transparent group-hover:bg-sidebar-accent border border-transparent"
                )}>
                  <Icon className={cn(
                    "w-5 h-5 transition-colors",
                    active ? "text-primary" : "text-sidebar-foreground/50 group-hover:text-sidebar-foreground/80"
                  )} />
                </div>
                <span className={cn(
                  "text-[9px] font-mono font-bold tracking-wider transition-colors leading-none",
                  active ? "text-primary" : "text-sidebar-foreground/40"
                )}>
                  {item.label}
                </span>
              </button>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
