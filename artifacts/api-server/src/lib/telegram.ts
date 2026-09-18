import TelegramBot from "node-telegram-bot-api";
import { db, usersTable, projectsTable, tasksTable, broadcastsTable, taskSubmissionsTable, projectEnrollmentsTable } from "@workspace/db";
import { eq, desc, count, isNotNull, and, inArray } from "drizzle-orm";
import { logger } from "./logger";
import { broadcastEvent } from "../routes/events";
import * as fs from "fs";
import * as path from "path";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;

// ─── Webhook mode (optional) ───────────────────────────────────────────────────
// Set TELEGRAM_WEBHOOK_URL (e.g. https://api.ayzen.tech/api/telegram/webhook)
// to run the bot on a webhook instead of long-polling — no code path below
// this changes if it's left unset, so every existing deployment keeps
// polling exactly as before. Webhook mode needs its own reverse-proxy-reachable
// URL, so it's a deliberate opt-in rather than a default.
//
// TELEGRAM_WEBHOOK_SECRET is required alongside it: Telegram echoes this
// back as the `X-Telegram-Bot-Api-Secret-Token` header on every webhook
// call (https://core.telegram.org/bots/api#setwebhook), and
// routes/telegram.ts's POST /telegram/webhook rejects anything that
// doesn't match. Without a secret this endpoint would accept arbitrary
// POSTed "updates" from anyone who finds the URL — the secret is what
// makes it a Telegram-only channel instead of an open one.
const WEBHOOK_URL = process.env.TELEGRAM_WEBHOOK_URL;
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;

let bot: TelegramBot | null = null;
let transportMode: "polling" | "webhook" | null = null;

export function getTelegramTransportMode(): "polling" | "webhook" | null {
  return transportMode;
}

// ─── Persistent pending-link store (survives server restarts) ─────────────────
const PENDING_FILE = path.join("/tmp", "tg_pending_codes.json");

interface PendingEntry { code: string; expires: number; }

function loadPending(): Map<string, PendingEntry> {
  try {
    const raw = fs.readFileSync(PENDING_FILE, "utf-8");
    const obj: Record<string, PendingEntry> = JSON.parse(raw);
    const now = Date.now();
    const m = new Map<string, PendingEntry>();
    for (const [k, v] of Object.entries(obj)) {
      if (v.expires > now) m.set(k, v);
    }
    return m;
  } catch { return new Map(); }
}

function savePending(m: Map<string, PendingEntry>): void {
  try {
    const obj: Record<string, PendingEntry> = {};
    for (const [k, v] of m.entries()) obj[k] = v;
    fs.writeFileSync(PENDING_FILE, JSON.stringify(obj), "utf-8");
  } catch (e: any) { logger.warn({ err: e?.message }, "savePending failed"); }
}

// Pending link sessions: telegramChatId → { code, expires }
const pendingLinks: Map<string, PendingEntry> = loadPending();
// Reverse lookup: code → chatId
const pendingByCode = new Map<string, string>();
// Rebuild reverse lookup from loaded data
for (const [chatId, entry] of pendingLinks.entries()) {
  pendingByCode.set(entry.code, chatId);
}

function genCode(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function md(text: string): string {
  return String(text).replace(/[_*[\]()~`>#+=|{}.!-]/g, "\\$&");
}

export function getBot(): TelegramBot | null {
  return bot;
}

export async function sendToUser(chatId: string, text: string): Promise<void> {
  if (!bot) return;
  try {
    await bot.sendMessage(chatId, text, { parse_mode: "Markdown" });
  } catch (err: any) {
    logger.warn({ err: err?.message, chatId }, "Telegram sendToUser failed");
  }
}

/**
 * Same as sendToUser, but with a single inline-keyboard button under the
 * message — the "template with a Repay/Confirm button" the Finance invoice
 * and payment-agreement flows send (see lib/finance-invoice.ts). Falls back
 * to a plain message with the link appended if the bot isn't configured.
 */
export async function sendToUserWithButton(chatId: string, text: string, buttonText: string, url: string): Promise<void> {
  if (!bot) return;
  try {
    await bot.sendMessage(chatId, text, {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: [[{ text: buttonText, url }]] },
    });
  } catch (err: any) {
    logger.warn({ err: err?.message, chatId }, "Telegram sendToUserWithButton failed");
  }
}

export async function broadcastToAll(text: string): Promise<number> {
  if (!bot) return 0;
  const users = await db
    .select({ telegramChatId: usersTable.telegramChatId })
    .from(usersTable)
    .where(isNotNull(usersTable.telegramChatId));
  let sent = 0;
  for (const u of users) {
    if (!u.telegramChatId) continue;
    try {
      await bot.sendMessage(u.telegramChatId, text, { parse_mode: "Markdown" });
      sent++;
    } catch {
      // user may have blocked bot — skip silently
    }
  }
  return sent;
}

async function isAdminChat(chatId: string): Promise<boolean> {
  const rows = await db
    .select({ role: usersTable.role })
    .from(usersTable)
    .where(eq(usersTable.telegramChatId, chatId))
    .limit(1);
  return rows[0]?.role === "admin";
}

async function getLinkedUser(chatId: string) {
  const rows = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.telegramChatId, chatId))
    .limit(1);
  return rows[0] ?? null;
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

async function handleStart(msg: { chat: { id: number }; from?: { first_name?: string } }): Promise<void> {
  const chatId = String(msg.chat.id);
  const first = msg.from?.first_name ?? "Operator";
  const linked = await getLinkedUser(chatId);

  const greeting = linked
    ? `✅ *Welcome back, ${linked.username}!*\n\nYour AYZEN account is connected.`
    : `🚀 *Welcome to AYZEN, ${first}!*\n\n_Crypto Airdrop Command Center_\n\nLink your account to receive broadcasts and track airdrops in real-time.`;

  await bot!.sendMessage(chatId, greeting, {
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [
          { text: "📊 Projects", callback_data: "projects" },
          { text: "🏆 Leaderboard", callback_data: "leaderboard" },
        ],
        [
          { text: "🔗 Link Account", callback_data: "link" },
          { text: "💡 Help", callback_data: "help" },
        ],
        [{ text: "📡 Platform Status", callback_data: "status" }],
      ],
    },
  });
}

async function handleHelp(chatId: string): Promise<void> {
  const text = [
    "*AYZEN Bot — Command Reference*",
    "",
    "📌 *General*",
    "/start — Main menu",
    "/help — This message",
    "/status — Platform health",
    "/ping — Quick alive check",
    "",
    "📊 *Airdrop Intel*",
    "/projects — Active airdrop projects",
    "/leaderboard — Top operators by ROI",
    "/tasks — Available tasks with IDs",
    "",
    "✅ *Task Completion*",
    "/done <taskId> — Submit task completion",
    "/mytasks — Your submission history",
    "",
    "👤 *Account*",
    "/connect — Link your AYZEN account",
    "/disconnect — Unlink account",
    "/me — Your stats",
    "",
    "🔐 *Admin Only*",
    "/broadcast <message> — Push to all users",
    "/stats — Platform statistics",
  ].join("\n");

  await bot!.sendMessage(chatId, text, { parse_mode: "Markdown" });
}

async function handleStatus(chatId: string): Promise<void> {
  const [{ userCount }] = await db.select({ userCount: count() }).from(usersTable);
  const [{ projectCount }] = await db.select({ projectCount: count() }).from(projectsTable);
  const [{ taskCount }] = await db.select({ taskCount: count() }).from(tasksTable);
  const [{ connectedCount }] = await db
    .select({ connectedCount: count() })
    .from(usersTable)
    .where(isNotNull(usersTable.telegramChatId));

  const text = [
    "*⚡ AYZEN Platform Status*",
    "",
    "🟢 API: Online",
    `👥 Users: ${userCount}`,
    `📱 Telegram connected: ${connectedCount}`,
    `📂 Projects: ${projectCount}`,
    `✅ Tasks: ${taskCount}`,
    "",
    "_All systems operational_",
  ].join("\n");

  await bot!.sendMessage(chatId, text, { parse_mode: "Markdown" });
}

async function handleProjects(chatId: string): Promise<void> {
  const projects = await db
    .select({
      id: projectsTable.id,
      name: projectsTable.name,
      tier: projectsTable.tier,
      rewardEstimate: projectsTable.rewardEstimate,
      fundingAmount: projectsTable.fundingAmount,
    })
    .from(projectsTable)
    .limit(8);

  if (!projects.length) {
    await bot!.sendMessage(chatId, "No projects found at the moment. Check back soon!");
    return;
  }

  const lines = projects.map(
    (p, i) =>
      `${i + 1}. *${p.name}* [Tier ${p.tier}]\n   Reward: ~$${p.rewardEstimate} • Funding: $${p.fundingAmount}`
  );

  await bot!.sendMessage(
    chatId,
    `*📊 Active Airdrop Projects*\n\n${lines.join("\n\n")}`,
    { parse_mode: "Markdown" }
  );
}

async function handleLeaderboard(chatId: string): Promise<void> {
  const users = await db
    .select({
      username: usersTable.username,
      totalRoi: usersTable.totalRoi,
      streak: usersTable.streak,
    })
    .from(usersTable)
    .orderBy(desc(usersTable.totalRoi))
    .limit(10);

  if (!users.length) {
    await bot!.sendMessage(chatId, "Leaderboard is empty. Be the first to earn ROI!");
    return;
  }

  const medals = ["🥇", "🥈", "🥉"];
  const lines = users.map(
    (u, i) =>
      `${medals[i] ?? `${i + 1}.`} *${u.username}* — ${u.totalRoi.toFixed(1)}% ROI • 🔥 ${u.streak}d`
  );

  await bot!.sendMessage(
    chatId,
    `*🏆 AYZEN Leaderboard*\n\n${lines.join("\n")}`,
    { parse_mode: "Markdown" }
  );
}

async function handleTasks(chatId: string): Promise<void> {
  const tasks = await db
    .select({
      id: tasksTable.id,
      name: tasksTable.name,
      taskType: tasksTable.taskType,
      rewardAmount: tasksTable.rewardAmount,
      verificationType: tasksTable.verificationType,
    })
    .from(tasksTable)
    .orderBy(desc(tasksTable.createdAt))
    .limit(8);

  if (!tasks.length) {
    await bot!.sendMessage(chatId, "No tasks found.");
    return;
  }

  const lines = tasks.map(
    (t) => `• [ID: \`${t.id}\`] *${md(t.name)}* [${t.taskType}] — $${t.rewardAmount ?? 0} reward`
  );

  await bot!.sendMessage(
    chatId,
    `*✅ Available Tasks*\n\n${lines.join("\n")}\n\n_Use /done <ID> to complete a task_`,
    { parse_mode: "Markdown" }
  );
}

async function handleDone(chatId: string, taskIdStr: string): Promise<void> {
  const user = await getLinkedUser(chatId);
  if (!user) {
    await bot!.sendMessage(
      chatId,
      "❌ You must link your AYZEN account first\\. Use /connect to get started\\.",
      { parse_mode: "MarkdownV2" }
    );
    return;
  }

  const taskId = parseInt(taskIdStr.trim(), 10);
  if (isNaN(taskId)) {
    await bot!.sendMessage(chatId, "❌ Invalid task ID\\. Usage: `/done 5`", { parse_mode: "MarkdownV2" });
    return;
  }

  const [task] = await db.select().from(tasksTable).where(eq(tasksTable.id, taskId));
  if (!task) {
    await bot!.sendMessage(chatId, `❌ Task #${taskId} not found\\.`, { parse_mode: "MarkdownV2" });
    return;
  }

  // Check if already submitted
  const [existing] = await db
    .select()
    .from(taskSubmissionsTable)
    .where(and(eq(taskSubmissionsTable.taskId, taskId), eq(taskSubmissionsTable.userId, user.id)))
    .limit(1);

  if (existing) {
    const statusMap: Record<string, string> = { pending: "⏳ pending review", approved: "✅ already approved", rejected: "❌ rejected" };
    await bot!.sendMessage(
      chatId,
      `You already submitted this task\\. Status: *${statusMap[existing.status] ?? existing.status}*`,
      { parse_mode: "MarkdownV2" }
    );
    return;
  }

  // Auto-approve if verification is auto, otherwise pending
  const status = task.verificationType === "auto" ? "approved" : "pending";
  const notes = "Submitted via Telegram";

  await db.insert(taskSubmissionsTable).values({ taskId, userId: user.id, status, notes });

  if (status === "approved") {
    await db.update(tasksTable).set({ completionCount: task.completionCount + 1 }).where(eq(tasksTable.id, taskId));
  }

  // Broadcast to website — real-time sync
  broadcastEvent("tasks_updated", { action: "submitted", taskId, userId: user.id, status, source: "telegram" });

  const rewardText = task.rewardAmount ? ` \\($${task.rewardAmount} reward\\)` : "";

  if (status === "approved") {
    await bot!.sendMessage(
      chatId,
      `✅ *Task Completed\\!*\n\n📋 *${md(task.name)}*${rewardText}\n\nAuto\\-verified and credited to your account\\.`,
      { parse_mode: "MarkdownV2" }
    );
  } else {
    await bot!.sendMessage(
      chatId,
      `📨 *Task Submitted\\!*\n\n📋 *${md(task.name)}*${rewardText}\n\nStatus: ⏳ Pending admin review\\.\nYou'll be notified when it's verified\\.`,
      { parse_mode: "MarkdownV2" }
    );
  }
}

async function handleMyTasks(chatId: string): Promise<void> {
  const user = await getLinkedUser(chatId);
  if (!user) {
    await bot!.sendMessage(chatId, "❌ No linked account. Use /connect first.");
    return;
  }

  const subs = await db
    .select({ sub: taskSubmissionsTable, task: tasksTable })
    .from(taskSubmissionsTable)
    .leftJoin(tasksTable, eq(taskSubmissionsTable.taskId, tasksTable.id))
    .where(eq(taskSubmissionsTable.userId, user.id))
    .orderBy(desc(taskSubmissionsTable.submittedAt))
    .limit(10);

  if (!subs.length) {
    await bot!.sendMessage(chatId, "You haven't submitted any tasks yet\\. Use /tasks to see available tasks\\.", { parse_mode: "MarkdownV2" });
    return;
  }

  const statusEmoji: Record<string, string> = { approved: "✅", pending: "⏳", rejected: "❌" };
  const lines = subs.map(
    (s) => `${statusEmoji[s.sub.status] ?? "•"} *${md(s.task?.name ?? "Unknown")}* — ${s.sub.status}`
  );

  await bot!.sendMessage(
    chatId,
    `*📋 Your Task Submissions*\n\n${lines.join("\n")}`,
    { parse_mode: "Markdown" }
  );
}

async function handleMe(chatId: string): Promise<void> {
  const user = await getLinkedUser(chatId);
  if (!user) {
    await bot!.sendMessage(
      chatId,
      "❌ No linked account. Use /connect to link your AYZEN account."
    );
    return;
  }
  const text = [
    "*👤 Your AYZEN Profile*",
    "",
    `🔑 Username: ${user.username}`,
    `📧 Email: ${user.email}`,
    `💰 ROI: ${user.totalRoi.toFixed(1)}%`,
    `🔥 Streak: ${user.streak} days`,
    `🎭 Role: ${user.role}`,
    `📱 Telegram: @${user.telegramUsername ?? "linked"}`,
  ].join("\n");

  await bot!.sendMessage(chatId, text, { parse_mode: "Markdown" });
}

async function handleStats(chatId: string): Promise<void> {
  if (!(await isAdminChat(chatId))) {
    await bot!.sendMessage(chatId, "⛔ This command is for admins only.");
    return;
  }
  const [{ userCount }] = await db.select({ userCount: count() }).from(usersTable);
  const [{ projectCount }] = await db.select({ projectCount: count() }).from(projectsTable);
  const [{ taskCount }] = await db.select({ taskCount: count() }).from(tasksTable);
  const [{ broadcastCount }] = await db.select({ broadcastCount: count() }).from(broadcastsTable);
  const [{ connectedCount }] = await db
    .select({ connectedCount: count() })
    .from(usersTable)
    .where(isNotNull(usersTable.telegramChatId));

  const text = [
    "*📈 Platform Statistics*",
    "",
    `👥 Total users: ${userCount}`,
    `📱 Telegram connected: ${connectedCount}`,
    `📂 Projects: ${projectCount}`,
    `✅ Tasks: ${taskCount}`,
    `📣 Broadcasts sent: ${broadcastCount}`,
  ].join("\n");

  await bot!.sendMessage(chatId, text, { parse_mode: "Markdown" });
}

async function handleConnect(chatId: string): Promise<void> {
  const code = genCode();
  const entry: PendingEntry = { code, expires: Date.now() + 10 * 60 * 1000 };
  pendingLinks.set(chatId, entry);
  pendingByCode.set(code, chatId);
  savePending(pendingLinks);

  const text = [
    "*🔗 Link Your AYZEN Account*",
    "",
    `Your one-time code: \`${code}\``,
    "",
    "Enter this code in your AYZEN dashboard under *Settings → Telegram Connect*.",
    "",
    "_Expires in 10 minutes._",
  ].join("\n");

  await bot!.sendMessage(chatId, text, { parse_mode: "Markdown" });
}

async function handleDisconnect(chatId: string): Promise<void> {
  const user = await getLinkedUser(chatId);
  if (!user) {
    await bot!.sendMessage(chatId, "No linked account found.");
    return;
  }
  await db
    .update(usersTable)
    .set({ telegramChatId: null, telegramUsername: null })
    .where(eq(usersTable.id, user.id));
  await bot!.sendMessage(chatId, "✅ Your AYZEN account has been disconnected.");
}

async function handleBroadcastCmd(chatId: string, fullText: string): Promise<void> {
  if (!(await isAdminChat(chatId))) {
    await bot!.sendMessage(chatId, "⛔ This command is for admins only.");
    return;
  }
  const message = fullText.replace(/^\/broadcast\s*/i, "").trim();
  if (!message) {
    await bot!.sendMessage(chatId, "Usage: /broadcast <your message here>");
    return;
  }
  const sent = await broadcastToAll(`📣 *AYZEN Broadcast*\n\n${message}`);
  await bot!.sendMessage(chatId, `✅ Broadcast delivered to ${sent} connected user(s).`);
}

// ─── Register all handlers ────────────────────────────────────────────────────

function registerHandlers(b: TelegramBot): void {
  b.onText(/^\/start/, (msg) => handleStart(msg));
  b.onText(/^\/help/, (msg) => handleHelp(String(msg.chat.id)));
  b.onText(/^\/status/, (msg) => handleStatus(String(msg.chat.id)));
  b.onText(/^\/projects/, (msg) => handleProjects(String(msg.chat.id)));
  b.onText(/^\/leaderboard/, (msg) => handleLeaderboard(String(msg.chat.id)));
  b.onText(/^\/tasks/, (msg) => handleTasks(String(msg.chat.id)));
  b.onText(/^\/done(?:\s+(.+))?/, (msg, match) => handleDone(String(msg.chat.id), match?.[1] ?? ""));
  b.onText(/^\/mytasks/, (msg) => handleMyTasks(String(msg.chat.id)));
  b.onText(/^\/me/, (msg) => handleMe(String(msg.chat.id)));
  b.onText(/^\/stats/, (msg) => handleStats(String(msg.chat.id)));
  b.onText(/^\/connect/, (msg) => handleConnect(String(msg.chat.id)));
  b.onText(/^\/disconnect/, (msg) => handleDisconnect(String(msg.chat.id)));
  b.onText(/^\/broadcast/, (msg) => handleBroadcastCmd(String(msg.chat.id), msg.text ?? ""));
  b.onText(/^\/ping/, (msg) => b.sendMessage(msg.chat.id, "🟢 AYZEN Bot is online!"));

  // Inline keyboard callbacks
  b.on("callback_query", async (query) => {
    const chatId = query.message?.chat.id;
    if (!chatId) return;
    await b.answerCallbackQuery(query.id);
    const id = String(chatId);
    switch (query.data) {
      case "projects":    return handleProjects(id);
      case "leaderboard": return handleLeaderboard(id);
      case "link":        return handleConnect(id);
      case "help":        return handleHelp(id);
      case "status":      return handleStatus(id);
    }
  });

  // Fallback: non-command text
  b.on("message", async (msg) => {
    if (!msg.text || msg.text.startsWith("/")) return;
    await b.sendMessage(msg.chat.id, "Type /help to see all available commands.");
  });

  b.on("polling_error", (err: any) => {
    const msg: string = err?.message ?? "";
    // 404 = token invalid/revoked — stop polling immediately, no point retrying
    if (msg.includes("404")) {
      logger.error("Telegram bot token is invalid (404). Stop polling. Re-create the bot via @BotFather and update TELEGRAM_BOT_TOKEN.");
      b.stopPolling().catch(() => {});
      bot = null;
      transportMode = null;
      return;
    }
    // 409 = another instance is polling — stop immediately and retry after backoff
    // (letting the library retry right away just keeps the lock alive forever)
    if (msg.includes("409")) {
      logger.warn("Telegram 409: another polling session active. Stopping, will retry in 15s.");
      b.stopPolling().catch(() => {}).then(() => {
        setTimeout(() => {
          if (bot !== b) return; // bot was replaced, don't restart
          b.startPolling().catch(() => {});
        }, 15000);
      });
      return;
    }
    logger.warn({ err: msg }, "Telegram polling error");
  });
}

// ─── Notify user when their task submission is reviewed ───────────────────────

export async function notifyTaskVerified(
  userId: number,
  taskName: string,
  approved: boolean,
  rewardAmount?: number | null
): Promise<void> {
  if (!bot) return;
  const rows = await db
    .select({ telegramChatId: usersTable.telegramChatId })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);
  const chatId = rows[0]?.telegramChatId;
  if (!chatId) return;

  const reward = rewardAmount ? ` (+$${rewardAmount})` : "";
  const text = approved
    ? `✅ *Task Approved\\!*\n\n📋 *${md(taskName)}*${reward}\n\nYour submission has been verified\\. Great work, Operator\\!`
    : `❌ *Task Rejected*\n\n📋 *${md(taskName)}*\n\nYour submission was not approved\\. Try again or contact support\\.`;

  try {
    await bot.sendMessage(chatId, text, { parse_mode: "MarkdownV2" });
  } catch (err: any) {
    logger.warn({ err: err?.message, userId, chatId }, "notifyTaskVerified: failed to send");
  }
}

// ─── New project alert — broadcast to every user with Telegram linked ─────────

export async function notifyNewProject(project: { id: number; name: string; tier?: string | null }): Promise<void> {
  if (!bot) return;
  const text = `🚀 *New Project Live\\!*\n\n📌 *${md(project.name)}*${project.tier ? ` — Tier ${md(project.tier)}` : ""}\n\nA new project just went live on AYZEN\\. Check it out and enroll your entities\\.`;
  try {
    await broadcastToAll(text);
  } catch (err: any) {
    logger.warn({ err: err?.message, projectId: project.id }, "notifyNewProject: failed to send");
  }
}

// ─── New task alert — only users enrolled in that task's project ──────────────

export async function notifyEnrolledUsersNewTask(
  projectId: number | null | undefined,
  task: { id: number; name: string; rewardAmount?: number | null },
): Promise<void> {
  if (!bot || !projectId) return;
  const enrolledUserIds = await db
    .selectDistinct({ userId: projectEnrollmentsTable.userId })
    .from(projectEnrollmentsTable)
    .where(and(eq(projectEnrollmentsTable.projectId, projectId), eq(projectEnrollmentsTable.status, "active")));
  if (!enrolledUserIds.length) return;

  const ids = enrolledUserIds.map((r) => r.userId);
  const [project] = await db.select({ name: projectsTable.name }).from(projectsTable).where(eq(projectsTable.id, projectId));
  const rows = await db
    .select({ telegramChatId: usersTable.telegramChatId })
    .from(usersTable)
    .where(and(inArray(usersTable.id, ids), isNotNull(usersTable.telegramChatId)));

  const reward = task.rewardAmount ? ` (+$${task.rewardAmount})` : "";
  const text = `🆕 *New Task Available\\!*\n\n📁 Project: *${md(project?.name ?? "")}*\n📋 Task: *${md(task.name)}*${reward}\n\nYou're enrolled in this project — go complete it\\.`;

  for (const r of rows) {
    if (!r.telegramChatId) continue;
    try {
      await bot.sendMessage(r.telegramChatId, text, { parse_mode: "MarkdownV2" });
    } catch (err: any) {
      logger.warn({ err: err?.message, chatId: r.telegramChatId }, "notifyEnrolledUsersNewTask: failed to send");
    }
  }
}

// ─── KYC: alert admins on submission, alert user on review decision ───────────

export async function notifyAdminsKycSubmitted(username: string): Promise<void> {
  if (!bot) return;
  const admins = await db
    .select({ telegramChatId: usersTable.telegramChatId })
    .from(usersTable)
    .where(and(eq(usersTable.role, "admin"), isNotNull(usersTable.telegramChatId)));

  const text = `🛂 *New KYC Submission*\n\nOperator *${md(username)}* submitted Level 1 KYC and is awaiting review\\.\n\nReview it in the Admin panel → KYC Approvals\\.`;

  for (const a of admins) {
    if (!a.telegramChatId) continue;
    try {
      await bot.sendMessage(a.telegramChatId, text, { parse_mode: "MarkdownV2" });
    } catch (err: any) {
      logger.warn({ err: err?.message, chatId: a.telegramChatId }, "notifyAdminsKycSubmitted: failed to send");
    }
  }
}

export async function notifyKycStatus(
  userId: number,
  approved: boolean,
  level: number,
  reason?: string | null
): Promise<void> {
  if (!bot) return;
  const rows = await db
    .select({ telegramChatId: usersTable.telegramChatId })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);
  const chatId = rows[0]?.telegramChatId;
  if (!chatId) return;

  const text = approved
    ? `✅ *KYC Approved\\!*\n\nYour Level ${level} KYC has been verified by an admin\\. Your account is now verified\\.`
    : `❌ *KYC Rejected*\n\nYour KYC submission was not approved\\.${reason ? `\n\n*Reason:* ${md(reason)}` : ""}\n\nUpdate your profile and resubmit\\.`;

  try {
    await bot.sendMessage(chatId, text, { parse_mode: "MarkdownV2" });
  } catch (err: any) {
    logger.warn({ err: err?.message, userId, chatId }, "notifyKycStatus: failed to send");
  }
}

// ─── Exported for route use ───────────────────────────────────────────────────

export async function verifyTelegramCode(
  code: string,
  userId: number
): Promise<boolean> {
  const chatId = pendingByCode.get(code);
  if (!chatId) return false;
  const pending = pendingLinks.get(chatId);
  if (!pending || pending.expires < Date.now() || pending.code !== code) {
    pendingByCode.delete(code);
    return false;
  }
  pendingLinks.delete(chatId);
  pendingByCode.delete(code);
  savePending(pendingLinks);
  let tgUsername: string | null = null;
  try {
    const chat = await bot?.getChat(chatId);
    tgUsername = (chat as any)?.username ?? null;
  } catch { /* ignore */ }
  await db
    .update(usersTable)
    .set({ telegramChatId: chatId, telegramUsername: tgUsername })
    .where(eq(usersTable.id, userId));
  if (bot) {
    try {
      await bot.sendMessage(chatId, `✅ *Account linked!*\n\nYour AYZEN account has been connected to this Telegram.`, { parse_mode: "Markdown" });
    } catch { /* ignore */ }
  }
  return true;
}

export function stopTelegramBot(): Promise<void> {
  if (!bot) return Promise.resolve();
  const b = bot;
  const wasWebhook = transportMode === "webhook";
  bot = null;
  transportMode = null;
  // Mirror image of each mode's startup: webhook mode tears down the
  // registration it made with Telegram; polling mode stops its long-lived
  // HTTP loop. Getting this wrong (e.g. stopPolling() in webhook mode)
  // is harmless but pointless — same reasoning either way stays correct.
  return wasWebhook ? b.deleteWebhook().catch(() => {}) : b.stopPolling().catch(() => {});
}

export function initTelegramBot(): void {
  if (!TOKEN) {
    logger.warn("TELEGRAM_BOT_TOKEN not set — Telegram bot disabled");
    return;
  }
  if (WEBHOOK_URL) {
    initWebhookMode();
    return;
  }
  initPollingMode();
}

// ─── Webhook mode ──────────────────────────────────────────────────────────────
function initWebhookMode(): void {
  if (!WEBHOOK_SECRET) {
    logger.error(
      "TELEGRAM_WEBHOOK_URL is set but TELEGRAM_WEBHOOK_SECRET is not — refusing to " +
      "start in webhook mode without a secret to verify inbound calls (anyone could " +
      "POST fake updates to the endpoint otherwise). Falling back to polling.",
    );
    initPollingMode();
    return;
  }

  // No `polling` or `webHook` option passed — the library only starts a
  // transport you explicitly ask for, so this constructs an otherwise-inert
  // bot instance. We run our own Express route (routes/telegram.ts's POST
  // /telegram/webhook) instead of the library's built-in webhook HTTP
  // server, so this app's existing security middleware/rate limiting/
  // logging applies to Telegram traffic the same as every other route.
  const b = new TelegramBot(TOKEN!);
  bot = b;
  transportMode = "webhook";
  registerHandlers(b);

  b.setWebhook(WEBHOOK_URL!, { secret_token: WEBHOOK_SECRET, drop_pending_updates: true })
    .then(() => {
      logger.info({ url: WEBHOOK_URL }, "Telegram bot started (webhook mode)");
      broadcastToAll(
        "🚀 *AYZEN is online!*\n\nThe Airdrop Command Center is up and running.\nUse /status to check platform health."
      ).catch(() => {});
    })
    .catch((err: any) => {
      logger.error({ err: err?.message }, "Failed to register Telegram webhook — bot will not receive updates");
    });
}

/**
 * Feeds a webhook-delivered update into the same handler pipeline polling
 * mode uses (onText/callback_query/message — registerHandlers() wires both
 * transports through the identical node-telegram-bot-api event emitters,
 * so nothing above this needs to know which transport is active).
 * Returns false without touching the bot if the secret doesn't match —
 * routes/telegram.ts turns that into a 401 and never calls processUpdate().
 */
export function handleWebhookUpdate(update: unknown, secretTokenHeader: string | undefined): boolean {
  if (!bot || transportMode !== "webhook") return false;
  if (!WEBHOOK_SECRET || secretTokenHeader !== WEBHOOK_SECRET) return false;
  bot.processUpdate(update as any);
  return true;
}

// ─── Polling mode (default — unchanged from before webhook mode existed) ──────
function initPollingMode(): void {
  // Create bot with autoStart:false so we can clear any previous session first
  const b = new TelegramBot(TOKEN!, {
    polling: { autoStart: false, params: { timeout: 2 } },
  });
  bot = b;
  transportMode = "polling";
  registerHandlers(b);

  // Delete any lingering webhook, wait 12s for Telegram to release the old
  // polling session, then start clean — prevents 409 on rapid restarts
  b.deleteWebhook({ drop_pending_updates: true })
    .catch(() => {})
    .then(() => new Promise<void>(resolve => setTimeout(resolve, 20000)))
    .then(() => b.startPolling())
    .then(() => {
      logger.info("Telegram bot started (polling mode)");
      broadcastToAll(
        "🚀 *AYZEN is online!*\n\nThe Airdrop Command Center is up and running.\nUse /status to check platform health."
      ).catch(() => {});
    })
    .catch((err: any) => {
      logger.error({ err: err?.message }, "Failed to start Telegram bot polling");
    });
}
