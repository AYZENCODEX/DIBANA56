/**
 * lib/finance-recurring-cron.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Finance recurring engine. Once a day, scans finance_recurring_rules for any
 * rule whose nextRunDate has passed, materializes a real
 * finance_ledger_entries row from it (tagged with recurringRuleId so it's
 * traceable back to the template), and advances nextRunDate by the rule's
 * frequency. A rule can fall behind (server downtime, etc) — each sweep
 * catches it up one period at a time rather than looping unboundedly, and
 * will finish catching up on the following day's sweep.
 */
import cron from "node-cron";
import { db, financeRecurringRulesTable, financeLedgerEntriesTable } from "@workspace/db";
import { eq, and, lte, sql } from "drizzle-orm";
import { logger } from "./logger";
import { logBus } from "./log-bus";
import { createAndSendRuleInvoice } from "./finance-invoice";
import { postEntryJournal, resolveBookId } from "./finance-accounting";

// BUG FIX: `d.setMonth(d.getMonth() + intervalCount)` overflows into the
// following month when the current day-of-month doesn't exist in the
// target month (e.g. a rule created on Jan 31 would next run Mar 3, not
// Feb 28/29 — same underlying JS Date rollover bug fixed in
// lib/finance-accounting.ts's addMonths). For a recurring rent/EMI/
// subscription rule that drifts its due date forward a little further
// every time it fires, eventually skipping or doubling up months. Yearly
// has the same issue for Feb 29 rules. Clamp to the last valid day of the
// target month in both cases.
function setMonthClamped(d: Date, targetMonth: number): void {
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(targetMonth);
  const lastDayOfTargetMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, lastDayOfTargetMonth));
}

function advance(date: Date, frequency: string, intervalCount: number): Date {
  const d = new Date(date);
  switch (frequency) {
    case "daily": d.setDate(d.getDate() + intervalCount); break;
    case "weekly": d.setDate(d.getDate() + 7 * intervalCount); break;
    case "yearly": setMonthClamped(d, d.getMonth() + 12 * intervalCount); break;
    case "monthly":
    default: setMonthClamped(d, d.getMonth() + intervalCount); break;
  }
  return d;
}

export async function runFinanceRecurringSweep(): Promise<{ rulesChecked: number; entriesCreated: number }> {
  const now = new Date();
  const dueRules = await db.select().from(financeRecurringRulesTable)
    .where(and(eq(financeRecurringRulesTable.active, 1), lte(financeRecurringRulesTable.nextRunDate, now)));

  let entriesCreated = 0;

  for (const rule of dueRules) {
    if (rule.endDate && rule.nextRunDate > rule.endDate) {
      await db.update(financeRecurringRulesTable).set({ active: 0, updatedAt: new Date() }).where(eq(financeRecurringRulesTable.id, rule.id));
      continue;
    }

    // financeRecurringRulesTable has no bookId of its own — resolve the
    // rule owner's default book so this entry follows the same "every
    // write path resolves a concrete bookId before insert" rule as every
    // other entry-creation path (see financeLedgerEntriesTable.bookId's
    // doc comment). Without this, entries land with bookId = null and
    // silently disappear from GET /finance/entries, which always filters
    // on a resolved (non-null) bookId.
    const resolvedBookId = await resolveBookId(rule.userId);

    const [entry] = await db.insert(financeLedgerEntriesTable).values({
      userId: rule.userId,
      bookId: resolvedBookId,
      kind: rule.kind,
      title: rule.title,
      amount: rule.amount,
      currency: rule.currency,
      partyId: rule.partyId,
      projectId: rule.projectId,
      category: rule.category,
      interestRate: rule.interestRate,
      dueDate: rule.nextRunDate,
      occurredDate: rule.nextRunDate,
      status: "pending",
      notes: rule.notes,
      recurringRuleId: rule.id,
    }).returning();
    entriesCreated++;

    // Every other entry-creation path (POST /finance/entries, amortization
    // installments, late-fee accrual, ...) posts an opening journal entry
    // so Trial Balance / Balance Sheet / Income Statement stay accurate.
    // This was previously skipped here, so every recurring-generated entry
    // (rent, EMI, subscriptions) was silently invisible to those reports.
    if (entry) postEntryJournal(entry).catch(() => {}); // best-effort — never blocks the sweep

    // Rent/loan-EMI style: also mint + auto-send an invoice against the
    // entry just created, if this rule opted in.
    if (rule.autoInvoice && entry) {
      createAndSendRuleInvoice(entry, rule).catch(() => {});
    }

    const next = advance(rule.nextRunDate, rule.frequency, rule.intervalCount);
    const stillActive = !rule.endDate || next <= rule.endDate;
    await db.update(financeRecurringRulesTable)
      .set({ nextRunDate: next, lastRunAt: now, active: stillActive ? 1 : 0, updatedAt: new Date() })
      .where(eq(financeRecurringRulesTable.id, rule.id));
  }

  return { rulesChecked: dueRules.length, entriesCreated };
}

let scheduled = false;

export function startFinanceRecurringCron() {
  if (scheduled) return;
  scheduled = true;

  const expr = process.env.FINANCE_RECURRING_CRON ?? "15 0 * * *"; // 00:15 daily
  if (!cron.validate(expr)) {
    logger.warn({ expr }, "FINANCE_RECURRING_CRON is not a valid cron expression — finance recurring cron disabled");
    logBus.warn(`Finance recurring cron disabled: invalid schedule "${expr}"`);
    return;
  }

  cron.schedule(expr, () => {
    runFinanceRecurringSweep().catch((err) => {
      logger.error({ err }, "Finance recurring sweep failed");
      logBus.error(`Finance recurring sweep failed: ${err?.message ?? err}`);
    });
  });

  logBus.system(`✅ Finance recurring cron scheduled ("${expr}")`);
  logger.info({ expr }, "Finance recurring cron scheduled");
}
