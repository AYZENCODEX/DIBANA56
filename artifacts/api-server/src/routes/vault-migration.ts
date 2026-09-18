/**
 * routes/vault-migration.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Feature 13 — Import/Export Migration Tool.
 *
 * Export: GET /vault/export?format=csv|json — a portable (NOT encrypted)
 * dump of the caller's own active Vault entries, for moving data to another
 * tool or for personal backup. This is deliberately lighter than Feature 15
 * (routes/vault-snapshot.ts), which produces a single password-encrypted
 * blob of the *entire* vault for disaster recovery — use that one when the
 * goal is "back this up safely", use this one when the goal is "get my data
 * out in a format other tools can read".
 *
 * Import: POST /vault/import — accepts AYZEN's own CSV/JSON export format,
 * or a raw CSV export from 1Password, Bitwarden, or LastPass. Each format
 * has its own column layout (see the FORMAT_MAPPERS below); everything gets
 * normalized to the same Partial<InsertVaultEntry> shape and inserted the
 * same way POST /vault does, including running sensitive fields through
 * encryptField() (see SENSITIVE_VAULT_FIELDS, exported from routes/vault.ts).
 *
 * Row-level failures never abort the whole import — each row succeeds or
 * fails independently and the response reports both counts plus a per-row
 * reason, since a single malformed line in a 500-row LastPass export
 * shouldn't cost the other 499.
 */
import { Router } from "express";
import express from "express";
import { db, vaultEntriesTable } from "@workspace/db";
import { requireAuth, getRequestUserId } from "../middlewares/auth";
import { sensitiveWriteLimiter } from "../middlewares/security";
import { encryptField, decryptField } from "../lib/vault-crypto";
import { parseCsvObjects, toCsv } from "../lib/csv";
import { logActivity } from "../lib/activity";
import { SENSITIVE_VAULT_FIELDS, generateSerial } from "./vault";
import { and, eq, sql } from "drizzle-orm";

const router = Router();

// Import bodies (a full CSV/JSON export) can be larger than the app-wide
// JSON_BODY_LIMIT — scoped bump, same reasoning as vault-attachments.ts.
const importBodyParser = express.json({ limit: "15mb" });

// ─── Export ─────────────────────────────────────────────────────────────────

const EXPORT_COLUMNS = [
  "category", "projectName", "username", "accountPassword",
  "email", "emailPassword", "email2fa", "emailBackupCode",
  "twitterUsername", "twitterPassword",
  "discordUsername", "discordPassword",
  "telegramUsername", "telegramPassword",
  "walletAddresses", "tags", "notes", "status", "currentValue",
] as const;

router.get("/vault/export", requireAuth, async (req, res): Promise<void> => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }

  const format = String(req.query.format ?? "csv").toLowerCase();
  if (format !== "csv" && format !== "json") {
    res.status(400).json({ error: "Invalid format", solution: "format must be \"csv\" or \"json\"." });
    return;
  }

  const rows = await db.select().from(vaultEntriesTable)
    .where(and(eq(vaultEntriesTable.userId, userId), sql`${vaultEntriesTable.deletedAt} IS NULL`));

  const decrypted = rows.map(r => {
    const out: Record<string, unknown> = { ...r };
    for (const f of SENSITIVE_VAULT_FIELDS) out[f] = decryptField(out[f] as any);
    return out;
  });

  await logActivity(userId, "vault_exported", null, null, null, { format, count: decrypted.length });

  if (format === "json") {
    res.setHeader("Content-Disposition", `attachment; filename="ayzen-vault-export-${Date.now()}.json"`);
    res.json({ exportedAt: new Date().toISOString(), count: decrypted.length, entries: decrypted.map(pickExportColumns) });
    return;
  }

  const csv = toCsv(decrypted.map(pickExportColumns), [...EXPORT_COLUMNS]);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="ayzen-vault-export-${Date.now()}.csv"`);
  res.send(csv);
});

function pickExportColumns(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const c of EXPORT_COLUMNS) out[c] = row[c] ?? "";
  return out;
}

// ─── Import ─────────────────────────────────────────────────────────────────

type ImportFormat = "ayzen_csv" | "ayzen_json" | "1password" | "bitwarden" | "lastpass";
const IMPORT_FORMATS: ImportFormat[] = ["ayzen_csv", "ayzen_json", "1password", "bitwarden", "lastpass"];

type PartialEntry = Record<string, unknown>;

// Each mapper turns one parsed row (already split into columns by header,
// see parseCsvObjects) into our internal field names. Unknown/missing
// source columns are simply left out — never fail the row just because one
// optional column wasn't present in a particular export.
const FORMAT_MAPPERS: Record<Exclude<ImportFormat, "ayzen_json">, (row: Record<string, string>) => PartialEntry> = {
  ayzen_csv: (row) => ({
    category: row.category || undefined,
    projectName: row.projectName || row.name || undefined,
    username: row.username || undefined,
    accountPassword: row.accountPassword || undefined,
    email: row.email || undefined,
    emailPassword: row.emailPassword || undefined,
    email2fa: row.email2fa || undefined,
    emailBackupCode: row.emailBackupCode || undefined,
    twitterUsername: row.twitterUsername || undefined,
    twitterPassword: row.twitterPassword || undefined,
    discordUsername: row.discordUsername || undefined,
    discordPassword: row.discordPassword || undefined,
    telegramUsername: row.telegramUsername || undefined,
    telegramPassword: row.telegramPassword || undefined,
    walletAddresses: row.walletAddresses || undefined,
    tags: row.tags || undefined,
    notes: row.notes || undefined,
    status: row.status || undefined,
    currentValue: row.currentValue ? Number(row.currentValue) || 0 : undefined,
  }),
  // 1Password "Export as CSV" (legacy Logins export): Title,Url,Username,Password,Notes
  "1password": (row) => ({
    projectName: row.Title || row.title || "Imported item",
    username: row.Username || row.username || undefined,
    accountPassword: row.Password || row.password || undefined,
    notes: joinNotes(row.Notes || row.notes, row.Url || row.url),
  }),
  // Bitwarden "Export vault" CSV: folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp
  bitwarden: (row) => ({
    projectName: row.name || "Imported item",
    username: row.login_username || undefined,
    accountPassword: row.login_password || undefined,
    account2fa: row.login_totp || undefined,
    notes: joinNotes(row.notes, row.login_uri),
  }),
  // LastPass "Export" CSV: url,username,password,extra,name,grouping,fav
  lastpass: (row) => ({
    projectName: row.name || "Imported item",
    username: row.username || undefined,
    accountPassword: row.password || undefined,
    notes: joinNotes(row.extra, row.url),
  }),
};

function joinNotes(notes?: string, url?: string): string | undefined {
  const parts = [notes?.trim(), url?.trim() ? `URL: ${url.trim()}` : ""].filter(Boolean);
  return parts.length ? parts.join("\n\n") : undefined;
}

router.post("/vault/import", requireAuth, importBodyParser, sensitiveWriteLimiter, async (req, res): Promise<void> => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }

  const { format, data } = req.body ?? {};
  if (typeof format !== "string" || !IMPORT_FORMATS.includes(format as ImportFormat)) {
    res.status(400).json({ error: "Invalid format", solution: `format must be one of: ${IMPORT_FORMATS.join(", ")}` });
    return;
  }
  if (typeof data !== "string" || !data.trim()) {
    res.status(400).json({ error: "data is required", solution: "Provide the raw CSV or JSON export text." });
    return;
  }

  let entries: PartialEntry[] = [];
  try {
    if (format === "ayzen_json") {
      const parsed = JSON.parse(data);
      entries = Array.isArray(parsed) ? parsed : (parsed.entries ?? []);
    } else {
      const rows = parseCsvObjects(data);
      const mapper = FORMAT_MAPPERS[format as Exclude<ImportFormat, "ayzen_json">];
      entries = rows.map(mapper);
    }
  } catch (err: any) {
    res.status(400).json({ error: "Could not parse import data", detail: err?.message });
    return;
  }

  if (entries.length === 0) {
    res.json({ imported: 0, skipped: 0, errors: [] });
    return;
  }
  if (entries.length > 2000) {
    res.status(413).json({ error: "Too many rows", solution: "Import at most 2000 entries at a time." });
    return;
  }

  let imported = 0;
  const errors: { row: number; reason: string }[] = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const projectName = String(entry.projectName ?? "").trim();
    if (!projectName) { errors.push({ row: i + 1, reason: "Missing projectName/title" }); continue; }

    const values: PartialEntry = { userId, entitySerial: generateSerial(userId), projectName };
    for (const [key, value] of Object.entries(entry)) {
      if (key === "projectName" || value === undefined || value === null || value === "") continue;
      // Never let attacker-supplied import data override identity/ownership or
      // system-managed timestamp columns — mirrors the same exclusion list used
      // by vault-snapshot.ts's restore route.
      if (["id", "userId", "entitySerial", "createdAt", "updatedAt", "deletedAt"].includes(key)) continue;
      values[key] = SENSITIVE_VAULT_FIELDS.has(key) ? encryptField(String(value)) : value;
    }

    try {
      await db.insert(vaultEntriesTable).values(values as any);
      imported++;
    } catch (err: any) {
      errors.push({ row: i + 1, reason: err?.message ?? "Insert failed" });
    }
  }

  await logActivity(userId, "vault_imported", null, null, null, { format, imported, skipped: errors.length });

  res.json({ imported, skipped: errors.length, errors: errors.slice(0, 50) });
});

export default router;
