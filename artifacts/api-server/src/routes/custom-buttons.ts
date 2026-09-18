import { Router } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { requireAuth, requireDev } from "../middlewares/auth";

const router = Router();

const POSITIONS = ["bottom-right", "bottom-left", "top-right", "top-left"];
const VARIANTS = ["solid", "outline", "ghost"];
const COLORS = ["primary", "secondary", "accent", "success", "warning", "danger"];
const SHAPES = ["pill", "rounded", "square"];
const SIZES = ["sm", "md", "lg"];

async function ensureTable() {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS ui_custom_buttons (
      id SERIAL PRIMARY KEY,
      label TEXT NOT NULL,
      icon TEXT NOT NULL DEFAULT 'Link2',
      href TEXT NOT NULL,
      external BOOLEAN NOT NULL DEFAULT false,
      position TEXT NOT NULL DEFAULT 'bottom-right',
      variant TEXT NOT NULL DEFAULT 'solid',
      color TEXT NOT NULL DEFAULT 'primary',
      shape TEXT NOT NULL DEFAULT 'pill',
      size TEXT NOT NULL DEFAULT 'md',
      enabled BOOLEAN NOT NULL DEFAULT true,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

function fmt(row: any) {
  return {
    id: row.id,
    label: row.label,
    icon: row.icon,
    href: row.href,
    external: !!row.external,
    position: row.position,
    variant: row.variant,
    color: row.color,
    shape: row.shape,
    size: row.size,
    enabled: !!row.enabled,
    sortOrder: row.sort_order,
    updatedAt: (row.updated_at instanceof Date ? row.updated_at : new Date(row.updated_at)).toISOString(),
  };
}

function validate(b: any, forCreate: boolean) {
  if (forCreate && (!b.label || !String(b.label).trim())) return "label is required";
  if (forCreate && (!b.href || !String(b.href).trim())) return "href is required";
  if (b.position !== undefined && !POSITIONS.includes(b.position)) return `position must be one of ${POSITIONS.join(", ")}`;
  if (b.variant !== undefined && !VARIANTS.includes(b.variant)) return `variant must be one of ${VARIANTS.join(", ")}`;
  if (b.color !== undefined && !COLORS.includes(b.color)) return `color must be one of ${COLORS.join(", ")}`;
  if (b.shape !== undefined && !SHAPES.includes(b.shape)) return `shape must be one of ${SHAPES.join(", ")}`;
  if (b.size !== undefined && !SIZES.includes(b.size)) return `size must be one of ${SIZES.join(", ")}`;
  return null;
}

// ── GET /ui-custom-buttons — enabled buttons, for rendering site-wide ─────────
router.get("/ui-custom-buttons", requireAuth, async (_req, res): Promise<void> => {
  try {
    await ensureTable();
    const rows = await db.execute(sql`SELECT * FROM ui_custom_buttons WHERE enabled = true ORDER BY position ASC, sort_order ASC`);
    res.json(rows.rows.map(fmt));
  } catch (e: any) {
    res.status(500).json({ error: "Failed to load buttons", detail: e?.message });
  }
});

// ── GET /admin/ui-custom-buttons — every button, incl. disabled (dev/admin) ───
router.get("/admin/ui-custom-buttons", requireDev, async (_req, res): Promise<void> => {
  try {
    await ensureTable();
    const rows = await db.execute(sql`SELECT * FROM ui_custom_buttons ORDER BY position ASC, sort_order ASC`);
    res.json(rows.rows.map(fmt));
  } catch (e: any) {
    res.status(500).json({ error: "Failed to load buttons", detail: e?.message });
  }
});

// ── POST /admin/ui-custom-buttons — add a button ───────────────────────────────
router.post("/admin/ui-custom-buttons", requireDev, async (req, res): Promise<void> => {
  try {
    await ensureTable();
    const b = req.body ?? {};
    const err = validate(b, true);
    if (err) { res.status(400).json({ error: err }); return; }

    const siblings = await db.execute(sql`SELECT COUNT(*)::int AS n FROM ui_custom_buttons WHERE position = ${b.position ?? "bottom-right"}`);
    const nextOrder = (siblings.rows[0] as any)?.n ?? 0;

    const inserted = await db.execute(sql`
      INSERT INTO ui_custom_buttons (label, icon, href, external, position, variant, color, shape, size, enabled, sort_order)
      VALUES (
        ${String(b.label).trim()}, ${b.icon ? String(b.icon) : "Link2"}, ${String(b.href).trim()},
        ${!!b.external}, ${b.position ?? "bottom-right"}, ${b.variant ?? "solid"}, ${b.color ?? "primary"},
        ${b.shape ?? "pill"}, ${b.size ?? "md"}, ${b.enabled === undefined ? true : !!b.enabled}, ${nextOrder}
      )
      RETURNING *
    `);
    res.status(201).json(fmt(inserted.rows[0]));
  } catch (e: any) {
    res.status(500).json({ error: "Failed to create button", detail: e?.message });
  }
});

// ── PATCH /admin/ui-custom-buttons/:id — edit / reposition / reorder / toggle ─
router.patch("/admin/ui-custom-buttons/:id", requireDev, async (req, res): Promise<void> => {
  try {
    await ensureTable();
    const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
    if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid id" }); return; }

    const b = req.body ?? {};
    const err = validate(b, false);
    if (err) { res.status(400).json({ error: err }); return; }

    const existingRows = await db.execute(sql`SELECT * FROM ui_custom_buttons WHERE id = ${id} LIMIT 1`);
    const existing: any = existingRows.rows[0];
    if (!existing) { res.status(404).json({ error: "Not found" }); return; }

    const next = {
      label: b.label !== undefined ? String(b.label).trim() : existing.label,
      icon: b.icon !== undefined ? String(b.icon) : existing.icon,
      href: b.href !== undefined ? String(b.href).trim() : existing.href,
      external: b.external !== undefined ? !!b.external : existing.external,
      position: b.position !== undefined ? b.position : existing.position,
      variant: b.variant !== undefined ? b.variant : existing.variant,
      color: b.color !== undefined ? b.color : existing.color,
      shape: b.shape !== undefined ? b.shape : existing.shape,
      size: b.size !== undefined ? b.size : existing.size,
      enabled: b.enabled !== undefined ? !!b.enabled : existing.enabled,
      sort_order: b.sortOrder !== undefined ? Number(b.sortOrder) : existing.sort_order,
    };

    const updated = await db.execute(sql`
      UPDATE ui_custom_buttons SET
        label = ${next.label}, icon = ${next.icon}, href = ${next.href}, external = ${next.external},
        position = ${next.position}, variant = ${next.variant}, color = ${next.color}, shape = ${next.shape},
        size = ${next.size}, enabled = ${next.enabled}, sort_order = ${next.sort_order}, updated_at = NOW()
      WHERE id = ${id}
      RETURNING *
    `);
    res.json(fmt(updated.rows[0]));
  } catch (e: any) {
    res.status(500).json({ error: "Failed to update button", detail: e?.message });
  }
});

// ── DELETE /admin/ui-custom-buttons/:id ────────────────────────────────────────
router.delete("/admin/ui-custom-buttons/:id", requireDev, async (req, res): Promise<void> => {
  try {
    await ensureTable();
    const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
    if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid id" }); return; }
    await db.execute(sql`DELETE FROM ui_custom_buttons WHERE id = ${id}`);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: "Failed to delete button", detail: e?.message });
  }
});

export default router;
