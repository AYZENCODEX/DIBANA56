import { pgTable, serial, text, integer, real, boolean, timestamp } from "drizzle-orm/pg-core";

/**
 * uptime_pings
 * ─────────────────────────────────────────────────────────────────────────────
 * One row per keepalive/health check (see services/uptime-bot.ts). The bot
 * pings the server's own public URL every few minutes so free-tier hosts
 * (Render/Replit) that sleep on inbound-traffic inactivity never see a long
 * enough gap to spin the app down — and every ping's result is logged here
 * so the public status page (client/pages/status.tsx) can show live status +
 * 24h/7d/30d uptime % + a response-time history, without depending on a
 * third-party monitoring service.
 */
export const uptimePingsTable = pgTable("uptime_pings", {
  id: serial("id").primaryKey(),
  target: text("target").notNull().default("self"),
  isUp: boolean("is_up").notNull(),
  statusCode: integer("status_code"),
  latencyMs: real("latency_ms"),
  errorMessage: text("error_message"),
  checkedAt: timestamp("checked_at").notNull().defaultNow(),
});
