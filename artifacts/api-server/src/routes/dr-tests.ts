/**
 * routes/dr-tests.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * DR Evidence Collector — Phase 1 (Backup Integrity) + Phase 2
 * (Schema-Isolated Restore). See dr-evidence-collector-design.md for the
 * full design, and lib/dr-test-runner.ts for what a run actually checks.
 *
 * Admin-only for now — same as every other admin/*-style route in this app
 * (requireAdmin). No dashboard page ships yet (that's still open, per the
 * design doc's rollout plan); these are plain JSON endpoints an admin can
 * call directly. The node-cron scheduler (lib/dr-test-cron.ts) now also
 * calls runDrTest() automatically on a weekly schedule and emails admins on
 * failure — POST /admin/dr-tests/run-now below is no longer the only way a
 * report gets created, just the on-demand one (triggeredBy: "manual" vs
 * the cron's "scheduled").
 */
import { Router } from "express";
import { db, drTestReportsTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import { requireAdmin, getRequestUserId } from "../middlewares/auth";
import { sensitiveWriteLimiter } from "../middlewares/security";
import { runDrTest } from "../lib/dr-test-runner";

const router = Router();

const MAX_LIST_LIMIT = 100;
const DEFAULT_LIST_LIMIT = 20;

// Triggers one DR test synchronously (checksum → decrypt → isolated-schema
// restore → record-count verification → cleanup) and returns the resulting
// evidence report. sensitiveWriteLimiter because — like other admin
// backup/restore-adjacent actions — this decrypts a real backup and
// restores it (into a throwaway schema, never touching real user rows),
// even though the plaintext/restored rows are never returned and the
// schema is always dropped before the response is sent.
router.post("/admin/dr-tests/run-now", requireAdmin, sensitiveWriteLimiter, async (req, res): Promise<void> => {
  const adminUserId = getRequestUserId(req);
  try {
    const report = await runDrTest({ triggeredBy: "manual", adminUserId });
    res.json({ ok: true, report });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? "DR test failed to run" });
  }
});

// Lists past evidence reports, most recent first.
router.get("/admin/dr-tests", requireAdmin, async (req, res): Promise<void> => {
  const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? DEFAULT_LIST_LIMIT), 10) || DEFAULT_LIST_LIMIT, 1), MAX_LIST_LIMIT);
  const reports = await db.select().from(drTestReportsTable).orderBy(desc(drTestReportsTable.createdAt)).limit(limit);
  res.json({ reports });
});

// Single report detail (e.g. to inspect a failure's failureStage/failureReason).
router.get("/admin/dr-tests/:id", requireAdmin, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid report id" }); return; }
  const [report] = await db.select().from(drTestReportsTable).where(eq(drTestReportsTable.id, id));
  if (!report) { res.status(404).json({ error: "Report not found" }); return; }
  res.json({ report });
});

export default router;
