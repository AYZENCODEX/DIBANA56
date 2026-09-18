import { Router } from "express";
import { db, vaultEntriesTable, projectsTable, tasksTable, taskSubmissionsTable, usersTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import * as crypto from "crypto";
import { requireAuth, requireAdmin, getRequestUser } from "../middlewares/auth";

const router = Router();

function generateSerial(userId: number): string {
  const ts = Date.now().toString(36).toUpperCase().slice(-4);
  const rand = crypto.randomBytes(2).toString("hex").toUpperCase();
  return `AYZN${userId}-${ts}${rand}`;
}

// POST /ai/actions/create-vault — AI creates a vault entry
router.post("/ai/actions/create-vault", requireAuth, async (req, res): Promise<void> => {
  const { userId } = getRequestUser(req)!;
  const { projectName, category, email, twitterUsername, discordUsername, telegramUsername, walletAddresses, notes } = req.body;

  if (!projectName) { res.status(400).json({ error: "projectName is required" }); return; }

  try {
    const serial = generateSerial(userId);
    const result = await db.execute(sql.raw(
      `INSERT INTO vault_entries (user_id, entity_serial, category, project_name, email, twitter_username, discord_username, telegram_username, wallet_addresses, notes, created_at, updated_at)
       VALUES (${userId}, '${serial}', '${(category || "Wallet").replace(/'/g, "''")}', '${projectName.replace(/'/g, "''")}',
         ${email ? `'${email.replace(/'/g, "''")}'` : "NULL"},
         ${twitterUsername ? `'${twitterUsername.replace(/'/g, "''")}'` : "NULL"},
         ${discordUsername ? `'${discordUsername.replace(/'/g, "''")}'` : "NULL"},
         ${telegramUsername ? `'${telegramUsername.replace(/'/g, "''")}'` : "NULL"},
         ${walletAddresses ? `'${JSON.stringify(walletAddresses).replace(/'/g, "''")}'` : "NULL"},
         ${notes ? `'${notes.replace(/'/g, "''")}'` : "NULL"},
         NOW(), NOW())
       RETURNING *`
    ));
    res.status(201).json({ success: true, vault: result.rows[0], message: `Vault entry created for ${projectName} with serial ${serial}` });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to create vault entry", detail: err?.message });
  }
});

// POST /ai/actions/complete-task — AI marks a task as complete for the user
router.post("/ai/actions/complete-task", requireAuth, async (req, res): Promise<void> => {
  const { userId } = getRequestUser(req)!;
  const { taskId, notes, proofUrl } = req.body;

  if (!taskId) { res.status(400).json({ error: "taskId is required" }); return; }

  try {
    const taskResult = await db.execute(sql.raw(`SELECT * FROM tasks WHERE id = ${Number(taskId)}`));
    const task = taskResult.rows[0] as any;
    if (!task) { res.status(404).json({ error: "Task not found" }); return; }

    // Check existing submission
    const existing = await db.execute(sql.raw(
      `SELECT id, status FROM task_submissions WHERE task_id = ${Number(taskId)} AND user_id = ${userId} ORDER BY submitted_at DESC LIMIT 1`
    ));
    if ((existing.rows[0] as any)?.status === "pending" || (existing.rows[0] as any)?.status === "approved") {
      res.json({ success: false, message: "Task already submitted or approved" });
      return;
    }

    const status = task.verification_type === "auto" ? "approved" : "pending";
    const subResult = await db.execute(sql.raw(
      `INSERT INTO task_submissions (task_id, user_id, status, proof_url, notes, cost, profit)
       VALUES (${Number(taskId)}, ${userId}, '${status}',
         ${proofUrl ? `'${proofUrl.replace(/'/g, "''")}'` : "NULL"},
         ${notes ? `'${notes.replace(/'/g, "''")}'` : "'Submitted via AI Assistant'"},
         ${Number(task.cost ?? 0)}, ${Number(task.profit ?? 0)})
       RETURNING *`
    ));

    res.json({
      success: true,
      submission: subResult.rows[0],
      message: `Task "${task.name}" marked as ${status}. ${status === "approved" ? "Auto-approved!" : "Pending admin review."}`
    });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to complete task", detail: err?.message });
  }
});

// POST /ai/actions/create-project — AI creates a project (admin only)
router.post("/ai/actions/create-project", requireAdmin, async (req, res): Promise<void> => {

  const { name, description, tier, fundingAmount, rewardEstimate, xpName, websiteUrl, twitterHandle } = req.body;
  if (!name) { res.status(400).json({ error: "name is required" }); return; }

  try {
    const [project] = await db.insert(projectsTable).values({
      name, description, xpName: xpName || null, twitterHandle, websiteUrl,
      tier: tier ?? "1", fundingAmount: Number(fundingAmount ?? 0), rewardEstimate: Number(rewardEstimate ?? 0),
    }).returning();
    res.status(201).json({ success: true, project, message: `Project "${name}" created successfully.` });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to create project", detail: err?.message });
  }
});

// GET /ai/actions/get-password — AI retrieves a vault entry password for the user
router.get("/ai/actions/get-password", requireAuth, async (req, res): Promise<void> => {
  const { userId } = getRequestUser(req)!;
  const { projectName, field } = req.query as Record<string, string>;

  if (!projectName) { res.status(400).json({ error: "projectName is required" }); return; }

  try {
    const rows = await db.execute(sql.raw(
      `SELECT * FROM vault_entries WHERE user_id = ${userId} AND project_name ILIKE '%${projectName.replace(/'/g, "''")}%' LIMIT 1`
    ));
    const entry = rows.rows[0] as any;
    if (!entry) { res.json({ success: false, message: `No vault entry found for project "${projectName}"` }); return; }

    const fieldMap: Record<string, string> = {
      email: entry.email,
      email_password: entry.email_password,
      twitter_password: entry.twitter_password,
      discord_password: entry.discord_password,
      telegram_password: entry.telegram_password,
    };

    const requestedField = field && fieldMap[field] !== undefined ? field : null;
    const value = requestedField ? fieldMap[requestedField] : null;

    res.json({
      success: true,
      projectName: entry.project_name,
      entitySerial: entry.entity_serial,
      email: entry.email,
      requestedField: requestedField,
      value: value,
      message: value
        ? `Found ${requestedField} for "${entry.project_name}": ${value}`
        : `Found vault entry for "${entry.project_name}" (serial: ${entry.entity_serial}). Email: ${entry.email ?? "not set"}`
    });
  } catch (err: any) {
    res.status(500).json({ error: "DB error", detail: err?.message });
  }
});

// POST /ai/actions/add-roi — add ROI to a user's project
router.post("/ai/actions/add-roi", requireAuth, async (req, res): Promise<void> => {
  const { userId } = getRequestUser(req)!;
  const { amount, projectId, notes } = req.body;

  if (!amount || isNaN(Number(amount))) { res.status(400).json({ error: "amount is required" }); return; }

  try {
    await db.execute(sql.raw(
      `UPDATE users SET total_roi = COALESCE(total_roi, 0) + ${Number(amount)} WHERE id = ${userId}`
    ));
    if (projectId) {
      await db.execute(sql.raw(
        `UPDATE projects SET total_roi_distributed = COALESCE(total_roi_distributed, 0) + ${Number(amount)} WHERE id = ${Number(projectId)}`
      ));
    }
    res.json({ success: true, message: `ROI of $${amount} added successfully.${notes ? ` Note: ${notes}` : ""}` });
  } catch (err: any) {
    res.status(500).json({ error: "DB error", detail: err?.message });
  }
});

export default router;
