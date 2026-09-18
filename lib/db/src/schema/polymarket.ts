import { pgTable, serial, text, integer, timestamp, real } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// Real-money Polymarket trades placed through a user's AYZEN wallet
// (artifacts/api-server/src/routes/polymarket.ts). This is a local audit/
// display log — Polymarket's CLOB is the source of truth for order state;
// we record what we submitted and the order id it came back with so the
// UI can show trade history without re-querying the CLOB every time.
export const polymarketTradesTable = pgTable("polymarket_trades", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  walletId: integer("wallet_id").notNull(),
  marketId: text("market_id").notNull(),
  marketQuestion: text("market_question"),
  tokenId: text("token_id").notNull(),
  outcome: text("outcome").notNull(), // "YES" | "NO"
  side: text("side").notNull().default("BUY"), // "BUY" | "SELL"
  price: real("price").notNull(), // 0.01 - 0.99
  sizeUsdc: real("size_usdc").notNull(),
  status: text("status").notNull().default("submitted"), // submitted | failed | filled | cancelled
  clobOrderId: text("clob_order_id"),
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertPolymarketTradeSchema = createInsertSchema(polymarketTradesTable).omit({
  id: true,
  createdAt: true,
});
export type InsertPolymarketTrade = z.infer<typeof insertPolymarketTradeSchema>;
export type PolymarketTrade = typeof polymarketTradesTable.$inferSelect;
