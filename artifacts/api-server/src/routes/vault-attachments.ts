/**
 * routes/vault-attachments.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Feature 12 — Document/File Attachments.
 *
 * Per-entity encrypted file storage (ID scan, contract, etc). No object
 * storage is wired into this project, so files travel as base64 JSON and are
 * stored encrypted (lib/vault-crypto.ts) in the vault_attachments table —
 * see schema/vault-attachments.ts for the full design note.
 *
 * All routes are scoped to a vault_entries row the caller owns — the entity
 * ownership check (assertEntityOwnership) runs before every read/write so
 * one user can never enumerate or touch another user's attachments even by
 * guessing IDs.
 */
import { Router } from "express";
import type { Request, Response } from "express";
import express from "express";
import { db, vaultAttachmentsTable, vaultEntriesTable } from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { requireAuth, getRequestUserId, pepDecisionObserver } from "../middlewares/auth";
import { requireOwnership } from "../lib/policy/pep/middleware";
import type { ResourceRefBuilder } from "../lib/policy/pep/types";
import { sensitiveWriteLimiter } from "../middlewares/security";
import { encryptField, decryptField } from "../lib/vault-crypto";
import { logActivity } from "../lib/activity";

const router = Router();

// ─── Route Integration Roadmap — Season E, Phase E5 (new resource builder:
// vault-attachments.ts) ───────────────────────────────────────────────────
// This file's own `assertEntityOwnership()` (below) has always been a
// genuine single-row ownership check — `:id` names a `vault_entries` row,
// `vaultEntriesTable.userId` is a real, distinct owner column a caller
// could mismatch against — the same shape every `*Resource`/
// `requireXOwnership()` pair in `finance.ts`/`projects.ts` already covers.
// It just predates `requireOwnership()`/`ResourceRefBuilder` existing in
// this codebase (this file is older than the PEP), so it was never
// migrated to the pattern — `check-ownership-gate-coverage.ts` doesn't
// recognize a bespoke inline async boolean helper as wiring, correctly.
//
// New `ResourceRefBuilder` below, reusing the EXACT same query
// `assertEntityOwnership()` already runs (including the `deletedAt IS
// NULL` condition — a soft-deleted entity must deny the same way a
// nonexistent one does, not silently skip the filter and leak a
// soft-deleted entity's attachments). `assertEntityOwnership()` itself is
// NOT removed — every handler below keeps its own inline call as
// defense-in-depth, same "keep the working inline check alongside the new
// router-level gate" precedent E1's book/entry-derived groups already
// established for `finance.ts`.
//
// All 5 routes in this file share one resource type and one pre-existing
// 404 body (`{ error: "Entity not found" }`) — a single parametrized
// `requireVaultAttachmentEntityOwnership(action)` factory covers all of
// them, same shape as `ayzen-mailbox.ts`'s `requireAyzenMailboxSubOwnership`.
const VAULT_ATTACHMENT_ENTITY_OWNER_SENTINEL_NONE = -1;

const vaultAttachmentEntityResource: ResourceRefBuilder = async (req: Request) => {
  const raw = req.params.id;
  const id = parseInt(String(raw), 10);
  if (!Number.isFinite(id)) {
    return { type: "vault_entry", id: raw, ownerId: VAULT_ATTACHMENT_ENTITY_OWNER_SENTINEL_NONE };
  }
  const [row] = await db.select({ userId: vaultEntriesTable.userId })
    .from(vaultEntriesTable)
    .where(and(eq(vaultEntriesTable.id, id), sql`${vaultEntriesTable.deletedAt} IS NULL`))
    .limit(1);
  return { type: "vault_entry", id, ownerId: row?.userId ?? VAULT_ATTACHMENT_ENTITY_OWNER_SENTINEL_NONE };
};

function requireVaultAttachmentEntityOwnership(action: string) {
  return requireOwnership(action, vaultAttachmentEntityResource, {
    onDecision: pepDecisionObserver,
    onDeny: (_req: Request, res: Response) => {
      res.status(404).json({ error: "Entity not found" });
    },
  });
}

// Raw (pre-encryption, pre-base64) file size cap. Kept small — this is a
// TEXT-column store, not object storage (see file header). 8MB comfortably
// covers ID photos and PDF contracts without letting a single upload bloat
// the vault_attachments table or the JSON body parser.
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const ALLOWED_CATEGORIES = new Set(["id_scan", "contract", "screenshot", "other"]);

// Attachment uploads need a bigger body than the app-wide JSON_BODY_LIMIT
// (default 1mb) allows — base64 alone adds ~33% overhead on top of
// MAX_ATTACHMENT_BYTES. Scoped to just this route so no other endpoint's
// body-size budget changes.
const uploadBodyParser = express.json({ limit: "12mb" });

async function assertEntityOwnership(entityId: number, userId: number): Promise<boolean> {
  const rows = await db.select({ id: vaultEntriesTable.id })
    .from(vaultEntriesTable)
    .where(and(eq(vaultEntriesTable.id, entityId), eq(vaultEntriesTable.userId, userId), sql`${vaultEntriesTable.deletedAt} IS NULL`))
    .limit(1);
  return rows.length > 0;
}

// ── GET /vault/:id/attachments — list (metadata only, no file bytes) ────────
router.get("/vault/:id/attachments", requireAuth, requireVaultAttachmentEntityOwnership("vault_entry.attachments.list"), async (req, res): Promise<void> => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }

  const entityId = parseInt(String(req.params.id), 10);
  if (!Number.isFinite(entityId)) { res.status(400).json({ error: "Invalid entity id" }); return; }
  if (!(await assertEntityOwnership(entityId, userId))) { res.status(404).json({ error: "Entity not found" }); return; }

  const rows = await db.select({
    id: vaultAttachmentsTable.id,
    fileName: vaultAttachmentsTable.fileName,
    mimeType: vaultAttachmentsTable.mimeType,
    fileSizeBytes: vaultAttachmentsTable.fileSizeBytes,
    category: vaultAttachmentsTable.category,
    note: vaultAttachmentsTable.note,
    uploadedAt: vaultAttachmentsTable.uploadedAt,
    updatedAt: vaultAttachmentsTable.updatedAt,
  }).from(vaultAttachmentsTable)
    .where(and(eq(vaultAttachmentsTable.vaultEntryId, entityId), eq(vaultAttachmentsTable.userId, userId)))
    .orderBy(vaultAttachmentsTable.uploadedAt);

  res.json({ items: rows });
});

// ── POST /vault/:id/attachments — upload a new file ─────────────────────────
// Body: { fileName, mimeType, category?, note?, dataBase64 }
router.post("/vault/:id/attachments", requireAuth, requireVaultAttachmentEntityOwnership("vault_entry.attachments.upload"), uploadBodyParser, sensitiveWriteLimiter, async (req, res): Promise<void> => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }

  const entityId = parseInt(String(req.params.id), 10);
  if (!Number.isFinite(entityId)) { res.status(400).json({ error: "Invalid entity id" }); return; }
  if (!(await assertEntityOwnership(entityId, userId))) { res.status(404).json({ error: "Entity not found" }); return; }

  const { fileName, mimeType, category = "other", note, dataBase64 } = req.body ?? {};
  if (typeof fileName !== "string" || !fileName.trim()) {
    res.status(400).json({ error: "fileName is required" }); return;
  }
  if (typeof mimeType !== "string" || !mimeType.trim()) {
    res.status(400).json({ error: "mimeType is required" }); return;
  }
  if (typeof dataBase64 !== "string" || !dataBase64) {
    res.status(400).json({ error: "dataBase64 is required" }); return;
  }
  if (typeof category !== "string" || !ALLOWED_CATEGORIES.has(category)) {
    res.status(400).json({ error: "Invalid category", solution: `category must be one of: ${[...ALLOWED_CATEGORIES].join(", ")}` });
    return;
  }

  // Strip a data-URL prefix if the client sent one (e.g. "data:application/pdf;base64,...").
  const b64 = dataBase64.includes(",") && dataBase64.trim().startsWith("data:")
    ? dataBase64.slice(dataBase64.indexOf(",") + 1)
    : dataBase64;

  let raw: Buffer;
  try {
    raw = Buffer.from(b64, "base64");
  } catch {
    res.status(400).json({ error: "dataBase64 is not valid base64" }); return;
  }
  if (raw.length === 0) { res.status(400).json({ error: "File is empty" }); return; }
  if (raw.length > MAX_ATTACHMENT_BYTES) {
    res.status(413).json({
      error: "File too large",
      code: "ATTACHMENT_TOO_LARGE",
      solution: `Attachments are limited to ${Math.floor(MAX_ATTACHMENT_BYTES / (1024 * 1024))}MB.`,
    });
    return;
  }

  const encryptedContent = encryptField(b64)!;

  const [row] = await db.insert(vaultAttachmentsTable).values({
    userId,
    vaultEntryId: entityId,
    fileName: fileName.trim().slice(0, 255),
    mimeType: mimeType.trim().slice(0, 100),
    fileSizeBytes: raw.length,
    category,
    note: typeof note === "string" && note.trim() ? note.trim().slice(0, 500) : null,
    encryptedContent,
  }).returning({
    id: vaultAttachmentsTable.id,
    fileName: vaultAttachmentsTable.fileName,
    mimeType: vaultAttachmentsTable.mimeType,
    fileSizeBytes: vaultAttachmentsTable.fileSizeBytes,
    category: vaultAttachmentsTable.category,
    note: vaultAttachmentsTable.note,
    uploadedAt: vaultAttachmentsTable.uploadedAt,
  });

  await logActivity(userId, "vault_attachment_uploaded", "vault_entry", entityId, fileName, { attachmentId: row.id, category });

  res.status(201).json(row);
});

// ── GET /vault/:id/attachments/:attachmentId — download (decrypted) ────────
router.get("/vault/:id/attachments/:attachmentId", requireAuth, requireVaultAttachmentEntityOwnership("vault_entry.attachments.download"), async (req, res): Promise<void> => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }

  const entityId = parseInt(String(req.params.id), 10);
  const attachmentId = parseInt(String(req.params.attachmentId), 10);
  if (!Number.isFinite(entityId) || !Number.isFinite(attachmentId)) { res.status(400).json({ error: "Invalid id" }); return; }
  if (!(await assertEntityOwnership(entityId, userId))) { res.status(404).json({ error: "Entity not found" }); return; }

  const [row] = await db.select().from(vaultAttachmentsTable)
    .where(and(
      eq(vaultAttachmentsTable.id, attachmentId),
      eq(vaultAttachmentsTable.vaultEntryId, entityId),
      eq(vaultAttachmentsTable.userId, userId),
    ))
    .limit(1);
  if (!row) { res.status(404).json({ error: "Attachment not found" }); return; }

  const b64 = decryptField(row.encryptedContent);
  await logActivity(userId, "vault_attachment_downloaded", "vault_entry", entityId, row.fileName, { attachmentId });

  if (req.query.raw === "1") {
    res.setHeader("Content-Type", row.mimeType);
    res.setHeader("Content-Disposition", `attachment; filename="${row.fileName.replace(/"/g, "")}"`);
    res.send(Buffer.from(b64, "base64"));
    return;
  }

  res.json({
    id: row.id,
    fileName: row.fileName,
    mimeType: row.mimeType,
    fileSizeBytes: row.fileSizeBytes,
    category: row.category,
    note: row.note,
    uploadedAt: row.uploadedAt,
    dataBase64: b64,
  });
});

// ── PATCH /vault/:id/attachments/:attachmentId — rename / recategorize ─────
router.patch("/vault/:id/attachments/:attachmentId", requireAuth, requireVaultAttachmentEntityOwnership("vault_entry.attachments.update"), async (req, res): Promise<void> => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }

  const entityId = parseInt(String(req.params.id), 10);
  const attachmentId = parseInt(String(req.params.attachmentId), 10);
  if (!Number.isFinite(entityId) || !Number.isFinite(attachmentId)) { res.status(400).json({ error: "Invalid id" }); return; }
  if (!(await assertEntityOwnership(entityId, userId))) { res.status(404).json({ error: "Entity not found" }); return; }

  const { fileName, category, note } = req.body ?? {};
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (fileName !== undefined) {
    if (typeof fileName !== "string" || !fileName.trim()) { res.status(400).json({ error: "Invalid fileName" }); return; }
    updates.fileName = fileName.trim().slice(0, 255);
  }
  if (category !== undefined) {
    if (typeof category !== "string" || !ALLOWED_CATEGORIES.has(category)) { res.status(400).json({ error: "Invalid category" }); return; }
    updates.category = category;
  }
  if (note !== undefined) {
    updates.note = typeof note === "string" && note.trim() ? note.trim().slice(0, 500) : null;
  }

  const result = await db.update(vaultAttachmentsTable)
    .set(updates as any)
    .where(and(
      eq(vaultAttachmentsTable.id, attachmentId),
      eq(vaultAttachmentsTable.vaultEntryId, entityId),
      eq(vaultAttachmentsTable.userId, userId),
    ))
    .returning({ id: vaultAttachmentsTable.id });
  if (!result.length) { res.status(404).json({ error: "Attachment not found" }); return; }

  res.json({ ok: true });
});

// ── DELETE /vault/:id/attachments/:attachmentId ─────────────────────────────
router.delete("/vault/:id/attachments/:attachmentId", requireAuth, requireVaultAttachmentEntityOwnership("vault_entry.attachments.delete"), async (req, res): Promise<void> => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }

  const entityId = parseInt(String(req.params.id), 10);
  const attachmentId = parseInt(String(req.params.attachmentId), 10);
  if (!Number.isFinite(entityId) || !Number.isFinite(attachmentId)) { res.status(400).json({ error: "Invalid id" }); return; }
  if (!(await assertEntityOwnership(entityId, userId))) { res.status(404).json({ error: "Entity not found" }); return; }

  const [row] = await db.delete(vaultAttachmentsTable)
    .where(and(
      eq(vaultAttachmentsTable.id, attachmentId),
      eq(vaultAttachmentsTable.vaultEntryId, entityId),
      eq(vaultAttachmentsTable.userId, userId),
    ))
    .returning({ id: vaultAttachmentsTable.id, fileName: vaultAttachmentsTable.fileName });
  if (!row) { res.status(404).json({ error: "Attachment not found" }); return; }

  await logActivity(userId, "vault_attachment_deleted", "vault_entry", entityId, row.fileName, { attachmentId });
  res.json({ ok: true });
});

export default router;
