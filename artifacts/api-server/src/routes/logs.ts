import { Router } from "express";
import { logBus } from "../lib/log-bus";
import { requireAdmin } from "../middlewares/auth";

const router = Router();

// D5-follow-up (found during the same sweep that re-checked D4's
// plugins.ts fix): both routes below had no auth at all, same shape as
// the plugins.ts bug — no `:id`-shaped param, so the C33 lint never
// flagged them, and this file fell outside D4's 70-file scope entirely.
// Any unauthenticated caller could stream live server logs (GET) or wipe
// the log buffer (DELETE). `requireAdmin` added to both, matching every
// other `/admin/...` route in this codebase.
router.get("/admin/logs/stream", requireAdmin, (req, res): void => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const recent = logBus.recent(150);
  if (recent.length) {
    res.write(`data: ${JSON.stringify({ type: "history", entries: recent })}\n\n`);
  }

  const onLog = (entry: unknown) => {
    res.write(`data: ${JSON.stringify({ type: "entry", entry })}\n\n`);
  };

  logBus.on("log", onLog);

  const heartbeat = setInterval(() => {
    res.write(`: heartbeat\n\n`);
  }, 15000);

  req.on("close", () => {
    clearInterval(heartbeat);
    logBus.off("log", onLog);
  });
});

router.delete("/admin/logs", requireAdmin, (_req, res): void => {
  res.json({ ok: true });
});

export default router;
