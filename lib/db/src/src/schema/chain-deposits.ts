import { pgTable, serial, integer, text, real, timestamp, boolean, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * schema/chain-deposits.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Real-time deposit tracking for the AYZEN vault wallet across EVM chains
 * (ETH, BSC, Polygon, Plasma, Arbitrum). Populated by
 * services/deposit-watcher.ts, which polls each chain for new blocks / logs
 * against every address in `wallets` and writes a row here the moment a
 * matching transfer is seen on-chain — before it's safe to spend.
 *
 * Lifecycle: pending (seen, confirmations accumulating) → confirmed (crossed
 * the chain's confirmation threshold, balance credited) — never re-credited
 * after that thanks to the unique (chain, tx_hash, log_index) index.
 */
export const chainDepositsTable = pgTable("chain_deposits", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  walletId: integer("wallet_id").notNull(),
  chain: text("chain").notNull(), // ETH | BSC | MATIC | PLASMA | ARB
  tokenSymbol: text("token_symbol").notNull(), // native symbol (ETH/BNB/MATIC/XPL) or e.g. USDT
  tokenContract: text("token_contract"), // null = native coin deposit
  amount: real("amount").notNull(),
  fromAddress: text("from_address").notNull(),
  toAddress: text("to_address").notNull(),
  txHash: text("tx_hash").notNull(),
  logIndex: integer("log_index").notNull().default(-1), // -1 for native tx (no log)
  blockNumber: integer("block_number").notNull(),
  confirmations: integer("confirmations").notNull().default(0),
  status: text("status").notNull().default("pending"), // pending | confirmed
  credited: boolean("credited").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  confirmedAt: timestamp("confirmed_at"),
}, (t) => ({
  txUniqueIdx: uniqueIndex("chain_deposits_chain_tx_log_idx").on(t.chain, t.txHash, t.logIndex),
}));
export type ChainDeposit = typeof chainDepositsTable.$inferSelect;

/**
 * One row per watched chain — how far the deposit watcher has scanned.
 * Lets the watcher resume from where it left off after a restart instead
 * of re-scanning (or worse, missing) blocks.
 */
export const chainScanCursorTable = pgTable("chain_scan_cursor", {
  chain: text("chain").primaryKey(), // ETH | BSC | MATIC | PLASMA | ARB
  lastBlock: integer("last_block").notNull().default(0),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
export type ChainScanCursor = typeof chainScanCursorTable.$inferSelect;
