/**
 * routes/ayzen-mailbox.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * The native ayzen.tech mailbox — full folder system (Inbox, Sent, Drafts,
 * Archive, Trash, plus user-created custom folders — see
 * migrations/037_ayzen_mailbox_folders.sql), single message + body, send,
 * drafts, and switching a user's AYZEN Email from "forward" (Cloudflare Email
 * Routing, unchanged) to "native" (stored here, received via Resend Inbound —
 * see routes/resend-webhook.ts).
 */
import { Router, type Request, type Response } from "express";
import express from "express";
import {
  db, usersTable, ayzenMailboxMessagesTable, ayzenMailboxAttachmentsTable, ayzenMailboxFoldersTable,
  ayzenMailboxLabelsTable, ayzenMailboxMessageLabelsTable, ayzenMailboxRulesTable, ayzenContactsTable,
  ayzenMailboxSendQueueTable, ayzenMailboxTemplatesTable,
  AYZEN_MAILBOX_SYSTEM_FOLDERS, AYZEN_LABEL_COLORS, AYZEN_RULE_FIELDS, AYZEN_RULE_MATCH_TYPES,
  type AyzenMailboxSystemFolder,
} from "@workspace/db";
import { eq, and, desc, count, inArray, sql, ilike, gte, lte, ne } from "drizzle-orm";
import { requireAuth, requireAdmin, pepDecisionObserver } from "../middlewares/auth";
import { requireCreditBalance, chargeCredits } from "../services/credit-meter";
import { requireOwnership, authorizeMany, allowedKeys } from "../lib/policy/pep";
import type { ResourceRefBuilder } from "../lib/policy/pep/types";
import type { ResourceRef } from "../lib/policy/types";
import { PolicyEngine } from "../lib/policy/policy-engine";
import { createResourceOwnershipRule } from "../lib/policy/resource";
import { getResendConfig } from "../lib/resend-mail";
import { resolveThreadId } from "../lib/mail-threading";
import { applyRulesToExistingMail } from "../lib/mail-rules";
import { encryptField, decryptField } from "../lib/vault-crypto";
import { buildZip, dedupeNames } from "../lib/zip-writer";
import { resolveAttachmentContent } from "../lib/mail-attachment-content";
import { parseMailSearchQuery } from "../lib/mail-search-query";
import { setSenderStatus, recordSpamReport, clearSenderSpamFlags, listSenders, extractEmail, extractAllEmails } from "../lib/mail-spam";
import { listProblematicRecipients, clearRecipientFlag, checkOutboundRecipients } from "../lib/mail-recipient-reputation";
import { getSendingHealth, resumeSendingHealth } from "../lib/mail-sending-health";
import { getSendingConfig, updateSendingConfig } from "../lib/mail-sending-config";
import { enqueueSend, UNDO_SEND_WINDOW_MS, clampUndoSendWindowMs } from "../lib/mail-send-queue";

const router = Router();

// Raw (pre-base64) per-attachment size cap, same limit as vault-attachments —
// this is still a TEXT-column store, not object storage. Compose bodies with
// attachments need a bigger JSON limit than the app-wide default, scoped to
// just the send/draft routes.
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const sendBodyParser = express.json({ limit: "12mb" });

function getUserId(req: any): number { return req.user!.userId; }

const SYSTEM_FOLDER_SET = new Set<string>(AYZEN_MAILBOX_SYSTEM_FOLDERS);
const FOLDER_LABELS: Record<AyzenMailboxSystemFolder, string> = {
  inbox: "Inbox", snoozed: "Snoozed", sent: "Sent", scheduled: "Scheduled", drafts: "Drafts", spam: "Spam", archive: "Archive", trash: "Trash",
};

// Folders that only the dedicated routes below (snooze/unsnooze,
// send-with-scheduledSendAt/reschedule/cancel-schedule) may put a message
// into or out of, because they carry state (snoozedUntil / scheduledSendAt)
// the generic move/bulk-move routes don't know to set. Filtered out of the
// folder lists those routes accept as a target.
const NON_MOVE_TARGET_FOLDERS = new Set<string>(["snoozed", "scheduled", "outbox"]);

// Sweeps this user's expired snoozes back to Inbox. Cheap (indexed, scoped
// to one user) and called at the top of every read route that reports
// folder membership or counts, so nothing needs a cron job to "wake up" a
// snoozed message on time.
async function sweepExpiredSnoozes(userId: number): Promise<void> {
  await db.update(ayzenMailboxMessagesTable)
    .set({ folder: "inbox", snoozedUntil: null })
    .where(and(
      eq(ayzenMailboxMessagesTable.userId, userId),
      eq(ayzenMailboxMessagesTable.folder, "snoozed"),
      sql`${ayzenMailboxMessagesTable.snoozedUntil} <= now()`,
    ));
}

// Batch-fetches labels for a set of message ids in one query — used
// everywhere a list of messages is returned so we don't do one query per
// row. Returns a Map so callers can look up `labelsByMessage.get(id) ?? []`.
async function getLabelsForMessages(messageIds: number[]): Promise<Map<number, { id: number; name: string; color: string }[]>> {
  const out = new Map<number, { id: number; name: string; color: string }[]>();
  if (!messageIds.length) return out;
  const rows = await db.select({
    messageId: ayzenMailboxMessageLabelsTable.messageId,
    id: ayzenMailboxLabelsTable.id,
    name: ayzenMailboxLabelsTable.name,
    color: ayzenMailboxLabelsTable.color,
  }).from(ayzenMailboxMessageLabelsTable)
    .innerJoin(ayzenMailboxLabelsTable, eq(ayzenMailboxLabelsTable.id, ayzenMailboxMessageLabelsTable.labelId))
    .where(inArray(ayzenMailboxMessageLabelsTable.messageId, messageIds));
  for (const r of rows) {
    const list = out.get(r.messageId) ?? [];
    list.push({ id: r.id, name: r.name, color: r.color });
    out.set(r.messageId, list);
  }
  return out;
}

function fmt(m: typeof ayzenMailboxMessagesTable.$inferSelect, labels?: { id: number; name: string; color: string }[]) {
  return {
    id: m.id,
    direction: m.direction,
    folder: m.folder,
    folderId: m.folderId,
    isDraft: m.isDraft,
    from: m.fromAddr,
    to: m.toAddr,
    cc: m.ccAddr,
    bcc: m.bccAddr,
    subject: m.subject,
    hasAttachments: m.hasAttachments,
    isRead: m.isRead,
    isStarred: m.isStarred,
    snoozedUntil: m.snoozedUntil?.toISOString() ?? null,
    // Only meaningful while folder === "scheduled" — see the column comment
    // in lib/db/src/schema/ayzen-mailbox.ts.
    scheduledSendAt: m.scheduledSendAt?.toISOString() ?? null,
    // Delivery Tracking — see migrations/050_ayzen_mailbox_delivery_tracking.sql.
    // Null for inbound mail and for outbound rows sent before this existed.
    deliveryStatus: m.deliveryStatus,
    deliveryStatusAt: m.deliveryStatusAt?.toISOString() ?? null,
    bounceReason: m.bounceReason,
    // Bounce + Complaint Handling (Phase 1) — see
    // migrations/052_ayzen_mailbox_bounce_complaint.sql. Null unless
    // Resend has reported this outbound message as a spam complaint.
    complainedAt: m.complainedAt?.toISOString() ?? null,
    // Undo Send (Phase 2) — see migrations/051_ayzen_mailbox_undo_send_phase2.sql.
    // Only meaningful while folder === "outbox"; drives the persistent
    // "Undo (Ns)" chip in the Outbox list (as opposed to Phase 1's
    // toast-only affordance), straight off this same GET data.
    undoExpiresAt: m.undoExpiresAt?.toISOString() ?? null,
    labels: labels ?? [],
    forwardedTo: m.forwardedTo,
    // BUG FIX: this was never sent to the frontend, so the reply flow had no
    // way to thread correctly and fell back to passing the DB row's numeric
    // `id` as the In-Reply-To header (see routes/ayzen-mailbox.ts send route
    // + pages/user/mailbox.tsx) — an integer is not a valid RFC Message-ID,
    // so replies never threaded in the recipient's mail client.
    messageId: m.messageId,
    // References header this message carried (or was sent with) — the
    // frontend needs it to build the *next* reply's References chain
    // without a round-trip, and threadId to fetch the full conversation.
    references: m.referencesHeader,
    threadId: m.threadId,
    receivedAt: m.receivedAt?.toISOString() ?? null,
    createdAt: m.createdAt.toISOString(),
  };
}

// Splits a from/to address into { email, name } — handles both the plain
// "someone@example.com" a compose box's To field produces and the RFC
// '"Someone" <someone@example.com>' shape inbound mail (via Resend) often
// carries. Always lowercases the email so the same person doesn't get
// counted as two correspondents just because one message capitalized it
// differently. Shared by Mail Analytics and Contact Intelligence below.
function parseAddr(raw: string): { email: string; name: string | null } {
  const first = raw.split(",")[0]?.trim() ?? raw.trim();
  const m = first.match(/^"?([^"<]*)"?\s*<([^>]+)>$/);
  if (m) {
    const name = m[1]!.trim();
    return { email: m[2]!.trim().toLowerCase(), name: name || null };
  }
  return { email: first.toLowerCase(), name: null };
}

// Folds one message's correspondent into the running per-address tally used
// by GET /mailbox/analytics's topCorrespondents list.
function bumpCorrespondent(
  map: Map<string, { name: string | null; count: number; lastInteraction: Date }>,
  email: string, name: string | null, at: Date,
): void {
  const existing = map.get(email);
  if (!existing) { map.set(email, { name, count: 1, lastInteraction: at }); return; }
  existing.count += 1;
  if (!existing.name && name) existing.name = name;
  if (at > existing.lastInteraction) existing.lastInteraction = at;
}

// Resolves + validates the `folder` (+ optional `folderId`) a request wants
// to read from or move a message into. Shared by the list route and the
// move route so both enforce the same rules (custom folders must exist and
// belong to the caller).
async function resolveFolderTarget(
  userId: number,
  folder: unknown,
  folderId: unknown,
): Promise<{ ok: true; folder: string; folderId: number | null } | { ok: false; error: string }> {
  const f = String(folder ?? "inbox");
  if (f === "custom") {
    const fid = parseInt(String(folderId ?? ""), 10);
    if (!Number.isFinite(fid)) return { ok: false, error: "folderId is required when folder is 'custom'" };
    const [row] = await db.select().from(ayzenMailboxFoldersTable)
      .where(and(eq(ayzenMailboxFoldersTable.id, fid), eq(ayzenMailboxFoldersTable.userId, userId)));
    if (!row) return { ok: false, error: "Folder not found" };
    return { ok: true, folder: "custom", folderId: fid };
  }
  if (!SYSTEM_FOLDER_SET.has(f)) return { ok: false, error: `Unknown folder "${f}"` };
  return { ok: true, folder: f, folderId: null };
}

// Same as resolveFolderTarget, but also rejects folders that need dedicated
// state alongside them (currently just 'snoozed') — for the generic
// move/bulk-move routes, which only ever set `folder`/`folderId`. Reading
// *from* 'snoozed' (GET /mailbox?folder=snoozed) still goes through
// resolveFolderTarget directly, since that's just a list, not a move.
async function resolveMoveTarget(
  userId: number,
  folder: unknown,
  folderId: unknown,
): Promise<{ ok: true; folder: string; folderId: number | null } | { ok: false; error: string }> {
  const target = await resolveFolderTarget(userId, folder, folderId);
  if (!target.ok) return target;
  if (NON_MOVE_TARGET_FOLDERS.has(target.folder)) {
    return { ok: false, error: `Use the snooze action to move a message into "${target.folder}"` };
  }
  return target;
}

// ─── Route Integration Roadmap — Season C, Phase C10 (mechanical sweep, batch 10) ─
// The file Phase C7 flagged as needing "its own dedicated phase" (2300+
// lines, several independent resource types). This phase covers ONLY the
// four small, single-table settings-style resources — folders, labels,
// templates, rules — each already scoped by the same hand-rolled
// `and(eq(table.id, id), eq(table.userId, userId))` combined-where this
// series has migrated everywhere else. The much bigger, central resource
// in this file — the mailbox message itself (everything from `GET
// /ayzen-email/mailbox` at line ~746 onward: thread/quick-action/search/
// analytics/contacts/senders/problematic-recipients/sending-health/the
// individual message actions — star/read/snooze/reschedule/undo-send/
// move/mark-spam/bulk/delete/drafts/send) — is deliberately left for a
// later phase; it's one resource with 20+ verbs and deserves its own
// focused pass rather than being rushed into the same batch as four
// simple settings objects.
//
// `PATCH /ayzen-email/mailbox/:id/labels` is NOT touched here even though
// it lives in the "Labels" section below — its `:id` is a *message* id
// (`ayzenMailboxMessagesTable`), not a label id. That's message-resource
// scope, grouped with the deferred batch above, not with this phase's
// label/folder/template/rule resources.
const AYZEN_FOLDER_OWNER_SENTINEL_NONE = -1;
const AYZEN_LABEL_OWNER_SENTINEL_NONE = -1;
const AYZEN_TEMPLATE_OWNER_SENTINEL_NONE = -1;
const AYZEN_RULE_OWNER_SENTINEL_NONE = -1;

const ayzenFolderResource: ResourceRefBuilder = async (req: Request) => {
  const id = parseInt(req.params.id as string, 10);
  if (!Number.isFinite(id)) return { type: "ayzen_mailbox_folder", id: req.params.id, ownerId: AYZEN_FOLDER_OWNER_SENTINEL_NONE };
  const [row] = await db.select({ userId: ayzenMailboxFoldersTable.userId }).from(ayzenMailboxFoldersTable)
    .where(eq(ayzenMailboxFoldersTable.id, id)).limit(1);
  return { type: "ayzen_mailbox_folder", id, ownerId: row?.userId ?? AYZEN_FOLDER_OWNER_SENTINEL_NONE };
};

const ayzenLabelResource: ResourceRefBuilder = async (req: Request) => {
  const id = parseInt(req.params.id as string, 10);
  if (!Number.isFinite(id)) return { type: "ayzen_mailbox_label", id: req.params.id, ownerId: AYZEN_LABEL_OWNER_SENTINEL_NONE };
  const [row] = await db.select({ userId: ayzenMailboxLabelsTable.userId }).from(ayzenMailboxLabelsTable)
    .where(eq(ayzenMailboxLabelsTable.id, id)).limit(1);
  return { type: "ayzen_mailbox_label", id, ownerId: row?.userId ?? AYZEN_LABEL_OWNER_SENTINEL_NONE };
};

const ayzenTemplateResource: ResourceRefBuilder = async (req: Request) => {
  const id = parseInt(req.params.id as string, 10);
  if (!Number.isFinite(id)) return { type: "ayzen_mailbox_template", id: req.params.id, ownerId: AYZEN_TEMPLATE_OWNER_SENTINEL_NONE };
  const [row] = await db.select({ userId: ayzenMailboxTemplatesTable.userId }).from(ayzenMailboxTemplatesTable)
    .where(eq(ayzenMailboxTemplatesTable.id, id)).limit(1);
  return { type: "ayzen_mailbox_template", id, ownerId: row?.userId ?? AYZEN_TEMPLATE_OWNER_SENTINEL_NONE };
};

const ayzenRuleResource: ResourceRefBuilder = async (req: Request) => {
  const id = parseInt(req.params.id as string, 10);
  if (!Number.isFinite(id)) return { type: "ayzen_mailbox_rule", id: req.params.id, ownerId: AYZEN_RULE_OWNER_SENTINEL_NONE };
  const [row] = await db.select({ userId: ayzenMailboxRulesTable.userId }).from(ayzenMailboxRulesTable)
    .where(eq(ayzenMailboxRulesTable.id, id)).limit(1);
  return { type: "ayzen_mailbox_rule", id, ownerId: row?.userId ?? AYZEN_RULE_OWNER_SENTINEL_NONE };
};

// Every route in this phase's scope shares the exact same 404 shape as its
// existing hand-rolled check (`{ error: "<Thing> not found" }`) — one small
// parameterized helper instead of four near-identical ones.
function requireAyzenMailboxSubOwnership(resource: ResourceRefBuilder, action: string, notFoundLabel: string) {
  return requireOwnership(action, resource, {
    onDecision: pepDecisionObserver,
    onDeny: (_req: Request, res: Response) => {
      res.status(404).json({ error: `${notFoundLabel} not found` });
    },
  });
}

// ─── Route Integration Roadmap — Season C, Phase C11+C12 (mechanical sweep,
// batches 11-12: the message resource itself) ─────────────────────────────
// Phase C10 deliberately left the file's biggest resource — the mailbox
// message (`ayzenMailboxMessagesTable`) — for a later, focused pass: 20+
// verbs, all sharing the same `and(eq(...id, id), eq(...userId, userId))`
// hand-rolled scoping this series has migrated everywhere else. This one
// `ResourceRefBuilder` + parameterized helper covers every single-message-id
// route in both C11 and C12 — they're the same resource type, just a
// different `action` (and, for the handful of routes whose pre-existing
// 404 body says something more specific than "Message not found", a
// different `notFoundError`) per route.
//
// C11 (batch 11) wires the read/tag half: GET /:id, GET
// /:id/attachments/download-all, GET /:id/attachments/:attachmentId, PATCH
// /:id/labels (the one route C10 explicitly flagged as message-resource
// scope and deferred), /:id/star, /:id/read, /:id/snooze, /:id/unsnooze.
//
// C12 (batch 12) wires the folder-transition / send-lifecycle half: PATCH
// /:id/reschedule, /:id/cancel-schedule, /:id/undo-send, /:id/move,
// /:id/mark-spam, /:id/not-spam, DELETE /:id, PATCH /drafts/:id.
//
// Deliberately still NOT touched (same reasoning both phases share): PATCH
// /mailbox/bulk (an array of ids, not a single resource ref — a bulk
// ownership check is its own PEP shape, not this one) and GET
// /mailbox/thread/:threadId + PATCH /mailbox/thread/:threadId/quick-action
// (threadId is not a single-row primary key with one owner column the way
// every other resource in this series has been — it's a filter across
// however many of the caller's own rows share that thread, already scoped
// by embedding `eq(userId, userId)` directly in the query rather than a
// separate lookup-then-compare). Both are left as candidates for a future,
// dedicated phase, same as C9/C10 left other shapes for later batches.
const AYZEN_MAILBOX_MESSAGE_OWNER_SENTINEL_NONE = -1;

const ayzenMailboxMessageResource: ResourceRefBuilder = async (req: Request) => {
  const id = parseInt(req.params.id as string, 10);
  if (!Number.isFinite(id)) return { type: "ayzen_mailbox_message", id: req.params.id, ownerId: AYZEN_MAILBOX_MESSAGE_OWNER_SENTINEL_NONE };
  const [row] = await db.select({ userId: ayzenMailboxMessagesTable.userId }).from(ayzenMailboxMessagesTable)
    .where(eq(ayzenMailboxMessagesTable.id, id)).limit(1);
  return { type: "ayzen_mailbox_message", id, ownerId: row?.userId ?? AYZEN_MAILBOX_MESSAGE_OWNER_SENTINEL_NONE };
};

// Most of these routes' pre-existing 404 is the plain `{ error: "Message
// not found" }` every other message route already used, so that's the
// default — but PATCH /:id/unsnooze, /:id/cancel-schedule, and /:id/not-spam
// combined the ownership check with a folder-state check in one query and
// returned a more specific body ("...in Snoozed" / "...in Scheduled" /
// "...in Spam") regardless of *which* half failed. Since this gate only
// ever checks ownership (the folder-state half stays exactly where it was,
// in the handler, unchanged), a non-owner now gets that same specific body
// from `onDeny` — preserving the pre-existing "can't tell ownership-miss
// apart from wrong-folder" behavior — while an owner-but-wrong-folder
// request still falls through to the handler's own unchanged check.
function requireAyzenMailboxMessageOwnership(action: string, notFoundError: string = "Message not found") {
  return requireOwnership(action, ayzenMailboxMessageResource, {
    onDecision: pepDecisionObserver,
    onDeny: (_req: Request, res: Response) => {
      res.status(404).json({ error: notFoundError });
    },
  });
}

// Two of the GET .../:id/attachments/... routes (below) pre-check
// `Number.isFinite(id)` themselves and answer a non-numeric id with
// `400 { error: "Invalid id" }` *before* ever doing their ownership lookup
// — unlike every other route in this batch, which just let a NaN id fall
// through to a query that matches nothing and 404s. The generic
// `onDeny` above can't tell "invalid input" apart from "not found"/"not
// yours" (the resource builder folds a non-finite id into the same owner
// sentinel used for "no such row"), so gating those two routes with it
// as-is would turn a non-numeric id from 400 into 404 — an actual
// behavior change. This variant re-derives that same distinction in
// `onDeny` so both pre-existing response shapes survive unchanged.
function requireAyzenMailboxMessageOwnershipStrictId(action: string) {
  return requireOwnership(action, ayzenMailboxMessageResource, {
    onDecision: pepDecisionObserver,
    onDeny: (req: Request, res: Response) => {
      const id = parseInt(req.params.id as string, 10);
      if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid id" }); return; }
      res.status(404).json({ error: "Message not found" });
    },
  });
}

// ─── Folders ────────────────────────────────────────────────────────────────

// GET /ayzen-email/mailbox/folders — the 5 system folders (with counts) plus
// every custom folder the user has created, for rendering the folder list.
router.get("/ayzen-email/mailbox/folders", requireAuth, async (req, res): Promise<void> => {
  const userId = getUserId(req);
  await sweepExpiredSnoozes(userId);

  const rows = await db.select({ folder: ayzenMailboxMessagesTable.folder, folderId: ayzenMailboxMessagesTable.folderId, isRead: ayzenMailboxMessagesTable.isRead, direction: ayzenMailboxMessagesTable.direction })
    .from(ayzenMailboxMessagesTable).where(eq(ayzenMailboxMessagesTable.userId, userId));

  const systemCounts = new Map<string, { count: number; unread: number }>();
  for (const key of AYZEN_MAILBOX_SYSTEM_FOLDERS) systemCounts.set(key, { count: 0, unread: 0 });
  const customCounts = new Map<number, { count: number; unread: number }>();

  for (const r of rows) {
    if (r.folder === "custom" && r.folderId != null) {
      const c = customCounts.get(r.folderId) ?? { count: 0, unread: 0 };
      c.count += 1;
      // Unread only means something for mail that came in — sent items and
      // drafts are always "read" from the owner's own perspective.
      if (!r.isRead && r.direction === "inbound") c.unread += 1;
      customCounts.set(r.folderId, c);
    } else {
      const c = systemCounts.get(r.folder) ?? { count: 0, unread: 0 };
      c.count += 1;
      if (!r.isRead && r.direction === "inbound") c.unread += 1;
      systemCounts.set(r.folder, c);
    }
  }

  const customFolders = await db.select().from(ayzenMailboxFoldersTable)
    .where(eq(ayzenMailboxFoldersTable.userId, userId)).orderBy(ayzenMailboxFoldersTable.name);

  res.json({
    system: AYZEN_MAILBOX_SYSTEM_FOLDERS.map((key) => ({
      key, label: FOLDER_LABELS[key],
      count: systemCounts.get(key)!.count, unread: systemCounts.get(key)!.unread,
    })),
    custom: customFolders.map((f) => ({
      id: f.id, name: f.name,
      count: customCounts.get(f.id)?.count ?? 0, unread: customCounts.get(f.id)?.unread ?? 0,
    })),
  });
});

// GET /ayzen-email/mailbox/unread-summary — a small, cheap-to-poll endpoint
// for the "new mail" notification: just the Inbox unread count plus the
// single newest unread inbound message (for the notification's title/body).
// Deliberately not the same as /mailbox/folders' unread numbers — those
// cover every folder (useful for the folder rail's badges) but firing a
// desktop notification off e.g. a newly-unread message in a custom folder
// would be surprising, so this only ever looks at Inbox, matching how
// every mainstream mail client scopes its "new mail" badge/sound.
router.get("/ayzen-email/mailbox/unread-summary", requireAuth, async (req, res): Promise<void> => {
  const userId = getUserId(req);
  await sweepExpiredSnoozes(userId);
  const [{ value: unreadCount }] = await db.select({ value: count() }).from(ayzenMailboxMessagesTable)
    .where(and(eq(ayzenMailboxMessagesTable.userId, userId), eq(ayzenMailboxMessagesTable.folder, "inbox"), eq(ayzenMailboxMessagesTable.direction, "inbound"), eq(ayzenMailboxMessagesTable.isRead, false)));

  const [latest] = await db.select().from(ayzenMailboxMessagesTable)
    .where(and(eq(ayzenMailboxMessagesTable.userId, userId), eq(ayzenMailboxMessagesTable.folder, "inbox"), eq(ayzenMailboxMessagesTable.direction, "inbound"), eq(ayzenMailboxMessagesTable.isRead, false)))
    .orderBy(desc(ayzenMailboxMessagesTable.createdAt)).limit(1);

  res.json({
    unreadCount,
    latest: latest ? { id: latest.id, from: latest.fromAddr, subject: latest.subject, threadId: latest.threadId } : null,
  });
});

router.post("/ayzen-email/mailbox/folders", requireAuth, async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const name = String((req.body as { name?: string })?.name ?? "").trim().slice(0, 60);
  if (!name) { res.status(400).json({ error: "Folder name is required" }); return; }
  if (SYSTEM_FOLDER_SET.has(name.toLowerCase()) || name.toLowerCase() === "custom") {
    res.status(400).json({ error: `"${name}" is a reserved folder name` }); return;
  }

  try {
    const [row] = await db.insert(ayzenMailboxFoldersTable).values({ userId, name }).returning();
    res.status(201).json({ id: row.id, name: row.name, count: 0, unread: 0 });
  } catch (err: any) {
    // Unique index on (user_id, lower(name)) — see migration 037.
    if (String(err?.message ?? "").includes("ayzen_mailbox_folders_user_name_key")) {
      res.status(409).json({ error: `You already have a folder named "${name}"` }); return;
    }
    throw err;
  }
});

router.patch("/ayzen-email/mailbox/folders/:id", requireAuth, requireAyzenMailboxSubOwnership(ayzenFolderResource, "ayzen_mailbox_folder.update", "Folder"), async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const id = parseInt(req.params.id as string, 10);
  const name = String((req.body as { name?: string })?.name ?? "").trim().slice(0, 60);
  if (!name) { res.status(400).json({ error: "Folder name is required" }); return; }
  if (SYSTEM_FOLDER_SET.has(name.toLowerCase()) || name.toLowerCase() === "custom") {
    res.status(400).json({ error: `"${name}" is a reserved folder name` }); return;
  }

  try {
    const [row] = await db.update(ayzenMailboxFoldersTable).set({ name })
      .where(and(eq(ayzenMailboxFoldersTable.id, id), eq(ayzenMailboxFoldersTable.userId, userId))).returning();
    if (!row) { res.status(404).json({ error: "Folder not found" }); return; }
    res.json({ id: row.id, name: row.name });
  } catch (err: any) {
    if (String(err?.message ?? "").includes("ayzen_mailbox_folders_user_name_key")) {
      res.status(409).json({ error: `You already have a folder named "${name}"` }); return;
    }
    throw err;
  }
});

// DELETE /ayzen-email/mailbox/folders/:id — deletes the folder itself; any
// messages inside it move to Archive rather than being deleted, so removing
// a folder can never silently destroy mail.
router.delete("/ayzen-email/mailbox/folders/:id", requireAuth, requireAyzenMailboxSubOwnership(ayzenFolderResource, "ayzen_mailbox_folder.delete", "Folder"), async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const id = parseInt(req.params.id as string, 10);

  const [folder] = await db.select().from(ayzenMailboxFoldersTable)
    .where(and(eq(ayzenMailboxFoldersTable.id, id), eq(ayzenMailboxFoldersTable.userId, userId)));
  if (!folder) { res.status(404).json({ error: "Folder not found" }); return; }

  await db.update(ayzenMailboxMessagesTable).set({ folder: "archive", folderId: null })
    .where(and(eq(ayzenMailboxMessagesTable.userId, userId), eq(ayzenMailboxMessagesTable.folder, "custom"), eq(ayzenMailboxMessagesTable.folderId, id)));
  await db.delete(ayzenMailboxFoldersTable).where(eq(ayzenMailboxFoldersTable.id, id));

  res.json({ ok: true });
});

// ─── Labels ─────────────────────────────────────────────────────────────────
// Colored tags a message can carry alongside its folder — see
// migrations/042_ayzen_mailbox_labels_filters_rules.sql. Many-to-many
// (a message can carry several), unlike folders which are exclusive.

// GET /ayzen-email/mailbox/labels — every label the user has, with counts
// (how many messages currently carry it), for the Labels rail + label
// picker dropdown.
router.get("/ayzen-email/mailbox/labels", requireAuth, async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const labels = await db.select().from(ayzenMailboxLabelsTable)
    .where(eq(ayzenMailboxLabelsTable.userId, userId)).orderBy(ayzenMailboxLabelsTable.name);

  const counts = await db.select({ labelId: ayzenMailboxMessageLabelsTable.labelId, value: count() })
    .from(ayzenMailboxMessageLabelsTable)
    .innerJoin(ayzenMailboxMessagesTable, eq(ayzenMailboxMessagesTable.id, ayzenMailboxMessageLabelsTable.messageId))
    .where(eq(ayzenMailboxMessagesTable.userId, userId))
    .groupBy(ayzenMailboxMessageLabelsTable.labelId);
  const countByLabel = new Map(counts.map((c) => [c.labelId, c.value]));

  res.json({
    labels: labels.map((l) => ({ id: l.id, name: l.name, color: l.color, count: countByLabel.get(l.id) ?? 0 })),
    colors: AYZEN_LABEL_COLORS,
  });
});

router.post("/ayzen-email/mailbox/labels", requireAuth, async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const { name: rawName, color: rawColor } = req.body as { name?: string; color?: string };
  const name = String(rawName ?? "").trim().slice(0, 40);
  if (!name) { res.status(400).json({ error: "Label name is required" }); return; }
  const color = (AYZEN_LABEL_COLORS as readonly string[]).includes(String(rawColor)) ? (rawColor as string) : "sky";

  try {
    const [row] = await db.insert(ayzenMailboxLabelsTable).values({ userId, name, color }).returning();
    res.status(201).json({ id: row.id, name: row.name, color: row.color, count: 0 });
  } catch (err: any) {
    if (String(err?.message ?? "").includes("ayzen_mailbox_labels_user_name_key")) {
      res.status(409).json({ error: `You already have a label named "${name}"` }); return;
    }
    throw err;
  }
});

router.patch("/ayzen-email/mailbox/labels/:id", requireAuth, requireAyzenMailboxSubOwnership(ayzenLabelResource, "ayzen_mailbox_label.update", "Label"), async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const id = parseInt(req.params.id as string, 10);
  const { name: rawName, color: rawColor } = req.body as { name?: string; color?: string };

  const patch: Partial<typeof ayzenMailboxLabelsTable.$inferInsert> = {};
  if (rawName !== undefined) {
    const name = String(rawName).trim().slice(0, 40);
    if (!name) { res.status(400).json({ error: "Label name is required" }); return; }
    patch.name = name;
  }
  if (rawColor !== undefined) {
    if (!(AYZEN_LABEL_COLORS as readonly string[]).includes(String(rawColor))) { res.status(400).json({ error: "Invalid color" }); return; }
    patch.color = rawColor;
  }

  try {
    const [row] = await db.update(ayzenMailboxLabelsTable).set(patch)
      .where(and(eq(ayzenMailboxLabelsTable.id, id), eq(ayzenMailboxLabelsTable.userId, userId))).returning();
    if (!row) { res.status(404).json({ error: "Label not found" }); return; }
    res.json({ id: row.id, name: row.name, color: row.color });
  } catch (err: any) {
    if (String(err?.message ?? "").includes("ayzen_mailbox_labels_user_name_key")) {
      res.status(409).json({ error: `You already have a label named "${patch.name}"` }); return;
    }
    throw err;
  }
});

// DELETE /ayzen-email/mailbox/labels/:id — deletes the label; the join
// table row (ON DELETE CASCADE) is dropped for every message that had it,
// so those messages just lose the tag rather than being touched otherwise.
router.delete("/ayzen-email/mailbox/labels/:id", requireAuth, requireAyzenMailboxSubOwnership(ayzenLabelResource, "ayzen_mailbox_label.delete", "Label"), async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const id = parseInt(req.params.id as string, 10);
  const [row] = await db.delete(ayzenMailboxLabelsTable)
    .where(and(eq(ayzenMailboxLabelsTable.id, id), eq(ayzenMailboxLabelsTable.userId, userId))).returning();
  if (!row) { res.status(404).json({ error: "Label not found" }); return; }
  res.json({ ok: true });
});

// PATCH /ayzen-email/mailbox/:id/labels — body { labelIds: number[] }
// Replaces the full set of labels on a message in one call (simplest shape
// for a multi-select label picker — the client sends the complete desired
// set rather than individual add/remove calls).
router.patch("/ayzen-email/mailbox/:id/labels", requireAuth, requireAyzenMailboxMessageOwnership("ayzen_mailbox_message.labels.update"), async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const id = parseInt(req.params.id as string, 10);
  const { labelIds } = req.body as { labelIds?: number[] };

  const [message] = await db.select({ id: ayzenMailboxMessagesTable.id }).from(ayzenMailboxMessagesTable)
    .where(and(eq(ayzenMailboxMessagesTable.id, id), eq(ayzenMailboxMessagesTable.userId, userId)));
  if (!message) { res.status(404).json({ error: "Message not found" }); return; }

  const requested = Array.from(new Set((labelIds ?? []).filter((n) => Number.isFinite(n))));
  // Only attach labels that actually belong to this user — silently drops
  // anything else rather than erroring, so a stale client-side label list
  // (e.g. one just deleted in another tab) can't 400 the whole save.
  const owned = requested.length
    ? (await db.select({ id: ayzenMailboxLabelsTable.id }).from(ayzenMailboxLabelsTable)
        .where(and(inArray(ayzenMailboxLabelsTable.id, requested), eq(ayzenMailboxLabelsTable.userId, userId)))).map((r) => r.id)
    : [];

  await db.delete(ayzenMailboxMessageLabelsTable).where(eq(ayzenMailboxMessageLabelsTable.messageId, id));
  if (owned.length) {
    await db.insert(ayzenMailboxMessageLabelsTable).values(owned.map((labelId) => ({ messageId: id, labelId })));
  }

  const labels = await db.select({ id: ayzenMailboxLabelsTable.id, name: ayzenMailboxLabelsTable.name, color: ayzenMailboxLabelsTable.color })
    .from(ayzenMailboxLabelsTable).where(inArray(ayzenMailboxLabelsTable.id, owned));
  res.json({ id, labels });
});

// ─── Compose Templates ───────────────────────────────────────────────────────
// Reusable "canned response" subject/body pairs the compose box can insert,
// or save the message currently being written as — see
// migrations/056_ayzen_mailbox_templates.sql. bodyHtml is encrypted at rest
// the same way message bodies are (encryptField/decryptField), so every
// route below decrypts on the way out and encrypts on the way in, same as
// the drafts/send routes further down do for textBody/htmlBody.

const MAX_TEMPLATE_NAME_LEN = 60;
const MAX_TEMPLATE_SUBJECT_LEN = 998; // matches the practical RFC 5322 subject line cap used elsewhere for mail subjects
const MAX_TEMPLATE_BODY_BYTES = 200_000; // generous but bounded, well above a real canned-response body

function fmtTemplate(row: typeof ayzenMailboxTemplatesTable.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    subject: row.subject ?? "",
    bodyHtml: decryptField(row.bodyHtml) ?? "",
    updatedAt: row.updatedAt,
  };
}

// GET /ayzen-email/mailbox/templates — every template the user has, most
// recently updated first, for the compose-box "Insert template" picker and
// the manage-templates dialog (same list backs both).
router.get("/ayzen-email/mailbox/templates", requireAuth, async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const rows = await db.select().from(ayzenMailboxTemplatesTable)
    .where(eq(ayzenMailboxTemplatesTable.userId, userId))
    .orderBy(desc(ayzenMailboxTemplatesTable.updatedAt));
  res.json({ templates: rows.map(fmtTemplate) });
});

// POST /ayzen-email/mailbox/templates — body { name, subject?, bodyHtml? }
// Used both by the manage-templates dialog's "New template" form and by
// the compose box's "Save as template" action (which sends the compose
// box's current subject/body).
// PHASE 5 (admin credit console request): creating a mail template is a
// metered action (wisp.template_use) — charge-on-success, after the row is
// actually inserted (a duplicate-name 409 below never touches the ledger).
router.post("/ayzen-email/mailbox/templates", requireAuth, requireCreditBalance("wisp.template_use"), async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const { name: rawName, subject: rawSubject, bodyHtml: rawBody } = req.body as { name?: string; subject?: string; bodyHtml?: string };
  const name = String(rawName ?? "").trim().slice(0, MAX_TEMPLATE_NAME_LEN);
  if (!name) { res.status(400).json({ error: "Template name is required" }); return; }
  const subject = rawSubject !== undefined ? String(rawSubject).slice(0, MAX_TEMPLATE_SUBJECT_LEN) : null;
  const bodyHtml = rawBody !== undefined ? String(rawBody).slice(0, MAX_TEMPLATE_BODY_BYTES) : null;

  try {
    const [row] = await db.insert(ayzenMailboxTemplatesTable)
      .values({ userId, name, subject, bodyHtml: encryptField(bodyHtml) })
      .returning();
    const charge = await chargeCredits(userId, "wisp.template_use");
    res.status(201).json({ ...fmtTemplate(row), _credits: charge.ok ? { charged: charge.charged, newBalance: charge.newBalance } : null });
  } catch (err: any) {
    if (String(err?.message ?? "").includes("ayzen_mailbox_templates_user_name_key")) {
      res.status(409).json({ error: `You already have a template named "${name}"` }); return;
    }
    throw err;
  }
});

router.patch("/ayzen-email/mailbox/templates/:id", requireAuth, requireAyzenMailboxSubOwnership(ayzenTemplateResource, "ayzen_mailbox_template.update", "Template"), async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const id = parseInt(req.params.id as string, 10);
  const { name: rawName, subject: rawSubject, bodyHtml: rawBody } = req.body as { name?: string; subject?: string; bodyHtml?: string };

  const patch: Partial<typeof ayzenMailboxTemplatesTable.$inferInsert> = { updatedAt: new Date() };
  if (rawName !== undefined) {
    const name = String(rawName).trim().slice(0, MAX_TEMPLATE_NAME_LEN);
    if (!name) { res.status(400).json({ error: "Template name is required" }); return; }
    patch.name = name;
  }
  if (rawSubject !== undefined) patch.subject = String(rawSubject).slice(0, MAX_TEMPLATE_SUBJECT_LEN);
  if (rawBody !== undefined) patch.bodyHtml = encryptField(String(rawBody).slice(0, MAX_TEMPLATE_BODY_BYTES));

  try {
    const [row] = await db.update(ayzenMailboxTemplatesTable).set(patch)
      .where(and(eq(ayzenMailboxTemplatesTable.id, id), eq(ayzenMailboxTemplatesTable.userId, userId))).returning();
    if (!row) { res.status(404).json({ error: "Template not found" }); return; }
    res.json(fmtTemplate(row));
  } catch (err: any) {
    if (String(err?.message ?? "").includes("ayzen_mailbox_templates_user_name_key")) {
      res.status(409).json({ error: `You already have a template named "${patch.name}"` }); return;
    }
    throw err;
  }
});

router.delete("/ayzen-email/mailbox/templates/:id", requireAuth, requireAyzenMailboxSubOwnership(ayzenTemplateResource, "ayzen_mailbox_template.delete", "Template"), async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const id = parseInt(req.params.id as string, 10);
  const [row] = await db.delete(ayzenMailboxTemplatesTable)
    .where(and(eq(ayzenMailboxTemplatesTable.id, id), eq(ayzenMailboxTemplatesTable.userId, userId))).returning();
  if (!row) { res.status(404).json({ error: "Template not found" }); return; }
  res.json({ ok: true });
});

// ─── Rules ──────────────────────────────────────────────────────────────────
// Saved "when inbound mail matches X, do Y" automations — see
// migrations/042_ayzen_mailbox_labels_filters_rules.sql and lib/mail-rules.ts
// for evaluation. Only ever run against INBOUND mail (a rule automating
// your own sent mail doesn't make sense), triggered from
// routes/resend-webhook.ts right after a message is stored.

router.get("/ayzen-email/mailbox/rules", requireAuth, async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const rules = await db.select().from(ayzenMailboxRulesTable)
    .where(eq(ayzenMailboxRulesTable.userId, userId)).orderBy(ayzenMailboxRulesTable.position);
  res.json({ rules, fields: AYZEN_RULE_FIELDS, matchTypes: AYZEN_RULE_MATCH_TYPES });
});

function validateRuleBody(body: any): { error: string } | {
  name: string; field: string; matchType: string; value: string;
  actionLabelId: number | null; actionFolder: string | null; actionFolderId: number | null;
  actionMarkRead: boolean; actionStar: boolean; enabled: boolean;
} {
  const name = String(body?.name ?? "").trim().slice(0, 60);
  if (!name) return { error: "Rule name is required" };
  const field = String(body?.field ?? "from");
  if (!(AYZEN_RULE_FIELDS as readonly string[]).includes(field)) return { error: `field must be one of ${AYZEN_RULE_FIELDS.join(", ")}` };
  const matchType = String(body?.matchType ?? "contains");
  if (!(AYZEN_RULE_MATCH_TYPES as readonly string[]).includes(matchType)) return { error: `matchType must be one of ${AYZEN_RULE_MATCH_TYPES.join(", ")}` };
  const value = String(body?.value ?? "").trim().slice(0, 200);
  if (!value) return { error: "A value to match against is required" };
  const actionFolder = body?.actionFolder ? String(body.actionFolder) : null;
  if (actionFolder && actionFolder !== "custom" && !SYSTEM_FOLDER_SET.has(actionFolder)) return { error: `Unknown target folder "${actionFolder}"` };
  const actionFolderId = body?.actionFolderId != null ? parseInt(String(body.actionFolderId), 10) : null;
  const actionLabelId = body?.actionLabelId != null ? parseInt(String(body.actionLabelId), 10) : null;
  if (!actionLabelId && !actionFolder && !body?.actionMarkRead && !body?.actionStar) {
    return { error: "A rule needs at least one action (add a label, move to a folder, mark as read, or star)" };
  }
  return {
    name, field, matchType, value,
    actionLabelId: Number.isFinite(actionLabelId) ? actionLabelId : null,
    actionFolder, actionFolderId: Number.isFinite(actionFolderId) ? actionFolderId : null,
    actionMarkRead: !!body?.actionMarkRead, actionStar: !!body?.actionStar,
    enabled: body?.enabled === undefined ? true : !!body.enabled,
  };
}

// POST /ayzen-email/mailbox/rules — body matches validateRuleBody's return
// shape, plus optional `applyToExisting: boolean` to immediately run the
// new rule against the user's existing inbound mail (Gmail's "Also apply
// filter to matching conversations" checkbox).
router.post("/ayzen-email/mailbox/rules", requireAuth, async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const parsed = validateRuleBody(req.body);
  if ("error" in parsed) { res.status(400).json({ error: parsed.error }); return; }

  const [{ value: maxPos }] = await db.select({ value: sql<number>`coalesce(max(${ayzenMailboxRulesTable.position}), -1)` })
    .from(ayzenMailboxRulesTable).where(eq(ayzenMailboxRulesTable.userId, userId));

  const [row] = await db.insert(ayzenMailboxRulesTable).values({ userId, position: maxPos + 1, ...parsed }).returning();

  let messagesTouched = 0;
  if ((req.body as any)?.applyToExisting) {
    const result = await applyRulesToExistingMail(userId);
    messagesTouched = result.messagesTouched;
  }

  res.status(201).json({ ...row, messagesTouched });
});

router.patch("/ayzen-email/mailbox/rules/:id", requireAuth, requireAyzenMailboxSubOwnership(ayzenRuleResource, "ayzen_mailbox_rule.update", "Rule"), async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const id = parseInt(req.params.id as string, 10);
  const parsed = validateRuleBody({ ...req.body, name: req.body?.name, value: req.body?.value });
  if ("error" in parsed) { res.status(400).json({ error: parsed.error }); return; }

  const [row] = await db.update(ayzenMailboxRulesTable).set(parsed)
    .where(and(eq(ayzenMailboxRulesTable.id, id), eq(ayzenMailboxRulesTable.userId, userId))).returning();
  if (!row) { res.status(404).json({ error: "Rule not found" }); return; }
  res.json(row);
});

router.delete("/ayzen-email/mailbox/rules/:id", requireAuth, requireAyzenMailboxSubOwnership(ayzenRuleResource, "ayzen_mailbox_rule.delete", "Rule"), async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const id = parseInt(req.params.id as string, 10);
  const [row] = await db.delete(ayzenMailboxRulesTable)
    .where(and(eq(ayzenMailboxRulesTable.id, id), eq(ayzenMailboxRulesTable.userId, userId))).returning();
  if (!row) { res.status(404).json({ error: "Rule not found" }); return; }
  res.json({ ok: true });
});

// ─── Signature ──────────────────────────────────────────────────────────────

// GET /ayzen-email/mailbox/signature — current signature + whether it's
// auto-inserted into new messages. Split out from GET /ayzen-email/status
// (which also reports it, for pages that don't want a second round-trip)
// so the compose box and the signature-editor dialog can fetch just this.
router.get("/ayzen-email/mailbox/signature", requireAuth, async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
  if (!user) { res.status(404).json({ error: "User not found" }); return; }
  res.json({
    signature: user.ayzenMailboxSignature ?? "",
    enabled: user.ayzenMailboxSignatureEnabled,
  });
});

// PATCH /ayzen-email/mailbox/signature — body { signature?: string, enabled?: boolean }
router.patch("/ayzen-email/mailbox/signature", requireAuth, async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const { signature, enabled } = req.body as { signature?: string; enabled?: boolean };

  const patch: Partial<typeof usersTable.$inferInsert> = {};
  // Cap at a generous but bounded size — this is a signature, not a second
  // email body; keeps a runaway paste from bloating every future draft/send.
  if (signature !== undefined) patch.ayzenMailboxSignature = String(signature).slice(0, 20_000);
  if (enabled !== undefined) patch.ayzenMailboxSignatureEnabled = !!enabled;

  const [row] = await db.update(usersTable).set(patch).where(eq(usersTable.id, userId)).returning();
  res.json({
    signature: row.ayzenMailboxSignature ?? "",
    enabled: row.ayzenMailboxSignatureEnabled,
  });
});

// Switch to native mode: mail to username@ayzen.tech is stored here instead
// of only forwarded. Requires the domain to already be verified on Resend —
// see routes/resend-admin.ts for the one-time admin setup. Does NOT go
// through Cloudflare's destination-address verification dance at all —
// that's specific to the "forward" mode this replaces.
router.post("/ayzen-email/claim-native", requireAuth, async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
  if (!user) { res.status(404).json({ error: "User not found" }); return; }

  const cfg = await getResendConfig();
  if (!cfg || !cfg.domainId) {
    res.status(503).json({ error: "Resend Email isn't set up yet. Ask an admin to run domain setup in Admin → Plugins → Resend Email." });
    return;
  }

  const { username, forwardTo } = req.body as { username?: string; forwardTo?: string };
  const clean = String(username ?? user.username).toLowerCase().replace(/[^a-z0-9._-]/g, "");
  if (!clean || clean.length < 3 || clean.length > 30) { res.status(400).json({ error: "Invalid username format" }); return; }

  const ayzenEmail = `${clean}@${cfg.domain}`;
  if (user.ayzenEmail && user.ayzenEmail !== ayzenEmail) {
    const existing = await db.select().from(usersTable).where(eq(usersTable.ayzenEmail, ayzenEmail));
    if (existing.length > 0) { res.status(409).json({ error: "Username already taken" }); return; }
  }

  await db.update(usersTable).set({
    ayzenEmail,
    ayzenEmailMode: "native",
    ayzenEmailVerified: true, // domain-level verification (Resend) already covers this — no per-user step needed
    ayzenEmailForwardTo: forwardTo ? String(forwardTo).trim() : user.ayzenEmailForwardTo,
  }).where(eq(usersTable.id, userId));

  res.status(201).json({ ayzenEmail, mode: "native", message: `${ayzenEmail} is live — mail sent to it now lands in your AYZEN inbox.` });
});

// Message ids (for this user) that carry a given label — used to turn a
// `labelId` filter into a plain WHERE id IN (...) against the messages
// table, since labels are a join table rather than a column there.
async function messageIdsWithLabel(userId: number, labelId: number): Promise<number[]> {
  const rows = await db.select({ id: ayzenMailboxMessagesTable.id }).from(ayzenMailboxMessageLabelsTable)
    .innerJoin(ayzenMailboxMessagesTable, eq(ayzenMailboxMessagesTable.id, ayzenMailboxMessageLabelsTable.messageId))
    .where(and(eq(ayzenMailboxMessageLabelsTable.labelId, labelId), eq(ayzenMailboxMessagesTable.userId, userId)));
  return rows.map((r) => r.id);
}

// Shared "quick filter" query params — Unread / Starred / Has attachment /
// a specific label — combinable with folder and (on /mailbox/search) a
// text query. Returns extra AND conditions, or `null` if a labelId filter
// was given but matches nothing (so callers can short-circuit to an empty
// result instead of running a pointless query).
async function parseQuickFilters(userId: number, query: Record<string, unknown>) {
  const extra: any[] = [];
  if (query.unread === "1") extra.push(and(eq(ayzenMailboxMessagesTable.isRead, false), eq(ayzenMailboxMessagesTable.direction, "inbound")));
  if (query.starred === "1") extra.push(eq(ayzenMailboxMessagesTable.isStarred, true));
  if (query.hasAttachments === "1") extra.push(eq(ayzenMailboxMessagesTable.hasAttachments, true));
  if (query.labelId) {
    const labelId = parseInt(String(query.labelId), 10);
    if (Number.isFinite(labelId)) {
      const ids = await messageIdsWithLabel(userId, labelId);
      if (!ids.length) return null;
      extra.push(inArray(ayzenMailboxMessagesTable.id, ids));
    }
  }
  return extra;
}

// GET /ayzen-email/mailbox?folder=inbox|sent|drafts|archive|trash|custom&folderId=&limit=50&offset=0
// Optional quick filters (combinable with folder): unread=1, starred=1,
// hasAttachments=1, labelId=<id>.
router.get("/ayzen-email/mailbox", requireAuth, async (req, res): Promise<void> => {
  const userId = getUserId(req);
  await sweepExpiredSnoozes(userId);
  const target = await resolveFolderTarget(userId, req.query.folder, req.query.folderId);
  if (!target.ok) { res.status(400).json({ error: target.error }); return; }
  const limit = Math.min(parseInt(String(req.query.limit ?? "50"), 10) || 50, 100);

  const extraFilters = await parseQuickFilters(userId, req.query as Record<string, unknown>);
  if (extraFilters === null) { res.json({ messages: [], total: 0 }); return; }

  const folderClause = target.folder === "custom"
    ? and(eq(ayzenMailboxMessagesTable.userId, userId), eq(ayzenMailboxMessagesTable.folder, "custom"), eq(ayzenMailboxMessagesTable.folderId, target.folderId!))
    : and(eq(ayzenMailboxMessagesTable.userId, userId), eq(ayzenMailboxMessagesTable.folder, target.folder));
  const whereClause = extraFilters.length ? and(folderClause, ...extraFilters) : folderClause;

  // Every other folder reads newest-first; Snoozed reads by when each
  // message is due back (soonest first), same as Gmail's Snoozed tab —
  // that's the number the user actually cares about there, not send time.
  const rows = await db.select().from(ayzenMailboxMessagesTable).where(whereClause)
    .orderBy(target.folder === "snoozed" ? ayzenMailboxMessagesTable.snoozedUntil : desc(ayzenMailboxMessagesTable.createdAt))
    .limit(limit);

  // BUG FIX: this used to report `total: rows.length`, which is just the
  // current page size (capped at `limit`) instead of how many messages
  // actually exist in the folder — so a folder with, say, 240 messages
  // always reported "total: 50" and any unread/pagination UI built on top
  // of it would be wrong.
  const [{ value: total }] = await db.select({ value: count() }).from(ayzenMailboxMessagesTable).where(whereClause);

  // Conversation view: collapse rows sharing a thread_id into one entry
  // (the newest message in the thread stands in for the whole conversation
  // in the list), same as Gmail/Outlook. `messageCount` only counts messages
  // *in this folder* — a thread that's partly in Inbox and partly Archived
  // shows a smaller count here than GET /mailbox/thread/:threadId returns,
  // which is intentional: each folder's list should reflect what's actually
  // sitting in it, not the conversation's full history. Grouping is done
  // in JS rather than a GROUP BY so the "representative" row can still be
  // the full message (subject/from/attachments/etc.), not just an id.
  const order: string[] = [];
  const groups = new Map<string, { latest: typeof rows[number]; count: number; unread: boolean }>();
  for (const r of rows) {
    const g = groups.get(r.threadId);
    if (!g) {
      groups.set(r.threadId, { latest: r, count: 1, unread: !r.isRead && r.direction === "inbound" });
      order.push(r.threadId);
    } else {
      g.count += 1;
      if (!r.isRead && r.direction === "inbound") g.unread = true;
      // Rows are already newest-first, so the first one seen per thread is
      // the latest — nothing else to do for `latest`.
    }
  }
  const labelsByMessage = await getLabelsForMessages(order.map((threadId) => groups.get(threadId)!.latest.id));
  const conversations = order.map((threadId) => {
    const g = groups.get(threadId)!;
    return { ...fmt(g.latest, labelsByMessage.get(g.latest.id)), messageCount: g.count, threadUnread: g.unread };
  });

  res.json({ messages: conversations, total });
});

// GET /ayzen-email/mailbox/thread/:threadId?anchor=<messageId> — every
// message in one conversation, oldest first, across every folder except
// Trash (deleting a message removes it from a conversation the same way
// it removes it from a folder list — but a thread that's split between
// e.g. Inbox and Archive still reads as one conversation, matching how
// Gmail/Outlook show threads regardless of which label/folder each
// individual message carries).
//
// `anchor` is optional and only changes one thing: if the message the
// caller is actually viewing is itself sitting in Trash, Trash rows are
// NOT filtered out — the whole point of opening a trashed message is to
// see (and act on) that conversation as it currently sits, trash and all.
// Without this, a message opened from the Trash folder would vanish from
// its own `visible` list, ThreadDetail's anchor lookup would silently
// fall back to some other (non-trashed) message in the thread, and every
// "act on this trashed message" control (Restore, Delete forever) would
// end up pointed at the wrong row. Omit `anchor` (or point it at a
// non-trashed message) and behavior is unchanged from before.
router.get("/ayzen-email/mailbox/thread/:threadId", requireAuth, async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const threadId = req.params.threadId as string;
  const anchorId = req.query.anchor ? parseInt(String(req.query.anchor), 10) : undefined;

  const rows = await db.select().from(ayzenMailboxMessagesTable)
    .where(and(eq(ayzenMailboxMessagesTable.userId, userId), eq(ayzenMailboxMessagesTable.threadId, threadId)))
    .orderBy(ayzenMailboxMessagesTable.createdAt);
  const anchorInTrash = anchorId != null && rows.some((r) => r.id === anchorId && r.folder === "trash");
  const visible = anchorInTrash ? rows : rows.filter((r) => r.folder !== "trash");
  if (!visible.length) { res.status(404).json({ error: "Thread not found" }); return; }

  const unreadIds = visible.filter((r) => !r.isRead && r.direction === "inbound").map((r) => r.id);
  if (unreadIds.length) {
    await db.update(ayzenMailboxMessagesTable).set({ isRead: true }).where(inArray(ayzenMailboxMessagesTable.id, unreadIds));
  }

  const attachmentsByMessage = new Map<number, typeof ayzenMailboxAttachmentsTable.$inferSelect[]>();
  const atts = await db.select().from(ayzenMailboxAttachmentsTable)
    .where(inArray(ayzenMailboxAttachmentsTable.messageId, visible.map((r) => r.id)));
  for (const a of atts) {
    const list = attachmentsByMessage.get(a.messageId) ?? [];
    list.push(a);
    attachmentsByMessage.set(a.messageId, list);
  }

  // Robust Send Queue Phase 2: a message the send-queue worker gave up on
  // (see lib/mail-send-queue.ts's abandon path) lands back in 'drafts'
  // with no visible trace of *why* — same gap mail-schedule-cron.ts's
  // abandon path currently leaves for scheduled sends. Look up the most
  // recent failed queue row per drafted message so the UI can show
  // something more useful than a silently reappeared draft. Cheap: at most
  // one query, scoped to this thread's own message ids.
  const draftIds = visible.filter((r) => r.folder === "drafts").map((r) => r.id);
  const sendFailureByMessage = new Map<number, string>();
  if (draftIds.length) {
    const failedRows = await db.select().from(ayzenMailboxSendQueueTable)
      .where(and(inArray(ayzenMailboxSendQueueTable.messageId, draftIds), eq(ayzenMailboxSendQueueTable.status, "failed")));
    for (const q of failedRows) {
      if (q.lastError) sendFailureByMessage.set(q.messageId, q.lastError);
    }
  }

  const threadLabelsByMessage = await getLabelsForMessages(visible.map((r) => r.id));
  res.json({
    threadId,
    messages: visible.map((r) => ({
      ...fmt(r, threadLabelsByMessage.get(r.id)),
      isRead: true,
      text: decryptField(r.textBody),
      html: decryptField(r.htmlBody),
      attachments: (attachmentsByMessage.get(r.id) ?? []).map((a) => ({ id: a.id, filename: a.filename, contentType: a.contentType, sizeBytes: a.sizeBytes })),
      sendFailure: sendFailureByMessage.get(r.id) ?? null,
    })),
  });
});

// PATCH /ayzen-email/mailbox/thread/:threadId/quick-action — body { action:
// "star" | "unstar" | "markRead" | "markUnread" }. Whole Conversation
// Actions Phase 2: the mailbox list's per-row star/read-toggle icons act on
// a thread's *representative* row (see GET /mailbox above, which collapses
// each conversation to its newest message for the list). Before this route
// existed, clicking that icon only ever touched that one representative
// row — same gap Phase 1 fixed for the opened-thread detail view. This is
// deliberately narrower than PATCH /mailbox/bulk: only the two actions a
// list row's quick-icons actually trigger, so the list can stay a single
// fast round-trip without the frontend first fetching every message id in
// the thread just to build a bulk request. Excludes Trash the same way GET
// /mailbox/thread/:threadId's default (no-anchor) behavior does — a row in
// the list is never showing a trashed conversation in the first place.
const THREAD_QUICK_ACTIONS = ["star", "unstar", "markRead", "markUnread"] as const;
type ThreadQuickAction = (typeof THREAD_QUICK_ACTIONS)[number];

router.patch("/ayzen-email/mailbox/thread/:threadId/quick-action", requireAuth, async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const threadId = req.params.threadId as string;
  const { action } = req.body as { action?: string };
  if (!THREAD_QUICK_ACTIONS.includes(action as ThreadQuickAction)) {
    res.status(400).json({ error: `action must be one of ${THREAD_QUICK_ACTIONS.join(", ")}` }); return;
  }

  const ids = await db.select({ id: ayzenMailboxMessagesTable.id }).from(ayzenMailboxMessagesTable)
    .where(and(
      eq(ayzenMailboxMessagesTable.userId, userId),
      eq(ayzenMailboxMessagesTable.threadId, threadId),
      ne(ayzenMailboxMessagesTable.folder, "trash"),
    )).then((rows) => rows.map((r) => r.id));
  if (!ids.length) { res.json({ ok: true, affected: 0 }); return; }

  const patch: Partial<typeof ayzenMailboxMessagesTable.$inferInsert> =
    action === "star" ? { isStarred: true }
    : action === "unstar" ? { isStarred: false }
    : action === "markRead" ? { isRead: true }
    : { isRead: false };

  await db.update(ayzenMailboxMessagesTable).set(patch).where(inArray(ayzenMailboxMessagesTable.id, ids));
  res.json({ ok: true, affected: ids.length });
});

// GET /ayzen-email/mailbox/search?q=&folder=&labelId=&unread=1&starred=1&hasAttachments=1&limit=50
// Full-text + advanced search. `q` is parsed for Gmail-style operators
// (see lib/mail-search-query.ts) — from:/to:/cc:/subject:/has:attachment/
// is:unread|starred|draft/after:/before:/folder:, freely combinable with
// each other and with plain free text (e.g. `invoice from:boss
// has:attachment after:2026-01-01`). Whatever's left after stripping
// operators is full-text searched over subject/from/to/cc/bcc (see
// migrations/042 — message BODIES are encrypted at rest and are NOT part
// of the search index, so a search for words that only appear in a
// message's body won't find it).
//
// Also combinable with the same folder + quick-filter params GET /mailbox
// takes (?folder=, ?unread=1, etc.) — an explicit ?folder= query param
// wins over an embedded `folder:` operator, so a UI that pairs a folder
// dropdown with the search box behaves predictably; the operator is there
// for power users typing everything into one box. Omitting folder entirely
// searches across every folder except Trash.
//
// Registered ABOVE GET /ayzen-email/mailbox/:id on purpose — Express
// matches routes in registration order, and "search" would otherwise match
// :id's pattern (as the literal string "search", parsed to NaN) and get
// swallowed as a 404 before this handler ever ran.
router.get("/ayzen-email/mailbox/search", requireAuth, async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const raw = String(req.query.q ?? "").trim();
  if (!raw) { res.json({ messages: [], total: 0 }); return; }
  const limit = Math.min(parseInt(String(req.query.limit ?? "50"), 10) || 50, 100);

  const parsed = parseMailSearchQuery(raw);

  const extraFilters = await parseQuickFilters(userId, req.query as Record<string, unknown>);
  if (extraFilters === null) { res.json({ messages: [], total: 0 }); return; }

  const conditions: any[] = [eq(ayzenMailboxMessagesTable.userId, userId), ...extraFilters];
  let matchedAnything = false;

  // search_vector is DB/trigger-managed only (see migration 036 + 042) and
  // deliberately not mapped as a Drizzle column — referenced by raw column
  // name here rather than via the schema object. Only run when free text
  // actually remains after stripping operators: websearch_to_tsquery('')
  // matches nothing, so an operator-only query (e.g. `from:boss
  // has:attachment`) would otherwise wrongly zero out every result.
  if (parsed.freeText) {
    conditions.push(sql`search_vector @@ websearch_to_tsquery('english', ${parsed.freeText})`);
    matchedAnything = true;
  }
  if (parsed.from) { conditions.push(ilike(ayzenMailboxMessagesTable.fromAddr, `%${parsed.from}%`)); matchedAnything = true; }
  if (parsed.to) { conditions.push(ilike(ayzenMailboxMessagesTable.toAddr, `%${parsed.to}%`)); matchedAnything = true; }
  if (parsed.cc) { conditions.push(ilike(ayzenMailboxMessagesTable.ccAddr, `%${parsed.cc}%`)); matchedAnything = true; }
  if (parsed.subject) { conditions.push(ilike(ayzenMailboxMessagesTable.subject, `%${parsed.subject}%`)); matchedAnything = true; }
  if (parsed.hasAttachment) { conditions.push(eq(ayzenMailboxMessagesTable.hasAttachments, true)); matchedAnything = true; }
  if (parsed.isUnread) { conditions.push(and(eq(ayzenMailboxMessagesTable.isRead, false), eq(ayzenMailboxMessagesTable.direction, "inbound"))!); matchedAnything = true; }
  if (parsed.isStarred) { conditions.push(eq(ayzenMailboxMessagesTable.isStarred, true)); matchedAnything = true; }
  if (parsed.isDraft) { conditions.push(eq(ayzenMailboxMessagesTable.isDraft, true)); matchedAnything = true; }
  if (parsed.after) { conditions.push(gte(ayzenMailboxMessagesTable.createdAt, parsed.after)); matchedAnything = true; }
  if (parsed.before) { conditions.push(lte(ayzenMailboxMessagesTable.createdAt, parsed.before)); matchedAnything = true; }

  const folderParam = req.query.folder ?? parsed.folder;
  if (!matchedAnything && !folderParam && !extraFilters.length) {
    // Nothing usable came out of `q` at all (e.g. only whitespace-padded
    // operator syntax that failed to parse, with no folder/quick-filter to
    // narrow by either) — same "nothing to search on" response as an empty
    // q, rather than falling through to "list every message in scope".
    res.json({ messages: [], total: 0 }); return;
  }

  if (folderParam) {
    const target = await resolveFolderTarget(userId, folderParam, req.query.folderId);
    if (!target.ok) { res.status(400).json({ error: target.error }); return; }
    conditions.push(target.folder === "custom"
      ? and(eq(ayzenMailboxMessagesTable.folder, "custom"), eq(ayzenMailboxMessagesTable.folderId, target.folderId!))!
      : eq(ayzenMailboxMessagesTable.folder, target.folder));
  } else {
    // No folder given — search everywhere except Trash, matching how the
    // thread route treats "everywhere" (deleted mail shouldn't surface).
    conditions.push(sql`${ayzenMailboxMessagesTable.folder} != 'trash'`);
  }

  const rows = await db.select().from(ayzenMailboxMessagesTable).where(and(...conditions))
    .orderBy(desc(ayzenMailboxMessagesTable.createdAt)).limit(limit);
  const labelsByMessage = await getLabelsForMessages(rows.map((r) => r.id));

  res.json({
    messages: rows.map((r) => ({ ...fmt(r, labelsByMessage.get(r.id)) })),
    total: rows.length,
  });
});

// ─── Mail Analytics ─────────────────────────────────────────────────────────
// GET /ayzen-email/mailbox/analytics — one summary the Analytics dialog
// renders as stat tiles + a top-correspondents list. Registered BEFORE
// GET /mailbox/:id right below (same reason as attachments/search further
// down) so "analytics" isn't parsed as a message id.
//
// Everything here reads live off the messages/attachments tables — no
// separate rollup table to keep in sync, since a mailbox's total row count
// is small enough that computing this on request is cheap.
router.get("/ayzen-email/mailbox/analytics", requireAuth, async (req, res): Promise<void> => {
  const userId = getUserId(req);

  // Trash doesn't count toward activity stats — a thrown-away email was
  // never really "received" or "sent" from the user's point of view.
  const rows = await db.select({
    direction: ayzenMailboxMessagesTable.direction,
    folder: ayzenMailboxMessagesTable.folder,
    threadId: ayzenMailboxMessagesTable.threadId,
    fromAddr: ayzenMailboxMessagesTable.fromAddr,
    toAddr: ayzenMailboxMessagesTable.toAddr,
    isRead: ayzenMailboxMessagesTable.isRead,
    createdAt: ayzenMailboxMessagesTable.createdAt,
  }).from(ayzenMailboxMessagesTable)
    .where(and(eq(ayzenMailboxMessagesTable.userId, userId), sql`${ayzenMailboxMessagesTable.folder} != 'trash'`));

  let emailsReceived = 0, emailsSent = 0, unread = 0;
  const correspondents = new Map<string, { name: string | null; count: number; lastInteraction: Date }>();
  const byThread = new Map<string, { createdAt: Date; direction: string }[]>();

  for (const r of rows) {
    if (r.direction === "inbound") {
      emailsReceived++;
      if (!r.isRead && r.folder === "inbox") unread++;
      const { email, name } = parseAddr(r.fromAddr);
      bumpCorrespondent(correspondents, email, name, r.createdAt);
    } else if (r.folder === "sent") {
      emailsSent++;
      const { email, name } = parseAddr(r.toAddr);
      bumpCorrespondent(correspondents, email, name, r.createdAt);
    }
    const list = byThread.get(r.threadId) ?? [];
    list.push({ createdAt: r.createdAt, direction: r.direction });
    byThread.set(r.threadId, list);
  }

  // Avg response time: for each inbound message, how long until the next
  // outbound message in the same thread — i.e. how long the user took to
  // reply. A thread with no reply yet contributes no data point, so this
  // is an average over threads that actually got a response, not all mail.
  const responseTimes: number[] = [];
  for (const list of byThread.values()) {
    const sorted = [...list].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    for (let i = 0; i < sorted.length; i++) {
      if (sorted[i]!.direction !== "inbound") continue;
      const next = sorted.slice(i + 1).find((m) => m.direction === "outbound");
      if (next) responseTimes.push(next.createdAt.getTime() - sorted[i]!.createdAt.getTime());
    }
  }
  const avgResponseMs = responseTimes.length
    ? Math.round(responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length)
    : null;

  const [{ value: attachmentCount }] = await db.select({ value: count() }).from(ayzenMailboxAttachmentsTable)
    .innerJoin(ayzenMailboxMessagesTable, eq(ayzenMailboxMessagesTable.id, ayzenMailboxAttachmentsTable.messageId))
    .where(and(eq(ayzenMailboxMessagesTable.userId, userId), sql`${ayzenMailboxMessagesTable.folder} != 'trash'`));

  // A saved contact's name wins over whatever display name a message
  // happened to carry — same precedence GET /mailbox/contacts/:email uses.
  const savedContacts = await db.select().from(ayzenContactsTable).where(eq(ayzenContactsTable.userId, userId));
  const savedByEmail = new Map(savedContacts.map((c) => [c.email.toLowerCase(), c.name]));

  const topCorrespondents = [...correspondents.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 5)
    .map(([email, v]) => ({
      email, name: savedByEmail.get(email) ?? v.name, count: v.count, lastInteraction: v.lastInteraction.toISOString(),
    }));

  res.json({
    emailsReceived, emailsSent, unread, attachments: attachmentCount,
    avgResponseMs, correspondentCount: correspondents.size,
    topCorrespondents,
  });
});

// ─── Contact Intelligence ───────────────────────────────────────────────────
// GET /ayzen-email/mailbox/contacts/:email — everything the mailbox knows
// about one address: how much mail has passed between it and this user
// (any folder except Trash), plus whether it's been explicitly saved via
// POST /mailbox/contacts. Works for ANY address that's ever appeared in
// mail, saved or not — a saved row here just lets the user pin a name and
// mark it deliberately, and wins over whatever name a message's own
// display name would otherwise suggest.
router.get("/ayzen-email/mailbox/contacts/:email", requireAuth, async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const email = String(req.params.email ?? "").trim().toLowerCase();
  if (!email || !email.includes("@")) { res.status(400).json({ error: "Invalid address" }); return; }

  const [saved] = await db.select().from(ayzenContactsTable)
    .where(and(eq(ayzenContactsTable.userId, userId), sql`lower(${ayzenContactsTable.email}) = ${email}`));

  const rows = await db.select({
    id: ayzenMailboxMessagesTable.id,
    direction: ayzenMailboxMessagesTable.direction,
    fromAddr: ayzenMailboxMessagesTable.fromAddr,
    toAddr: ayzenMailboxMessagesTable.toAddr,
    createdAt: ayzenMailboxMessagesTable.createdAt,
  }).from(ayzenMailboxMessagesTable)
    .where(and(eq(ayzenMailboxMessagesTable.userId, userId), sql`${ayzenMailboxMessagesTable.folder} != 'trash'`));

  let emailCount = 0, guessedName: string | null = null, lastInteraction: Date | null = null;
  const matchingIds: number[] = [];
  for (const r of rows) {
    const parsed = parseAddr(r.direction === "inbound" ? r.fromAddr : r.toAddr);
    if (parsed.email !== email) continue;
    emailCount++;
    matchingIds.push(r.id);
    if (!lastInteraction || r.createdAt > lastInteraction) lastInteraction = r.createdAt;
    if (!guessedName && parsed.name) guessedName = parsed.name;
  }

  const [{ value: attachmentCount }] = matchingIds.length
    ? await db.select({ value: count() }).from(ayzenMailboxAttachmentsTable).where(inArray(ayzenMailboxAttachmentsTable.messageId, matchingIds))
    : [{ value: 0 }];

  res.json({
    email, name: saved?.name ?? guessedName,
    emailCount, attachmentCount,
    lastInteraction: lastInteraction ? lastInteraction.toISOString() : null,
    isContact: !!saved,
  });
});

// POST /ayzen-email/mailbox/contacts — body { email, name? }. The "Add
// contact" button in the Contact Intelligence popover. Idempotent: clicking
// it again for an address already saved just succeeds (optionally updating
// the name) instead of erroring, since from the user's side it's the same
// button either way, not an "already exists" failure.
router.post("/ayzen-email/mailbox/contacts", requireAuth, async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const { email, name } = req.body as { email?: string; name?: string };
  const clean = String(email ?? "").trim().toLowerCase();
  if (!clean || !clean.includes("@")) { res.status(400).json({ error: "A valid email address is required" }); return; }
  const cleanName = name ? (String(name).trim().slice(0, 120) || null) : null;

  try {
    const [row] = await db.insert(ayzenContactsTable).values({ userId, email: clean, name: cleanName }).returning();
    res.status(201).json({ id: row.id, email: row.email, name: row.name });
  } catch (err: any) {
    // Unique index on (user_id, lower(email)) — see migration 045.
    if (String(err?.message ?? "").includes("ayzen_contacts_user_email_idx")) {
      const [row] = await db.update(ayzenContactsTable).set(cleanName ? { name: cleanName } : {})
        .where(and(eq(ayzenContactsTable.userId, userId), sql`lower(${ayzenContactsTable.email}) = ${clean}`)).returning();
      res.status(200).json({ id: row.id, email: row.email, name: row.name });
      return;
    }
    throw err;
  }
});

// ─── Spam + Block ────────────────────────────────────────────────────────────
// Sender reputation (block/allow lists, "Mark spam" reporting, basic
// rate control) — see lib/mail-spam.ts and migrations/046. Registered
// ABOVE GET /ayzen-email/mailbox/:id for the same reason /search,
// /analytics, and /contacts/:email above are — "senders" would otherwise
// get parsed as :id and 404 before this ever ran.

// GET /ayzen-email/mailbox/senders?status=blocked|allowed — the Block/Allow
// list screens. Defaults to blocked if status is omitted or unrecognized.
router.get("/ayzen-email/mailbox/senders", requireAuth, async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const status = req.query.status === "allowed" ? "allowed" : "blocked";
  const rows = await listSenders(userId, status);
  res.json({
    senders: rows.map((r) => ({
      email: r.email, status: r.status, spamReports: r.spamReports,
      lastReceivedAt: r.lastReceivedAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
    })),
  });
});

// POST /ayzen-email/mailbox/senders/block — body { email }. Future inbound
// from this address lands straight in Spam (see
// lib/mail-spam.ts evaluateInboundReputation(), called from
// routes/resend-webhook.ts) instead of Inbox — same effect "Block sender"
// has in Gmail/Outlook.
router.post("/ayzen-email/mailbox/senders/block", requireAuth, async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const { email } = req.body as { email?: string };
  const clean = extractEmail(String(email ?? ""));
  if (!clean || !clean.includes("@")) { res.status(400).json({ error: "A valid email address is required" }); return; }
  await setSenderStatus(userId, clean, "blocked");
  res.json({ ok: true, email: clean, status: "blocked" });
});

// POST /ayzen-email/mailbox/senders/allow — body { email }. Future inbound
// from this address always lands in Inbox, skipping the report/rate-based
// auto-spam heuristics — "Allow sender" for a correspondent that keeps
// tripping them. Overwrites any existing Block on the same address, since
// the single `status` column means whichever action the user took most
// recently is what's in effect.
router.post("/ayzen-email/mailbox/senders/allow", requireAuth, async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const { email } = req.body as { email?: string };
  const clean = extractEmail(String(email ?? ""));
  if (!clean || !clean.includes("@")) { res.status(400).json({ error: "A valid email address is required" }); return; }
  await setSenderStatus(userId, clean, "allowed");
  res.json({ ok: true, email: clean, status: "allowed" });
});

// DELETE /ayzen-email/mailbox/senders/:email — removes a sender from
// whichever list they're currently on, back to 'neutral'. The caller is
// expected to URL-encode the address (it contains '@' and '.').
router.delete("/ayzen-email/mailbox/senders/:email", requireAuth, async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const clean = extractEmail(decodeURIComponent(req.params.email as string));
  if (!clean || !clean.includes("@")) { res.status(400).json({ error: "Invalid address" }); return; }
  await setSenderStatus(userId, clean, "neutral");
  res.json({ ok: true, email: clean, status: "neutral" });
});

// ─── Bounce + Complaint Handling (Phase 1) ───────────────────────────────────
// Recipient reputation (bounce/complaint tracking + the 'flagged'/'blocked'
// address flag) — see lib/mail-recipient-reputation.ts and migrations/052.
// Read-only + a manual clear for Phase 1; Phase 2 is what makes POST /send
// itself consult this before sending. Registered ABOVE GET /:id for the
// same routing-order reason the Spam + Block routes above are.

// GET /ayzen-email/mailbox/problematic-recipients — every recipient this
// user has flagged (repeated bounces) or blocked (a spam complaint),
// newest flag first.
router.get("/ayzen-email/mailbox/problematic-recipients", requireAuth, async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const rows = await listProblematicRecipients(userId);
  res.json({
    recipients: rows.map((r) => ({
      email: r.email,
      status: r.status,
      bounceCount: r.bounceCount,
      consecutiveBounces: r.consecutiveBounces,
      complaintCount: r.complaintCount,
      lastBounceAt: r.lastBounceAt?.toISOString() ?? null,
      lastComplaintAt: r.lastComplaintAt?.toISOString() ?? null,
      flaggedAt: r.flaggedAt?.toISOString() ?? null,
    })),
  });
});

// DELETE /ayzen-email/mailbox/problematic-recipients/:email — manually
// clears a flag/block back to 'ok' (e.g. "this address is fine now"). The
// caller is expected to URL-encode the address, same as the sender routes.
router.delete("/ayzen-email/mailbox/problematic-recipients/:email", requireAuth, async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const clean = extractEmail(decodeURIComponent(req.params.email as string));
  if (!clean || !clean.includes("@")) { res.status(400).json({ error: "Invalid address" }); return; }
  await clearRecipientFlag(userId, clean);
  res.json({ ok: true, email: clean, status: "ok" });
});

// ─── Bounce + Complaint Handling (Phase 3) ───────────────────────────────────
// Account-wide sending health — see lib/mail-sending-health.ts. Sits next
// to the problematic-recipients routes above since both back the same
// Settings area.

// GET /ayzen-email/mailbox/sending-health — status, current window's
// bounce/complaint rates, and lifetime totals. Backs the Settings health
// widget; also what POST /send itself checks before every send.
router.get("/ayzen-email/mailbox/sending-health", requireAuth, async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const health = await getSendingHealth(userId);
  res.json({
    ...health,
    pausedAt: health.pausedAt?.toISOString() ?? null,
    lastDigestSentAt: health.lastDigestSentAt?.toISOString() ?? null,
  });
});

// POST /ayzen-email/mailbox/sending-health/resume — the user's "I've
// cleaned up my list, let me send again" action. Re-evaluates from current
// counts rather than force-clearing; if the rate is still over the pause
// threshold this lands right back on 'paused' and `resumed: false` tells
// the caller so.
router.post("/ayzen-email/mailbox/sending-health/resume", requireAuth, async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const result = await resumeSendingHealth(userId);
  res.json(result);
});

// GET/PATCH /admin/mail-sending-config — the thresholds behind both the
// per-recipient flag (bounceFlagThreshold) and the account-wide pause
// (everything else), admin-tunable rather than hardcoded — see
// lib/mail-sending-config.ts and migrations/053.
router.get("/admin/mail-sending-config", requireAdmin, async (_req, res): Promise<void> => {
  res.json(await getSendingConfig());
});
router.patch("/admin/mail-sending-config", requireAdmin, async (req, res): Promise<void> => {
  const allowed = [
    "bounceFlagThreshold", "windowDays", "minSampleSize",
    "warningBounceRateBp", "pauseBounceRateBp", "pauseComplaintRateBp", "complaintHardCap",
    // Bounce + Complaint Handling (Phase 4) — digest/batching thresholds.
    "digestTriggerCount", "digestBurstMinutes",
  ] as const;
  const patch: Record<string, number> = {};
  for (const key of allowed) {
    const v = (req.body as Record<string, unknown>)[key];
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) patch[key] = v;
  }
  res.json(await updateSendingConfig(patch));
});

// PHASE 5 (admin credit console request): opening a message body is now
// a metered action (wisp.mail_view) — charge-on-success once the message
// is actually found and about to be returned.
router.get("/ayzen-email/mailbox/:id", requireAuth, requireAyzenMailboxMessageOwnership("ayzen_mailbox_message.read"), requireCreditBalance("wisp.mail_view"), async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const id = parseInt(req.params.id as string, 10);
  const [row] = await db.select().from(ayzenMailboxMessagesTable).where(and(eq(ayzenMailboxMessagesTable.id, id), eq(ayzenMailboxMessagesTable.userId, userId)));
  if (!row) { res.status(404).json({ error: "Message not found" }); return; }

  if (!row.isRead && row.direction === "inbound") {
    await db.update(ayzenMailboxMessagesTable).set({ isRead: true }).where(eq(ayzenMailboxMessagesTable.id, id));
  }

  const attachments = await db.select().from(ayzenMailboxAttachmentsTable).where(eq(ayzenMailboxAttachmentsTable.messageId, id));
  const messageLabels = (await getLabelsForMessages([id])).get(id) ?? [];

  const charge = await chargeCredits(userId, "wisp.mail_view");

  res.json({
    ...fmt(row, messageLabels),
    isRead: true,
    text: decryptField(row.textBody),
    html: decryptField(row.htmlBody),
    attachments: attachments.map((a) => ({ id: a.id, filename: a.filename, contentType: a.contentType, sizeBytes: a.sizeBytes })),
    _credits: charge.ok ? { charged: charge.charged, newBalance: charge.newBalance } : null,
  });
});

// GET /ayzen-email/mailbox/attachments/search?q=&limit=25 — find attachments
// by filename across every message the user owns (any folder, including
// Trash — "find that PDF" shouldn't care where the email ended up). This is
// distinct from the `hasAttachments=1` quick filter and the main mail search
// (subject/from/to/cc/bcc): neither of those matches on the attachment's own
// filename.
// NOTE: registered before the "/:id" routes below so "attachments" here
// isn't swallowed by `GET /mailbox/:id`.
router.get("/ayzen-email/mailbox/attachments/search", requireAuth, async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const q = String(req.query.q ?? "").trim();
  if (!q) { res.json({ results: [] }); return; }
  const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? "25"), 10) || 25, 1), 100);

  const rows = await db
    .select({
      attId: ayzenMailboxAttachmentsTable.id,
      filename: ayzenMailboxAttachmentsTable.filename,
      contentType: ayzenMailboxAttachmentsTable.contentType,
      sizeBytes: ayzenMailboxAttachmentsTable.sizeBytes,
      messageId: ayzenMailboxMessagesTable.id,
      subject: ayzenMailboxMessagesTable.subject,
      fromAddr: ayzenMailboxMessagesTable.fromAddr,
      toAddr: ayzenMailboxMessagesTable.toAddr,
      folder: ayzenMailboxMessagesTable.folder,
      folderId: ayzenMailboxMessagesTable.folderId,
      createdAt: ayzenMailboxMessagesTable.createdAt,
      receivedAt: ayzenMailboxMessagesTable.receivedAt,
    })
    .from(ayzenMailboxAttachmentsTable)
    .innerJoin(ayzenMailboxMessagesTable, eq(ayzenMailboxAttachmentsTable.messageId, ayzenMailboxMessagesTable.id))
    .where(and(
      eq(ayzenMailboxMessagesTable.userId, userId),
      ilike(ayzenMailboxAttachmentsTable.filename, `%${q}%`),
    ))
    .orderBy(desc(ayzenMailboxMessagesTable.createdAt))
    .limit(limit);

  res.json({
    results: rows.map((r) => ({
      attachment: { id: r.attId, filename: r.filename, contentType: r.contentType, sizeBytes: r.sizeBytes },
      message: {
        id: r.messageId, subject: r.subject, from: r.fromAddr, to: r.toAddr,
        folder: r.folder, folderId: r.folderId,
        receivedAt: r.receivedAt, createdAt: r.createdAt,
      },
    })),
  });
});

// GET /ayzen-email/mailbox/:id/attachments/download-all — every attachment
// on the message, zipped into a single download (see lib/zip-writer.ts).
// Registered BEFORE the generic ":attachmentId" route right below — both
// match a path shaped like "/mailbox/42/attachments/download-all", and
// Express resolves routes in registration order, so the more specific one
// has to come first or "download-all" gets swallowed as a (numeric,
// therefore invalid) attachment id.
router.get("/ayzen-email/mailbox/:id/attachments/download-all", requireAuth, requireAyzenMailboxMessageOwnershipStrictId("ayzen_mailbox_message.attachments.download_all"), async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const id = parseInt(req.params.id as string, 10);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const [message] = await db.select().from(ayzenMailboxMessagesTable).where(and(eq(ayzenMailboxMessagesTable.id, id), eq(ayzenMailboxMessagesTable.userId, userId)));
  if (!message) { res.status(404).json({ error: "Message not found" }); return; }

  const attachments = await db.select().from(ayzenMailboxAttachmentsTable).where(eq(ayzenMailboxAttachmentsTable.messageId, id));
  if (!attachments.length) { res.status(404).json({ error: "This message has no attachments" }); return; }

  try {
    const resolved = await Promise.all(attachments.map((a) => resolveAttachmentContent(message, a)));
    const names = dedupeNames(resolved.map((r) => r.filename));
    const zip = buildZip(resolved.map((r, i) => ({ name: names[i]!, data: Buffer.from(r.dataBase64, "base64") })));
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="mail-${id}-attachments.zip"`);
    res.send(zip);
  } catch (err: any) {
    res.status(err?.status ?? 502).json({ error: err?.message ?? "Could not build the download" });
  }
});

// GET /ayzen-email/mailbox/:id/attachments/:attachmentId — download one attachment.
// ?raw=1 streams the actual file with a Content-Disposition header; without
// it, returns { filename, contentType, dataBase64 } like vault-attachments does.
router.get("/ayzen-email/mailbox/:id/attachments/:attachmentId", requireAuth, requireAyzenMailboxMessageOwnershipStrictId("ayzen_mailbox_message.attachments.read"), async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const id = parseInt(req.params.id as string, 10);
  const attachmentId = parseInt(req.params.attachmentId as string, 10);
  if (!Number.isFinite(id) || !Number.isFinite(attachmentId)) { res.status(400).json({ error: "Invalid id" }); return; }

  const [message] = await db.select().from(ayzenMailboxMessagesTable).where(and(eq(ayzenMailboxMessagesTable.id, id), eq(ayzenMailboxMessagesTable.userId, userId)));
  if (!message) { res.status(404).json({ error: "Message not found" }); return; }

  const [attachment] = await db.select().from(ayzenMailboxAttachmentsTable).where(and(eq(ayzenMailboxAttachmentsTable.id, attachmentId), eq(ayzenMailboxAttachmentsTable.messageId, id)));
  if (!attachment) { res.status(404).json({ error: "Attachment not found" }); return; }

  let content: { filename: string; contentType: string; dataBase64: string };
  try {
    content = await resolveAttachmentContent(message, attachment);
  } catch (err: any) {
    res.status(err?.status ?? 502).json({ error: err?.message ?? "Could not retrieve attachment" }); return;
  }

  if (req.query.raw === "1") {
    res.setHeader("Content-Type", content.contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${content.filename.replace(/"/g, "")}"`);
    res.send(Buffer.from(content.dataBase64, "base64"));
    return;
  }
  res.json(content);
});

router.patch("/ayzen-email/mailbox/:id/star", requireAuth, requireAyzenMailboxMessageOwnership("ayzen_mailbox_message.star.update"), async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const id = parseInt(req.params.id as string, 10);
  const { starred } = req.body as { starred?: boolean };
  const [row] = await db.update(ayzenMailboxMessagesTable).set({ isStarred: !!starred })
    .where(and(eq(ayzenMailboxMessagesTable.id, id), eq(ayzenMailboxMessagesTable.userId, userId))).returning();
  if (!row) { res.status(404).json({ error: "Message not found" }); return; }
  res.json(fmt(row));
});

// PATCH /ayzen-email/mailbox/:id/read — body { read: boolean }. Explicit
// mark-read/unread, distinct from the automatic "mark read on open" that
// GET /mailbox/:id and /mailbox/thread/:threadId already do — this is what
// "Mark as unread" (single or bulk) calls.
router.patch("/ayzen-email/mailbox/:id/read", requireAuth, requireAyzenMailboxMessageOwnership("ayzen_mailbox_message.read_state.update"), async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const id = parseInt(req.params.id as string, 10);
  const { read } = req.body as { read?: boolean };
  const [row] = await db.update(ayzenMailboxMessagesTable).set({ isRead: !!read })
    .where(and(eq(ayzenMailboxMessagesTable.id, id), eq(ayzenMailboxMessagesTable.userId, userId))).returning();
  if (!row) { res.status(404).json({ error: "Message not found" }); return; }
  res.json(fmt(row));
});

// PATCH /ayzen-email/mailbox/:id/snooze — body { until: ISOString }. Moves
// the message into Snoozed and records when it's due back. Only meaningful
// for a message currently sitting in Inbox (mirrors Gmail, which only lets
// you snooze from Inbox) — snoozing from anywhere else would make "due
// back" ambiguous (back to Inbox? back to wherever it was?).
router.patch("/ayzen-email/mailbox/:id/snooze", requireAuth, requireAyzenMailboxMessageOwnership("ayzen_mailbox_message.snooze"), async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const id = parseInt(req.params.id as string, 10);
  const { until } = req.body as { until?: string };

  const parsed = until ? new Date(until) : null;
  if (!parsed || Number.isNaN(parsed.getTime()) || parsed.getTime() <= Date.now()) {
    res.status(400).json({ error: "until must be a valid future date/time" }); return;
  }

  const [existing] = await db.select({ folder: ayzenMailboxMessagesTable.folder }).from(ayzenMailboxMessagesTable)
    .where(and(eq(ayzenMailboxMessagesTable.id, id), eq(ayzenMailboxMessagesTable.userId, userId)));
  if (!existing) { res.status(404).json({ error: "Message not found" }); return; }
  if (existing.folder !== "inbox") { res.status(400).json({ error: "Only Inbox messages can be snoozed" }); return; }

  const [row] = await db.update(ayzenMailboxMessagesTable)
    .set({ folder: "snoozed", folderId: null, isDraft: false, snoozedUntil: parsed })
    .where(and(eq(ayzenMailboxMessagesTable.id, id), eq(ayzenMailboxMessagesTable.userId, userId))).returning();
  res.json(fmt(row));
});

// PATCH /ayzen-email/mailbox/:id/unsnooze — manual "bring it back now",
// same effect the automatic sweep has once `until` passes, just triggered
// early by the user instead of by time.
router.patch("/ayzen-email/mailbox/:id/unsnooze", requireAuth, requireAyzenMailboxMessageOwnership("ayzen_mailbox_message.unsnooze", "Message not found in Snoozed"), async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const id = parseInt(req.params.id as string, 10);
  const [row] = await db.update(ayzenMailboxMessagesTable)
    .set({ folder: "inbox", snoozedUntil: null })
    .where(and(eq(ayzenMailboxMessagesTable.id, id), eq(ayzenMailboxMessagesTable.userId, userId), eq(ayzenMailboxMessagesTable.folder, "snoozed")))
    .returning();
  if (!row) { res.status(404).json({ error: "Message not found in Snoozed" }); return; }
  res.json(fmt(row));
});

// PATCH /ayzen-email/mailbox/:id/reschedule — body { scheduledSendAt: ISOString }.
// Changes when an already-scheduled message will go out. Only meaningful
// for a message currently sitting in Scheduled, same restriction the snooze
// route places on Inbox above. Resets scheduleAttempts so a message that
// had started failing gets a clean slate against its new time.
router.patch("/ayzen-email/mailbox/:id/reschedule", requireAuth, requireAyzenMailboxMessageOwnership("ayzen_mailbox_message.reschedule"), async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const id = parseInt(req.params.id as string, 10);
  const { scheduledSendAt } = req.body as { scheduledSendAt?: string };

  const parsed = scheduledSendAt ? new Date(scheduledSendAt) : null;
  if (!parsed || Number.isNaN(parsed.getTime()) || parsed.getTime() <= Date.now()) {
    res.status(400).json({ error: "scheduledSendAt must be a valid future date/time" }); return;
  }

  const [existing] = await db.select({ folder: ayzenMailboxMessagesTable.folder }).from(ayzenMailboxMessagesTable)
    .where(and(eq(ayzenMailboxMessagesTable.id, id), eq(ayzenMailboxMessagesTable.userId, userId)));
  if (!existing) { res.status(404).json({ error: "Message not found" }); return; }
  if (existing.folder !== "scheduled") { res.status(400).json({ error: "Only messages in Scheduled can be rescheduled" }); return; }

  // Undo Send (Phase 2): the message got a real send-queue row the instant
  // it was first scheduled (see POST /send's scheduled branch above), so
  // rescheduling has to push that row's next_attempt_at forward too — not
  // just the message's own scheduledSendAt — or the worker would still
  // send at the *old* time. Guarded on status = 'pending' the same way
  // PATCH /:id/undo-send guards its cancel: if the worker already claimed
  // the row (status is 'sending', or it already finished), this matches
  // zero rows and the client is told it's too late instead of silently
  // updating a message that's already out of the queue's hands.
  const row = await db.transaction(async (tx) => {
    const requeued = await tx.execute(sql`
      UPDATE ayzen_mailbox_send_queue SET next_attempt_at = ${parsed}, attempts = 0, last_error = NULL
      WHERE message_id = ${id} AND status = 'pending'
      RETURNING id
    `);
    if (!(requeued.rows as { id: number }[]).length) return null;

    const [updated] = await tx.update(ayzenMailboxMessagesTable)
      .set({ scheduledSendAt: parsed, scheduleAttempts: 0 })
      .where(and(eq(ayzenMailboxMessagesTable.id, id), eq(ayzenMailboxMessagesTable.userId, userId))).returning();
    return updated;
  });

  if (!row) {
    res.status(409).json({ error: "Too late — this is already being sent", code: "UNDO_WINDOW_EXPIRED" });
    return;
  }
  res.json(fmt(row));
});

// PATCH /ayzen-email/mailbox/:id/cancel-schedule — pulls a message back out
// of Scheduled before it goes out. Lands it in Drafts (editable,
// re-sendable) rather than deleting it — the same spot the Send Queue
// (lib/mail-send-queue.ts) drops a message into after MAX_SEND_ATTEMPTS
// failed sends once it becomes due and is handed off there, so every path
// leaves the message in one predictable place.
// Undo Send (Phase 2) unified this with PATCH /:id/undo-send below: since a
// scheduled message now gets a real send-queue row the instant it's
// scheduled (not just once the old once-a-minute cron promoted it), this
// cancel has to race against that row the same way undo-send races against
// an immediate send's — UPDATE ... WHERE status = 'pending' first, then
// only move the message to Drafts if that actually matched a row. If the
// worker already claimed it (status 'sending') or it already went out,
// this matches zero rows and the client is told it's too late instead of
// moving a message to Drafts that Resend already accepted.
router.patch("/ayzen-email/mailbox/:id/cancel-schedule", requireAuth, requireAyzenMailboxMessageOwnership("ayzen_mailbox_message.cancel_schedule", "Message not found in Scheduled"), async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const id = parseInt(req.params.id as string, 10);

  const [existing] = await db.select({ folder: ayzenMailboxMessagesTable.folder }).from(ayzenMailboxMessagesTable)
    .where(and(eq(ayzenMailboxMessagesTable.id, id), eq(ayzenMailboxMessagesTable.userId, userId)));
  if (!existing) { res.status(404).json({ error: "Message not found in Scheduled" }); return; }
  if (existing.folder !== "scheduled") { res.status(400).json({ error: "Message not found in Scheduled" }); return; }

  const row = await db.transaction(async (tx) => {
    const cancelled = await tx.execute(sql`
      UPDATE ayzen_mailbox_send_queue SET status = 'cancelled'
      WHERE message_id = ${id} AND status = 'pending'
      RETURNING id
    `);
    if (!(cancelled.rows as { id: number }[]).length) return null;

    const [updated] = await tx.update(ayzenMailboxMessagesTable)
      .set({ folder: "drafts", isDraft: true, scheduledSendAt: null, scheduleAttempts: 0, idempotencyKey: null })
      .where(and(eq(ayzenMailboxMessagesTable.id, id), eq(ayzenMailboxMessagesTable.userId, userId))).returning();
    return updated;
  });

  if (!row) {
    res.status(409).json({ error: "Too late — this is already being sent", code: "UNDO_WINDOW_EXPIRED" });
    return;
  }
  res.json(fmt(row));
});

// PATCH /ayzen-email/mailbox/:id/undo-send — Undo Send, Phase 1. Pulls an
// immediate send back out before the Send Queue worker (lib/mail-send-queue.ts)
// has actually attempted it, landing it in Drafts — same convention
// cancel-schedule (above) and the queue's own give-up path already use, so
// however a send gets pulled back, it always ends up somewhere editable/
// re-sendable.
//
// Deliberately does NOT gate on the message's own folder alone: 'outbox'
// covers the message's entire time in flight, including the undo window,
// so folder can't tell "still waiting, not claimed yet" apart from "a
// worker already has it." The send-queue row's status is what actually
// knows that, so the UPDATE ... WHERE status = 'pending' below is the real
// race guard — if claimNextBatch() got there first (status is already
// 'sending', or the row finished as 'sent'/'failed'), this matches zero
// rows and the client is told it's too late instead of silently no-op'ing.
router.patch("/ayzen-email/mailbox/:id/undo-send", requireAuth, requireAyzenMailboxMessageOwnership("ayzen_mailbox_message.undo_send"), async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const id = parseInt(req.params.id as string, 10);

  const [existing] = await db.select().from(ayzenMailboxMessagesTable)
    .where(and(eq(ayzenMailboxMessagesTable.id, id), eq(ayzenMailboxMessagesTable.userId, userId)));
  if (!existing) { res.status(404).json({ error: "Message not found" }); return; }
  if (existing.folder !== "outbox") { res.status(400).json({ error: "This message isn't waiting to be sent" }); return; }

  const row = await db.transaction(async (tx) => {
    const cancelled = await tx.execute(sql`
      UPDATE ayzen_mailbox_send_queue SET status = 'cancelled'
      WHERE message_id = ${id} AND status = 'pending'
      RETURNING id
    `);
    if (!(cancelled.rows as { id: number }[]).length) return null;

    // idempotencyKey cleared alongside the reset: leaving the original
    // send's key on a now-Drafts row would let a later resend of this same
    // draft get misread as a retry of the cancelled send (Idempotent Send's
    // replay path above keys off (userId, idempotencyKey) alone, not
    // folder), which would hand back the stale cancelled outcome instead
    // of actually sending.
    const [updated] = await tx.update(ayzenMailboxMessagesTable).set({
      folder: "drafts", isDraft: true, deliveryStatus: null, deliveryStatusAt: null, idempotencyKey: null,
      undoExpiresAt: null, // Undo Send (Phase 2): back in Drafts, nothing left to undo.
    }).where(eq(ayzenMailboxMessagesTable.id, id)).returning();
    return updated;
  });

  if (!row) {
    res.status(409).json({ error: "Too late — this is already being sent", code: "UNDO_WINDOW_EXPIRED" });
    return;
  }
  res.json(fmt(row));
});

// PATCH /ayzen-email/mailbox/:id/move — body { folder, folderId? }
// Moves a message into any system folder or a custom one. This is the one
// place folder membership changes, so Archive, "move to custom folder", and
// restoring something out of Trash all go through here.
router.patch("/ayzen-email/mailbox/:id/move", requireAuth, requireAyzenMailboxMessageOwnership("ayzen_mailbox_message.move"), async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const id = parseInt(req.params.id as string, 10);
  const { folder, folderId } = req.body as { folder?: string; folderId?: number };

  const target = await resolveMoveTarget(userId, folder, folderId);
  if (!target.ok) { res.status(400).json({ error: target.error }); return; }
  // A draft is only ever a draft while it sits in Drafts — moving it
  // anywhere else (Archive, a custom folder, Trash) means the user is
  // filing away or discarding it unsent, so drop the draft flag.
  const isDraft = target.folder === "drafts";

  const [row] = await db.update(ayzenMailboxMessagesTable)
    .set({ folder: target.folder, folderId: target.folderId, isDraft })
    .where(and(eq(ayzenMailboxMessagesTable.id, id), eq(ayzenMailboxMessagesTable.userId, userId))).returning();
  if (!row) { res.status(404).json({ error: "Message not found" }); return; }
  res.json(fmt(row));
});

// PATCH /ayzen-email/mailbox/:id/mark-spam — moves a message into Spam and
// reports its sender (see lib/mail-spam.ts recordSpamReport()). After
// enough reports against the same sender, their future inbound auto-routes
// to Spam too — the same "basic reputation" heuristic
// routes/resend-webhook.ts applies to brand-new mail.
router.patch("/ayzen-email/mailbox/:id/mark-spam", requireAuth, requireAyzenMailboxMessageOwnership("ayzen_mailbox_message.mark_spam"), async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const id = parseInt(req.params.id as string, 10);
  const [existing] = await db.select().from(ayzenMailboxMessagesTable)
    .where(and(eq(ayzenMailboxMessagesTable.id, id), eq(ayzenMailboxMessagesTable.userId, userId)));
  if (!existing) { res.status(404).json({ error: "Message not found" }); return; }

  const [row] = await db.update(ayzenMailboxMessagesTable)
    .set({ folder: "spam", folderId: null, isDraft: false })
    .where(and(eq(ayzenMailboxMessagesTable.id, id), eq(ayzenMailboxMessagesTable.userId, userId))).returning();

  // Only inbound mail has a sender worth reporting — outbound/drafts have
  // no "from" that means anything to flag.
  if (existing.direction === "inbound") await recordSpamReport(userId, existing.fromAddr);
  res.json(fmt(row));
});

// PATCH /ayzen-email/mailbox/:id/not-spam — pulls a message back out of
// Spam into Inbox. Same "Not spam" semantics Gmail/Outlook use: also clears
// any manual Block on the sender and resets their report count (see
// lib/mail-spam.ts clearSenderSpamFlags()), since saying "not spam" means
// the user didn't actually mean to keep blocking/auto-spamming them.
router.patch("/ayzen-email/mailbox/:id/not-spam", requireAuth, requireAyzenMailboxMessageOwnership("ayzen_mailbox_message.not_spam", "Message not found in Spam"), async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const id = parseInt(req.params.id as string, 10);
  const [row] = await db.update(ayzenMailboxMessagesTable)
    .set({ folder: "inbox", folderId: null })
    .where(and(eq(ayzenMailboxMessagesTable.id, id), eq(ayzenMailboxMessagesTable.userId, userId), eq(ayzenMailboxMessagesTable.folder, "spam")))
    .returning();
  if (!row) { res.status(404).json({ error: "Message not found in Spam" }); return; }
  if (row.direction === "inbound") await clearSenderSpamFlags(userId, row.fromAddr);
  res.json(fmt(row));
});

// ─── Route Integration Roadmap — Season C, Phase C13 (mechanical sweep,
// batch 13: PATCH /mailbox/bulk via authorizeMany()) ────────────────────────
// The one route Season C's mechanical sweep kept explicitly deferring
// (flagged in both C11 and C12): `PATCH /mailbox/bulk` takes an array of
// ids, not a single resource ref, so `requireOwnership()` — built for
// exactly one WHO/WHAT/WHICH question per request — doesn't fit. The
// Policy & Authorization Mega Engine already shipped exactly the tool this
// shape needs back in Phase 20 (`authorizeMany()`/`allowedKeys()`, see
// ./lib/policy/pep/authorize-many.ts's own header — "marketplace lists,
// projects, organization members, vault resources, admin dashboards") but
// no route had ever actually called it — this is that tool's first real
// caller.
//
// Same trust-boundary posture as every single-id route in this series:
// the DB lookup below does NOT filter by `userId` — it only scopes to the
// requested ids — so a row belonging to another user is fetched too (its
// real owner, not assumed away), and it's `authorizeMany()` +
// `allowedKeys()` that decides which of those rows the caller actually
// gets to act on, the exact same `resource-ownership` rule every
// `requireOwnership()` call in this file already runs, now evaluated once
// per item in the batch instead of once per request. The resulting
// `ids` list is IDENTICAL to what the old `eq(userId, userId)`-filtered
// query would have produced — nonexistent/other-users'-ids still just
// silently don't make it into `ids`, same as before — the only change is
// that exclusion is now a real, audited `AuthorizationDecision` per id
// instead of a WHERE clause no PDP ever saw.
const ayzenMailboxBulkOwnershipEngine = new PolicyEngine({ onDecision: pepDecisionObserver });
ayzenMailboxBulkOwnershipEngine.registerRule("resource-ownership", createResourceOwnershipRule());

// PATCH /ayzen-email/mailbox/bulk — body { ids: number[], action, folder?,
// folderId?, labelId? }. One request instead of N — every action here is a
// single UPDATE/DELETE scoped to `inArray(id, ownedIds) AND userId=...`, so
// the message-selection checkbox UI (select 40 emails, archive them) doesn't
// turn into 40 round-trips. Every id is re-validated against the caller's
// own messages before anything runs, same as the single-message routes —
// a stale/tampered id list just gets silently dropped rather than 403ing
// the whole batch, so "select 12, one already got deleted in another tab"
// still succeeds for the other 11.
const BULK_ACTIONS = ["markRead", "markUnread", "star", "unstar", "archive", "trash", "delete", "move", "snooze", "unsnooze", "addLabel", "removeLabel", "spam", "notSpam"] as const;
type BulkAction = (typeof BULK_ACTIONS)[number];

router.patch("/ayzen-email/mailbox/bulk", requireAuth, async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const { ids: rawIds, action, folder, folderId, labelId, until } = req.body as {
    ids?: number[]; action?: string; folder?: string; folderId?: number; labelId?: number; until?: string;
  };
  const requestedIds = Array.from(new Set((rawIds ?? []).filter((n) => Number.isFinite(n))));
  if (!requestedIds.length) { res.status(400).json({ error: "ids must be a non-empty array" }); return; }
  if (!BULK_ACTIONS.includes(action as BulkAction)) { res.status(400).json({ error: `action must be one of ${BULK_ACTIONS.join(", ")}` }); return; }

  // Only parsed/validated for the "snooze" action, but done up-front so the
  // switch body below can just check truthiness like every other branch.
  let snoozeUntil: Date | null = null;
  if (action === "snooze") {
    const parsed = until ? new Date(until) : null;
    if (!parsed || Number.isNaN(parsed.getTime()) || parsed.getTime() <= Date.now()) {
      res.status(400).json({ error: "until must be a valid future date/time" }); return;
    }
    snoozeUntil = parsed;
  }

  // Trust-boundary lookup, NOT scoped to `userId` — see the Phase C13
  // header above. Every candidate row's REAL owner is fetched (whoever it
  // actually belongs to), and `authorizeMany()`/`allowedKeys()` below is
  // what decides which of these the caller may act on. fromAddr/direction
  // are only needed by the spam/notSpam actions further down, but fetched
  // for every action here rather than conditionally — one extra pair of
  // already-indexed columns on a query already scoped to a handful of ids
  // costs nothing worth branching on.
  const candidates = await db.select({
    id: ayzenMailboxMessagesTable.id, userId: ayzenMailboxMessagesTable.userId, folder: ayzenMailboxMessagesTable.folder,
    fromAddr: ayzenMailboxMessagesTable.fromAddr, direction: ayzenMailboxMessagesTable.direction,
  }).from(ayzenMailboxMessagesTable).where(inArray(ayzenMailboxMessagesTable.id, requestedIds));

  // One `resource-ownership` decision per candidate row, sharing a single
  // Subject/PolicyContext resolution for the whole batch (see
  // authorize-many.ts's own header on why that's the N+1 this exists to
  // avoid) — action name carries the actual bulk verb requested, same
  // "each verb gets its own decision-reason code" posture every other
  // route in this series already follows for its own single-id action.
  const outcome = await authorizeMany<number>({
    req,
    engine: ayzenMailboxBulkOwnershipEngine,
    action: `ayzen_mailbox_message.bulk.${action}`,
    items: candidates.map((row): { key: number; resource: ResourceRef } => ({
      key: row.id,
      resource: { type: "ayzen_mailbox_message", id: row.id, ownerId: row.userId },
    })),
  });
  const allowedIdSet = new Set(allowedKeys(outcome));
  const owned = candidates.filter((r) => allowedIdSet.has(r.id));
  const ids = owned.map((r) => r.id);
  if (!ids.length) { res.json({ ok: true, affected: 0 }); return; }

  switch (action as BulkAction) {
    case "markRead":
      await db.update(ayzenMailboxMessagesTable).set({ isRead: true }).where(inArray(ayzenMailboxMessagesTable.id, ids));
      break;
    case "markUnread":
      await db.update(ayzenMailboxMessagesTable).set({ isRead: false }).where(inArray(ayzenMailboxMessagesTable.id, ids));
      break;
    case "star":
      await db.update(ayzenMailboxMessagesTable).set({ isStarred: true }).where(inArray(ayzenMailboxMessagesTable.id, ids));
      break;
    case "unstar":
      await db.update(ayzenMailboxMessagesTable).set({ isStarred: false }).where(inArray(ayzenMailboxMessagesTable.id, ids));
      break;
    case "archive":
      await db.update(ayzenMailboxMessagesTable).set({ folder: "archive", folderId: null, isDraft: false }).where(inArray(ayzenMailboxMessagesTable.id, ids));
      break;
    case "trash":
      await db.update(ayzenMailboxMessagesTable).set({ folder: "trash", folderId: null, isDraft: false }).where(inArray(ayzenMailboxMessagesTable.id, ids));
      break;
    case "delete": {
      // Same two-stage rule as the single-message DELETE route: only
      // messages already sitting in Trash actually get permanently
      // removed here; anything else in the selection is moved to Trash
      // instead of being destroyed outright (bulk-selecting across
      // folders shouldn't be able to skip the "are you sure" of Trash).
      const trashedIds = owned.filter((r) => r.folder === "trash").map((r) => r.id);
      const otherIds = owned.filter((r) => r.folder !== "trash").map((r) => r.id);
      if (trashedIds.length) {
        await db.delete(ayzenMailboxAttachmentsTable).where(inArray(ayzenMailboxAttachmentsTable.messageId, trashedIds));
        await db.delete(ayzenMailboxMessagesTable).where(inArray(ayzenMailboxMessagesTable.id, trashedIds));
      }
      if (otherIds.length) {
        await db.update(ayzenMailboxMessagesTable).set({ folder: "trash", folderId: null, isDraft: false }).where(inArray(ayzenMailboxMessagesTable.id, otherIds));
      }
      break;
    }
    case "move": {
      const target = await resolveMoveTarget(userId, folder, folderId);
      if (!target.ok) { res.status(400).json({ error: target.error }); return; }
      const isDraft = target.folder === "drafts";
      await db.update(ayzenMailboxMessagesTable).set({ folder: target.folder, folderId: target.folderId, isDraft }).where(inArray(ayzenMailboxMessagesTable.id, ids));
      break;
    }
    case "snooze": {
      if (!snoozeUntil) { res.status(400).json({ error: "until is required for snooze" }); return; }
      await db.update(ayzenMailboxMessagesTable).set({ folder: "snoozed", folderId: null, isDraft: false, snoozedUntil: snoozeUntil }).where(inArray(ayzenMailboxMessagesTable.id, ids));
      break;
    }
    case "unsnooze":
      await db.update(ayzenMailboxMessagesTable).set({ folder: "inbox", snoozedUntil: null }).where(inArray(ayzenMailboxMessagesTable.id, ids));
      break;
    case "spam": {
      await db.update(ayzenMailboxMessagesTable).set({ folder: "spam", folderId: null, isDraft: false }).where(inArray(ayzenMailboxMessagesTable.id, ids));
      // One report per distinct sender, not per message — reporting three
      // messages from the same address should count as one report against
      // that sender, same as clicking "Mark spam" three times on the same
      // person wouldn't reasonably mean three separate strikes.
      const inboundSenders = new Set(owned.filter((r) => r.direction === "inbound").map((r) => r.fromAddr));
      for (const sender of inboundSenders) await recordSpamReport(userId, sender);
      break;
    }
    case "notSpam": {
      const spamIds = owned.filter((r) => r.folder === "spam").map((r) => r.id);
      if (spamIds.length) {
        await db.update(ayzenMailboxMessagesTable).set({ folder: "inbox", folderId: null }).where(inArray(ayzenMailboxMessagesTable.id, spamIds));
        const inboundSenders = new Set(owned.filter((r) => r.direction === "inbound" && r.folder === "spam").map((r) => r.fromAddr));
        for (const sender of inboundSenders) await clearSenderSpamFlags(userId, sender);
      }
      break;
    }
    case "addLabel":
    case "removeLabel": {
      const lid = parseInt(String(labelId ?? ""), 10);
      if (!Number.isFinite(lid)) { res.status(400).json({ error: "labelId is required for addLabel/removeLabel" }); return; }
      const [labelRow] = await db.select({ id: ayzenMailboxLabelsTable.id }).from(ayzenMailboxLabelsTable)
        .where(and(eq(ayzenMailboxLabelsTable.id, lid), eq(ayzenMailboxLabelsTable.userId, userId)));
      if (!labelRow) { res.status(404).json({ error: "Label not found" }); return; }
      if (action === "removeLabel") {
        await db.delete(ayzenMailboxMessageLabelsTable)
          .where(and(eq(ayzenMailboxMessageLabelsTable.labelId, lid), inArray(ayzenMailboxMessageLabelsTable.messageId, ids)));
      } else {
        // Skip ids that already carry the label — an unconditional bulk
        // insert would violate the (message_id, label_id) primary key the
        // moment any selected message already had this label.
        const existing = await db.select({ messageId: ayzenMailboxMessageLabelsTable.messageId }).from(ayzenMailboxMessageLabelsTable)
          .where(and(eq(ayzenMailboxMessageLabelsTable.labelId, lid), inArray(ayzenMailboxMessageLabelsTable.messageId, ids)));
        const already = new Set(existing.map((r) => r.messageId));
        const toInsert = ids.filter((id) => !already.has(id));
        if (toInsert.length) {
          await db.insert(ayzenMailboxMessageLabelsTable).values(toInsert.map((messageId) => ({ messageId, labelId: lid })));
        }
      }
      break;
    }
  }

  res.json({ ok: true, affected: ids.length });
});

// DELETE /ayzen-email/mailbox/:id — two-stage delete like Gmail/Outlook:
// deleting from anywhere else moves the message to Trash (recoverable via
// the move route above); deleting a message that's *already* in Trash
// permanently removes it (and its attachments) instead.
router.delete("/ayzen-email/mailbox/:id", requireAuth, requireAyzenMailboxMessageOwnership("ayzen_mailbox_message.delete"), async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const id = parseInt(req.params.id as string, 10);

  const [row] = await db.select().from(ayzenMailboxMessagesTable).where(and(eq(ayzenMailboxMessagesTable.id, id), eq(ayzenMailboxMessagesTable.userId, userId)));
  if (!row) { res.status(404).json({ error: "Message not found" }); return; }

  if (row.folder === "trash") {
    await db.delete(ayzenMailboxAttachmentsTable).where(eq(ayzenMailboxAttachmentsTable.messageId, id));
    await db.delete(ayzenMailboxMessagesTable).where(eq(ayzenMailboxMessagesTable.id, id));
    res.json({ ok: true, permanentlyDeleted: true });
    return;
  }

  await db.update(ayzenMailboxMessagesTable).set({ folder: "trash", folderId: null, isDraft: false })
    .where(eq(ayzenMailboxMessagesTable.id, id));
  res.json({ ok: true, permanentlyDeleted: false });
});

// DELETE /ayzen-email/mailbox/trash/empty — permanently deletes everything
// currently in Trash for this user in one go ("Empty Trash").
router.delete("/ayzen-email/mailbox/trash/empty", requireAuth, async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const trashed = await db.select({ id: ayzenMailboxMessagesTable.id }).from(ayzenMailboxMessagesTable)
    .where(and(eq(ayzenMailboxMessagesTable.userId, userId), eq(ayzenMailboxMessagesTable.folder, "trash")));
  const ids = trashed.map((r) => r.id);
  if (ids.length) {
    await db.delete(ayzenMailboxAttachmentsTable).where(inArray(ayzenMailboxAttachmentsTable.messageId, ids));
    await db.delete(ayzenMailboxMessagesTable).where(inArray(ayzenMailboxMessagesTable.id, ids));
  }
  res.json({ ok: true, deletedCount: ids.length });
});

// ─── Drafts ─────────────────────────────────────────────────────────────────

// POST /ayzen-email/mailbox/drafts — save a new draft. Body is the same
// shape as /send but nothing actually goes out over Resend yet.
router.post("/ayzen-email/mailbox/drafts", requireAuth, sendBodyParser, async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
  if (!user?.ayzenEmail || user.ayzenEmailMode !== "native") {
    res.status(400).json({ error: "You need a native AYZEN Email address first — claim one via /ayzen-email/claim-native" });
    return;
  }

  const { to, cc, bcc, subject, html, text, inReplyTo, references } = req.body as {
    to?: string; cc?: string; bcc?: string; subject?: string; html?: string; text?: string; inReplyTo?: string; references?: string;
  };
  const threadId = await resolveThreadId(userId, inReplyTo, references, null);
  const [draft] = await db.insert(ayzenMailboxMessagesTable).values({
    userId,
    direction: "outbound",
    folder: "drafts",
    isDraft: true,
    inReplyTo: inReplyTo ?? null,
    referencesHeader: references ?? null,
    threadId,
    fromAddr: user.ayzenEmail,
    toAddr: to ?? "",
    ccAddr: cc ?? null,
    bccAddr: bcc ?? null,
    subject: subject ?? "",
    textBody: encryptField(text ?? null),
    htmlBody: encryptField(html ?? null),
    hasAttachments: false,
  }).returning();

  res.status(201).json(fmt(draft));
});

// PATCH /ayzen-email/mailbox/drafts/:id — autosave/update a draft in place.
router.patch("/ayzen-email/mailbox/drafts/:id", requireAuth, requireAyzenMailboxMessageOwnership("ayzen_mailbox_message.draft.update", "Draft not found"), sendBodyParser, async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const id = parseInt(req.params.id as string, 10);
  const { to, cc, bcc, subject, html, text } = req.body as { to?: string; cc?: string; bcc?: string; subject?: string; html?: string; text?: string };

  const [existing] = await db.select().from(ayzenMailboxMessagesTable)
    .where(and(eq(ayzenMailboxMessagesTable.id, id), eq(ayzenMailboxMessagesTable.userId, userId), eq(ayzenMailboxMessagesTable.isDraft, true)));
  if (!existing) { res.status(404).json({ error: "Draft not found" }); return; }

  const [row] = await db.update(ayzenMailboxMessagesTable).set({
    toAddr: to ?? existing.toAddr,
    ccAddr: cc !== undefined ? (cc || null) : existing.ccAddr,
    bccAddr: bcc !== undefined ? (bcc || null) : existing.bccAddr,
    subject: subject ?? existing.subject,
    textBody: text !== undefined ? encryptField(text) : existing.textBody,
    htmlBody: html !== undefined ? encryptField(html) : existing.htmlBody,
  }).where(eq(ayzenMailboxMessagesTable.id, id)).returning();

  res.json(fmt(row));
});

// Idempotent Send: builds the same response shape POST /send would have
// returned, from a message that (per idempotencyKey) already exists —
// either because this is a client retry of an earlier successful request,
// or because a concurrent duplicate lost the insert/update race below.
// Reflects the row's *current* folder rather than blindly replaying
// "queued"/"scheduled" again, since by the time a retry lands the worker
// may already have moved it on (e.g. sent, or abandoned back to drafts).
async function replaySendResult(existing: typeof ayzenMailboxMessagesTable.$inferSelect) {
  if (existing.folder === "scheduled") {
    return { id: existing.id, scheduled: true, scheduledSendAt: existing.scheduledSendAt!.toISOString(), deliveryStatus: existing.deliveryStatus, duplicate: true };
  }
  const [{ value: attachmentCount }] = await db.select({ value: count() }).from(ayzenMailboxAttachmentsTable)
    .where(eq(ayzenMailboxAttachmentsTable.messageId, existing.id));
  return { id: existing.id, queued: existing.folder === "outbox", sent: existing.folder === "sent", attachmentCount, deliveryStatus: existing.deliveryStatus, duplicate: true };
}

// POST /ayzen-email/mailbox/send — compose & send from the user's own username@ayzen.tech
// Body: { to, subject, html?, text?, inReplyTo?, draftId?, attachments?: [{ filename, contentType, dataBase64 }] }
// If draftId is given (sending an existing draft), that row is updated
// in place and moved to Sent instead of inserting a new message.
// PHASE 5 (admin credit console request): sending mail through the native
// mailbox is a metered action (wisp.mail_send) — distinct from
// wisp.custom_send (routes/email-compose.ts's external relay accounts).
// Charge-on-success below, at whichever of the two success paths this
// request actually takes (scheduled vs. immediate/outbox) — an idempotent
// replay of an already-sent message never re-charges.
router.post("/ayzen-email/mailbox/send", requireAuth, requireCreditBalance("wisp.mail_send"), sendBodyParser, async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
  if (!user?.ayzenEmail || user.ayzenEmailMode !== "native") {
    res.status(400).json({ error: "You need a native AYZEN Email address first — claim one via /ayzen-email/claim-native" });
    return;
  }
  const cfg = await getResendConfig();
  if (!cfg) { res.status(503).json({ error: "Resend Email isn't configured" }); return; }

  const { to, cc, bcc, subject, html, text, inReplyTo, references, draftId, scheduledSendAt, attachments, idempotencyKey, confirmFlaggedRecipients } = req.body as {
    to?: string; cc?: string; bcc?: string; subject?: string; html?: string; text?: string; inReplyTo?: string; references?: string; draftId?: number;
    scheduledSendAt?: string;
    attachments?: { filename?: string; contentType?: string; dataBase64?: string }[];
    idempotencyKey?: string;
    // Bounce + Complaint Handling (Phase 2) — set by the compose UI after
    // the user confirms a "this address has bounced repeatedly" warning
    // (see the RECIPIENT_FLAGGED response below). Never bypasses
    // RECIPIENT_BLOCKED — that gate has no override short of clearing the
    // flag first via DELETE /problematic-recipients/:email.
    confirmFlaggedRecipients?: boolean;
  };
  if (!to || !subject || (!html && !text)) { res.status(400).json({ error: "to, subject, and html or text are required" }); return; }

  // Idempotent Send: the client sends the same idempotencyKey on every
  // attempt to send this one compose action (double-click on Send, or a
  // retry after the original request's response was lost to a network
  // blip/timeout). If a message already exists for this user+key, this
  // request is a repeat of one that already went through — hand back that
  // message's outcome again instead of inserting/updating a second one,
  // which is what used to send the same email out twice. Checked before
  // the draftId lookup below on purpose: a retried send-from-draft would
  // otherwise 404 here (the first request already flipped the draft's
  // isDraft to false), which is confusing even though it isn't a duplicate
  // send. Checked before the Bounce + Complaint recipient gate below too —
  // a retry of an already-sent message should replay that outcome, not get
  // newly blocked because the recipient's status changed *after* the
  // original send already went through.
  if (idempotencyKey) {
    const [existing] = await db.select().from(ayzenMailboxMessagesTable)
      .where(and(eq(ayzenMailboxMessagesTable.userId, userId), eq(ayzenMailboxMessagesTable.idempotencyKey, idempotencyKey)));
    if (existing) {
      res.status(200).json(await replaySendResult(existing));
      return;
    }
  }

  // Bounce + Complaint Handling (Phase 3) — account-wide gate, checked
  // BEFORE the per-recipient gate below since it's the broader of the two:
  // no reason to evaluate individual recipients if the whole account is
  // paused. Unlike RECIPIENT_BLOCKED/RECIPIENT_FLAGGED, there's no
  // confirm-and-resend path here — resuming is a deliberate Settings
  // action (POST /sending-health/resume), not something a retry of this
  // same send can satisfy.
  const health = await getSendingHealth(userId);
  if (health.status === "paused") {
    res.status(423).json({
      error: `Sending is paused: ${health.pausedReason ?? "bounce/complaint rate too high"}. Review Problematic Recipients in Settings, then resume sending from there.`,
      code: "SENDING_PAUSED",
      pausedReason: health.pausedReason,
    });
    return;
  }

  // Bounce + Complaint Handling (Phase 2) — send-time enforcement. Checked
  // against every To/Cc/Bcc address before anything is written, so a
  // blocked/flagged recipient can't slip through the Scheduled Send branch
  // either (both branches sit below this). 'blocked' always stops the
  // send; 'flagged' only stops it once, pending confirmFlaggedRecipients —
  // see lib/mail-recipient-reputation.ts's checkOutboundRecipients() for
  // why the two are treated differently.
  const allRecipientAddrs = [
    ...extractAllEmails(to),
    ...(cc ? extractAllEmails(cc) : []),
    ...(bcc ? extractAllEmails(bcc) : []),
  ];
  const { blocked, flagged } = await checkOutboundRecipients(userId, allRecipientAddrs);
  if (blocked.length) {
    res.status(422).json({
      error: `Can't send — ${blocked.join(", ")} ${blocked.length === 1 ? "is" : "are"} blocked after a spam complaint. Clear it from Settings first if you're sure.`,
      code: "RECIPIENT_BLOCKED",
      blockedRecipients: blocked,
    });
    return;
  }
  if (flagged.length && !confirmFlaggedRecipients) {
    res.status(409).json({
      error: `${flagged.map((f) => f.email).join(", ")} ${flagged.length === 1 ? "has" : "have"} bounced repeatedly. Send anyway?`,
      code: "RECIPIENT_FLAGGED",
      flaggedRecipients: flagged,
    });
    return;
  }

  // Scheduled Send: a future scheduledSendAt queues the message in the
  // Scheduled folder instead of actually sending it now —
  // lib/mail-schedule-cron.ts's sweep does the real Resend send once it's
  // due. Same future-date validation the snooze route uses.
  let scheduledFor: Date | null = null;
  if (scheduledSendAt) {
    const parsed = new Date(scheduledSendAt);
    if (Number.isNaN(parsed.getTime()) || parsed.getTime() <= Date.now()) {
      res.status(400).json({ error: "scheduledSendAt must be a valid future date/time" }); return;
    }
    scheduledFor = parsed;
  }

  let draftRow: typeof ayzenMailboxMessagesTable.$inferSelect | null = null;
  if (draftId != null) {
    const [d] = await db.select().from(ayzenMailboxMessagesTable)
      .where(and(eq(ayzenMailboxMessagesTable.id, draftId), eq(ayzenMailboxMessagesTable.userId, userId), eq(ayzenMailboxMessagesTable.isDraft, true)));
    if (!d) { res.status(404).json({ error: "Draft not found" }); return; }
    draftRow = d;
  }

  // Validate + normalize attachments before calling out to Resend, so a bad
  // one fails the whole send instead of silently going out without it.
  const cleanAttachments: { filename: string; contentType: string; base64: string; sizeBytes: number }[] = [];
  if (attachments?.length) {
    for (const a of attachments) {
      if (!a?.filename || !a?.dataBase64) { res.status(400).json({ error: "Each attachment needs filename and dataBase64" }); return; }
      const b64 = a.dataBase64.includes(",") && a.dataBase64.trim().startsWith("data:") ? a.dataBase64.slice(a.dataBase64.indexOf(",") + 1) : a.dataBase64;
      let raw: Buffer;
      try { raw = Buffer.from(b64, "base64"); } catch { res.status(400).json({ error: `Attachment "${a.filename}" is not valid base64` }); return; }
      if (raw.length === 0) { res.status(400).json({ error: `Attachment "${a.filename}" is empty` }); return; }
      if (raw.length > MAX_ATTACHMENT_BYTES) {
        res.status(413).json({ error: `Attachment "${a.filename}" is too large`, code: "ATTACHMENT_TOO_LARGE", solution: `Attachments are limited to ${Math.floor(MAX_ATTACHMENT_BYTES / (1024 * 1024))}MB each.` });
        return;
      }
      cleanAttachments.push({ filename: a.filename.slice(0, 255), contentType: a.contentType?.slice(0, 100) || "application/octet-stream", base64: b64, sizeBytes: raw.length });
    }
  }

  // Resolve inReplyTo/references before send so we know the thread this
  // message joins (draft edits can carry forward whatever was captured when
  // the reply/forward was first opened, same as the fields below).
  const effectiveInReplyTo = inReplyTo ?? draftRow?.inReplyTo ?? undefined;
  const effectiveReferences = references ?? draftRow?.referencesHeader ?? undefined;
  const threadId = await resolveThreadId(userId, effectiveInReplyTo, effectiveReferences, null);

  if (scheduledFor) {
    // Undo Send (Phase 2) folds Scheduled Send onto the same Send Queue
    // immediate sends use, instead of leaving it to the separate
    // once-a-minute cron (lib/mail-schedule-cron.ts) to notice this row
    // became due and hand it off. enqueueSend(tx, id, delayMs) — the exact
    // same helper the immediate-send path below calls with the undo window
    // — is called here too, with delayMs = scheduledFor - now instead. That
    // gives this message a real 'pending' send-queue row from the moment
    // it's scheduled, not just from whenever the cron next ticks, so
    // reschedule/cancel-schedule (below) can guard on that row's status the
    // exact same way PATCH /:id/undo-send already does for immediate sends
    // — one unified "is it still safe to pull this back" check for both
    // send paths, rather than two bespoke ones.
    //
    // Message + queue row committed together, same atomicity guarantee the
    // immediate-send path below already has: a crash between the two could
    // otherwise leave a message stuck in 'scheduled' forever (folder set,
    // no queue row to ever pick it up) or a queue row with no message.
    let scheduledMessage: typeof ayzenMailboxMessagesTable.$inferSelect;
    try {
      scheduledMessage = await db.transaction(async (tx) => {
        let msg: typeof ayzenMailboxMessagesTable.$inferSelect;
        if (draftRow) {
          [msg] = await tx.update(ayzenMailboxMessagesTable).set({
            direction: "outbound",
            folder: "scheduled",
            folderId: null,
            isDraft: false,
            scheduledSendAt: scheduledFor,
            scheduleAttempts: 0,
            inReplyTo: effectiveInReplyTo ?? null,
            referencesHeader: effectiveReferences ?? null,
            threadId,
            fromAddr: user.ayzenEmail,
            toAddr: to,
            ccAddr: cc ?? null,
            bccAddr: bcc ?? null,
            subject,
            textBody: encryptField(text ?? null),
            htmlBody: encryptField(html ?? null),
            hasAttachments: cleanAttachments.length > 0,
            idempotencyKey: idempotencyKey ?? null,
            deliveryStatus: "queued",
            deliveryStatusAt: new Date(),
          }).where(eq(ayzenMailboxMessagesTable.id, draftRow.id)).returning();
          // A draft's attachments (if any were saved earlier) are replaced by
          // whatever is queued with it, same as an immediate send.
          await tx.delete(ayzenMailboxAttachmentsTable).where(eq(ayzenMailboxAttachmentsTable.messageId, draftRow.id));
        } else {
          [msg] = await tx.insert(ayzenMailboxMessagesTable).values({
            userId,
            direction: "outbound",
            folder: "scheduled",
            scheduledSendAt: scheduledFor,
            inReplyTo: effectiveInReplyTo ?? null,
            referencesHeader: effectiveReferences ?? null,
            threadId,
            fromAddr: user.ayzenEmail,
            toAddr: to,
            ccAddr: cc ?? null,
            bccAddr: bcc ?? null,
            subject,
            textBody: encryptField(text ?? null),
            htmlBody: encryptField(html ?? null),
            hasAttachments: cleanAttachments.length > 0,
            idempotencyKey: idempotencyKey ?? null,
            deliveryStatus: "queued",
            deliveryStatusAt: new Date(),
          }).returning();
        }

        if (cleanAttachments.length) {
          await tx.insert(ayzenMailboxAttachmentsTable).values(
            cleanAttachments.map((a) => ({
              messageId: msg.id,
              filename: a.filename,
              contentType: a.contentType,
              sizeBytes: a.sizeBytes,
              encryptedContent: encryptField(a.base64),
            })),
          );
        }

        await enqueueSend(tx, msg.id, scheduledFor.getTime() - Date.now());
        return msg;
      });
    } catch (err: any) {
      // Idempotent Send race: two near-simultaneous requests with the same
      // key both passed the pre-check above before either committed. The
      // unique (user_id, idempotency_key) index lets only one through —
      // the loser lands here and just replays the winner's row instead of
      // erroring out to the user.
      if (err?.code === "23505" && idempotencyKey) {
        const [existing] = await db.select().from(ayzenMailboxMessagesTable)
          .where(and(eq(ayzenMailboxMessagesTable.userId, userId), eq(ayzenMailboxMessagesTable.idempotencyKey, idempotencyKey)));
        if (existing) { res.status(200).json(await replaySendResult(existing)); return; }
      }
      throw err;
    }

    // Charge-on-success: the message is durably enqueued (send queue row
    // committed in the same transaction above) — that's "sent" from the
    // user's perspective even though the worker delivers it async.
    const scheduledCharge = await chargeCredits(userId, "wisp.mail_send");
    res.status(201).json({ id: scheduledMessage.id, scheduled: true, scheduledSendAt: scheduledMessage.scheduledSendAt!.toISOString(), deliveryStatus: scheduledMessage.deliveryStatus, _credits: scheduledCharge.ok ? { charged: scheduledCharge.charged, newBalance: scheduledCharge.newBalance } : null });
    return;
  }
  // Robust Send Queue (Phase 1): the message row + its queue row are
  // written in one transaction — either both commit or neither does, which
  // is the actual "durable" in durable outbox — and folder = 'outbox'
  // rather than 'sent' since sending is now the worker's job
  // (lib/mail-send-queue.ts), not this request handler's. No Resend call
  // happens here anymore.
  // Undo Send (Phase 2): per-user window (Settings, Gmail-style 5/10/20/30s
  // — see routes/mail-undo-send-settings.ts) instead of Phase 1's single
  // operator-set MAIL_UNDO_SEND_WINDOW_MS. Re-clamped defensively in case
  // the stored value is ever out of the send queue's supported range (e.g.
  // a row from before Phase 2, or a hand edit); computed once, up front, so
  // the value stamped onto the message row, the delay handed to
  // enqueueSend, and the value echoed back in the response can't drift
  // apart from each other.
  const undoWindowMs = clampUndoSendWindowMs(user.mailUndoSendWindowMs ?? UNDO_SEND_WINDOW_MS);
  const undoExpiresAtDate = new Date(Date.now() + undoWindowMs);

  let message: typeof ayzenMailboxMessagesTable.$inferSelect;
  try {
    message = await db.transaction(async (tx) => {
    let msg: typeof ayzenMailboxMessagesTable.$inferSelect;
    if (draftRow) {
      [msg] = await tx.update(ayzenMailboxMessagesTable).set({
        direction: "outbound",
        folder: "outbox",
        folderId: null,
        isDraft: false,
        inReplyTo: effectiveInReplyTo ?? null,
        referencesHeader: effectiveReferences ?? null,
        threadId,
        fromAddr: user.ayzenEmail,
        toAddr: to,
        ccAddr: cc ?? null,
        bccAddr: bcc ?? null,
        subject,
        textBody: encryptField(text ?? null),
        htmlBody: encryptField(html ?? null),
        hasAttachments: cleanAttachments.length > 0,
        idempotencyKey: idempotencyKey ?? null,
        deliveryStatus: "queued",
        deliveryStatusAt: new Date(),
        undoExpiresAt: undoExpiresAtDate,
      }).where(eq(ayzenMailboxMessagesTable.id, draftRow.id)).returning();
      // A draft's attachments (if any were saved earlier) are replaced by
      // whatever is queued with it, same as a fresh send.
      await tx.delete(ayzenMailboxAttachmentsTable).where(eq(ayzenMailboxAttachmentsTable.messageId, draftRow.id));
    } else {
      [msg] = await tx.insert(ayzenMailboxMessagesTable).values({
        userId,
        direction: "outbound",
        folder: "outbox",
        inReplyTo: effectiveInReplyTo ?? null,
        referencesHeader: effectiveReferences ?? null,
        threadId,
        fromAddr: user.ayzenEmail,
        toAddr: to,
        ccAddr: cc ?? null,
        bccAddr: bcc ?? null,
        subject,
        textBody: encryptField(text ?? null),
        htmlBody: encryptField(html ?? null),
        hasAttachments: cleanAttachments.length > 0,
        idempotencyKey: idempotencyKey ?? null,
        deliveryStatus: "queued",
        deliveryStatusAt: new Date(),
        undoExpiresAt: undoExpiresAtDate,
      }).returning();
    }

    if (cleanAttachments.length) {
      await tx.insert(ayzenMailboxAttachmentsTable).values(
        cleanAttachments.map((a) => ({
          messageId: msg.id,
          filename: a.filename,
          contentType: a.contentType,
          sizeBytes: a.sizeBytes,
          encryptedContent: encryptField(a.base64),
        })),
      );
    }

    await enqueueSend(tx, msg.id, undoWindowMs);
    return msg;
    });
  } catch (err: any) {
    // Idempotent Send race: same as the scheduled-send branch above — two
    // near-simultaneous requests with the same key both passed the
    // pre-check before either committed, the unique index let only one
    // through, and the loser replays the winner's row instead of erroring.
    if (err?.code === "23505" && idempotencyKey) {
      const [existing] = await db.select().from(ayzenMailboxMessagesTable)
        .where(and(eq(ayzenMailboxMessagesTable.userId, userId), eq(ayzenMailboxMessagesTable.idempotencyKey, idempotencyKey)));
      if (existing) { res.status(200).json(await replaySendResult(existing)); return; }
    }
    throw err;
  }

  // Undo Send: undoWindowMs/undoExpiresAt tell the client how long PATCH
  // /:id/undo-send above will actually work for — server-derived (now off
  // the user's own Settings preference, Phase 2) rather than a client-side
  // constant, so a Settings change or an admin retuning the env-var default
  // never needs a frontend redeploy. Also now stamped onto the message row
  // itself (undoExpiresAtDate, above) so the Outbox list's persistent
  // "Undo (Ns)" chip has something to read even after this toast-triggering
  // response is long gone (dismissed toast, reload, etc). Not included on
  // the Scheduled Send or idempotent-replay response branches above:
  // Scheduled Send already has its own always-available cancel-schedule,
  // and a replayed response reflects whatever the row's state already
  // settled to rather than re-promising a window that may have already
  // closed.
  // Charge-on-success: same reasoning as the scheduled-send branch above —
  // the message + send-queue row are durably committed at this point.
  const sendCharge = await chargeCredits(userId, "wisp.mail_send");
  res.status(202).json({
    id: message.id, queued: true, attachmentCount: cleanAttachments.length, deliveryStatus: message.deliveryStatus,
    undoWindowMs, undoExpiresAt: undoExpiresAtDate.toISOString(),
    _credits: sendCharge.ok ? { charged: sendCharge.charged, newBalance: sendCharge.newBalance } : null,
  });
});

export default router;
