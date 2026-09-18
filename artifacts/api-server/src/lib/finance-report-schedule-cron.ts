/**
 * lib/finance-report-schedule-cron.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase 4 "Scheduled formal PDF reports" — the monthly-P&L-auto-email item,
 * generalized to any of the double-entry reports (Income Statement, Balance
 * Sheet, Trial Balance, Cash Flow) on a per-schedule fixed day of month. See
 * finance_report_schedules (lib/db/src/schema/finance.ts) for the schedule
 * row shape and routes/finance.ts for its CRUD.
 *
 * Deliberately separate from the daily digest (finance-notify.ts /
 * finance-digest-cron.ts) — that's a lightweight "what changed" activity
 * rollup pushed every day; this is a formal document (real PDF attachment)
 * sent on a fixed day of the month, same distinction the schema comment on
 * financeReportSchedulesTable makes.
 *
 * Runs a daily check (env FINANCE_REPORT_SCHEDULE_CRON, default 09:00) since
 * "day N of the month" isn't expressible as a single 5-field cron schedule
 * shared across all rows — each due schedule is matched against today's
 * date-of-month, gated by lastSentAt so a wider check window or a restart
 * never double-sends within the same month.
 */
import cron from "node-cron";
import PDFDocument from "pdfkit";
import { PassThrough } from "stream";
import { db, usersTable, financeReportSchedulesTable, financeBooksTable, type FinanceReportSchedule } from "@workspace/db";
import { eq, and, or, isNull, lt, sql } from "drizzle-orm";
import { logger } from "./logger";
import { logBus } from "./log-bus";
import { computeAccountBalances, listBooks, type AccountBalanceRow } from "./finance-accounting";
import { sendEmail } from "./email";

const REPORT_LABELS: Record<string, string> = {
  income_statement: "Income Statement",
  balance_sheet: "Balance Sheet",
  trial_balance: "Trial Balance",
  cash_flow: "Cash Flow (summary)",
};

function money(n: number): string {
  return `BDT ${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function monthBounds(d: Date): { from: Date; to: Date } {
  const from = new Date(d.getFullYear(), d.getMonth(), 1);
  const to = new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59);
  return { from, to };
}

// Any day within the month immediately before `d`'s month — e.g. for a
// schedule that runs on the 1st, this resolves to a date inside the month
// that just ended, so monthBounds() below returns that completed month's
// range rather than the handful-of-hours-old month that just started.
function previousMonthReference(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth() - 1, 1);
}

// BUG FIX: financeReportSchedulesTable's own schema comment defines a null
// bookId as "all books combined" — and this cron labels the email exactly
// that way ("All books" below) — but computeAccountBalances(userId, {
// bookId: null }) actually calls resolveBookId(userId, null), which
// resolves to just the user's *default* book, not every book. A user with
// e.g. separate Personal and Business books who scheduled an "All books"
// report was silently getting only their default book's figures every
// month, with everything else missing and no indication anything was left
// out. Sum each book's balances (by account code) instead of resolving to one.
async function computeAllBooksAccountBalances(userId: number, opts: { from?: Date; to?: Date }): Promise<AccountBalanceRow[]> {
  const books = await listBooks(userId);
  const perBook = await Promise.all(books.map(b => computeAccountBalances(userId, { ...opts, bookId: b.id })));
  const merged = new Map<string, AccountBalanceRow>();
  for (const rows of perBook) {
    for (const r of rows) {
      const existing = merged.get(r.code);
      if (existing) {
        existing.totalDebit += r.totalDebit;
        existing.totalCredit += r.totalCredit;
        existing.balance += r.balance;
      } else {
        merged.set(r.code, { ...r });
      }
    }
  }
  return [...merged.values()].sort((a, b) => a.code.localeCompare(b.code));
}

/** Renders one of the 4 report types as a PDF buffer for a user/book/period covering the month containing `reportDate`. */
async function renderReportPdf(userId: number, bookId: number | null, reportType: string, periodLabel: string, reportDate: Date): Promise<Buffer> {
  const { from, to } = monthBounds(reportDate);
  const rows: AccountBalanceRow[] = bookId == null
    ? await computeAllBooksAccountBalances(userId, reportType === "trial_balance" || reportType === "balance_sheet" ? { to } : { from, to })
    : reportType === "trial_balance" || reportType === "balance_sheet"
      ? await computeAccountBalances(userId, { to, bookId })
      : await computeAccountBalances(userId, { from, to, bookId });

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40, size: "A4" });
    const stream = new PassThrough();
    const chunks: Buffer[] = [];
    stream.on("data", (c) => chunks.push(c));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
    doc.pipe(stream);

    doc.fontSize(18).fillColor("#000").text(`${REPORT_LABELS[reportType] ?? reportType}`, { align: "left" });
    doc.fontSize(10).fillColor("#555").text(periodLabel);
    doc.moveDown(1);
    doc.fillColor("#000").fontSize(11);

    if (reportType === "balance_sheet") {
      const assets = rows.filter(r => r.type === "asset");
      const liabilities = rows.filter(r => r.type === "liability");
      const equity = rows.filter(r => r.type === "equity");
      const section = (title: string, list: AccountBalanceRow[]) => {
        doc.fontSize(13).text(title);
        doc.fontSize(10);
        for (const r of list) doc.text(`${r.code}  ${r.name}`, { continued: true }), doc.text(`  ${money(r.balance)}`, { align: "right" });
        doc.moveDown(0.5);
      };
      section("Assets", assets);
      section("Liabilities", liabilities);
      section("Equity", equity);
    } else if (reportType === "income_statement" || reportType === "cash_flow") {
      const income = rows.filter(r => r.type === "income");
      const expense = rows.filter(r => r.type === "expense");
      doc.fontSize(13).text("Income");
      doc.fontSize(10);
      for (const r of income) doc.text(`${r.code}  ${r.name}`, { continued: true }), doc.text(`  ${money(r.balance)}`, { align: "right" });
      doc.moveDown(0.5);
      doc.fontSize(13).text("Expenses");
      doc.fontSize(10);
      for (const r of expense) doc.text(`${r.code}  ${r.name}`, { continued: true }), doc.text(`  ${money(r.balance)}`, { align: "right" });
      const totalIncome = income.reduce((s, r) => s + r.balance, 0);
      const totalExpense = expense.reduce((s, r) => s + r.balance, 0);
      doc.moveDown(1);
      doc.fontSize(13).text(`Net Income: ${money(totalIncome - totalExpense)}`);
    } else {
      // trial_balance
      doc.fontSize(10);
      for (const r of rows) {
        doc.text(`${r.code}  ${r.name} (${r.type})`, { continued: true });
        doc.text(`  Dr ${money(r.totalDebit)}  Cr ${money(r.totalCredit)}`, { align: "right" });
      }
    }

    doc.end();
  });
}

/** Finds and sends every schedule due today. Never throws — logs and continues past individual failures. */
export async function runFinanceReportSchedules(): Promise<void> {
  const today = new Date();
  const dayOfMonth = today.getDate();
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);

  const due = await db.select().from(financeReportSchedulesTable).where(and(
    eq(financeReportSchedulesTable.active, 1),
    eq(financeReportSchedulesTable.dayOfMonth, dayOfMonth),
    or(isNull(financeReportSchedulesTable.lastSentAt), lt(financeReportSchedulesTable.lastSentAt, monthStart)),
  ));
  if (due.length === 0) return;

  for (const schedule of due) {
    try {
      const [user] = await db.select({ id: usersTable.id, email: usersTable.email, username: usersTable.username })
        .from(usersTable).where(eq(usersTable.id, schedule.userId)).limit(1);
      if (!user?.email) continue;

      let bookLabel = "All books";
      if (schedule.bookId) {
        const [book] = await db.select({ name: financeBooksTable.name }).from(financeBooksTable).where(eq(financeBooksTable.id, schedule.bookId)).limit(1);
        bookLabel = book?.name ?? bookLabel;
      }
      // Report the month that just completed, not today's (still in
      // progress) month — a schedule firing on the 1st should mail out
      // last month's numbers, not a near-empty one-day snapshot of the
      // month that started hours ago.
      const reportMonth = previousMonthReference(today);
      const monthLabel = reportMonth.toLocaleString("en-US", { month: "long", year: "numeric" });
      const periodLabel = `${bookLabel} · ${monthLabel}`;
      const pdf = await renderReportPdf(schedule.userId, schedule.bookId, schedule.reportType, periodLabel, reportMonth);
      const reportLabel = REPORT_LABELS[schedule.reportType] ?? schedule.reportType;

      await sendEmail({
        to: user.email,
        subject: `📊 ${reportLabel} — ${monthLabel}`,
        html: `<p>Your scheduled <strong>${reportLabel}</strong> for <strong>${bookLabel}</strong> is attached.</p>`,
        text: `Your scheduled ${reportLabel} for ${bookLabel} is attached.`,
        attachments: [{ filename: `${schedule.reportType}-${reportMonth.toISOString().slice(0, 7)}.pdf`, content: pdf, contentType: "application/pdf" }],
      });

      await db.update(financeReportSchedulesTable).set({ lastSentAt: today, updatedAt: today }).where(eq(financeReportSchedulesTable.id, schedule.id));
      logBus.system(`✅ Sent scheduled ${reportLabel} to user #${schedule.userId}`);
    } catch (err: any) {
      logger.error({ err: err?.message, scheduleId: schedule.id }, "Failed to send scheduled finance report");
      logBus.error(`Scheduled finance report #${schedule.id} failed: ${err?.message ?? err}`);
    }
  }
}

let scheduled = false;

export function startFinanceReportScheduleCron(): void {
  if (scheduled) return;
  scheduled = true;

  const expr = process.env.FINANCE_REPORT_SCHEDULE_CRON ?? "0 9 * * *"; // 09:00 daily — checks which schedules are due today
  if (!cron.validate(expr)) {
    logger.warn({ expr }, "FINANCE_REPORT_SCHEDULE_CRON is not a valid cron expression — scheduled finance reports disabled");
    logBus.warn(`Scheduled finance reports cron disabled: invalid schedule "${expr}"`);
    return;
  }

  cron.schedule(expr, () => {
    runFinanceReportSchedules().catch((err) => {
      logger.error({ err }, "Finance report schedule sweep failed");
      logBus.error(`Finance report schedule sweep failed: ${err?.message ?? err}`);
    });
  });

  logBus.system(`✅ Scheduled finance reports cron scheduled ("${expr}")`);
  logger.info({ expr }, "Scheduled finance reports cron scheduled");
}
