/**
 * subdomain-app.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Workspace — subdomain app scoping (master plan §2/§7 Phase 2:
 * "Split Sylo onto its own subdomain").
 *
 * This is intentionally NOT a separate build/deploy. It's the same SPA
 * bundle served from the same Express app (see app.ts) on every
 * `*.ayzen.tech` host — this file just makes that one bundle *behave*
 * like a single-purpose Sylo app when it detects it's running on Sylo's
 * hostname:
 *   - App.tsx redirects any route outside Sylo's scope back to its home.
 *   - app-sidebar.tsx hides nav groups/items outside Sylo's scope.
 *
 * On the main domain (ayzen.tech / workspace.ayzen.tech) or any
 * unrecognized host, `getCurrentSubdomainApp()` returns null and nothing
 * about the app's behavior changes — this is purely additive.
 *
 * Auth still works exactly as before either way: the AYZEN Account session
 * cookie (lib/session-cookie.ts on the backend) is already shared across
 * every `*.ayzen.tech` subdomain, so a user who's logged in on the main
 * domain is already logged in here too — that part needed zero frontend
 * change.
 *
 * Adding the next split (Ryft, Wisp, Verve, Skarn, Warde — Phase 3/4/8 per
 * the master plan, though in practice all landed the same way: existing
 * routes, just scoped) means adding one more entry to SUBDOMAIN_APPS
 * below. Nothing else in this file changes.
 */

export interface SubdomainApp {
  id: string;
  label: string;
  /** Where an in-scope user lands on "/" or when redirected out of an out-of-scope route. */
  homePath: string;
  /** Path prefixes considered "in scope" for this subdomain — checked with exact match or a "/" boundary, never a bare substring match. */
  routePrefixes: string[];
}

// Add one entry per app as it gets its own subdomain. Vault's routes already all
// live under /vault (user) and /admin/vault (admin) — see route-config.tsx
// — so Sylo needed no route renaming to gain a scope here.
//
// Phase 3 (this pass): Ryft, Wisp, Verve added the same way — each app's
// routes already lived under one or two existing prefixes in
// route-config.tsx, so like Sylo, no page had to move or get renamed.
//
// Skarn added the same pass, once it was confirmed (not assumed) that it
// already exists as a product surface under a different label: the
// "Protocols" nav group in app-sidebar.tsx (USER_NAV/ADMIN_NAV — comment
// there literally says "Protocols restructure") IS Skarn — airdrop
// project tracking, per-project tasks, operator progress. Nothing to
// build, just scope it: /projects (+ every ?rollup=/?type= filter variant
// the Category sub-tree uses — hasPrefix's "?" boundary check covers
// those for free), /tasks and /content (both live inside the Protocols
// group itself, see app-sidebar.tsx), plus the admin mirror
// (/admin/projects, /admin/project-templates, /admin/operator-progress,
// /admin/tasks — same four entries as ADMIN_NAV's own "Protocols" group).
// Deliberately NOT included, despite being airdrop-farming-adjacent:
// /teams ("Team" nav group — farming teams, but organizationally its own
// top-level group, not nested under Protocols), /leaderboard (lives in
// the "Social" group), /earn (its own "Earn" group), /enroll/* (its own
// "Enroll" group). Ask before folding any of those in — this pass only
// claims what the user pointed at as "Protocols."
//
// Zynth — added once a real user-facing route existed to scope it to (see
// CHANGES_ZYNTH_SUBDOMAIN_SPLIT.md). pages/user/assistant.tsx docks the
// same <AiChat/> that was previously only reachable as a floating widget;
// seed-oidc-clients.ts already had its OIDC client registered and waiting.
const SUBDOMAIN_APPS: Record<string, Omit<SubdomainApp, "id">> = {
  sylo: {
    label: "Sylo",
    homePath: "/vault",
    routePrefixes: ["/vault", "/admin/vault", "/admin/team-vault"],
  },
  ryft: {
    label: "Ryft",
    // Wallet + finance/ledger + Investments (master plan §2: Investment
    // stays inside Ryft as a nav tab, not its own brand) — home is the
    // wallet hub, the same landing pattern Sylo uses (/vault, not a
    // sub-page). /credits and /subscription are deliberately excluded:
    // those are Workspace-wide (AYZEN Credits pool, §5), not Ryft-scoped.
    homePath: "/wallet",
    routePrefixes: ["/wallet", "/wallets", "/finance", "/admin/tools/wallet"],
  },
  wisp: {
    label: "Wisp",
    // /mailbox is the native mail client UI (CHANGES_NATIVE_MAILBOX.md);
    // /ayzen-email is the account-setup/status page, kept in-scope since a
    // Wisp visitor still needs it before a mailbox exists.
    homePath: "/mailbox",
    routePrefixes: ["/mailbox", "/ayzen-email", "/email-accounts", "/admin/mail-sending-config"],
  },
  verve: {
    label: "Verve",
    homePath: "/marketplace/hub",
    routePrefixes: [
      "/marketplace",
      "/admin/marketplace",
      "/admin/marketplace-categories",
      "/admin/marketplace-market-config",
    ],
  },
  skarn: {
    label: "Skarn",
    homePath: "/projects",
    routePrefixes: [
      "/projects",
      "/tasks",
      "/content",
      "/admin/projects",
      "/admin/project-templates",
      "/admin/operator-progress",
      "/admin/tasks",
    ],
  },
  zynth: {
    label: "Zynth",
    homePath: "/assistant",
    routePrefixes: ["/assistant", "/admin/ai-agent"],
  },
  warde: {
    label: "Warde",
    // The "Team" nav group (USER_NAV/MODERATOR_NAV/TEAM_LEADER_NAV — same
    // shape in all three, ADMIN_NAV's own "Team" group mirrors it) is
    // farming-team management: members, chat, browse/invite, task &
    // mission progress, team leaderboard/projects rollup, team vault,
    // team settings — every one of those is a `/teams?tab=...` variant of
    // the single route, so one prefix covers all of it (same "?" boundary
    // hasPrefix() already relies on for Ryft's finance filters and
    // Skarn's project rollups). /team_leader is included too — the
    // Sidebar Builder's team-leader-role custom-page route
    // (`/team_leader/custom/:slug`), the team-leader equivalent of
    // Skarn/admin's own custom-page routes.
    homePath: "/teams",
    routePrefixes: ["/teams", "/team_leader", "/admin/teams", "/admin/team-vault"],
  },
};

// Pages that make sense to reach from ANY subdomain regardless of scope —
// auth, the public status page, and every public/unauthenticated token-link
// page (emergency access, receipts). None of these go through the
// ProtectedRoute scope guard anyway (see App.tsx), but isPathInSubdomainScope
// is kept accurate for anything that calls it directly in the future.
const ALWAYS_ALLOWED_PREFIXES = [
  "/login", "/register", "/forgot-password", "/status",
  "/emergency-access", "/finance/receipt", "/finance/invoice",
  "/finance/payment-agreement", "/receipt",
  // OIDC Roadmap — Season 3, Phase 5b-b: the callback route has to render
  // regardless of which subdomain app is scoped (or whether one is scoped
  // at all) — it's what ESTABLISHES the session App.tsx's ProtectedRoute
  // guard checks, so it can't itself require a resolved app/session first.
  "/oidc/callback",
];

function hasPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(prefix + "/") || path.startsWith(prefix + "?");
}

/**
 * Detects which AYZEN sub-app (if any) the current hostname is scoped to.
 * Matches:
 *  - configured production hostnames (VITE_<APP>_HOSTS, each with a matching
 *    `<app>.ayzen.tech` default) — exact match.
 *  - dev/preview convenience: any hostname whose FIRST label equals a known
 *    app id, e.g. "sylo.localhost" or a "sylo-<replit-preview>" domain —
 *    so this is testable before ayzen.tech DNS/subdomains exist for real.
 * Returns null on the main domain or any unrecognized host.
 */
export function getCurrentSubdomainApp(): SubdomainApp | null {
  if (typeof window === "undefined") return null;
  const host = window.location.hostname;

  for (const [id, app] of Object.entries(SUBDOMAIN_APPS)) {
    const configuredHosts = ((import.meta.env[`VITE_${id.toUpperCase()}_HOSTS`] as string | undefined) ?? `${id}.ayzen.tech`)
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean);
    if (configuredHosts.includes(host.toLowerCase())) return { id, ...app };
  }

  const firstLabel = host.split(".")[0];
  const app = SUBDOMAIN_APPS[firstLabel];
  return app ? { id: firstLabel, ...app } : null;
}

/** True when `path` is in-scope for the given subdomain app, or is one of the always-reachable public/auth pages. */
export function isPathInSubdomainScope(path: string, app: SubdomainApp): boolean {
  if (ALWAYS_ALLOWED_PREFIXES.some((p) => hasPrefix(path, p))) return true;
  return app.routePrefixes.some((p) => hasPrefix(path, p));
}
