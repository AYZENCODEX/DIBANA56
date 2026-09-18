/**
 * lib/finance-networth.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Net worth breakdown + trend snapshots, and financial-goal progress sync.
 *
 * computeNetWorthBreakdown() is the single source of truth for the netWorth
 * figure — it's the exact formula GET /finance/summary already used
 * (myAssetValue + receivable - payable - borrowed), extracted here so the
 * dashboard's live number and the snapshot trend can never disagree.
 */
import {
  db,
  financeLedgerEntriesTable,
  financeAssetsTable,
  financeAssetOwnersTable,
  financeGoalsTable,
  financeNetWorthSnapshotsTable,
  financeCurrencyRatesTable,
  type FinanceGoal,
} from "@workspace/db";
import { eq, and, sql, gte } from "drizzle-orm";

export interface NetWorthBreakdown {
  netWorth: number;
  totalAssets: number; // "my share" of all Finance Assets
  totalReceivable: number;
  totalPayable: number;
  totalBorrowed: number;
  totalLending: number; // money lent out (kind 'lending') — an asset, same as receivable
  totalInvested: number; // money invested (kind 'investment') — an asset, same as receivable
}

// Converts an amount into the user's base currency (BDT) using their
// manually maintained rate table — same helper as routes/finance.ts's
// getRateMap/toBase, duplicated here to avoid a routes -> lib import.
// Ledger entries can be created in any currency, so summing raw `amount`
// across entries (below) without this would silently mix currencies.
async function getRateMap(userId: number): Promise<Record<string, number>> {
  const rows = await db.select().from(financeCurrencyRatesTable).where(eq(financeCurrencyRatesTable.userId, userId));
  const map: Record<string, number> = { BDT: 1 };
  for (const r of rows) map[r.currency] = r.rateToBase;
  return map;
}
function toBase(amount: number, currency: string, rates: Record<string, number>): number {
  return amount * (rates[currency] ?? 1);
}

/** Same formula as GET /finance/summary — kept in one place so it's never duplicated. */
export async function computeNetWorthBreakdown(userId: number): Promise<NetWorthBreakdown> {
  const rates = await getRateMap(userId);
  // Grouped by kind AND currency so each bucket can be converted to the
  // user's base currency before being summed together.
  const totals = await db.select({
    kind: financeLedgerEntriesTable.kind,
    currency: financeLedgerEntriesTable.currency,
    total: sql<number>`COALESCE(SUM(${financeLedgerEntriesTable.amount}), 0)`,
  }).from(financeLedgerEntriesTable)
    .where(and(eq(financeLedgerEntriesTable.userId, userId), sql`${financeLedgerEntriesTable.status} NOT IN ('paid', 'closed')`))
    .groupBy(financeLedgerEntriesTable.kind, financeLedgerEntriesTable.currency);

  const byKind = new Map<string, number>();
  for (const t of totals) byKind.set(t.kind, (byKind.get(t.kind) ?? 0) + toBase(t.total, t.currency, rates));
  const totalReceivable = byKind.get("receivable") ?? 0;
  const totalPayable = byKind.get("payable") ?? 0;
  const totalBorrowed = byKind.get("borrowed") ?? 0;
  // 'lending' (money lent out) and 'investment' (money invested) are assets
  // too — same as receivable — and are already posted as such in the Chart
  // of Accounts (1200 Loans Receivable, 1300 Investments). Previously
  // omitted here entirely, so lending/investing money silently vanished
  // from Net Worth and Current Balance even though it's still yours.
  const totalLending = byKind.get("lending") ?? 0;
  const totalInvested = byKind.get("investment") ?? 0;

  const assets = await db.select().from(financeAssetsTable).where(eq(financeAssetsTable.userId, userId));
  const assetIds = assets.map(a => a.id);
  const owners = assetIds.length
    ? await db.select().from(financeAssetOwnersTable).where(sql`${financeAssetOwnersTable.assetId} IN (${sql.join(assetIds.map(id => sql`${id}`), sql`, `)})`)
    : [];

  let totalAssets = 0;
  for (const a of assets) {
    const mine = owners.filter(o => o.assetId === a.id && o.partyId == null);
    const pct = mine.length ? mine.reduce((s, o) => s + o.ownershipPercent, 0) : 100;
    totalAssets += a.totalValue * (pct / 100);
  }

  return {
    netWorth: totalAssets + totalReceivable + totalLending + totalInvested - totalPayable - totalBorrowed,
    totalAssets, totalReceivable, totalPayable, totalBorrowed, totalLending, totalInvested,
  };
}

/** Write (or overwrite) this month's net worth snapshot for a user. */
export async function snapshotNetWorth(userId: number, at: Date = new Date()): Promise<void> {
  const breakdown = await computeNetWorthBreakdown(userId);
  const monthStart = new Date(at.getFullYear(), at.getMonth(), 1);
  const monthEnd = new Date(at.getFullYear(), at.getMonth() + 1, 1);

  // Delete-then-insert for this calendar month — same "regenerate" approach
  // used by amortization/depreciation schedules, avoids needing an
  // expression-target upsert for the date_trunc(month) unique index.
  await db.delete(financeNetWorthSnapshotsTable).where(and(
    eq(financeNetWorthSnapshotsTable.userId, userId),
    gte(financeNetWorthSnapshotsTable.snapshotDate, monthStart),
    sql`${financeNetWorthSnapshotsTable.snapshotDate} < ${monthEnd}`,
  ));

  await db.insert(financeNetWorthSnapshotsTable).values({
    userId,
    snapshotDate: at,
    netWorth: breakdown.netWorth,
    totalAssets: breakdown.totalAssets,
    totalReceivable: breakdown.totalReceivable,
    totalPayable: breakdown.totalPayable,
    totalBorrowed: breakdown.totalBorrowed,
    totalLending: breakdown.totalLending,
    totalInvested: breakdown.totalInvested,
  });
}

/** Snapshot every user who has any Finance activity — used by the monthly cron. */
export async function snapshotNetWorthForAllUsers(): Promise<{ usersSnapshotted: number }> {
  const activeUsers = await db.selectDistinct({ userId: financeLedgerEntriesTable.userId }).from(financeLedgerEntriesTable);
  const assetUsers = await db.selectDistinct({ userId: financeAssetsTable.userId }).from(financeAssetsTable);
  const userIds = new Set<number>([...activeUsers.map(u => u.userId), ...assetUsers.map(u => u.userId)]);
  for (const userId of userIds) await snapshotNetWorth(userId);
  return { usersSnapshotted: userIds.size };
}

export async function listNetWorthHistory(userId: number, months = 12) {
  const since = new Date();
  since.setMonth(since.getMonth() - months);
  const rows = await db.select().from(financeNetWorthSnapshotsTable)
    .where(and(eq(financeNetWorthSnapshotsTable.userId, userId), gte(financeNetWorthSnapshotsTable.snapshotDate, since)))
    .orderBy(financeNetWorthSnapshotsTable.snapshotDate);
  return rows;
}

/** If a goal is linked to an asset, mirror that asset's "my share" value onto currentAmount. Auto-marks 'achieved' once the target is hit. */
export async function syncGoalProgress(goal: FinanceGoal): Promise<FinanceGoal> {
  if (goal.linkedAssetId == null) return goal;
  const [asset] = await db.select().from(financeAssetsTable).where(eq(financeAssetsTable.id, goal.linkedAssetId));
  if (!asset) return goal;
  const owners = await db.select().from(financeAssetOwnersTable).where(eq(financeAssetOwnersTable.assetId, asset.id));
  const mine = owners.filter(o => o.partyId == null);
  const pct = mine.length ? mine.reduce((s, o) => s + o.ownershipPercent, 0) : 100;
  const currentAmount = asset.totalValue * (pct / 100);
  if (Math.abs(currentAmount - goal.currentAmount) < 0.01) return goal;

  const status = goal.status === "active" && goal.targetAmount > 0 && currentAmount >= goal.targetAmount ? "achieved" : goal.status;
  const [updated] = await db.update(financeGoalsTable)
    .set({ currentAmount, status, updatedAt: new Date() })
    .where(eq(financeGoalsTable.id, goal.id))
    .returning();
  return updated ?? goal;
}
