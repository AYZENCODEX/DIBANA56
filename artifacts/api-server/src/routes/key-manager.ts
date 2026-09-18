import { Router } from "express";
import { pool } from "@workspace/db";
import { requireAdmin } from "../middlewares/auth";

const router = Router();

// Round-robin counters (in-memory, reset on server restart)
const rrCounters: Record<string, number> = {};

// ── GET /key-manager/keys — list all keys (values masked) ────────────────────
router.get("/key-manager/keys", requireAdmin, async (_req, res): Promise<void> => {
  try {
    const r = await pool.query(
      `SELECT id, provider, label, slot, created_at,
              LEFT(key_value, 8) || '...' || RIGHT(key_value, 4) AS key_masked,
              is_active
       FROM robin_api_keys ORDER BY provider, slot`
    );
    res.json({ keys: r.rows });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /key-manager/keys — add or update a key ─────────────────────────────
router.post("/key-manager/keys", requireAdmin, async (req, res): Promise<void> => {
  const { provider, label, slot, key_value } = req.body;
  if (!provider || !key_value || slot == null) {
    res.status(400).json({ error: "provider, slot, and key_value are required" });
    return;
  }
  try {
    const r = await pool.query(
      `INSERT INTO robin_api_keys (provider, label, slot, key_value, is_active)
       VALUES ($1, $2, $3, $4, true)
       ON CONFLICT (provider, slot) DO UPDATE SET key_value = EXCLUDED.key_value, label = EXCLUDED.label, is_active = true, updated_at = NOW()
       RETURNING id, provider, label, slot, is_active, created_at`,
      [provider, label ?? `${provider} key ${slot}`, slot, key_value]
    );
    res.json({ key: r.rows[0] });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── DELETE /key-manager/keys/:id — remove a key ──────────────────────────────
router.delete("/key-manager/keys/:id", requireAdmin, async (req, res): Promise<void> => {
  try {
    await pool.query("DELETE FROM robin_api_keys WHERE id = $1", [req.params.id]);
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── PATCH /key-manager/keys/:id/toggle — toggle active state ─────────────────
router.patch("/key-manager/keys/:id/toggle", requireAdmin, async (req, res): Promise<void> => {
  try {
    const r = await pool.query(
      "UPDATE robin_api_keys SET is_active = NOT is_active, updated_at = NOW() WHERE id = $1 RETURNING id, is_active",
      [req.params.id]
    );
    res.json({ key: r.rows[0] });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /key-manager/next/:provider — get next active key (round-robin) ──────
router.get("/key-manager/next/:provider", requireAdmin, async (req, res): Promise<void> => {
  const provider = String(req.params.provider);
  try {
    const r = await pool.query(
      "SELECT id, key_value, label, slot FROM robin_api_keys WHERE provider = $1 AND is_active = true ORDER BY slot",
      [provider]
    );
    if (r.rows.length === 0) {
      res.status(404).json({ error: `No active keys for provider: ${provider}` });
      return;
    }
    const idx = (rrCounters[provider] ?? 0) % r.rows.length;
    rrCounters[provider] = idx + 1;
    const key = r.rows[idx];
    res.json({ key: { id: key.id, label: key.label, slot: key.slot, key_value: key.key_value }, index: idx, total: r.rows.length });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /key-manager/status — summary of all providers ───────────────────────
router.get("/key-manager/status", requireAdmin, async (_req, res): Promise<void> => {
  try {
    const r = await pool.query(
      `SELECT provider, COUNT(*) as total, SUM(CASE WHEN is_active THEN 1 ELSE 0 END) as active
       FROM robin_api_keys GROUP BY provider ORDER BY provider`
    );
    res.json({ providers: r.rows });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
