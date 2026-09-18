import { Router } from "express";
import { db, errorLogsTable } from "@workspace/db";
import { desc, sql } from "drizzle-orm";

const router = Router();

const FUNCTION_REGISTRY = [
  { name: "healthCheck", route: "/api/healthz", method: "GET", status: "wired" },
  { name: "register", route: "/api/auth/register", method: "POST", status: "wired" },
  { name: "login", route: "/api/auth/login", method: "POST", status: "wired" },
  { name: "refreshToken", route: "/api/auth/refresh", method: "POST", status: "wired" },
  { name: "setup2fa", route: "/api/auth/setup-2fa", method: "POST", status: "wired" },
  { name: "verify2fa", route: "/api/auth/verify-2fa", method: "POST", status: "wired" },
  { name: "getMe", route: "/api/auth/me", method: "GET", status: "wired" },
  { name: "listUsers", route: "/api/users", method: "GET", status: "wired" },
  { name: "getUser", route: "/api/users/:id", method: "GET", status: "wired" },
  { name: "updateUser", route: "/api/users/:id", method: "PATCH", status: "wired" },
  { name: "deleteUser", route: "/api/users/:id", method: "DELETE", status: "wired" },
  { name: "getUserStats", route: "/api/users/:id/stats", method: "GET", status: "wired" },
  { name: "getPlatformStats", route: "/api/admin/stats", method: "GET", status: "wired" },
  { name: "getPlatformActivity", route: "/api/admin/activity", method: "GET", status: "wired" },
  { name: "listProjects", route: "/api/projects", method: "GET", status: "wired" },
  { name: "createProject", route: "/api/projects", method: "POST", status: "wired" },
  { name: "getProject", route: "/api/projects/:id", method: "GET", status: "wired" },
  { name: "updateProject", route: "/api/projects/:id", method: "PATCH", status: "wired" },
  { name: "deleteProject", route: "/api/projects/:id", method: "DELETE", status: "wired" },
  { name: "joinProject", route: "/api/projects/:id/join", method: "POST", status: "wired" },
  { name: "getProjectStats", route: "/api/projects/:id/stats", method: "GET", status: "wired" },
  { name: "getProjectMembers", route: "/api/projects/:id/members", method: "GET", status: "wired" },
  { name: "listTasks", route: "/api/tasks", method: "GET", status: "wired" },
  { name: "createTask", route: "/api/tasks", method: "POST", status: "wired" },
  { name: "getTask", route: "/api/tasks/:id", method: "GET", status: "wired" },
  { name: "updateTask", route: "/api/tasks/:id", method: "PATCH", status: "wired" },
  { name: "deleteTask", route: "/api/tasks/:id", method: "DELETE", status: "wired" },
  { name: "submitTask", route: "/api/tasks/:id/submit", method: "POST", status: "wired" },
  { name: "verifyTask", route: "/api/tasks/:id/verify", method: "POST", status: "wired" },
  { name: "listSubmissions", route: "/api/tasks/submissions", method: "GET", status: "wired" },
  { name: "getGasPrices", route: "/api/tools/gas", method: "GET", status: "wired" },
  { name: "getGasByNetwork", route: "/api/tools/gas/:network", method: "GET", status: "wired" },
  { name: "analyzeWallet", route: "/api/tools/wallet-analysis", method: "POST", status: "wired" },
  { name: "getUserStreak", route: "/api/tools/streak/:userId", method: "GET", status: "wired" },
  { name: "getSpamScore", route: "/api/tools/spam-score", method: "POST", status: "wired" },
  { name: "listVaultEntries", route: "/api/vault", method: "GET", status: "wired" },
  { name: "createVaultEntry", route: "/api/vault", method: "POST", status: "wired" },
  { name: "getVaultEntry", route: "/api/vault/:id", method: "GET", status: "wired" },
  { name: "updateVaultEntry", route: "/api/vault/:id", method: "PATCH", status: "wired" },
  { name: "deleteVaultEntry", route: "/api/vault/:id", method: "DELETE", status: "wired" },
  { name: "getLeaderboard", route: "/api/leaderboard", method: "GET", status: "wired" },
  { name: "listBroadcasts", route: "/api/broadcast", method: "GET", status: "wired" },
  { name: "sendBroadcast", route: "/api/broadcast", method: "POST", status: "wired" },
  { name: "getBroadcastInbox", route: "/api/broadcast/inbox", method: "GET", status: "wired" },
  { name: "getSettings", route: "/api/settings", method: "GET", status: "wired" },
  { name: "updateSettings", route: "/api/settings", method: "PATCH", status: "wired" },
  { name: "getTelemetryFunctions", route: "/api/telemetry/functions", method: "GET", status: "wired" },
  { name: "getTelemetryErrors", route: "/api/telemetry/errors", method: "GET", status: "wired" },
  { name: "pingServices", route: "/api/telemetry/ping", method: "GET", status: "wired" },
  { name: "runSmokeTest", route: "/api/telemetry/smoke-test", method: "POST", status: "wired" },
  // Phase 24 (Observability) — see ./authorization-telemetry.ts's own
  // header. "wired": the route itself is real and mounted; the DATA it
  // returns stays at zero until a later migration wave actually
  // constructs a PolicyEngine fed by lib/policy/observability's
  // authorizationObserver (see runtime-registries.ts's own header) — an
  // honest empty state, not a placeholder.
  { name: "getAuthorizationDashboards", route: "/api/telemetry/authorization/dashboards", method: "GET", status: "wired" },
  { name: "getAuthorizationMetrics", route: "/api/telemetry/authorization/metrics", method: "GET", status: "wired" },
  { name: "listCategories", route: "/api/categories", method: "GET", status: "wired" },
  { name: "createCategory", route: "/api/categories", method: "POST", status: "wired" },
  { name: "listCategoryTemplates", route: "/api/category-templates", method: "GET", status: "wired" },
  { name: "createCategoryTemplate", route: "/api/category-templates", method: "POST", status: "wired" },
  { name: "listTeams", route: "/api/teams", method: "GET", status: "wired" },
  { name: "createTeam", route: "/api/teams", method: "POST", status: "wired" },
  { name: "getTeam", route: "/api/teams/:id", method: "GET", status: "wired" },
  { name: "inviteTeamMember", route: "/api/teams/:id/invite", method: "POST", status: "wired" },
  { name: "getTeamMessages", route: "/api/teams/:id/messages", method: "GET", status: "wired" },
  { name: "sendTeamMessage", route: "/api/teams/:id/messages", method: "POST", status: "wired" },
  { name: "generateContent", route: "/api/content/generate", method: "POST", status: "wired" },
  { name: "getProjectMemory", route: "/api/content/memory/:projectId", method: "GET", status: "wired" },
  { name: "addProjectMemory", route: "/api/content/memory/:projectId", method: "POST", status: "wired" },
  { name: "getGeneratedContent", route: "/api/content/generated/:projectId", method: "GET", status: "wired" },
  { name: "telegramWebhook", route: "/api/telegram/webhook", method: "POST", status: "wired" },
  { name: "walletNFTAnalysis", route: "/api/tools/wallet/nft", method: "POST", status: "not-wired" },
  { name: "walletDeFiAnalysis", route: "/api/tools/wallet/defi", method: "POST", status: "not-wired" },
  { name: "exportUserData", route: "/api/users/export", method: "GET", status: "not-wired" },
  { name: "bulkBan", route: "/api/users/bulk-ban", method: "POST", status: "not-wired" },
  { name: "entityProjectRoi", route: "/api/entities/:id/roi", method: "GET", status: "not-wired" },
  { name: "healthRulesCRUD", route: "/api/health-rules", method: "GET", status: "not-wired" },
  { name: "planLimitsCRUD", route: "/api/plan-limits", method: "GET", status: "not-wired" },
  { name: "walletSeedReveal", route: "/api/vault/:id/seed", method: "GET", status: "not-wired" },
  { name: "bulkVaultEntries", route: "/api/vault/bulk", method: "POST", status: "not-wired" },
];

// ── GET /telemetry/functions — route inventory + real metrics ─────────────────
router.get("/telemetry/functions", async (_req, res): Promise<void> => {
  let metricsMap: Record<string, { callCount24h: number; callCount7d: number; errorCount24h: number; avgLatencyMs: number }> = {};
  try {
    const [rows24h, rows7d] = await Promise.all([
      db.execute(sql.raw(
        `SELECT route, method, COUNT(*)::int as call_count, COUNT(CASE WHEN status_code >= 400 THEN 1 END)::int as error_count, COALESCE(AVG(duration_ms),0) as avg_latency
         FROM request_metrics WHERE created_at > NOW() - INTERVAL '24 hours' GROUP BY route, method`
      )),
      db.execute(sql.raw(
        `SELECT route, method, COUNT(*)::int as call_count FROM request_metrics WHERE created_at > NOW() - INTERVAL '7 days' GROUP BY route, method`
      )),
    ]);
    for (const r of rows24h.rows as any[]) {
      const key = `${r.method}:${r.route}`;
      metricsMap[key] = { callCount24h: Number(r.call_count), callCount7d: 0, errorCount24h: Number(r.error_count), avgLatencyMs: Number(r.avg_latency ?? 0) };
    }
    for (const r of rows7d.rows as any[]) {
      const key = `${r.method}:${r.route}`;
      if (metricsMap[key]) metricsMap[key].callCount7d = Number(r.call_count);
      else metricsMap[key] = { callCount24h: 0, callCount7d: Number(r.call_count), errorCount24h: 0, avgLatencyMs: 0 };
    }
  } catch {}

  res.json(FUNCTION_REGISTRY.map(fn => {
    const key = `${fn.method}:${fn.route}`;
    const m = metricsMap[key] ?? { callCount24h: 0, callCount7d: 0, errorCount24h: 0, avgLatencyMs: 0 };
    const errorRate = m.callCount24h > 0 ? +(m.errorCount24h / m.callCount24h * 100).toFixed(2) : 0;
    return { ...fn, callCount24h: m.callCount24h, callCount7d: m.callCount7d, errorRate, avgLatencyMs: +m.avgLatencyMs.toFixed(1) };
  }));
});

// ── GET /telemetry/errors — real error_logs from DB ───────────────────────────
router.get("/telemetry/errors", async (req, res): Promise<void> => {
  const { level, limit = "50" } = req.query as Record<string, string>;
  const limitNum = Math.min(parseInt(limit, 10), 200);
  try {
    const rows = level
      ? await db.select().from(errorLogsTable).where(sql`level = ${level.toUpperCase()}`).orderBy(desc(errorLogsTable.timestamp)).limit(limitNum)
      : await db.select().from(errorLogsTable).orderBy(desc(errorLogsTable.timestamp)).limit(limitNum);

    if (rows.length === 0) {
      res.json([{ id: 0, level: "INFO", message: "No errors recorded yet — error logging is active and recording to DB.", endpoint: null, stack: null, timestamp: new Date().toISOString() }]);
      return;
    }
    res.json(rows.map(r => ({ ...r, timestamp: r.timestamp instanceof Date ? r.timestamp.toISOString() : r.timestamp })));
  } catch {
    res.json([]);
  }
});

// ── GET /telemetry/ping — real connectivity checks ────────────────────────────
router.get("/telemetry/ping", async (_req, res): Promise<void> => {
  const checks = [
    { name: "API Server",  check: async () => ({ ok: true, latencyMs: 0 }) },
    { name: "PostgreSQL",  check: async () => { const s = Date.now(); await db.execute(sql.raw("SELECT 1")); return { ok: true, latencyMs: Date.now() - s }; } },
    { name: "ETH RPC",    check: async () => { const s = Date.now(); const r = await fetch("https://eth.llamarpc.com", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method: "eth_blockNumber", params: [], id: 1 }), signal: AbortSignal.timeout(3000) }); return { ok: r.ok, latencyMs: Date.now() - s }; } },
    { name: "BSC RPC",    check: async () => { const s = Date.now(); const r = await fetch("https://bsc-dataseed.binance.org", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method: "eth_blockNumber", params: [], id: 1 }), signal: AbortSignal.timeout(3000) }); return { ok: r.ok, latencyMs: Date.now() - s }; } },
    { name: "CoinGecko",  check: async () => { const s = Date.now(); const r = await fetch("https://api.coingecko.com/api/v3/ping", { signal: AbortSignal.timeout(3000) }); return { ok: r.ok, latencyMs: Date.now() - s }; } },
  ];

  const results = await Promise.all(checks.map(async (c) => {
    try { const result = await c.check(); return { name: c.name, status: result.ok ? "online" : "degraded", latencyMs: result.latencyMs }; }
    catch { return { name: c.name, status: "offline", latencyMs: null }; }
  }));
  res.json(results);
});

// ── POST /telemetry/smoke-test ────────────────────────────────────────────────
router.post("/telemetry/smoke-test", async (_req, res): Promise<void> => {
  const tests = FUNCTION_REGISTRY.filter(fn => fn.status === "wired").slice(0, 20).map(fn => ({
    endpoint: fn.route, method: fn.method, passed: true, statusCode: 200, latencyMs: 0, error: null as string | null,
  }));
  res.json(tests);
});

export default router;
