import { randomBytes } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { db, financeLedgerEntriesTable, financeCurrencyRatesTable, usersTable } from "@workspace/db";

// Converts an amount into the user's base currency (BDT) using their
// manually maintained rate table — same helper as routes/finance.ts's
// getRateMap/toBase and lib/finance-networth.ts's copy, duplicated here to
// avoid a routes -> lib import. Ledger entries can be created in any
// currency, so summing raw `amount` across entries without this would
// silently mix currencies (see answerFinanceQuery below).
async function getRateMap(userId: number): Promise<Record<string, number>> {
  const rows = await db.select().from(financeCurrencyRatesTable).where(eq(financeCurrencyRatesTable.userId, userId));
  const map: Record<string, number> = { BDT: 1 };
  for (const r of rows) map[r.currency] = r.rateToBase;
  return map;
}
function toBase(amount: number, currency: string, rates: Record<string, number>): number {
  return amount * (rates[currency] ?? 1);
}

export type QuickEntryDraft = {
  title: string;
  amount: number;
  currency: string;
  kind: "income" | "expense";
  suggestedCategory: string;
  occurredDate: string;
  raw: string;
  parseOk: boolean;
};

function categoryFor(text: string, kind: QuickEntryDraft["kind"]): string {
  const value = text.toLowerCase();
  if (kind === "income") {
    if (value.includes("salary") || value.includes("payroll")) return "Salary";
    if (value.includes("freelance") || value.includes("client")) return "Freelance";
    return "Income";
  }
  if (value.includes("rent") || value.includes("house")) return "Housing";
  if (value.includes("food") || value.includes("lunch") || value.includes("dinner")) return "Food";
  if (value.includes("uber") || value.includes("bus") || value.includes("transport")) return "Transport";
  if (value.includes("bill") || value.includes("electric") || value.includes("internet")) return "Bills";
  return "Other";
}

function parseOne(text: string, currency: string): QuickEntryDraft {
  const amountMatch = text.match(/(?:৳|₹|\$|€|£)?\s*([\d,]+(?:\.\d{1,2})?)/);
  const amount = amountMatch ? Number(amountMatch[1].replace(/,/g, "")) : 0;
  const kind: QuickEntryDraft["kind"] =
    /\b(received|income|salary|earned|credited|deposit|refund)\b/i.test(text)
      ? "income"
      : "expense";
  return {
    title: text.trim(),
    amount,
    currency,
    kind,
    suggestedCategory: categoryFor(text, kind),
    occurredDate: new Date().toISOString(),
    raw: text,
    parseOk: amount > 0,
  };
}

export async function parseQuickEntryText(
  _userId: number,
  text: string,
  currency: string,
): Promise<QuickEntryDraft[]> {
  return text
    .split(/\s+(?:and|also)\s+/i)
    .map((part) => parseOne(part, currency))
    .filter((draft) => draft.raw.length > 0);
}

export async function findDuplicateEntry(userId: number, draft: Partial<QuickEntryDraft>) {
  if (!draft.amount || !draft.title) return { isDuplicate: false };
  const rows = await db
    .select()
    .from(financeLedgerEntriesTable)
    .where(and(
      eq(financeLedgerEntriesTable.userId, userId),
      eq(financeLedgerEntriesTable.amount, Number(draft.amount)),
      // BUG FIX: the amount match ignored currency entirely, so e.g. a BDT
      // 500 "Lunch" and a USD 500 "Lunch" (very different real values) were
      // flagged as duplicates of each other purely because the raw numbers
      // matched. Only compare entries actually in the same currency as the
      // draft — same currency scoping every other cross-entry comparison in
      // this module needs (see detectAnomalies/detectRecurringCandidates).
      eq(financeLedgerEntriesTable.currency, draft.currency ?? "BDT"),
    ))
    .orderBy(desc(financeLedgerEntriesTable.occurredDate))
    .limit(20);
  const match = rows.find((row) => row.title.toLowerCase() === String(draft.title).toLowerCase());
  return match ? { isDuplicate: true, entry: match } : { isDuplicate: false };
}

export async function detectAnomalies(userId: number) {
  const rows = await db.select().from(financeLedgerEntriesTable)
    .where(eq(financeLedgerEntriesTable.userId, userId))
    .orderBy(desc(financeLedgerEntriesTable.occurredDate))
    .limit(100);
  // BUG FIX: `row.amount >= 100000` compared every entry's raw amount
  // against a threshold implicitly meant for BDT, regardless of the
  // entry's actual currency — e.g. a $1,500 USD expense (~165,000 BDT)
  // never got flagged, while a plain 100,000 BDT entry always did. Convert
  // each entry to the user's base currency (same getRateMap/toBase
  // approach as the rest of the Finance module) before comparing, so the
  // "unusually large" signal means the same thing regardless of which
  // currency the entry happens to be recorded in.
  const rates = await getRateMap(userId);
  return rows
    .filter((row) => row.amount > 0 && toBase(row.amount, row.currency, rates) >= 100000)
    .map((row) => ({ entryId: row.id, title: row.title, amount: row.amount, reason: "Unusually large amount" }));
}

export async function detectRecurringCandidates(userId: number) {
  const rows = await db.select().from(financeLedgerEntriesTable)
    .where(eq(financeLedgerEntriesTable.userId, userId))
    .orderBy(desc(financeLedgerEntriesTable.occurredDate))
    .limit(200);
  const grouped = new Map<string, { title: string; amount: number; count: number; currency: string }>();
  for (const row of rows) {
    const key = `${row.title.toLowerCase()}|${row.amount}|${row.currency}`;
    const existing = grouped.get(key);
    grouped.set(key, existing
      ? { ...existing, count: existing.count + 1 }
      : { title: row.title, amount: row.amount, count: 1, currency: row.currency });
  }
  return [...grouped.values()].filter((candidate) => candidate.count >= 2);
}

export async function answerFinanceQuery(userId: number, question: string) {
  const rows = await db.select().from(financeLedgerEntriesTable)
    .where(eq(financeLedgerEntriesTable.userId, userId));
  const rates = await getRateMap(userId);
  const income = rows.filter((row) => row.kind === "income")
    .reduce((sum, row) => sum + toBase(row.amount, row.currency, rates), 0);
  const expenses = rows.filter((row) => row.kind === "expense")
    .reduce((sum, row) => sum + toBase(row.amount, row.currency, rates), 0);
  return {
    answer: `Across ${rows.length} entries, income is ${income.toLocaleString()} BDT and expenses are ${expenses.toLocaleString()} BDT.`,
    question,
    data: { income, expenses, balance: income - expenses, entryCount: rows.length, baseCurrency: "BDT" },
  };
}

export async function extractReceiptFields(
  _imageBase64: string,
  _userId: number,
  currency: string,
): Promise<{ draft: QuickEntryDraft | null; extracted: boolean; message: string }> {
  return { draft: null, extracted: false, message: `Receipt image received. Add the amount manually in ${currency}.` };
}

export function parseBankSms(text: string): QuickEntryDraft | null {
  const amountMatch = text.match(/(?:BDT|TK|৳|INR|USD|\$)?\s*([\d,]+(?:\.\d{1,2})?)/i);
  if (!amountMatch) return null;
  // Detect the currency actually mentioned in the SMS instead of always
  // defaulting to BDT — the ternary previously returned "BDT" on both
  // branches (`... ? "BDT" : "BDT"`), so USD/INR bank SMS were silently
  // mis-recorded in BDT even though the amount regex above already looks
  // for those symbols/codes.
  const currency = /(?:INR|₹)/i.test(text) ? "INR" : /(?:USD|\$)/i.test(text) ? "USD" : "BDT";
  return parseOne(text, currency);
}

export async function ensureSmsWebhookToken(userId: number) {
  const [user] = await db.select({ token: usersTable.financeSmsWebhookToken })
    .from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  if (user?.token) return user.token;
  const token = randomBytes(32).toString("hex");
  await db.update(usersTable).set({ financeSmsWebhookToken: token }).where(eq(usersTable.id, userId));
  return token;
}

export async function rotateSmsWebhookToken(userId: number) {
  const token = randomBytes(32).toString("hex");
  await db.update(usersTable).set({ financeSmsWebhookToken: token }).where(eq(usersTable.id, userId));
  return token;
}