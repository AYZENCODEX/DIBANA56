/**
 * lib/finance-late-fee-cron.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Late fee / overdue-interest auto-calc. Once a day, scans finance_ledger_entries
 * for anything past dueDate + lateFeeGraceDays with lateFeeType set and not yet
 * settled, computes the fee accrued since lateFeeLastCalcAt (or since the grace
 * period ended, if never calculated), adds it to both `amount` (what's owed
 * grows) and lateFeeAccrued (running total charged), flips status to 'overdue'
 * if it wasn't already paid/partial, and posts the accrual to the books via
 * postLateFeeAccrualJournal — same auto-posting pattern as postEntryJournal/
 * postRepaymentJournal.
 *
 * lateFeeType:
 *   'flat'            — one-time flat lateFeeRate amount, charged once (accrues
 *                        nothing further on later sweeps once already charged).
 *   'daily_percent'   — lateFeeRate% of the ORIGINAL entry.amount per day overdue.
 *   'monthly_percent' — lateFeeRate% of the ORIGINAL entry.amount per 30-day
 *                        period, prorated daily between sweeps.
 */
import cron from "node-cron";
import { db, financeLedgerEntriesTable, financeRepaymentsTable, type FinanceLedgerEntry } from "@workspace/db";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { logger } from "./logger";
import { logBus } from "./log-bus";
import { postLateFeeAccrualJournal } from "./finance-accounting";
import { createNotification } from "../routes/notifications";

const SETTLED_STATUSES = ["paid", "closed"];

// Original principal, excluding fees already tacked on. `entry.amount` is
// the *current outstanding* balance: it grows when a late fee accrues (see
// below) but also SHRINKS when a principal repayment is posted (see
// POST /finance/entries/:id/repayments — "amount reduces what's actually
// still owed"). So amount - lateFeeAccrued only equals the original
// principal for an entry with no repayments yet; once any principal has
// been repaid, that same subtraction under-counts the original amount by
// exactly what's been repaid. Add back principal repayments made so far to
// recover the true original, since daily_percent/monthly_percent are
// specified as a percentage of the ORIGINAL amount, not the shrinking
// outstanding balance (interest-only repayments never touch `amount`, so
// they're excluded here).
async function principal(entry: FinanceLedgerEntry): Promise<number> {
  const [{ repaid } = { repaid: 0 }] = await db.select({
    repaid: sql<number>`COALESCE(SUM(${financeRepaymentsTable.amount}), 0)`,
  }).from(financeRepaymentsTable)
    .where(and(eq(financeRepaymentsTable.entryId, entry.id), eq(financeRepaymentsTable.isInterest, 0)));
  return Math.max(0, entry.amount - entry.lateFeeAccrued + repaid);
}

async function computeAccrual(entry: FinanceLedgerEntry, since: Date, now: Date): Promise<number> {
  const rate = entry.lateFeeRate ?? 0;
  if (rate <= 0) return 0;

  if (entry.lateFeeType === "flat") {
    return entry.lateFeeAccrued > 0 ? 0 : rate;
  }
  const daysElapsed = Math.max(0, (now.getTime() - since.getTime()) / 86400000);
  if (daysElapsed <= 0) return 0;

  const base = await principal(entry);
  if (entry.lateFeeType === "daily_percent") {
    return base * (rate / 100) * daysElapsed;
  }
  if (entry.lateFeeType === "monthly_percent") {
    return base * (rate / 100) * (daysElapsed / 30);
  }
  return 0;
}

export async function runFinanceLateFeeSweep(): Promise<{ checked: number; accrued: number }> {
  const now = new Date();

  const candidates = await db.select().from(financeLedgerEntriesTable).where(and(
    isNotNull(financeLedgerEntriesTable.lateFeeType),
    isNotNull(financeLedgerEntriesTable.dueDate),
    sql`${financeLedgerEntriesTable.status} NOT IN (${sql.join(SETTLED_STATUSES.map(s => sql`${s}`), sql`, `)})`,
  ));

  let accruedCount = 0;

  for (const entry of candidates) {
    try {
      const graceEnd = new Date(entry.dueDate!);
      graceEnd.setDate(graceEnd.getDate() + (entry.lateFeeGraceDays ?? 0));
      if (now < graceEnd) continue;

      const since = entry.lateFeeLastCalcAt && entry.lateFeeLastCalcAt > graceEnd ? entry.lateFeeLastCalcAt : graceEnd;
      const fee = await computeAccrual(entry, since, now);
      if (fee <= 0.01) {
        // Still mark it overdue even if there's nothing new to accrue this sweep.
        if (entry.status === "pending") {
          await db.update(financeLedgerEntriesTable).set({ status: "overdue", updatedAt: now }).where(sql`id = ${entry.id}`);
        }
        continue;
      }

      const newStatus = entry.status === "pending" || entry.status === "overdue" ? "overdue" : entry.status;

      // BUG FIX: this used to compute `entry.amount + fee` / `entry.lateFeeAccrued
      // + fee` in JS from the row fetched at the top of the sweep, then write
      // those back — the same non-atomic read-then-write race already fixed
      // in POST /finance/entries/:id/repayments, the payment-agreement verify
      // route, and PUT /finance/amortization/:id/pay. A manual repayment (or
      // another concurrent write) landing on this entry between the sweep's
      // read and this write would have its effect on `amount` silently
      // clobbered by this accrual. Increment both columns atomically in SQL
      // and read back what the database actually holds afterward, same as
      // those other fixes.
      const [updated] = await db.update(financeLedgerEntriesTable).set({
        amount: sql`${financeLedgerEntriesTable.amount} + ${fee}`,
        lateFeeAccrued: sql`${financeLedgerEntriesTable.lateFeeAccrued} + ${fee}`,
        lateFeeLastCalcAt: now,
        status: newStatus, updatedAt: now,
      }).where(sql`id = ${entry.id}`).returning({ amount: financeLedgerEntriesTable.amount });
      const newAmount = updated?.amount ?? (entry.amount + fee);

      postLateFeeAccrualJournal(entry, fee).catch(() => {});
      createNotification(
        entry.userId, "finance_late_fee",
        `⏳ Late fee added — ${entry.title}`,
        `${entry.currency} ${fee.toLocaleString(undefined, { maximumFractionDigits: 2 })} late fee added. New total: ${entry.currency} ${newAmount.toLocaleString()}.`,
        { entryId: entry.id, fee },
      ).catch(() => {});

      accruedCount++;
    } catch (err: any) {
      logger.error({ err: err?.message, entryId: entry.id }, "Failed to accrue late fee");
      logBus.error(`Late fee accrual failed for entry #${entry.id}: ${err?.message ?? err}`);
    }
  }

  return { checked: candidates.length, accrued: accruedCount };
}

let scheduled = false;

export function startFinanceLateFeeCron(): void {
  if (scheduled) return;
  scheduled = true;

  const expr = process.env.FINANCE_LATE_FEE_CRON ?? "0 1 * * *"; // 01:00 daily
  if (!cron.validate(expr)) {
    logger.warn({ expr }, "FINANCE_LATE_FEE_CRON is not a valid cron expression — late fee auto-calc disabled");
    logBus.warn(`Late fee auto-calc cron disabled: invalid schedule "${expr}"`);
    return;
  }

  cron.schedule(expr, () => {
    runFinanceLateFeeSweep().catch((err) => {
      logger.error({ err }, "Late fee sweep failed");
      logBus.error(`Late fee sweep failed: ${err?.message ?? err}`);
    });
  });

  logBus.system(`✅ Late fee auto-calc cron scheduled ("${expr}")`);
  logger.info({ expr }, "Late fee auto-calc cron scheduled");
}
