import { Router } from "express";
import { db, configEntriesTable } from "@workspace/db";
import { eq, asc, and } from "drizzle-orm";
import { requireDev } from "../middlewares/auth";
import { CONFIG_SEEDS, CONFIG_DOMAIN_LABELS } from "./config-seeds";

const router = Router();

async function ensureSeeded(domain: string): Promise<void> {
  const existing = await db.select().from(configEntriesTable).where(eq(configEntriesTable.domain, domain));
  if (existing.length > 0) return;
  const seeds = CONFIG_SEEDS[domain] ?? [];
  for (let i = 0; i < seeds.length; i++) {
    await db.insert(configEntriesTable).values({
      domain, data: seeds[i].data, sortOrder: i, isSeed: true,
    });
  }
}

// ── GET /admin/config/domains — list every known domain + row count ────────
router.get("/admin/config/domains", requireDev, async (_req, res): Promise<void> => {
  const rows = await db.select().from(configEntriesTable);
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.domain, (counts.get(r.domain) ?? 0) + 1);
  const known = new Set([...Object.keys(CONFIG_DOMAIN_LABELS), ...counts.keys()]);
  const domains = [...known].map(domain => ({
    domain,
    label: CONFIG_DOMAIN_LABELS[domain] ?? domain,
    count: counts.get(domain) ?? (CONFIG_SEEDS[domain]?.length ?? 0),
  }));
  res.json(domains);
});

// ── GET /admin/config/:domain — flat list of entries for one domain ────────
router.get("/admin/config/:domain", requireDev, async (req, res): Promise<void> => {
  const domain = req.params.domain as string;
  await ensureSeeded(domain);
  const rows = await db.select().from(configEntriesTable)
    .where(eq(configEntriesTable.domain, domain))
    .orderBy(asc(configEntriesTable.sortOrder));
  res.json(rows);
});

// ── POST /admin/config/:domain — add an entry ───────────────────────────────
router.post("/admin/config/:domain", requireDev, async (req, res): Promise<void> => {
  const domain = req.params.domain as string;
  const { data } = req.body as { data?: Record<string, unknown> };
  if (!data || typeof data !== "object") { res.status(400).json({ error: "data (object) is required" }); return; }
  const siblings = await db.select().from(configEntriesTable).where(eq(configEntriesTable.domain, domain));
  const [created] = await db.insert(configEntriesTable).values({
    domain, data, sortOrder: siblings.length, isSeed: false,
  }).returning();
  res.status(201).json(created);
});

// ── PATCH /admin/config/:domain/:id — edit data / enable / reorder ─────────
router.patch("/admin/config/:domain/:id", requireDev, async (req, res): Promise<void> => {
  const domain = req.params.domain as string;
  const id = parseInt(req.params.id as string, 10);
  const { data, enabled, sortOrder } = req.body as { data?: Record<string, unknown>; enabled?: boolean; sortOrder?: number };

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (data !== undefined) updates.data = data;
  if (enabled !== undefined) updates.enabled = Boolean(enabled);
  if (sortOrder !== undefined) updates.sortOrder = Number(sortOrder);

  const [updated] = await db.update(configEntriesTable).set(updates)
    .where(and(eq(configEntriesTable.id, id), eq(configEntriesTable.domain, domain)))
    .returning();
  if (!updated) { res.status(404).json({ error: "Not found" }); return; }
  res.json(updated);
});

// ── DELETE /admin/config/:domain/:id ────────────────────────────────────────
router.delete("/admin/config/:domain/:id", requireDev, async (req, res): Promise<void> => {
  const domain = req.params.domain as string;
  const id = parseInt(req.params.id as string, 10);
  await db.delete(configEntriesTable).where(and(eq(configEntriesTable.id, id), eq(configEntriesTable.domain, domain)));
  res.json({ ok: true });
});

export default router;
