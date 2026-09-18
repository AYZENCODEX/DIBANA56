/**
 * services/admin-wallet.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * The platform's own revenue wallet. Every fee-generating flow on AYZEN feeds
 * into this one ledger:
 *   - marketplace fees (vault, azn, bundles, cart, game, nft, offers) — swept
 *     in from marketplace_transactions.fee rather than hooked into each of
 *     those 7 route files individually (see sweepMarketplaceFees below)
 *   - subscription payments (routes/subscriptions.ts calls creditAdminWallet
 *     directly at both payment-confirmation points: CoinGate auto-check and
 *     admin manual approval)
 *   - AYZEN-owned account/OTP sales (routes/marketplace-vault.ts listings
 *     created from the admin's own vault — the full sale price is platform
 *     revenue, credited the same way a marketplace fee is)
 */
import { db, pool, adminWalletLedgerTable } from "@workspace/db";
import { sql } from "drizzle-orm";

export type AdminWalletSource = "marketplace_fee" | "subscription" | "account_sale" | "otp_sale" | "manual";

export async function creditAdminWallet(
  source: AdminWalletSource,
  amount: number,
  currency: string,
  opts: { refId?: string; userId?: number; note?: string } = {}
): Promise<void> {
  if (!(amount > 0)) return; // never record zero/negative "revenue"
  await db.insert(adminWalletLedgerTable).values({
    source,
    amount,
    currency,
    refId: opts.refId ?? null,
    userId: opts.userId ?? null,
    note: opts.note ?? null,
  });
}

/**
 * Like creditAdminWallet, but skips the insert if a ledger row with this
 * exact refId already exists. Use for payment flows that can be polled or
 * retried (e.g. a client re-checking a CoinGate order's status) so the same
 * payment is never counted as revenue twice. Returns true if it credited,
 * false if it was already recorded.
 */
export async function creditAdminWalletIfNew(
  refId: string,
  amount: number,
  currency: string,
  userId?: number,
  note?: string,
  source: AdminWalletSource = "subscription"
): Promise<boolean> {
  const existing = await db.execute(sql`SELECT 1 FROM admin_wallet_ledger WHERE ref_id = ${refId} LIMIT 1`);
  if (existing.rows.length > 0) return false;
  await creditAdminWallet(source, amount, currency, { refId, userId, note });
  return true;
}

/**
 * Sweeps any not-yet-credited marketplace_transactions.fee rows into the
 * admin wallet ledger, then marks them admin_credited=true. Idempotent and
 * safe to call as often as you like (e.g. on every GET /admin/wallet) — rows
 * already swept are skipped by the admin_credited flag, so nothing is ever
 * double-counted no matter how many marketplace route files feed this table.
 */
export async function sweepMarketplaceFees(): Promise<number> {
  const { rows } = await pool.query(
    `SELECT id, market_type, fee, buyer_id FROM marketplace_transactions
     WHERE admin_credited = FALSE AND fee > 0
     ORDER BY id ASC LIMIT 500`
  );
  if (rows.length === 0) return 0;

  for (const row of rows) {
    await creditAdminWallet("marketplace_fee", Number(row.fee), "AZN", {
      refId: `mktx_${row.id}`,
      userId: row.buyer_id,
      note: `${row.market_type} marketplace fee`,
    });
  }

  const ids = rows.map((r: any) => r.id);
  await pool.query(`UPDATE marketplace_transactions SET admin_credited = TRUE WHERE id = ANY($1::int[])`, [ids]);
  return rows.length;
}

export interface AdminWalletSummary {
  balances: { currency: string; total: number }[];
  recent: Array<{
    id: number;
    source: string;
    amount: number;
    currency: string;
    refId: string | null;
    userId: number | null;
    note: string | null;
    createdAt: string;
  }>;
}

export async function getAdminWalletSummary(recentLimit = 50): Promise<AdminWalletSummary> {
  await sweepMarketplaceFees();

  const balanceRows = await db.execute(
    sql`SELECT currency, SUM(amount) AS total FROM admin_wallet_ledger GROUP BY currency ORDER BY total DESC`
  );
  const recentRows = await db.execute(
    sql`SELECT id, source, amount, currency, ref_id AS "refId", user_id AS "userId", note, created_at AS "createdAt"
        FROM admin_wallet_ledger ORDER BY created_at DESC LIMIT ${recentLimit}`
  );

  return {
    balances: (balanceRows.rows as any[]).map((r) => ({ currency: r.currency, total: Number(r.total) })),
    recent: recentRows.rows as any[],
  };
}
