import { Router } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { requireAuth, requireAdmin } from "../middlewares/auth";

const router = Router();

// ── GET /networks — list all networks ─────────────────────────────────────────
router.get("/networks", requireAuth, async (_req, res): Promise<void> => {
  const result = await db.execute(sql.raw(`SELECT * FROM networks ORDER BY name ASC`));
  res.json(result.rows);
});

// ── GET /networks/enabled — list enabled networks ─────────────────────────────
router.get("/networks/enabled", requireAuth, async (_req, res): Promise<void> => {
  const result = await db.execute(sql.raw(`SELECT * FROM networks WHERE enabled = true ORDER BY name ASC`));
  res.json(result.rows);
});

// ── POST /networks — create network (admin only) ──────────────────────────────
router.post("/networks", requireAdmin, async (req, res): Promise<void> => {
  const { name, networkId, chain, symbol, coingeckoId, rpcUrl, gasOracleUrl, enabled = true } = req.body;
  if (!name || !chain) { res.status(400).json({ error: "name and chain are required" }); return; }
  const result = await db.execute(sql.raw(
    `INSERT INTO networks (name, network_id, chain, symbol, coingecko_id, rpc_url, gas_oracle_url, enabled)
     VALUES (
       '${name.replace(/'/g, "''")}',
       ${networkId ? `'${String(networkId).replace(/'/g, "''")}'` : "NULL"},
       '${chain.replace(/'/g, "''")}',
       ${symbol ? `'${symbol.replace(/'/g, "''")}'` : "NULL"},
       ${coingeckoId ? `'${coingeckoId.replace(/'/g, "''")}'` : "NULL"},
       ${rpcUrl ? `'${rpcUrl.replace(/'/g, "''")}'` : "NULL"},
       ${gasOracleUrl ? `'${gasOracleUrl.replace(/'/g, "''")}'` : "NULL"},
       ${Boolean(enabled)}
     ) RETURNING *`
  ));
  res.status(201).json(result.rows[0]);
});

// ── PATCH /networks/:id — update network (admin only) ─────────────────────────
router.patch("/networks/:id", requireAdmin, async (req, res): Promise<void> => {
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const { name, rpcUrl, gasOracleUrl, enabled, coingeckoId, symbol } = req.body;
  const sets: string[] = [];
  if (name !== undefined) sets.push(`name = '${name.replace(/'/g, "''")}'`);
  if (rpcUrl !== undefined) sets.push(`rpc_url = ${rpcUrl ? `'${rpcUrl.replace(/'/g, "''")}'` : "NULL"}`);
  if (gasOracleUrl !== undefined) sets.push(`gas_oracle_url = ${gasOracleUrl ? `'${gasOracleUrl.replace(/'/g, "''")}'` : "NULL"}`);
  if (enabled !== undefined) sets.push(`enabled = ${Boolean(enabled)}`);
  if (coingeckoId !== undefined) sets.push(`coingecko_id = ${coingeckoId ? `'${coingeckoId.replace(/'/g, "''")}'` : "NULL"}`);
  if (symbol !== undefined) sets.push(`symbol = ${symbol ? `'${symbol.replace(/'/g, "''")}'` : "NULL"}`);
  if (!sets.length) { res.status(400).json({ error: "Nothing to update" }); return; }
  const result = await db.execute(sql.raw(`UPDATE networks SET ${sets.join(", ")} WHERE id = ${id} RETURNING *`));
  if (!result.rows.length) { res.status(404).json({ error: "Not found" }); return; }
  res.json(result.rows[0]);
});

// ── DELETE /networks/:id — delete network (admin only) ────────────────────────
router.delete("/networks/:id", requireAdmin, async (req, res): Promise<void> => {
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  await db.execute(sql.raw(`DELETE FROM networks WHERE id = ${id}`));
  res.json({ ok: true });
});

// ── GET /health-rules — list health rules (admin only) ────────────────────────
router.get("/health-rules", requireAdmin, async (_req, res): Promise<void> => {
  const result = await db.execute(sql.raw(`SELECT * FROM health_rules ORDER BY severity ASC`));
  res.json(result.rows);
});

// ── POST /health-rules — create health rule (admin only) ─────────────────────
router.post("/health-rules", requireAdmin, async (req, res): Promise<void> => {
  const { name, description = "", ruleType = "entity", condition = "{}", severity = "warning", isActive = true } = req.body;
  if (!name) { res.status(400).json({ error: "name is required" }); return; }
  const condStr = typeof condition === "string" ? condition : JSON.stringify(condition);
  const result = await db.execute(sql.raw(
    `INSERT INTO health_rules (name, description, rule_type, condition, severity, is_active)
     VALUES ('${name.replace(/'/g, "''")}', '${String(description).replace(/'/g, "''")}', '${ruleType.replace(/'/g, "''")}', '${condStr.replace(/'/g, "''")}', '${severity.replace(/'/g, "''")}', ${Boolean(isActive)})
     RETURNING *`
  ));
  res.status(201).json(result.rows[0]);
});

// ── PATCH /health-rules/:id — update health rule ──────────────────────────────
router.patch("/health-rules/:id", requireAdmin, async (req, res): Promise<void> => {
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const { name, description, severity, isActive, condition } = req.body;
  const sets: string[] = [];
  if (name !== undefined) sets.push(`name = '${name.replace(/'/g, "''")}'`);
  if (description !== undefined) sets.push(`description = '${String(description).replace(/'/g, "''")}'`);
  if (severity !== undefined) sets.push(`severity = '${severity.replace(/'/g, "''")}'`);
  if (isActive !== undefined) sets.push(`is_active = ${Boolean(isActive)}`);
  if (condition !== undefined) {
    const c = typeof condition === "string" ? condition : JSON.stringify(condition);
    sets.push(`condition = '${c.replace(/'/g, "''")}'`);
  }
  if (!sets.length) { res.status(400).json({ error: "Nothing to update" }); return; }
  const result = await db.execute(sql.raw(`UPDATE health_rules SET ${sets.join(", ")} WHERE id = ${id} RETURNING *`));
  if (!result.rows.length) { res.status(404).json({ error: "Not found" }); return; }
  res.json(result.rows[0]);
});

// ── DELETE /health-rules/:id — delete health rule ─────────────────────────────
router.delete("/health-rules/:id", requireAdmin, async (req, res): Promise<void> => {
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  await db.execute(sql.raw(`DELETE FROM health_rules WHERE id = ${id}`));
  res.json({ ok: true });
});

export default router;
