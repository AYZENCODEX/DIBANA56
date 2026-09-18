import { pool } from "@workspace/db";

/**
 * Per-market admin configuration (fee % + enabled/disabled), backed by
 * marketplace_market_configs (see MIGRATIONS in index.ts). Vault Market and
 * Game Market used to hardcode `const FEE_PCT = 5` at the top of their route
 * files — this makes that number (and a kill switch) editable from
 * pages/admin/marketplace-market-config.tsx without a redeploy, the same way
 * nft_market_categories made NFT categories DB-driven instead of hardcoded.
 *
 * Falls back to each market's original hardcoded default if no row exists
 * yet (first boot, before an admin has ever touched the settings page), so
 * this is a non-destructive add — existing behavior is unchanged until an
 * admin explicitly saves a config.
 */

export interface MarketConfig {
  marketType: string;
  feePct: number;
  enabled: boolean;
}

const DEFAULT_FEE_PCT: Record<string, number> = {
  vault: 5,
  game: 5,
};

export async function getMarketConfig(marketType: string): Promise<MarketConfig> {
  const r = await pool.query(
    "SELECT fee_pct, enabled FROM marketplace_market_configs WHERE market_type = $1",
    [marketType]
  );
  if (r.rows[0]) {
    return { marketType, feePct: Number(r.rows[0].fee_pct), enabled: Boolean(r.rows[0].enabled) };
  }
  return { marketType, feePct: DEFAULT_FEE_PCT[marketType] ?? 5, enabled: true };
}

export async function upsertMarketConfig(
  marketType: string,
  data: { feePct?: number; enabled?: boolean }
): Promise<MarketConfig> {
  const current = await getMarketConfig(marketType);
  const feePct = data.feePct ?? current.feePct;
  const enabled = data.enabled ?? current.enabled;
  const r = await pool.query(
    `INSERT INTO marketplace_market_configs (market_type, fee_pct, enabled, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (market_type) DO UPDATE SET fee_pct = $2, enabled = $3, updated_at = NOW()
     RETURNING fee_pct, enabled`,
    [marketType, feePct, enabled]
  );
  return { marketType, feePct: Number(r.rows[0].fee_pct), enabled: Boolean(r.rows[0].enabled) };
}
