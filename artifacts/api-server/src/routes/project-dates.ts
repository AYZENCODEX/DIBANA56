/**
 * routes/project-dates.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Airdrop calendar — a centralized list of important dates (token snapshot,
 * TGE, claim deadline, whitelist deadline, etc) across every project, so the
 * user doesn't have to track each project's dates separately. Feeds:
 *   - GET  /project-dates        → calendar view (all projects together)
 *   - POST/PATCH/DELETE          → admin management of dates per project
 * The 1-day-ahead Telegram reminder is a separate cron
 * (lib/airdrop-reminder-cron.ts) that reads this same table.
 */
import { Router } from "express";
import { db, projectDatesTable, projectsTable, projectEnrollmentsTable } from "@workspace/db";
import { eq, and, gte, inArray } from "drizzle-orm";
import { requireAuth, requireAdmin } from "../middlewares/auth";
import { logBus } from "../lib/log-bus";

const router = Router();

function formatDate(d: typeof projectDatesTable.$inferSelect & { projectName?: string; thumbnailUrl?: string | null }) {
  return {
    id: d.id,
    projectId: d.projectId,
    projectName: (d as any).projectName ?? null,
    thumbnailUrl: (d as any).thumbnailUrl ?? null,
    label: d.label,
    eventType: d.eventType,
    eventDate: d.eventDate.toISOString(),
    notes: d.notes,
    remindedAt: d.remindedAt ? d.remindedAt.toISOString() : null,
    createdAt: d.createdAt.toISOString(),
  };
}

// ─── GET /project-dates — centralized calendar view ──────────────────────────
// Returns every date across every project, joined with the project's name +
// thumbnail so the calendar can render without a second round-trip per row.
//   ?mine=true          → only dates for projects the current user is enrolled in
//   ?upcomingOnly=true  → drop dates more than a day in the past
router.get("/project-dates", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const mine = req.query.mine === "true";
  const upcomingOnly = req.query.upcomingOnly === "true";

  try {
    let projectIdFilter: number[] | null = null;
    if (mine) {
      const enrollments = await db.select({ projectId: projectEnrollmentsTable.projectId })
        .from(projectEnrollmentsTable)
        .where(eq(projectEnrollmentsTable.userId, userId));
      projectIdFilter = [...new Set(enrollments.map((e) => e.projectId))];
      if (projectIdFilter.length === 0) { res.json([]); return; }
    }

    const rows = await db.select({
      id: projectDatesTable.id,
      projectId: projectDatesTable.projectId,
      label: projectDatesTable.label,
      eventType: projectDatesTable.eventType,
      eventDate: projectDatesTable.eventDate,
      notes: projectDatesTable.notes,
      remindedAt: projectDatesTable.remindedAt,
      createdAt: projectDatesTable.createdAt,
      projectName: projectsTable.name,
      thumbnailUrl: projectsTable.thumbnailUrl,
    })
      .from(projectDatesTable)
      .leftJoin(projectsTable, eq(projectDatesTable.projectId, projectsTable.id))
      .where(and(
        upcomingOnly ? gte(projectDatesTable.eventDate, new Date(Date.now() - 24 * 60 * 60 * 1000)) : undefined,
        projectIdFilter ? inArray(projectDatesTable.projectId, projectIdFilter) : undefined,
      ));

    rows.sort((a, b) => a.eventDate.getTime() - b.eventDate.getTime());
    res.json(rows.map((r) => formatDate(r as any)));
  } catch (err: any) {
    res.status(500).json({ error: "Unable to load calendar", detail: err?.message });
  }
});

// ─── GET /projects/:id/dates — dates for one project (project detail page) ───
// C29: flagged since C25/C28 as a visibility decision — this returns every
// date for `projectId` with no `project_enrollments` check, unlike `?mine=true`
// above. Decision (C29, owner sign-off): intentional, no gate added. Evidence
// that tipped it: `GET /project-dates` (no `mine`) already returns every date
// across every project to any authenticated user — `mine=true` is an opt-in
// convenience filter for "my calendar", not an access boundary, so a project's
// dates were never treated as enrollment-private data. The only current
// frontend caller (`ProjectDatesManager`, admin project-detail settings tab)
// happens to be admin-only, but that's a UI choice, not the reason this is
// safe — the data itself is meant to be public airdrop-calendar info (token
// snapshot/TGE/claim dates), same as the aggregate endpoint. `requireAuth`
// (unchanged) is the correct gate: any signed-in user, no enrollment check.
router.get("/projects/:id/dates", requireAuth, async (req, res): Promise<void> => {
  const projectId = parseInt(req.params.id as string, 10);
  const rows = await db.select().from(projectDatesTable)
    .where(eq(projectDatesTable.projectId, projectId));
  rows.sort((a, b) => a.eventDate.getTime() - b.eventDate.getTime());
  res.json(rows.map((r) => formatDate(r)));
});

// ─── POST /projects/:id/dates — add a date (admin) ────────────────────────────
router.post("/projects/:id/dates", requireAdmin, async (req, res): Promise<void> => {
  const projectId = parseInt(req.params.id as string, 10);
  const { label, eventType, eventDate, notes } = req.body as {
    label?: string; eventType?: string; eventDate?: string; notes?: string;
  };
  if (!label || !String(label).trim()) { res.status(400).json({ error: "label is required" }); return; }
  if (!eventDate || Number.isNaN(new Date(eventDate).getTime())) { res.status(400).json({ error: "A valid eventDate is required" }); return; }

  try {
    const [row] = await db.insert(projectDatesTable).values({
      projectId,
      label: String(label).trim(),
      eventType: eventType || "snapshot",
      eventDate: new Date(eventDate),
      notes: notes || null,
    }).returning();
    logBus.system(`Airdrop calendar: added "${row.label}" for project #${projectId} (${row.eventDate.toISOString()})`);
    res.status(201).json(formatDate(row));
  } catch (err: any) {
    res.status(500).json({ error: "Unable to add date", detail: err?.message });
  }
});

// ─── PATCH /project-dates/:id — edit a date (admin) ──────────────────────────
router.patch("/project-dates/:id", requireAdmin, async (req, res): Promise<void> => {
  const id = parseInt(req.params.id as string, 10);
  const { label, eventType, eventDate, notes } = req.body as {
    label?: string; eventType?: string; eventDate?: string; notes?: string;
  };
  const updates: Partial<typeof projectDatesTable.$inferInsert> = {};
  if (label !== undefined) updates.label = String(label).trim();
  if (eventType !== undefined) updates.eventType = eventType;
  if (notes !== undefined) updates.notes = notes;
  if (eventDate !== undefined) {
    if (Number.isNaN(new Date(eventDate).getTime())) { res.status(400).json({ error: "Invalid eventDate" }); return; }
    updates.eventDate = new Date(eventDate);
    // Date changed — allow the reminder to fire again for the new date.
    (updates as any).remindedAt = null;
  }

  try {
    const [row] = await db.update(projectDatesTable).set(updates)
      .where(eq(projectDatesTable.id, id)).returning();
    if (!row) { res.status(404).json({ error: "Date not found" }); return; }
    res.json(formatDate(row));
  } catch (err: any) {
    res.status(500).json({ error: "Unable to update date", detail: err?.message });
  }
});

// ─── DELETE /project-dates/:id — remove a date (admin) ───────────────────────
router.delete("/project-dates/:id", requireAdmin, async (req, res): Promise<void> => {
  const id = parseInt(req.params.id as string, 10);
  const [row] = await db.delete(projectDatesTable).where(eq(projectDatesTable.id, id)).returning();
  if (!row) { res.status(404).json({ error: "Date not found" }); return; }
  res.json({ success: true });
});

export default router;
