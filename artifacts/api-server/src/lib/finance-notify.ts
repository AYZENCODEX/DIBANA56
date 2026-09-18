/**
 * lib/finance-notify.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Finance module notification delivery — two independent flows:
 *
 *  1. notifyEntryCreated — fired (best-effort, non-blocking) right after a
 *     new Finance ledger entry is inserted (see POST /finance/entries in
 *     routes/finance.ts). Mints the same public receipt/invoice link used by
 *     the manual "Share receipt" button (ensureReceiptToken, lib/finance-
 *     accounting.ts) and pushes it out over every channel the user has:
 *     in-app notification bell, Telegram (if linked), and email.
 *
 *  2. runFinanceDailyDigest — once-a-day sweep (see finance-digest-cron.ts
 *     for the schedule) that rolls up, per user: entries due in the next 3
 *     days, overdue entries, entries recorded in the last 24h, and a net
 *     worth snapshot — delivered the same way. Mirrors lib/vault-health-
 *     scan.ts's per-user Telegram+email digest pattern, but on its own
 *     cadence (financeLastDigestSentAt) so it never interferes with the
 *     vault digest's schedule.
 */
import { db, usersTable, financeLedgerEntriesTable, type FinanceLedgerEntry } from "@workspace/db";
import { eq, and, lt, gte, lte, sql } from "drizzle-orm";
import { logger } from "./logger";
import { logBus } from "./log-bus";
import { createNotification } from "../routes/notifications";
import { sendToUser } from "./telegram";
import { sendReceiptEmail, sendFinanceDigestEmail } from "./email";
import { ensureReceiptToken, financeReceiptUrl } from "./finance-accounting";
import { computeNetWorthBreakdown } from "./finance-networth";

const KIND_ICON: Record<string, string> = {
  receivable: "📥", payable: "📤", borrowed: "🏦", lending: "🤝",
  investment: "📈", expense: "💸", income: "💰",
};
const KIND_LABEL: Record<string, string> = {
  receivable: "Receivable", payable: "Payable", borrowed: "Borrowed Funds",
  lending: "Lending", investment: "Investment", expense: "Expense", income: "Income",
};

function money(currency: string, amount: number): string {
  return `${currency} ${amount.toLocaleString()}`;
}

// ─── Per-entry: invoice/receipt on creation ──────────────────────────────────

/** Fired right after a new ledger entry is inserted. Never throws. */
export async function notifyEntryCreated(entry: FinanceLedgerEntry): Promise<void> {
  try {
    const [user] = await db.select({
      id: usersTable.id, username: usersTable.username, email: usersTable.email,
      telegramChatId: usersTable.telegramChatId,
    }).from(usersTable).where(eq(usersTable.id, entry.userId)).limit(1);
    if (!user) return;

    const token = await ensureReceiptToken(entry.id, entry.userId);
    const url = token ? financeReceiptUrl(token) : null;
    const isInvoice = entry.kind === "receivable" && entry.status !== "paid";
    const docWord = isInvoice ? "Invoice" : "Receipt";
    const icon = KIND_ICON[entry.kind] ?? "💰";
    const label = KIND_LABEL[entry.kind] ?? entry.kind;
    const amountStr = money(entry.currency, entry.amount);

    // In-app notification bell — non-blocking, best-effort.
    createNotification(
      user.id,
      "finance_entry_created",
      `${icon} ${docWord} ready — ${entry.title}`,
      `${label} of ${amountStr} recorded.${url ? ` Your ${docWord.toLowerCase()} link is ready.` : ""}`,
      { entryId: entry.id, kind: entry.kind, url },
    ).catch(() => {});

    // Telegram — only if the user has linked their account.
    if (user.telegramChatId) {
      const text = [
        `${icon} *New ${label} Recorded*`,
        "",
        `*${entry.title}*`,
        `Amount: ${amountStr}`,
        entry.dueDate ? `Due: ${new Date(entry.dueDate).toLocaleDateString()}` : "",
        "",
        url ? `📄 ${docWord}: ${url}` : "",
      ].filter(Boolean).join("\n");
      sendToUser(user.telegramChatId, text).catch(() => {});
    }

    // Email — reuses the same generic receipt-link template as the manual share flow.
    if (user.email && url) {
      sendReceiptEmail(user.email, user.username, {
        kicker: docWord,
        title: entry.title,
        summary: `${label} — ${amountStr}${entry.dueDate ? ` · due ${new Date(entry.dueDate).toLocaleDateString()}` : ""}`,
        url,
      }).catch(() => {});
    }
  } catch (err: any) {
    logger.warn({ err: err?.message, entryId: entry.id }, "notifyEntryCreated failed");
  }
}

// ─── Daily digest ────────────────────────────────────────────────────────────

interface DigestUser {
  id: number; username: string; email: string; telegramChatId: string | null;
  financeLastDigestSentAt: Date | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export interface FinanceDigestResult {
  usersChecked: number;
  usersSent: number;
}

/** Runs once a day (see finance-digest-cron.ts): one rollup message per user, Telegram + email. */
export async function runFinanceDailyDigest(): Promise<FinanceDigestResult> {
  // Only consider users who've actually touched the Finance module.
  const activeUserIds = await db.selectDistinct({ userId: financeLedgerEntriesTable.userId }).from(financeLedgerEntriesTable);
  if (activeUserIds.length === 0) return { usersChecked: 0, usersSent: 0 };

  const ids = activeUserIds.map(r => r.userId);
  const users = await db.select({
    id: usersTable.id, username: usersTable.username, email: usersTable.email,
    telegramChatId: usersTable.telegramChatId, financeLastDigestSentAt: usersTable.financeLastDigestSentAt,
  }).from(usersTable).where(sql`${usersTable.id} IN (${sql.join(ids.map(id => sql`${id}`), sql`, `)})`);

  let usersSent = 0;
  const now = new Date();

  for (const user of users) {
    // Once every ~24h per user, regardless of when the cron itself runs.
    if (user.financeLastDigestSentAt && now.getTime() - user.financeLastDigestSentAt.getTime() < DAY_MS) continue;
    try {
      const sent = await deliverDigest(user, now);
      if (sent) {
        await db.update(usersTable).set({ financeLastDigestSentAt: now }).where(eq(usersTable.id, user.id));
        usersSent++;
      }
    } catch (err: any) {
      logger.warn({ err: err?.message, userId: user.id }, "runFinanceDailyDigest: delivery failed for user");
    }
  }

  const summary = `Finance daily digest: ${users.length} active user(s) checked, ${usersSent} sent`;
  logBus.system(summary);
  logger.info({ usersChecked: users.length, usersSent }, "finance daily digest complete");
  return { usersChecked: users.length, usersSent };
}

async function deliverDigest(user: DigestUser, now: Date): Promise<boolean> {
  const windowEnd = new Date(now.getTime() + 3 * DAY_MS);
  const yesterday = new Date(now.getTime() - DAY_MS);

  const [dueSoon, overdue, addedRecently, netWorth] = await Promise.all([
    db.select().from(financeLedgerEntriesTable).where(and(
      eq(financeLedgerEntriesTable.userId, user.id),
      gte(financeLedgerEntriesTable.dueDate, now),
      lte(financeLedgerEntriesTable.dueDate, windowEnd),
      sql`${financeLedgerEntriesTable.status} NOT IN ('paid', 'closed')`,
    )),
    db.select().from(financeLedgerEntriesTable).where(and(
      eq(financeLedgerEntriesTable.userId, user.id),
      lt(financeLedgerEntriesTable.dueDate, now),
      sql`${financeLedgerEntriesTable.status} NOT IN ('paid', 'closed')`,
    )),
    db.select().from(financeLedgerEntriesTable).where(and(
      eq(financeLedgerEntriesTable.userId, user.id),
      gte(financeLedgerEntriesTable.createdAt, yesterday),
    )),
    computeNetWorthBreakdown(user.id),
  ]);

  // Nothing due, nothing overdue, nothing new — still worth a light-touch
  // digest so the net worth number stays visible without logging in, but
  // skip Telegram/email noise entirely if there's truly zero movement.
  const hasActivity = dueSoon.length + overdue.length + addedRecently.length > 0;
  if (!hasActivity) return false;

  const entryLine = (e: typeof financeLedgerEntriesTable.$inferSelect, withDue = true) => {
    const icon = KIND_ICON[e.kind] ?? "💰";
    const label = KIND_LABEL[e.kind] ?? e.kind;
    const due = withDue && e.dueDate ? ` — due ${new Date(e.dueDate).toLocaleDateString()}` : "";
    return `${icon} *${e.title}* (${label}) — ${money(e.currency, e.amount)}${due}`;
  };

  const sections: string[] = [];
  if (overdue.length) sections.push(`🔴 *Overdue (${overdue.length})*\n${overdue.map(e => entryLine(e)).join("\n")}`);
  if (dueSoon.length) sections.push(`🟡 *Due in next 3 days (${dueSoon.length})*\n${dueSoon.map(e => entryLine(e)).join("\n")}`);
  if (addedRecently.length) sections.push(`🆕 *Recorded in the last 24h (${addedRecently.length})*\n${addedRecently.map(e => entryLine(e, false)).join("\n")}`);

  const summaryLine = `Net Worth: ${money("BDT", netWorth.netWorth)} · Receivable: ${money("BDT", netWorth.totalReceivable)} · Payable: ${money("BDT", netWorth.totalPayable)} · Borrowed: ${money("BDT", netWorth.totalBorrowed)}`;

  // In-app notification bell.
  createNotification(
    user.id,
    "finance_daily_digest",
    `📊 Finance Digest — ${overdue.length} overdue, ${dueSoon.length} due soon`,
    [summaryLine, ...sections].join("\n\n"),
    { overdueCount: overdue.length, dueSoonCount: dueSoon.length, addedCount: addedRecently.length },
  ).catch(() => {});

  // Telegram — only if linked.
  if (user.telegramChatId) {
    const text = [`📊 *Finance Daily Digest*`, "", summaryLine, "", ...sections].join("\n\n");
    sendToUser(user.telegramChatId, text).catch(() => {});
  }

  // Email — always, so the digest reaches users who haven't logged in.
  if (user.email) {
    const plainLines = [
      ...overdue.map(e => `🔴 <strong>${e.title}</strong> (${KIND_LABEL[e.kind] ?? e.kind}) — ${money(e.currency, e.amount)}, overdue`),
      ...dueSoon.map(e => `🟡 <strong>${e.title}</strong> (${KIND_LABEL[e.kind] ?? e.kind}) — ${money(e.currency, e.amount)}, due ${e.dueDate ? new Date(e.dueDate).toLocaleDateString() : ""}`),
      ...addedRecently.map(e => `🆕 <strong>${e.title}</strong> (${KIND_LABEL[e.kind] ?? e.kind}) — ${money(e.currency, e.amount)}, just recorded`),
    ];
    sendFinanceDigestEmail(user.email, user.username, plainLines, summaryLine).catch(() => {});
  }

  return true;
}
