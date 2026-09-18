import { Router } from "express";
import { db, vaultEntriesTable, usersTable, userProjectsTable, projectsTable, taskSubmissionsTable, projectEnrollmentsTable, tasksTable } from "@workspace/db";
import { eq, desc, count, sql } from "drizzle-orm";
import { requireAuth, getRequestUser } from "../middlewares/auth";
import { requireCreditBalance, chargeCredits } from "../services/credit-meter";

const router = Router();

export const GROQ_MODELS = [
  { id: "llama-3.3-70b-versatile",                     name: "Llama 3.3 70B Versatile",       context: 128000, free: true,  tier: "recommended",  speed: "fast" },
  { id: "llama-3.1-8b-instant",                         name: "Llama 3.1 8B Instant",           context: 131072, free: true,  tier: "recommended",  speed: "ultra-fast" },
  { id: "meta-llama/llama-4-scout-17b-16e-instruct",   name: "Llama 4 Scout 17B",              context: 131072, free: true,  tier: "recommended",  speed: "fast" },
  { id: "llama3-70b-8192",                              name: "Llama 3 70B",                    context: 8192,   free: true,  tier: "stable",       speed: "fast" },
  { id: "llama3-8b-8192",                               name: "Llama 3 8B",                     context: 8192,   free: true,  tier: "stable",       speed: "ultra-fast" },
  { id: "gemma2-9b-it",                                 name: "Gemma 2 9B IT",                  context: 8192,   free: true,  tier: "stable",       speed: "fast" },
  { id: "qwen-qwq-32b",                                 name: "Qwen QwQ 32B",                   context: 131072, free: true,  tier: "reasoning",    speed: "medium" },
  { id: "deepseek-r1-distill-llama-70b",                name: "DeepSeek R1 Distill 70B",        context: 131072, free: true,  tier: "reasoning",    speed: "medium" },
  { id: "llama-3.3-70b-specdec",                        name: "Llama 3.3 70B SpecDec",          context: 8192,   free: true,  tier: "experimental", speed: "fast" },
  { id: "llama-guard-3-8b",                             name: "Llama Guard 3 8B",               context: 8192,   free: true,  tier: "safety",       speed: "fast" },
];

const DEFAULT_MODEL = "llama-3.3-70b-versatile";

const USER_SYSTEM = `You are AYZEN AI — a dedicated crypto airdrop intelligence assistant for the AYZEN Airdrop Command Center.

You have DIRECT ACCESS to the user's live account data (injected below). Answer questions about:
- Their vault credential entities (wallets, emails, socials per airdrop project)
- Their enrolled projects and airdrop participation
- Completed tasks, submission history, ROI, streak
- Any specific entity when asked about it directly (by its entity serial or by the project it's tied to)
- Any entity's progress on any specific project — enrollment status plus how many of that project's tasks the entity has completed, has pending, or had rejected (see "Entity Progress by Project" below)
- General crypto: airdrops, DeFi, L2 networks, gas optimization, sybil avoidance

🔧 ACTIONS YOU CAN PERFORM:
When the user asks you to perform an action, respond with an action block at the END of your response in this EXACT format:

ACTION: create_vault
PROJECT: <projectName>
CATEGORY: <Wallet|Twitter|Discord|Telegram>
EMAIL: <email or skip>
TWITTER: <@handle or skip>
DISCORD: <username or skip>
TELEGRAM: <@handle or skip>

ACTION: complete_task
TASK_ID: <numeric id>
NOTES: <optional notes>

ACTION: get_password
PROJECT: <projectName>
FIELD: <email|twitter_password|discord_password|telegram_password>

ACTION: add_roi
AMOUNT: <number>
PROJECT_ID: <optional project id>
NOTES: <description>

Rules:
- When asked about their data ("my accounts", "my vault", "my wallets"), refer to the injected context
- When asked about a specific entity, or "how is entity X doing on project Y", use the Vault Entities and Entity Progress by Project sections to answer precisely — cite the entity serial, project name, enrollment status, and task counts
- When asked to CREATE a vault entry, ADD a project/account, or COMPLETE a task — use the ACTION blocks above
- When asked for a password or credentials, use ACTION: get_password
- Never fabricate credentials — only report what's in the context
- Be concise, direct, and crypto-native
- Use $TICKER symbols when relevant
- Only use one ACTION block per response`;

const ADMIN_SYSTEM = `You are AYZEN Admin AI — an intelligent admin assistant for the AYZEN crypto airdrop platform.

You have DIRECT ACCESS to live platform statistics (injected below). You can help with:
- Platform analytics: user counts, project stats, vault entries, ROI distributed
- User management: answering questions about operators, roles, activity
- Project management: explaining project details, task completion rates
- Any project's platform-wide task/entity progress (see "Task Progress by Project" below) — e.g. how many entities have completed, pending, or rejected tasks on a given project
- Operational decisions: airdrop strategy, vault credential management, tier structure
- Technical debugging: API errors, database issues, system health

Rules:
- Be precise and data-driven, referencing the injected platform stats
- Use admin-appropriate language — direct, professional, action-oriented
- For destructive actions (delete user, ban, etc.), describe the action but clarify it must be done via the admin panel
- Be concise — executives don't want long explanations`;

function buildUserContext(
  user: any, vault: any[], projects: any[], tasks: any[],
  enrollments: any[], entityTaskStats: any[]
): string {
  const lines = ["\n\n══ LIVE USER CONTEXT FROM AYZEN DB ══"];
  lines.push(`Operator: ${user.username} | Streak: ${user.streak}d | Total ROI: $${user.totalRoi} | Role: ${user.role}`);
  if (vault.length) {
    lines.push(`\n📂 Vault Entities (${vault.length} total):`);
    vault.slice(0, 25).forEach(e => {
      lines.push(`  [${e.entitySerial}] ${e.projectName} — ${e.category}`);
      if (e.email) lines.push(`    ✉ ${e.email}`);
      if (e.twitterUsername) lines.push(`    🐦 @${e.twitterUsername}`);
      if (e.discordUsername) lines.push(`    💬 ${e.discordUsername}`);
      if (e.telegramUsername) lines.push(`    📱 @${e.telegramUsername}`);
      const wallets: string[] = e.walletAddresses ? JSON.parse(e.walletAddresses) : [];
      if (wallets.length) lines.push(`    👛 ${wallets.join(" | ")}`);
    });
    if (vault.length > 25) lines.push(`  … +${vault.length - 25} more entities`);
  }
  if (projects.length) {
    lines.push(`\n🚀 Enrolled Projects (${projects.length}):`);
    projects.slice(0, 15).forEach(p => {
      lines.push(`  • ${p.name} | Tier: ${p.tier} | Est. Reward: $${p.rewardEstimate ?? "TBD"}`);
    });
  }
  // Per-entity, per-project progress — lets the assistant answer "how far along
  // is entity X on project Y" directly instead of only listing raw submissions.
  if (enrollments.length) {
    lines.push(`\n📊 Entity Progress by Project (${enrollments.length} enrollments):`);
    enrollments.slice(0, 25).forEach(en => {
      const statsForEntity = entityTaskStats.filter(
        s => s.entityId === en.vaultEntryId && s.projectId === en.projectId
      );
      const byStatus: Record<string, number> = {};
      statsForEntity.forEach(s => { byStatus[s.status] = Number(s.cnt); });
      const total = Object.values(byStatus).reduce((a, b) => a + b, 0);
      const breakdown = Object.entries(byStatus).map(([status, cnt]) => `${cnt} ${status}`).join(", ") || "no task submissions yet";
      lines.push(`  • [${en.entitySerial}] on "${en.projectName}" — enrollment: ${en.status} | tasks: ${breakdown} (${total} total)`);
    });
    if (enrollments.length > 25) lines.push(`  … +${enrollments.length - 25} more enrollments`);
  }
  if (tasks.length) {
    lines.push(`\n✅ Recent Task Submissions:`);
    tasks.slice(0, 8).forEach(t => {
      lines.push(`  • Task #${t.taskId} | ${t.status} | $${t.rewardAmount ?? "?"}`);
    });
  }
  lines.push("══════════════════════════════════════");
  return lines.join("\n");
}

async function buildAdminContext(): Promise<string> {
  try {
    const [{ totalUsers }] = await db.select({ totalUsers: count() }).from(usersTable);
    const [{ totalProjects }] = await db.select({ totalProjects: count() }).from(projectsTable);
    const [{ totalVault }] = await db.select({ totalVault: count() }).from(vaultEntriesTable);
    const [{ totalSubmissions }] = await db.select({ totalSubmissions: count() }).from(taskSubmissionsTable);
    const projects = await db.select({ name: projectsTable.name, tier: projectsTable.tier, rewardEstimate: projectsTable.rewardEstimate, fundingAmount: projectsTable.fundingAmount }).from(projectsTable).limit(20);
    const recentUsers = await db.select({ username: usersTable.username, email: usersTable.email, role: usersTable.role, createdAt: usersTable.createdAt }).from(usersTable).orderBy(desc(usersTable.createdAt)).limit(10);
    // Platform-wide task completion breakdown per project, so the admin
    // assistant can answer "how is project X progressing" or "which entities
    // on project X still have pending tasks" without needing raw SQL.
    const projectTaskStats = await db.select({
      projectId: tasksTable.projectId,
      projectName: projectsTable.name,
      status: taskSubmissionsTable.status,
      cnt: count(),
    })
      .from(taskSubmissionsTable)
      .innerJoin(tasksTable, eq(taskSubmissionsTable.taskId, tasksTable.id))
      .leftJoin(projectsTable, eq(tasksTable.projectId, projectsTable.id))
      .groupBy(tasksTable.projectId, projectsTable.name, taskSubmissionsTable.status);

    const lines = ["\n\n══ LIVE PLATFORM CONTEXT FROM AYZEN DB ══"];
    lines.push(`Platform Stats: ${totalUsers} operators | ${totalProjects} projects | ${totalVault} vault entities | ${totalSubmissions} task submissions`);
    if (projects.length) {
      lines.push(`\n🚀 Active Projects:`);
      projects.forEach(p => lines.push(`  • ${p.name} | Tier ${p.tier} | Est. Reward: $${p.rewardEstimate} | Funding: $${p.fundingAmount}`));
    }
    if (projectTaskStats.length) {
      lines.push(`\n📊 Task Progress by Project (all entities, platform-wide):`);
      const byProject = new Map<number, { name: string; byStatus: Record<string, number> }>();
      projectTaskStats.forEach(s => {
        if (s.projectId == null) return;
        const entry = byProject.get(s.projectId) ?? { name: s.projectName ?? `Project #${s.projectId}`, byStatus: {} };
        entry.byStatus[s.status] = Number(s.cnt);
        byProject.set(s.projectId, entry);
      });
      byProject.forEach(({ name, byStatus }) => {
        const total = Object.values(byStatus).reduce((a, b) => a + b, 0);
        const breakdown = Object.entries(byStatus).map(([status, cnt]) => `${cnt} ${status}`).join(", ");
        lines.push(`  • ${name} — ${breakdown} (${total} total submissions)`);
      });
    }
    if (recentUsers.length) {
      lines.push(`\n👥 Recent Operators (newest 10):`);
      recentUsers.forEach(u => lines.push(`  • ${u.username} (${u.email}) | Role: ${u.role}`));
    }
    lines.push("══════════════════════════════════════");
    return lines.join("\n");
  } catch {
    return "\n\n[Platform context unavailable — DB offline]";
  }
}

// PHASE 5: metered action zynth.ai_query. Admin/operator console use of this
// same endpoint (buildAdminContext() below) is internal ops tooling, not a
// user spending their own credit pool, so it's exempted — see file header
// on requireCreditBalance for why exemptRoles exists.
router.post("/ai/chat", requireAuth, requireCreditBalance("zynth.ai_query", { exemptRoles: ["admin", "operator"] }), async (req, res): Promise<void> => {
  const groqKey = process.env.GROQ_API_KEY;
  const openRouterKey = process.env.OPENROUTER_API_KEY;

  if (!groqKey && !openRouterKey) {
    res.status(503).json({ error: "AI not configured. Add GROQ_API_KEY in Replit Secrets." });
    return;
  }

  const { messages, model } = req.body;
  if (!messages || !Array.isArray(messages)) {
    res.status(400).json({ error: "messages array required" });
    return;
  }

  const { userId, role } = getRequestUser(req)!;
  const isAdmin = role === "admin" || role === "operator";

  let systemPrompt: string;
  if (isAdmin) {
    const ctx = await buildAdminContext();
    systemPrompt = ADMIN_SYSTEM + ctx;
  } else {
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
    const vault = await db.select().from(vaultEntriesTable).where(eq(vaultEntriesTable.userId, userId));
    const projects = await db.select({ name: projectsTable.name, tier: projectsTable.tier, rewardEstimate: projectsTable.rewardEstimate })
      .from(userProjectsTable)
      .innerJoin(projectsTable, eq(userProjectsTable.projectId, projectsTable.id))
      .where(eq(userProjectsTable.userId, userId));
    const tasks = await db.select().from(taskSubmissionsTable)
      .where(eq(taskSubmissionsTable.userId, userId))
      .orderBy(desc(taskSubmissionsTable.submittedAt))
      .limit(10);
    // Which entity is enrolled in which project, and how that entity's task
    // submissions for that project break down by status — powers "how is
    // entity X doing on project Y" style questions.
    const enrollments = await db.select({
      projectId: projectEnrollmentsTable.projectId,
      projectName: projectsTable.name,
      vaultEntryId: projectEnrollmentsTable.vaultEntryId,
      entitySerial: vaultEntriesTable.entitySerial,
      status: projectEnrollmentsTable.status,
    })
      .from(projectEnrollmentsTable)
      .innerJoin(projectsTable, eq(projectEnrollmentsTable.projectId, projectsTable.id))
      .innerJoin(vaultEntriesTable, eq(projectEnrollmentsTable.vaultEntryId, vaultEntriesTable.id))
      .where(eq(projectEnrollmentsTable.userId, userId));
    const entityTaskStats = await db.select({
      entityId: taskSubmissionsTable.entityId,
      projectId: tasksTable.projectId,
      status: taskSubmissionsTable.status,
      cnt: count(),
    })
      .from(taskSubmissionsTable)
      .innerJoin(tasksTable, eq(taskSubmissionsTable.taskId, tasksTable.id))
      .where(eq(taskSubmissionsTable.userId, userId))
      .groupBy(taskSubmissionsTable.entityId, tasksTable.projectId, taskSubmissionsTable.status);
    systemPrompt = USER_SYSTEM + (user ? buildUserContext(user, vault, projects, tasks, enrollments, entityTaskStats) : "");
  }

  const selectedModel = (model && GROQ_MODELS.find(m => m.id === model)) ? model : DEFAULT_MODEL;
  const allMessages = [{ role: "system", content: systemPrompt }, ...messages.slice(-20)];

  type ProviderResult = { ok: true; data: Record<string, unknown>; label: string } | { ok: false; error: string };

  async function tryGroq(): Promise<ProviderResult> {
    if (!groqKey) return { ok: false, error: "GROQ_API_KEY not set" };
    try {
      const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${groqKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: selectedModel, messages: allMessages, max_tokens: 1024 }),
      });
      const data = await response.json() as Record<string, unknown>;
      if (!response.ok || (data as any)?.error) {
        return { ok: false, error: `Groq: ${JSON.stringify((data as any)?.error ?? data)}` };
      }
      return { ok: true, data, label: selectedModel };
    } catch (err: any) {
      return { ok: false, error: `Groq: ${err?.message ?? "request failed"}` };
    }
  }

  async function tryOpenRouter(): Promise<ProviderResult> {
    if (!openRouterKey) return { ok: false, error: "OPENROUTER_API_KEY not set" };
    try {
      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${openRouterKey}`, "Content-Type": "application/json", "HTTP-Referer": "https://ayzen.tech" },
        body: JSON.stringify({ model: "meta-llama/llama-3.3-70b-instruct:free", messages: allMessages, max_tokens: 1024 }),
      });
      const data = await response.json() as Record<string, unknown>;
      if (!response.ok || (data as any)?.error) {
        return { ok: false, error: `OpenRouter: ${JSON.stringify((data as any)?.error ?? data)}` };
      }
      return { ok: true, data, label: "llama-3.3-70b (OpenRouter)" };
    } catch (err: any) {
      return { ok: false, error: `OpenRouter: ${err?.message ?? "request failed"}` };
    }
  }

  const providers = [tryGroq, tryOpenRouter];
  const errors: string[] = [];

  for (const provider of providers) {
    const result = await provider();
    if (result.ok) {
      // Charge-on-success (see services/credit-meter.ts): only now, after a
      // provider actually returned a reply, do we touch the ledger — a
      // Groq+OpenRouter double-failure below never costs the user credits.
      let creditsCharge: { newBalance: number; charged: number } | null = null;
      if (!isAdmin) {
        const charge = await chargeCredits(userId, "zynth.ai_query");
        if (charge.ok) creditsCharge = { newBalance: charge.newBalance, charged: charge.charged };
        // If this somehow fails (balance moved between the pre-flight check
        // and now), we still return the reply — it already cost tokens —
        // rather than discard a completed AI response over a ledger race.
      }
      res.json({ ...result.data, _model: result.label, _credits: creditsCharge });
      return;
    }
    errors.push(result.error);
  }

  res.status(502).json({
    error: "All AI providers failed. Check that your API keys are valid.",
    details: errors,
  });
});

router.get("/ai/models", (_req, res) => {
  res.json(GROQ_MODELS);
});

export default router;
