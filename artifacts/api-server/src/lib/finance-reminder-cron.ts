/**
 * lib/finance-reminder-cron.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Finance due-date reminders. Once a day, scans finance_ledger_entries for
 * anything due within the next 3 days (payables, receivables, borrowed funds)
 * that hasn't been reminded about yet and fires an in-app notification
 * (same createNotification helper used across the app). remindedAt is
 * per-entry so it only ever fires once per due date, even if the sweep runs
 * daily and the item stays in the "next 3 days" window across multiple runs.
 */
import cron from "node-cron";
import { db, financeLedgerEntriesTable } from "@workspace/db";
import { and, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { logger } from "./logger";
import { logBus } from "./log-bus";
import { createNotification } from "../routes/notifications";

const KIND_ICON: Record<string, string> = {
  payable: "📤", borrowed: "🏦", receivable: "📥", lending: "🤝", expense: "💸",
};

// Mirrors artifacts/ayzen/src/config/finance.ts's CURRENCY_SYMBOLS — kept as
// a local copy since the API server and the frontend app are separate
// packages. Falls back to the raw currency code (e.g. "XYZ ") for anything
// not in the map, same as the frontend's fmtMoney().
const CURRENCY_SYMBOLS: Record<string, string> = {
  BDT: "৳", USD: "$", EUR: "€", GBP: "£", INR: "₹", AED: "د.إ", SGD: "S$",
};
function currencySymbol(currency: string): string {
  return CURRENCY_SYMBOLS[currency] ?? `${currency} `;
}

export async function runFinanceReminderSweep(): Promise<{ entriesChecked: number; remindersSent: number }> {
  const windowEnd = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);

  const dueEntries = await db.select().from(financeLedgerEntriesTable)
    .where(and(
      isNotNull(financeLedgerEntriesTable.dueDate),
      isNull(financeLedgerEntriesTable.remindedAt),
      lte(financeLedgerEntriesTable.dueDate, windowEnd),
      sql`${financeLedgerEntriesTable.status} NOT IN ('paid', 'closed')`,
    ));

  let remindersSent = 0;

  for (const e of dueEntries) {
    const days = Math.max(0, Math.ceil((e.dueDate!.getTime() - Date.now()) / 86400000));
    const icon = KIND_ICON[e.kind] ?? "💰";
    const direction = e.kind === "payable" || e.kind === "borrowed" ? "dite hobe" : "pabe";
    await createNotification(
      e.userId,
      "finance_reminder",
      `${icon} ${e.title} — ${days === 0 ? "today" : `${days}d`}`,
      `${e.title}: ${currencySymbol(e.currency)}${e.amount.toLocaleString()} ${direction}${days === 0 ? " today" : ` in ${days} day(s)`}.`,
      { entryId: e.id, kind: e.kind, dueDate: e.dueDate },
    );
    await db.update(financeLedgerEntriesTable).set({ remindedAt: new Date() }).where(sql`id = ${e.id}`);
    remindersSent++;
  }

  return { entriesChecked: dueEntries.length, remindersSent };
}

let scheduled = false;

export function startFinanceReminderCron() {
  if (scheduled) return;
  scheduled = true;

  const expr = process.env.FINANCE_REMINDER_CRON ?? "0 9 * * *"; // 09:00 daily
  if (!cron.validate(expr)) {
    logger.warn({ expr }, "FINANCE_REMINDER_CRON is not a valid cron expression — finance reminder cron disabled");
    logBus.warn(`Finance reminder cron disabled: invalid schedule "${expr}"`);
    return;
  }

  cron.schedule(expr, () => {
    runFinanceReminderSweep().catch((err) => {
      logger.error({ err }, "Finance reminder sweep failed");
      logBus.error(`Finance reminder sweep failed: ${err?.message ?? err}`);
    });
  });

  logBus.system(`✅ Finance reminder cron scheduled ("${expr}")`);
  logger.info({ expr }, "Finance reminder cron scheduled");
}
