/**
 * lib/notification-bus.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Workspace — Phase 7: Notification Bus (master plan §6, detailed in §11).
 *
 * Before this, every module that wanted to notify a user reinvented the same
 * three-channel delivery (in-app bell + Telegram + email) from scratch —
 * see lib/finance-notify.ts, lib/mail-notification-digest.ts, and the raw
 * `INSERT INTO notifications` in routes/marketplace.ts. That's fine for one
 * module, but master plan §6 calls for "a Ryft repayment, a Skarn claim
 * window, and a Verve offer all surface through one consistent in-app +
 * Astra + (optionally) Wisp email notification, instead of each app
 * reinventing alerts" — this file is that one place.
 *
 * This is deliberately a thin ROUTER, not a new source of truth:
 *  - in-app bell        → reuses routes/notifications.ts's createNotification
 *  - Telegram           → reuses lib/telegram.ts's sendToUser
 *  - email              → reuses lib/email.ts's sendNotificationEmail
 *  - Astra toolbar badge → reuses routes/events.ts's broadcastToUser (SSE),
 *                          under a distinct "astra_badge" event name so the
 *                          extension can listen for badge counts specifically
 *                          without also having to parse every "notification"
 *                          SSE event meant for the in-app bell UI.
 * No channel's delivery logic lives here — only the decision of *whether*
 * to call it, per the user's notification_preferences row (migration 108).
 *
 * Producer functions below (notifyRyftRepaymentPosted, etc.) are the
 * per-app call sites wire into. Adding a new one is: pick a category, pick
 * an event type string, write the title/message, call emitEvent(). No new
 * channel plumbing required — that's the whole point of the bus existing.
 */
import { db, usersTable, notificationPreferencesTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { logger } from "./logger";
import { createNotification } from "../routes/notifications";
import { sendToUser } from "./telegram";
import { sendNotificationEmail } from "./email";
import { broadcastToUser } from "../routes/events";

export type NotificationCategory = "ryft" | "skarn" | "verve" | "warde" | "sylo" | "wisp" | "system";

interface EmitEventParams {
  userId: number;
  category: NotificationCategory;
  type: string; // e.g. "ryft.repayment.posted", "verve.offer.received"
  title: string;
  message: string;
  data?: Record<string, unknown>;
}

interface ChannelFlags {
  inApp: boolean;
  telegram: boolean;
  email: boolean;
  astra: boolean;
}

const DEFAULT_CHANNELS: ChannelFlags = { inApp: true, telegram: true, email: true, astra: true };

/** No row for this (user, category) yet = every channel on (opt-out model — see migration 108). */
async function getChannelFlags(userId: number, category: NotificationCategory): Promise<ChannelFlags> {
  try {
    const [row] = await db.select().from(notificationPreferencesTable)
      .where(and(eq(notificationPreferencesTable.userId, userId), eq(notificationPreferencesTable.category, category)))
      .limit(1);
    if (!row) return DEFAULT_CHANNELS;
    return { inApp: row.inApp, telegram: row.telegram, email: row.email, astra: row.astra };
  } catch {
    return DEFAULT_CHANNELS; // preference lookup failing should never block delivery
  }
}

/**
 * Emit one event across every channel the user has enabled for its
 * category. Best-effort and non-throwing — a notification-delivery bug in
 * any one channel must never block the caller's actual work (a repayment
 * being posted, an offer being created, etc.), same posture every existing
 * per-module notify function already took.
 */
export async function emitEvent(params: EmitEventParams): Promise<void> {
  const { userId, category, type, title, message, data } = params;
  try {
    const [user, flags] = await Promise.all([
      db.select({
        id: usersTable.id, username: usersTable.username, email: usersTable.email,
        telegramChatId: usersTable.telegramChatId,
      }).from(usersTable).where(eq(usersTable.id, userId)).limit(1).then(r => r[0]),
      getChannelFlags(userId, category),
    ]);
    if (!user) return;

    if (flags.inApp) {
      createNotification(userId, type, title, message, data).catch(err =>
        logger.warn({ err: err?.message, type, userId }, "notification-bus: in-app delivery failed"));
    }
    if (flags.telegram && user.telegramChatId) {
      sendToUser(user.telegramChatId, `*${title}*\n\n${message}`).catch(err =>
        logger.warn({ err: err?.message, type, userId }, "notification-bus: telegram delivery failed"));
    }
    if (flags.email && user.email) {
      sendNotificationEmail(user.email, user.username, { category, title, message }).catch(err =>
        logger.warn({ err: err?.message, type, userId }, "notification-bus: email delivery failed"));
    }
    if (flags.astra) {
      // Fire-and-forget SSE push; broadcastToUser is a no-op for a user
      // with no open extension connection, same as it is for the web bell.
      broadcastToUser(userId, "astra_badge", { category, type, title, data: data ?? {} });
    }
  } catch (err: any) {
    logger.warn({ err: err?.message, type, userId }, "notification-bus: emitEvent failed");
  }
}

// ─── Producers ────────────────────────────────────────────────────────────
// Thin, typed wrappers per event so call sites don't hand-format
// title/message strings inline and category/type strings can't drift
// between producer and any future consumer (e.g. developers.ayzen.tech
// webhooks, master plan §12, subscribing to these same event types).

export async function notifyRyftRepaymentPosted(
  userId: number, entryTitle: string, amountStr: string, isInterest: boolean,
): Promise<void> {
  await emitEvent({
    userId, category: "ryft", type: "ryft.repayment.posted",
    title: `💵 Repayment posted — ${entryTitle}`,
    message: `${isInterest ? "Interest" : "Principal"} repayment of ${amountStr} recorded against "${entryTitle}".`,
    data: { entryTitle, amountStr, isInterest },
  });
}

export async function notifyVerveOfferReceived(
  sellerId: number, listingTitle: string, priceAzn: number, buyerUsername: string,
): Promise<void> {
  await emitEvent({
    userId: sellerId, category: "verve", type: "verve.offer.received",
    title: `🛒 New offer — ${listingTitle}`,
    message: `${buyerUsername} offered ${priceAzn} AZN on your listing "${listingTitle}".`,
    data: { listingTitle, priceAzn, buyerUsername },
  });
}

export async function notifyVerveOrderResolved(
  buyerId: number, action: "approve" | "reject", message: string,
): Promise<void> {
  await emitEvent({
    userId: buyerId, category: "verve", type: `verve.order.${action === "approve" ? "approved" : "rejected"}`,
    title: `📦 Order ${action === "approve" ? "approved" : "rejected"}`,
    message,
  });
}

export async function notifyWardeMemberInvited(inviteeId: number, teamId: number, teamName?: string): Promise<void> {
  await emitEvent({
    userId: inviteeId, category: "warde", type: "warde.member.invited",
    title: `👥 Team invite — ${teamName ?? `Team #${teamId}`}`,
    message: `You've been added to ${teamName ?? `Team #${teamId}`}.`,
    data: { teamId },
  });
}

/** Phase 8 — Organization Accounts. Reuses the "warde" category (master
 *  plan §2: Warde is the org-accounts brand), same as notifyWardeMemberInvited
 *  above — a farming-team invite and an org invite are both "Warde" from
 *  the user's notification-preferences point of view, even though they're
 *  backed by different tables (team_members vs. organization_members). */
export async function notifyOrganizationInvited(inviteeId: number, organizationId: number, organizationName: string): Promise<void> {
  await emitEvent({
    userId: inviteeId, category: "warde", type: "warde.organization.invited",
    title: `🏢 Organization invite — ${organizationName}`,
    message: `You've been invited to join ${organizationName}.`,
    data: { organizationId },
  });
}

export async function notifyOrganizationRoleChanged(userId: number, organizationId: number, organizationName: string, newRole: string): Promise<void> {
  await emitEvent({
    userId, category: "warde", type: "warde.organization.role_changed",
    title: `🏢 Role updated — ${organizationName}`,
    message: `Your role in ${organizationName} is now "${newRole}".`,
    data: { organizationId, newRole },
  });
}

/**
 * Skarn (airdrop farming / "Protocols") has no dedicated claim-window
 * scheduler in this codebase yet — projects/tasks carry deadlines, but
 * nothing currently computes "a snapshot/claim window is opening soon" as
 * a distinct event the way Finance's late-fee cron or vault's health scan
 * do. The bus is ready for it (this producer + the "skarn" category both
 * work end to end today), but wiring a real producer means someone first
 * builds that scheduler — documented here rather than faked with a stub
 * caller that always fires immediately, which would just be a fake event.
 */
export async function notifySkarnClaimWindowOpening(
  userId: number, projectName: string, opensInMinutes: number,
): Promise<void> {
  await emitEvent({
    userId, category: "skarn", type: "skarn.claim_window.opening",
    title: `⏰ Claim window opening — ${projectName}`,
    message: `${projectName}'s claim window opens in ${opensInMinutes} minutes.`,
    data: { projectName, opensInMinutes },
  });
}
