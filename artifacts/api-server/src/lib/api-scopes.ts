/**
 * lib/api-scopes.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Drop this at: artifacts/api-server/src/lib/api-scopes.ts
 *
 * Feature-scope taxonomy for "scoped" API keys (routes/api-keys.ts). A scoped
 * key can only call routes whose path starts with one of its granted scopes'
 * `prefixes`. Enforced centrally in middlewares/api-key-scope.ts — no
 * per-route changes needed elsewhere, same pattern as auth-utils.ts.
 *
 * DEFAULT-DENY: any path that doesn't match a defined scope (e.g. every
 * `/admin/*` route, `/key-manager`, `/dev-panel`, `/shell`, `/security`) is
 * blocked for scoped keys automatically — you only ever ADD access by adding
 * a prefix here, you never need to remember to exclude something dangerous.
 * "Full" keys and real login sessions are never affected by this file.
 *
 * To add a new scope or extend an existing one, just edit SCOPE_DEFINITIONS
 * below — nothing else needs to change.
 */

export interface ScopeDefinition {
  id: string;
  label: string;
  /** Path prefixes (relative to /api, e.g. "/tasks") this scope grants access to. */
  prefixes: string[];
}

export const SCOPE_DEFINITIONS: ScopeDefinition[] = [
  { id: "tasks", label: "Tasks & earn (ad-tasks, check-in, earn/reward links)", prefixes: ["/tasks", "/ad-tasks", "/checkin", "/earn-links", "/reward-links"] },
  { id: "wallets", label: "Wallets & networks", prefixes: ["/wallets", "/networks"] },
  { id: "vault", label: "Vault", prefixes: ["/vault"] },
  { id: "marketplace", label: "Marketplace (buy/sell, cart, offers, reviews)", prefixes: ["/marketplace"] },
  { id: "payments", label: "Subscriptions, plans, payments, credits", prefixes: ["/subscription", "/plans", "/payments", "/credits"] },
  { id: "projects", label: "Projects", prefixes: ["/projects"] },
  { id: "entities", label: "Entities", prefixes: ["/entities"] },
  { id: "notifications", label: "Notifications", prefixes: ["/notifications"] },
  { id: "messages", label: "Messages", prefixes: ["/messages"] },
  { id: "referrals", label: "Referrals", prefixes: ["/referrals"] },
  { id: "leaderboard", label: "Leaderboard", prefixes: ["/leaderboard"] },
  { id: "watchlist", label: "Watchlist", prefixes: ["/watchlist"] },
  { id: "content", label: "Content, categories & search", prefixes: ["/content", "/categories", "/category-templates", "/search"] },
  { id: "support", label: "Support tickets", prefixes: ["/support"] },
  { id: "telegram", label: "Telegram integration", prefixes: ["/telegram"] },
  { id: "email", label: "Email (AYZEN mail & connected accounts)", prefixes: ["/email", "/email-accounts", "/ayzen-email", "/ayzen-mail"] },
  { id: "ai", label: "AI assistant", prefixes: ["/ai"] },
  { id: "profile", label: "Profile, account settings & 2FA", prefixes: ["/profile", "/users", "/two-factor", "/settings"] },
  { id: "polymarket", label: "Polymarket", prefixes: ["/polymarket"] },
  { id: "local-accounts", label: "Local accounts", prefixes: ["/local-accounts"] },
  { id: "tools", label: "Tools & CSV import/export", prefixes: ["/tools", "/csv"] },
  { id: "nft", label: "NFT subscriptions", prefixes: ["/nft-subscriptions"] },
  { id: "teams", label: "Teams", prefixes: ["/teams"] },
];

export const ALL_SCOPE_IDS = SCOPE_DEFINITIONS.map((s) => s.id);
const SCOPE_BY_ID = new Map(SCOPE_DEFINITIONS.map((s) => [s.id, s]));

export function isValidScope(id: string): boolean {
  return SCOPE_BY_ID.has(id);
}

/** Returns the scope id covering this request path, or null if no scope covers it (default-deny for scoped keys). */
export function resolveScopeForPath(path: string): string | null {
  for (const scope of SCOPE_DEFINITIONS) {
    for (const prefix of scope.prefixes) {
      if (path === prefix || path.startsWith(prefix + "/")) return scope.id;
    }
  }
  return null;
}
