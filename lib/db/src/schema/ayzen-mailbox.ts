import { pgTable, serial, text, integer, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// User-created custom mail folders (Folders + Drafts + Trash/Archive system —
// see migrations/037_ayzen_mailbox_folders.sql). The five system folders
// ('inbox' | 'sent' | 'drafts' | 'archive' | 'trash') live as plain string
// values on ayzenMailboxMessagesTable.folder and don't get a row here; only
// user-named folders ("Clients", "Receipts", ...) get one, referenced by
// ayzenMailboxMessagesTable.folderId when folder = 'custom'.
export const ayzenMailboxFoldersTable = pgTable("ayzen_mailbox_folders", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertAyzenMailboxFolderSchema = createInsertSchema(ayzenMailboxFoldersTable).omit({ id: true, createdAt: true });
export type InsertAyzenMailboxFolder = z.infer<typeof insertAyzenMailboxFolderSchema>;
export type AyzenMailboxFolder = typeof ayzenMailboxFoldersTable.$inferSelect;

// Native ayzen.tech mailbox — see migrations/036_ayzen_native_mailbox.sql and
// 037_ayzen_mailbox_folders.sql. Populated by routes/resend-webhook.ts
// (inbound) and routes/ayzen-mailbox.ts (outbound / drafts, when the user
// sends or saves a draft from their username@ayzen.tech address).
export const ayzenMailboxMessagesTable = pgTable("ayzen_mailbox_messages", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  direction: text("direction").notNull().default("inbound"),
  // Which folder this message currently lives in. One of the five system
  // folders, or 'custom' — in which case folderId names the actual folder.
  // Every message lives in exactly one folder at a time (moving a message
  // — e.g. inbox -> archive, or anything -> trash — just rewrites this
  // column rather than tagging/copying), which mirrors how Gmail/Outlook
  // model folders and keeps unread/list counts unambiguous.
  folder: text("folder").notNull().default("inbox"),
  folderId: integer("folder_id"),
  // True only while the message is an unsent draft. Flips to false (and
  // folder moves to 'sent') the moment it's actually sent.
  isDraft: boolean("is_draft").notNull().default(false),
  resendEmailId: text("resend_email_id"),
  messageId: text("message_id"),
  inReplyTo: text("in_reply_to"),
  // Raw RFC "References" header — every ancestor Message-ID in the chain,
  // oldest first, space-separated. In-Reply-To alone only names the
  // *immediate* parent, which breaks threading the moment that parent isn't
  // a message we have (e.g. we only ever saw a later reply). References
  // lets both the inbound webhook and the outbound send route find the
  // conversation's true root even in that case — see migrations/040.
  referencesHeader: text("references_header"),
  // Conversation key every message in the same thread shares (see
  // migrations/040_ayzen_mailbox_threading.sql for how it's derived and
  // backfilled). Not itself an RFC concept — it's our own grouping id,
  // usually seeded from the thread root's Message-ID.
  threadId: text("thread_id").notNull(),
  fromAddr: text("from_addr").notNull(),
  toAddr: text("to_addr").notNull(),
  ccAddr: text("cc_addr"),
  // Blind carbon copy — see migrations/041_ayzen_mailbox_compose_upgrade.sql.
  // Only ever visible to the sender's own mailbox (fmt() in
  // routes/ayzen-mailbox.ts returns it same as ccAddr); Resend receives it
  // on the send call but it's never present in headers the other
  // recipients see, which is the whole point of Bcc.
  bccAddr: text("bcc_addr"),
  subject: text("subject"),
  textBody: text("text_body"),
  htmlBody: text("html_body"),
  hasAttachments: boolean("has_attachments").notNull().default(false),
  isRead: boolean("is_read").notNull().default(false),
  isStarred: boolean("is_starred").notNull().default(false),
  // Set only while folder = 'snoozed' — when this a message was snoozed
  // until. routes/ayzen-mailbox.ts sweeps rows where this has passed back
  // to folder = 'inbox' (and clears this) on every mailbox read for the
  // owning user — see migrations/043_ayzen_mailbox_spam_snooze.sql.
  snoozedUntil: timestamp("snoozed_until"),
  forwardedTo: text("forwarded_to"),
  // Kept for backward compatibility with rows written before folders
  // existed; no longer consulted for filtering (folder = 'trash' is now the
  // source of truth for what shows in Trash). Left null on all new rows.
  deletedAt: timestamp("deleted_at"),
  // Scheduled Send — see migrations/045_ayzen_mailbox_schedule_analytics.sql.
  // Set only while folder = 'scheduled': when lib/mail-schedule-cron.ts
  // should actually fire this message off via Resend. Cleared (back to
  // null) once the message leaves 'scheduled' — either sent, cancelled
  // back to Drafts, or abandoned after too many failed attempts — same
  // "only meaningful while folder === X" convention snoozedUntil follows.
  scheduledSendAt: timestamp("scheduled_send_at"),
  // How many times lib/mail-schedule-cron.ts has tried (and failed) to
  // send this since it was last (re)scheduled. Reset to 0 on schedule/
  // reschedule; once it hits MAX_SCHEDULE_ATTEMPTS the cron gives up and
  // drops the message back to Drafts instead of retrying forever.
  scheduleAttempts: integer("schedule_attempts").notNull().default(0),
  // Delivery Tracking — see migrations/050_ayzen_mailbox_delivery_tracking.sql.
  // Queued -> Sending -> Accepted -> Delivered -> Bounced/Failed. The first
  // three (+ 'failed') are driven by lib/mail-send-queue.ts on our own side;
  // 'delivered'/'bounced' only ever get set by routes/resend-webhook.ts off
  // Resend's own outbound events. Nullable with no default, same as
  // idempotencyKey in migration 049 — only ever set on outbound rows going
  // forward, never backfilled onto inbound mail or pre-migration sends.
  deliveryStatus: text("delivery_status"),
  deliveryStatusAt: timestamp("delivery_status_at"),
  // Only ever set alongside deliveryStatus = 'bounced', by
  // routes/resend-webhook.ts off Resend's email.bounced event payload.
  bounceReason: text("bounce_reason"),
  // Bounce + Complaint Handling (Phase 1) — see
  // migrations/052_ayzen_mailbox_bounce_complaint.sql. Set by
  // routes/resend-webhook.ts off Resend's email.complained event. Kept
  // separate from deliveryStatus rather than adding a 'complained' status
  // value: a complaint fires *after* email.delivered (the recipient's mail
  // server already accepted and delivered the message — they're reporting
  // it as spam from their own inbox), so the message really was delivered;
  // overwriting deliveryStatus would lose that.
  complainedAt: timestamp("complained_at"),
  // Undo Send (Phase 2) — see migrations/051_ayzen_mailbox_undo_send_phase2.sql.
  // Only meaningful while folder === 'outbox', same "only meaningful while
  // folder === X" convention as scheduledSendAt/snoozedUntil above: the
  // moment lib/mail-send-queue.ts's enqueueSend() opens an undo window for
  // an immediate send, this is stamped with when it closes, so the Outbox
  // list can render a persistent "Undo (Ns)" chip straight off ordinary
  // GET data — no separate toast-only affordance, and it survives a
  // dismissed toast or a mid-window reload. Cleared (back to null) the
  // moment the message leaves outbox for any reason: undone (PATCH
  // /:id/undo-send), actually sent, or abandoned to Drafts after
  // MAX_SEND_ATTEMPTS.
  undoExpiresAt: timestamp("undo_expires_at"),
  receivedAt: timestamp("received_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertAyzenMailboxMessageSchema = createInsertSchema(ayzenMailboxMessagesTable).omit({ id: true, createdAt: true });
export type InsertAyzenMailboxMessage = z.infer<typeof insertAyzenMailboxMessageSchema>;
export type AyzenMailboxMessage = typeof ayzenMailboxMessagesTable.$inferSelect;

// The system folders every mailbox always has, in display order. Kept here
// (rather than only in the frontend) so route validation and the UI can't
// drift apart on what counts as a valid system folder value.
//
// 'snoozed' is exclusive-folder like the rest (see the comment on `folder`
// above) but is only ever entered/left through the dedicated snooze/unsnooze
// routes — never the generic move route — since it needs snoozedUntil set
// alongside it. 'spam' behaves exactly like archive/trash: plain move target,
// no extra column. 'scheduled' behaves like 'snoozed' — only ever entered
// via POST /send with scheduledSendAt, and left via the dedicated
// reschedule/cancel-schedule routes or lib/mail-schedule-cron.ts once it
// actually sends — since it needs scheduledSendAt set alongside it.
// 'outbox' is the same shape again, for the Robust Send Queue (see
// ayzenMailboxSendQueueTable below) — POST /send moves a non-scheduled
// message here (instead of straight to 'sent') the instant it's queued,
// and lib/mail-send-queue.ts's worker flips it to 'sent' once the Resend
// call actually succeeds. Never entered/left via the generic move route.
export const AYZEN_MAILBOX_SYSTEM_FOLDERS = ["inbox", "snoozed", "sent", "scheduled", "outbox", "drafts", "spam", "archive", "trash"] as const;
export type AyzenMailboxSystemFolder = (typeof AYZEN_MAILBOX_SYSTEM_FOLDERS)[number];

export const ayzenMailboxAttachmentsTable = pgTable("ayzen_mailbox_attachments", {
  id: serial("id").primaryKey(),
  messageId: integer("message_id").notNull(),
  filename: text("filename"),
  contentType: text("content_type"),
  sizeBytes: integer("size_bytes"),
  resendAttachmentId: text("resend_attachment_id"),
  // Populated only for OUTBOUND attachments (we have the bytes at send time,
  // since the client uploads them to us). Inbound attachments are fetched
  // on-demand from Resend via resendAttachmentId instead of being duplicated
  // here — see lib/resend-mail.ts getInboundAttachmentContent().
  encryptedContent: text("encrypted_content"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type AyzenMailboxAttachment = typeof ayzenMailboxAttachmentsTable.$inferSelect;

export const resendWebhookEventsTable = pgTable("resend_webhook_events", {
  eventId: text("event_id").primaryKey(),
  eventType: text("event_type"),
  receivedAt: timestamp("received_at").notNull().defaultNow(),
});

// ─── Labels ────────────────────────────────────────────────────────────────
// Gmail-style colored tags — see migrations/042_ayzen_mailbox_labels_filters_rules.sql.
// Unlike folders (exclusive — a message lives in exactly one), a message can
// carry any number of labels at once via ayzenMailboxMessageLabelsTable.
export const ayzenMailboxLabelsTable = pgTable("ayzen_mailbox_labels", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  name: text("name").notNull(),
  // A key into the fixed palette in components/mail/label-badge.tsx, not a
  // raw hex value — see AYZEN_LABEL_COLORS there for the allowed set.
  color: text("color").notNull().default("sky"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertAyzenMailboxLabelSchema = createInsertSchema(ayzenMailboxLabelsTable).omit({ id: true, createdAt: true });
export type InsertAyzenMailboxLabel = z.infer<typeof insertAyzenMailboxLabelSchema>;
export type AyzenMailboxLabel = typeof ayzenMailboxLabelsTable.$inferSelect;

// Fixed set of colors labels can use — kept in one place so the backend can
// validate against the exact same list the frontend's palette renders.
export const AYZEN_LABEL_COLORS = ["red", "orange", "yellow", "emerald", "sky", "violet", "pink", "slate"] as const;
export type AyzenLabelColor = (typeof AYZEN_LABEL_COLORS)[number];

export const ayzenMailboxMessageLabelsTable = pgTable("ayzen_mailbox_message_labels", {
  messageId: integer("message_id").notNull(),
  labelId: integer("label_id").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type AyzenMailboxMessageLabel = typeof ayzenMailboxMessageLabelsTable.$inferSelect;

// ─── Rules ─────────────────────────────────────────────────────────────────
// Saved "when inbound mail matches X, do Y" automations — see
// migrations/042_ayzen_mailbox_labels_filters_rules.sql and
// lib/mail-rules.ts (evaluation logic, run from routes/resend-webhook.ts
// right after a new inbound message is stored).
export const AYZEN_RULE_FIELDS = ["from", "to", "subject"] as const;
export type AyzenRuleField = (typeof AYZEN_RULE_FIELDS)[number];
export const AYZEN_RULE_MATCH_TYPES = ["contains", "equals"] as const;
export type AyzenRuleMatchType = (typeof AYZEN_RULE_MATCH_TYPES)[number];

export const ayzenMailboxRulesTable = pgTable("ayzen_mailbox_rules", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  name: text("name").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  field: text("field").notNull().default("from"),
  matchType: text("match_type").notNull().default("contains"),
  value: text("value").notNull(),
  actionLabelId: integer("action_label_id"),
  actionFolder: text("action_folder"),
  actionFolderId: integer("action_folder_id"),
  actionMarkRead: boolean("action_mark_read").notNull().default(false),
  actionStar: boolean("action_star").notNull().default(false),
  position: integer("position").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertAyzenMailboxRuleSchema = createInsertSchema(ayzenMailboxRulesTable).omit({ id: true, createdAt: true });
export type InsertAyzenMailboxRule = z.infer<typeof insertAyzenMailboxRuleSchema>;
export type AyzenMailboxRule = typeof ayzenMailboxRulesTable.$inferSelect;

// ─── Compose Templates ───────────────────────────────────────────────────────
// Reusable "canned response" bodies the compose box can insert (or a new
// message can be started from) — see migrations/056_ayzen_mailbox_templates.sql.
// Distinct from the single per-user signature (users.ayzenMailboxSignature):
// a user can save any number of these, each with its own name/subject/body,
// and picks one explicitly per compose rather than having it auto-inserted.
// bodyHtml is stored encrypted the same way message bodies are (see
// encryptField/decryptField usage in routes/ayzen-mailbox.ts) since it's
// arbitrary user-authored content that can carry the same kind of sensitive
// boilerplate (e.g. a "here's my bank details" canned reply) mail bodies do.
export const ayzenMailboxTemplatesTable = pgTable("ayzen_mailbox_templates", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  name: text("name").notNull(),
  // Optional — a template can be body-only (subject left blank means "don't
  // touch whatever the compose box already has" when inserted).
  subject: text("subject"),
  bodyHtml: text("body_html"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertAyzenMailboxTemplateSchema = createInsertSchema(ayzenMailboxTemplatesTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertAyzenMailboxTemplate = z.infer<typeof insertAyzenMailboxTemplateSchema>;
export type AyzenMailboxTemplate = typeof ayzenMailboxTemplatesTable.$inferSelect;

// ─── Contact Intelligence ────────────────────────────────────────────────────
// Explicitly-saved contacts (the "Add contact" button) — see
// migrations/045_ayzen_mailbox_schedule_analytics.sql and
// routes/ayzen-mailbox.ts. Distinct from the mailbox's own on-the-fly
// correspondent lookup (GET /mailbox/contacts/:email), which works for any
// address that's ever appeared in mail whether or not it's saved here — a
// saved row here just lets the user pin a name and mark it deliberately, and
// wins over whatever name that lookup would otherwise guess.
export const ayzenContactsTable = pgTable("ayzen_contacts", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  email: text("email").notNull(),
  name: text("name"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertAyzenContactSchema = createInsertSchema(ayzenContactsTable).omit({ id: true, createdAt: true });
export type InsertAyzenContact = z.infer<typeof insertAyzenContactSchema>;
export type AyzenContact = typeof ayzenContactsTable.$inferSelect;

// ─── Sender Reputation (Spam + Block) ───────────────────────────────────────
// One row per (user, sender email) — backs Block sender / Allow sender,
// "Mark spam" reporting, and basic inbound rate control. See
// migrations/046_ayzen_mailbox_spam_block.sql and lib/mail-spam.ts (in
// artifacts/api-server) for how each column gets read/written.
export const AYZEN_SENDER_STATUSES = ["neutral", "blocked", "allowed"] as const;
export type AyzenSenderStatus = (typeof AYZEN_SENDER_STATUSES)[number];

export const ayzenMailboxSenderReputationTable = pgTable("ayzen_mailbox_sender_reputation", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  email: text("email").notNull(),
  status: text("status").notNull().default("neutral"),
  spamReports: integer("spam_reports").notNull().default(0),
  // Rolling-window flood counter — see the migration comment for how
  // lib/mail-spam.ts uses these two together.
  receivedInWindow: integer("received_in_window").notNull().default(0),
  windowStartedAt: timestamp("window_started_at"),
  lastReceivedAt: timestamp("last_received_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type AyzenMailboxSenderReputation = typeof ayzenMailboxSenderReputationTable.$inferSelect;

// ─── Bounce + Complaint Handling (recipient reputation) ─────────────────────
// One row per (user, recipient email) — the outbound mirror of
// ayzenMailboxSenderReputationTable above. See
// migrations/052_ayzen_mailbox_bounce_complaint.sql for what each column
// means and lib/mail-recipient-reputation.ts (in artifacts/api-server) for
// how they're read/written, off routes/resend-webhook.ts's bounce/
// complaint/delivered handling.
export const AYZEN_RECIPIENT_STATUSES = ["ok", "flagged", "blocked"] as const;
export type AyzenRecipientStatus = (typeof AYZEN_RECIPIENT_STATUSES)[number];

export const ayzenMailboxRecipientReputationTable = pgTable("ayzen_mailbox_recipient_reputation", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  email: text("email").notNull(),
  status: text("status").notNull().default("ok"),
  bounceCount: integer("bounce_count").notNull().default(0),
  // Resets to 0 on the next successful delivery to this recipient —
  // "repeated failures" tracks a current streak, not a lifetime tally.
  consecutiveBounces: integer("consecutive_bounces").notNull().default(0),
  complaintCount: integer("complaint_count").notNull().default(0),
  lastBounceAt: timestamp("last_bounce_at"),
  lastComplaintAt: timestamp("last_complaint_at"),
  lastDeliveredAt: timestamp("last_delivered_at"),
  flaggedAt: timestamp("flagged_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type AyzenMailboxRecipientReputation = typeof ayzenMailboxRecipientReputationTable.$inferSelect;

// ─── Bounce + Complaint Handling (account-wide sending health) ──────────────
// See migrations/053_ayzen_mailbox_sending_health.sql for the full
// rationale. One row per user; read/written by
// lib/mail-sending-health.ts (in artifacts/api-server), off the same
// send/bounce/complaint events lib/mail-recipient-reputation.ts's
// per-recipient tracking already hooks.
export const AYZEN_SENDING_HEALTH_STATUSES = ["healthy", "warning", "paused"] as const;
export type AyzenSendingHealthStatus = (typeof AYZEN_SENDING_HEALTH_STATUSES)[number];

export const ayzenMailboxSendingHealthTable = pgTable("ayzen_mailbox_sending_health", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().unique(),
  windowStartedAt: timestamp("window_started_at").notNull().defaultNow(),
  sentInWindow: integer("sent_in_window").notNull().default(0),
  bouncedInWindow: integer("bounced_in_window").notNull().default(0),
  complainedInWindow: integer("complained_in_window").notNull().default(0),
  totalSent: integer("total_sent").notNull().default(0),
  totalBounced: integer("total_bounced").notNull().default(0),
  totalComplained: integer("total_complained").notNull().default(0),
  status: text("status").notNull().default("healthy"),
  pausedAt: timestamp("paused_at"),
  pausedReason: text("paused_reason"),
  // Bounce + Complaint Handling (Phase 4) — digest/batching for the
  // per-message bounce/complaint notifications Phase 1 fires individually.
  // See migrations/054_ayzen_mailbox_notification_digest.sql and
  // lib/mail-notification-digest.ts.
  burstNotifCount: integer("burst_notif_count").notNull().default(0),
  burstWindowStartedAt: timestamp("burst_window_started_at"),
  digestPendingBounces: integer("digest_pending_bounces").notNull().default(0),
  digestPendingComplaints: integer("digest_pending_complaints").notNull().default(0),
  lastDigestSentAt: timestamp("last_digest_sent_at"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type AyzenMailboxSendingHealth = typeof ayzenMailboxSendingHealthTable.$inferSelect;

// Singleton (id is always 1) — admin-tunable thresholds read by both
// lib/mail-sending-health.ts and lib/mail-recipient-reputation.ts. Rates
// are basis points (500 = 5.00%) to keep threshold comparisons exact
// integers instead of floats.
export const ayzenMailboxSendingConfigTable = pgTable("ayzen_mailbox_sending_config", {
  id: integer("id").primaryKey().default(1),
  bounceFlagThreshold: integer("bounce_flag_threshold").notNull().default(3),
  windowDays: integer("window_days").notNull().default(30),
  minSampleSize: integer("min_sample_size").notNull().default(20),
  warningBounceRateBp: integer("warning_bounce_rate_bp").notNull().default(500),
  pauseBounceRateBp: integer("pause_bounce_rate_bp").notNull().default(1000),
  pauseComplaintRateBp: integer("pause_complaint_rate_bp").notNull().default(50),
  complaintHardCap: integer("complaint_hard_cap").notNull().default(5),
  // Bounce + Complaint Handling (Phase 4) — digest/batching thresholds.
  // Flush cadence itself is env-var-driven (MAIL_DIGEST_CRON) — see
  // migrations/054's comment for why there's no digestFlushMinutes column.
  digestTriggerCount: integer("digest_trigger_count").notNull().default(5),
  digestBurstMinutes: integer("digest_burst_minutes").notNull().default(15),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type AyzenMailboxSendingConfig = typeof ayzenMailboxSendingConfigTable.$inferSelect;

// ─── Robust Send Queue ───────────────────────────────────────────────────────
// Durable outbox for outbound sends — see migrations/047_ayzen_mailbox_send_queue.sql
// and lib/mail-send-queue.ts (in artifacts/api-server). POST /send inserts
// the message row + a queue row here in the same DB transaction (that
// atomicity is the "durable" part of durable outbox: if the process dies
// between the two inserts, neither committed), then returns immediately —
// lib/mail-send-queue.ts's worker does the actual Resend call off the
// request path and flips the message to folder = 'sent' once it succeeds.
export const AYZEN_SEND_QUEUE_STATUSES = ["pending", "sending", "sent", "failed"] as const;
export type AyzenSendQueueStatus = (typeof AYZEN_SEND_QUEUE_STATUSES)[number];

export const ayzenMailboxSendQueueTable = pgTable("ayzen_mailbox_send_queue", {
  id: serial("id").primaryKey(),
  messageId: integer("message_id").notNull(),
  status: text("status").notNull().default("pending"),
  // Phase 1 never increments this (no retry yet) — Phase 2 increments it on
  // failure and caps it before giving up.
  attempts: integer("attempts").notNull().default(0),
  // The worker's claim query only picks up rows where this has passed.
  // Phase 1 always claims immediately (defaults to now()); Phase 2 pushes
  // this forward on failure for exponential backoff.
  nextAttemptAt: timestamp("next_attempt_at").notNull().defaultNow(),
  // Set (alongside status = 'sending') when a worker claims this row.
  // Phase 2 uses locked_at to recover rows abandoned by a worker that
  // crashed mid-send.
  lockedAt: timestamp("locked_at"),
  lockedBy: text("locked_by"),
  lastError: text("last_error"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertAyzenMailboxSendQueueSchema = createInsertSchema(ayzenMailboxSendQueueTable).omit({ id: true, createdAt: true });
export type InsertAyzenMailboxSendQueue = z.infer<typeof insertAyzenMailboxSendQueueSchema>;
export type AyzenMailboxSendQueue = typeof ayzenMailboxSendQueueTable.$inferSelect;
