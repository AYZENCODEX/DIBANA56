/**
 * lib/finance-invoice-reminder-cron.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Overdue Finance-invoice nudge — email/Telegram, sent to the DEBTOR, once the
 * invoice's due date has passed. Distinct from finance-reminder-cron.ts (an
 * in-app notification to the *creditor*, fired up to 3 days *before* a
 * ledger entry is due) — this one runs after the due date, targets whoever
 * owes the money, and re-fires periodically until the invoice is settled or
 * cancelled. Same daily-sweep + lastSentAt-style dedup shape as
 * finance-report-schedule-cron.ts.
 */
import cron from "node-cron";
import { db, financeInvoicesTable, usersTable } from "@workspace/db";
import { and, lt, or, isNull, sql } from "drizzle-orm";
import { logger } from "./logger";
import { logBus } from "./log-bus";
import { financeInvoiceUrl, logInvoiceEvent } from "./finance-invoice";
import { sendInvoiceOverdueReminderEmail } from "./email";
import { sendToUserWithButton } from "./telegram";

// "disputed" is intentionally excluded from reminders: the debtor has already
// flagged the payment claim as disputed and is waiting on the creditor's
// review, so nagging them with an overdue reminder is confusing/unwanted UX.
const SETTLED_STATUSES: string[] = ["paid", "settled", "cancelled", "void", "disputed"];

function reminderIntervalMs(): number {
  const days = Number(process.env.FINANCE_INVOICE_REMINDER_INTERVAL_DAYS ?? "3");
  return (Number.isFinite(days) && days > 0 ? days : 3) * 24 * 60 * 60 * 1000;
}

export async function runFinanceInvoiceReminderSweep(): Promise<{ checked: number; sent: number }> {
  const now = new Date();
  const reminderCutoff = new Date(now.getTime() - reminderIntervalMs());

  const due = await db.select().from(financeInvoicesTable).where(and(
    lt(financeInvoicesTable.dueDate, now),
    sql`${financeInvoicesTable.status} NOT IN (${sql.join(SETTLED_STATUSES.map(s => sql`${s}`), sql`, `)})`,
    or(isNull(financeInvoicesTable.lastReminderAt), lt(financeInvoicesTable.lastReminderAt, reminderCutoff)),
  ));

  let sent = 0;
  for (const invoice of due) {
    try {
      const [creditor] = await db.select({ username: usersTable.username }).from(usersTable).where(sql`id = ${invoice.userId}`);
      const creditorName = creditor?.username ?? "Someone on AYZEN";
      const url = financeInvoiceUrl(invoice.invoiceToken);
      const remaining = Math.max(0, invoice.amount - invoice.paidAmount);
      const daysOverdue = Math.max(0, Math.ceil((now.getTime() - new Date(invoice.dueDate!).getTime()) / 86400000));
      const amountStr = `${invoice.currency} ${invoice.amount.toLocaleString()}`;
      const remainingStr = `${invoice.currency} ${remaining.toLocaleString()}`;

      let sentEmail = false, sentTelegram = false;
      if (invoice.debtorEmail) {
        const result = await sendInvoiceOverdueReminderEmail(invoice.debtorEmail, {
          debtorName: invoice.debtorName, creditorName, title: `Invoice #${invoice.id}`,
          amount: amountStr, remainingAmount: remainingStr, daysOverdue, url,
        });
        sentEmail = result.success;
      }
      if (invoice.debtorTelegramChatId) {
        await sendToUserWithButton(
          invoice.debtorTelegramChatId,
          `⏰ *Payment overdue*\n\nYour invoice from ${creditorName} was due ${daysOverdue} day(s) ago.\n\nRemaining: *${remainingStr}*`,
          "💳 Repay Now",
          url,
        );
        sentTelegram = true;
      }

      if (sentEmail || sentTelegram) {
        await db.update(financeInvoicesTable).set({
          lastReminderAt: now, reminderCount: sql`${financeInvoicesTable.reminderCount} + 1`, updatedAt: now,
        }).where(sql`id = ${invoice.id}`);
        logInvoiceEvent(invoice.id, "overdue_reminder_sent", undefined, { daysOverdue, sentEmail, sentTelegram }).catch(() => {});
        sent++;
      }
    } catch (err: any) {
      logger.error({ err: err?.message, invoiceId: invoice.id }, "Failed to send overdue invoice reminder");
      logBus.error(`Overdue invoice reminder #${invoice.id} failed: ${err?.message ?? err}`);
    }
  }

  return { checked: due.length, sent };
}

let scheduled = false;

export function startFinanceInvoiceReminderCron(): void {
  if (scheduled) return;
  scheduled = true;

  const expr = process.env.FINANCE_INVOICE_REMINDER_CRON ?? "30 9 * * *"; // 09:30 daily
  if (!cron.validate(expr)) {
    logger.warn({ expr }, "FINANCE_INVOICE_REMINDER_CRON is not a valid cron expression — overdue invoice reminders disabled");
    logBus.warn(`Overdue invoice reminders cron disabled: invalid schedule "${expr}"`);
    return;
  }

  cron.schedule(expr, () => {
    runFinanceInvoiceReminderSweep().catch((err) => {
      logger.error({ err }, "Overdue invoice reminder sweep failed");
      logBus.error(`Overdue invoice reminder sweep failed: ${err?.message ?? err}`);
    });
  });

  logBus.system(`✅ Overdue invoice reminders cron scheduled ("${expr}")`);
  logger.info({ expr }, "Overdue invoice reminders cron scheduled");
}
