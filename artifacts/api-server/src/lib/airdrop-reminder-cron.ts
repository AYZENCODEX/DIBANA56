/**
 * lib/airdrop-reminder-cron.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Airdrop calendar reminders — the whole point of the calendar (routes/
 * project-dates.ts) isn't just to look at it, it's to never miss a snapshot.
 * Once a day this scans project_dates for anything landing in the next
 * ~24-48h window that hasn't been reminded about yet, and pings every user
 * enrolled in that project over Telegram (same sendToUser used by
 * vault-health-scan.ts) plus an in-app notification.
 *
 * Schedule configurable via AIRDROP_REMINDER_CRON (default 10:00 server time
 * daily — after the vault health scan at 09:00). Kept separate/testable the
 * same way vault-health-cron.ts wraps vault-health-scan.ts.
 */
import cron from "node-cron";
import { db, projectDatesTable, projectsTable, projectEnrollmentsTable, usersTable } from "@workspace/db";
import { eq, and, gte, lte, isNull, inArray } from "drizzle-orm";
import { logger } from "./logger";
import { logBus } from "./log-bus";
import { sendToUser } from "./telegram";
import { createNotification } from "../routes/notifications";

const EVENT_LABEL: Record<string, string> = {
  snapshot: "📸 Token Snapshot", tge: "🚀 TGE", deadline: "⏰ Deadline",
  claim: "🎁 Claim Window", other: "📅 Important Date",
};

function fmtDate(d: Date): string {
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** Finds every project_dates row landing ~24h from now that hasn't been
 *  reminded about, and notifies every user enrolled in that project. */
export async function runAirdropReminderSweep(): Promise<{ datesChecked: number; usersNotified: number }> {
  const windowStart = new Date(Date.now() + 20 * 60 * 60 * 1000); // 20h out
  const windowEnd = new Date(Date.now() + 28 * 60 * 60 * 1000);   // 28h out — one daily
                                                                    // sweep comfortably covers "1 day before"

  const dueDates = await db.select({
    id: projectDatesTable.id,
    projectId: projectDatesTable.projectId,
    label: projectDatesTable.label,
    eventType: projectDatesTable.eventType,
    eventDate: projectDatesTable.eventDate,
    projectName: projectsTable.name,
  })
    .from(projectDatesTable)
    .leftJoin(projectsTable, eq(projectDatesTable.projectId, projectsTable.id))
    .where(and(
      isNull(projectDatesTable.remindedAt),
      gte(projectDatesTable.eventDate, windowStart),
      lte(projectDatesTable.eventDate, windowEnd),
    ));

  let usersNotified = 0;

  for (const d of dueDates) {
    const enrollments = await db.select({ userId: projectEnrollmentsTable.userId })
      .from(projectEnrollmentsTable)
      .where(eq(projectEnrollmentsTable.projectId, d.projectId));
    const userIds = [...new Set(enrollments.map((e) => e.userId))];
    if (userIds.length === 0) {
      await db.update(projectDatesTable).set({ remindedAt: new Date() }).where(eq(projectDatesTable.id, d.id));
      continue;
    }

    const users = await db.select({ id: usersTable.id, telegramChatId: usersTable.telegramChatId })
      .from(usersTable)
      .where(inArray(usersTable.id, userIds));

    const emoji = EVENT_LABEL[d.eventType] ?? EVENT_LABEL.other;
    const projectName = d.projectName ?? "Unknown project";
    const title = `${emoji} ${projectName} — ${d.label} tomorrow`;
    const message = `${d.label} for *${projectName}* is set for ${fmtDate(d.eventDate)} — less than a day away. Don't miss it.`;

    for (const u of users) {
      await createNotification(u.id, "airdrop_reminder", title, message, { projectId: d.projectId, projectDateId: d.id, eventDate: d.eventDate.toISOString() });
      if (u.telegramChatId) {
        await sendToUser(u.telegramChatId, `${emoji} *${projectName}*\n${d.label}: *${fmtDate(d.eventDate)}*\n\n⚠️ Less than 24h left — don't miss it.`);
      }
      usersNotified++;
    }

    await db.update(projectDatesTable).set({ remindedAt: new Date() }).where(eq(projectDatesTable.id, d.id));
    logBus.system(`Airdrop reminder sent: "${d.label}" (${projectName}) → ${users.length} user(s)`);
  }

  return { datesChecked: dueDates.length, usersNotified };
}

let scheduled = false;

export function startAirdropReminderCron(): void {
  if (scheduled) return; // guard against double-init (e.g. hot reload)
  scheduled = true;

  const expr = process.env.AIRDROP_REMINDER_CRON ?? "0 10 * * *";
  if (!cron.validate(expr)) {
    logger.warn({ expr }, "AIRDROP_REMINDER_CRON is not a valid cron expression — airdrop reminder cron disabled");
    logBus.warn(`Airdrop reminder cron disabled: invalid schedule "${expr}"`);
    return;
  }

  cron.schedule(expr, () => {
    runAirdropReminderSweep().catch((err) => {
      logger.error({ err }, "Airdrop reminder sweep failed");
      logBus.error(`Airdrop reminder sweep failed: ${err?.message ?? err}`);
    });
  });

  logBus.system(`✅ Airdrop reminder cron scheduled ("${expr}")`);
  logger.info({ expr }, "Airdrop reminder cron scheduled");
}
