/**
 * routes/notification-preferences.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Workspace — Phase 7: Notification Bus, settings screen backend.
 *
 * Master plan §11: "one settings screen in the Workspace hub controls all
 * channels for all apps — not six separate notification-preference pages."
 * This is that screen's API: one GET returns every category's channel
 * flags (filled in with the opt-out defaults for any category the user
 * hasn't touched yet), one PUT upserts a single category's row.
 */
import { Router } from "express";
import { db, notificationPreferencesTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { requireAuth, getRequestUser } from "../middlewares/auth";

const router = Router();

const CATEGORIES = ["ryft", "skarn", "verve", "warde", "sylo", "wisp", "system"] as const;
type Category = (typeof CATEGORIES)[number];

const DEFAULT_FLAGS = { inApp: true, telegram: true, email: true, astra: true };

// GET /api/notification-preferences — every category, defaults filled in
router.get("/notification-preferences", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const rows = await db.select().from(notificationPreferencesTable)
    .where(eq(notificationPreferencesTable.userId, authUser.userId));
  const byCategory = new Map(rows.map(r => [r.category, r]));
  const result = CATEGORIES.map((category) => {
    const row = byCategory.get(category);
    return row
      ? { category, inApp: row.inApp, telegram: row.telegram, email: row.email, astra: row.astra }
      : { category, ...DEFAULT_FLAGS };
  });
  res.json(result);
});

// PUT /api/notification-preferences/:category — upsert one category's flags
router.put("/notification-preferences/:category", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const category = req.params.category as Category;
  if (!CATEGORIES.includes(category)) { res.status(400).json({ error: "Unknown category" }); return; }
  const { inApp, telegram, email, astra } = req.body as Partial<typeof DEFAULT_FLAGS>;

  const [existing] = await db.select().from(notificationPreferencesTable)
    .where(and(eq(notificationPreferencesTable.userId, authUser.userId), eq(notificationPreferencesTable.category, category)))
    .limit(1);

  const next = {
    inApp: inApp ?? existing?.inApp ?? DEFAULT_FLAGS.inApp,
    telegram: telegram ?? existing?.telegram ?? DEFAULT_FLAGS.telegram,
    email: email ?? existing?.email ?? DEFAULT_FLAGS.email,
    astra: astra ?? existing?.astra ?? DEFAULT_FLAGS.astra,
  };

  if (existing) {
    await db.update(notificationPreferencesTable)
      .set({ ...next, updatedAt: new Date() })
      .where(eq(notificationPreferencesTable.id, existing.id));
  } else {
    await db.insert(notificationPreferencesTable).values({ userId: authUser.userId, category, ...next });
  }
  res.json({ category, ...next });
});

export default router;
