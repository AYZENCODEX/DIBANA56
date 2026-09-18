import { Router, type Request, type Response } from "express";
import { db, projectsTable, userProjectsTable, tasksTable, usersTable, projectEnrollmentsTable, vaultEntriesTable, projectRatingsTable, entityProjectRoiTable, projectPnlReceiptsTable, financeLedgerEntriesTable } from "@workspace/db";
import { eq, ilike, and, count, sql, isNotNull } from "drizzle-orm";
import crypto from "crypto";
import { broadcastEvent } from "./events";
import { requireAdmin, requireAuth, requireRoles, pepDecisionObserver } from "../middlewares/auth";
import { requireCreditBalance, chargeCredits } from "../services/credit-meter";
import { requireOwnership, requirePublicAudit } from "../lib/policy/pep/middleware";
import { authorize } from "../lib/policy/pep";
import type { ResourceRefBuilder } from "../lib/policy/pep/types";
import type { ResourceRef } from "../lib/policy/types";
import { PolicyEngine } from "../lib/policy/policy-engine";
import { createResourceOwnershipRule } from "../lib/policy/resource";
import { syncOnProjectDelete } from "../services/sync";
import { logSubjectActivity, getSubjectActivitySummary, getUserEnrollmentsOverview, getProjectEnrollmentsOverview, getUserEntitiesOverview } from "../lib/activity-log";
import { decryptRow } from "../lib/vault-crypto";
import { streamFantasticReceiptPdf } from "../lib/receipt-theme";

// ─── Route Integration Roadmap — Season C, Phase C9 (mechanical sweep, batch 9) ─
// The last file from Phase C7's own "combined-where" audit list
// (`ayzen-mailbox.ts` remains deliberately deferred — Phase C7 already
// flagged it as needing its own dedicated phase, not a mechanical-sweep
// batch). `projects.ts` is large (1140+ lines, 30+ routes) but only TWO
// routes actually fit this series' pattern: a client-supplied `:id`
// (here `enrollmentId`) that the handler already re-checks against
// `req.user!.userId` in a combined `and(eq(...))` before acting. Both
// scope the same resource — a project enrollment (`projectEnrollmentsTable`)
// — so they share one `ResourceRefBuilder`/`requireOwnership()` pair.
//
// Everything else with a `:id` in this file is one of:
//   - `requireAdmin`/`requireRoles(...)` already (already PDP-backed via
//     Phase A2 — `PATCH/DELETE /projects/:id`, `PATCH
//     /projects/:id/enrollments/:enrollmentId/status`, `GET
//     /admin/projects/:id/entity-enrollments`, `DELETE
//     /admin/projects/:id/ratings/:ratingId`)
//   - self-scoped by construction, not a lookup-by-client-id: the
//     `:id`/`:enrollmentId` in the query is a *project* id or is
//     paired with `eq(...userId, userId)` baked directly into a
//     read/write that only ever touches the caller's own row
//     (`GET/POST/DELETE .../ratings/me`, `POST`/`DELETE
//     .../pnl-receipt` — composite-keyed on `(userId, projectId)`, no
//     separate resource id to check ownership of) — same exclusion this
//     series has used since Phase B1 for list/create/self-scoped shapes
//   - public, unauthenticated (`GET /projects`, `GET /projects/:id`,
//     `GET /projects/:id/members`, `GET /projects/:id/stats`, `GET
//     /projects/:id/ratings`, `GET /projects/pnl-receipt/:token[/pdf]`)
const PROJECT_ENROLLMENT_OWNER_SENTINEL_NONE = -1;

const projectEnrollmentResource: ResourceRefBuilder = async (req: Request) => {
  const raw = req.params.enrollmentId;
  const id = parseInt(Array.isArray(raw) ? raw[0] : raw, 10);
  if (!Number.isFinite(id)) return { type: "project_enrollment", id: raw, ownerId: PROJECT_ENROLLMENT_OWNER_SENTINEL_NONE };
  const [row] = await db.select({ userId: projectEnrollmentsTable.userId }).from(projectEnrollmentsTable)
    .where(eq(projectEnrollmentsTable.id, id)).limit(1);
  return { type: "project_enrollment", id, ownerId: row?.userId ?? PROJECT_ENROLLMENT_OWNER_SENTINEL_NONE };
};

// `DELETE /projects/:id/enrollments/:enrollmentId` never returned a 404 —
// non-owner/nonexistent id is a pre-existing silent no-op (same shape
// Phase C6/C7 preserved for `notifications.ts`/`email-accounts.ts`
// `DELETE`), so its `onDeny` renders that exact `{ message: "Enrollment
// removed" }` body instead of a 404.
function requireProjectEnrollmentOwnership(action: string, onDeny: (req: Request, res: Response) => void) {
  return requireOwnership(action, projectEnrollmentResource, {
    onDecision: pepDecisionObserver,
    onDeny,
  });
}

// ─── Route Integration Roadmap — Season D, Phase D7 (consistency sweep,
// audit-trail wiring) ───────────────────────────────────────────────────────
// D3's triage put this file's remaining `:id`-shaped routes into bucket ঘ
// ("membership/owner-scoped raw-SQL", 7 routes) — same posture finance.ts's
// own D7 block already documents: no SQL/behavior changes, one `authorize()`
// call added purely for its audit side effect, return value discarded.
//
// Only TWO of those 7 actually have a client-supplied entity id whose real
// owner could genuinely differ from the caller — `:vaultEntryId` (GET
// /projects/entity/:vaultEntryId/overview) and the `vaultEntryId`/
// `kycEntryId` read from the body of `POST /projects/:id/enroll`. Those got
// audit-only wiring here at D7 time, re-fetching each id's REAL owner
// unfiltered by caller (same "never trust an already-`userId`-filtered
// SELECT for the audit — that would make the trail tautological" reasoning
// finance.ts's own header documents), so a genuine mismatch actually showed
// up as a DENY. Season E, Phase E3 (below) promoted the `vaultEntryId` half
// of this to a real, blocking gate; the `kycEntryId` half stays audit-only
// (see E3's own comment for why).
//
// The other 5 (`enrolled-entities`, `enrollments`, `enrollments/overview`,
// `entity-tasks`, `roi-summary`) bake `req.user!.userId` directly into
// their own WHERE/JOIN — the `:id` in their URL is a PROJECT id, which
// isn't an owned resource at all (any user may query their own enrollment
// data for any project), and there is no separate client-controllable
// entity id being compared against an owner. There is no non-tautological
// ownership decision to audit for these five — same "self-scoped, no
// separate resource id" exclusion D3's own bucket গ and finance.ts's
// `PUT /finance/currencies/:currency` already established, just arrived at
// via a raw-SQL JOIN instead of a composite key. Deliberately left
// unwired, not an oversight.
const PROJECTS_OWNER_SENTINEL_NONE = -1;

const vaultEntryOwnerResource: ResourceRefBuilder = async (req: Request) => {
  const raw = req.params.vaultEntryId ?? (req.body as { vaultEntryId?: number | string })?.vaultEntryId;
  const id = parseInt(Array.isArray(raw) ? raw[0] : String(raw), 10);
  if (!Number.isFinite(id)) return { type: "vault_entry", id: raw as any, ownerId: PROJECTS_OWNER_SENTINEL_NONE };
  const [row] = await db.select({ userId: vaultEntriesTable.userId }).from(vaultEntriesTable)
    .where(eq(vaultEntriesTable.id, id)).limit(1);
  return { type: "vault_entry", id, ownerId: row?.userId ?? PROJECTS_OWNER_SENTINEL_NONE };
};
// ─── Route Integration Roadmap — Season E, Phase E3 (projects.ts raw-SQL/
// audit-only group, audit-only → enforcing) ─────────────────────────────────
// Re-triage of this file's D7 block above confirmed its own bucket-breakdown
// still holds: of the file's `:id`-shaped routes, exactly two have a
// client-supplied entity id whose real owner could genuinely differ from the
// caller (`vaultEntryId`, read from either `req.params.vaultEntryId` or
// `req.body.vaultEntryId` — `vaultEntryOwnerResource` already handles both).
// Both already had the audit-only wiring above; this promotes both to a
// real, blocking `requireOwnership()`, same shape E1/E2 already used in
// `finance.ts`. The other 14 flagged-unwired routes in this file are
// confirmed-unchanged per the D7 header comment: 3 public (no auth at all),
// 11 self-scoped-by-construction (composite `(userId, projectId)` key or a
// project id that isn't an owned resource at all) — none of those get a
// gate, same D6/D3 precedent this file already documents. The `kycEntryId`
// half of `POST /projects/:id/enroll` stays audit-only, unpromoted — it's
// read from an OPTIONAL body field, only relevant inside an `if (kycEntryId)`
// branch that already ran its own existence+ownership `SELECT` first; a
// router-level `requireOwnership()` gate runs unconditionally for every
// request and can't skip itself when a field is absent, so this one has to
// stay an inline, conditional audit call, same as it was under D7.
function requireProjectsVaultEntryOwnership(action: string, onDeny: (req: Request, res: Response) => void) {
  return requireOwnership(action, vaultEntryOwnerResource, { onDecision: pepDecisionObserver, onDeny });
}

// `kyc_entries` has no Drizzle table imported in this file (the rest of the
// file reads it via raw SQL too, see the enroll-by-KYC-entity shortcut
// below) — same raw-SQL shape, just for the audit re-fetch instead of the
// route's own logic.
async function kycEntryOwnerResource(kycEntryId: number): Promise<ResourceRef> {
  if (!Number.isFinite(kycEntryId)) return { type: "kyc_entry", id: kycEntryId, ownerId: PROJECTS_OWNER_SENTINEL_NONE };
  const result = await db.execute(sql`SELECT user_id FROM kyc_entries WHERE id = ${kycEntryId} LIMIT 1`);
  const ownerId = (result.rows[0] as any)?.user_id ?? PROJECTS_OWNER_SENTINEL_NONE;
  return { type: "kyc_entry", id: kycEntryId, ownerId };
}
const kycEntryAuditEngine = new PolicyEngine({ onDecision: pepDecisionObserver });
kycEntryAuditEngine.registerRule("resource-ownership", createResourceOwnershipRule());

/** Fire only for the audit side effect — every call site below discards the
 *  return value, same `auditFinanceOwnership()` shape finance.ts's own D7
 *  block establishes. */
async function auditProjectsOwnership(req: Request, engine: PolicyEngine, action: string, resource: ResourceRef): Promise<void> {
  await authorize({ req, engine, action, resource });
}

// Fields decrypted at rest on kyc_entries — mirrors routes/kyc.ts's
// KYC_SENSITIVE_FIELDS, needed here to build the account_data snapshot when
// enrolling straight from a KYC Entity (see /projects/:id/enroll below).
const KYC_ENTRY_SENSITIVE_FIELDS = [
  "account_password", "email_password", "email_2fa", "email_backup_code", "nid_number",
  "account_2fa", "account_backup_code",
  "email_recovery_password", "recovery_2fa", "recovery_backup_code",
] as const;

// Maps a decrypted kyc_entries row onto the same account_data shape the
// manual enroll form produces (project-entities.tsx's ENROLL_EMPTY_FORM) —
// so an enrollment looks identical downstream regardless of which path
// created it.
function accountDataFromKycEntry(k: Record<string, any>): Record<string, unknown> {
  return {
    username: k.username ?? "", accountPassword: k.account_password ?? "",
    email: k.email ?? "", emailPassword: k.email_password ?? "",
    email2fa: k.email_2fa ?? "", emailBackupCode: k.email_backup_code ?? "",
    notes: k.notes ?? "",
    lastLoginAt: k.last_login_at ?? "", buyDate: k.account_buy_date ?? "", createDate: k.account_create_date ?? "",
    currentBuyValue: k.account_buy_price ?? "", currentValue: k.account_worth ?? "", followers: k.followers ?? "",
    emailRecovery: k.email_recovery ?? "", emailRecoveryPassword: k.email_recovery_password ?? "",
    recovery2fa: k.recovery_2fa ?? "", recoveryBackupCode: k.recovery_backup_code ?? "",
  };
}

const router = Router();

/** Optional auth for public routes that personalize when a valid token is present. */
async function getOptionalUserId(req: { headers: { authorization?: string } }): Promise<number | null> {
  const authHeader = req.headers.authorization;
  if (!authHeader) return null;
  const { getUserFromToken } = await import("../lib/auth-utils");
  const user = await getUserFromToken(authHeader.replace("Bearer ", "").trim());
  return user ? user.userId : null;
}

function formatProject(p: typeof projectsTable.$inferSelect, taskCount = 0, completedTaskCount = 0, activeUserCount = 0) {
  return { ...p, createdAt: p.createdAt.toISOString(), taskCount, completedTaskCount, activeUserCount };
}

// GET /projects/entity/:vaultEntryId/overview — cross-project stats for one entity (MUST be before /:id)
// Pre-gating, a non-owned/nonexistent vaultEntryId already replied 200 with
// an empty/null-shaped body (the queries below were already scoped by
// `user_id = ${userId}`, so a mismatch just returned no rows, never a 404)
// — the promoted gate's `onDeny` reproduces that exact shape, per
// OWNERSHIP_GATING_GUIDE.md's "silent no-op" deny case, not a new 404.
function projectEntityOverviewSilentDeny(req: Request, res: Response): void {
  const raw = Array.isArray(req.params.vaultEntryId) ? req.params.vaultEntryId[0] : req.params.vaultEntryId;
  const vaultEntryId = parseInt(raw as string, 10);
  res.json({
    entity: null,
    vaultEntryId,
    projects: [],
    activity: [],
    summary: { totalProjects: 0, completedProjects: 0, ongoingProjects: 0, totalRoi: 0, totalProfit: 0, totalCost: 0 },
  });
}

router.get("/projects/entity/:vaultEntryId/overview", requireAuth, requireProjectsVaultEntryOwnership("project.entity_overview.read", projectEntityOverviewSilentDeny), async (req, res): Promise<void> => {
  const vaultEntryId = parseInt(Array.isArray(req.params.vaultEntryId) ? req.params.vaultEntryId[0] : req.params.vaultEntryId, 10);
  const userId = req.user!.userId;
  try {
    const rows = await db.execute(sql.raw(
      `SELECT
         p.id as project_id, p.name as project_name, p.project_type, p.category,
         p.thumbnail_url,
         (SELECT COUNT(*) FROM tasks WHERE project_id = p.id)::int as total_tasks,
         (SELECT COUNT(*) FROM task_submissions ts2
            JOIN tasks t2 ON t2.id = ts2.task_id
            WHERE t2.project_id = p.id AND ts2.user_id = ${userId} AND ts2.status IN ('approved','completed'))::int as completed_tasks,
         COALESCE((SELECT SUM(ts3.profit) FROM task_submissions ts3
            JOIN tasks t3 ON t3.id = ts3.task_id
            WHERE t3.project_id = p.id AND ts3.user_id = ${userId} AND ts3.status IN ('approved','completed')), 0) as total_profit,
         COALESCE((SELECT SUM(ts4.cost) FROM task_submissions ts4
            JOIN tasks t4 ON t4.id = ts4.task_id
            WHERE t4.project_id = p.id AND ts4.user_id = ${userId} AND ts4.status IN ('approved','completed')), 0) as total_cost,
         pe.id as enrollment_id, pe.enrolled_at, pe.status as enrollment_status
       FROM project_enrollments pe
       JOIN projects p ON p.id = pe.project_id
       WHERE pe.vault_entry_id = ${vaultEntryId} AND pe.user_id = ${userId}
       ORDER BY pe.enrolled_at DESC`
    ));
    const entity = await db.execute(sql.raw(
      `SELECT entity_serial, project_name as entity_name, category, twitter_username, discord_username, email
       FROM vault_entries WHERE id = ${vaultEntryId} AND user_id = ${userId}`
    ));
    const projects = (rows.rows as any[]).map(r => ({
      projectId: Number(r.project_id),
      projectName: r.project_name,
      projectType: r.project_type ?? "protocol",
      category: r.category,
      thumbnailUrl: r.thumbnail_url,
      totalTasks: Number(r.total_tasks),
      completedTasks: Number(r.completed_tasks),
      progress: Number(r.total_tasks) > 0 ? Math.round((Number(r.completed_tasks) / Number(r.total_tasks)) * 100) : 0,
      totalProfit: Number(r.total_profit),
      totalCost: Number(r.total_cost),
      roi: Number(r.total_profit) - Number(r.total_cost),
      enrollmentId: Number(r.enrollment_id),
      enrolledAt: r.enrolled_at,
      enrollmentStatus: (r.enrollment_status as string) ?? "active",
    }));
    const totalRoi = projects.reduce((s, p) => s + p.roi, 0);
    const totalProfit = projects.reduce((s, p) => s + p.totalProfit, 0);
    const totalCost = projects.reduce((s, p) => s + p.totalCost, 0);
    const completedProjects = projects.filter(p => p.enrollmentStatus === "completed").length;
    const ongoingProjects = projects.length - completedProjects;
    // Activity heatmap data — task completions by day (past 365 days)
    const activityRows = await db.execute(sql.raw(
      `SELECT DATE(ts.submitted_at)::text as day, COUNT(*)::int as count
       FROM task_submissions ts
       JOIN tasks t ON t.id = ts.task_id
       JOIN project_enrollments pe ON pe.project_id = t.project_id
       WHERE pe.vault_entry_id = ${vaultEntryId}
         AND ts.user_id = ${userId}
         AND ts.status IN ('approved', 'completed')
         AND ts.submitted_at >= NOW() - INTERVAL '365 days'
       GROUP BY DATE(ts.submitted_at)
       ORDER BY day ASC`
    ));
    const activity = (activityRows.rows as any[]).map(r => ({
      day: String(r.day),
      count: Number(r.count),
    }));

    res.json({
      entity: entity.rows[0] ?? null,
      vaultEntryId,
      projects,
      activity,
      summary: { totalProjects: projects.length, completedProjects, ongoingProjects, totalRoi, totalProfit, totalCost },
    });
  } catch (err: any) {
    res.status(500).json({ error: "DB error", detail: err?.message });
  }
});

// GET /projects/enrolled — projects the current user has entities enrolled in
// Used by Enrollment → Project sidebar page. Returns projects with their
// enrolled entity count. Only active/completed enrollments (not cancelled/banned).
router.get("/projects/enrolled", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  try {
    const result = await db.execute(sql.raw(`
      SELECT p.id, p.name, p.category, p.status,
             COUNT(DISTINCT pe.vault_entry_id)::int AS enrolled_count
      FROM projects p
      JOIN project_enrollments pe ON pe.project_id = p.id AND pe.user_id = ${userId}
      WHERE pe.status NOT IN ('cancelled', 'banned')
      GROUP BY p.id, p.name, p.category, p.status
      ORDER BY p.name
    `));
    res.json(result.rows);
  } catch (err: any) {
    res.status(500).json({ error: "DB error", detail: err?.message });
  }
});

// GET /projects/:id/enrolled-entities — vault entities enrolled in a specific project
// Used by Enrollment → Project drill-down when the user clicks a project row.
router.get("/projects/:id/enrolled-entities", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const projectId = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  if (isNaN(projectId)) { res.status(400).json({ error: "Invalid project id" }); return; }
  try {
    const result = await db.execute(sql.raw(`
      SELECT ve.id, ve.project_name, ve.category, ve.entity_serial, ve.status,
             ve.twitter_username, ve.discord_username, ve.telegram_username,
             pe.status AS enrollment_status
      FROM project_enrollments pe
      JOIN vault_entries ve ON ve.id = pe.vault_entry_id
      WHERE pe.project_id = ${projectId} AND pe.user_id = ${userId}
        AND pe.status NOT IN ('cancelled', 'banned')
      ORDER BY pe.created_at DESC
    `));
    res.json(result.rows);
  } catch (err: any) {
    res.status(500).json({ error: "DB error", detail: err?.message });
  }
});

// GET /projects/entity-leaderboard — all entities ranked by ROI (MUST be before /:id)
router.get("/projects/entity-leaderboard", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  try {
    const rows = await db.execute(sql.raw(
      `SELECT
         ve.id as vault_entry_id,
         ve.entity_serial,
         ve.project_name as entity_name,
         ve.category,
         (SELECT COUNT(DISTINCT pe.project_id)::int
          FROM project_enrollments pe WHERE pe.vault_entry_id = ve.id AND pe.user_id = ${userId}
         ) as total_projects,
         (SELECT COUNT(DISTINCT pe.project_id)::int
          FROM project_enrollments pe WHERE pe.vault_entry_id = ve.id AND pe.user_id = ${userId} AND pe.status = 'completed'
         ) as completed_projects,
         (SELECT COUNT(DISTINCT pe.project_id)::int
          FROM project_enrollments pe WHERE pe.vault_entry_id = ve.id AND pe.user_id = ${userId} AND pe.status != 'completed'
         ) as ongoing_projects,
         -- Phase 18: per-status breakdown (Phase 5's disqualify/ban/cancel-enrollment
         -- statuses) — powers the vault card/quick-view enrollment summary + status
         -- flags without a separate per-entity request.
         (SELECT COUNT(DISTINCT pe.project_id)::int
          FROM project_enrollments pe WHERE pe.vault_entry_id = ve.id AND pe.user_id = ${userId} AND pe.status = 'active'
         ) as active_projects,
         (SELECT COUNT(DISTINCT pe.project_id)::int
          FROM project_enrollments pe WHERE pe.vault_entry_id = ve.id AND pe.user_id = ${userId} AND pe.status = 'disqualified'
         ) as disqualified_projects,
         (SELECT COUNT(DISTINCT pe.project_id)::int
          FROM project_enrollments pe WHERE pe.vault_entry_id = ve.id AND pe.user_id = ${userId} AND pe.status = 'banned'
         ) as banned_projects,
         (SELECT COUNT(DISTINCT pe.project_id)::int
          FROM project_enrollments pe WHERE pe.vault_entry_id = ve.id AND pe.user_id = ${userId} AND pe.status = 'cancelled'
         ) as cancelled_projects,
         COALESCE((
           SELECT COUNT(*)::int FROM task_submissions ts
           JOIN tasks t ON t.id = ts.task_id
           JOIN project_enrollments pe ON pe.project_id = t.project_id AND pe.vault_entry_id = ve.id
           WHERE ts.user_id = ${userId} AND ts.status IN ('approved','completed')
         ), 0) as total_completions,
         COALESCE((
           SELECT SUM(ts.profit) FROM task_submissions ts
           JOIN tasks t ON t.id = ts.task_id
           JOIN project_enrollments pe ON pe.project_id = t.project_id AND pe.vault_entry_id = ve.id
           WHERE ts.user_id = ${userId} AND ts.status IN ('approved','completed')
         ), 0)::float as total_profit,
         COALESCE((
           SELECT SUM(ts.cost) FROM task_submissions ts
           JOIN tasks t ON t.id = ts.task_id
           JOIN project_enrollments pe ON pe.project_id = t.project_id AND pe.vault_entry_id = ve.id
           WHERE ts.user_id = ${userId} AND ts.status IN ('approved','completed')
         ), 0)::float as total_cost
       FROM vault_entries ve
       WHERE ve.user_id = ${userId}`
    ));
    const entities = (rows.rows as any[])
      .map(r => ({
        vaultEntryId:     Number(r.vault_entry_id),
        entitySerial:     r.entity_serial as string | null,
        entityName:       r.entity_name as string | null,
        category:         r.category as string | null,
        totalProjects:    Number(r.total_projects),
        completedProjects: Number(r.completed_projects),
        ongoingProjects:  Number(r.ongoing_projects),
        activeProjects:       Number(r.active_projects),
        disqualifiedProjects: Number(r.disqualified_projects),
        bannedProjects:       Number(r.banned_projects),
        cancelledProjects:    Number(r.cancelled_projects),
        totalCompletions: Number(r.total_completions),
        totalProfit:      Number(r.total_profit),
        totalCost:        Number(r.total_cost),
        totalRoi:         Number(r.total_profit) - Number(r.total_cost),
      }))
      .sort((a, b) => b.totalRoi - a.totalRoi)
      .map((e, i) => ({ ...e, rank: i + 1 }));
    res.json(entities);
  } catch (err: any) {
    res.status(500).json({ error: "DB error", detail: err?.message });
  }
});

router.get("/projects", async (req, res): Promise<void> => {
  const { tier, search, page = "1", limit = "20", type, exchangeSubType, accountCategory } = req.query as Record<string, string>;
  const pageNum = parseInt(page, 10);
  const limitNum = Math.min(parseInt(limit, 10), 200);
  const offset = (pageNum - 1) * limitNum;

  const conditions = [];
  if (tier) conditions.push(eq(projectsTable.tier, tier));
  if (search) conditions.push(ilike(projectsTable.name, `%${search}%`));
  if (type && type !== "all") conditions.push(sql.raw(`project_type = '${type.replace(/'/g,"''")}'`));
  if (exchangeSubType) conditions.push(sql.raw(`exchange_sub_type = '${exchangeSubType.replace(/'/g,"''")}'`));
  if (accountCategory && accountCategory !== "all") conditions.push(sql.raw(`(account_category = '${accountCategory.replace(/'/g,"''")}' OR account_category = 'both')`));
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const projects = await db.select().from(projectsTable).where(where).limit(limitNum).offset(offset);
  const [{ total }] = await db.select({ total: count() }).from(projectsTable).where(where);

  const enriched = await Promise.all(projects.map(async (p) => {
    const [{ taskCount }] = await db.select({ taskCount: count() }).from(tasksTable).where(eq(tasksTable.projectId, p.id));
    const [{ memberCount }] = await db.select({ memberCount: count() }).from(userProjectsTable).where(eq(userProjectsTable.projectId, p.id));
    return formatProject(p, Number(taskCount), 0, Number(memberCount));
  }));

  res.json({ projects: enriched, total: Number(total), page: pageNum, limit: limitNum });
});

router.post("/projects", requireRoles("admin", "moderator"), async (req, res): Promise<void> => {
  const { name, description, xpName, xpPrice, twitterHandle, discordUrl, websiteUrl, tutorialLink, tutorialSteps, badges, experienceLevel, tier, fundingAmount, rewardEstimate, thumbnailUrl, bannerUrl } = req.body;
  if (!name) { res.status(400).json({ error: "name is required" }); return; }
  const [project] = await db.insert(projectsTable).values({
    name, description, xpName: xpName || null, twitterHandle, discordUrl, websiteUrl, tutorialLink,
    // xpPrice has a DB default (0.01) but was never actually read from the
    // request body here — every project silently got the default
    // regardless of what the create form (or a Project Template, see
    // routes/project-templates.ts) sent. Fixed alongside the Project
    // Templates feature since a template's XP system is one of the
    // fields it's meant to carry.
    xpPrice: xpPrice !== undefined && xpPrice !== null && xpPrice !== "" ? Number(xpPrice) : undefined,
    tutorialSteps: tutorialSteps ? (typeof tutorialSteps === "string" ? tutorialSteps : JSON.stringify(tutorialSteps)) : null,
    // Phase 7A — same string-or-array-in, JSON-string-out convention as tutorialSteps.
    badges: badges ? (typeof badges === "string" ? badges : JSON.stringify(badges)) : null,
    experienceLevel: experienceLevel ?? "Beginner",
    tier: tier ?? "1",
    fundingAmount: Number(fundingAmount ?? 0),
    rewardEstimate: Number(rewardEstimate ?? 0),
    thumbnailUrl,
    bannerUrl,
  }).returning();

  // category/project_type/deadline aren't in the Drizzle insert above (project_type
  // and deadline are raw-SQL-only columns, same as in PATCH below) — without this,
  // a newly created project never gets a project_type, so it's invisible to every
  // sidebar ?type=/?rollup= link. Applied as a follow-up raw UPDATE so the typed
  // insert above stays simple.
  const createRawSets: string[] = [];
  if (req.body.category !== undefined) createRawSets.push(`category = '${String(req.body.category).replace(/'/g, "''")}'`);
  if (req.body.projectType !== undefined) createRawSets.push(`project_type = '${String(req.body.projectType).replace(/'/g, "''")}'`);
  if (req.body.exchangeSubType !== undefined) createRawSets.push(`exchange_sub_type = '${String(req.body.exchangeSubType).replace(/'/g, "''")}'`);
  if (req.body.accountCategory !== undefined) createRawSets.push(`account_category = '${String(req.body.accountCategory).replace(/'/g, "''")}'`);
  if (req.body.deadline) createRawSets.push(`deadline = '${req.body.deadline}'`);
  // durationType/difficulty/costType columns existed (schema-migrations.ts)
  // but were never read from the request body here — same gap as xpPrice
  // above, fixed alongside the Project Templates feature.
  if (req.body.durationType !== undefined) createRawSets.push(`duration_type = '${String(req.body.durationType).replace(/'/g, "''")}'`);
  if (req.body.difficulty !== undefined) createRawSets.push(`difficulty = '${String(req.body.difficulty).replace(/'/g, "''")}'`);
  if (req.body.costType !== undefined) createRawSets.push(`cost_type = '${String(req.body.costType).replace(/'/g, "''")}'`);

  let finalProject = project;
  if (createRawSets.length > 0) {
    const result = await db.execute(sql.raw(`UPDATE projects SET ${createRawSets.join(", ")} WHERE id = ${project.id} RETURNING *`));
    finalProject = (result.rows[0] as typeof project) ?? project;
  }

  broadcastEvent("projects_updated", { action: "created", projectId: finalProject.id });

  // Telegram alert — every user with Telegram linked gets pinged that a new
  // project just went live. Best-effort, never blocks project creation.
  import("../lib/telegram").then(({ notifyNewProject }) =>
    notifyNewProject({ id: finalProject.id, name: finalProject.name, tier: finalProject.tier })
  ).catch(() => {});

  res.status(201).json(formatProject(finalProject));
});

router.get("/projects/:id", async (req, res): Promise<void> => {
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const userId = await getOptionalUserId(req);
  const [project] = await db.select().from(projectsTable).where(eq(projectsTable.id, id));
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }
  const tasks = await db.select().from(tasksTable).where(eq(tasksTable.projectId, id));
  const [{ memberCount }] = await db.select({ memberCount: count() }).from(userProjectsTable).where(eq(userProjectsTable.projectId, id));
  const enrollments = userId ? await db.select().from(projectEnrollmentsTable)
    .where(and(eq(projectEnrollmentsTable.projectId, id), eq(projectEnrollmentsTable.userId, userId))) : [];
  const isJoined = enrollments.length > 0;
  // category/duration_type/difficulty/cost_type are raw-SQL-only columns
  // (not in projectsTable's Drizzle definition — see POST /projects'
  // comment), so the typed select above silently drops them. Needed here
  // so admin/project-detail.tsx's "Apply Template" preview can diff a
  // template's category/durationType/difficulty/costType against what the
  // project actually has, not against undefined.
  const rawExtra = await db.execute(sql`SELECT category, duration_type, difficulty, cost_type FROM projects WHERE id = ${id}`);
  const extra = rawExtra.rows[0] as Record<string, unknown> | undefined;
  res.json({
    ...formatProject(project, tasks.length, 0, Number(memberCount)),
    category: extra?.category ?? null,
    durationType: extra?.duration_type ?? null,
    difficulty: extra?.difficulty ?? null,
    costType: extra?.cost_type ?? null,
    tasks: tasks.map(t => ({ ...t, createdAt: t.createdAt.toISOString(), projectName: project.name, userStatus: null })),
    isJoined,
    enrollmentCount: enrollments.length,
    userProgress: 0,
  });
});

router.patch("/projects/:id", requireAdmin, async (req, res): Promise<void> => {
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const updates: Record<string, unknown> = {};
  const fields = ["name", "description", "xpName", "xpPrice", "twitterHandle", "discordUrl", "websiteUrl", "tutorialLink", "experienceLevel", "tier", "fundingAmount", "rewardEstimate", "thumbnailUrl", "bannerUrl"];
  for (const f of fields) if (req.body[f] !== undefined) updates[f] = req.body[f];
  if (req.body.tutorialSteps !== undefined) {
    updates.tutorialSteps = typeof req.body.tutorialSteps === "string" ? req.body.tutorialSteps : JSON.stringify(req.body.tutorialSteps);
  }
  // Phase 7A — badges/tags, same string-or-array-in, JSON-string-out convention as tutorialSteps.
  if (req.body.badges !== undefined) {
    updates.badges = typeof req.body.badges === "string" ? req.body.badges : JSON.stringify(req.body.badges);
  }

  // Extra raw-SQL fields not in Drizzle schema yet
  const rawSets: string[] = [];
  if (req.body.deadline !== undefined) rawSets.push(`deadline = ${req.body.deadline ? `'${req.body.deadline}'` : "NULL"}`);
  if (req.body.startedAt !== undefined) rawSets.push(`started_at = ${req.body.startedAt ? `'${req.body.startedAt}'` : "NULL"}`);
  if (req.body.status !== undefined) rawSets.push(`status = '${String(req.body.status).replace(/'/g, "''")}'`);
  if (req.body.projectType !== undefined) rawSets.push(`project_type = '${String(req.body.projectType).replace(/'/g, "''")}'`);
  if (req.body.exchangeSubType !== undefined) rawSets.push(`exchange_sub_type = '${String(req.body.exchangeSubType).replace(/'/g, "''")}'`);
  if (req.body.accountCategory !== undefined) rawSets.push(`account_category = '${String(req.body.accountCategory).replace(/'/g, "''")}'`);
  if (req.body.exchangeCustomCategories !== undefined) rawSets.push(`exchange_custom_categories = ${req.body.exchangeCustomCategories ? `'${JSON.stringify(req.body.exchangeCustomCategories).replace(/'/g, "''")}'` : "NULL"}`);
  // durationType/difficulty/costType/category — same "existing column,
  // never wired up" gap as xpPrice above (see POST /projects' comment),
  // fixed here so Project Templates can actually re-apply these onto an
  // existing project via this route.
  if (req.body.durationType !== undefined) rawSets.push(`duration_type = '${String(req.body.durationType).replace(/'/g, "''")}'`);
  if (req.body.difficulty !== undefined) rawSets.push(`difficulty = '${String(req.body.difficulty).replace(/'/g, "''")}'`);
  if (req.body.costType !== undefined) rawSets.push(`cost_type = '${String(req.body.costType).replace(/'/g, "''")}'`);
  if (req.body.category !== undefined) rawSets.push(`category = '${String(req.body.category).replace(/'/g, "''")}'`);

  try {
    let project: any;
    if (Object.keys(updates).length > 0) {
      const [p] = await db.update(projectsTable).set(updates).where(eq(projectsTable.id, id)).returning();
      project = p;
    }
    if (rawSets.length > 0) {
      const result = await db.execute(sql.raw(`UPDATE projects SET ${rawSets.join(", ")} WHERE id = ${id} RETURNING *`));
      project = result.rows[0] ?? project;
    }
    if (!project) {
      const [p] = await db.select().from(projectsTable).where(eq(projectsTable.id, id));
      project = p;
    }
    if (!project) { res.status(404).json({ error: "Project not found" }); return; }
    broadcastEvent("projects_updated", { action: "updated", projectId: id });
    const p = project as any;
    res.json({
      ...p,
      createdAt: p.createdAt instanceof Date ? p.createdAt.toISOString() : p.createdAt,
      deadline: p.deadline instanceof Date ? p.deadline.toISOString() : (p.deadline ?? null),
      startedAt: p.started_at instanceof Date ? p.started_at.toISOString() : (p.started_at ?? null),
      status: p.status ?? "active",
    });
  } catch (err: any) {
    res.status(500).json({ error: "DB error", detail: err?.message });
  }
});

router.delete("/projects/:id", requireAdmin, async (req, res): Promise<void> => {
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  await db.delete(projectsTable).where(eq(projectsTable.id, id));
  broadcastEvent("projects_updated", { action: "deleted", projectId: id });
  syncOnProjectDelete(id).catch(() => {});
  res.json({ message: "Project deleted" });
});

router.post("/projects/:id/join", requireAuth, async (req, res): Promise<void> => {
  const projectId = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const userId = req.user!.userId;
  const existing = await db.select().from(userProjectsTable).where(and(eq(userProjectsTable.userId, userId), eq(userProjectsTable.projectId, projectId)));
  if (existing.length === 0) {
    await db.insert(userProjectsTable).values({ userId, projectId });
  }
  res.json({ message: "Joined project" });
});

// PHASE 5 (admin credit console request): enrolling a vault entity into a
// project is a metered action (workspace.project_use) — charge-on-success
// at whichever branch below actually commits (reactivation or a fresh
// enrollment); validation failures (404/409/403 above) never touch the
// ledger.
router.post("/projects/:id/enroll", requireAuth, requireProjectsVaultEntryOwnership("project.enroll", (_req, res) => { res.status(404).json({ error: "Vault entity not found" }); }), requireCreditBalance("workspace.project_use"), async (req, res): Promise<void> => {
  const projectId = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const userId = req.user!.userId;
  const { vaultEntryId, kycEntryId, dataEntityId } = req.body as {
    vaultEntryId: number; kycEntryId?: number; dataEntityId?: number;
  };
  let { accountData } = req.body as { accountData?: Record<string, unknown> };
  if (!vaultEntryId) { res.status(400).json({ error: "vaultEntryId is required" }); return; }

  const [vaultEntry] = await db.select().from(vaultEntriesTable)
    .where(and(eq(vaultEntriesTable.id, vaultEntryId), eq(vaultEntriesTable.userId, userId)));
  if (!vaultEntry) { res.status(404).json({ error: "Vault entity not found" }); return; }

  // Exchange enroll-by-KYC-entity shortcut — no manual form. Verify the KYC
  // Entity belongs to this user, isn't already spent on another active
  // enrollment, and auto-build account_data from its own fields.
  if (kycEntryId) {
    const kycResult = await db.execute(sql`SELECT * FROM kyc_entries WHERE id = ${kycEntryId} AND user_id = ${userId} LIMIT 1`);
    if (!kycResult.rows.length) { res.status(404).json({ error: "KYC entity not found" }); return; }
    // D7: audit-only, see the file-header block above — the check above
    // already decided the 404 (unchanged); re-reads kycEntryId's real
    // owner unfiltered for the same non-tautological reason as the
    // vaultEntryId call above.
    await auditProjectsOwnership(req, kycEntryAuditEngine, "project.enroll.kyc_entry", await kycEntryOwnerResource(kycEntryId));
    const [inUse] = await db.select().from(projectEnrollmentsTable)
      .where(and(eq(projectEnrollmentsTable.kycEntryId, kycEntryId), eq(projectEnrollmentsTable.status, "active")));
    if (inUse && inUse.vaultEntryId !== vaultEntryId) {
      res.status(409).json({ error: "This KYC entity is already enrolled elsewhere" }); return;
    }
    const kycRow = decryptRow(kycResult.rows[0] as Record<string, any>, KYC_ENTRY_SENSITIVE_FIELDS);
    accountData = accountDataFromKycEntry(kycRow);
  }

  const [existing] = await db.select().from(projectEnrollmentsTable)
    .where(and(eq(projectEnrollmentsTable.projectId, projectId), eq(projectEnrollmentsTable.userId, userId), eq(projectEnrollmentsTable.vaultEntryId, vaultEntryId)));

  if (existing) {
    // Phase 5 — a "banned" enrollment permanently blocks re-enrollment for
    // this entity↔project pair. "disqualified"/"cancelled" don't — the
    // entity can be re-enrolled, which reactivates the same row (keeping
    // its history intact) rather than inserting a duplicate.
    if (existing.status === "banned") {
      res.status(403).json({ error: "This entity is banned from this project" }); return;
    }
    if (existing.status === "active") {
      res.status(409).json({ error: "Entity already enrolled in this project" }); return;
    }
    const [reactivated] = await db.update(projectEnrollmentsTable)
      .set({
        status: "active",
        accountData: accountData && typeof accountData === "object" ? JSON.stringify(accountData) : existing.accountData,
        kycEntryId: kycEntryId ?? existing.kycEntryId,
        dataEntityId: dataEntityId ?? existing.dataEntityId,
      })
      .where(eq(projectEnrollmentsTable.id, existing.id))
      .returning();

    logSubjectActivity("project_enrollment", reactivated.id, "enrolled", {
      actorUserId: userId, meta: { projectId, vaultEntryId, reactivatedFrom: existing.status },
    });

    const reactivateCharge = await chargeCredits(userId, "workspace.project_use");
    res.status(201).json({
      ...reactivated,
      enrolledAt: reactivated.enrolledAt.toISOString(),
      accountData: reactivated.accountData ? JSON.parse(reactivated.accountData) : null,
      _credits: reactivateCharge.ok ? { charged: reactivateCharge.charged, newBalance: reactivateCharge.newBalance } : null,
    });
    return;
  }

  const [enrollment] = await db.insert(projectEnrollmentsTable).values({
    userId, projectId, vaultEntryId, status: "active",
    accountData: accountData && typeof accountData === "object" ? JSON.stringify(accountData) : null,
    kycEntryId: kycEntryId ?? null,
    dataEntityId: dataEntityId ?? null,
  }).returning();

  const alreadyJoined = await db.select().from(userProjectsTable).where(and(eq(userProjectsTable.userId, userId), eq(userProjectsTable.projectId, projectId)));
  if (alreadyJoined.length === 0) await db.insert(userProjectsTable).values({ userId, projectId });

  // Phase 4 — activity log: record the enrollment start so cumulative
  // days-active can be computed from the log later.
  logSubjectActivity("project_enrollment", enrollment.id, "enrolled", {
    actorUserId: userId, meta: { projectId, vaultEntryId },
  });

  const charge = await chargeCredits(userId, "workspace.project_use");
  res.status(201).json({
    ...enrollment,
    enrolledAt: enrollment.enrolledAt.toISOString(),
    accountData: enrollment.accountData ? JSON.parse(enrollment.accountData) : null,
    _credits: charge.ok ? { charged: charge.charged, newBalance: charge.newBalance } : null,
  });
});

// PATCH /projects/:id/enrollments/:enrollmentId/status — Phase 5: Disqualify /
// Ban / Cancel enrollment. Admin/moderator only. Unlike DELETE (voluntary
// unenroll, which removes the row), these are moderation actions that keep
// the enrollment row and its history — only `status` changes — and each
// writes a corresponding event to the shared Phase 4 activity_log so the
// entity's timeline shows exactly who changed it, when, and why.
const ENROLLMENT_MODERATION_ACTIONS: Record<string, string> = {
  disqualified: "disqualified", // stops future reward accrual, keeps history
  banned: "banned",             // disqualify + blocks re-enrollment (see /enroll above)
  cancelled: "cancelled",       // voluntary/admin removal, no stigma, can re-enroll
  active: "enrolled",           // admin restoring a previously moderated enrollment
};
router.patch("/projects/:id/enrollments/:enrollmentId/status", requireRoles("admin", "moderator"), async (req, res): Promise<void> => {
  const enrollmentId = parseInt(Array.isArray(req.params.enrollmentId) ? req.params.enrollmentId[0] : req.params.enrollmentId, 10);
  const { status, reason } = req.body as { status: string; reason?: string };
  const logAction = ENROLLMENT_MODERATION_ACTIONS[status];
  if (!logAction) { res.status(400).json({ error: "status must be one of: disqualified, banned, cancelled, active" }); return; }

  const [existing] = await db.select().from(projectEnrollmentsTable).where(eq(projectEnrollmentsTable.id, enrollmentId));
  if (!existing) { res.status(404).json({ error: "Enrollment not found" }); return; }

  const [updated] = await db.update(projectEnrollmentsTable)
    .set({ status })
    .where(eq(projectEnrollmentsTable.id, enrollmentId))
    .returning();

  logSubjectActivity("project_enrollment", enrollmentId, logAction, {
    actorUserId: req.user!.userId,
    meta: { projectId: existing.projectId, vaultEntryId: existing.vaultEntryId, reason: reason ?? null },
  });

  res.json({
    ...updated,
    enrolledAt: updated.enrolledAt.toISOString(),
    accountData: updated.accountData ? JSON.parse(updated.accountData) : null,
  });
});

// GET /admin/projects/:id/entity-enrollments — Phase 5: every entity
// enrollment for this project across ALL users (unlike GET
// /projects/:id/enrollments, which is scoped to req.user) — powers the
// admin moderation view (disqualify/ban/cancel).
router.get("/admin/projects/:id/entity-enrollments", requireRoles("admin", "moderator"), async (req, res): Promise<void> => {
  const projectId = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  try {
    const rows = await db
      .select({ enrollment: projectEnrollmentsTable, vault: vaultEntriesTable, ownerUsername: usersTable.username })
      .from(projectEnrollmentsTable)
      .leftJoin(vaultEntriesTable, eq(projectEnrollmentsTable.vaultEntryId, vaultEntriesTable.id))
      .leftJoin(usersTable, eq(projectEnrollmentsTable.userId, usersTable.id))
      .where(eq(projectEnrollmentsTable.projectId, projectId));
    res.json(rows.map(({ enrollment, vault, ownerUsername }) => ({
      ...enrollment,
      enrolledAt: enrollment.enrolledAt.toISOString(),
      accountData: enrollment.accountData ? JSON.parse(enrollment.accountData) : null,
      ownerUsername: ownerUsername ?? null,
      entity: vault ? {
        id: vault.id, entitySerial: vault.entitySerial, projectName: vault.projectName, category: vault.category,
      } : null,
    })));
  } catch (err: any) {
    res.status(500).json({ error: "DB error", detail: err?.message });
  }
});

router.get("/projects/:id/enrollments", requireAuth, async (req, res): Promise<void> => {
  const projectId = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const userId = req.user!.userId;
  const enrollments = await db
    .select({ enrollment: projectEnrollmentsTable, vault: vaultEntriesTable })
    .from(projectEnrollmentsTable)
    .leftJoin(vaultEntriesTable, eq(projectEnrollmentsTable.vaultEntryId, vaultEntriesTable.id))
    .where(and(eq(projectEnrollmentsTable.projectId, projectId), eq(projectEnrollmentsTable.userId, userId)));
  res.json(enrollments.map(({ enrollment, vault }) => ({
    ...enrollment,
    enrolledAt: enrollment.enrolledAt.toISOString(),
    // Enrollment-scoped account snapshot (Phase 3) — independent of the
    // entity's own vault_entries account fields.
    accountData: enrollment.accountData ? JSON.parse(enrollment.accountData) : null,
    entity: vault ? {
      id: vault.id, entitySerial: vault.entitySerial, projectName: vault.projectName,
      category: vault.category, twitterUsername: vault.twitterUsername, discordUsername: vault.discordUsername,
      walletAddresses: vault.walletAddresses ? JSON.parse(vault.walletAddresses) : [], email: vault.email,
    } : null,
  })));
});

// GET /projects/mine/enrolled — every project the user has an active
// enrollment in, one row per project with its enrolled-entity count. Powers
// the new top-level "Project" sidebar page (pages/user/project-entities.tsx),
// which is separate from the Protocols/Vault browsing sidebar.
router.get("/projects/mine/enrolled", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const rows = await db.execute(sql.raw(
    `SELECT p.id as project_id, p.name as project_name, p.thumbnail_url, p.category,
            COUNT(pe.id)::int as enrolled_count
     FROM project_enrollments pe
     JOIN projects p ON p.id = pe.project_id
     WHERE pe.user_id = ${userId}
     GROUP BY p.id, p.name, p.thumbnail_url, p.category
     ORDER BY p.name ASC`
  ));
  res.json((rows.rows as any[]).map(r => ({
    projectId: Number(r.project_id),
    projectName: r.project_name,
    thumbnailUrl: r.thumbnail_url,
    category: r.category,
    enrolledCount: Number(r.enrolled_count),
  })));
});

// GET /projects/mine/enrolled-entities — every entity the user has enrolled
// into at least one project, with each enrolled project's own lifecycle
// status (projects.status: active/paused/completed/archived) attached.
// Powers the Vault > Enrollment > Entity hierarchy (Overview/Ongoing/Past —
// pages/user/vault-enrollment-entity.tsx): "ongoing" = at least one project
// with status active/paused, "past" = at least one project with status
// completed/archived. An entity can appear under both if it has projects in
// each bucket — the frontend filters this same list per tab rather than
// three separate queries.
router.get("/projects/mine/enrolled-entities", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  try {
    const rows = await db.execute(sql.raw(
      `SELECT
         ve.id as vault_entry_id, ve.entity_serial, ve.project_name as entity_name, ve.category,
         p.id as project_id, p.name as project_name, p.status as project_status, p.thumbnail_url as project_thumbnail_url,
         pe.status as enrollment_status, pe.enrolled_at
       FROM project_enrollments pe
       JOIN vault_entries ve ON ve.id = pe.vault_entry_id
       JOIN projects p ON p.id = pe.project_id
       WHERE pe.user_id = ${userId}
       ORDER BY pe.enrolled_at DESC`
    ));

    const ONGOING = new Set(["active", "paused"]);
    const PAST = new Set(["completed", "archived"]);

    const byEntity = new Map<number, any>();
    for (const r of rows.rows as any[]) {
      const key = Number(r.vault_entry_id);
      if (!byEntity.has(key)) {
        byEntity.set(key, {
          vaultEntryId: key,
          entityName: r.entity_name as string | null,
          entitySerial: r.entity_serial as string | null,
          category: r.category as string | null,
          projects: [] as any[],
        });
      }
      byEntity.get(key).projects.push({
        projectId: Number(r.project_id),
        projectName: r.project_name as string,
        projectStatus: (r.project_status as string | null) ?? "active",
        thumbnailUrl: r.project_thumbnail_url as string | null,
        enrollmentStatus: r.enrollment_status as string,
        enrolledAt: r.enrolled_at,
      });
    }

    const entities = Array.from(byEntity.values()).map(e => ({
      ...e,
      hasOngoing: e.projects.some((p: any) => ONGOING.has(p.projectStatus)),
      hasPast: e.projects.some((p: any) => PAST.has(p.projectStatus)),
    }));

    res.json(entities);
  } catch (err: any) {
    res.status(500).json({ error: "DB error", detail: err?.message });
  }
});

// GET /projects/mine/overview — Phase 9A: aggregate stats across every
// project enrollment the user has (all projects, all entities), sourced
// from the Phase 4 activity_log — never stored/duplicated, same
// "compute from the log at read time" rule as
// /projects/enrollments/:enrollmentId/activity below. Powers the Enroll
// sidebar's Projects > Overview (components/layout/enroll-sidebar.tsx).
router.get("/projects/mine/overview", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  try {
    const overview = await getUserEnrollmentsOverview(userId);
    res.json(overview);
  } catch (err: any) {
    res.status(500).json({ error: "DB error", detail: err?.message });
  }
});

// GET /projects/mine/entities-overview — Phase 10A: same aggregate stats as
// /projects/mine/overview above, just grouped by entity (vault_entry_id)
// instead of project. Powers the Enroll sidebar's Entities > Overview
// (pages/user/enroll-entities.tsx), mirroring the Projects Overview pattern.
router.get("/projects/mine/entities-overview", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  try {
    const overview = await getUserEntitiesOverview(userId);
    res.json(overview);
  } catch (err: any) {
    res.status(500).json({ error: "DB error", detail: err?.message });
  }
});

// GET /projects/:id/enrollments/overview — Phase 9B: aggregate stats for
// the current user's enrollments within THIS one project (own dedicated
// dashboard page, pages/user/project-dashboard.tsx) — same "derive from the
// Phase 4 activity_log at read time" rule as /projects/mine/overview,
// just scoped to one project via getProjectEnrollmentsOverview instead of
// every project the user has.
router.get("/projects/:id/enrollments/overview", requireAuth, async (req, res): Promise<void> => {
  const projectId = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const userId = req.user!.userId;
  try {
    const overview = await getProjectEnrollmentsOverview(userId, projectId);
    res.json(overview);
  } catch (err: any) {
    res.status(500).json({ error: "DB error", detail: err?.message });
  }
});

router.delete("/projects/:id/enrollments/:enrollmentId", requireAuth, requireProjectEnrollmentOwnership("project_enrollment.delete", (_req, res) => {
  res.json({ message: "Enrollment removed" });
}), async (req, res): Promise<void> => {
  const enrollmentId = parseInt(Array.isArray(req.params.enrollmentId) ? req.params.enrollmentId[0] : req.params.enrollmentId, 10);
  const userId = req.user!.userId;

  // Phase 4 — activity log: record the "left" event (with a snapshot of
  // what's being removed) *before* the row is deleted, since the log must
  // outlive the enrollment it describes.
  const [existing] = await db.select().from(projectEnrollmentsTable)
    .where(and(eq(projectEnrollmentsTable.id, enrollmentId), eq(projectEnrollmentsTable.userId, userId)));
  if (existing) {
    logSubjectActivity("project_enrollment", enrollmentId, "left", {
      actorUserId: userId, meta: { projectId: existing.projectId, vaultEntryId: existing.vaultEntryId },
    });
  }

  await db.delete(projectEnrollmentsTable)
    .where(and(eq(projectEnrollmentsTable.id, enrollmentId), eq(projectEnrollmentsTable.userId, userId)));
  res.json({ message: "Enrollment removed" });
});

// GET /projects/enrollments/:enrollmentId/activity — Phase 4: the
// enrolled/left/reward log + computed totals (days active, total reward,
// reward/day) for a single entity↔project enrollment. Totals are always
// derived from the log at read time, never stored, so they can't drift.
router.get("/projects/enrollments/:enrollmentId/activity", requireAuth, requireProjectEnrollmentOwnership("project_enrollment.activity.read", (_req, res) => {
  res.status(404).json({ error: "Enrollment not found" });
}), async (req, res): Promise<void> => {
  const enrollmentId = parseInt(Array.isArray(req.params.enrollmentId) ? req.params.enrollmentId[0] : req.params.enrollmentId, 10);
  const userId = req.user!.userId;
  const [enrollment] = await db.select().from(projectEnrollmentsTable)
    .where(and(eq(projectEnrollmentsTable.id, enrollmentId), eq(projectEnrollmentsTable.userId, userId)));
  if (!enrollment) { res.status(404).json({ error: "Enrollment not found" }); return; }
  try {
    const summary = await getSubjectActivitySummary("project_enrollment", enrollmentId);
    res.json(summary);
  } catch (err: any) {
    res.status(500).json({ error: "DB error", detail: err?.message });
  }
});

// GET /projects/:id/members — list all users who joined this project (admin view)
// D3 — bug fix: this had NO auth middleware at all despite returning every
// member's email address (plus userId/task-completion stats) — anyone,
// logged in or not, could enumerate project ids and harvest every member's
// email. The route's own comment says "(admin view)" and all three real
// callers (operator-progress.tsx, project-detail.tsx — both under
// pages/admin/) already send a Bearer token, so gating this the same way
// its sibling admin route (GET /admin/projects/:id/entity-enrollments)
// already is changes nothing for any legitimate caller.
router.get("/projects/:id/members", requireRoles("admin", "moderator"), async (req, res): Promise<void> => {
  const projectId = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  try {
    const rows = await db.execute(sql.raw(
      `SELECT up.user_id, up.joined_at, u.username, u.email,
              (SELECT COUNT(*) FROM task_submissions ts
               JOIN tasks t ON t.id = ts.task_id
               WHERE ts.user_id = up.user_id AND t.project_id = ${projectId}
               AND ts.status IN ('approved','completed'))::int as tasks_completed,
              (SELECT COUNT(*) FROM tasks WHERE project_id = ${projectId})::int as total_tasks
       FROM user_projects up
       JOIN users u ON u.id = up.user_id
       WHERE up.project_id = ${projectId}
       ORDER BY up.joined_at DESC`
    ));
    res.json(rows.rows.map((r: any) => ({
      userId: r.user_id,
      username: r.username,
      email: r.email,
      joinedAt: r.joined_at,
      tasksCompleted: Number(r.tasks_completed ?? 0),
      totalTasks: Number(r.total_tasks ?? 0),
      progress: Number(r.total_tasks ?? 0) > 0
        ? Math.round((Number(r.tasks_completed ?? 0) / Number(r.total_tasks ?? 0)) * 100)
        : 0,
    })));
  } catch (err: any) {
    res.status(500).json({ error: "DB error", detail: err?.message });
  }
});

router.get("/projects/:id/stats", async (req, res): Promise<void> => {
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const [{ taskCount }] = await db.select({ taskCount: count() }).from(tasksTable).where(eq(tasksTable.projectId, id));
  const [{ memberCount }] = await db.select({ memberCount: count() }).from(userProjectsTable).where(eq(userProjectsTable.projectId, id));
  const [roiResult] = await db.select({ roi: sql<number>`COALESCE(SUM(total_roi_distributed), 0)` }).from(projectsTable).where(eq(projectsTable.id, id));
  res.json({ totalTasks: Number(taskCount), completedTasks: 0, activeUsers: Number(memberCount), totalRoiDistributed: Number(roiResult?.roi ?? 0) });
});

// ─── GET /api/projects/:id/entity-tasks — per-entity task completion ──────────
router.get("/projects/:id/entity-tasks", requireAuth, async (req, res): Promise<void> => {
  const projectId = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const userId = req.user!.userId;

  try {
    const tasks = await db.execute(sql.raw(
      `SELECT id, name, description, reward_amount, verification_type, task_type, cost, profit FROM tasks WHERE project_id = ${projectId} ORDER BY id ASC`
    ));
    const enrollments = await db.execute(sql.raw(
      `SELECT pe.*, ve.entity_serial, ve.project_name as entity_name, ve.category, ve.twitter_username, ve.discord_username, ve.email
       FROM project_enrollments pe
       LEFT JOIN vault_entries ve ON ve.id = pe.vault_entry_id
       WHERE pe.project_id = ${projectId} AND pe.user_id = ${userId}`
    ));

    const result = await Promise.all((enrollments.rows as any[]).map(async (enr) => {
      const taskStatuses = await Promise.all((tasks.rows as any[]).map(async (task) => {
        const sub = await db.execute(sql.raw(
          `SELECT status FROM task_submissions WHERE task_id = ${task.id} AND user_id = ${userId} ORDER BY submitted_at DESC LIMIT 1`
        ));
        return {
          taskId: task.id, taskName: task.name, taskType: task.task_type,
          rewardAmount: task.reward_amount, cost: task.cost ?? 0, profit: task.profit ?? 0,
          status: sub.rows[0] ? (sub.rows[0] as any).status : null,
        };
      }));
      const done = taskStatuses.filter(t => t.status === "approved" || t.status === "completed").length;
      return {
        enrollmentId: enr.id, vaultEntryId: enr.vault_entry_id,
        entitySerial: enr.entity_serial, entityName: enr.entity_name,
        category: enr.category, email: enr.email,
        twitterUsername: enr.twitter_username, discordUsername: enr.discord_username,
        status: enr.status,
        tasks: taskStatuses, completedTasks: done, totalTasks: tasks.rows.length,
      };
    }));

    res.json({ tasks: tasks.rows, entities: result });
  } catch (err: any) {
    res.status(500).json({ error: "DB error", detail: err?.message });
  }
});

// ─── GET /projects/:id/ratings — list ratings + average (public) ─────────────
router.get("/projects/:id/ratings", async (req, res): Promise<void> => {
  const projectId = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  try {
    const rows = await db
      .select({ r: projectRatingsTable, username: usersTable.username })
      .from(projectRatingsTable)
      .leftJoin(usersTable, eq(projectRatingsTable.userId, usersTable.id))
      .where(eq(projectRatingsTable.projectId, projectId))
      .orderBy(sql`${projectRatingsTable.updatedAt} DESC`);

    const ratings = rows.map(({ r, username }) => ({
      id: r.id, userId: r.userId, username: username ?? "Unknown",
      rating: r.rating, comment: r.comment,
      createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(),
    }));
    const count = ratings.length;
    const average = count > 0 ? ratings.reduce((s, r) => s + r.rating, 0) / count : 0;
    const distribution: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    for (const r of ratings) if (distribution[r.rating] !== undefined) distribution[r.rating]++;

    res.json({ ratings, count, average: Math.round(average * 100) / 100, distribution });
  } catch (err: any) {
    res.status(500).json({ error: "DB error", detail: err?.message });
  }
});

// ─── GET /projects/:id/ratings/me — current user's own rating for this project ─
router.get("/projects/:id/ratings/me", requireAuth, async (req, res): Promise<void> => {
  const projectId = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const userId = req.user!.userId;
  const [rating] = await db.select().from(projectRatingsTable)
    .where(and(eq(projectRatingsTable.projectId, projectId), eq(projectRatingsTable.userId, userId)));
  if (!rating) { res.json(null); return; }
  res.json({ ...rating, createdAt: rating.createdAt.toISOString(), updatedAt: rating.updatedAt.toISOString() });
});

// ─── POST /projects/:id/ratings — create or update (upsert) own rating ────────
router.post("/projects/:id/ratings", requireAuth, async (req, res): Promise<void> => {
  const projectId = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const userId = req.user!.userId;
  const { rating, comment } = req.body;
  const ratingNum = Number(rating);
  if (!Number.isInteger(ratingNum) || ratingNum < 1 || ratingNum > 5) {
    res.status(400).json({ error: "rating must be an integer from 1 to 5" });
    return;
  }

  const [project] = await db.select().from(projectsTable).where(eq(projectsTable.id, projectId));
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const existing = await db.select().from(projectRatingsTable)
    .where(and(eq(projectRatingsTable.projectId, projectId), eq(projectRatingsTable.userId, userId)));

  let row;
  if (existing.length > 0) {
    [row] = await db.update(projectRatingsTable)
      .set({ rating: ratingNum, comment: comment ?? null, updatedAt: new Date() })
      .where(and(eq(projectRatingsTable.projectId, projectId), eq(projectRatingsTable.userId, userId)))
      .returning();
  } else {
    [row] = await db.insert(projectRatingsTable)
      .values({ userId, projectId, rating: ratingNum, comment: comment ?? null })
      .returning();
  }
  broadcastEvent("projects_updated", { action: "rated", projectId });
  res.status(existing.length > 0 ? 200 : 201).json({ ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() });
});

// ─── DELETE /projects/:id/ratings/me — remove own rating ──────────────────────
router.delete("/projects/:id/ratings/me", requireAuth, async (req, res): Promise<void> => {
  const projectId = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const userId = req.user!.userId;
  await db.delete(projectRatingsTable)
    .where(and(eq(projectRatingsTable.projectId, projectId), eq(projectRatingsTable.userId, userId)));
  res.json({ message: "Rating removed" });
});

// ─── DELETE /admin/projects/:id/ratings/:ratingId — moderate any rating ───────
router.delete("/admin/projects/:id/ratings/:ratingId", requireAdmin, async (req, res): Promise<void> => {
  const ratingId = parseInt(Array.isArray(req.params.ratingId) ? req.params.ratingId[0] : req.params.ratingId, 10);
  await db.delete(projectRatingsTable).where(eq(projectRatingsTable.id, ratingId));
  res.json({ message: "Rating removed" });
});

// ─── GET /projects/:id/roi-summary — per-entity ROI ledger for this project ───
router.get("/projects/:id/roi-summary", requireAuth, async (req, res): Promise<void> => {
  const projectId = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const userId = req.user!.userId;
  try {
    const rows = await db
      .select({ roi: entityProjectRoiTable, vault: vaultEntriesTable })
      .from(entityProjectRoiTable)
      .leftJoin(vaultEntriesTable, eq(entityProjectRoiTable.vaultEntryId, vaultEntriesTable.id))
      .where(and(eq(entityProjectRoiTable.projectId, projectId), eq(entityProjectRoiTable.userId, userId)));

    const entries = rows.map(({ roi, vault }) => ({
      vaultEntryId: roi.vaultEntryId,
      entitySerial: vault?.entitySerial ?? null,
      entityName: vault?.projectName ?? null,
      totalProfit: roi.totalProfit,
      totalCost: roi.totalCost,
      roi: roi.roi ?? (roi.totalProfit - roi.totalCost),
      recordedAt: roi.recordedAt.toISOString(),
    }));
    const totalProfit = entries.reduce((s, e) => s + e.totalProfit, 0);
    const totalCost = entries.reduce((s, e) => s + e.totalCost, 0);

    res.json({ projectId, entries, summary: { totalProfit, totalCost, totalRoi: totalProfit - totalCost } });
  } catch (err: any) {
    res.status(500).json({ error: "DB error", detail: err?.message });
  }
});

// ─── Public receipt link — Project P&L ────────────────────────────────────────
// One shareable, unauthenticated "P&L card" per (user, project) pair — the
// same aggregate numbers as GET /projects/:id/roi-summary above, handed out
// as a link/PDF. Same possession-is-auth model as the Local Entity / Vault
// Entity / Finance ledger receipts. Idempotent mint (repeat calls return the
// same token until revoked); revoke deletes the row outright since, unlike
// the other two receipt types, there's no host row to null a column on.

function generateProjectReceiptToken(): string {
  return crypto.randomBytes(20).toString("base64url");
}
function projectReceiptUrl(receiptToken: string): string {
  return `${process.env.APP_URL ?? "https://ayzen.replit.app"}/receipt/project/${receiptToken}`;
}

async function computeProjectPnlSummary(userId: number, projectId: number) {
  // Same source/logic as GET /finance/investments (this file's frontend
  // counterpart, pages/user/finance/pnl.tsx), scoped to one project — kept
  // in lockstep with that route so the receipt always matches what the
  // user sees on their own Finance → P&L page.
  const rows = await db.select({
    kind: financeLedgerEntriesTable.kind,
    total: sql<number>`COALESCE(SUM(${financeLedgerEntriesTable.amount}), 0)`,
  }).from(financeLedgerEntriesTable)
    .where(and(
      eq(financeLedgerEntriesTable.userId, userId),
      eq(financeLedgerEntriesTable.projectId, projectId),
      sql`${financeLedgerEntriesTable.kind} IN ('investment', 'expense', 'income')`,
    ))
    .groupBy(financeLedgerEntriesTable.kind);

  let invested = 0, spent = 0, earned = 0;
  for (const r of rows) {
    if (r.kind === "investment") invested += r.total;
    if (r.kind === "expense") spent += r.total;
    if (r.kind === "income") earned += r.total;
  }
  const netPnl = earned - spent;
  const netPosition = invested - spent + earned;
  const roiPct = spent > 0 ? (netPnl / spent) * 100 : (earned > 0 ? 100 : null);
  return { invested, spent, earned, netPnl, netPosition, roiPct };
}

// POST /projects/:id/pnl-receipt — mint (or fetch the existing) public link
router.post("/projects/:id/pnl-receipt", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const projectId = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  if (!Number.isFinite(projectId)) { res.status(400).json({ error: "Invalid project id" }); return; }
  try {
    const [project] = await db.select({ id: projectsTable.id }).from(projectsTable).where(eq(projectsTable.id, projectId));
    if (!project) { res.status(404).json({ error: "Project not found" }); return; }

    const [existing] = await db.select().from(projectPnlReceiptsTable)
      .where(and(eq(projectPnlReceiptsTable.userId, userId), eq(projectPnlReceiptsTable.projectId, projectId)));

    let token = existing?.receiptToken ?? null;
    if (!token) {
      for (let attempt = 0; attempt < 3 && !token; attempt++) {
        const candidate = generateProjectReceiptToken();
        try {
          const [row] = await db.insert(projectPnlReceiptsTable)
            .values({ userId, projectId, receiptToken: candidate })
            .returning({ receiptToken: projectPnlReceiptsTable.receiptToken });
          token = row.receiptToken;
        } catch { /* unique collision — loop and retry */ }
      }
      if (!token) { res.status(500).json({ error: "Could not generate a receipt link, please try again" }); return; }
    }
    res.json({ token, url: projectReceiptUrl(token) });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to create receipt link", detail: err?.message });
  }
});

// DELETE /projects/:id/pnl-receipt — revoke the public link
router.delete("/projects/:id/pnl-receipt", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const projectId = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  if (!Number.isFinite(projectId)) { res.status(400).json({ error: "Invalid project id" }); return; }
  const deleted = await db.delete(projectPnlReceiptsTable)
    .where(and(eq(projectPnlReceiptsTable.userId, userId), eq(projectPnlReceiptsTable.projectId, projectId)))
    .returning({ id: projectPnlReceiptsTable.id });
  if (!deleted.length) { res.status(404).json({ error: "No active receipt link for this project" }); return; }
  res.json({ success: true });
});

async function findProjectReceiptByToken(token: string) {
  const [receipt] = await db.select().from(projectPnlReceiptsTable).where(eq(projectPnlReceiptsTable.receiptToken, token)).limit(1);
  if (!receipt) return null;
  const [project] = await db.select().from(projectsTable).where(eq(projectsTable.id, receipt.projectId));
  if (!project) return null;
  const [owner] = await db.select({ username: usersTable.username }).from(usersTable).where(eq(usersTable.id, receipt.userId)).limit(1);
  const summary = await computeProjectPnlSummary(receipt.userId, receipt.projectId);
  return { receipt, project, issuedBy: owner?.username ?? null, summary };
}

function fmtPublicProjectReceipt(found: NonNullable<Awaited<ReturnType<typeof findProjectReceiptByToken>>>) {
  const { receipt, project, issuedBy, summary } = found;
  return {
    id: receipt.id,
    projectId: project.id,
    projectName: project.name,
    projectTier: project.tier,
    thumbnailUrl: project.thumbnailUrl,
    invested: summary.invested,
    spent: summary.spent,
    earned: summary.earned,
    netPnl: summary.netPnl,
    netPosition: summary.netPosition,
    roiPct: summary.roiPct,
    issuedBy,
    generatedAt: new Date().toISOString(),
  };
}

// GET /projects/pnl-receipt/:token — public, no auth
router.get("/projects/pnl-receipt/:token", requirePublicAudit("project_pnl_receipt.view", { onDecision: pepDecisionObserver }), async (req, res): Promise<void> => {
  const token = Array.isArray(req.params.token) ? req.params.token[0] : req.params.token;
  if (!token) { res.status(400).json({ error: "Missing token" }); return; }
  const found = await findProjectReceiptByToken(token);
  if (!found) { res.status(404).json({ error: "This receipt link is invalid or has been revoked." }); return; }
  res.json(fmtPublicProjectReceipt(found));
});

// GET /projects/pnl-receipt/:token/pdf — public, no auth
router.get("/projects/pnl-receipt/:token/pdf", requirePublicAudit("project_pnl_receipt.pdf", { onDecision: pepDecisionObserver }), async (req, res): Promise<void> => {
  const token = Array.isArray(req.params.token) ? req.params.token[0] : req.params.token;
  if (!token) { res.status(400).json({ error: "Missing token" }); return; }
  const found = await findProjectReceiptByToken(token);
  if (!found) { res.status(404).json({ error: "This receipt link is invalid or has been revoked." }); return; }
  const r = fmtPublicProjectReceipt(found);

  streamFantasticReceiptPdf(res, {
    kicker: "Project P&L Receipt",
    title: r.projectName,
    subtitle: r.projectTier != null ? `Tier ${r.projectTier}` : undefined,
    avatarLetter: r.projectName,
    heroLabel: r.roiPct !== null ? "Return on Investment" : "Net P&L",
    heroValue: r.roiPct !== null ? `${r.roiPct >= 0 ? "+" : ""}${r.roiPct.toFixed(1)}%` : `${r.netPnl >= 0 ? "+" : ""}$${r.netPnl.toFixed(2)}`,
    heroPositive: r.roiPct !== null ? r.roiPct >= 0 : (r.netPnl >= 0),
    stats: [
      { label: "Invested", value: `$${r.invested.toFixed(2)}` },
      { label: "Earned", value: `$${r.earned.toFixed(2)}`, color: "#0f9d58" },
      { label: "Spent", value: `$${r.spent.toFixed(2)}`, color: "#e4453a" },
      { label: "Net PnL", value: `${r.netPnl >= 0 ? "+" : ""}$${r.netPnl.toFixed(2)}`, color: r.netPnl >= 0 ? "#0f9d58" : "#e4453a" },
      { label: "Net Position", value: `$${r.netPosition.toFixed(2)}` },
    ],
    receiptId: r.id,
    issuedBy: r.issuedBy,
    filenamePrefix: "project-pnl",
  });
});

export default router;
