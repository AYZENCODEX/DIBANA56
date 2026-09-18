import { Router } from "express";
import { db, pageLayoutsTable } from "@workspace/db";
import { eq, asc } from "drizzle-orm";
import { requireAuth, requireDev } from "../middlewares/auth";
import { LAYOUT_PAGES, LAYOUT_PAGE_MAP } from "./layout-sections";

const router = Router();

async function ensureSeeded(pageKey: string): Promise<void> {
  const existing = await db.select().from(pageLayoutsTable).where(eq(pageLayoutsTable.pageKey, pageKey));
  if (existing.length > 0) return;
  const def = LAYOUT_PAGE_MAP[pageKey];
  if (!def) return;
  for (let i = 0; i < def.sections.length; i++) {
    await db.insert(pageLayoutsTable).values({
      pageKey, sectionKey: def.sections[i].key, sortOrder: i, visible: true,
    });
  }
}

// ── GET /layout/:pageKey — public read for any signed-in user; used by the
//    page itself (usePageLayoutOrder) to render sections in the configured
//    order. No dev/admin restriction — every user needs their dashboard's
//    layout, not just devs. Only sectionKey/sortOrder/visible, no labels.
router.get("/layout/:pageKey", requireAuth, async (req, res): Promise<void> => {
  const pageKey = req.params.pageKey as string;
  if (!LAYOUT_PAGE_MAP[pageKey]) { res.status(404).json({ error: "Unknown page" }); return; }
  await ensureSeeded(pageKey);
  const rows = await db.select().from(pageLayoutsTable)
    .where(eq(pageLayoutsTable.pageKey, pageKey))
    .orderBy(asc(pageLayoutsTable.sortOrder));
  res.json(rows.map(r => ({ sectionKey: r.sectionKey, sortOrder: r.sortOrder, visible: r.visible })));
});

// ── GET /admin/layout/pages — every registered page + its section count ───
router.get("/admin/layout/pages", requireDev, async (_req, res): Promise<void> => {
  res.json(LAYOUT_PAGES.map(p => ({ pageKey: p.pageKey, label: p.label, sectionCount: p.sections.length })));
});

// ── GET /admin/layout/:pageKey — current order + visibility, seeded ────────
router.get("/admin/layout/:pageKey", requireDev, async (req, res): Promise<void> => {
  const pageKey = req.params.pageKey as string;
  if (!LAYOUT_PAGE_MAP[pageKey]) { res.status(404).json({ error: "Unknown page" }); return; }
  await ensureSeeded(pageKey);
  const rows = await db.select().from(pageLayoutsTable)
    .where(eq(pageLayoutsTable.pageKey, pageKey))
    .orderBy(asc(pageLayoutsTable.sortOrder));
  // Attach the human label from the registry (not stored in DB).
  const labels = new Map(LAYOUT_PAGE_MAP[pageKey].sections.map(s => [s.key, s.label]));
  res.json(rows.map(r => ({ ...r, label: labels.get(r.sectionKey) ?? r.sectionKey })));
});

// ── PATCH /admin/layout/:pageKey — bulk save order + visibility ────────────
router.patch("/admin/layout/:pageKey", requireDev, async (req, res): Promise<void> => {
  const pageKey = req.params.pageKey as string;
  if (!LAYOUT_PAGE_MAP[pageKey]) { res.status(404).json({ error: "Unknown page" }); return; }
  const { sections } = req.body as { sections?: { sectionKey: string; sortOrder: number; visible: boolean }[] };
  if (!Array.isArray(sections) || sections.length === 0) { res.status(400).json({ error: "sections array is required" }); return; }

  await ensureSeeded(pageKey);
  const existing = await db.select().from(pageLayoutsTable).where(eq(pageLayoutsTable.pageKey, pageKey));
  const byKey = new Map(existing.map(r => [r.sectionKey, r]));

  for (const s of sections) {
    const row = byKey.get(s.sectionKey);
    if (!row) continue; // unknown section key — ignore rather than error, keeps this endpoint tolerant of stale clients
    await db.update(pageLayoutsTable)
      .set({ sortOrder: Number(s.sortOrder), visible: Boolean(s.visible), updatedAt: new Date() })
      .where(eq(pageLayoutsTable.id, row.id));
  }

  const rows = await db.select().from(pageLayoutsTable)
    .where(eq(pageLayoutsTable.pageKey, pageKey))
    .orderBy(asc(pageLayoutsTable.sortOrder));
  res.json(rows);
});

export default router;
