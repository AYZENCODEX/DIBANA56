import { Router } from "express";
import { db, creditsTable, creditTransactionsTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { requireAuth, requireAdmin } from "../middlewares/auth";
import { syncSubscriptionExpiry } from "../services/sync";

const router = Router();

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const GROQ_API_KEY = process.env.GROQ_API_KEY;

async function callAI(systemPrompt: string, userPrompt: string): Promise<string> {
  if (OPENROUTER_API_KEY) {
    try {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { "Authorization": `Bearer ${OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "meta-llama/llama-3.1-8b-instruct:free",
          messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }],
          max_tokens: 800,
        }),
      });
      const json = await res.json() as any;
      if (json.choices?.[0]?.message?.content) return json.choices[0].message.content;
    } catch {}
  }
  if (GROQ_API_KEY) {
    try {
      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { "Authorization": `Bearer ${GROQ_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "llama3-8b-8192",
          messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }],
          max_tokens: 800,
        }),
      });
      const json = await res.json() as any;
      if (json.choices?.[0]?.message?.content) return json.choices[0].message.content;
    } catch {}
  }
  throw new Error("No AI provider configured. Set OPENROUTER_API_KEY or GROQ_API_KEY.");
}

// ── GET /content/memory/:projectId — list project memory ─────────────────────
router.get("/content/memory/:projectId", requireAuth, async (req, res): Promise<void> => {
  const projectId = parseInt(Array.isArray(req.params.projectId) ? req.params.projectId[0] : req.params.projectId, 10);
  const result = await db.execute(sql.raw(
    `SELECT * FROM project_memory WHERE project_id = ${projectId} ORDER BY created_at DESC`
  ));
  res.json(result.rows);
});

// ── POST /content/memory/:projectId — add memory entry ───────────────────────
// C28: project_memory has no owner column (only project_id), and `projects`
// itself has no owner column either — this is shared platform content, not
// per-user data, so there's no ownership to gate on. Decision (C28, owner
// sign-off): write restricted to admins; read stays open to any authenticated
// user (unchanged GET routes below). requireAdmin already routes through the
// PDP (lib/policy/pep/middleware.ts's requireRole(), see middlewares/auth.ts
// header) so this decision is observable via pepDecisionObserver the same way
// every other role-gated route already is — no separate resource-ownership
// engine needed since there's no ownerId on these rows to compare against.
router.post("/content/memory/:projectId", requireAdmin, async (req, res): Promise<void> => {
  const projectId = parseInt(Array.isArray(req.params.projectId) ? req.params.projectId[0] : req.params.projectId, 10);
  const { contentType, content } = req.body;
  if (!contentType || !content) { res.status(400).json({ error: "contentType and content are required" }); return; }
  const validTypes = ["context", "post", "hashtag", "question"];
  if (!validTypes.includes(contentType)) { res.status(400).json({ error: `contentType must be one of: ${validTypes.join(", ")}` }); return; }
  const result = await db.execute(sql.raw(
    `INSERT INTO project_memory (project_id, content_type, content) VALUES (${projectId}, '${contentType.replace(/'/g, "''")}', '${content.replace(/'/g, "''")}') RETURNING *`
  ));
  res.status(201).json(result.rows[0]);
});

// ── DELETE /content/memory/:id — delete memory entry ─────────────────────────
// C28: admin-only write (see note above POST /content/memory/:projectId).
router.delete("/content/memory/:id", requireAdmin, async (req, res): Promise<void> => {
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  await db.execute(sql.raw(`DELETE FROM project_memory WHERE id = ${id}`));
  res.json({ ok: true });
});

// ── GET /content/generated/:projectId — list generated content ────────────────
router.get("/content/generated/:projectId", requireAuth, async (req, res): Promise<void> => {
  const projectId = parseInt(Array.isArray(req.params.projectId) ? req.params.projectId[0] : req.params.projectId, 10);
  const { type, limit = "20" } = req.query as Record<string, string>;
  let query = `SELECT * FROM generated_content WHERE project_id = ${projectId}`;
  if (type) query += ` AND type = '${type.replace(/'/g, "''")}'`;
  query += ` ORDER BY created_at DESC LIMIT ${Math.min(parseInt(limit, 10), 100)}`;
  const result = await db.execute(sql.raw(query));
  res.json(result.rows);
});

// ── POST /content/generate — generate content (costs 1 credit) ───────────────
// C28: admin-only write (see note above POST /content/memory/:projectId).
// Still spends the calling admin's own credit balance (req.user!.userId
// below) — only who may call this endpoint changed, not the credit logic.
router.post("/content/generate", requireAdmin, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const { projectId, type, customInstructions } = req.body;
  if (!projectId || !type) { res.status(400).json({ error: "projectId and type are required" }); return; }
  const validTypes = ["post", "reply", "comment"];
  if (!validTypes.includes(type)) { res.status(400).json({ error: `type must be one of: ${validTypes.join(", ")}` }); return; }

  const [credits] = await db.select().from(creditsTable).where(eq(creditsTable.userId, userId));
  if (!credits || credits.balance < 1) {
    res.status(402).json({ error: "Insufficient credits. Purchase credits to generate content.", code: "INSUFFICIENT_CREDITS" });
    return;
  }

  const memoryResult = await db.execute(sql.raw(
    `SELECT content_type, content FROM project_memory WHERE project_id = ${Number(projectId)} ORDER BY created_at DESC LIMIT 20`
  ));
  const memories = memoryResult.rows as any[];
  const context = memories.map(m => `[${m.content_type.toUpperCase()}]: ${m.content}`).join("\n");
  const projectResult = await db.execute(sql.raw(`SELECT name, description FROM projects WHERE id = ${Number(projectId)} LIMIT 1`));
  const project = projectResult.rows[0] as any;

  const systemPrompt = `You are a Web3 content creator for the "${project?.name ?? "Unknown"}" project. ${project?.description ? `Project: ${project.description}` : ""}
Write authentic, engaging ${type}s for crypto/Web3 community farming. Use the provided context/memory to maintain consistent tone and style. Keep it under 280 characters for posts, longer for replies/comments.`;

  const userPrompt = [
    context ? `Project Memory:\n${context}` : "No specific memory provided.",
    customInstructions ? `\nAdditional instructions: ${customInstructions}` : "",
    `\nGenerate one compelling ${type} for this Web3 project.`,
  ].join("\n");

  let output: string;
  try {
    output = await callAI(systemPrompt, userPrompt);
  } catch (err: any) {
    res.status(503).json({ error: err.message ?? "AI generation failed" });
    return;
  }

  const promptUsed = userPrompt.slice(0, 500);

  const insertResult = await db.execute(sql.raw(
    `INSERT INTO generated_content (project_id, type, prompt_used, output) VALUES (${Number(projectId)}, '${type}', '${promptUsed.replace(/'/g, "''")}', '${output.replace(/'/g, "''")}') RETURNING *`
  ));

  await db.update(creditsTable).set({ balance: credits.balance - 1, totalSpent: credits.totalSpent + 1 }).where(eq(creditsTable.userId, userId));
  await db.insert(creditTransactionsTable).values({ userId, type: "spend", method: "content_generation", credits: 1, aznAmount: 0, status: "completed", notes: `Generated ${type} for project ${projectId}` });

  res.status(201).json({ ...insertResult.rows[0], creditsRemaining: credits.balance - 1 });
});

// ── DELETE /content/generated/:id — delete generated content ─────────────────
// C28: admin-only write (see note above POST /content/memory/:projectId).
router.delete("/content/generated/:id", requireAdmin, async (req, res): Promise<void> => {
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  await db.execute(sql.raw(`DELETE FROM generated_content WHERE id = ${id}`));
  res.json({ ok: true });
});

// ── GET /content/plan-limits — check user's generation limits ─────────────────
router.get("/content/plan-limits", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  await syncSubscriptionExpiry(userId);
  const subResult = await db.execute(sql.raw(`SELECT plan FROM subscriptions WHERE user_id = ${userId} LIMIT 1`));
  const plan = (subResult.rows[0] as any)?.plan ?? "free";
  const limitsResult = await db.execute(sql.raw(`SELECT * FROM plan_limits WHERE plan = '${plan}'`));
  const [credits] = await db.select().from(creditsTable).where(eq(creditsTable.userId, userId));
  res.json({ plan, limits: limitsResult.rows, credits: { balance: credits?.balance ?? 0, aznBalance: credits?.aznBalance ?? 0 } });
});

export default router;
