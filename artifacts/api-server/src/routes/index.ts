import { Router, type IRouter } from "express";
import healthRouter from "./health";
import uptimeRouter from "./uptime";
import authRouter from "./auth";
import passkeyRouter from "./passkey";
import usersRouter from "./users";
import projectsRouter from "./projects";
import projectDatesRouter from "./project-dates";
import tasksRouter from "./tasks";
import toolsRouter from "./tools";
import vaultRouter from "./vault";
import vaultSecurityRouter from "./vault-security";
import vaultReauthRouter from "./vault-reauth";
import leaderboardRouter from "./leaderboard";
import broadcastRouter from "./broadcast";
import settingsRouter from "./settings";
import telemetryRouter from "./telemetry";
import authorizationTelemetryRouter from "./authorization-telemetry";
import aiRouter from "./ai";
import emailRoutingRouter from "./email-routing";
import resendWebhookRouter from "./resend-webhook";
import ayzenMailboxRouter from "./ayzen-mailbox";
import resendAdminRouter from "./resend-admin";
import telegramRouter from "./telegram";
import emailAccountsRouter from "./email-accounts";
import emailComposeRouter from "./email-compose";
import supportRouter from "./support";
import referralsRouter from "./referrals";
import eventsRouter from "./events";
import syncRouter from "./sync";
import polymarketRouter from "./polymarket";
import adminWalletRouter from "./admin-wallet";
import configRouter from "./config";
import subEnginesRouter from "./sub-engines";
import advancedSubEnginesRouter from "./sub-engines-advanced";
import sioraRouter from "./siora";
import adminOidcRolloutRouter from "./admin-oidc-rollout";
// OIDC Roadmap — Season 3, Phase 6e-d: Monitoring — admin GET for the
// Back-Channel Logout retry queue's stats/health. See that router's own
// header for why this is GET-only (no admin action in 6e-d's scope).
import adminOidcBackchannelLogoutRouter from "./admin-oidc-backchannel-logout";
// OIDC Roadmap — Season 5, Phase 9a: Admin client list view. Same
// `requireDev`-gated tier as the two imports above — see that router's
// own header for the full mounting rationale.
import adminOidcClientsRouter from "./admin-oidc-clients";
// AYZEN Policy & Authorization Mega Engine — Phase 23A/23B: Admin Policy
// Console, Policies/Policy Versions sections. Same requireDev-gated tier
// as the admin routers above; see routes/admin-policy-console.ts's own
// header for the full mounting rationale.
import adminPolicyConsoleRouter from "./admin-policy-console";
// AYZEN Policy & Authorization Mega Engine — Phase 23C: Admin Policy
// Console, Roles/Permissions/Assignments sections. Mounted right next to
// its own Phase 23A/23B sibling above; see routes/admin-rbac-console.ts's
// own header for the full mounting rationale.
import adminRbacConsoleRouter from "./admin-rbac-console";
// AYZEN Policy & Authorization Mega Engine — Phase 23D: Admin Policy
// Console, Resources section. Mounted right next to its own Phase
// 23A/23B/23C siblings above; see routes/admin-resource-console.ts's own
// header for the full mounting rationale.
import adminResourceConsoleRouter from "./admin-resource-console";
// AYZEN Mega Engine — Phase E2: Admin Inspection (§57-E health/metrics/
// dead-letter tools/replay, HTTP surface for the Part E1 store-layer
// functions). Same requireDev-gated tier as the admin routers above; see
// routes/admin-mega-engine.ts's own header for the full mounting
// rationale.
import adminMegaEngineRouter from "./admin-mega-engine";
import layoutRouter from "./layout";
import marketplaceUsdtRouter from "./marketplace-usdt";
import emailRouter from "./email";
import walletsRouter from "./wallets";
import logsRouter from "./logs";
import pluginsRouter from "./plugins";
import subscriptionsRouter from "./subscriptions";
import paymentsRouter from "./payments";
import creditsRouter from "./credits";
// PHASE 5 — admin credit console: view/reprice/enable-disable metered
// actions + usage stats. Mounted right next to creditsRouter since it's
// the admin-facing surface on top of the same credits/credit_transactions
// tables and services/credit-meter.ts registry; see that file's own header.
import adminCreditConsoleRouter from "./admin-credit-console";
import telemetryStreamRouter from "./telemetry-stream";
import localAccountsRouter from "./local-accounts";
import kycRouter from "./kyc";
import kycDataEntitiesRouter from "./kyc-data-entities";
import gameEntriesRouter from "./game-entries";
import messagesRouter from "./messages";
import aiActionsRouter from "./ai-actions";
import notificationsRouter from "./notifications";
import notificationPreferencesRouter from "./notification-preferences";
import functionsRouter from "./functions";
import historyRouter from "./history";
import earnLinksRouter from "./earn-links";
import categoriesRouter from "./categories";
import teamsRouter from "./teams";
// Phase 8 — Organization Accounts (master plan §2/§7 Phase 8). Distinct
// product from teamsRouter above — see routes/organizations.ts's own
// header for why the two aren't merged.
import organizationsRouter from "./organizations";
import contentRouter from "./content";
import entitiesRouter from "./entities";
import twoFactorRouter from "./two-factor";
import bulkRouter from "./bulk";
import networksRouter from "./networks";
import rewardLinksRouter from "./reward-links";
import adTasksRouter from "./ad-tasks";
import searchRouter from "./search";
import nftSubscriptionsRouter from "./nft-subscriptions";
import ayzenMailRouter from "./ayzen-mail";
import marketplaceRouter from "./marketplace";
import marketplaceCartRouter from "./marketplace-cart";
import marketplaceReviewsRouter from "./marketplace-reviews";
import marketplaceOffersRouter from "./marketplace-offers";
import marketplaceCouponsRouter from "./marketplace-coupons";
import marketplaceReportsRouter from "./marketplace-reports";
import marketplaceAnalyticsRouter from "./marketplace-analytics";
import marketplaceBundlesRouter from "./marketplace-bundles";
import marketplaceAlertsRouter from "./marketplace-alerts";
import marketplaceDiscoveryRouter from "./marketplace-discovery";
import marketplaceAznRouter from "./marketplace-azn";
import marketplaceNftRouter from "./marketplace-nft";
import marketplaceVaultRouter from "./marketplace-vault";
import marketplaceMarketConfigRouter from "./marketplace-market-config";
import marketplaceGameRouter from "./marketplace-game";
import marketplaceWalletRouter from "./marketplace-wallet";
import marketplaceSpotRouter from "./marketplace-spot";
import aiAgentRouter from "./ai-agent";
import securityRouter from "./security";
import checkinRouter from "./checkin";
import watchlistRouter from "./watchlist";
import shellRouter from "./shell";
import devPanelRouter from "./dev-panel";
import keyManagerRouter from "./key-manager";
import devNavRouter from "./dev-nav";
import navRouter from "./nav";
import mcpAgentsRouter from "./mcp-agents";
import uiThemeRouter from "./ui-theme";
import customButtonsRouter from "./custom-buttons";
import apiKeysRouter from "./api-keys";
import valueHistoryRouter from "./value-history";
import vaultSharesRouter from "./vault-shares";
import vaultEntityLinksRouter from "./vault-entity-links";
import exchangeApiRouter from "./exchange-api";
import digestSettingsRouter from "./digest-settings";
import mailUndoSendSettingsRouter from "./mail-undo-send-settings";
import mcpRouter from "./mcp";
import vaultAttachmentsRouter from "./vault-attachments";
import vaultMigrationRouter from "./vault-migration";
import vaultSnapshotRouter from "./vault-snapshot";
import vaultBackupScheduleRouter from "./vault-backup-schedule";
import vaultBackupCloudRouter from "./vault-backup-cloud";
import vaultBackupKeyRouter from "./vault-backup-key";
import complianceReportRouter from "./compliance-report";
import emergencyAccessRouter from "./emergency-access";
import drTestsRouter from "./dr-tests";
import financeRouter from "./finance";
import financeInvoicesRouter from "./finance-invoices";
import projectTemplatesRouter from "./project-templates";
import sharedRouter from "./shared";
import newEnginesRouter from "./new-engines";

const router: IRouter = Router();

router.use(shellRouter);
router.use(eventsRouter);
router.use(logsRouter);
router.use(healthRouter);
router.use(uptimeRouter);
router.use(authRouter);
router.use(passkeyRouter);
router.use(usersRouter);
router.use(emailRouter);
router.use(walletsRouter);
router.use(projectsRouter);
router.use(tasksRouter);
router.use(toolsRouter);
router.use(vaultRouter);
router.use(vaultSecurityRouter);
router.use(vaultReauthRouter);
router.use(leaderboardRouter);
router.use(broadcastRouter);
router.use(settingsRouter);
router.use(pluginsRouter);
router.use(telemetryRouter);
router.use(authorizationTelemetryRouter);
router.use(aiRouter);
router.use(emailRoutingRouter);
router.use(telegramRouter);
router.use(emailAccountsRouter);
router.use(emailComposeRouter);
router.use(supportRouter);
router.use(referralsRouter);
router.use(subscriptionsRouter);
router.use(paymentsRouter);
router.use(creditsRouter);
router.use(adminCreditConsoleRouter);
router.use(telemetryStreamRouter);
router.use(localAccountsRouter);
router.use(kycRouter);
router.use(kycDataEntitiesRouter);
router.use(gameEntriesRouter);
router.use(messagesRouter);
router.use(aiActionsRouter);
router.use(notificationsRouter);
router.use(notificationPreferencesRouter);
router.use(functionsRouter);
router.use(historyRouter);
router.use(earnLinksRouter);
router.use(categoriesRouter);
router.use(teamsRouter);
router.use(organizationsRouter);
router.use(contentRouter);
router.use(entitiesRouter);
router.use(vaultSharesRouter);
router.use(vaultEntityLinksRouter);
router.use(twoFactorRouter);
router.use(bulkRouter);
router.use(networksRouter);
router.use(rewardLinksRouter);
router.use(adTasksRouter);
router.use(searchRouter);
router.use(nftSubscriptionsRouter);
router.use(ayzenMailRouter);
router.use(marketplaceDiscoveryRouter);
router.use(marketplaceRouter);
router.use(marketplaceCartRouter);
router.use(marketplaceReviewsRouter);
router.use(marketplaceOffersRouter);
router.use(marketplaceCouponsRouter);
router.use(marketplaceReportsRouter);
router.use(marketplaceAnalyticsRouter);
router.use(marketplaceBundlesRouter);
router.use(marketplaceAlertsRouter);
router.use(marketplaceAznRouter);
router.use(marketplaceNftRouter);
router.use(marketplaceVaultRouter);
router.use(marketplaceMarketConfigRouter);
router.use(marketplaceGameRouter);
router.use(marketplaceWalletRouter);
router.use(marketplaceSpotRouter);
router.use(aiAgentRouter);
router.use(mcpAgentsRouter);
router.use(securityRouter);
router.use(checkinRouter);
router.use(watchlistRouter);
router.use(devPanelRouter);
router.use(keyManagerRouter);
router.use(devNavRouter);
router.use(navRouter);
router.use(uiThemeRouter);
router.use(customButtonsRouter);
router.use(syncRouter);
router.use(polymarketRouter);
router.use(adminWalletRouter);
router.use(configRouter);
router.use(subEnginesRouter);
router.use(advancedSubEnginesRouter);
router.use(sioraRouter);
// Season 3, Phase 5c-c/5c-d/5c-e/5d-b/5e-c/5e-d — admin GET/PATCH for the
// OIDC rollout flag + comparison stats + health. Same `requireDev`-gated
// tier as configRouter above; see routes/admin-oidc-rollout.ts's own
// header for the full mounting rationale.
router.use(adminOidcRolloutRouter);
// Season 3, Phase 6e-d — admin GET for the Back-Channel Logout retry
// queue's stats/health. Same `requireDev`-gated tier, mounted right next
// to its own Season-3-admin sibling above.
router.use(adminOidcBackchannelLogoutRouter);
// Season 5, Phase 9a — admin GET for the full oidc_clients registry
// (list view). Same `requireDev`-gated tier, mounted right next to its
// own Season-3-admin siblings above; see routes/admin-oidc-clients.ts's
// own header for the full mounting rationale.
router.use(adminOidcClientsRouter);
// AYZEN Policy & Authorization Mega Engine — Phase 23A/23B/23C — Admin
// Policy Console (Policies/Policy Versions, then Roles/Permissions/
// Assignments). Same requireDev-gated tier as the admin routers above;
// mounted together since both are the same "internal operator console"
// surface, just different sections of it.
router.use(adminPolicyConsoleRouter);
router.use(adminRbacConsoleRouter);
router.use(adminResourceConsoleRouter);
// AYZEN Mega Engine — Phase E2 — admin GET/POST for engine health, §39
// metrics, and event-bus/scheduler dead-letter list/replay/discard.
// Mounted right next to its own admin-console siblings above.
router.use(adminMegaEngineRouter);
router.use(layoutRouter);
router.use(marketplaceUsdtRouter);
router.use(apiKeysRouter);
router.use(valueHistoryRouter);
router.use(projectDatesRouter);
router.use(exchangeApiRouter);
router.use(digestSettingsRouter);
router.use(mailUndoSendSettingsRouter);
router.use(mcpRouter);
router.use(vaultAttachmentsRouter);
router.use(vaultMigrationRouter);
router.use(vaultSnapshotRouter);
router.use(vaultBackupScheduleRouter);
router.use(vaultBackupCloudRouter);
router.use(vaultBackupKeyRouter);
router.use(complianceReportRouter);
router.use(emergencyAccessRouter);
router.use(drTestsRouter);
router.use(financeRouter);
router.use(financeInvoicesRouter);
router.use(projectTemplatesRouter);
router.use(sharedRouter);
router.use(newEnginesRouter);
router.use(resendWebhookRouter);
router.use(ayzenMailboxRouter);
router.use(resendAdminRouter);

export default router;
