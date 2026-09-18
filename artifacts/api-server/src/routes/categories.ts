import { Router } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { requireAuth, requireAdmin } from "../middlewares/auth";

const router = Router();

// ── GET /categories — list categories ────────────────────────────────────────
router.get("/categories", requireAuth, async (req, res): Promise<void> => {
  const { type, parentId } = req.query as Record<string, string>;
  let query = `SELECT * FROM categories WHERE 1=1`;
  if (type) query += ` AND type = '${type.replace(/'/g, "''")}'`;
  if (parentId) query += ` AND parent_id = ${parseInt(parentId, 10)}`;
  else query += ` AND parent_id IS NULL`;
  query += ` ORDER BY name ASC`;
  const result = await db.execute(sql.raw(query));
  res.json(result.rows);
});

// ── GET /categories/all — full tree ───────────────────────────────────────────
router.get("/categories/all", requireAuth, async (req, res): Promise<void> => {
  const { type } = req.query as Record<string, string>;
  let query = `SELECT * FROM categories WHERE 1=1`;
  if (type) query += ` AND type = '${type.replace(/'/g, "''")}'`;
  query += ` ORDER BY parent_id NULLS FIRST, name ASC`;
  const result = await db.execute(sql.raw(query));
  res.json(result.rows);
});

// ── POST /categories — create category (admin only) ───────────────────────────
router.post("/categories", requireAdmin, async (req, res): Promise<void> => {
  const { name, type, parentId, isCustom = true } = req.body;
  if (!name || !type) { res.status(400).json({ error: "name and type are required" }); return; }
  const result = await db.execute(sql.raw(
    `INSERT INTO categories (name, type, parent_id, is_custom) VALUES ('${name.replace(/'/g, "''")}', '${type.replace(/'/g, "''")}', ${parentId ? Number(parentId) : "NULL"}, ${Boolean(isCustom)}) RETURNING *`
  ));
  res.status(201).json(result.rows[0]);
});

// ── PATCH /categories/:id — update category (admin only) ─────────────────────
router.patch("/categories/:id", requireAdmin, async (req, res): Promise<void> => {
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const { name, type } = req.body;
  const sets: string[] = [];
  if (name) sets.push(`name = '${name.replace(/'/g, "''")}'`);
  if (type) sets.push(`type = '${type.replace(/'/g, "''")}'`);
  if (!sets.length) { res.status(400).json({ error: "Nothing to update" }); return; }
  const result = await db.execute(sql.raw(`UPDATE categories SET ${sets.join(", ")} WHERE id = ${id} RETURNING *`));
  if (!result.rows.length) { res.status(404).json({ error: "Not found" }); return; }
  res.json(result.rows[0]);
});

// ── DELETE /categories/:id — delete category (admin only) ────────────────────
router.delete("/categories/:id", requireAdmin, async (req, res): Promise<void> => {
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  await db.execute(sql.raw(`DELETE FROM categories WHERE id = ${id}`));
  res.json({ ok: true });
});

// ── GET /category-templates — list templates ──────────────────────────────────
router.get("/category-templates", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const result = await db.execute(sql.raw(
    `SELECT * FROM category_templates WHERE is_global = true OR created_by = ${userId} ORDER BY name ASC`
  ));
  res.json(result.rows);
});

// ── POST /category-templates — create template ────────────────────────────────
router.post("/category-templates", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const isAdmin = req.user!.role === "admin";
  const { name, type, subCategories = [], isGlobal = false } = req.body;
  if (!name || !type) { res.status(400).json({ error: "name and type are required" }); return; }
  const globalFlag = isAdmin ? Boolean(isGlobal) : false;
  const subCatsJson = JSON.stringify(subCategories).replace(/'/g, "''");
  const result = await db.execute(sql.raw(
    `INSERT INTO category_templates (name, type, sub_categories, created_by, is_global) VALUES ('${name.replace(/'/g, "''")}', '${type.replace(/'/g, "''")}', '${subCatsJson}'::jsonb, ${userId}, ${globalFlag}) RETURNING *`
  ));
  res.status(201).json(result.rows[0]);
});

// ── DELETE /category-templates/:id ───────────────────────────────────────────
router.delete("/category-templates/:id", requireAdmin, async (req, res): Promise<void> => {
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  await db.execute(sql.raw(`DELETE FROM category_templates WHERE id = ${id}`));
  res.json({ ok: true });
});

export default router;
