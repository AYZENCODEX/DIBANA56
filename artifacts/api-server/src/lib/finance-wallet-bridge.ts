/**
 * lib/finance-wallet-bridge.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Wallet↔Finance bridge. Confirmed vault deposits (services/deposit-watcher.ts)
 * and outbound withdrawals (routes/wallets.ts handleWithdraw) each auto-post a
 * Finance ledger entry here, which in turn auto-posts a balanced journal entry
 * via lib/finance-accounting.ts (kind 'income' -> Cash/Income, kind 'expense'
 * -> Expense/Cash). Net effect: on-chain wallet activity shows up in Finance's
 * ledger, analytics, and Trial Balance / Balance Sheet / Income Statement with
 * zero manual entry.
 *
 * Idempotency: source_chain_deposit_id / source_wallet_tx_hash are unique
 * columns (migration 025) — a retried credit or a duplicate broadcast event
 * can never post twice. Both functions are best-effort: a Finance-side
 * failure is logged and swallowed, never allowed to break the deposit credit
 * or the withdrawal response the user is waiting on.
 */
import { db, walletsTable, financeLedgerEntriesTable, type ChainDeposit } from "@workspace/db";
import { eq } from "drizzle-orm";
import { postEntryJournal, resolveBookId } from "./finance-accounting";
import { logger } from "./logger";

async function walletSyncEnabled(walletId: number): Promise<boolean> {
  const [w] = await db.select({ autoFinanceSync: walletsTable.autoFinanceSync })
    .from(walletsTable).where(eq(walletsTable.id, walletId));
  return w?.autoFinanceSync ?? true;
}

/** Called once a chain_deposits row crosses its confirmation threshold and is credited. */
export async function postDepositToFinance(deposit: ChainDeposit): Promise<void> {
  try {
    if (!(await walletSyncEnabled(deposit.walletId))) return;

    // BUG FIX: every entry-creation path must resolve a concrete bookId
    // before insert (financeLedgerEntriesTable.bookId's doc comment) —
    // GET /finance/entries and virtually every other read always filters
    // on a resolved, non-null bookId. This insert previously left bookId
    // unset (null), so wallet deposits posted a journal entry but the
    // ledger row itself was permanently invisible in the Finance UI —
    // same bug already fixed for the CSV-import and recurring-cron paths.
    const bookId = await resolveBookId(deposit.userId);

    const [entry] = await db.insert(financeLedgerEntriesTable).values({
      userId: deposit.userId,
      bookId,
      kind: "income",
      title: `${deposit.tokenSymbol} deposit — ${deposit.chain}`,
      amount: deposit.amount,
      currency: deposit.tokenSymbol,
      category: "Wallet Deposit",
      occurredDate: deposit.confirmedAt ?? new Date(),
      status: "paid",
      notes: `Auto-posted from vault deposit. Tx ${deposit.txHash} on ${deposit.chain}, from ${deposit.fromAddress}.`,
      sourceChainDepositId: deposit.id,
    }).returning();

    await postEntryJournal(entry);
  } catch (err: any) {
    if (err?.code === "23505") return; // unique violation — already posted, safe no-op
    logger.warn({ err, depositId: deposit.id }, "finance-wallet-bridge: failed to post deposit");
  }
}

/** Called right after a wallet withdrawal is successfully broadcast. */
export async function postWithdrawalToFinance(opts: {
  userId: number;
  walletId: number;
  chain: string;
  symbol: string;
  amount: number;
  to: string;
  txHash: string;
}): Promise<void> {
  try {
    if (!(await walletSyncEnabled(opts.walletId))) return;

    // BUG FIX: same missing-bookId gap as postDepositToFinance above — this
    // insert never resolved a bookId, so wallet withdrawals were also
    // invisible in Finance's ledger UI despite journaling correctly.
    const bookId = await resolveBookId(opts.userId);

    const [entry] = await db.insert(financeLedgerEntriesTable).values({
      userId: opts.userId,
      bookId,
      kind: "expense",
      title: `${opts.symbol} withdrawal — ${opts.chain}`,
      amount: opts.amount,
      currency: opts.symbol,
      category: "Wallet Withdrawal",
      occurredDate: new Date(),
      status: "paid",
      notes: `Auto-posted from wallet withdrawal. Tx ${opts.txHash} on ${opts.chain}, to ${opts.to}.`,
      sourceWalletTxHash: opts.txHash,
    }).returning();

    await postEntryJournal(entry);
  } catch (err: any) {
    if (err?.code === "23505") return;
    logger.warn({ err, txHash: opts.txHash }, "finance-wallet-bridge: failed to post withdrawal");
  }
}
