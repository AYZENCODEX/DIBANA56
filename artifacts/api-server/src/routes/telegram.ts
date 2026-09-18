import { Router } from "express";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { broadcastToAll, verifyTelegramCode, getBot, handleWebhookUpdate, getTelegramTransportMode } from "../lib/telegram";
import { requireAuth, requireAdmin, getRequestUser } from "../middlewares/auth";

const router = Router();

// POST /telegram/connect/verify — user submits the 6-digit code from the bot (chatId not needed)
router.post("/telegram/connect/verify", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }

  const { code } = req.body as { code?: string };
  if (!code) { res.status(400).json({ error: "code is required" }); return; }

  const ok = await verifyTelegramCode(code, authUser.userId);
  if (!ok) { res.status(400).json({ error: "Invalid or expired code — open the bot and send /connect for a new code" }); return; }

  res.json({ success: true, message: "Telegram account linked successfully" });
});

// GET /telegram/me — current user's link status
router.get("/telegram/me", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }

  const rows = await db
    .select({ telegramChatId: usersTable.telegramChatId, telegramUsername: usersTable.telegramUsername })
    .from(usersTable)
    .where(eq(usersTable.id, authUser.userId))
    .limit(1);
  const row = rows[0];
  res.json({
    linked: !!row?.telegramChatId,
    chatId: row?.telegramChatId ?? null,
    username: row?.telegramUsername ?? null,
  });
});

// DELETE /telegram/disconnect — unlink Telegram
router.delete("/telegram/disconnect", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }

  await db
    .update(usersTable)
    .set({ telegramChatId: null, telegramUsername: null })
    .where(eq(usersTable.id, authUser.userId));
  res.json({ success: true });
});

// POST /telegram/broadcast — admin: push message to all connected users
router.post("/telegram/broadcast", requireAdmin, async (req, res): Promise<void> => {

  const { message } = req.body as { message?: string };
  if (!message) { res.status(400).json({ error: "message is required" }); return; }

  const sent = await broadcastToAll(`📣 *AYZEN Broadcast*\n\n${message}`);
  res.json({ success: true, sent });
});

// POST /telegram/test — admin: send "AYZEN is working" test blast
router.post("/telegram/test", requireAdmin, async (req, res): Promise<void> => {

  const bot = getBot();
  if (!bot) {
    res.status(503).json({ error: "Telegram bot not configured — check TELEGRAM_BOT_TOKEN" });
    return;
  }

  const sent = await broadcastToAll(
    "✅ *AYZEN is working!*\n\nThe Airdrop Command Center is fully operational.\nAll systems are online. Ready to dominate every airdrop. 🚀"
  );
  res.json({ success: true, sent, message: "AYZEN is working" });
});

// GET /telegram/status — bot health check
router.get("/telegram/status", async (_req, res): Promise<void> => {
  const bot = getBot();
  if (!bot) {
    res.json({ online: false, reason: "TELEGRAM_BOT_TOKEN not configured" });
    return;
  }
  try {
    const info = await bot.getMe();
    res.json({ online: true, username: info.username, name: info.first_name, id: info.id, transport: getTelegramTransportMode() });
  } catch (err: any) {
    res.json({ online: false, reason: err?.message });
  }
});

// POST /telegram/webhook — Telegram calls this directly when the bot is
// running in webhook mode (TELEGRAM_WEBHOOK_URL set; see lib/telegram.ts).
// No AYZEN auth applies here — the caller is Telegram's servers, not a
// logged-in user — so this route is guarded instead by the `secret_token`
// Telegram echoes back on every call
// (https://core.telegram.org/bots/api#setwebhook), compared against
// TELEGRAM_WEBHOOK_SECRET inside handleWebhookUpdate(). A missing/wrong
// secret — or the bot simply not being in webhook mode — gets a 401
// without ever reaching bot.processUpdate(), so this can't be used as an
// open channel to inject fake Telegram events.
//
// Always acks fast once accepted: Telegram retries a webhook that doesn't
// get a timely 2xx, and processUpdate()'s own handlers (onText/
// callback_query, same ones polling mode uses) run through their usual
// async paths rather than being awaited here.
router.post("/telegram/webhook", (req, res): void => {
  const secretHeader = req.header("x-telegram-bot-api-secret-token");
  const accepted = handleWebhookUpdate(req.body, secretHeader);
  if (!accepted) { res.sendStatus(401); return; }
  res.sendStatus(200);
});

export default router;
