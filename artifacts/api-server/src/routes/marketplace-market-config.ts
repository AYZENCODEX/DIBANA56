import { Router } from "express";
import { requireAuth, requireRoles } from "../middlewares/auth";
import { getMarketConfig, upsertMarketConfig } from "../lib/market-config";

const router = Router();

// Markets manageable from pages/admin/marketplace-market-config.tsx. AZN/NFT/P2P
// keep their own settings surfaces (marketplace_settings, nft_market_categories) —
// this covers the two that still had a hardcoded fee constant.
const CONFIGURABLE_MARKETS = ["vault", "game"] as const;
type ConfigurableMarket = (typeof CONFIGURABLE_MARKETS)[number];

function isConfigurableMarket(v: string): v is ConfigurableMarket {
  return (CONFIGURABLE_MARKETS as readonly string[]).includes(v);
}

// ── GET /admin/marketplace/market-config — every configurable market at once ──
router.get("/admin/marketplace/market-config", requireAuth, requireRoles("admin", "dev"), async (_req, res): Promise<void> => {
  try {
    const configs = await Promise.all(CONFIGURABLE_MARKETS.map(m => getMarketConfig(m)));
    res.json(configs);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ── PATCH /admin/marketplace/market-config/:marketType — update fee%/enabled ──
router.patch("/admin/marketplace/market-config/:marketType", requireAuth, requireRoles("admin", "dev"), async (req, res): Promise<void> => {
  const marketType = Array.isArray(req.params.marketType) ? req.params.marketType[0] : req.params.marketType;
  if (!isConfigurableMarket(marketType)) {
    res.status(400).json({ error: `Unknown market. Must be one of: ${CONFIGURABLE_MARKETS.join(", ")}` });
    return;
  }
  const { fee_pct, enabled } = req.body as { fee_pct?: number; enabled?: boolean };
  if (fee_pct !== undefined && (Number.isNaN(Number(fee_pct)) || Number(fee_pct) < 0 || Number(fee_pct) > 100)) {
    res.status(400).json({ error: "fee_pct must be a number between 0 and 100" });
    return;
  }
  try {
    const updated = await upsertMarketConfig(marketType, {
      feePct: fee_pct !== undefined ? Number(fee_pct) : undefined,
      enabled,
    });
    res.json(updated);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
