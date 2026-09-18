/**
 * lib/vault-backup-cloud.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Feature 15l — Cloud Backup Delivery (Google Drive / Dropbox).
 *
 * Adds two new off-vault delivery destinations alongside the existing
 * email/webhook ones (lib/vault-backup-delivery.ts): pushing a copy of an
 * encrypted vault_snapshots blob into the user's OWN Google Drive or
 * Dropbox account, via a standard OAuth "authorization code" flow (see
 * routes/vault-backup-cloud.ts for the connect/callback/disconnect
 * endpoints this powers).
 *
 * Everything provider-specific lives here; vault-backup-delivery.ts only
 * gets two thin `deliverSnapshotByGoogleDrive` / `deliverSnapshotByDropbox`
 * wrappers so its own job stays "dispatch + log delivery attempts", same
 * as it already does for email/webhook.
 *
 * ── Required environment variables (not set by this change — an app must
 *    be registered with each provider first) ──────────────────────────────
 *   GOOGLE_DRIVE_CLIENT_ID / GOOGLE_DRIVE_CLIENT_SECRET / GOOGLE_DRIVE_REDIRECT_URI
 *     — from a Google Cloud project with the Drive API enabled and an
 *       OAuth 2.0 Web application client. Redirect URI must exactly match
 *       what's registered there, e.g. https://<your-domain>/api/vault/backup/cloud/google_drive/callback
 *   DROPBOX_CLIENT_ID / DROPBOX_CLIENT_SECRET / DROPBOX_REDIRECT_URI
 *     — from a Dropbox App Console app with the `files.content.write` scope.
 * If a provider's env vars aren't set, its connect endpoint returns a clear
 * 501 rather than redirecting into a broken OAuth flow — see isConfigured().
 *
 * ── Token storage ───────────────────────────────────────────────────────
 * Access/refresh tokens are stored on vault_backup_cloud_connections
 * (schema/vault-backup-cloud-connections.ts), encrypted at rest via
 * encryptField()/decryptField() — same machinery, same key-rotation story,
 * every other Vault secret already uses.
 *
 * ── ASSUMPTIONS TO VERIFY (I don't have a live Google/Dropbox app to test
 *    against) ───────────────────────────────────────────────────────────
 *   1. Google Drive upload uses the `multipart/related` upload endpoint
 *      (uploadType=multipart) — fine for backup-sized payloads; would need
 *      to switch to resumable upload if blobs regularly exceed ~5-10MB.
 *   2. Dropbox upload uses the simple `/2/files/upload` endpoint, which
 *      Dropbox caps at 150MB — comfortably covers a vault snapshot; a
 *      backup that includes many large attachments could need the
 *      chunked upload-session API instead.
 *   3. Both refresh flows assume the standard OAuth2 `refresh_token` grant;
 *      double-check against each provider's current docs before relying on
 *      this in production, since token endpoint details do shift.
 */
import { db, vaultBackupCloudConnectionsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { encryptField, decryptField } from "./vault-crypto";
import { signOAuthState, verifyOAuthState } from "./jwt";
import { logger } from "./logger";

export type CloudProvider = "google_drive" | "dropbox";
export const CLOUD_PROVIDERS: CloudProvider[] = ["google_drive", "dropbox"];

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart";
const GOOGLE_FILES_URL = "https://www.googleapis.com/drive/v3/files";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";
const GOOGLE_SCOPE = "https://www.googleapis.com/auth/drive.file email";

const DROPBOX_AUTH_URL = "https://www.dropbox.com/oauth2/authorize";
const DROPBOX_TOKEN_URL = "https://api.dropboxapi.com/oauth2/token";
const DROPBOX_UPLOAD_URL = "https://content.dropboxapi.com/2/files/upload";
const DROPBOX_ACCOUNT_URL = "https://api.dropboxapi.com/2/users/get_current_account";
const DROPBOX_BACKUP_PATH = "/AYZEN Vault Backups";

function googleCreds() {
  return {
    clientId: process.env.GOOGLE_DRIVE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_DRIVE_CLIENT_SECRET,
    redirectUri: process.env.GOOGLE_DRIVE_REDIRECT_URI,
  };
}
function dropboxCreds() {
  return {
    clientId: process.env.DROPBOX_CLIENT_ID,
    clientSecret: process.env.DROPBOX_CLIENT_SECRET,
    redirectUri: process.env.DROPBOX_REDIRECT_URI,
  };
}

/** Whether the given provider has its OAuth app credentials configured server-side. */
export function isCloudProviderConfigured(provider: CloudProvider): boolean {
  const c = provider === "google_drive" ? googleCreds() : dropboxCreds();
  return !!(c.clientId && c.clientSecret && c.redirectUri);
}

/** Builds the "Connect" redirect URL for a provider, with a signed state carrying userId. */
export function buildAuthorizeUrl(provider: CloudProvider, userId: number): string {
  const state = signOAuthState({ userId, provider });
  if (provider === "google_drive") {
    const { clientId, redirectUri } = googleCreds();
    const params = new URLSearchParams({
      client_id: clientId!, redirect_uri: redirectUri!, response_type: "code",
      scope: GOOGLE_SCOPE, access_type: "offline", prompt: "consent", state,
    });
    return `${GOOGLE_AUTH_URL}?${params.toString()}`;
  }
  const { clientId, redirectUri } = dropboxCreds();
  const params = new URLSearchParams({
    client_id: clientId!, redirect_uri: redirectUri!, response_type: "code",
    token_access_type: "offline", state,
  });
  return `${DROPBOX_AUTH_URL}?${params.toString()}`;
}

/** Verifies an OAuth callback's `state` param and returns the userId/provider it carries, or null if invalid/expired. */
export function verifyAuthorizeState(state: string): { userId: number; provider: CloudProvider } | null {
  const decoded = verifyOAuthState<{ userId: number; provider: CloudProvider }>(state);
  if (!decoded || typeof decoded.userId !== "number" || !CLOUD_PROVIDERS.includes(decoded.provider)) return null;
  return decoded;
}

interface TokenSet { accessToken: string; refreshToken: string | null; expiresAt: Date | null; }

async function exchangeGoogleCode(code: string): Promise<TokenSet> {
  const { clientId, clientSecret, redirectUri } = googleCreds();
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code, client_id: clientId!, client_secret: clientSecret!,
      redirect_uri: redirectUri!, grant_type: "authorization_code",
    }),
  });
  const data: any = await res.json();
  if (!res.ok) throw new Error(data?.error_description ?? data?.error ?? "Google token exchange failed");
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresAt: data.expires_in ? new Date(Date.now() + data.expires_in * 1000) : null,
  };
}

async function exchangeDropboxCode(code: string): Promise<TokenSet> {
  const { clientId, clientSecret, redirectUri } = dropboxCreds();
  const res = await fetch(DROPBOX_TOKEN_URL, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code, client_id: clientId!, client_secret: clientSecret!,
      redirect_uri: redirectUri!, grant_type: "authorization_code",
    }),
  });
  const data: any = await res.json();
  if (!res.ok) throw new Error(data?.error_description ?? data?.error ?? "Dropbox token exchange failed");
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresAt: data.expires_in ? new Date(Date.now() + data.expires_in * 1000) : null,
  };
}

async function fetchGoogleAccountLabel(accessToken: string): Promise<string | null> {
  try {
    const res = await fetch(GOOGLE_USERINFO_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) return null;
    const data: any = await res.json();
    return data?.email ?? null;
  } catch { return null; }
}
async function fetchDropboxAccountLabel(accessToken: string): Promise<string | null> {
  try {
    const res = await fetch(DROPBOX_ACCOUNT_URL, { method: "POST", headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) return null;
    const data: any = await res.json();
    return data?.email ?? null;
  } catch { return null; }
}

/** Creates or finds the "AYZEN Vault Backups" Drive folder and returns its id. */
async function ensureGoogleFolder(accessToken: string): Promise<string> {
  const q = encodeURIComponent("name='AYZEN Vault Backups' and mimeType='application/vnd.google-apps.folder' and trashed=false");
  const listRes = await fetch(`${GOOGLE_FILES_URL}?q=${q}&fields=files(id)`, { headers: { Authorization: `Bearer ${accessToken}` } });
  const listData: any = await listRes.json().catch(() => ({}));
  if (listRes.ok && Array.isArray(listData?.files) && listData.files[0]?.id) return listData.files[0].id;

  const createRes = await fetch(GOOGLE_FILES_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "AYZEN Vault Backups", mimeType: "application/vnd.google-apps.folder" }),
  });
  const createData: any = await createRes.json();
  if (!createRes.ok) throw new Error(createData?.error?.message ?? "Couldn't create Drive backup folder");
  return createData.id;
}

/** Completes the OAuth callback for a provider: exchanges the code, resolves an account label (and Drive folder), and upserts the connection row. */
export async function completeCloudConnect(provider: CloudProvider, userId: number, code: string): Promise<void> {
  const tokens = provider === "google_drive" ? await exchangeGoogleCode(code) : await exchangeDropboxCode(code);
  const accountLabel = provider === "google_drive"
    ? await fetchGoogleAccountLabel(tokens.accessToken)
    : await fetchDropboxAccountLabel(tokens.accessToken);
  const folderId = provider === "google_drive" ? await ensureGoogleFolder(tokens.accessToken) : null;

  const [existing] = await db.select().from(vaultBackupCloudConnectionsTable)
    .where(and(eq(vaultBackupCloudConnectionsTable.userId, userId), eq(vaultBackupCloudConnectionsTable.provider, provider)));

  const values = {
    userId, provider,
    accessToken: encryptField(tokens.accessToken),
    // A re-auth (already connected, connecting again) may not return a new
    // refresh_token (Google only issues one on first consent) — keep the
    // existing one rather than overwriting it with null.
    refreshToken: tokens.refreshToken ? encryptField(tokens.refreshToken) : (existing?.refreshToken ?? null),
    expiresAt: tokens.expiresAt,
    accountLabel, folderId,
    updatedAt: new Date(),
  };

  if (existing) {
    await db.update(vaultBackupCloudConnectionsTable).set(values).where(eq(vaultBackupCloudConnectionsTable.id, existing.id));
  } else {
    await db.insert(vaultBackupCloudConnectionsTable).values(values as any);
  }
}

/** Returns a usable (refreshed if needed) plaintext access token for a user's connection, or null if not connected. Refreshing updates the stored row. */
async function getFreshAccessToken(userId: number, provider: CloudProvider): Promise<{ accessToken: string; folderId: string | null } | null> {
  const [row] = await db.select().from(vaultBackupCloudConnectionsTable)
    .where(and(eq(vaultBackupCloudConnectionsTable.userId, userId), eq(vaultBackupCloudConnectionsTable.provider, provider)));
  if (!row) return null;

  const stillValid = !row.expiresAt || new Date(row.expiresAt).getTime() - Date.now() > 60_000;
  if (stillValid) return { accessToken: decryptField(row.accessToken), folderId: row.folderId };

  const refreshToken = decryptField(row.refreshToken);
  if (!refreshToken) return { accessToken: decryptField(row.accessToken), folderId: row.folderId }; // no way to refresh — try the old token anyway

  const refreshed = await refreshAccessToken(provider, refreshToken);
  await db.update(vaultBackupCloudConnectionsTable).set({
    accessToken: encryptField(refreshed.accessToken),
    expiresAt: refreshed.expiresAt,
    updatedAt: new Date(),
  }).where(eq(vaultBackupCloudConnectionsTable.id, row.id));

  return { accessToken: refreshed.accessToken, folderId: row.folderId };
}

async function refreshAccessToken(provider: CloudProvider, refreshToken: string): Promise<{ accessToken: string; expiresAt: Date | null }> {
  const { clientId, clientSecret } = provider === "google_drive" ? googleCreds() : dropboxCreds();
  const url = provider === "google_drive" ? GOOGLE_TOKEN_URL : DROPBOX_TOKEN_URL;
  const res = await fetch(url, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ refresh_token: refreshToken, client_id: clientId!, client_secret: clientSecret!, grant_type: "refresh_token" }),
  });
  const data: any = await res.json();
  if (!res.ok) throw new Error(data?.error_description ?? data?.error ?? `${provider} token refresh failed`);
  return { accessToken: data.access_token, expiresAt: data.expires_in ? new Date(Date.now() + data.expires_in * 1000) : null };
}

/** Uploads the backup blob to Google Drive. Throws on failure (caller — vault-backup-delivery.ts — logs it). */
export async function uploadToGoogleDrive(userId: number, filename: string, blob: string): Promise<void> {
  const conn = await getFreshAccessToken(userId, "google_drive");
  if (!conn) throw new Error("Google Drive is not connected");
  const folderId = conn.folderId ?? await ensureGoogleFolder(conn.accessToken);

  const boundary = "ayzen-backup-boundary";
  const metadata = JSON.stringify({ name: filename, parents: [folderId] });
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n` +
    `--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n${blob}\r\n--${boundary}--`;

  const res = await fetch(GOOGLE_UPLOAD_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${conn.accessToken}`, "Content-Type": `multipart/related; boundary=${boundary}` },
    body,
  });
  if (!res.ok) {
    const data: any = await res.json().catch(() => ({}));
    throw new Error(data?.error?.message ?? `Google Drive upload failed (${res.status})`);
  }
}

/** Uploads the backup blob to Dropbox. Throws on failure (caller logs it). */
export async function uploadToDropbox(userId: number, filename: string, blob: string): Promise<void> {
  const conn = await getFreshAccessToken(userId, "dropbox");
  if (!conn) throw new Error("Dropbox is not connected");

  const res = await fetch(DROPBOX_UPLOAD_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${conn.accessToken}`,
      "Content-Type": "application/octet-stream",
      "Dropbox-API-Arg": JSON.stringify({ path: `${DROPBOX_BACKUP_PATH}/${filename}`, mode: "add", autorename: true, mute: true }),
    },
    body: Buffer.from(blob, "utf8"),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(text || `Dropbox upload failed (${res.status})`);
  }
}

export interface CloudConnectionStatus {
  provider: CloudProvider;
  connected: boolean;
  accountLabel: string | null;
  configured: boolean; // whether the server has OAuth credentials set up for this provider at all
}

/** Connection status for every provider, for the Automatic Backups card. Never returns tokens. */
export async function listCloudConnections(userId: number): Promise<CloudConnectionStatus[]> {
  const rows = await db.select().from(vaultBackupCloudConnectionsTable).where(eq(vaultBackupCloudConnectionsTable.userId, userId));
  return CLOUD_PROVIDERS.map((provider) => {
    const row = rows.find((r: typeof rows[number]) => r.provider === provider);
    return { provider, connected: !!row, accountLabel: row?.accountLabel ?? null, configured: isCloudProviderConfigured(provider) };
  });
}

export async function disconnectCloudProvider(userId: number, provider: CloudProvider): Promise<void> {
  await db.delete(vaultBackupCloudConnectionsTable)
    .where(and(eq(vaultBackupCloudConnectionsTable.userId, userId), eq(vaultBackupCloudConnectionsTable.provider, provider)))
    .catch((err: unknown) => { logger.warn({ err }, "Failed to delete vault_backup_cloud_connections row"); throw err; });
}
