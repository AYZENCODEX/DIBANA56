/**
 * routes/digest-settings.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Drop this at: artifacts/api-server/src/routes/digest-settings.ts
 *
 * Lets the logged-in user choose how often they get pinged with their
 * vault/dashboard risk digest (Telegram + email). The underlying scan
 * itself runs every 6h regardless (see vault-health-cron.ts) so the data
 * behind the digest is always fresh — this preference only controls send
 * cadence, checked in vault-health-scan.ts against last_digest_sent_at.
 */
import { Router } from "express";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireAuth, getRequestUser } from "../middlewares/auth";

const router = Router();

const VALID_FREQUENCIES = new Set(["daily", "weekly", "monthly"]);

// ── GET /users/me/digest — current digest frequency + last sent time ───────
router.get("/users/me/digest", requireAuth, async (req, res): Promise<void> => {
  const user = getRequestUser(req);
  if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }
  const [row] = await db
    .select({ digestFrequency: usersTable.digestFrequency, lastDigestSentAt: usersTable.lastDigestSentAt })
    .from(usersTable)
    .where(eq(usersTable.id, user.userId));
  if (!row) { res.status(404).json({ error: "User not found" }); return; }
  res.json({
    digestFrequency: row.digestFrequency,
    lastDigestSentAt: row.lastDigestSentAt?.toISOString() ?? null,
  });
});

// ── PATCH /users/me/digest — { frequency: "daily" | "weekly" | "monthly" } ─
router.patch("/users/me/digest", requireAuth, async (req, res): Promise<void> => {
  const user = getRequestUser(req);
  if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }

  const frequency = typeof req.body?.frequency === "string" ? req.body.frequency.trim().toLowerCase() : "";
  if (!VALID_FREQUENCIES.has(frequency)) {
    res.status(400).json({ error: "frequency must be one of: daily, weekly, monthly" });
    return;
  }

  await db.update(usersTable).set({ digestFrequency: frequency }).where(eq(usersTable.id, user.userId));
  res.json({ ok: true, digestFrequency: frequency });
});

export default router;
