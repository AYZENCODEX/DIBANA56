/**
 * lib/vault-backup-delivery.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Feature 15c — Off-Vault Backup Delivery.
 *
 * A vault_snapshots row is always written first (see routes/vault-snapshot.ts
 * and lib/vault-backup-schedule-cron.ts) — this module is what ADDITIONALLY
 * gets a copy of that same encrypted blob somewhere outside AYZEN's own
 * database, for anyone who wants "3-2-1 backup"-style redundancy without
 * remembering to click download manually:
 *
 *   - email:   the .ayzenbak blob as a plain-text attachment on an email,
 *              sent via lib/email.ts's sendEmail() (SMTP if configured,
 *              else Resend — same transport every other transactional email
 *              in this app already uses).
 *   - webhook: a JSON POST to a user-supplied URL, HMAC-SHA256 signed with a
 *              per-schedule secret (X-Ayzen-Signature header) so the
 *              receiving endpoint can verify it actually came from AYZEN
 *              before trusting the payload.
 *   - google_drive / dropbox (Feature 15l): the .ayzenbak blob uploaded into
 *              the user's OWN connected Drive/Dropbox account. All OAuth/
 *              token/upload details live in lib/vault-backup-cloud.ts — this
 *              module only dispatches to it and logs the attempt, same as
 *              the two destinations above.
 *
 * Every attempt — success or failure — is logged to vault_backup_deliveries
 * so a bad webhook URL, bounced email, or expired cloud connection shows up
 * in the UI instead of silently vanishing.
 */
import crypto from "crypto";
import { db, vaultBackupDeliveriesTable } from "@workspace/db";
import { sendEmail } from "./email";
import { logger } from "./logger";
import { uploadToGoogleDrive, uploadToDropbox, type CloudProvider } from "./vault-backup-cloud";
import { assertPublicHttpsUrl } from "./ssrf-guard";

export interface DeliveryTarget {
  destination: "email" | "webhook" | CloudProvider;
  email?: string | null;
  webhookUrl?: string | null;
  webhookSecret?: string | null;
}

export interface SnapshotForDelivery {
  id: number;
  label: string | null;
  blob: string;
  sizeBytes: number;
  entriesCount: number;
  walletsCount: number;
  createdAt: Date | string;
}

async function logDelivery(
  userId: number, snapshotId: number, destination: string, target: string | null,
  status: "success" | "failed", error?: string,
): Promise<void> {
  try {
    await db.insert(vaultBackupDeliveriesTable).values({
      userId, snapshotId, destination, target, status, error: error ?? null,
    });
  } catch (err) {
    logger.warn({ err }, "Failed to write vault_backup_deliveries row (delivery itself still happened)");
  }
}

/** Emails the stored backup's exact blob as a .ayzenbak attachment. */
export async function deliverSnapshotByEmail(
  userId: number, to: string, snapshot: SnapshotForDelivery,
): Promise<{ ok: boolean; error?: string }> {
  const filename = `ayzen-vault-backup-${new Date(snapshot.createdAt).getTime()}.ayzenbak`;
  try {
    const result = await sendEmail({
      to,
      subject: `AYZEN Vault Backup${snapshot.label ? ` — ${snapshot.label}` : ""}`,
      html: `
        <p>A copy of your AYZEN Vault backup is attached.</p>
        <p style="color:#888;font-size:13px">
          ${snapshot.entriesCount} entities, ${snapshot.walletsCount} wallets ·
          created ${new Date(snapshot.createdAt).toLocaleString()}
        </p>
        <p style="color:#888;font-size:13px">
          This file is encrypted — you'll need the backup's password (or, for automatic
          backups, sign in to AYZEN and restore it from the Snapshot Backup page) to open it.
        </p>`,
      text: `A copy of your AYZEN Vault backup is attached (${filename}).`,
      attachments: [{ filename, content: Buffer.from(snapshot.blob, "utf8"), contentType: "application/octet-stream" }],
    });
    if (!result.success) {
      await logDelivery(userId, snapshot.id, "email", to, "failed", result.error);
      return { ok: false, error: result.error };
    }
    await logDelivery(userId, snapshot.id, "email", to, "success");
    return { ok: true };
  } catch (err: any) {
    await logDelivery(userId, snapshot.id, "email", to, "failed", err?.message);
    return { ok: false, error: err?.message ?? "Unknown error sending backup email" };
  }
}

/**
 * POSTs the stored backup's blob + metadata to a webhook URL, HMAC-signed.
 *
 * Vault Backup hardening, Round 5 — re-validates the URL via
 * assertPublicHttpsUrl() immediately before every send (not just once when
 * the schedule was saved — see lib/ssrf-guard.ts's doc comment for why),
 * and never follows redirects: a webhook target answering with a 3xx to an
 * internal address would otherwise let a validated, public URL bounce the
 * actual request somewhere private without a second look. Both failure
 * modes are logged as an ordinary failed delivery, same as a timeout or a
 * non-2xx response — nothing about the SSRF check is exposed differently
 * to the caller than any other delivery failure.
 */
export async function deliverSnapshotByWebhook(
  userId: number, url: string, secret: string | null, snapshot: SnapshotForDelivery,
): Promise<{ ok: boolean; error?: string }> {
  try {
    await assertPublicHttpsUrl(url);
  } catch (err: any) {
    const errMsg = err?.message ?? "Webhook URL isn't allowed";
    await logDelivery(userId, snapshot.id, "webhook", url, "failed", errMsg);
    return { ok: false, error: errMsg };
  }

  const payload = JSON.stringify({
    event: "vault.backup.created",
    snapshotId: snapshot.id,
    label: snapshot.label,
    sizeBytes: snapshot.sizeBytes,
    entriesCount: snapshot.entriesCount,
    walletsCount: snapshot.walletsCount,
    createdAt: snapshot.createdAt,
    blob: snapshot.blob,
  });
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (secret) {
      headers["X-Ayzen-Signature"] = crypto.createHmac("sha256", secret).update(payload).digest("hex");
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    let res: Response;
    try {
      // redirect: "manual" — see the doc comment above. A 3xx here is
      // treated as a failure, not followed.
      res = await fetch(url, { method: "POST", headers, body: payload, signal: controller.signal, redirect: "manual" });
    } finally {
      clearTimeout(timeout);
    }
    if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
      const errMsg = "Webhook responded with a redirect, which isn't followed (SSRF protection)";
      await logDelivery(userId, snapshot.id, "webhook", url, "failed", errMsg);
      return { ok: false, error: errMsg };
    }
    if (!res.ok) {
      const errMsg = `Webhook responded ${res.status}`;
      await logDelivery(userId, snapshot.id, "webhook", url, "failed", errMsg);
      return { ok: false, error: errMsg };
    }
    await logDelivery(userId, snapshot.id, "webhook", url, "success");
    return { ok: true };
  } catch (err: any) {
    const errMsg = err?.name === "AbortError" ? "Webhook timed out after 15s" : (err?.message ?? "Unknown webhook error");
    await logDelivery(userId, snapshot.id, "webhook", url, "failed", errMsg);
    return { ok: false, error: errMsg };
  }
}

/** Uploads the stored backup's exact blob into the user's connected Google Drive/Dropbox. */
export async function deliverSnapshotByCloud(
  userId: number, provider: CloudProvider, snapshot: SnapshotForDelivery,
): Promise<{ ok: boolean; error?: string }> {
  const filename = `ayzen-vault-backup-${new Date(snapshot.createdAt).getTime()}.ayzenbak`;
  try {
    if (provider === "google_drive") await uploadToGoogleDrive(userId, filename, snapshot.blob);
    else await uploadToDropbox(userId, filename, snapshot.blob);
    await logDelivery(userId, snapshot.id, provider, filename, "success");
    return { ok: true };
  } catch (err: any) {
    const errMsg = err?.message ?? `Unknown ${provider} upload error`;
    await logDelivery(userId, snapshot.id, provider, filename, "failed", errMsg);
    return { ok: false, error: errMsg };
  }
}

/** Dispatches to the right delivery method based on `target.destination`. No-op for destination = "store". */
export async function deliverSnapshot(
  userId: number, target: DeliveryTarget, snapshot: SnapshotForDelivery,
): Promise<{ ok: boolean; error?: string } | null> {
  if (target.destination === "email") {
    if (!target.email) return { ok: false, error: "No destination email configured" };
    return deliverSnapshotByEmail(userId, target.email, snapshot);
  }
  if (target.destination === "webhook") {
    if (!target.webhookUrl) return { ok: false, error: "No webhook URL configured" };
    return deliverSnapshotByWebhook(userId, target.webhookUrl, target.webhookSecret ?? null, snapshot);
  }
  if (target.destination === "google_drive" || target.destination === "dropbox") {
    return deliverSnapshotByCloud(userId, target.destination, snapshot);
  }
  return null; // "store" — nothing to deliver, the vault_snapshots row is the backup
}
