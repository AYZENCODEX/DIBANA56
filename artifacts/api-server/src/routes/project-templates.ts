/**
 * routes/project-templates.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Project Templates — one-click prefill for admin/projects.tsx's "Initialize
 * New Protocol" dialog. See migrations/070_ayzen_project_templates.sql,
 * migrations/071_ayzen_project_templates_extend.sql, and
 * lib/db/src/schema/project-templates.ts for the full rationale.
 *
 * requireRoles("admin", "moderator") throughout, same as POST /projects
 * itself (routes/projects.ts) — templates are a shared team resource, not
 * scoped per-admin, so any admin/moderator can list, apply, create, edit,
 * or delete any template. There's no per-user ownership check on purpose.
 *
 * Extension (migration 071) added three things on top of the original
 * CRUD: a `folder` grouping, a `usageCount` counter bumped by the new
 * POST .../apply route, and a `defaultForProjectType` slot (at most one
 * template per project_type — enforced here by clearing any prior holder
 * before setting a new one, backed by a partial unique index as a safety
 * net). POST .../duplicate and POST /project-templates/from-project/:id
 * are also new — see each route's comment.
 */
import { Router } from "express";
import { db, projectTemplatesTable, projectsTable, PROJECT_TEMPLATE_DATA_KEYS } from "@workspace/db";
import { eq, desc, sql, and, ne } from "drizzle-orm";
import { requireRoles, getRequestUserId } from "../middlewares/auth";

const router = Router();

function formatTemplate(row: typeof projectTemplatesTable.$inferSelect) {
  let data: Record<string, unknown> = {};
  try { data = JSON.parse(row.data); } catch { /* corrupt/legacy row — surface as empty */ }
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    data,
    folder: row.folder,
    usageCount: row.usageCount,
    defaultForProjectType: row.defaultForProjectType,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// Strips req.body.data down to the allow-listed keys only, so a template
// can never smuggle in identity/media/money fields (see the schema file's
// PROJECT_TEMPLATE_DATA_KEYS comment for why those stay per-project) and a
// typo'd or renamed field on the create form can't silently write garbage
// into every future template.
function pickTemplateData(input: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!input || typeof input !== "object") return out;
  for (const key of PROJECT_TEMPLATE_DATA_KEYS) {
    const val = (input as Record<string, unknown>)[key];
    if (val !== undefined && val !== null && val !== "") out[key] = val;
  }
  return out;
}

// GET /project-templates — list all, most-recently-updated first. Powers
// both the manager page and the "Load from Template" dropdown in the
// create dialog.
router.get("/project-templates", requireRoles("admin", "moderator", "dev"), async (_req, res): Promise<void> => {
  const rows = await db.select().from(projectTemplatesTable).orderBy(desc(projectTemplatesTable.updatedAt));
  res.json({ templates: rows.map(formatTemplate) });
});

router.get("/project-templates/:id", requireRoles("admin", "moderator", "dev"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  const [row] = await db.select().from(projectTemplatesTable).where(eq(projectTemplatesTable.id, id));
  if (!row) { res.status(404).json({ error: "Template not found" }); return; }
  res.json(formatTemplate(row));
});

router.post("/project-templates", requireRoles("admin", "moderator"), async (req, res): Promise<void> => {
  const { name, description, folder } = req.body;
  if (!name || typeof name !== "string" || !name.trim()) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  const data = pickTemplateData(req.body.data);
  const adminUserId = getRequestUserId(req);
  const defaultForProjectType = req.body.defaultForProjectType || null;

  try {
    // Clearing the previous default-holder and inserting the new row must
    // succeed or fail together — previously these were two separate
    // statements, so a name clash on the insert (which throws AFTER the
    // clear already committed) left no template holding that type's
    // default at all, even though nothing new was actually created.
    const row = await db.transaction(async (tx) => {
      if (defaultForProjectType) {
        await tx.update(projectTemplatesTable).set({ defaultForProjectType: null })
          .where(eq(projectTemplatesTable.defaultForProjectType, defaultForProjectType));
      }
      const [inserted] = await tx.insert(projectTemplatesTable).values({
        name: name.trim(),
        description: description?.trim() || null,
        data: JSON.stringify(data),
        folder: folder?.trim() || null,
        defaultForProjectType,
        createdBy: adminUserId ?? 0,
      }).returning();
      return inserted;
    });
    res.status(201).json(formatTemplate(row));
  } catch (err: any) {
    // Unique (lower(name)) violation — same 409-with-clear-message pattern
    // ayzen-mailbox.ts uses for duplicate template/label names.
    if (String(err?.message ?? "").includes("ayzen_project_templates_name_key")) {
      res.status(409).json({ error: `A template named "${name.trim()}" already exists` });
      return;
    }
    throw err;
  }
});

router.patch("/project-templates/:id", requireRoles("admin", "moderator"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  const [existing] = await db.select().from(projectTemplatesTable).where(eq(projectTemplatesTable.id, id));
  if (!existing) { res.status(404).json({ error: "Template not found" }); return; }

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (req.body.name !== undefined) {
    if (!String(req.body.name).trim()) { res.status(400).json({ error: "name cannot be empty" }); return; }
    updates.name = String(req.body.name).trim();
  }
  if (req.body.description !== undefined) updates.description = req.body.description?.trim() || null;
  if (req.body.data !== undefined) updates.data = JSON.stringify(pickTemplateData(req.body.data));
  if (req.body.folder !== undefined) updates.folder = req.body.folder?.trim() || null;
  const nextDefaultType = req.body.defaultForProjectType !== undefined ? (req.body.defaultForProjectType || null) : undefined;
  if (nextDefaultType !== undefined) updates.defaultForProjectType = nextDefaultType;

  try {
    // Same atomicity fix as POST above — clear-then-update in one
    // transaction, so a failed update (name clash) can't strand the
    // system with the old default cleared and no new one set.
    const row = await db.transaction(async (tx) => {
      if (nextDefaultType) {
        await tx.update(projectTemplatesTable).set({ defaultForProjectType: null })
          .where(and(eq(projectTemplatesTable.defaultForProjectType, nextDefaultType), ne(projectTemplatesTable.id, id)));
      }
      const [updated] = await tx.update(projectTemplatesTable).set(updates).where(eq(projectTemplatesTable.id, id)).returning();
      return updated;
    });
    res.json(formatTemplate(row));
  } catch (err: any) {
    if (String(err?.message ?? "").includes("ayzen_project_templates_name_key")) {
      res.status(409).json({ error: `A template named "${req.body.name}" already exists` });
      return;
    }
    throw err;
  }
});

router.delete("/project-templates/:id", requireRoles("admin", "moderator"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  const [deleted] = await db.delete(projectTemplatesTable).where(eq(projectTemplatesTable.id, id)).returning();
  if (!deleted) { res.status(404).json({ error: "Template not found" }); return; }
  res.json({ ok: true });
});

// POST /project-templates/:id/apply — records that a template was actually
// used (bumps usage_count), called by the frontend right after it merges
// the template's fields into a create-project form OR patches an existing
// project with them. Deliberately separate from GET — listing/viewing a
// template in the dropdown must never count as a "use".
router.post("/project-templates/:id/apply", requireRoles("admin", "moderator"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  const [row] = await db.update(projectTemplatesTable)
    .set({ usageCount: sql`${projectTemplatesTable.usageCount} + 1` })
    .where(eq(projectTemplatesTable.id, id))
    .returning();
  if (!row) { res.status(404).json({ error: "Template not found" }); return; }
  res.json(formatTemplate(row));
});

// POST /project-templates/:id/duplicate — clones a template's data/folder
// (never its defaultForProjectType — a duplicate is deliberately NOT the
// new default, to avoid silently stealing that slot from the original) as
// a new row named "Copy of X" (de-duped with a counter suffix if that name
// is already taken, since names are unique).
router.post("/project-templates/:id/duplicate", requireRoles("admin", "moderator"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  const [source] = await db.select().from(projectTemplatesTable).where(eq(projectTemplatesTable.id, id));
  if (!source) { res.status(404).json({ error: "Template not found" }); return; }
  const adminUserId = getRequestUserId(req);

  let candidateName = `Copy of ${source.name}`;
  for (let attempt = 0; attempt < 20; attempt++) {
    const [clash] = await db.select({ id: projectTemplatesTable.id }).from(projectTemplatesTable)
      .where(sql`lower(${projectTemplatesTable.name}) = lower(${candidateName})`);
    if (!clash) break;
    candidateName = `Copy of ${source.name} (${attempt + 2})`;
  }

  const [row] = await db.insert(projectTemplatesTable).values({
    name: candidateName,
    description: source.description,
    data: source.data,
    folder: source.folder,
    createdBy: adminUserId ?? 0,
  }).returning();
  res.status(201).json(formatTemplate(row));
});

// POST /project-templates/from-project/:projectId — builds a new template
// out of an EXISTING project's current fields, for the "I already set this
// project up exactly how I want future ones to start" case (admin/
// project-detail.tsx's "Save as Template" action). Only the allow-listed
// fields are pulled — never name/description/media/social/money.
//
// A raw SELECT is used (not db.select().from(projectsTable)) because
// category/duration_type/difficulty/cost_type aren't in projectsTable's
// Drizzle definition (see routes/projects.ts's POST handler comment on
// category/project_type being "raw-SQL-only columns") — Drizzle's typed
// select would silently omit them.
router.post("/project-templates/from-project/:projectId", requireRoles("admin", "moderator"), async (req, res): Promise<void> => {
  const projectId = parseInt(req.params.projectId, 10);
  const { name, description, folder } = req.body;
  if (!name || typeof name !== "string" || !name.trim()) {
    res.status(400).json({ error: "name is required" });
    return;
  }

  const result = await db.execute(sql`SELECT * FROM projects WHERE id = ${projectId}`);
  const p = result.rows[0] as Record<string, unknown> | undefined;
  if (!p) { res.status(404).json({ error: "Project not found" }); return; }

  // tutorial_steps/badges come back from this raw SELECT as JSON-encoded
  // TEXT (however the project stored them), but a template built from the
  // live create-form (POST /project-templates from admin/projects.tsx's
  // "Save current as template") stores these as real arrays — form state
  // holds them as arrays the whole time, never a stringified blob. Parsing
  // here keeps both template sources producing the same shape; leaving
  // them as strings would hand the Tutorial Steps editor / badge tag-input
  // a string instead of an array the next time this template is applied
  // to the create form, breaking that UI.
  const parseJsonArray = (v: unknown): unknown => {
    if (Array.isArray(v)) return v;
    if (typeof v !== "string" || !v) return v;
    try { const parsed = JSON.parse(v); return Array.isArray(parsed) ? parsed : v; } catch { return v; }
  };

  const data = pickTemplateData({
    category: p.category,
    projectType: p.project_type,
    exchangeSubType: p.exchange_sub_type,
    accountCategory: p.account_category,
    tier: p.tier,
    experienceLevel: p.experience_level,
    durationType: p.duration_type,
    difficulty: p.difficulty,
    costType: p.cost_type,
    xpName: p.xp_name,
    xpPrice: p.xp_price,
    tutorialLink: p.tutorial_link,
    tutorialSteps: parseJsonArray(p.tutorial_steps),
    badges: parseJsonArray(p.badges),
  });

  const adminUserId = getRequestUserId(req);
  try {
    const [row] = await db.insert(projectTemplatesTable).values({
      name: name.trim(),
      description: description?.trim() || `Saved from ${p.name}`,
      data: JSON.stringify(data),
      folder: folder?.trim() || null,
      createdBy: adminUserId ?? 0,
    }).returning();
    res.status(201).json(formatTemplate(row));
  } catch (err: any) {
    if (String(err?.message ?? "").includes("ayzen_project_templates_name_key")) {
      res.status(409).json({ error: `A template named "${name.trim()}" already exists` });
      return;
    }
    throw err;
  }
});

export default router;
