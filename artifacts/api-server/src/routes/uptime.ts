import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const router: IRouter = Router();

function pct(up: number, total: number): number {
  return total > 0 ? Math.round((up / total) * 10000) / 100 : 100;
}

// ─── GET /uptime/status — public, no auth. Powers the status page. ───────────
router.get("/uptime/status", async (_req, res): Promise<void> => {
  try {
    const latestRows = await db.execute(
      sql`SELECT is_up, status_code, latency_ms, checked_at FROM uptime_pings ORDER BY checked_at DESC LIMIT 1`,
    );
    const latest = latestRows.rows[0] as any | undefined;

    const windowRows = await db.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE checked_at > NOW() - INTERVAL '24 hours')                as total_24h,
        COUNT(*) FILTER (WHERE checked_at > NOW() - INTERVAL '24 hours' AND is_up)       as up_24h,
        COUNT(*) FILTER (WHERE checked_at > NOW() - INTERVAL '7 days')                   as total_7d,
        COUNT(*) FILTER (WHERE checked_at > NOW() - INTERVAL '7 days' AND is_up)         as up_7d,
        COUNT(*) FILTER (WHERE checked_at > NOW() - INTERVAL '30 days')                  as total_30d,
        COUNT(*) FILTER (WHERE checked_at > NOW() - INTERVAL '30 days' AND is_up)        as up_30d,
        AVG(latency_ms) FILTER (WHERE checked_at > NOW() - INTERVAL '24 hours')          as avg_latency_24h
      FROM uptime_pings
    `);
    const w = (windowRows.rows[0] ?? {}) as any;

    const historyRows = await db.execute(sql`
      SELECT checked_at, is_up, status_code, latency_ms
      FROM uptime_pings
      ORDER BY checked_at DESC
      LIMIT 200
    `);
    const history = (historyRows.rows as any[])
      .reverse()
      .map(r => ({
        checkedAt: r.checked_at,
        isUp: r.is_up,
        statusCode: r.status_code,
        latencyMs: r.latency_ms !== null ? Number(r.latency_ms) : null,
      }));

    res.json({
      current: latest
        ? {
            isUp: latest.is_up,
            statusCode: latest.status_code,
            latencyMs: latest.latency_ms !== null ? Number(latest.latency_ms) : null,
            checkedAt: latest.checked_at,
          }
        : null,
      uptimePct: {
        "24h": pct(Number(w.up_24h ?? 0), Number(w.total_24h ?? 0)),
        "7d": pct(Number(w.up_7d ?? 0), Number(w.total_7d ?? 0)),
        "30d": pct(Number(w.up_30d ?? 0), Number(w.total_30d ?? 0)),
      },
      avgLatencyMs24h: w.avg_latency_24h !== null && w.avg_latency_24h !== undefined ? Math.round(Number(w.avg_latency_24h)) : null,
      history,
    });
  } catch (err: any) {
    // Table may not exist yet on a brand-new DB mid-migration — respond with an
    // empty-but-valid shape instead of a 500 so the status page still renders.
    res.json({
      current: null,
      uptimePct: { "24h": 100, "7d": 100, "30d": 100 },
      avgLatencyMs24h: null,
      history: [],
    });
  }
});

export default router;
