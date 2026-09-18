/**
 * vault-sidebar.tsx
 * ─────────────────────────────────────────────
 * Vault section sidebar — 4-step numbered hierarchy. Mostly flat, except
 * Wallet Hub (Step 02 — Access) which expands into its three addressable
 * views (Overview / Wallet / Settings — see vault-wallet-hub.tsx).
 *
 *   STEP 01 — ACCOUNT    : Entity · Local · KYC · Game
 *   STEP 02 — ACCESS     : 2FA · Backup Code · Mail Hub · Wallet Hub ▸
 *                            ▸ Overview · Wallet · Settings
 *   STEP 03 — ENROLLMENT : Overview · Enroll · Linked · Project
 *   STEP 04 — OTHER      : Shared · Banned · Activity Log · Security
 *
 * 2FA / Backup Code are single sidebar links (into /vault/2fa/overview and
 * /vault/backup/overview) — Overview/Entity/Local/KYC/Game live as an
 * IN-PAGE tab bar on those pages (see CategoryTabBar in vault-2fa-category
 * .tsx / vault-backup.tsx), not as nested sidebar items, so switching
 * category never reads as "leaving" the 2FA/Backup Code sidebar page.
 *
 * Mobile: collapses into a horizontal scrollable pill-nav (Wallet Hub's
 * children are flattened into individual pills — there's no room for an
 * expand/collapse affordance in a one-row scroller).
 * Desktop (sm+): vertical sidebar list with step numbers; Wallet Hub is a
 * collapsible sub-group that auto-opens when the active route is one of
 * its children, so the highlighted item is never hidden behind a collapse.
 */
import { useEffect, useState } from "react";
import { Link, useLocation, useSearch } from "wouter";
import {
  Wallet, ShieldCheck, Mail, BookKey,
  LayoutDashboard, FolderGit2, Link2,
  Share2, Ban, Lock, Shield, Settings,
  IdCard, History, ChevronDown, ChevronRight,
  UserPlus, Smartphone, Gamepad2, Trash2,
  DatabaseBackup, ArrowLeftRight, FileBarChart, HeartPulse,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface FlatItem { href: string; label: string; icon: React.ElementType }
interface ExpandableItem { label: string; icon: React.ElementType; children: readonly FlatItem[] }
type StepItem = FlatItem | ExpandableItem;

function isExpandable(item: StepItem): item is ExpandableItem {
  return (item as ExpandableItem).children !== undefined;
}

// ── STEP 01 — ACCOUNT ─────────────────────────────────────────────────────────
const ACCOUNT_ITEMS: readonly StepItem[] = [
  { href: "/vault?tab=entity",  label: "Entity",  icon: Shield },
  { href: "/vault?tab=local",   label: "Local",   icon: Smartphone },
  { href: "/vault?tab=kyc",     label: "KYC",     icon: ShieldCheck },
  { href: "/vault?tab=game",    label: "Game",    icon: Gamepad2 },
] as const;

// ── STEP 02 — ACCESS ──────────────────────────────────────────────────────────
// Wallet Hub — Overview (active-wallet switcher) / Wallet (per-entity address
// & seed list) / Settings (wallet-related config, synced from Vault) — three
// addressable views under /vault/wallet-hub/:subtab (see vault-wallet-hub.tsx
// and VaultWalletSeedContent).
const ACCESS_ITEMS: readonly StepItem[] = [
  { href: "/vault/2fa/overview",    label: "2FA",         icon: ShieldCheck },
  { href: "/vault/backup/overview", label: "Backup Code", icon: BookKey },
  { href: "/vault/mail-hub/entity", label: "Mail Hub",    icon: Mail },
  {
    label: "Wallet Hub", icon: Wallet,
    children: [
      { href: "/vault/wallet-hub/overview", label: "Overview", icon: LayoutDashboard },
      { href: "/vault/wallet-hub/wallet",   label: "Wallet",   icon: Wallet },
      { href: "/vault/wallet-hub/settings", label: "Settings", icon: Settings },
    ],
  },
] as const;

// ── STEP 03 — ENROLLMENT ──────────────────────────────────────────────────────
const ENROLL_ITEMS: readonly StepItem[] = [
  { href: "/vault/enrollment/overview", label: "Overview", icon: LayoutDashboard },
  { href: "/vault/projects",            label: "Enroll",   icon: UserPlus },
  { href: "/vault/enrollment/linked",   label: "Linked",   icon: Link2 },
  { href: "/vault/enrollment/project",  label: "Project",  icon: FolderGit2 },
] as const;

// ── STEP 04 — OTHER ───────────────────────────────────────────────────────────
const OTHER_ITEMS: readonly StepItem[] = [
  { href: "/vault/shared",   label: "Shared",       icon: Share2 },
  { href: "/vault/banned",   label: "Banned",       icon: Ban },
  { href: "/vault/trash",    label: "Trash",        icon: Trash2 },
  { href: "/vault/activity", label: "Activity Log", icon: History },
  { href: "/vault/security", label: "Security",     icon: Lock },
  {
    label: "Data & Recovery", icon: DatabaseBackup,
    children: [
      { href: "/vault/migration",        label: "Import/Export",    icon: ArrowLeftRight },
      { href: "/vault/snapshot",         label: "Snapshot Backup",  icon: DatabaseBackup },
      { href: "/vault/compliance",       label: "Compliance Report", icon: FileBarChart },
      { href: "/vault/emergency-access", label: "Emergency Access", icon: HeartPulse },
    ],
  },
] as const;

// ── ALL_ITEMS — flat list for mobile scroll nav (children flattened out) ──────
const ALL_ITEMS: readonly FlatItem[] = [
  ...ACCOUNT_ITEMS, ...ACCESS_ITEMS, ...ENROLL_ITEMS, ...OTHER_ITEMS,
].flatMap(item => (isExpandable(item) ? item.children : [item]));

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildFullLocation(pathname: string, search: string): string {
  if (!search) return pathname;
  return `${pathname}${search.startsWith("?") ? search : `?${search}`}`;
}

function matchHref(href: string, fullLocation: string): boolean {
  if (href === fullLocation) return true;
  // 2FA / Backup Code are single sidebar links into their Overview page, but
  // category-switching happens via an in-page tab bar that rewrites the path
  // to /vault/2fa/<category> or /vault/backup/<category> — keep the sidebar
  // link highlighted across all of those, not just the literal overview path.
  if (href === "/vault/2fa/overview" || href === "/vault/backup/overview") {
    const base = href.replace("/overview", "");
    return fullLocation === base || fullLocation.startsWith(`${base}/`);
  }
  if (href.includes("?")) {
    const [hPath, hQuery] = href.split("?");
    const [lPath, lQuery] = fullLocation.split("?");
    if (hPath !== lPath) return false;
    const hp = new URLSearchParams(hQuery);
    const lp = new URLSearchParams(lQuery ?? "");
    for (const [k, v] of hp.entries()) {
      if (lp.get(k) !== v) return false;
    }
    return true;
  }
  return fullLocation === href || fullLocation.startsWith(`${href}?`) || fullLocation.startsWith(`${href}/`);
}

// ── Individual sidebar item ───────────────────────────────────────────────────

function SidebarItem({
  href, label, icon: Icon, active,
}: {
  href: string; label: string; icon: React.ElementType; active: boolean;
}) {
  return (
    <Link href={href}>
      <div
        className={cn(
          "flex items-center gap-2.5 px-3 py-2 rounded-lg font-mono text-xs uppercase tracking-wider transition-all cursor-pointer border group",
          active
            ? "bg-primary/10 text-primary border-primary/25 font-bold"
            : "text-muted-foreground/60 border-transparent hover:bg-muted/20 hover:text-foreground hover:border-border/30"
        )}
      >
        <div
          className={cn(
            "w-5 h-5 rounded-md flex items-center justify-center flex-shrink-0 transition-all",
            active
              ? "bg-primary/20 border border-primary/30"
              : "bg-muted/30 border border-transparent group-hover:bg-muted/60 group-hover:border-border/30"
          )}
        >
          <Icon className={cn("w-3 h-3", active ? "text-primary" : "text-current")} />
        </div>
        <span className="truncate">{label}</span>
      </div>
    </Link>
  );
}

// ── Numbered step group ───────────────────────────────────────────────────────

function StepGroup({
  step, label, items, location,
}: {
  step: string;
  label: string;
  items: readonly StepItem[];
  location: string;
}) {
  return (
    <div className="space-y-0.5">
      {/* Step header */}
      <div className="flex items-center gap-1.5 px-2 pb-1">
        <span className="font-mono text-[8px] font-bold text-primary/40 tabular-nums">{step}</span>
        <div className="flex-1 h-px bg-border/20" />
        <span className="font-mono text-[8px] uppercase tracking-widest text-muted-foreground/35">{label}</span>
      </div>
      {/* Items */}
      {items.map(item =>
        isExpandable(item) ? (
          <SidebarSection key={item.label} section={item} location={location} />
        ) : (
          <SidebarItem
            key={item.href}
            {...item}
            active={matchHref(item.href, location)}
          />
        )
      )}
    </div>
  );
}

// ── Expandable sub-group (currently just Wallet Hub) ──────────────────────────
// Auto-opens whenever the active route is one of its children, so navigating
// straight to /vault/wallet-hub/settings (bookmark, deep link, etc.) never
// leaves the active item hidden behind a collapsed parent.
function SidebarSection({
  section, location,
}: {
  section: ExpandableItem;
  location: string;
}) {
  const Icon = section.icon;
  const childActive = section.children.some(c => matchHref(c.href, location));
  const [open, setOpen] = useState(childActive);

  useEffect(() => {
    if (childActive) setOpen(true);
  }, [childActive]);

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className={cn(
          "w-full flex items-center gap-2.5 px-3 py-2 rounded-lg font-mono text-xs uppercase tracking-wider transition-all cursor-pointer border group",
          childActive
            ? "bg-primary/10 text-primary border-primary/25 font-bold"
            : "text-muted-foreground/60 border-transparent hover:bg-muted/20 hover:text-foreground hover:border-border/30"
        )}
      >
        <div
          className={cn(
            "w-5 h-5 rounded-md flex items-center justify-center flex-shrink-0 transition-all",
            childActive
              ? "bg-primary/20 border border-primary/30"
              : "bg-muted/30 border border-transparent group-hover:bg-muted/60 group-hover:border-border/30"
          )}
        >
          <Icon className={cn("w-3 h-3", childActive ? "text-primary" : "text-current")} />
        </div>
        <span className="flex-1 text-left truncate">{section.label}</span>
        {open ? <ChevronDown className="w-3 h-3 flex-shrink-0" /> : <ChevronRight className="w-3 h-3 flex-shrink-0" />}
      </button>
      {open && (
        <div className="mt-0.5 ml-3 pl-2 border-l border-border/20 space-y-0.5">
          {section.children.map(child => (
            <SidebarItem
              key={child.href}
              {...child}
              active={matchHref(child.href, location)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Mobile horizontal scrollable nav ─────────────────────────────────────────
function MobileNav({ location }: { location: string }) {
  return (
    <div className="flex gap-1.5 overflow-x-auto pb-1 scrollbar-none -mx-0.5 px-0.5">
      {ALL_ITEMS.map(item => {
        const active = matchHref(item.href, location);
        const Icon = item.icon;
        return (
          <Link key={item.href} href={item.href}>
            <div
              className={cn(
                "flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg font-mono text-[10px] uppercase tracking-wider border flex-shrink-0 cursor-pointer transition-all",
                active
                  ? "bg-primary/10 text-primary border-primary/30 font-bold"
                  : "text-muted-foreground/60 border-border/20 hover:bg-muted/20 hover:text-foreground bg-card"
              )}
            >
              <Icon className="w-3 h-3" />
              {item.label}
            </div>
          </Link>
        );
      })}
    </div>
  );
}

export function VaultSidebar() {
  const [pathname] = useLocation();
  const search = useSearch();
  const location = buildFullLocation(pathname, search);

  return (
    <>
      {/* Mobile: horizontal scroll nav */}
      <nav aria-label="Vault sections" className="sm:hidden">
        <MobileNav location={location} />
      </nav>

      {/* Desktop: vertical stepped sidebar */}
      <nav aria-label="Vault sections" className="hidden sm:flex flex-col gap-3 w-48 flex-shrink-0">
        <StepGroup step="01" label="Account"    items={ACCOUNT_ITEMS} location={location} />
        <StepGroup step="02" label="Access"     items={ACCESS_ITEMS}  location={location} />
        <StepGroup step="03" label="Enrollment" items={ENROLL_ITEMS}  location={location} />
        <StepGroup step="04" label="Other"      items={OTHER_ITEMS}   location={location} />
      </nav>
    </>
  );
}

// ─── Shared page shell ────────────────────────────────────────────────────────
export function VaultSectionPage({
  title, description, icon: Icon, children, headerExtra,
}: {
  title: string;
  description: string;
  icon: React.ElementType;
  children: React.ReactNode;
  headerExtra?: React.ReactNode;
}) {
  return (
    <div className="space-y-5 page-enter">
      <div>
        <div className="flex items-start justify-between gap-2 flex-wrap">
          <h1 className="text-2xl font-bold font-mono tracking-tighter uppercase flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center">
              <Icon className="w-4 h-4 text-primary" />
            </div>
            {title}
          </h1>
          {headerExtra && <div className="flex-shrink-0 mt-1">{headerExtra}</div>}
        </div>
        <p className="text-muted-foreground font-mono text-xs mt-1 pl-0.5">{description}</p>
      </div>

      <div className="flex flex-col sm:flex-row gap-5 min-h-0">
        <VaultSidebar />
        <div className="flex-1 min-w-0">{children}</div>
      </div>
    </div>
  );
}

// Generic empty state used by pages that haven't loaded real data yet.
export function VaultSectionEmptyState({
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

// ─── In-page category tab bar ──────────────────────────────────────────────────
// Used by vault-2fa-category.tsx and vault-backup.tsx to switch between
// Overview/Entity/Local/KYC/Game WITHOUT that switch reading as leaving the
// "2FA" / "Backup Code" sidebar page — the sidebar link stays a single flat
// item pointing at .../overview, and this tab bar rewrites just the trailing
// category segment client-side (client nav via wouter Link, not a sidebar
// item), so the surrounding page/sidebar context never changes.
export interface CategoryTab { id: string; label: string; icon: React.ElementType }

export function CategoryTabBar({
  basePath, active, tabs,
}: {
  basePath: string;
  active: string;
  tabs: readonly CategoryTab[];
}) {
  return (
    <div className="flex gap-1.5 flex-wrap border-b border-border/20 pb-3">
      {tabs.map(tab => {
        const Icon = tab.icon;
        const isActive = tab.id === active;
        return (
          <Link key={tab.id} href={`${basePath}/${tab.id}`}>
            <div
              className={cn(
                "flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-mono text-[11px] uppercase tracking-wider border cursor-pointer transition-all",
                isActive
                  ? "bg-primary/10 text-primary border-primary/25 font-bold"
                  : "text-muted-foreground/60 border-transparent hover:bg-muted/20 hover:text-foreground hover:border-border/30"
              )}
            >
              <Icon className="w-3.5 h-3.5" />
              {tab.label}
            </div>
          </Link>
        );
      })}
    </div>
  );
}
