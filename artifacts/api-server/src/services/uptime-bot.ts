import { db, uptimePingsTable } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logBus } from "../lib/log-bus";
import { logger } from "../lib/logger";

/**
 * Uptime bot — keeps the free-tier host (Render/Replit) awake and feeds the
 * public status page (client/pages/status.tsx).
 *
 * Free tiers sleep after a stretch of *inbound* inactivity. A ping that never
 * leaves the process (e.g. straight to localhost) doesn't count as inbound
 * traffic, so this deliberately goes out over the public internet to the
 * app's own external URL and back in through the platform's reverse proxy —
 * the same path a real visitor's request takes.
 *
 * Public URL resolution order:
 *   1. AYZEN_PUBLIC_URL       — set this explicitly for the most reliable behavior
 *   2. RENDER_EXTERNAL_URL    — Render sets this automatically
 *   3. (unset) — falls back to localhost so the status page still gets data,
 *      but this does NOT prevent the host from sleeping; a warning is logged
 *      once at startup so it's easy to notice and fix via env var.
 */
function resolvePublicUrl(port: number): { url: string; isExternal: boolean } {
  const explicit = process.env["AYZEN_PUBLIC_URL"]?.replace(/\/$/, "");
  if (explicit) return { url: explicit, isExternal: true };

  const renderUrl = process.env["RENDER_EXTERNAL_URL"]?.replace(/\/$/, "");
  if (renderUrl) return { url: renderUrl, isExternal: true };

  return { url: `http://localhost:${port}`, isExternal: false };
}

const PING_INTERVAL_MS = 4 * 60 * 1000; // 4 min — comfortably under typical ~15min sleep thresholds
const PING_TIMEOUT_MS = 10 * 1000;
const RETENTION_DAYS = 30;

let warnedAboutLocalFallback = false;

async function pingOnce(port: number): Promise<void> {
  const { url, isExternal } = resolvePublicUrl(port);
  if (!isExternal && !warnedAboutLocalFallback) {
    warnedAboutLocalFallback = true;
    logBus.warn(
      "Uptime bot: no AYZEN_PUBLIC_URL/RENDER_EXTERNAL_URL set — pinging localhost. " +
      "This keeps the status page populated but will NOT prevent the host from sleeping. " +
      "Set AYZEN_PUBLIC_URL to this app's public address to fix.",
    );
  }

  const target = `${url}/api/healthz`;
  const start = Date.now();
  let isUp = false;
  let statusCode: number | null = null;
  let errorMessage: string | null = null;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PING_TIMEOUT_MS);
    const res = await fetch(target, { signal: controller.signal });
    clearTimeout(timeout);
    statusCode = res.status;
    isUp = res.ok;
    if (!res.ok) errorMessage = `HTTP ${res.status}`;
  } catch (err: any) {
    errorMessage = err?.name === "AbortError" ? "Timed out" : (err?.message ?? "Unknown error");
  }

  const latencyMs = Date.now() - start;

  try {
    await db.insert(uptimePingsTable).values({
      target: "self",
      isUp,
      statusCode,
      latencyMs,
      errorMessage,
    });
  } catch (err: any) {
    logger.warn({ err }, "Uptime bot: failed to record ping (table may not exist yet)");
  }

  if (!isUp) {
    logBus.warn(`Uptime bot: self-ping failed (${errorMessage ?? "unknown"}, ${latencyMs}ms)`);
  }
}

async function purgeOldPings(): Promise<void> {
  try {
    // RETENTION_DAYS is a fixed constant, not user input — safe to inline.
    await db.execute(sql.raw(`DELETE FROM uptime_pings WHERE checked_at < NOW() - INTERVAL '${RETENTION_DAYS} days'`));
  } catch (err: any) {
    logger.warn({ err }, "Uptime bot: retention purge failed");
  }
}

export function startUptimeBot(port: number): void {
  // First ping shortly after boot (give the DB/migrations a moment), then on
  // a fixed interval for the life of the process.
  setTimeout(() => pingOnce(port), 15_000);
  setInterval(() => pingOnce(port), PING_INTERVAL_MS);

  // Trim old rows daily so uptime_pings doesn't grow unbounded.
  setTimeout(purgeOldPings, 30_000);
  setInterval(purgeOldPings, 24 * 60 * 60 * 1000);
}
