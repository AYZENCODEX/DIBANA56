/**
 * routes/compliance-report.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Feature 14 — Compliance Audit Report Export.
 *
 * Generates a date-ranged activity report from the same two audit trails
 * already maintained elsewhere in the app:
 *   - user_activity      (routes/history.ts's general account/task/vault log)
 *   - vault_activity_log (routes/vault.ts's per-entity Vault audit trail)
 * merged into one chronological timeline and rendered as CSV or PDF.
 *
 * GET /compliance/report?from=YYYY-MM-DD&to=YYYY-MM-DD&format=csv|pdf — the
 * caller's own activity. GET /admin/compliance/report adds an optional
 * userId query param (any user) for admin-side audits.
 *
 * PDF rendering uses pdfkit (streamed directly to the response, no temp
 * file) — a plain, readable table, not a styled brand document; this is a
 * compliance artifact, not marketing collateral.
 */
import { Router } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { requireAuth, requireAdmin, getRequestUserId } from "../middlewares/auth";
import { toCsv } from "../lib/csv";
import PDFDocument from "pdfkit";

const router = Router();

const MAX_RANGE_DAYS = 366;
const MAX_ROWS = 20000;

interface ReportRow {
  occurredAt: Date;
  source: "account" | "vault";
  action: string;
  detail: string;
}

function parseDateRange(fromRaw: unknown, toRaw: unknown): { from: Date; to: Date } | { error: string } {
  const from = fromRaw ? new Date(String(fromRaw)) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const to = toRaw ? new Date(String(toRaw)) : new Date();
  if (isNaN(from.getTime()) || isNaN(to.getTime())) return { error: "Invalid from/to date" };
  if (from > to) return { error: "from must be before to" };
  if ((to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000) > MAX_RANGE_DAYS) {
    return { error: "Date range too large (max 366 days)" };
  }
  return { from, to };
}

async function fetchReportRows(userId: number, from: Date, to: Date): Promise<ReportRow[]> {
  const [userActivity, vaultActivity] = await Promise.all([
    db.execute(sql`
      SELECT created_at, action, entity_type, entity_name, meta
      FROM user_activity
      WHERE user_id = ${userId} AND created_at BETWEEN ${from} AND ${to}
      ORDER BY created_at ASC LIMIT ${MAX_ROWS}
    `),
    db.execute(sql`
      SELECT created_at, action, detail, vault_entry_id
      FROM vault_activity_log
      WHERE user_id = ${userId} AND created_at BETWEEN ${from} AND ${to}
      ORDER BY created_at ASC LIMIT ${MAX_ROWS}
    `),
  ]);

  const rows: ReportRow[] = [];
  for (const r of userActivity.rows as any[]) {
    rows.push({
      occurredAt: new Date(r.created_at),
      source: "account",
      action: r.action,
      detail: [r.entity_type, r.entity_name].filter(Boolean).join(": ") || (r.meta ?? ""),
    });
  }
  for (const r of vaultActivity.rows as any[]) {
    rows.push({
      occurredAt: new Date(r.created_at),
      source: "vault",
      action: r.action,
      detail: `entity #${r.vault_entry_id}${r.detail ? " — " + r.detail : ""}`,
    });
  }
  rows.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  return rows.slice(0, MAX_ROWS);
}

function renderCsv(rows: ReportRow[]): string {
  return toCsv(
    rows.map(r => ({ timestamp: r.occurredAt.toISOString(), source: r.source, action: r.action, detail: r.detail })),
    ["timestamp", "source", "action", "detail"],
  );
}

function renderPdf(res: any, rows: ReportRow[], title: string, from: Date, to: Date): void {
  const doc = new PDFDocument({ margin: 40, size: "A4" });
  doc.pipe(res);

  doc.fontSize(16).text(title, { align: "left" });
  doc.fontSize(10).fillColor("#555").text(`Range: ${from.toISOString().slice(0, 10)} to ${to.toISOString().slice(0, 10)}`);
  doc.text(`Generated: ${new Date().toISOString()}`);
  doc.text(`Total events: ${rows.length}`);
  doc.moveDown(1);
  doc.fillColor("#000");

  const colX = { time: 40, source: 175, action: 240, detail: 360 };
  doc.fontSize(9).font("Helvetica-Bold");
  doc.text("Timestamp", colX.time, doc.y, { continued: false });
  doc.text("Source", colX.source, doc.y - doc.currentLineHeight());
  doc.text("Action", colX.action, doc.y - doc.currentLineHeight());
  doc.text("Detail", colX.detail, doc.y - doc.currentLineHeight());
  doc.moveDown(0.5);
  doc.font("Helvetica");

  for (const row of rows) {
    if (doc.y > 760) doc.addPage();
    const y = doc.y;
    doc.fontSize(8);
    doc.text(row.occurredAt.toISOString().replace("T", " ").slice(0, 19), colX.time, y, { width: 130 });
    doc.text(row.source, colX.source, y, { width: 60 });
    doc.text(row.action, colX.action, y, { width: 115 });
    doc.text(row.detail.slice(0, 90), colX.detail, y, { width: 190 });
    doc.moveDown(0.6);
  }

  doc.end();
}

async function handleReport(userId: number, req: any, res: any): Promise<void> {
  const range = parseDateRange(req.query.from, req.query.to);
  if ("error" in range) { res.status(400).json({ error: range.error }); return; }

  const format = String(req.query.format ?? "csv").toLowerCase();
  if (format !== "csv" && format !== "pdf") {
    res.status(400).json({ error: "Invalid format", solution: "format must be \"csv\" or \"pdf\"." });
    return;
  }

  const rows = await fetchReportRows(userId, range.from, range.to);
  const stamp = `${range.from.toISOString().slice(0, 10)}_to_${range.to.toISOString().slice(0, 10)}`;

  if (format === "csv") {
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="ayzen-compliance-report-${stamp}.csv"`);
    res.send(renderCsv(rows));
    return;
  }

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="ayzen-compliance-report-${stamp}.pdf"`);
  renderPdf(res, rows, "AYZEN Compliance Audit Report", range.from, range.to);
}

// ─── Self-service — the caller's own activity ───────────────────────────────
router.get("/compliance/report", requireAuth, async (req, res): Promise<void> => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }
  await handleReport(userId, req, res);
});

// ─── Admin — any user's activity ────────────────────────────────────────────
router.get("/admin/compliance/report", requireAdmin, async (req, res): Promise<void> => {
  const targetUserId = parseInt(String(req.query.userId ?? ""), 10);
  if (!Number.isFinite(targetUserId)) {
    res.status(400).json({ error: "userId query param is required for the admin report" });
    return;
  }
  await handleReport(targetUserId, req, res);
});

export default router;
