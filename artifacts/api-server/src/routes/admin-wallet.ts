import { Router } from "express";
import { requireAdmin } from "../middlewares/auth";
import { getAdminWalletSummary, creditAdminWallet } from "../services/admin-wallet";

const router = Router();

// GET /admin/wallet — platform revenue balance (marketplace fees, subscriptions,
// account/OTP sales) + recent ledger entries. Sweeps any pending marketplace
// fees in first, so the balance shown is always current.
router.get("/admin/wallet", requireAdmin, async (_req, res): Promise<void> => {
  try {
    const summary = await getAdminWalletSummary(100);
    res.json(summary);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// POST /admin/wallet/manual — admin-only manual ledger adjustment (e.g. logging
// revenue collected outside the platform, or a correction).
router.post("/admin/wallet/manual", requireAdmin, async (req, res): Promise<void> => {
  const { amount, currency, note } = req.body as { amount?: number; currency?: string; note?: string };
  if (!amount || amount <= 0) { res.status(400).json({ error: "amount must be > 0" }); return; }
  try {
    await creditAdminWallet("manual", amount, currency ?? "AZN", { note });
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
