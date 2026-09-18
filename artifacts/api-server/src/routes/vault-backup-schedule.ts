/**
 * routes/vault-backup-schedule.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Feature 15c — Automatic Vault Backups.
 *
 * Config endpoints for the per-user vault_backup_schedules row (see
 * lib/db/src/schema/vault-backup-schedules.ts) that
 * lib/vault-backup-schedule-cron.ts sweeps on a timer, plus a manual
 * "Run Now" trigger and a small delivery-history list
 * (vault_backup_deliveries) for the Automatic Backups card on the Snapshot
 * Backup page.
 */
import { Router } from "express";
import express from "express";
import crypto from "crypto";
import { db, vaultBackupSchedulesTable, vaultBackupDeliveriesTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import { requireAuth, getRequestUserId } from "../middlewares/auth";
import { sensitiveWriteLimiter } from "../middlewares/security";
import { computeNextRunAt, runVaultBackupSchedule } from "../lib/vault-backup-schedule-cron";
import { assertPublicHttpsUrl } from "../lib/ssrf-guard";
import { logBackupAudit, redactUrl, listOwnBackupAuditLog } from "../lib/vault-backup-audit";

const router = Router();

const FREQUENCIES = ["daily", "weekly", "monthly"] as const;
// Feature 15l: "google_drive"/"dropbox" require a connection already made
// via routes/vault-backup-cloud.ts — checked at run time (cron/"Run Now"),
// not here, so saving the schedule config never depends on connect order.
const DESTINATIONS = ["store", "email", "webhook", "google_drive", "dropbox"] as const;

// ─── GET /vault/backup/schedule ─────────────────────────────────────────────
// Returns the caller's schedule config, or sane defaults (enabled: false) if
// they've never configured one — the frontend renders the same form either way.
router.get("/vault/backup/schedule", requireAuth, async (req, res): Promise<void> => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }

  const [row] = await db.select().from(vaultBackupSchedulesTable).where(eq(vaultBackupSchedulesTable.userId, userId));
  if (!row) {
    res.json({
      enabled: false, frequency: "weekly", dayOfWeek: 0, dayOfMonth: 1, hourOfDay: 3,
      includeAttachments: false, destination: "store", destinationEmail: null, webhookUrl: null,
      lastRunAt: null, lastRunStatus: null, lastRunError: null, nextRunAt: null,
    });
    return;
  }
  const { webhookSecret, ...safe } = row;
  res.json({ ...safe, hasWebhookSecret: !!webhookSecret });
});

// ─── PUT /vault/backup/schedule ─────────────────────────────────────────────
// Upserts the caller's schedule config. Recomputes nextRunAt whenever the
// timing fields change or the schedule transitions enabled: false -> true.
router.put("/vault/backup/schedule", requireAuth, express.json(), sensitiveWriteLimiter, async (req, res): Promise<void> => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }

  const body = req.body ?? {};
  const enabled = !!body.enabled;
  const frequency = FREQUENCIES.includes(body.frequency) ? body.frequency : "weekly";
  const dayOfWeek = Number.isInteger(body.dayOfWeek) ? Math.min(Math.max(body.dayOfWeek, 0), 6) : 0;
  const dayOfMonth = Number.isInteger(body.dayOfMonth) ? Math.min(Math.max(body.dayOfMonth, 1), 28) : 1;
  const hourOfDay = Number.isInteger(body.hourOfDay) ? Math.min(Math.max(body.hourOfDay, 0), 23) : 3;
  const includeAttachments = !!body.includeAttachments;
  const destination = DESTINATIONS.includes(body.destination) ? body.destination : "store";
  const destinationEmail = typeof body.destinationEmail === "string" && body.destinationEmail.trim() ? body.destinationEmail.trim() : null;
  const webhookUrl = typeof body.webhookUrl === "string" && body.webhookUrl.trim() ? body.webhookUrl.trim() : null;

  // Vault Backup hardening, Round 5 — SSRF guard (see lib/ssrf-guard.ts). A
  // webhook URL is checked here for immediate feedback, and — the check
  // that actually matters — again by lib/vault-backup-delivery.ts right
  // before every scheduled send, since DNS can change after this save.
  if (destination === "webhook" && webhookUrl) {
    try {
      await assertPublicHttpsUrl(webhookUrl);
    } catch (err: any) {
      res.status(400).json({ error: err?.message ?? "webhookUrl isn't allowed" });
      return;
    }
  }
  if (destination === "email" && destinationEmail && !/.+@.+\..+/.test(destinationEmail)) {
    res.status(400).json({ error: "destinationEmail doesn't look like a valid email address" });
    return;
  }

  const [existing] = await db.select().from(vaultBackupSchedulesTable).where(eq(vaultBackupSchedulesTable.userId, userId));

  // Keep the existing webhook secret unless the caller is (re)configuring a
  // webhook destination for the first time — generated once, never shown
  // back in full (see GET's hasWebhookSecret flag instead).
  let webhookSecret = existing?.webhookSecret ?? null;
  if (destination === "webhook" && !webhookSecret) {
    webhookSecret = crypto.randomBytes(24).toString("hex");
  }

  const timingChanged = !existing
    || existing.frequency !== frequency || existing.dayOfWeek !== dayOfWeek
    || existing.dayOfMonth !== dayOfMonth || existing.hourOfDay !== hourOfDay
    || (!existing.enabled && enabled);
  const nextRunAt = enabled ? (timingChanged ? computeNextRunAt({ frequency, dayOfWeek, dayOfMonth, hourOfDay }, new Date()) : existing?.nextRunAt) : null;

  const values = {
    userId, enabled, frequency, dayOfWeek, dayOfMonth, hourOfDay, includeAttachments,
    destination, destinationEmail, webhookUrl, webhookSecret, nextRunAt, updatedAt: new Date(),
  };

  if (existing) {
    await db.update(vaultBackupSchedulesTable).set(values).where(eq(vaultBackupSchedulesTable.id, existing.id));
  } else {
    await db.insert(vaultBackupSchedulesTable).values(values as any);
  }

  // Vault Backup hardening, Round 6 — a schedule's off-vault destination is
  // the exact surface Round 5's SSRF guard protects; log every time it
  // changes so an incident (or an audit) can see who pointed a schedule at
  // what, and when, without needing to diff DB snapshots. URL is redacted
  // (host+path only, see redactUrl()) — a webhook URL can carry an auth
  // token in its query string, which never belongs in a log.
  const destinationChanged = !existing || existing.destination !== destination;
  const webhookChanged = destination === "webhook" && (!existing || existing.webhookUrl !== webhookUrl);
  if (destinationChanged) {
    await logBackupAudit({
      ownerUserId: userId, eventType: "schedule_destination_changed", req,
      detail: { from: existing?.destination ?? null, to: destination },
    });
  }
  if (webhookChanged) {
    await logBackupAudit({
      ownerUserId: userId, eventType: "schedule_webhook_changed", req,
      detail: { webhookUrl: redactUrl(webhookUrl) },
    });
  }

  res.json({ ok: true, nextRunAt });
});

// ─── POST /vault/backup/schedule/run-now ───────────────────────────────────
// Runs the caller's configured schedule immediately (must already have one
// saved, though it doesn't need to be `enabled`) — handy for testing a
// destination (email/webhook) works before trusting it to the timer.
router.post("/vault/backup/schedule/run-now", requireAuth, sensitiveWriteLimiter, async (req, res): Promise<void> => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }

  const [row] = await db.select().from(vaultBackupSchedulesTable).where(eq(vaultBackupSchedulesTable.userId, userId));
  if (!row) { res.status(404).json({ error: "No backup schedule configured yet — set one up first." }); return; }

  const result = await runVaultBackupSchedule(row);
  if (!result.ok) { res.status(502).json({ ok: false, error: result.error }); return; }
  res.json({ ok: true, snapshotId: result.snapshotId });
});

// ─── GET /vault/backup/deliveries ───────────────────────────────────────────
// Recent off-vault delivery attempts (email/webhook), newest first — shown
// as a small history list so a bad webhook URL or bounced email is visible.
router.get("/vault/backup/deliveries", requireAuth, async (req, res): Promise<void> => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }

  const rows = await db.select().from(vaultBackupDeliveriesTable)
    .where(eq(vaultBackupDeliveriesTable.userId, userId))
    .orderBy(desc(vaultBackupDeliveriesTable.createdAt))
    .limit(20);

  res.json({ deliveries: rows });
});

// ─── GET /vault/backup/audit-log ────────────────────────────────────────────
// Vault Backup hardening, Round 6. The caller's own backup-security history
// (downloads, restores, trash/purge, destination/webhook changes, cloud
// connect/disconnect) — newest first. Deliberately does NOT include
// namespace-wide key-rotation events (those have no single owning user;
// see /admin/vault-backup/audit-log for those, admin-only).
router.get("/vault/backup/audit-log", requireAuth, async (req, res): Promise<void> => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }

  const limit = req.query.limit ? Number(req.query.limit) : undefined;
  const rows = await listOwnBackupAuditLog(userId, limit && Number.isFinite(limit) ? limit : undefined);
  res.json({ events: rows });
});

export default router;
