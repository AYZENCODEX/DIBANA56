/**
 * route-config.tsx
 * ─────────────────────────────────────────────
 * Single source of truth for ALL authenticated routes.
 * Adding a new page = one object here, nothing else.
 *
 * Drop this file at:
 *   artifacts/ayzen/src/lib/route-config.tsx
 */

import { lazy } from "react";
import type { LazyExoticComponent, ComponentType } from "react";

// ─── Types ────────────────────────────────────────────────────────────────────

export type AnyComponent = LazyExoticComponent<ComponentType<any>>;

export interface RouteConfig {
  path: string;
  component: AnyComponent;
  /** adminOnly=true  →  only 'admin' | 'dev' roles pass */
  adminOnly?: boolean;
  /** allowedRoles overrides adminOnly when present */
  allowedRoles?: string[];
}

// ─── Admin lazy imports ───────────────────────────────────────────────────────

const AdminDashboard     = lazy(() => import("@/pages/admin/dashboard"));
const AdminUsers         = lazy(() => import("@/pages/admin/users"));
const AdminProjects      = lazy(() => import("@/pages/admin/projects"));
const AdminProjectTemplates = lazy(() => import("@/pages/admin/project-templates"));
const AdminProjectDetail = lazy(() => import("@/pages/admin/project-detail"));
const AdminTasks         = lazy(() => import("@/pages/admin/tasks"));
const AdminGas           = lazy(() => import("@/pages/admin/tools/gas"));
const AdminWallet        = lazy(() => import("@/pages/admin/tools/wallet"));
const AdminRevenue       = lazy(() => import("@/pages/admin/revenue"));
const AdminStreak        = lazy(() => import("@/pages/admin/tools/streak"));
const AdminNetworks      = lazy(() => import("@/pages/admin/tools/networks"));
const AdminBroadcast     = lazy(() => import("@/pages/admin/broadcast"));
const AdminLeaderboard   = lazy(() => import("@/pages/admin/leaderboard"));
const AdminVault         = lazy(() => import("@/pages/admin/vault"));
const AdminPlugins       = lazy(() => import("@/pages/admin/plugins"));
const AdminSettings      = lazy(() => import("@/pages/admin/settings"));
const AdminDeveloper     = lazy(() => import("@/pages/admin/developer"));
const AdminSupport       = lazy(() => import("@/pages/admin/support"));
const AdminKyc           = lazy(() => import("@/pages/admin/kyc"));
const AdminEmergencyAccess = lazy(() => import("@/pages/admin/emergency-access"));
const AdminReferrals     = lazy(() => import("@/pages/admin/referrals"));
const AdminCreditsPage   = lazy(() => import("@/pages/admin/credits"));
const AdminSubscriptions = lazy(() => import("@/pages/admin/subscriptions"));
const AdminActivity      = lazy(() => import("@/pages/admin/activity"));
const AdminCategories    = lazy(() => import("@/pages/admin/categories"));
const AdminHealthRules   = lazy(() => import("@/pages/admin/health-rules"));
const AdminMailSendingConfig = lazy(() => import("@/pages/admin/mail-sending-config"));
const AdminTeams         = lazy(() => import("@/pages/admin/teams"));
const AdminTeamVault     = lazy(() => import("@/pages/admin/team-vault"));
const AdminMarketplace   = lazy(() => import("@/pages/admin/marketplace"));
const AdminAiAgent       = lazy(() => import("@/pages/admin/ai-agent"));
const Assistant           = lazy(() => import("@/pages/user/assistant"));
const AdminMcpAgents     = lazy(() => import("@/pages/admin/mcp-agents"));
const AdminKeyManager    = lazy(() => import("@/pages/admin/key-manager"));
const AdminDevNavBuilder = lazy(() => import("@/pages/admin/dev-nav-builder"));
const AdminMarketplaceCategories = lazy(() => import("@/pages/admin/marketplace-categories"));
const AdminMarketplaceMarketConfig = lazy(() => import("@/pages/admin/marketplace-market-config"));
const AdminConfigManager = lazy(() => import("@/pages/admin/config-manager"));
const AdminLayoutBuilder = lazy(() => import("@/pages/admin/layout-builder"));
const AdminThemeStudio   = lazy(() => import("@/pages/admin/theme-studio"));
const AdminCustomButtons = lazy(() => import("@/pages/admin/custom-buttons"));
const AdminOperatorProgress = lazy(() => import("@/pages/admin/operator-progress"));
const AdminMegaEngine    = lazy(() => import("@/pages/admin/mega-engine"));
const AdminMegaEngineObservability = lazy(() => import("@/pages/admin/mega-engine-observability"));

// ─── Dev lazy imports ────────────────────────────────────────────────────────

const DevAznDeploy = lazy(() => import("@/pages/dev/azn-deploy"));
const DevCustomPage = lazy(() => import("@/pages/dev/custom-page"));
// Same blank-page component, one navType-scoped wrapper each — see
// Sidebar Builder tabs (User/Admin/Moderator/Team Leader), mirrors Dev's.
const UserCustomPage = lazy(() => import("@/pages/user/custom-page"));
const AdminNavCustomPage = lazy(() => import("@/pages/admin/custom-page"));
const ModeratorCustomPage = lazy(() => import("@/pages/moderator/custom-page"));
const TeamLeaderCustomPage = lazy(() => import("@/pages/team-leader/custom-page"));

// ─── User lazy imports ────────────────────────────────────────────────────────

const UserHome          = lazy(() => import("@/pages/user/home"));
const UserDashboard     = lazy(() => import("@/pages/user/dashboard"));
const UserProjects      = lazy(() => import("@/pages/user/projects"));
const AirdropCalendar   = lazy(() => import("@/pages/user/airdrop-calendar"));
const UserProjectCompare = lazy(() => import("@/pages/user/project-compare"));
const UserProjectDetail = lazy(() => import("@/pages/user/project-detail"));
const UserProjectEntities = lazy(() => import("@/pages/user/project-entities"));
const UserTasks         = lazy(() => import("@/pages/user/tasks"));
const UserDeveloper     = lazy(() => import("@/pages/user/developer"));
const UserVault         = lazy(() => import("@/pages/user/vault"));
const VaultHub          = lazy(() => import("@/pages/user/vault-hub"));
const VaultEntityDetail = lazy(() => import("@/pages/user/vault-entity-detail"));
const VaultEntityAccess = lazy(() => import("@/pages/user/vault-entity-access"));
const VaultLocalDetail  = lazy(() => import("@/pages/user/vault-local-detail"));
const VaultKycDetail    = lazy(() => import("@/pages/user/vault-kyc-detail"));
const VaultKycDataOverview = lazy(() => import("@/pages/user/vault-kyc-data-overview"));
const VaultKycDataUsed     = lazy(() => import("@/pages/user/vault-kyc-data-used"));
const VaultKycDataUnused   = lazy(() => import("@/pages/user/vault-kyc-data-unused"));
const VaultKycDataDetail   = lazy(() => import("@/pages/user/vault-kyc-data-detail"));
const VaultKycEnrolled     = lazy(() => import("@/pages/user/vault-kyc-enrolled"));
const VaultMailInbox    = lazy(() => import("@/pages/user/vault-mail-inbox"));
const VaultMailMessage  = lazy(() => import("@/pages/user/vault-mail-message"));
const VaultTwoFaCategory     = lazy(() => import("@/pages/user/vault-2fa-category"));
const VaultTwoFaEntity       = lazy(() => import("@/pages/user/vault-2fa-entity"));
const VaultMailCategory      = lazy(() => import("@/pages/user/vault-mail-category"));
const VaultMailEntity        = lazy(() => import("@/pages/user/vault-mail-entity"));
const VaultMailMessageDetail = lazy(() => import("@/pages/user/vault-mail-message-detail"));
// Phase 4 — Vault Sidebar Restructure (Enroll / Security / Backup / Shared)
const VaultWalletHub                = lazy(() => import("@/pages/user/vault-wallet-hub"));
const VaultEnrollmentEntity         = lazy(() => import("@/pages/user/vault-enrollment-entity"));
const VaultEnrollmentOverview       = lazy(() => import("@/pages/user/vault-enrollment-overview"));
const VaultEnrollmentProject        = lazy(() => import("@/pages/user/vault-enrollment-project"));
const VaultEnrollmentProjectDetail  = lazy(() => import("@/pages/user/vault-enrollment-project-detail"));
const VaultEnrollmentLinked         = lazy(() => import("@/pages/user/vault-enrollment-linked"));
const VaultEnrollmentLinkedDetail   = lazy(() => import("@/pages/user/vault-enrollment-linked-detail"));
const VaultSecurity     = lazy(() => import("@/pages/user/vault-security"));
const VaultBackup       = lazy(() => import("@/pages/user/vault-backup"));
const VaultBackupEntity = lazy(() => import("@/pages/user/vault-backup-entity"));
const VaultShared       = lazy(() => import("@/pages/user/vault-shared"));
const VaultSharedEntity = lazy(() => import("@/pages/user/vault-shared-entity"));
const VaultBanned       = lazy(() => import("@/pages/user/vault-banned"));
const VaultTrash        = lazy(() => import("@/pages/user/vault-trash"));
const VaultActivity     = lazy(() => import("@/pages/user/vault-activity"));
const VaultMigration       = lazy(() => import("@/pages/user/vault-migration"));
const VaultSnapshot        = lazy(() => import("@/pages/user/vault-snapshot"));
const VaultCompliance      = lazy(() => import("@/pages/user/vault-compliance"));
const VaultEmergencyAccess = lazy(() => import("@/pages/user/vault-emergency-access"));
// Phase 9A — Enroll sidebar shell (Projects Overview; Entities placeholder
// until Phase 10A wires it up)
const EnrollProjects    = lazy(() => import("@/pages/user/enroll-projects"));
const EnrollEntities    = lazy(() => import("@/pages/user/enroll-entities"));
// Phase 9B — per-project dedicated dashboard (own URL, deep-linkable,
// separate from the submission-flow UserProjectDetail above)
const ProjectDashboard  = lazy(() => import("@/pages/user/project-dashboard"));
// Phase 10B — per-entity dedicated dashboard, reusing EntityDashboardTabs
const EntityDashboard   = lazy(() => import("@/pages/user/entity-dashboard"));
const UserLeaderboard   = lazy(() => import("@/pages/user/leaderboard"));
const UserInbox         = lazy(() => import("@/pages/user/inbox"));
const Authenticator     = lazy(() => import("@/pages/user/authenticator"));
const AyzenEmail        = lazy(() => import("@/pages/user/ayzen-email"));
const Mailbox           = lazy(() => import("@/pages/user/mailbox"));
const UserProfile       = lazy(() => import("@/pages/user/profile"));
const EmailAccounts     = lazy(() => import("@/pages/user/email-accounts"));
const UserSupport       = lazy(() => import("@/pages/user/support"));
const UserReferrals     = lazy(() => import("@/pages/user/referrals"));
const UserSettings      = lazy(() => import("@/pages/user/settings"));
const UserSecurity      = lazy(() => import("@/pages/user/security"));
const UserWallets       = lazy(() => import("@/pages/user/wallets"));
const FinanceDashboard      = lazy(() => import("@/pages/user/finance/dashboard"));
const FinanceReceivables    = lazy(() => import("@/pages/user/finance/receivables"));
const FinancePayables       = lazy(() => import("@/pages/user/finance/payables"));
const FinanceBorrowed       = lazy(() => import("@/pages/user/finance/borrowed"));
const FinanceLending        = lazy(() => import("@/pages/user/finance/lending"));
const FinanceInvestments    = lazy(() => import("@/pages/user/finance/investments"));
const FinanceInvestmentDetail = lazy(() => import("@/pages/user/finance/investment-detail"));
const FinanceAssets         = lazy(() => import("@/pages/user/finance/assets"));
const FinanceExpenses       = lazy(() => import("@/pages/user/finance/expenses"));
const FinanceInterest       = lazy(() => import("@/pages/user/finance/interest"));
const FinancePnl            = lazy(() => import("@/pages/user/finance/pnl"));
const FinanceLedger         = lazy(() => import("@/pages/user/finance/ledger"));
const FinanceProjections    = lazy(() => import("@/pages/user/finance/projections"));
const FinanceRecurring      = lazy(() => import("@/pages/user/finance/recurring"));
const FinanceBudgets        = lazy(() => import("@/pages/user/finance/budgets"));
const FinanceAnalytics      = lazy(() => import("@/pages/user/finance/analytics"));
const FinanceCurrencies     = lazy(() => import("@/pages/user/finance/currencies"));
const FinanceAccounts       = lazy(() => import("@/pages/user/finance/accounts"));
const FinanceJournal        = lazy(() => import("@/pages/user/finance/journal"));
const FinanceTrialBalance   = lazy(() => import("@/pages/user/finance/trial-balance"));
const FinanceBalanceSheet   = lazy(() => import("@/pages/user/finance/balance-sheet"));
const FinanceIncomeStatement = lazy(() => import("@/pages/user/finance/income-statement"));
const FinanceCashFlow = lazy(() => import("@/pages/user/finance/cash-flow"));
const FinanceGoals           = lazy(() => import("@/pages/user/finance/goals"));
const FinanceBooks           = lazy(() => import("@/pages/user/finance/books"));
const FinanceCustomReport    = lazy(() => import("@/pages/user/finance/custom-report"));
const FinanceInvoices        = lazy(() => import("@/pages/user/finance/invoices"));
const FinancePaymentMethods  = lazy(() => import("@/pages/user/finance/payment-methods"));
const SubscriptionPage  = lazy(() => import("@/pages/user/subscription"));
const CreditsPage       = lazy(() => import("@/pages/user/credits"));
const UserHistory       = lazy(() => import("@/pages/user/history"));
const EarnPage          = lazy(() => import("@/pages/user/earn"));
const CalculatorPage    = lazy(() => import("@/pages/user/calculator"));
const TeamsPage         = lazy(() => import("@/pages/user/teams"));
const ContentPage       = lazy(() => import("@/pages/user/content"));
const WalletHub         = lazy(() => import("@/pages/user/wallet-hub"));
const Marketplace       = lazy(() => import("@/pages/user/marketplace"));
const MarketHub         = lazy(() => import("@/pages/user/marketplace-hub"));
const MarketplaceAzn    = lazy(() => import("@/pages/user/marketplace-azn"));
const MarketplaceNft    = lazy(() => import("@/pages/user/marketplace-nft"));
const MarketplaceVault  = lazy(() => import("@/pages/user/marketplace-vault"));
const MarketplaceGame   = lazy(() => import("@/pages/user/marketplace-game"));
const MarketplaceWallet = lazy(() => import("@/pages/user/marketplace-wallet"));
const MarketplaceSpot   = lazy(() => import("@/pages/user/marketplace-spot"));
const MarketplaceStaking = lazy(() => import("@/pages/user/marketplace-staking"));
const MarketplacePolymarket = lazy(() => import("@/pages/user/marketplace-polymarket"));
const MarketplaceOrderHistory = lazy(() => import("@/pages/user/marketplace-order-history"));
const CheckinPage       = lazy(() => import("@/pages/user/checkin"));
const WatchlistPage     = lazy(() => import("@/pages/user/watchlist"));
const NftMarketplace    = lazy(() => import("@/pages/user/nft-marketplace"));

// ─── Route config arrays ──────────────────────────────────────────────────────

export const ADMIN_ROUTES: RouteConfig[] = [
  { path: "/admin/dashboard",       component: AdminDashboard,     adminOnly: true },
  { path: "/admin/users",           component: AdminUsers,         adminOnly: true },
  { path: "/admin/projects",              component: AdminProjects,        allowedRoles: ["admin", "dev", "moderator"] },
  { path: "/admin/project-templates",     component: AdminProjectTemplates, allowedRoles: ["admin", "dev", "moderator"] },
  { path: "/admin/projects/:id",         component: AdminProjectDetail,   adminOnly: true },
  { path: "/admin/operator-progress",    component: AdminOperatorProgress, adminOnly: true },
  { path: "/admin/tasks",           component: AdminTasks,         allowedRoles: ["admin", "dev", "moderator"] },
  { path: "/admin/tools/gas",       component: AdminGas,           adminOnly: true },
  { path: "/admin/tools/wallet",    component: AdminWallet,        adminOnly: true },
  { path: "/admin/revenue",         component: AdminRevenue,       adminOnly: true },
  { path: "/admin/tools/streak",    component: AdminStreak,        adminOnly: true },
  { path: "/admin/tools/networks",  component: AdminNetworks,      adminOnly: true },
  { path: "/admin/broadcast",       component: AdminBroadcast,     adminOnly: true },
  { path: "/admin/leaderboard",     component: AdminLeaderboard,   adminOnly: true },
  { path: "/admin/vault",           component: AdminVault,         adminOnly: true },
  { path: "/admin/plugins",         component: AdminPlugins,       adminOnly: true },
  { path: "/admin/settings",        component: AdminSettings,      adminOnly: true },
  { path: "/admin/developer",       component: AdminDeveloper,     allowedRoles: ["admin", "dev"] },
  { path: "/admin/support",         component: AdminSupport,       adminOnly: true },
  { path: "/admin/kyc",             component: AdminKyc,           adminOnly: true },
  { path: "/admin/emergency-access", component: AdminEmergencyAccess, adminOnly: true },
  { path: "/admin/referrals",       component: AdminReferrals,     adminOnly: true },
  { path: "/admin/credits",         component: AdminCreditsPage,   adminOnly: true },
  { path: "/admin/subscriptions",   component: AdminSubscriptions, adminOnly: true },
  { path: "/admin/activity",        component: AdminActivity,      adminOnly: true },
  { path: "/admin/categories",      component: AdminCategories,    adminOnly: true },
  { path: "/admin/health-rules",    component: AdminHealthRules,   adminOnly: true },
  { path: "/admin/mail-sending-config", component: AdminMailSendingConfig, adminOnly: true },
  { path: "/admin/teams",           component: AdminTeams,         allowedRoles: ["admin", "dev", "moderator"] },
  { path: "/admin/team-vault",      component: AdminTeamVault,     adminOnly: true },
  { path: "/admin/marketplace",     component: AdminMarketplace,   allowedRoles: ["admin", "dev"] },
  { path: "/admin/ai-agent",        component: AdminAiAgent,       allowedRoles: ["dev"] },
  { path: "/admin/mcp-agents",      component: AdminMcpAgents,     allowedRoles: ["dev"] },
  { path: "/admin/mega-engine",     component: AdminMegaEngine,    allowedRoles: ["dev"] },
  { path: "/admin/mega-engine/observability", component: AdminMegaEngineObservability, allowedRoles: ["dev"] },
  { path: "/admin/key-manager",     component: AdminKeyManager,    allowedRoles: ["admin"] },
  { path: "/admin/dev-nav-builder", component: AdminDevNavBuilder, allowedRoles: ["dev", "admin"] },
  { path: "/admin/marketplace-categories", component: AdminMarketplaceCategories, allowedRoles: ["dev", "admin"] },
  { path: "/admin/marketplace-market-config", component: AdminMarketplaceMarketConfig, allowedRoles: ["dev", "admin"] },
  { path: "/admin/config-manager", component: AdminConfigManager, allowedRoles: ["dev", "admin"] },
  { path: "/admin/layout-builder", component: AdminLayoutBuilder, allowedRoles: ["dev", "admin"] },
  { path: "/admin/theme-studio",    component: AdminThemeStudio,   allowedRoles: ["dev", "admin"] },
  { path: "/admin/custom-buttons",  component: AdminCustomButtons, allowedRoles: ["dev", "admin"] },
  // Dev panel (grouped with admin for convenience)
  { path: "/dev/azn-deploy",        component: DevAznDeploy,       allowedRoles: ["dev", "admin"] },
  // Catch-all landing pages for sidebar entries added from the Sidebar
  // Builder that don't point at an existing route — keep these last.
  { path: "/dev/custom/:slug",         component: DevCustomPage,          allowedRoles: ["dev", "admin"] },
  { path: "/admin/custom/:slug",       component: AdminNavCustomPage,     allowedRoles: ["dev", "admin"] },
  { path: "/moderator/custom/:slug",   component: ModeratorCustomPage,    allowedRoles: ["dev", "admin", "moderator"] },
  { path: "/team_leader/custom/:slug", component: TeamLeaderCustomPage,   allowedRoles: ["dev", "admin", "team_leader"] },
];

export const USER_ROUTES: RouteConfig[] = [
  // Core
  { path: "/home",               component: UserHome },
  { path: "/dashboard",          component: UserDashboard },
  { path: "/profile",            component: UserProfile },
  { path: "/settings",           component: UserSettings },
  { path: "/developer",          component: UserDeveloper },
  { path: "/security",           component: UserSecurity },
  // Tasks & Projects
  { path: "/projects",           component: UserProjects },
  // Airdrop calendar — every project's snapshot/TGE/deadline dates together,
  // with a 1-day-ahead Telegram reminder (see lib/airdrop-reminder-cron.ts).
  { path: "/calendar",           component: AirdropCalendar },
  // Phase 6 — must be registered before "/projects/:id" (wouter Switch is
  // first-match-wins, and ":id" would otherwise swallow "compare").
  { path: "/projects/compare",   component: UserProjectCompare },
  { path: "/projects/:id",       component: UserProjectDetail },
  { path: "/tasks",              component: UserTasks },
  // Gamification
  { path: "/leaderboard",        component: UserLeaderboard },
  { path: "/vault",              component: UserVault },
  { path: "/vault/hub",          component: VaultHub },
  // Wallet Hub — rename/expansion of the old flat "Wallet" access item into
  // its own sub-category with three addressable views (see
  // vault-wallet-hub.tsx). Bare "/vault/wallet-hub" falls back to Overview.
  { path: "/vault/wallet-hub",           component: VaultWalletHub },
  { path: "/vault/wallet-hub/:subtab",   component: VaultWalletHub },
  // Phase 4 — Vault Sidebar Restructure (Enroll / Security / Backup / Shared)
  // Enrollment hub — Overview / Entity / Project / Linked
  { path: "/vault/enrollment/overview",          component: VaultEnrollmentOverview },
  // Entity — Overview/Ongoing/Past hierarchy (one component, :view param).
  // The bare "/entity" path is kept as a fallback that renders Overview,
  // so any old link/bookmark still resolves.
  { path: "/vault/enrollment/entity",            component: VaultEnrollmentEntity },
  { path: "/vault/enrollment/entity/:view",      component: VaultEnrollmentEntity },
  // Project list must come before /:id so the literal "project" isn't swallowed
  { path: "/vault/enrollment/project",           component: VaultEnrollmentProject },
  { path: "/vault/enrollment/project/:id",       component: VaultEnrollmentProjectDetail },
  { path: "/vault/enrollment/linked",            component: VaultEnrollmentLinked },
  { path: "/vault/enrollment/linked/:entityId",  component: VaultEnrollmentLinkedDetail },
  { path: "/vault/security",     component: VaultSecurity },
  { path: "/vault/backup/:category/:id", component: VaultBackupEntity },
  { path: "/vault/backup/:category",     component: VaultBackup },
  { path: "/vault/backup",       component: VaultBackup },
  { path: "/vault/shared",                          component: VaultShared },
  { path: "/vault/shared/:entityType/:entityId",    component: VaultSharedEntity },
  { path: "/vault/banned",                          component: VaultBanned },
  { path: "/vault/trash",                           component: VaultTrash },
  { path: "/vault/activity",                        component: VaultActivity },
  { path: "/vault/migration",         component: VaultMigration },
  { path: "/vault/snapshot",          component: VaultSnapshot },
  { path: "/vault/compliance",        component: VaultCompliance },
  { path: "/vault/emergency-access",  component: VaultEmergencyAccess },
  { path: "/vault/projects",     component: UserProjectEntities },
  { path: "/vault/entity/:id/access", component: VaultEntityAccess },
  { path: "/vault/entity/:id",   component: VaultEntityDetail },
  { path: "/vault/local/:id",    component: VaultLocalDetail },
  { path: "/vault/kyc/data/overview", component: VaultKycDataOverview },
  { path: "/vault/kyc/data/used",     component: VaultKycDataUsed },
  { path: "/vault/kyc/data/unused",   component: VaultKycDataUnused },
  { path: "/vault/kyc/data/:id",      component: VaultKycDataDetail },
  { path: "/vault/kyc/enrolled",      component: VaultKycEnrolled },
  { path: "/vault/kyc/:id",      component: VaultKycDetail },
  { path: "/vault/2fa/:category/:id", component: VaultTwoFaEntity },
  { path: "/vault/2fa/:category",     component: VaultTwoFaCategory },
  { path: "/vault/mail-hub/:category/:id/mail/:msgId", component: VaultMailMessageDetail },
  { path: "/vault/mail-hub/:category/:id", component: VaultMailEntity },
  { path: "/vault/mail-hub/:category",     component: VaultMailCategory },
  { path: "/vault/mail/:accountId/:seqno", component: VaultMailMessage },
  { path: "/vault/mail/:accountId",        component: VaultMailInbox },
  // Phase 9A — Enroll sidebar shell (new area, separate from Vault's own
  // sidebar). "/enroll/projects" must come before nothing in particular here
  // since both are literal, single-segment-after-root paths — order is just
  // for readability, grouped with the rest of the enrollment surfaces above.
  { path: "/enroll/projects",    component: EnrollProjects },
  // Phase 9B — per-project dedicated dashboard, opened from the 9A project
  // list. Segment count differs from "/enroll/projects" above so match
  // order between the two doesn't matter, but kept adjacent for readability.
  { path: "/enroll/projects/:id", component: ProjectDashboard },
  { path: "/enroll/entities",    component: EnrollEntities },
  // Phase 10B — per-entity dedicated dashboard, opened from the 10A entity
  // list. Segment count differs from "/enroll/entities" above so match
  // order between the two doesn't matter, but kept adjacent for readability.
  { path: "/enroll/entities/:id", component: EntityDashboard },
  { path: "/checkin",            component: CheckinPage },
  { path: "/watchlist",          component: WatchlistPage },
  { path: "/earn",               component: EarnPage },
  { path: "/calculator",         component: CalculatorPage },
  { path: "/history",            component: UserHistory },
  // Social
  { path: "/teams",              component: TeamsPage },
  { path: "/inbox",              component: UserInbox },
  { path: "/content",            component: ContentPage },
  // Finance
  { path: "/wallet",             component: WalletHub },
  { path: "/wallets",            component: UserWallets },
  { path: "/credits",            component: CreditsPage },
  { path: "/subscription",       component: SubscriptionPage },
  { path: "/referrals",          component: UserReferrals },
  // Zynth — AI assistant layer (master plan §2). Docked full-page version
  // of the same <AiChat/> that also floats globally elsewhere.
  { path: "/assistant",          component: Assistant },
  // Finance module — Receivables/Payables/Loans/Investments/Assets/Expenses/Reports
  { path: "/finance/dashboard",              component: FinanceDashboard },
  { path: "/finance/receivables",            component: FinanceReceivables },
  { path: "/finance/payables",               component: FinancePayables },
  { path: "/finance/borrowed",               component: FinanceBorrowed },
  { path: "/finance/lending",                component: FinanceLending },
  { path: "/finance/interest",               component: FinanceInterest },
  { path: "/finance/investments/:id",        component: FinanceInvestmentDetail },
  { path: "/finance/investments",            component: FinanceInvestments },
  { path: "/finance/assets",                 component: FinanceAssets },
  { path: "/finance/expenses",               component: FinanceExpenses },
  { path: "/finance/pnl",                    component: FinancePnl },
  { path: "/finance/ledger",                 component: FinanceLedger },
  { path: "/finance/projections",            component: FinanceProjections },
  { path: "/finance/recurring",              component: FinanceRecurring },
  { path: "/finance/budgets",                component: FinanceBudgets },
  { path: "/finance/analytics",              component: FinanceAnalytics },
  { path: "/finance/currencies",             component: FinanceCurrencies },
  { path: "/finance/accounts",               component: FinanceAccounts },
  { path: "/finance/journal",                component: FinanceJournal },
  { path: "/finance/trial-balance",          component: FinanceTrialBalance },
  { path: "/finance/balance-sheet",          component: FinanceBalanceSheet },
  { path: "/finance/income-statement",       component: FinanceIncomeStatement },
  { path: "/finance/cash-flow",              component: FinanceCashFlow },
  { path: "/finance/goals",                  component: FinanceGoals },
  { path: "/finance/books",                  component: FinanceBooks },
  { path: "/finance/custom-report",          component: FinanceCustomReport },
  { path: "/finance/invoices",               component: FinanceInvoices },
  { path: "/finance/payment-methods",        component: FinancePaymentMethods },
  { path: "/finance",                        component: FinanceDashboard },
  // Marketplace
  { path: "/marketplace/hub",           component: MarketHub },
  { path: "/marketplace/azn",           component: MarketplaceAzn },
  { path: "/marketplace/p2p",           component: MarketplaceAzn },
  { path: "/marketplace/vault",         component: MarketplaceVault },
  { path: "/marketplace/game",          component: MarketplaceGame },
  { path: "/marketplace/wallet",        component: MarketplaceWallet },
  { path: "/marketplace/spot",          component: MarketplaceSpot },
  { path: "/marketplace/staking",       component: MarketplaceStaking },
  { path: "/marketplace/polymarket",    component: MarketplacePolymarket },
  { path: "/marketplace/order-history", component: MarketplaceOrderHistory },
  { path: "/marketplace",               component: Marketplace },           // keep last (catch-all)
  // Tools & Email
  { path: "/authenticator",      component: Authenticator },
  { path: "/ayzen-email",        component: AyzenEmail },
  { path: "/mailbox/:id",        component: Mailbox },
  { path: "/mailbox",            component: Mailbox },
  { path: "/email-accounts",     component: EmailAccounts },
  // Support
  { path: "/support",            component: UserSupport },
  // Catch-all landing page for sidebar entries added from the User tab of
  // the Sidebar Builder that don't point at an existing route — keep last.
  { path: "/user/custom/:slug",  component: UserCustomPage },
];

// ─── Page list for the per-page theme/layout override picker ──────────────────
// Derived from the same ADMIN_ROUTES/USER_ROUTES arrays used for routing, so
// this list can never drift out of sync with the actual pages in the app.

export interface PageListEntry { path: string; label: string; group: "admin" | "user" }

function labelFromPath(path: string): string {
  const segs = path.split("/").filter(Boolean).filter(s => !s.startsWith(":"));
  if (segs.length === 0) return "Home";
  return segs.map(s => s.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase())).join(" › ");
}

export const PAGE_LIST: PageListEntry[] = [
  ...ADMIN_ROUTES.map(r => ({ path: r.path, label: labelFromPath(r.path), group: "admin" as const })),
  ...USER_ROUTES.map(r => ({ path: r.path, label: labelFromPath(r.path), group: "user" as const })),
];

/** Matches a concrete pathname (e.g. "/projects/42") against a route pattern
 *  (e.g. "/projects/:id") — same segment count, literal segments must match
 *  exactly, ":param" segments match anything. */
export function matchesPagePattern(pattern: string, pathname: string): boolean {
  const p = pattern.split("/").filter(Boolean);
  const a = pathname.split("/").filter(Boolean);
  if (p.length !== a.length) return false;
  return p.every((seg, i) => seg.startsWith(":") || seg === a[i]);
}

/** Picks the best-matching override page key for a pathname. Exact literal
 *  matches win over dynamic (":id") ones so "/vault" isn't shadowed by a
 *  looser pattern, then falls back to the first dynamic match. */
export function findBestPageMatch(pageKeys: string[], pathname: string): string | null {
  const candidates = pageKeys.filter(k => matchesPagePattern(k, pathname));
  if (candidates.length === 0) return null;
  const exact = candidates.find(k => !k.includes(":"));
  return exact ?? candidates[0];
}
