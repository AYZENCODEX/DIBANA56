import { Router } from "express";
import crypto from "crypto";
import { db, tasksTable, taskSubmissionsTable, projectsTable, usersTable, creditsTable, financeLedgerEntriesTable } from "@workspace/db";
import { eq, and, sql, SQL } from "drizzle-orm";
import { broadcastEvent, broadcastToUser } from "./events";
import { notifyTaskVerified } from "../lib/telegram";
import { createNotification } from "./notifications";
import { logActivity } from "../lib/activity";
import { logSubjectActivity } from "../lib/activity-log";
import { requireAdmin, requireAuth, requireRoles, pepDecisionObserver } from "../middlewares/auth";
import { requireCreditBalance, chargeCredits } from "../services/credit-meter";
import { syncOnTaskDelete } from "../services/sync";
import { streamFantasticReceiptPdf } from "../lib/receipt-theme";
import { PolicyEngine } from "../lib/policy/policy-engine";
import { createResourceOwnershipRule, createRoleOverrideRule } from "../lib/policy/resource";
import { authorize, requirePublicAudit } from "../lib/policy/pep";

const router = Router();

// ── Route Integration Roadmap — Season C, Phase C1 (mechanical sweep) ──────
// The three `/tasks/submissions/:id/receipt*` routes below each hand-rolled
// the exact same "submission owner, OR an admin, may act" check. Same
// shared-engine shape `routes/support.ts`'s own Phase C1 note uses (see
// that file for the full rationale on why `createRoleOverrideRule()`,
// not `requireRole()`'s own rule, is what composes correctly with
// `createResourceOwnershipRule()` here) — a separate engine instance
// because this is a different resource type ("task.submission" vs
// "support.ticket"), not because the rule mix differs.
const submissionOwnerOrAdminEngine = new PolicyEngine({ onDecision: pepDecisionObserver });
submissionOwnerOrAdminEngine.registerRule("resource-ownership", createResourceOwnershipRule());
submissionOwnerOrAdminEngine.registerRule("role-override", createRoleOverrideRule(["admin"]));

function taskIdStr(id: number): string { return `#TSK-${String(id).padStart(4, "0")}`; }

// ─── Task submission receipt link ──────────────────────────────────────────
// One shareable, unauthenticated receipt per task submission — task name,
// project name, task number, cost, and profit. Same possession-is-auth
// model as the Local Entity / Vault Entity / Project P&L / Finance ledger
// receipts (lib/receipt-theme.ts). Minted automatically on submit so a
// receipt always exists once a task is submitted; can also be minted
// on-demand for older submissions via POST /tasks/submissions/:id/receipt.
function generateTaskReceiptToken(): string {
  return crypto.randomBytes(20).toString("base64url");
}
function taskReceiptUrl(receiptToken: string): string {
  return `${process.env.APP_URL ?? "https://ayzen.replit.app"}/receipt/task/${receiptToken}`;
}

async function mintTaskReceiptToken(submissionId: number): Promise<string | null> {
  const [row] = await db.select({ id: taskSubmissionsTable.id, receiptToken: taskSubmissionsTable.receiptToken })
    .from(taskSubmissionsTable).where(eq(taskSubmissionsTable.id, submissionId));
  if (!row) return null;
  if (row.receiptToken) return row.receiptToken;

  let token: string | null = null;
  for (let attempt = 0; attempt < 3 && !token; attempt++) {
    const candidate = generateTaskReceiptToken();
    try {
      const [updated] = await db.update(taskSubmissionsTable)
        .set({ receiptToken: candidate })
        .where(eq(taskSubmissionsTable.id, submissionId))
        .returning({ receiptToken: taskSubmissionsTable.receiptToken });
      token = updated.receiptToken;
    } catch { /* unique collision — loop and retry */ }
  }
  return token;
}

async function findTaskReceiptByToken(token: string) {
  const [sub] = await db.select().from(taskSubmissionsTable).where(eq(taskSubmissionsTable.receiptToken, token)).limit(1);
  if (!sub) return null;
  const [task] = await db.select().from(tasksTable).where(eq(tasksTable.id, sub.taskId));
  const [user] = await db.select({ username: usersTable.username }).from(usersTable).where(eq(usersTable.id, sub.userId));
  let projectName: string | null = null;
  if (task?.projectId) {
    const [project] = await db.select({ name: projectsTable.name }).from(projectsTable).where(eq(projectsTable.id, task.projectId));
    projectName = project?.name ?? null;
  }
  return { sub, task, issuedBy: user?.username ?? null, projectName };
}

function fmtPublicTaskReceipt(found: NonNullable<Awaited<ReturnType<typeof findTaskReceiptByToken>>>) {
  const { sub, task, issuedBy, projectName } = found;
  const cost = sub.cost ?? 0;
  const profit = sub.profit ?? 0;
  return {
    id: sub.id,
    taskId: task ? taskIdStr(task.id) : null,
    taskName: task?.name ?? "Deleted Task",
    projectName,
    status: sub.status,
    cost,
    profit,
    netProfit: profit - cost,
    issuedBy,
    submittedAt: sub.submittedAt.toISOString(),
    generatedAt: new Date().toISOString(),
  };
}

function formatTask(t: any, projectName?: string | null, userStatus?: string | null) {
  let steps: any[] = [];
  try { steps = JSON.parse(t.steps || t.steps_json || "[]"); } catch { steps = []; }
  return {
    ...t,
    taskId: taskIdStr(t.id),
    createdAt: t.createdAt instanceof Date ? t.createdAt.toISOString() : t.createdAt,
    deadline: t.deadline instanceof Date ? t.deadline.toISOString() : (t.deadline ?? null),
    projectName: projectName ?? null,
    userStatus: userStatus ?? null,
    cost: t.cost ?? 0,
    profit: t.profit ?? 0,
    category: t.category ?? "Social",
    taskCategory: t.taskCategory ?? t.task_category ?? t.category ?? "B1",
    timeLimitMinutes: t.timeLimitMinutes ?? t.time_limit_minutes ?? null,
    xpAmount: t.xpAmount ?? t.xp_amount ?? 0,
    taskLink: t.taskLink ?? t.task_link ?? null,
    steps,
    priority: t.priority ?? "normal",
    difficultyLevel: t.difficultyLevel ?? t.difficulty_level ?? "medium",
    estimatedCost: t.estimatedCost ?? t.estimated_cost ?? 0,
    estimatedProfit: t.estimatedProfit ?? t.estimated_profit ?? 0,
  };
}

// ── GET /tasks — list all tasks ─────────────────────────────────────────────
router.get("/tasks", async (req, res): Promise<void> => {
  const { projectId, userId } = req.query as Record<string, string>;
  try {
    const whereSql = projectId ? sql`WHERE t.project_id = ${parseInt(projectId, 10)}` : sql``;
    const rawTasks = await db.execute(sql`
      SELECT t.*, p.name as project_name, p.xp_name as project_xp_name, p.xp_price as project_xp_price
       FROM tasks t
       LEFT JOIN projects p ON p.id = t.project_id
       ${whereSql}
       ORDER BY t.created_at DESC
    `);
    const tasks = rawTasks.rows as any[];
    const enriched = await Promise.all(tasks.map(async (t) => {
      let userStatus: string | null = null;
      if (userId) {
        const [sub] = await db.select().from(taskSubmissionsTable)
          .where(and(eq(taskSubmissionsTable.taskId, t.id), eq(taskSubmissionsTable.userId, parseInt(userId, 10))));
        userStatus = sub?.status ?? null;
        if (userStatus && (t.task_type === "Daily" || t.task_type === "daily")) {
          const lastSub = await db.execute(sql`
            SELECT submitted_at FROM task_submissions WHERE task_id = ${t.id} AND user_id = ${parseInt(userId!, 10)} ORDER BY submitted_at DESC LIMIT 1
          `);
          const submittedAt = (lastSub.rows[0] as any)?.submitted_at;
          if (submittedAt) {
            const today = new Date(); today.setHours(0,0,0,0);
            const subDate = new Date(submittedAt); subDate.setHours(0,0,0,0);
            if (subDate < today) userStatus = null;
          }
        }
      }
      return formatTask({
        ...t, projectId: t.project_id, completionCount: t.completion_count,
        rewardAmount: t.reward_amount, verificationType: t.verification_type,
        taskType: t.task_type, createdAt: t.created_at, category: t.category,
        xpAmount: t.xp_amount ?? 0, steps: t.steps,
      }, t.project_name, userStatus);
    }));
    res.json(enriched);
  } catch (err: any) {
    res.status(500).json({ error: "DB error", detail: err?.message });
  }
});

// ── POST /tasks — create task ───────────────────────────────────────────────
router.post("/tasks", requireRoles("admin", "moderator"), async (req, res): Promise<void> => {
  const { projectId, name, description, rewardAmount, verificationType, taskType, cost, profit, category, taskCategory, deadline, timeLimitMinutes, xpAmount, steps, priority, difficultyLevel, estimatedCost, estimatedProfit } = req.body;
  if (!name) { res.status(400).json({ error: "name is required" }); return; }
  const stepsJson = steps && Array.isArray(steps) ? JSON.stringify(steps) : "[]";
  try {
    const { taskLink } = req.body;
    const result = await db.execute(sql`
      INSERT INTO tasks (project_id, name, description, reward_amount, xp_amount, verification_type, task_type, cost, profit, category, task_category, deadline, time_limit_minutes, steps, task_link, priority, difficulty_level, estimated_cost, estimated_profit)
       VALUES (${projectId ? Number(projectId) : null}, ${name},
         ${description ?? null},
         ${rewardAmount != null ? Number(rewardAmount) : null},
         ${Number(xpAmount ?? 0)},
         ${verificationType ?? "manual"},
         ${taskType ?? "One-time"},
         ${Number(cost ?? 0)}, ${Number(profit ?? 0)},
         ${category ?? "Social"},
         ${taskCategory ?? "B1"},
         ${deadline ?? null},
         ${timeLimitMinutes ? Number(timeLimitMinutes) : null},
         ${stepsJson},
         ${taskLink ?? null},
         ${priority ?? "normal"},
         ${difficultyLevel ?? "medium"},
         ${Number(estimatedCost ?? 0)},
         ${Number(estimatedProfit ?? 0)})
       RETURNING *
    `);
    const task = result.rows[0] as any;
    broadcastEvent("tasks_updated", { action: "created", taskId: task.id });

    // Telegram alert — everyone actively enrolled in this task's project gets
    // pinged that a new task dropped. Best-effort, never blocks task creation.
    if (task.project_id) {
      import("../lib/telegram").then(({ notifyEnrolledUsersNewTask }) =>
        notifyEnrolledUsersNewTask(task.project_id, { id: task.id, name: task.name, rewardAmount: task.reward_amount })
      ).catch(() => {});
    }

    res.status(201).json(formatTask({
      ...task, projectId: task.project_id, completionCount: task.completion_count,
      rewardAmount: task.reward_amount, verificationType: task.verification_type,
      taskType: task.task_type, createdAt: task.created_at, category: task.category,
      taskCategory: task.task_category ?? task.category, xpAmount: task.xp_amount ?? 0,
      steps: task.steps,
    }));
  } catch (err: any) {
    res.status(500).json({ error: "DB error", detail: err?.message });
  }
});

// ── GET /tasks/submissions — MUST be before GET /tasks/:id ─────────────────
router.get("/tasks/submissions", async (req, res): Promise<void> => {
  const { status, projectId } = req.query as Record<string, string>;
  const subs = await db.select({
    sub: taskSubmissionsTable, task: tasksTable, user: usersTable
  }).from(taskSubmissionsTable)
    .leftJoin(tasksTable, eq(taskSubmissionsTable.taskId, tasksTable.id))
    .leftJoin(usersTable, eq(taskSubmissionsTable.userId, usersTable.id));

  const filtered = subs.filter(s => {
    if (status && s.sub.status !== status) return false;
    if (projectId && s.task?.projectId !== parseInt(projectId, 10)) return false;
    return true;
  });

  res.json(filtered.map(s => {
    let costEntries: any[] = [];
    try { costEntries = JSON.parse((s.sub as any).costEntries ?? (s.sub as any).cost_entries ?? "[]"); } catch {}
    return {
      id: s.sub.id, taskId: s.sub.taskId, taskName: s.task?.name ?? null,
      userId: s.sub.userId, username: s.user?.username ?? null,
      status: s.sub.status, proofUrl: s.sub.proofUrl, notes: s.sub.notes,
      cost: s.sub.cost ?? 0, profit: s.sub.profit ?? 0,
      costEntries,
      submittedAt: s.sub.submittedAt.toISOString(), reviewedAt: s.sub.reviewedAt?.toISOString() ?? null,
    };
  }));
});

// ── POST /tasks/:id/visit — record link visit ────────────────────────────────
router.post("/tasks/:id/visit", requireAuth, async (req, res): Promise<void> => {
  const taskId = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const userId = req.user!.userId;
  try {
    await db.execute(sql`
      INSERT INTO task_link_visits (task_id, user_id) VALUES (${taskId}, ${userId})
       ON CONFLICT (task_id, user_id) DO UPDATE SET visited_at = NOW()
    `);
    res.json({ ok: true, visitedAt: new Date().toISOString() });
  } catch (err: any) {
    res.status(500).json({ error: "DB error", detail: err?.message });
  }
});

// ── GET /tasks/:id/visit — check if user visited ─────────────────────────────
router.get("/tasks/:id/visit", requireAuth, async (req, res): Promise<void> => {
  const taskId = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const userId = req.user!.userId;
  try {
    const result = await db.execute(sql`
      SELECT visited_at FROM task_link_visits WHERE task_id = ${taskId} AND user_id = ${userId} LIMIT 1
    `);
    const row = result.rows[0] as any;
    res.json({ visited: !!row, visitedAt: row?.visited_at ?? null });
  } catch {
    res.json({ visited: false, visitedAt: null });
  }
});

// ── GET /tasks/:id ──────────────────────────────────────────────────────────
router.get("/tasks/:id", async (req, res): Promise<void> => {
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const [task] = await db.select().from(tasksTable).where(eq(tasksTable.id, id));
  if (!task) { res.status(404).json({ error: "Task not found" }); return; }
  let projName: string | null = null;
  if (task.projectId) {
    const [proj] = await db.select({ name: projectsTable.name }).from(projectsTable).where(eq(projectsTable.id, task.projectId));
    projName = proj?.name ?? null;
  }
  res.json(formatTask(task, projName));
});

// ── PATCH /tasks/:id ────────────────────────────────────────────────────────
router.patch("/tasks/:id", requireAdmin, async (req, res): Promise<void> => {
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const allowedFields = ["name", "description", "rewardAmount", "verificationType", "taskType", "cost", "profit", "category", "xpAmount"];
  const updates: Record<string, unknown> = {};
  for (const f of allowedFields) {
    if (req.body[f] !== undefined) updates[f] = req.body[f];
  }
  const setFragments: SQL[] = [];
  if (req.body.taskCategory !== undefined) setFragments.push(sql`task_category = ${String(req.body.taskCategory)}`);
  if (req.body.deadline !== undefined) setFragments.push(sql`deadline = ${req.body.deadline ? req.body.deadline : null}`);
  if (req.body.timeLimitMinutes !== undefined) setFragments.push(sql`time_limit_minutes = ${req.body.timeLimitMinutes ? Number(req.body.timeLimitMinutes) : null}`);
  if (req.body.projectId !== undefined) setFragments.push(sql`project_id = ${req.body.projectId ? Number(req.body.projectId) : null}`);
  if (req.body.steps !== undefined) setFragments.push(sql`steps = ${JSON.stringify(req.body.steps)}`);
  if (req.body.taskLink !== undefined) setFragments.push(sql`task_link = ${req.body.taskLink ? String(req.body.taskLink) : null}`);
  if (req.body.priority !== undefined) setFragments.push(sql`priority = ${String(req.body.priority)}`);
  if (req.body.difficultyLevel !== undefined) setFragments.push(sql`difficulty_level = ${String(req.body.difficultyLevel)}`);
  if (req.body.estimatedCost !== undefined) setFragments.push(sql`estimated_cost = ${Number(req.body.estimatedCost) || 0}`);
  if (req.body.estimatedProfit !== undefined) setFragments.push(sql`estimated_profit = ${Number(req.body.estimatedProfit) || 0}`);

  try {
    let task: any;
    if (Object.keys(updates).length > 0) {
      const [t] = await db.update(tasksTable).set(updates).where(eq(tasksTable.id, id)).returning();
      task = t;
    }
    if (setFragments.length > 0) {
      const result = await db.execute(sql`UPDATE tasks SET ${sql.join(setFragments, sql`, `)} WHERE id = ${id} RETURNING *`);
      task = result.rows[0] ?? task;
    }
    if (!task) { res.status(404).json({ error: "Task not found" }); return; }
    broadcastEvent("tasks_updated", { action: "updated", taskId: id });
    const t = task as any;
    res.json(formatTask({
      ...t, projectId: t.project_id ?? t.projectId, completionCount: t.completion_count ?? t.completionCount,
      rewardAmount: t.reward_amount ?? t.rewardAmount, verificationType: t.verification_type ?? t.verificationType,
      taskType: t.task_type ?? t.taskType, createdAt: t.created_at ?? t.createdAt,
      category: t.category, taskCategory: t.task_category ?? t.taskCategory ?? t.category,
      xpAmount: t.xp_amount ?? t.xpAmount ?? 0, steps: t.steps,
    }));
  } catch (err: any) {
    res.status(500).json({ error: "DB error", detail: err?.message });
  }
});

// ── DELETE /tasks/:id ───────────────────────────────────────────────────────
router.delete("/tasks/:id", requireAdmin, async (req, res): Promise<void> => {
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  await db.delete(tasksTable).where(eq(tasksTable.id, id));
  broadcastEvent("tasks_updated", { action: "deleted", taskId: id });
  syncOnTaskDelete(id).catch(() => {});
  res.json({ message: "Task deleted" });
});

// ── GET /tasks/:id/steps — get task step guide ──────────────────────────────
router.get("/tasks/:id/steps", async (req, res): Promise<void> => {
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  try {
    const result = await db.execute(sql`SELECT steps FROM tasks WHERE id = ${id}`);
    const row = result.rows[0] as any;
    let steps: any[] = [];
    try { steps = JSON.parse(row?.steps ?? "[]"); } catch {}
    res.json(steps);
  } catch { res.json([]); }
});

// ── PUT /tasks/:id/steps — save all steps ──────────────────────────────────
router.put("/tasks/:id/steps", requireAdmin, async (req, res): Promise<void> => {
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const { steps } = req.body as { steps?: any[] };
  const stepsJson = JSON.stringify(Array.isArray(steps) ? steps : []);
  try {
    await db.execute(sql`UPDATE tasks SET steps = ${stepsJson} WHERE id = ${id}`);
    broadcastEvent("tasks_updated", { action: "steps_updated", taskId: id });
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: "DB error", detail: err?.message });
  }
});

// ── POST /tasks/:id/submit — submit task ────────────────────────────────────
// PHASE 5 (admin credit console request): submitting a task is a metered
// action (workspace.task_submit) — charge-on-success, after the submission
// row is actually inserted (a missing-task 404 above never touches the
// ledger).
router.post("/tasks/:id/submit", requireAuth, requireCreditBalance("workspace.task_submit"), async (req, res): Promise<void> => {
  const taskId = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const { proofUrl, notes, cost, profit, entityIds, costEntries } = req.body;
  const userId = req.user!.userId;

  try {
    const result = await db.execute(sql`SELECT * FROM tasks WHERE id = ${taskId}`);
    const task = result.rows[0] as any;
    if (!task) { res.status(404).json({ error: "Task not found" }); return; }

    const status = task.verification_type === "auto" ? "approved" : "pending";

    const entityIdsJson = entityIds && Array.isArray(entityIds) && entityIds.length
      ? JSON.stringify(entityIds) : null;

    const costEntriesJson = costEntries && Array.isArray(costEntries) && costEntries.length
      ? JSON.stringify(costEntries) : null;

    const totalCost = costEntries && Array.isArray(costEntries)
      ? costEntries.filter((e: any) => e.type === "cost").reduce((s: number, e: any) => s + Number(e.amount || 0), 0)
      : Number(cost ?? 0);
    const totalProfit = costEntries && Array.isArray(costEntries)
      ? costEntries.filter((e: any) => e.type === "profit").reduce((s: number, e: any) => s + Number(e.amount || 0), 0)
      : Number(profit ?? 0);

    const subResult = await db.execute(sql`
      INSERT INTO task_submissions (task_id, user_id, status, proof_url, notes, cost, profit, entity_ids, cost_entries, project_id)
       VALUES (${taskId}, ${userId}, ${status},
         ${proofUrl ?? null},
         ${notes ?? null},
         ${totalCost}, ${totalProfit}, ${entityIdsJson}, ${costEntriesJson}, ${task.project_id ?? null})
       RETURNING *
    `);
    const sub = subResult.rows[0] as any;

    if (status === "approved") {
      await db.execute(sql`UPDATE tasks SET completion_count = completion_count + 1 WHERE id = ${taskId}`);
      await awardXpAsAzn(userId, task);
      await createNotification(userId, "task_approved", "Task Auto-Approved ✓",
        `"${task.name}" was auto-verified. XP awarded to your balance.`,
        { taskId, xpAmount: task.xp_amount ?? 0 });
      logActivity(userId, "task_auto_approved", "task", taskId, task.name, { xpAmount: task.xp_amount ?? 0 });
      logProjectReward(task.project_id, taskId, userId, totalProfit, Array.isArray(entityIds) ? entityIds : null);
      postTaskFinanceEntries(userId, task.project_id, task.name, totalCost, totalProfit,
        Array.isArray(costEntries) && costEntries.some((e: any) => e.type === "profit"));
    } else {
      await createNotification(userId, "task_submitted", "Task Submitted",
        `"${task.name}" submitted for review. Pending admin verification.`, { taskId });
      logActivity(userId, "task_submitted", "task", taskId, task.name, { entities: entityIds });
    }

    broadcastEvent("tasks_updated", { action: "submitted", taskId, userId, status });

    const [user] = await db.select({ email: usersTable.email, username: usersTable.username })
      .from(usersTable).where(eq(usersTable.id, userId));
    if (user && status === "pending") {
      const { sendTaskSubmittedEmail } = await import("../lib/email");
      sendTaskSubmittedEmail(user.email, user.username, task.name).catch(() => {});
    }

    // Auto-mint a receipt token so a shareable receipt exists as soon as the
    // task is submitted — matches the "task submit dile receipt banao" flow.
    // Best-effort: never blocks the submit response.
    let receiptUrl: string | null = null;
    try {
      const token = await mintTaskReceiptToken(sub.id);
      if (token) receiptUrl = taskReceiptUrl(token);
    } catch { /* non-fatal */ }

    const charge = await chargeCredits(userId, "workspace.task_submit");
    res.json({
      id: sub.id, taskId: sub.task_id, taskName: task.name, userId: sub.user_id,
      status: sub.status, proofUrl: sub.proof_url, notes: sub.notes,
      cost: totalCost, profit: totalProfit, costEntries: costEntries ?? [],
      submittedAt: sub.submitted_at, reviewedAt: sub.reviewed_at ?? null,
      receiptUrl,
      _credits: charge.ok ? { charged: charge.charged, newBalance: charge.newBalance } : null,
    });
  } catch (err: any) {
    res.status(500).json({ error: "DB error", detail: err?.message });
  }
});

// ── Helper: award XP as AZN on task approval ────────────────────────────────
async function awardXpAsAzn(userId: number, task: any) {
  const xpAmt = Number(task.xp_amount ?? task.xpAmount ?? 0);
  if (!xpAmt || xpAmt <= 0) return;
  try {
    let xpPrice = 0.01;
    if (task.project_id || task.projectId) {
      const projId = task.project_id ?? task.projectId;
      const proj = await db.execute(sql`SELECT xp_price FROM projects WHERE id = ${projId}`);
      xpPrice = Number((proj.rows[0] as any)?.xp_price ?? 0.01);
    }
    const aznEarned = +(xpAmt * xpPrice).toFixed(6);
    if (aznEarned <= 0) return;
    await db.execute(sql`
      INSERT INTO credits (user_id, balance, azn_balance, total_purchased, total_spent, created_at, updated_at)
       VALUES (${userId}, 0, ${aznEarned}, 0, 0, NOW(), NOW())
       ON CONFLICT (user_id) DO UPDATE SET azn_balance = credits.azn_balance + ${aznEarned}, updated_at = NOW()
    `);
  } catch {}
}

// ── Task cost/profit → Finance ledger ───────────────────────────────────────
// On approval, whatever cost the submission carries gets posted as a Finance
// Expense entry, and whatever profit it carries gets posted as a Finance
// Income entry — both linked to the task's project (projectId) so they show
// up in Finance > Expenses / the project's Investment ledger and roll into
// the project P&L aggregate (routes/projects.ts GET /:id/pnl-summary).
// Best-effort: never blocks task submit/approval on a finance-write issue.
async function postTaskFinanceEntries(
  userId: number,
  projectId: number | null | undefined,
  taskName: string,
  cost: number | null | undefined,
  profit: number | null | undefined,
  hasProfitIntent: boolean,
): Promise<void> {
  try {
    const rows: (typeof financeLedgerEntriesTable.$inferInsert)[] = [];
    if (cost && cost > 0) {
      // "Cost" when the submission carried a profit entry too (spend expecting
      // a return, even if that return hasn't been realized yet) — "Loss" when
      // it was cost-only with no profit intended at all.
      rows.push({
        userId, kind: "expense", title: taskName, amount: cost, currency: "BDT",
        projectId: projectId ?? null, category: hasProfitIntent ? "Cost" : "Loss",
        status: "paid", occurredDate: new Date(),
      });
    }
    if (profit && profit > 0) {
      rows.push({
        userId, kind: "income", title: taskName, amount: profit, currency: "BDT",
        projectId: projectId ?? null, category: "Task Profit",
        status: "paid", occurredDate: new Date(),
      });
    }
    if (rows.length) await db.insert(financeLedgerEntriesTable).values(rows);
  } catch {
    // Non-fatal — task approval must not fail because of a finance-write issue.
  }
}

// ── Phase 4 (Vault/Project/Team Overhaul roadmap): log a "reward" activity
// event, per enrolled entity, on task approval. Attributed to each entity's
// own project_enrollments row so per-entity totals (computed from the log)
// never drift out of sync. ──────────────────────────────────────────────────
async function logProjectReward(
  projectId: number | null | undefined,
  taskId: number,
  userId: number,
  amount: number | null | undefined,
  entityIds: number[] | null | undefined,
) {
  if (!projectId || !amount || !entityIds || !entityIds.length) return;
  const ids = entityIds.map(Number).filter((n) => Number.isFinite(n));
  if (!ids.length) return;
  try {
    const idList = sql.join(ids.map((n) => sql`${n}`), sql`, `);
    const rows = await db.execute(sql`
      SELECT id FROM project_enrollments WHERE project_id = ${projectId} AND user_id = ${userId} AND vault_entry_id IN (${idList})
    `);
    for (const r of rows.rows as any[]) {
      await logSubjectActivity("project_enrollment", Number(r.id), "reward", {
        actorUserId: userId, amount, meta: { projectId, taskId },
      });
    }
  } catch {
    // Best-effort — never block task approval on log-write issues.
  }
}

// ── POST /tasks/:id/verify — admin approve/reject ──────────────────────────
router.post("/tasks/:id/verify", requireAdmin, async (req, res): Promise<void> => {
  const { submissionId, approved, rejectionReason } = req.body;
  const status = approved ? "approved" : "rejected";
  await db.update(taskSubmissionsTable).set({ status, rejectionReason, reviewedAt: new Date() }).where(eq(taskSubmissionsTable.id, submissionId));

  const [sub] = await db.select().from(taskSubmissionsTable).where(eq(taskSubmissionsTable.id, submissionId));
  let taskName: string | null = null;
  let rewardAmount: number | null = null;

  if (sub) {
    const [task] = await db.select().from(tasksTable).where(eq(tasksTable.id, sub.taskId));
    if (task) {
      taskName = task.name;
      rewardAmount = task.rewardAmount ?? null;
      if (approved) {
        await db.update(tasksTable).set({ completionCount: task.completionCount + 1 }).where(eq(tasksTable.id, sub.taskId));
        await awardXpAsAzn(sub.userId, task);
      }
    }

    if (approved) {
      await createNotification(sub.userId, "task_approved", "Task Approved ✓",
        taskName ? `"${taskName}" approved by admin. XP credited to your balance.` : "Your task was approved.",
        { submissionId, taskId: sub.taskId, xpAmount: task?.xpAmount ?? 0 });
      logActivity(sub.userId, "task_approved", "task", sub.taskId, taskName, { xpAmount: task?.xpAmount ?? 0, reward: rewardAmount });
      const parsedEntityIds: number[] | null = sub.entityIds
        ? JSON.parse(sub.entityIds)
        : (sub.entityId ? [sub.entityId] : null);
      logProjectReward(task?.projectId, sub.taskId, sub.userId, sub.profit, parsedEntityIds);
      let hasProfitIntent = false;
      try {
        const parsedCostEntries = sub.costEntries ? JSON.parse(sub.costEntries) : [];
        hasProfitIntent = Array.isArray(parsedCostEntries) && parsedCostEntries.some((e: any) => e.type === "profit");
      } catch {}
      postTaskFinanceEntries(sub.userId, task?.projectId, taskName ?? `Task #${sub.taskId}`, sub.cost, sub.profit, hasProfitIntent);
    } else {
      await createNotification(sub.userId, "task_rejected", "Task Rejected",
        taskName ? `"${taskName}" was rejected. Reason: ${rejectionReason || "See admin notes."}` : "Your task was rejected.",
        { submissionId, taskId: sub.taskId, reason: rejectionReason });
      logActivity(sub.userId, "task_rejected", "task", sub.taskId, taskName, { reason: rejectionReason });
    }

    if (taskName) {
      notifyTaskVerified(sub.userId, taskName, !!approved, rewardAmount).catch(() => {});
      const { sendTaskApprovedEmail } = await import("../lib/email");
      const [user] = await db.select({ email: usersTable.email, username: usersTable.username })
        .from(usersTable).where(eq(usersTable.id, sub.userId));
      if (user && approved) {
        sendTaskApprovedEmail(user.email, user.username, taskName, rewardAmount).catch(() => {});
      } else if (user && !approved) {
        const { sendTaskRejectedEmail } = await import("../lib/email");
        sendTaskRejectedEmail(user.email, user.username, taskName ?? "", rejectionReason ?? undefined).catch(() => {});
      }
    }
  }

  broadcastEvent("tasks_updated", { action: "verified", submissionId, status });
  broadcastEvent("submissions_updated", { submissionId, status });
  broadcastEvent("users_updated", { reason: "task_verified" });
  if (sub) broadcastToUser(sub.userId, "submissions_updated", { submissionId, status, taskName });
  res.json({ message: `Submission ${status}` });
});

// POST /tasks/submissions/:id/receipt — mint (or fetch the existing) public link
router.post("/tasks/submissions/:id/receipt", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const role = req.user!.role;
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid submission id" }); return; }
  try {
    const [sub] = await db.select({ id: taskSubmissionsTable.id, userId: taskSubmissionsTable.userId })
      .from(taskSubmissionsTable).where(eq(taskSubmissionsTable.id, id));
    if (!sub) { res.status(404).json({ error: "Submission not found" }); return; }
    // Phase C1: same "owner OR admin" question as before, now decided by
    // the PDP — same response shape (403 "Not your submission") on a
    // non-ALLOW.
    const mintOutcome = await authorize({
      req,
      engine: submissionOwnerOrAdminEngine,
      action: "task.submission_receipt.create",
      resource: { type: "task.submission", id: String(sub.id), ownerId: sub.userId },
    });
    if (mintOutcome.decision.effect !== "ALLOW") { res.status(403).json({ error: "Not your submission" }); return; }

    const token = await mintTaskReceiptToken(id);
    if (!token) { res.status(500).json({ error: "Could not generate a receipt link, please try again" }); return; }
    res.json({ token, url: taskReceiptUrl(token) });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to create receipt link", detail: err?.message });
  }
});

// DELETE /tasks/submissions/:id/receipt — revoke the public link
router.delete("/tasks/submissions/:id/receipt", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const role = req.user!.role;
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid submission id" }); return; }
  const [sub] = await db.select({ id: taskSubmissionsTable.id, userId: taskSubmissionsTable.userId })
    .from(taskSubmissionsTable).where(eq(taskSubmissionsTable.id, id));
  if (!sub) { res.status(404).json({ error: "Submission not found" }); return; }
  // Phase C1 — see the mint route above for the full rationale.
  const revokeOutcome = await authorize({
    req,
    engine: submissionOwnerOrAdminEngine,
    action: "task.submission_receipt.revoke",
    resource: { type: "task.submission", id: String(sub.id), ownerId: sub.userId },
  });
  if (revokeOutcome.decision.effect !== "ALLOW") { res.status(403).json({ error: "Not your submission" }); return; }
  await db.update(taskSubmissionsTable).set({ receiptToken: null }).where(eq(taskSubmissionsTable.id, id));
  res.json({ success: true });
});

// GET /tasks/submissions/receipt/:token — public, no auth
router.get("/tasks/submissions/receipt/:token", requirePublicAudit("task_receipt.view", { onDecision: pepDecisionObserver }), async (req, res): Promise<void> => {
  const token = Array.isArray(req.params.token) ? req.params.token[0] : req.params.token;
  if (!token) { res.status(400).json({ error: "Missing token" }); return; }
  const found = await findTaskReceiptByToken(token);
  if (!found) { res.status(404).json({ error: "This receipt link is invalid or has been revoked." }); return; }
  res.json(fmtPublicTaskReceipt(found));
});

// GET /tasks/submissions/receipt/:token/pdf — public, no auth
router.get("/tasks/submissions/receipt/:token/pdf", requirePublicAudit("task_receipt.pdf", { onDecision: pepDecisionObserver }), async (req, res): Promise<void> => {
  const token = Array.isArray(req.params.token) ? req.params.token[0] : req.params.token;
  if (!token) { res.status(400).json({ error: "Missing token" }); return; }
  const found = await findTaskReceiptByToken(token);
  if (!found) { res.status(404).json({ error: "This receipt link is invalid or has been revoked." }); return; }
  const r = fmtPublicTaskReceipt(found);

  streamFantasticReceiptPdf(res, {
    kicker: "Task Submission Receipt",
    title: r.taskName,
    subtitle: [r.projectName, r.taskId].filter(Boolean).join(" · ") || undefined,
    avatarLetter: r.taskName,
    heroLabel: "Net Profit",
    heroValue: `${r.netProfit >= 0 ? "+" : ""}$${r.netProfit.toFixed(2)}`,
    heroPositive: r.netProfit >= 0,
    stats: [
      { label: "Task Number", value: r.taskId ?? "—" },
      { label: "Project", value: r.projectName ?? "—" },
      { label: "Status", value: r.status },
      { label: "Cost", value: `$${r.cost.toFixed(2)}`, color: "#e4453a" },
      { label: "Profit", value: `$${r.profit.toFixed(2)}`, color: "#0f9d58" },
      { label: "Net Profit", value: `${r.netProfit >= 0 ? "+" : ""}$${r.netProfit.toFixed(2)}`, color: r.netProfit >= 0 ? "#0f9d58" : "#e4453a" },
    ],
    receiptId: r.id,
    issuedBy: r.issuedBy,
    filenamePrefix: "task-submission",
  });
});

// POST /tasks/submissions/:id/receipt/email — email the receipt link to the submitter
router.post("/tasks/submissions/:id/receipt/email", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const role = req.user!.role;
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid submission id" }); return; }
  try {
    const [sub] = await db.select().from(taskSubmissionsTable).where(eq(taskSubmissionsTable.id, id));
    if (!sub) { res.status(404).json({ error: "Submission not found" }); return; }
    // Phase C1 — see the mint route above for the full rationale.
    const emailOutcome = await authorize({
      req,
      engine: submissionOwnerOrAdminEngine,
      action: "task.submission_receipt.email",
      resource: { type: "task.submission", id: String(sub.id), ownerId: sub.userId },
    });
    if (emailOutcome.decision.effect !== "ALLOW") { res.status(403).json({ error: "Not your submission" }); return; }

    const token = await mintTaskReceiptToken(id);
    if (!token) { res.status(500).json({ error: "Could not generate a receipt link, please try again" }); return; }

    const [task] = await db.select().from(tasksTable).where(eq(tasksTable.id, sub.taskId));
    const [recipient] = await db.select({ email: usersTable.email, username: usersTable.username })
      .from(usersTable).where(eq(usersTable.id, sub.userId));
    if (!recipient?.email) { res.status(400).json({ error: "No email on file for this user" }); return; }

    const { sendReceiptEmail } = await import("../lib/email");
    const result = await sendReceiptEmail(recipient.email, recipient.username, {
      kicker: "Task Submission Receipt",
      title: task?.name ?? "Task",
      summary: `Cost $${(sub.cost ?? 0).toFixed(2)} · Profit $${(sub.profit ?? 0).toFixed(2)}`,
      url: taskReceiptUrl(token),
    });
    if (!result.success) { res.status(502).json({ error: "Failed to send email", detail: result.error }); return; }
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to email receipt", detail: err?.message });
  }
});

export default router;
