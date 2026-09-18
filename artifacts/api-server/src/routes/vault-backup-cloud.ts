/**
 * routes/vault-backup-cloud.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Feature 15l — Cloud Backup Delivery (Google Drive / Dropbox).
 *
 * Connect/disconnect + status endpoints for the OAuth connections
 * lib/vault-backup-cloud.ts uploads backups through. The actual upload
 * happens later, off a schedule or "Run Now" (lib/vault-backup-delivery.ts)
 * — these routes only manage the connection itself.
 *
 * This app authenticates via a bearer token (Authorization header, see
 * middlewares/auth.ts) rather than a session cookie, so GET /connect can't
 * itself be the page the browser navigates to — a plain navigation carries
 * no Authorization header, and requireAuth would reject it. Instead
 * GET /connect is a normal authenticated JSON call (via customFetch) that
 * returns `{ url }`; the frontend then does the actual navigation itself
 * (`window.location.href = url`). The provider's OAuth `state` param (see
 * lib/vault-backup-cloud.ts's signOAuthState) is what carries the userId
 * through that navigation and back, since the callback below runs
 * unauthenticated (the browser lands there directly from Google/Dropbox,
 * with no way to attach our app's bearer token). The callback then
 * redirects back into the app's Snapshot Backup page with a
 * `cloudConnected`/`cloudError` query param so the UI can show a toast
 * without needing its own polling.
 */
import { Router } from "express";
import { requireAuth, getRequestUserId } from "../middlewares/auth";
import { sensitiveWriteLimiter } from "../middlewares/security";
import {
  CLOUD_PROVIDERS, type CloudProvider,
  isCloudProviderConfigured, buildAuthorizeUrl, verifyAuthorizeState,
  completeCloudConnect, listCloudConnections, disconnectCloudProvider,
} from "../lib/vault-backup-cloud";
import { logger } from "../lib/logger";
import { logBackupAudit } from "../lib/vault-backup-audit";

const router = Router();

function isCloudProvider(v: string): v is CloudProvider {
  return (CLOUD_PROVIDERS as string[]).includes(v);
}

// Where the callback sends the browser back to, regardless of outcome.
// Same APP_URL env var (with the same fallback) every other absolute link
// in this app already uses (see routes/emergency-access.ts, finance.ts, etc).
function backToSnapshotPage(): string {
  return `${process.env.APP_URL ?? "https://ayzen.replit.app"}/vault/snapshot`;
}

// ─── GET /vault/backup/cloud ─────────────────────────────────────────────
// Connection status for every provider (never returns tokens) — powers the
// Automatic Backups card's "Connect Google Drive" / "Connected as …" state.
router.get("/vault/backup/cloud", requireAuth, async (req, res): Promise<void> => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }
  res.json({ connections: await listCloudConnections(userId) });
});

// ─── GET /vault/backup/cloud/:provider/connect ──────────────────────────
// Returns the provider's OAuth consent-screen URL (see file header for why
// this is JSON + a frontend-driven redirect, not a server-side one).
router.get("/vault/backup/cloud/:provider/connect", requireAuth, (req, res): void => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }

  const provider = String(req.params.provider);
  if (!isCloudProvider(provider)) { res.status(404).json({ error: "Unknown provider" }); return; }
  if (!isCloudProviderConfigured(provider)) {
    res.status(501).json({
      error: `${provider === "google_drive" ? "Google Drive" : "Dropbox"} isn't configured on this server yet — ` +
        "the required OAuth client id/secret/redirect URI environment variables aren't set.",
    });
    return;
  }

  res.json({ url: buildAuthorizeUrl(provider, userId) });
});

// ─── GET /vault/backup/cloud/:provider/callback ─────────────────────────
// Provider redirects here after consent. Exchanges the code, stores the
// connection, then bounces the browser back into the app.
router.get("/vault/backup/cloud/:provider/callback", async (req, res): Promise<void> => {
  const provider = String(req.params.provider);
  const code = typeof req.query.code === "string" ? req.query.code : null;
  const state = typeof req.query.state === "string" ? req.query.state : null;

  if (!isCloudProvider(provider) || !code || !state) {
    res.redirect(`${backToSnapshotPage()}?cloudError=${encodeURIComponent("Malformed callback")}`);
    return;
  }

  const verified = verifyAuthorizeState(state);
  if (!verified || verified.provider !== provider) {
    res.redirect(`${backToSnapshotPage()}?cloudError=${encodeURIComponent("Connect link expired — try again")}`);
    return;
  }

  try {
    await completeCloudConnect(provider, verified.userId, code);
    await logBackupAudit({
      ownerUserId: verified.userId, eventType: "cloud_connected", req, detail: { provider },
    });
    res.redirect(`${backToSnapshotPage()}?cloudConnected=${provider}`);
  } catch (err: any) {
    logger.error({ err, provider, userId: verified.userId }, "Cloud backup connect failed");
    res.redirect(`${backToSnapshotPage()}?cloudError=${encodeURIComponent(err?.message ?? "Connect failed")}`);
  }
});

// ─── DELETE /vault/backup/cloud/:provider ───────────────────────────────
router.delete("/vault/backup/cloud/:provider", requireAuth, sensitiveWriteLimiter, async (req, res): Promise<void> => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }

  const provider = String(req.params.provider);
  if (!isCloudProvider(provider)) { res.status(404).json({ error: "Unknown provider" }); return; }

  await disconnectCloudProvider(userId, provider);
  await logBackupAudit({ ownerUserId: userId, eventType: "cloud_disconnected", req, detail: { provider } });
  res.json({ ok: true });
});

export default router;
