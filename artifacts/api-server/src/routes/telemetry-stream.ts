import { Router, Request, Response } from "express";
import { getActiveConnectionCount, getAllProjectPresence } from "./events";
import { requireAdmin } from "../middlewares/auth";

const router = Router();

let requestCount = 0;
let requestCountLastMin = 0;
let lastMinTime = Date.now();
const responseTimes: number[] = [];

export function recordRequest(ms: number) {
  requestCount++;
  responseTimes.push(ms);
  if (responseTimes.length > 500) responseTimes.shift();
  const now = Date.now();
  if (now - lastMinTime > 60000) {
    requestCountLastMin = requestCount;
    requestCount = 0;
    lastMinTime = now;
  }
}

// D5-follow-up (found during the same sweep that re-checked D4's
// plugins.ts fix): same shape as that bug — no `:id`-shaped param, so
// the C33 lint never flagged it, and this file was outside D4's scope.
// Any unauthenticated caller could read live memory/request-rate/
// connection-count telemetry. `requireAdmin` added, matching every
// other `/admin/...` route in this codebase.
router.get("/admin/telemetry/stream", requireAdmin, (req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const startTime = process.hrtime.bigint();

  const push = () => {
    const mem = process.memoryUsage();
    const uptimeSec = process.uptime();
    const avgMs = responseTimes.length > 0
      ? Math.round(responseTimes.slice(-50).reduce((a, b) => a + b, 0) / Math.min(responseTimes.length, 50))
      : 0;
    const p95 = responseTimes.length > 5
      ? [...responseTimes].sort((a, b) => a - b)[Math.floor(responseTimes.length * 0.95)]
      : 0;

    const payload = {
      ts: Date.now(),
      connections: getActiveConnectionCount(),
      requestsPerMin: requestCount + requestCountLastMin,
      totalRequests: requestCount,
      avgResponseMs: avgMs,
      p95ResponseMs: p95,
      memRss: Math.round(mem.rss / 1024 / 1024),
      memHeap: Math.round(mem.heapUsed / 1024 / 1024),
      memHeapTotal: Math.round(mem.heapTotal / 1024 / 1024),
      uptimeSec: Math.round(uptimeSec),
      projectPresence: getAllProjectPresence(),
      nodeVersion: process.version,
      platform: process.platform,
    };
    try {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    } catch { clearInterval(interval); }
  };

  push();
  const interval = setInterval(push, 2000);

  req.on("close", () => clearInterval(interval));
});

export default router;
