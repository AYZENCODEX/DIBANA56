import { Router } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { requireAuth, requireDev } from "../middlewares/auth";

const router = Router();

// ── Schema (raw SQL — mirrors the pattern used in settings.ts) ────────────────

async function ensureTables() {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS ui_theme_settings (
      id SERIAL PRIMARY KEY,
      palette_id TEXT NOT NULL DEFAULT 'ash',
      contrast TEXT NOT NULL DEFAULT 'normal',
      density TEXT NOT NULL DEFAULT 'comfortable',
      text_size TEXT NOT NULL DEFAULT 'md',
      font_family TEXT NOT NULL DEFAULT 'mono',
      radius TEXT NOT NULL DEFAULT 'soft',
      sidebar_width TEXT NOT NULL DEFAULT 'default',
      sidebar_animation BOOLEAN NOT NULL DEFAULT true,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS ui_custom_themes (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      is_light BOOLEAN NOT NULL DEFAULT false,
      swatch JSONB NOT NULL,
      vars JSONB NOT NULL,
      created_by INTEGER,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  // Migrated from the old on/off `sidebar_animation` boolean to a speed enum
  // ("off" | "fast" | "normal" | "slow") so the animation is actually
  // configurable, not just toggleable. Safe to run on every request.
  await db.execute(sql`ALTER TABLE ui_theme_settings ADD COLUMN IF NOT EXISTS sidebar_anim_speed TEXT`);
  await db.execute(sql`
    UPDATE ui_theme_settings
    SET sidebar_anim_speed = CASE WHEN sidebar_animation THEN 'normal' ELSE 'off' END
    WHERE sidebar_anim_speed IS NULL
  `);
  await db.execute(sql`ALTER TABLE ui_theme_settings ALTER COLUMN sidebar_anim_speed SET DEFAULT 'normal'`);

  // Per-page theme/layout overrides — page_key is a route pattern from the
  // frontend's route-config.tsx (e.g. "/vault", "/projects/:id"). Every
  // theme/layout field is nullable: null means "inherit the global setting".
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS ui_page_theme_overrides (
      id SERIAL PRIMARY KEY,
      page_key TEXT NOT NULL UNIQUE,
      palette_id TEXT,
      contrast TEXT,
      density TEXT,
      text_size TEXT,
      font_family TEXT,
      radius TEXT,
      sidebar_width TEXT,
      sidebar_anim_speed TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

const REQUIRED_VAR_KEYS = [
  "background", "foreground", "card", "cardForeground", "cardBorder",
  "popover", "popoverForeground", "popoverBorder", "primary", "primaryForeground",
  "secondary", "secondaryForeground", "muted", "mutedForeground", "accent", "accentForeground",
  "border", "input", "ring", "sidebarBackground", "sidebarForeground", "sidebarPrimary",
  "sidebarPrimaryForeground", "sidebarAccent", "sidebarAccentForeground", "sidebarBorder", "sidebarRing",
];

function formatTheme(row: any) {
  return {
    id: row.id,
    paletteId: row.palette_id,
    contrast: row.contrast,
    density: row.density,
    textSize: row.text_size,
    fontFamily: row.font_family,
    radius: row.radius,
    sidebarWidth: row.sidebar_width,
    sidebarAnimationSpeed: row.sidebar_anim_speed ?? (row.sidebar_animation ? "normal" : "off"),
    updatedAt: (row.updated_at instanceof Date ? row.updated_at : new Date(row.updated_at)).toISOString(),
  };
}

function formatCustomTheme(row: any) {
  return {
    id: `custom:${row.id}`,
    dbId: row.id,
    name: row.name,
    description: row.description ?? "",
    swatch: row.swatch,
    isLight: !!row.is_light,
    vars: row.vars,
  };
}

function formatPageOverride(row: any) {
  return {
    dbId: row.id,
    pageKey: row.page_key,
    paletteId: row.palette_id ?? undefined,
    contrast: row.contrast ?? undefined,
    density: row.density ?? undefined,
    textSize: row.text_size ?? undefined,
    fontFamily: row.font_family ?? undefined,
    radius: row.radius ?? undefined,
    sidebarWidth: row.sidebar_width ?? undefined,
    sidebarAnimationSpeed: row.sidebar_anim_speed ?? undefined,
    updatedAt: (row.updated_at instanceof Date ? row.updated_at : new Date(row.updated_at)).toISOString(),
  };
}

async function getOrCreateTheme() {
  const rows = await db.execute(sql`SELECT * FROM ui_theme_settings ORDER BY id ASC LIMIT 1`);
  if (rows.rows.length === 0) {
    const inserted = await db.execute(sql`INSERT INTO ui_theme_settings DEFAULT VALUES RETURNING *`);
    return inserted.rows[0];
  }
  return rows.rows[0];
}

// ── GET /ui-theme — the active global theme (read by every logged-in user) ────
router.get("/ui-theme", requireAuth, async (_req, res): Promise<void> => {
  try {
    await ensureTables();
    const row = await getOrCreateTheme();
    res.json(formatTheme(row));
  } catch (e: any) {
    res.status(500).json({ error: "Failed to load theme", detail: e?.message });
  }
});

// ── GET /ui-theme/custom-themes — list uploaded custom themes (any user, so the
//    active palette can be resolved even if it's a custom one) ────────────────
router.get("/ui-theme/custom-themes", requireAuth, async (_req, res): Promise<void> => {
  try {
    await ensureTables();
    const rows = await db.execute(sql`SELECT * FROM ui_custom_themes ORDER BY id DESC`);
    res.json(rows.rows.map(formatCustomTheme));
  } catch (e: any) {
    res.status(500).json({ error: "Failed to load custom themes", detail: e?.message });
  }
});

// ── PATCH /admin/ui-theme — update the global theme (dev/admin only) ──────────
router.patch("/admin/ui-theme", requireDev, async (req, res): Promise<void> => {
  try {
    await ensureTables();
    const existing: any = await getOrCreateTheme();
    const b = req.body ?? {};

    // If pointing at a custom palette, make sure it actually exists.
    if (b.paletteId !== undefined && typeof b.paletteId === "string" && b.paletteId.startsWith("custom:")) {
      const dbId = Number(b.paletteId.split(":")[1]);
      const found = await db.execute(sql`SELECT id FROM ui_custom_themes WHERE id = ${dbId} LIMIT 1`);
      if (found.rows.length === 0) { res.status(400).json({ error: "Custom theme not found" }); return; }
    }

    const next = {
      palette_id: b.paletteId !== undefined ? String(b.paletteId) : existing.palette_id,
      contrast: b.contrast !== undefined ? String(b.contrast) : existing.contrast,
      density: b.density !== undefined ? String(b.density) : existing.density,
      text_size: b.textSize !== undefined ? String(b.textSize) : existing.text_size,
      font_family: b.fontFamily !== undefined ? String(b.fontFamily) : existing.font_family,
      radius: b.radius !== undefined ? String(b.radius) : existing.radius,
      sidebar_width: b.sidebarWidth !== undefined ? String(b.sidebarWidth) : existing.sidebar_width,
      sidebar_anim_speed: b.sidebarAnimationSpeed !== undefined ? String(b.sidebarAnimationSpeed) : (existing.sidebar_anim_speed ?? "normal"),
    };

    if (!["off", "fast", "normal", "slow"].includes(next.sidebar_anim_speed)) {
      res.status(400).json({ error: "sidebarAnimationSpeed must be one of off, fast, normal, slow" });
      return;
    }

    const updated = await db.execute(sql`
      UPDATE ui_theme_settings SET
        palette_id = ${next.palette_id},
        contrast = ${next.contrast},
        density = ${next.density},
        text_size = ${next.text_size},
        font_family = ${next.font_family},
        radius = ${next.radius},
        sidebar_width = ${next.sidebar_width},
        sidebar_anim_speed = ${next.sidebar_anim_speed},
        sidebar_animation = ${next.sidebar_anim_speed !== "off"},
        updated_at = NOW()
      WHERE id = ${existing.id}
      RETURNING *
    `);
    res.json(formatTheme(updated.rows[0]));
  } catch (e: any) {
    res.status(500).json({ error: "Failed to update theme", detail: e?.message });
  }
});

// ── POST /admin/ui-theme/custom-themes — upload a custom theme (dev/admin) ────
router.post("/admin/ui-theme/custom-themes", requireDev, async (req: any, res): Promise<void> => {
  try {
    await ensureTables();
    const { name, description, isLight, swatch, vars } = req.body ?? {};

    if (!name || !String(name).trim()) { res.status(400).json({ error: "name is required" }); return; }
    if (!vars || typeof vars !== "object") { res.status(400).json({ error: "vars is required" }); return; }

    const missing = REQUIRED_VAR_KEYS.filter(k => typeof vars[k] !== "string" || !vars[k].trim());
    if (missing.length) {
      res.status(400).json({ error: "Theme file is missing required color values", missing });
      return;
    }

    const finalSwatch = Array.isArray(swatch) && swatch.length === 3
      ? swatch
      : [`hsl(${vars.background})`, `hsl(${vars.primary})`, `hsl(${vars.accent})`];

    const inserted = await db.execute(sql`
      INSERT INTO ui_custom_themes (name, description, is_light, swatch, vars, created_by)
      VALUES (${String(name).trim()}, ${description ? String(description).trim() : null}, ${!!isLight},
              ${JSON.stringify(finalSwatch)}::jsonb, ${JSON.stringify(vars)}::jsonb, ${req.user?.userId ?? null})
      RETURNING *
    `);
    res.status(201).json(formatCustomTheme(inserted.rows[0]));
  } catch (e: any) {
    res.status(500).json({ error: "Failed to save custom theme", detail: e?.message });
  }
});

// ── DELETE /admin/ui-theme/custom-themes/:id — remove an uploaded theme ───────
router.delete("/admin/ui-theme/custom-themes/:id", requireDev, async (req, res): Promise<void> => {
  try {
    await ensureTables();
    const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
    if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid id" }); return; }

    await db.execute(sql`DELETE FROM ui_custom_themes WHERE id = ${id}`);

    // If the deleted theme was active, fall back to the default built-in palette
    // so nobody is left pointed at a palette that no longer exists.
    const target = `custom:${id}`;
    await db.execute(sql`UPDATE ui_theme_settings SET palette_id = 'ash', updated_at = NOW() WHERE palette_id = ${target}`);
    await db.execute(sql`UPDATE ui_page_theme_overrides SET palette_id = NULL, updated_at = NOW() WHERE palette_id = ${target}`);

    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: "Failed to delete custom theme", detail: e?.message });
  }
});

// ── GET /ui-theme/page-overrides — all per-page overrides (any user, needed
//    to resolve the effective theme on every page load) ───────────────────────
router.get("/ui-theme/page-overrides", requireAuth, async (_req, res): Promise<void> => {
  try {
    await ensureTables();
    const rows = await db.execute(sql`SELECT * FROM ui_page_theme_overrides ORDER BY id ASC`);
    res.json(rows.rows.map(formatPageOverride));
  } catch (e: any) {
    res.status(500).json({ error: "Failed to load page overrides", detail: e?.message });
  }
});

const PAGE_OVERRIDE_FIELDS: [string, string][] = [
  ["paletteId", "palette_id"], ["contrast", "contrast"], ["density", "density"],
  ["textSize", "text_size"], ["fontFamily", "font_family"], ["radius", "radius"],
  ["sidebarWidth", "sidebar_width"], ["sidebarAnimationSpeed", "sidebar_anim_speed"],
];

// ── POST /admin/ui-theme/page-overrides — upsert a per-page override (dev only).
//    Body: { pageKey, ...any subset of theme fields }. A field set to `null`
//    explicitly clears that field back to "inherit global"; omitted fields are
//    left untouched on an existing row. ─────────────────────────────────────
router.post("/admin/ui-theme/page-overrides", requireDev, async (req, res): Promise<void> => {
  try {
    await ensureTables();
    const b = req.body ?? {};
    const pageKey = typeof b.pageKey === "string" ? b.pageKey.trim() : "";
    if (!pageKey) { res.status(400).json({ error: "pageKey is required" }); return; }

    if (b.paletteId !== undefined && b.paletteId !== null && String(b.paletteId).startsWith("custom:")) {
      const dbId = Number(String(b.paletteId).split(":")[1]);
      const found = await db.execute(sql`SELECT id FROM ui_custom_themes WHERE id = ${dbId} LIMIT 1`);
      if (found.rows.length === 0) { res.status(400).json({ error: "Custom theme not found" }); return; }
    }

    const existingRes = await db.execute(sql`SELECT * FROM ui_page_theme_overrides WHERE page_key = ${pageKey} LIMIT 1`);
    const existing: any = existingRes.rows[0];

    const next: Record<string, any> = {};
    for (const [jsonKey, col] of PAGE_OVERRIDE_FIELDS) {
      if (jsonKey in b) next[col] = b[jsonKey] === null ? null : String(b[jsonKey]);
      else next[col] = existing ? existing[col] : null;
    }

    let row: any;
    if (existing) {
      const updated = await db.execute(sql`
        UPDATE ui_page_theme_overrides SET
          palette_id = ${next.palette_id}, contrast = ${next.contrast}, density = ${next.density},
          text_size = ${next.text_size}, font_family = ${next.font_family}, radius = ${next.radius},
          sidebar_width = ${next.sidebar_width}, sidebar_anim_speed = ${next.sidebar_anim_speed},
          updated_at = NOW()
        WHERE id = ${existing.id}
        RETURNING *
      `);
      row = updated.rows[0];
    } else {
      const inserted = await db.execute(sql`
        INSERT INTO ui_page_theme_overrides
          (page_key, palette_id, contrast, density, text_size, font_family, radius, sidebar_width, sidebar_anim_speed)
        VALUES (${pageKey}, ${next.palette_id}, ${next.contrast}, ${next.density}, ${next.text_size},
                ${next.font_family}, ${next.radius}, ${next.sidebar_width}, ${next.sidebar_anim_speed})
        RETURNING *
      `);
      row = inserted.rows[0];
    }
    res.status(existing ? 200 : 201).json(formatPageOverride(row));
  } catch (e: any) {
    res.status(500).json({ error: "Failed to save page override", detail: e?.message });
  }
});

// ── DELETE /admin/ui-theme/page-overrides/:id — remove a page's override
//    entirely, reverting it to the global theme (dev only) ────────────────────
router.delete("/admin/ui-theme/page-overrides/:id", requireDev, async (req, res): Promise<void> => {
  try {
    await ensureTables();
    const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
    if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid id" }); return; }
    await db.execute(sql`DELETE FROM ui_page_theme_overrides WHERE id = ${id}`);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: "Failed to delete page override", detail: e?.message });
  }
});

export default router;
