import { Router } from "express";
import { ERROR_LIBRARY } from "../lib/errors";

const router = Router();

const ENDPOINTS = [
  // ── Health ──────────────────────────────────────────────────────────────────
  { method: "GET",   path: "/",             group: "Health",    auth: false,  admin: false, desc: "Health check" },
  { method: "GET",   path: "/healthz",      group: "Health",    auth: false,  admin: false, desc: "Liveness probe" },

  // ── Auth ────────────────────────────────────────────────────────────────────
  { method: "POST",  path: "/auth/send-otp",           group: "Auth", auth: false, admin: false, desc: "Send email verification OTP before registration" },
  { method: "POST",  path: "/auth/register",           group: "Auth", auth: false, admin: false, desc: "Register a new user account (requires emailOtp)" },
  { method: "POST",  path: "/auth/login",              group: "Auth", auth: false, admin: false, desc: "Login with email + password, returns token" },
  { method: "POST",  path: "/auth/magic-link",         group: "Auth", auth: false, admin: false, desc: "Send passwordless OTP login code via email" },
  { method: "POST",  path: "/auth/magic-link/verify",  group: "Auth", auth: false, admin: false, desc: "Verify magic-link OTP code, returns token" },
  { method: "POST",  path: "/auth/refresh",            group: "Auth", auth: false, admin: false, desc: "Refresh an expired token using refreshToken" },
  { method: "POST",  path: "/auth/forgot-password",   group: "Auth", auth: false, admin: false, desc: "Send password reset OTP to email" },
  { method: "POST",  path: "/auth/reset-password",    group: "Auth", auth: false, admin: false, desc: "Verify reset OTP and set new password" },
  { method: "GET",   path: "/auth/me",                group: "Auth", auth: true,  admin: false, desc: "Get the currently authenticated user" },
  { method: "POST",  path: "/auth/firebase-sync",     group: "Auth", auth: false, admin: false, desc: "Sync a Firebase ID token into an AYZEN token" },
  { method: "POST",  path: "/auth/setup-2fa",         group: "Auth", auth: true,  admin: false, desc: "Generate a 2FA TOTP secret and QR code" },
  { method: "POST",  path: "/auth/verify-2fa",        group: "Auth", auth: true,  admin: false, desc: "Verify a 2FA TOTP code" },

  // ── Users ───────────────────────────────────────────────────────────────────
  { method: "GET",   path: "/users",              group: "Users",  auth: true, admin: true,  desc: "List all users (admin only)" },
  { method: "GET",   path: "/users/:id",          group: "Users",  auth: true, admin: false, desc: "Get a user by ID" },
  { method: "PATCH", path: "/users/:id",          group: "Users",  auth: true, admin: true,  desc: "Update user fields (admin only)" },
  { method: "DELETE",path: "/users/:id",          group: "Users",  auth: true, admin: true,  desc: "Delete a user account (admin only)" },
  { method: "GET",   path: "/users/:id/stats",    group: "Users",  auth: true, admin: false, desc: "Get task/ROI statistics for a user" },
  { method: "GET",   path: "/admin/stats",        group: "Users",  auth: true, admin: true,  desc: "Platform-wide stats (admin only)" },
  { method: "GET",   path: "/admin/activity",     group: "Users",  auth: true, admin: true,  desc: "Recent platform activity log (admin only)" },
  { method: "GET",   path: "/profile",            group: "Users",  auth: true, admin: false, desc: "Get authenticated user's profile" },
  { method: "PUT",   path: "/profile",            group: "Users",  auth: true, admin: false, desc: "Update authenticated user's profile" },
  { method: "GET",   path: "/profile/kyc",        group: "Users",  auth: true, admin: false, desc: "Get KYC status (pending/approved/rejected), v1 eligibility, v2 upcoming" },
  { method: "POST",  path: "/profile/kyc/submit", group: "Users",  auth: true, admin: false, desc: "Submit KYC level v1 for admin review (requires picture, Twitter, Discord, Telegram handle + bot, WhatsApp, location)" },
  { method: "GET",   path: "/admin/kyc",          group: "Users",  auth: true, admin: true,  desc: "List KYC submissions by status (admin only, default pending)" },
  { method: "POST",  path: "/admin/kyc/:userId/approve", group: "Users", auth: true, admin: true, desc: "Approve a user's KYC submission (admin only)" },
  { method: "POST",  path: "/admin/kyc/:userId/reject",  group: "Users", auth: true, admin: true, desc: "Reject a user's KYC submission with a reason (admin only)" },
  { method: "POST",  path: "/users/change-password", group: "Users", auth: true, admin: false, desc: "Change password (requires current password)" },

  // ── Projects ─────────────────────────────────────────────────────────────────
  { method: "GET",   path: "/projects",                         group: "Projects", auth: true,  admin: false, desc: "List all projects (paginated)" },
  { method: "POST",  path: "/projects",                         group: "Projects", auth: true,  admin: true,  desc: "Create a new project (admin only)" },
  { method: "GET",   path: "/projects/:id",                     group: "Projects", auth: true,  admin: false, desc: "Get a project by ID" },
  { method: "PATCH", path: "/projects/:id",                     group: "Projects", auth: true,  admin: true,  desc: "Update project fields (admin only)" },
  { method: "DELETE",path: "/projects/:id",                     group: "Projects", auth: true,  admin: true,  desc: "Delete a project (admin only)" },
  { method: "POST",  path: "/projects/:id/join",                group: "Projects", auth: true,  admin: false, desc: "Join / enroll in a project" },
  { method: "GET",   path: "/projects/:id/members",             group: "Projects", auth: true,  admin: false, desc: "List project members" },
  { method: "GET",   path: "/projects/:id/stats",               group: "Projects", auth: true,  admin: false, desc: "Project completion stats" },
  { method: "GET",   path: "/projects/:id/entity-tasks",        group: "Projects", auth: true,  admin: false, desc: "Tasks grouped by entity for a project" },

  // ── Tasks ────────────────────────────────────────────────────────────────────
  { method: "GET",   path: "/tasks",                group: "Tasks", auth: true,  admin: false, desc: "List tasks (filter by projectId, status)" },
  { method: "POST",  path: "/tasks",                group: "Tasks", auth: true,  admin: true,  desc: "Create a new task (admin only)" },
  { method: "GET",   path: "/tasks/submissions",    group: "Tasks", auth: true,  admin: true,  desc: "List all task submissions (admin only)" },
  { method: "GET",   path: "/tasks/:id",            group: "Tasks", auth: true,  admin: false, desc: "Get a task by ID" },
  { method: "PATCH", path: "/tasks/:id",            group: "Tasks", auth: true,  admin: true,  desc: "Update task fields (admin only)" },
  { method: "DELETE",path: "/tasks/:id",            group: "Tasks", auth: true,  admin: true,  desc: "Delete a task (admin only)" },
  { method: "POST",  path: "/tasks/:id/submit",     group: "Tasks", auth: true,  admin: false, desc: "Submit task proof (proofUrl, notes, cost, profit, roi, entities)" },
  { method: "POST",  path: "/tasks/:id/verify",     group: "Tasks", auth: true,  admin: true,  desc: "Approve or reject a task submission (admin only)" },

  // ── Vault ────────────────────────────────────────────────────────────────────
  { method: "GET",   path: "/vault",      group: "Vault", auth: true, admin: false, desc: "List user's vault entries" },
  { method: "POST",  path: "/vault",      group: "Vault", auth: true, admin: false, desc: "Create a new vault entry" },
  { method: "GET",   path: "/vault/:id",  group: "Vault", auth: true, admin: false, desc: "Get a vault entry by ID" },
  { method: "PATCH", path: "/vault/:id",  group: "Vault", auth: true, admin: false, desc: "Update a vault entry" },
  { method: "DELETE",path: "/vault/:id",  group: "Vault", auth: true, admin: false, desc: "Delete a vault entry" },
  { method: "GET",   path: "/admin/vault",group: "Vault", auth: true, admin: true,  desc: "View all vault entries (admin only)" },

  // ── Wallets ──────────────────────────────────────────────────────────────────
  { method: "GET",   path: "/wallets",              group: "Wallets", auth: true, admin: false, desc: "List user's wallets" },
  { method: "POST",  path: "/wallets",              group: "Wallets", auth: true, admin: false, desc: "Add a new wallet" },
  { method: "PATCH", path: "/wallets/:id",          group: "Wallets", auth: true, admin: false, desc: "Update wallet label/metadata" },
  { method: "DELETE",path: "/wallets/:id",          group: "Wallets", auth: true, admin: false, desc: "Remove a wallet" },
  { method: "POST",  path: "/wallets/:id/sync",     group: "Wallets", auth: true, admin: false, desc: "Sync on-chain balance for a wallet" },
  { method: "GET",   path: "/wallets/stats",        group: "Wallets", auth: true, admin: false, desc: "Aggregate wallet stats" },
  { method: "POST",  path: "/wallets/:id/phrase",   group: "Wallets", auth: true, admin: false, desc: "Encrypt and store seed phrase" },
  { method: "GET",   path: "/wallets/:id/phrase",   group: "Wallets", auth: true, admin: false, desc: "Retrieve encrypted seed phrase" },

  // ── AI ──────────────────────────────────────────────────────────────────────
  { method: "POST",  path: "/ai/chat",        group: "AI", auth: true, admin: false, desc: "Send a message to the AYZEN AI assistant" },
  { method: "GET",   path: "/ai/models",      group: "AI", auth: true, admin: false, desc: "List available AI models" },

  // ── Broadcast ────────────────────────────────────────────────────────────────
  { method: "GET",   path: "/broadcast",       group: "Broadcast", auth: true, admin: true,  desc: "List broadcasts (admin only)" },
  { method: "POST",  path: "/broadcast",       group: "Broadcast", auth: true, admin: true,  desc: "Send a broadcast message (admin only)" },
  { method: "GET",   path: "/broadcast/inbox", group: "Broadcast", auth: true, admin: false, desc: "Get user's broadcast inbox" },

  // ── Notifications ────────────────────────────────────────────────────────────
  { method: "GET",   path: "/notifications",              group: "Notifications", auth: true, admin: false, desc: "List notifications" },
  { method: "GET",   path: "/notifications/unread-count", group: "Notifications", auth: true, admin: false, desc: "Get unread notification count" },
  { method: "PATCH", path: "/notifications/read-all",     group: "Notifications", auth: true, admin: false, desc: "Mark all notifications as read" },
  { method: "PATCH", path: "/notifications/:id/read",     group: "Notifications", auth: true, admin: false, desc: "Mark a single notification as read" },
  { method: "DELETE",path: "/notifications/:id",          group: "Notifications", auth: true, admin: false, desc: "Delete a notification" },

  // ── Messages ─────────────────────────────────────────────────────────────────
  { method: "GET",  path: "/messages/conversations",  group: "Messages", auth: true, admin: false, desc: "List message conversations" },
  { method: "GET",  path: "/messages/:otherUserId",   group: "Messages", auth: true, admin: false, desc: "Get messages with a specific user" },
  { method: "POST", path: "/messages/:toUserId",      group: "Messages", auth: true, admin: false, desc: "Send a message to a user" },
  { method: "GET",  path: "/messages/unread/count",   group: "Messages", auth: true, admin: false, desc: "Get unread message count" },

  // ── Credits ───────────────────────────────────────────────────────────────────
  { method: "GET",   path: "/credits",                      group: "Credits", auth: true, admin: false, desc: "Get user's credit/AZN balances" },
  { method: "POST",  path: "/credits/purchase",             group: "Credits", auth: true, admin: false, desc: "Purchase credits" },
  { method: "POST",  path: "/credits/swap",                 group: "Credits", auth: true, admin: false, desc: "Swap credits ↔ AZN" },
  { method: "POST",  path: "/credits/transfer",             group: "Credits", auth: true, admin: false, desc: "Transfer credits to another user" },
  { method: "GET",   path: "/admin/credits",                group: "Credits", auth: true, admin: true,  desc: "List pending credit purchases (admin only)" },
  { method: "POST",  path: "/admin/credits/:id/approve",    group: "Credits", auth: true, admin: true,  desc: "Approve a credit purchase (admin only)" },
  { method: "POST",  path: "/admin/credits/:id/reject",     group: "Credits", auth: true, admin: true,  desc: "Reject a credit purchase (admin only)" },

  // ── Subscriptions ─────────────────────────────────────────────────────────────
  { method: "GET",  path: "/plans",                              group: "Subscriptions", auth: true, admin: false, desc: "List available subscription plans" },
  { method: "GET",  path: "/subscription",                       group: "Subscriptions", auth: true, admin: false, desc: "Get user's current subscription" },
  { method: "POST", path: "/subscription/upgrade",               group: "Subscriptions", auth: true, admin: false, desc: "Request a subscription upgrade" },
  { method: "POST", path: "/subscription/manual-upgrade",        group: "Subscriptions", auth: true, admin: false, desc: "Submit manual payment for subscription" },
  { method: "GET",  path: "/admin/subscriptions",                group: "Subscriptions", auth: true, admin: true,  desc: "List subscription requests (admin only)" },
  { method: "POST", path: "/admin/subscriptions/:userId/approve",group: "Subscriptions", auth: true, admin: true,  desc: "Approve a subscription (admin only)" },
  { method: "POST", path: "/admin/subscriptions/:userId/reject", group: "Subscriptions", auth: true, admin: true,  desc: "Reject a subscription (admin only)" },

  // ── Leaderboard ──────────────────────────────────────────────────────────────
  { method: "GET", path: "/leaderboard", group: "Leaderboard", auth: true, admin: false, desc: "Global ROI leaderboard" },

  // ── Tools ────────────────────────────────────────────────────────────────────
  { method: "GET",  path: "/tools/gas",               group: "Tools", auth: true, admin: false, desc: "Gas prices across 20+ networks" },
  { method: "GET",  path: "/tools/gas/:network",      group: "Tools", auth: true, admin: false, desc: "Gas price for a specific network" },
  { method: "POST", path: "/tools/wallet-analysis",   group: "Tools", auth: true, admin: false, desc: "On-chain wallet analysis" },
  { method: "GET",  path: "/tools/streak/:userId",    group: "Tools", auth: true, admin: false, desc: "Daily streak data for a user" },
  { method: "POST", path: "/tools/spam-score",        group: "Tools", auth: true, admin: false, desc: "Get wallet spam score" },

  // ── Settings ─────────────────────────────────────────────────────────────────
  { method: "GET",   path: "/settings",            group: "Settings", auth: true, admin: true,  desc: "Get platform settings (admin only)" },
  { method: "PATCH", path: "/settings",            group: "Settings", auth: true, admin: true,  desc: "Update platform settings (admin only)" },
  { method: "POST",  path: "/settings/email/test", group: "Settings", auth: true, admin: true,  desc: "Send a test email (admin only)" },

  // ── Support ──────────────────────────────────────────────────────────────────
  { method: "GET",   path: "/support/tickets",           group: "Support", auth: true, admin: false, desc: "List support tickets" },
  { method: "POST",  path: "/support/tickets",           group: "Support", auth: true, admin: false, desc: "Create a support ticket" },
  { method: "GET",   path: "/support/tickets/:id",       group: "Support", auth: true, admin: false, desc: "Get a support ticket by ID" },
  { method: "POST",  path: "/support/tickets/:id/messages", group: "Support", auth: true, admin: false, desc: "Reply to a support ticket" },
  { method: "PATCH", path: "/support/tickets/:id",       group: "Support", auth: true, admin: true,  desc: "Update ticket status (admin only)" },
  { method: "GET",   path: "/support/stats",             group: "Support", auth: true, admin: true,  desc: "Support ticket statistics (admin only)" },

  // ── Referrals ────────────────────────────────────────────────────────────────
  { method: "GET",   path: "/referrals/me",                 group: "Referrals", auth: true, admin: false, desc: "Get user's referral info" },
  { method: "GET",   path: "/referrals/list",               group: "Referrals", auth: true, admin: false, desc: "List users referred by current user" },
  { method: "POST",  path: "/referrals/apply",              group: "Referrals", auth: true, admin: false, desc: "Apply a referral code" },
  { method: "GET",   path: "/admin/referrals",              group: "Referrals", auth: true, admin: true,  desc: "All referrals (admin only)" },
  { method: "GET",   path: "/admin/referrals/leaderboard",  group: "Referrals", auth: true, admin: true,  desc: "Referral leaderboard (admin only)" },

  // ── Telegram ─────────────────────────────────────────────────────────────────
  { method: "POST",  path: "/telegram/connect/verify", group: "Telegram", auth: true, admin: false, desc: "Connect Telegram via verification code" },
  { method: "GET",   path: "/telegram/me",             group: "Telegram", auth: true, admin: false, desc: "Get connected Telegram info" },
  { method: "DELETE",path: "/telegram/disconnect",     group: "Telegram", auth: true, admin: false, desc: "Disconnect Telegram" },
  { method: "POST",  path: "/telegram/broadcast",      group: "Telegram", auth: true, admin: true,  desc: "Broadcast to all connected Telegram users (admin only)" },
  { method: "GET",   path: "/telegram/status",         group: "Telegram", auth: true, admin: true,  desc: "Telegram bot status (admin only)" },

  // ── Events (SSE) ─────────────────────────────────────────────────────────────
  { method: "GET", path: "/events",                 group: "Realtime", auth: true, admin: false, desc: "Server-Sent Events stream for live updates" },
  { method: "GET", path: "/projects/:id/presence",  group: "Realtime", auth: true, admin: false, desc: "SSE presence stream for a project" },

  // ── Admin Logs / Telemetry ───────────────────────────────────────────────────
  { method: "GET",    path: "/admin/logs/stream",      group: "Admin", auth: true, admin: true, desc: "SSE stream of server logs (admin only)" },
  { method: "DELETE", path: "/admin/logs",             group: "Admin", auth: true, admin: true, desc: "Clear server logs (admin only)" },
  { method: "GET",    path: "/telemetry/functions",    group: "Admin", auth: true, admin: true, desc: "Function call counts (admin only)" },
  { method: "GET",    path: "/telemetry/errors",       group: "Admin", auth: true, admin: true, desc: "Recent error log (admin only)" },
  { method: "GET",    path: "/telemetry/ping",         group: "Admin", auth: false, admin: false, desc: "Ping the server (returns uptime)" },
  { method: "GET",    path: "/admin/telemetry/stream", group: "Admin", auth: true, admin: true,  desc: "SSE telemetry stream (admin only)" },

  // ── Plugins ──────────────────────────────────────────────────────────────────
  { method: "GET",   path: "/admin/plugins",        group: "Plugins", auth: true, admin: true, desc: "List admin plugins (admin only)" },
  { method: "PATCH", path: "/admin/plugins/:slug",  group: "Plugins", auth: true, admin: true, desc: "Enable/disable/configure a plugin (admin only)" },

  // ── Functions (this endpoint) ────────────────────────────────────────────────
  { method: "GET", path: "/functions",         group: "Meta", auth: false, admin: false, desc: "List all API endpoints (this response)" },
  { method: "GET", path: "/functions/errors",  group: "Meta", auth: false, admin: false, desc: "Error code library with solutions" },
];

router.get("/functions", (_req, res) => {
  const grouped: Record<string, typeof ENDPOINTS> = {};
  for (const ep of ENDPOINTS) {
    if (!grouped[ep.group]) grouped[ep.group] = [];
    grouped[ep.group].push(ep);
  }
  res.json({
    total: ENDPOINTS.length,
    basePath: "/api",
    note: "All endpoints prefixed with /api (e.g. GET /api/auth/me)",
    groups: grouped,
    endpoints: ENDPOINTS,
  });
});

router.get("/functions/errors", (_req, res) => {
  res.json({
    total: Object.keys(ERROR_LIBRARY).length,
    errors: ERROR_LIBRARY,
  });
});

export default router;
