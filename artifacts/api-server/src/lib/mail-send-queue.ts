/**
 * lib/mail-send-queue.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Robust Send Queue, Phase 1 (durable outbox + worker) + Phase 2 (retry /
 * exponential backoff / crash recovery).
 *
 * POST /ayzen-email/mailbox/send (routes/ayzen-mailbox.ts) used to call
 * sendAsAyzenUser() inline, awaited in the request handler — a Resend
 * timeout, a mid-call crash, or a failed post-send DB write could lose or
 * duplicate a message with zero record of the attempt. Now the send route
 * writes the message row (folder = 'outbox') + a queue row here in one DB
 * transaction and returns immediately; this worker claims due rows and does
 * the actual Resend call off the request path, same helpers
 * (resolveAttachmentContent, sendAsAyzenUser) mail-schedule-cron.ts already
 * uses for Scheduled Send.
 *
 * Phase 2 makes this resilient, mirroring lib/mail-schedule-cron.ts's
 * existing retry/abandon convention exactly rather than inventing a new one:
 *   - A failed send retries with exponential backoff (+ jitter) up to
 *     MAX_SEND_ATTEMPTS, then gives up and drops the *message* back to
 *     folder = 'drafts' — the same landing spot the scheduled-send cron
 *     abandons to, so however a send failed, the user always ends up in one
 *     consistent "this didn't go out, fix and resend" place.
 *   - Rows a worker leaves stuck in 'sending' because it died mid-send
 *     (deploy restart, OOM kill) are recovered two ways: a startup sweep
 *     (this instance just restarted, so its own init is the recovery
 *     point) and a per-tick stale-lock sweep (for the same-instance-never-
 *     restarted case where a claim silently hung).
 *   - A cheap idempotency guard covers the narrow window where crash
 *     recovery reclaims a row whose Resend call actually succeeded but
 *     whose local status update never landed: if the message already has a
 *     resendEmailId, treat it as sent instead of calling Resend again.
 *
 * Delivery Tracking (migration 050) piggybacks on this same file: it's the
 * only place that knows a send is actually about to be attempted, actually
 * succeeded, or has been given up on, so it also drives the message's
 * deliveryStatus column through 'sending' -> 'accepted' (success) or back
 * to 'queued' (will retry) / 'failed' (gave up). The next two stages,
 * 'delivered' and 'bounced', come from Resend's own outbound webhook events
 * once they land — see routes/resend-webhook.ts, not this file.
 *
 * Undo Send (Phase 1) also piggybacks here, for free: claimNextBatch() only
 * ever claims rows where next_attempt_at <= now(), and Phase 1/2 already
 * push that column forward for backoff — so giving a brand-new row a small
 * forward-dated next_attempt_at (instead of "now", the column's default)
 * is all it takes to open a window where the row is durably queued but
 * deliberately not yet claimable. routes/ayzen-mailbox.ts's new
 * PATCH /:id/undo-send flips the row to 'cancelled' inside that window;
 * 'cancelled' is excluded by claimNextBatch()'s `status = 'pending'` filter
 * the same way 'sent'/'failed' already are, so no query here needed to
 * change at all. See UNDO_SEND_WINDOW_MS below.
 *
 * Undo Send (Phase 2) makes two more things piggyback here for free:
 *   - The window itself becomes a per-user Settings preference
 *     (users.mailUndoSendWindowMs) instead of one operator-set env var —
 *     see clampUndoSendWindowMs()/UNDO_SEND_WINDOW_CHOICES_MS below and
 *     routes/mail-undo-send-settings.ts.
 *   - Scheduled Send's separate once-a-minute cron (lib/mail-schedule-cron.ts)
 *     is folded into this same queue: routes/ayzen-mailbox.ts's scheduled
 *     branch now calls enqueueSend() at schedule time too (with
 *     delayMs = scheduledSendAt - now instead of the undo window), so a
 *     scheduled message has a real 'pending' send-queue row from the moment
 *     it's scheduled — reschedule/cancel-schedule guard on that row's
 *     status = 'pending' the exact same way undo-send does, rather than
 *     each send path having its own bespoke "is it still safe to touch"
 *     check. The old cron now only exists as a backstop sweep for orphaned
 *     rows (see that file's header).
 */
import crypto from "crypto";
import cron from "node-cron";
import {
  db,
  usersTable,
  ayzenMailboxMessagesTable,
  ayzenMailboxAttachmentsTable,
  ayzenMailboxSendQueueTable,
} from "@workspace/db";
import { eq, inArray, sql } from "drizzle-orm";
import { logger } from "./logger";
import { logBus } from "./log-bus";
import { getResendConfig, sendAsAyzenUser } from "./resend-mail";
import { resolveAttachmentContent } from "./mail-attachment-content";
import { decryptField } from "./vault-crypto";
import { recordSend as recordSendingHealthSend } from "./mail-sending-health";

// One id per process, stamped onto locked_by when a row is claimed. Phase 1
// never read it back; Phase 2's stale-lock sweep still doesn't need to
// (it only cares about locked_at's age, not which worker went silent) but
// it's kept in the log line below for debugging multi-instance deploys.
const WORKER_ID = `${process.pid}-${crypto.randomUUID().slice(0, 8)}`;

const CLAIM_BATCH_SIZE = 10;

// Mirrors MAX_SCHEDULE_ATTEMPTS in mail-schedule-cron.ts — same give-up
// threshold for both send paths.
const MAX_SEND_ATTEMPTS = 5;

// Backoff: baseMs * 2^attempts, capped at maxMs, ±20% jitter so a mass
// failure (e.g. Resend itself is down) doesn't retry every message in
// lockstep. attempts 1..5 -> roughly 2s, 4s, 8s, 16s, 32s before the 5th
// failure lands the message in Drafts.
const BACKOFF_BASE_MS = 2_000;
const BACKOFF_MAX_MS = 5 * 60_000;

function nextAttemptDelay(attempts: number): number {
  const raw = Math.min(BACKOFF_BASE_MS * 2 ** attempts, BACKOFF_MAX_MS);
  const jitter = raw * 0.2 * (Math.random() * 2 - 1); // ±20%
  return Math.max(0, Math.round(raw + jitter));
}

// How long a row can sit locked in 'sending' before the stale-lock sweep
// reclaims it as abandoned — long enough that a legitimately slow Resend
// call/attachment resolve doesn't get reclaimed out from under itself,
// short enough that a truly stuck row (worker died, never restarted) isn't
// stranded for hours.
const SEND_STUCK_TIMEOUT_MS = 5 * 60_000;

// Undo Send: how long a freshly-queued immediate send sits
// claimable-but-not-yet-claimed before the worker is allowed to touch it,
// giving the user a window to pull it back via PATCH /:id/undo-send.
//
// Phase 1 had exactly one value here, operator-set via
// MAIL_UNDO_SEND_WINDOW_MS and applied to every user. Phase 2
// (routes/mail-undo-send-settings.ts) turns this into a per-user
// preference — Gmail-style 5/10/20/30s — stored on users.mailUndoSendWindowMs
// (migrations/051). MIN/MAX widened from Phase 1's 5-10s to 5-30s to make
// room for that range; UNDO_SEND_WINDOW_MS (the env-derived value) is now
// only the *default* a brand-new user's row starts at, plus the fallback
// used if a user row is ever somehow out of range. Scheduled Send is
// unaffected either way (it already has its own, much longer,
// cancel-any-time window via PATCH /:id/cancel-schedule).
export const MIN_UNDO_SEND_WINDOW_MS = 5_000;
export const MAX_UNDO_SEND_WINDOW_MS = 30_000;
const DEFAULT_UNDO_SEND_WINDOW_MS = 8_000;

// The only choices Settings actually offers (routes/mail-undo-send-settings.ts
// validates PATCH bodies against this same list, so the two can't drift).
export const UNDO_SEND_WINDOW_CHOICES_MS = [5_000, 10_000, 20_000, 30_000] as const;
export type UndoSendWindowChoiceMs = (typeof UNDO_SEND_WINDOW_CHOICES_MS)[number];

/** Clamps an arbitrary ms value into the send queue's supported undo-window range. */
export function clampUndoSendWindowMs(ms: number): number {
  if (!Number.isFinite(ms)) return DEFAULT_UNDO_SEND_WINDOW_MS;
  return Math.min(MAX_UNDO_SEND_WINDOW_MS, Math.max(MIN_UNDO_SEND_WINDOW_MS, Math.round(ms)));
}

function resolveUndoSendWindowMs(): number {
  const raw = Number(process.env.MAIL_UNDO_SEND_WINDOW_MS);
  if (!Number.isFinite(raw)) return DEFAULT_UNDO_SEND_WINDOW_MS;
  return clampUndoSendWindowMs(raw);
}
// Env-derived default — see the comment above for what this is (and isn't)
// used for now that the window is per-user.
export const UNDO_SEND_WINDOW_MS = resolveUndoSendWindowMs();

// Same shape as the `tx` param other routes' db.transaction(async (tx) => ...)
// callbacks already use (see routes/wallets.ts, routes/credits.ts) —
// inferred straight off db.transaction so it stays correct if the drizzle
// db type ever changes.
type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Enqueues a durable send for a message that's already been inserted/
 * updated in the same transaction. Callers MUST pass the transaction
 * handle they're already inside (routes/ayzen-mailbox.ts's POST /send) —
 * enqueueing outside the message's own transaction would reopen exactly
 * the "wrote the message but not the queue row, or vice versa" gap this
 * whole feature exists to close.
 *
 * `delayMs` (default UNDO_SEND_WINDOW_MS, the env-derived fallback — actual
 * callers pass the user's own mailUndoSendWindowMs, see routes/ayzen-mailbox.ts)
 * is Undo Send's entire implementation on this side: it pushes
 * next_attempt_at into the future instead of leaving it at the column's
 * "now()" default, so the row sits claimable-but-not-due for a few seconds
 * before the worker is allowed to pick it up. Pass 0 for anything that
 * shouldn't get an undo window (there isn't a caller that needs to yet, but
 * a future "resend immediately" action might).
 *
 * Also reused, unmodified, by Scheduled Send (Phase 2 —
 * lib/mail-schedule-cron.ts / routes/ayzen-mailbox.ts's scheduled branch):
 * passing `scheduledSendAt - now` as delayMs is what lets a scheduled
 * message's queue row exist from the moment it's scheduled rather than only
 * once the old once-a-minute cron promoted it, unifying both send paths
 * onto the same 'pending' -> 'cancelled' undo/cancel guard.
 */
export async function enqueueSend(tx: DbTx, messageId: number, delayMs: number = UNDO_SEND_WINDOW_MS): Promise<void> {
  await tx.insert(ayzenMailboxSendQueueTable).values({
    messageId,
    nextAttemptAt: new Date(Date.now() + Math.max(0, delayMs)),
  });
}

/**
 * Atomically claims up to `limit` due rows: FOR UPDATE SKIP LOCKED means
 * concurrent workers (multiple API server instances) never claim the same
 * row twice, without needing a separate distributed lock.
 */
async function claimNextBatch(limit: number): Promise<(typeof ayzenMailboxSendQueueTable.$inferSelect)[]> {
  return db.transaction(async (trx) => {
    const claimable = await trx.execute(sql`
      SELECT id FROM ayzen_mailbox_send_queue
      WHERE status = 'pending' AND next_attempt_at <= now()
      ORDER BY created_at
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    `);
    const ids = (claimable.rows as { id: number }[]).map((r) => r.id);
    if (!ids.length) return [];

    return trx
      .update(ayzenMailboxSendQueueTable)
      .set({ status: "sending", lockedAt: new Date(), lockedBy: WORKER_ID })
      .where(inArray(ayzenMailboxSendQueueTable.id, ids))
      .returning();
  });
}

/** Sends one claimed queue row and updates both it and its message row. Returns the outcome for the sweep's tally. */
async function processQueueRow(row: typeof ayzenMailboxSendQueueTable.$inferSelect): Promise<"sent" | "failed"> {
  const [message] = await db.select().from(ayzenMailboxMessagesTable)
    .where(eq(ayzenMailboxMessagesTable.id, row.messageId));
  if (!message) {
    // Message row is gone (shouldn't happen — FK is ON DELETE CASCADE, so
    // this queue row would have gone with it — but guard anyway).
    await db.update(ayzenMailboxSendQueueTable).set({
      status: "failed", lastError: "Message no longer exists",
    }).where(eq(ayzenMailboxSendQueueTable.id, row.id));
    return "failed";
  }

  // Idempotency guard: if crash recovery reclaimed this row after a Resend
  // call that actually succeeded but whose local status update never
  // landed (worker died between the two), don't send twice — just catch
  // the queue row up to reality. Not full end-to-end idempotency (that
  // would need a Resend-side idempotency key on the original call, which
  // we don't have), just a cheap check for the specific gap crash recovery
  // can reopen.
  if (message.resendEmailId) {
    await db.update(ayzenMailboxMessagesTable).set({
      folder: "sent", folderId: null, deliveryStatus: "accepted", deliveryStatusAt: new Date(),
    })
      .where(eq(ayzenMailboxMessagesTable.id, message.id));
    await db.update(ayzenMailboxSendQueueTable).set({ status: "sent", lastError: null })
      .where(eq(ayzenMailboxSendQueueTable.id, row.id));
    logger.warn({ messageId: message.id, queueId: row.id }, "Send queue: message already had a resendEmailId — skipped duplicate send");
    return "sent";
  }

  // Delivery Tracking: this row is now actually in flight — set before the
  // Resend call itself so a slow/hung call still shows as "Sending" rather
  // than lingering on "Queued" (see migrations/050_ayzen_mailbox_delivery_tracking.sql).
  await db.update(ayzenMailboxMessagesTable).set({ deliveryStatus: "sending", deliveryStatusAt: new Date() })
    .where(eq(ayzenMailboxMessagesTable.id, message.id));

  try {
    const cfg = await getResendConfig();
    if (!cfg) throw new Error("Resend Email isn't configured");

    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, message.userId));
    if (!user?.ayzenEmail || user.ayzenEmailMode !== "native") {
      throw new Error("User no longer has a native AYZEN Email address");
    }

    const attachmentRows = await db.select().from(ayzenMailboxAttachmentsTable)
      .where(eq(ayzenMailboxAttachmentsTable.messageId, message.id));
    const resolvedAttachments = attachmentRows.length
      ? await Promise.all(attachmentRows.map((a) => resolveAttachmentContent(message, a)))
      : [];

    const username = user.ayzenEmail.split("@")[0]!;
    const result = await sendAsAyzenUser(cfg, {
      fromUsername: username,
      to: message.toAddr,
      cc: message.ccAddr ?? undefined,
      bcc: message.bccAddr ?? undefined,
      subject: message.subject ?? "",
      html: decryptField(message.htmlBody) ?? undefined,
      text: decryptField(message.textBody) ?? undefined,
      inReplyTo: message.inReplyTo ?? undefined,
      references: message.referencesHeader ?? undefined,
      attachments: resolvedAttachments.length
        ? resolvedAttachments.map((a) => ({ filename: a.filename, content: a.dataBase64, contentType: a.contentType }))
        : undefined,
    });

    await db.update(ayzenMailboxMessagesTable).set({
      folder: "sent",
      folderId: null,
      resendEmailId: result.id,
      messageId: result.messageId,
      deliveryStatus: "accepted",
      deliveryStatusAt: new Date(),
      // Undo Send (Phase 2): the window this message ever had is now moot —
      // it's actually gone out. Cleared so a stale chip can't linger on the
      // Outbox row's last-known state if the list hasn't refetched yet
      // (folder flipping to 'sent' already hides it from Outbox regardless,
      // this just keeps the row's own data honest).
      undoExpiresAt: null,
    }).where(eq(ayzenMailboxMessagesTable.id, message.id));

    // Bounce + Complaint Handling (Phase 3) — this is the one place a
    // message is actually, successfully dispatched to Resend, so it's the
    // single choke point for the account-wide sent-count every bounce/
    // complaint rate in lib/mail-sending-health.ts is measured against.
    // Deliberately not counted on the idempotency-guard branch above
    // (line ~237) — that's catching up state for a message already sent,
    // not a new send.
    await recordSendingHealthSend(message.userId);

    await db.update(ayzenMailboxSendQueueTable).set({
      status: "sent", lastError: null,
    }).where(eq(ayzenMailboxSendQueueTable.id, row.id));
    return "sent";
  } catch (err: any) {
    const errorMessage = err?.message ?? String(err);
    const attempts = row.attempts + 1;

    if (attempts >= MAX_SEND_ATTEMPTS) {
      // Give up — same landing spot mail-schedule-cron.ts's abandon path
      // uses (folder: 'drafts', isDraft: true), so a permanently-broken
      // send doesn't retry forever and the user ends up somewhere
      // editable/re-sendable regardless of which send path failed.
      await db.update(ayzenMailboxMessagesTable).set({
        folder: "drafts", isDraft: true, deliveryStatus: "failed", deliveryStatusAt: new Date(),
        undoExpiresAt: null, // Undo Send (Phase 2): no longer in Outbox, nothing left to undo.
      }).where(eq(ayzenMailboxMessagesTable.id, message.id));
      await db.update(ayzenMailboxSendQueueTable).set({
        status: "failed", attempts, lastError: errorMessage,
      }).where(eq(ayzenMailboxSendQueueTable.id, row.id));

      logger.error({ err, messageId: message.id, queueId: row.id, attempts }, "Send queue: send abandoned after max attempts — moved to Drafts");
      logBus.error(`Send Queue: message #${message.id} ("${message.subject ?? "no subject"}") failed ${MAX_SEND_ATTEMPTS}x — moved back to Drafts: ${errorMessage}`);
      return "failed";
    }

    // Not out of attempts yet — back to 'pending' with next_attempt_at
    // pushed forward, same row (attempts bumped) so the next worker tick
    // that reaches its next_attempt_at picks it back up. The message
    // itself stays in 'outbox' throughout the retry window — it only
    // moves to Drafts on final abandonment above. Delivery status goes
    // back to 'queued' (rather than staying 'sending') since it's genuinely
    // waiting again, not in flight.
    const delay = nextAttemptDelay(attempts);
    // undoExpiresAt cleared here too: the worker already claimed this row
    // once (that's why we're in the failure branch at all), so whatever
    // undo window it had has definitionally already closed — the message
    // stays in Outbox for the retry, but not with a stale/expired "Undo"
    // chip still showing on it.
    await db.update(ayzenMailboxMessagesTable).set({ deliveryStatus: "queued", deliveryStatusAt: new Date(), undoExpiresAt: null })
      .where(eq(ayzenMailboxMessagesTable.id, message.id));
    await db.update(ayzenMailboxSendQueueTable).set({
      status: "pending", attempts, lastError: errorMessage,
      nextAttemptAt: new Date(Date.now() + delay),
      lockedAt: null, lockedBy: null,
    }).where(eq(ayzenMailboxSendQueueTable.id, row.id));

    logger.warn({ err, messageId: message.id, queueId: row.id, attempts, retryInMs: delay }, "Send queue: send attempt failed — will retry");
    logBus.warn(`Send Queue: message #${message.id} ("${message.subject ?? "no subject"}") attempt ${attempts}/${MAX_SEND_ATTEMPTS} failed, retrying in ~${Math.round(delay / 1000)}s: ${errorMessage}`);
    return "failed";
  }
}

/** One worker tick: claim a batch, process each row sequentially. Exposed for tests/manual triggering. */
export async function runSendQueueSweep(): Promise<{ claimed: number; sent: number; failed: number }> {
  await recoverStaleLocks();

  const batch = await claimNextBatch(CLAIM_BATCH_SIZE);
  if (!batch.length) return { claimed: 0, sent: 0, failed: 0 };

  let sent = 0, failed = 0;
  for (const row of batch) {
    const outcome = await processQueueRow(row);
    if (outcome === "sent") sent++; else failed++;
  }

  logBus.system(`📤 Send Queue sweep: ${sent} sent, ${failed} failed (of ${batch.length} claimed)`);
  return { claimed: batch.length, sent, failed };
}

/**
 * Per-tick stale-lock sweep: reclaims any row still 'sending' whose
 * locked_at is older than SEND_STUCK_TIMEOUT_MS. Covers the case the
 * startup sweep (below) doesn't — a worker instance that never actually
 * restarts but whose claim silently hung (e.g. an unhandled hang inside
 * sendAsAyzenUser that isn't a normal throw). Deliberately does NOT bump
 * `attempts`: this is recovering an interrupted attempt, not counting a
 * new failure against the message.
 */
async function recoverStaleLocks(): Promise<void> {
  const cutoff = new Date(Date.now() - SEND_STUCK_TIMEOUT_MS);
  const reclaimed = await db.execute(sql`
    UPDATE ayzen_mailbox_send_queue
    SET status = 'pending', next_attempt_at = now(), locked_at = NULL, locked_by = NULL
    WHERE status = 'sending' AND locked_at < ${cutoff}
    RETURNING id, message_id
  `);
  const rows = reclaimed.rows as { id: number; message_id: number }[];
  if (!rows.length) return;

  logger.warn({ count: rows.length, ids: rows.map((r) => r.id) }, "Send queue: reclaimed stale locked rows");
  logBus.warn(`Send Queue: reclaimed ${rows.length} row(s) stuck in 'sending' past ${SEND_STUCK_TIMEOUT_MS / 1000}s (worker likely died mid-send)`);
}

let scheduled = false;

/**
 * Startup recovery: resets any row left in 'sending' back to 'pending' the
 * instant the worker boots. Whatever process last held that lock is, by
 * definition, not this fresh process — so a new worker starting up is
 * itself the recovery point for anything its predecessor left mid-send
 * (deploy restart, OOM kill, etc.). Does NOT bump `attempts` — same
 * reasoning as the per-tick stale-lock sweep: recovering an interrupted
 * attempt isn't a new failure.
 */
async function recoverOnStartup(): Promise<void> {
  const reset = await db.execute(sql`
    UPDATE ayzen_mailbox_send_queue
    SET status = 'pending', next_attempt_at = now(), locked_at = NULL, locked_by = NULL
    WHERE status = 'sending'
    RETURNING id
  `);
  const count = (reset.rows as { id: number }[]).length;
  if (!count) return;

  logger.warn({ count }, "Send queue: reset rows left in 'sending' by a previous worker instance");
  logBus.warn(`Send Queue: reset ${count} row(s) left in 'sending' on startup — recovering from a previous instance's crash/restart`);
}

/**
 * Starts the send-queue worker's poll loop. Runs far more often than the
 * scheduled-send cron (every few seconds, not every minute) since this is
 * the "hit Send and it goes out" path rather than a user-chosen future
 * time — the whole point of moving off the request thread is that it
 * should still feel roughly immediate.
 */
export function startSendQueueWorker(): void {
  if (scheduled) return; // guard against double-init (e.g. hot reload)
  scheduled = true;

  const expr = process.env.MAIL_SEND_QUEUE_CRON ?? "*/5 * * * * *"; // every 5s
  if (!cron.validate(expr)) {
    logger.warn({ expr }, "MAIL_SEND_QUEUE_CRON is not a valid cron expression — Send Queue worker disabled");
    logBus.warn(`Send Queue worker disabled: invalid schedule "${expr}"`);
    return;
  }

  recoverOnStartup().catch((err) => {
    logger.error({ err }, "Send Queue startup recovery failed");
    logBus.error(`Send Queue startup recovery failed: ${err?.message ?? err}`);
  }).finally(() => {
    cron.schedule(expr, () => {
      runSendQueueSweep().catch((err) => {
        logger.error({ err }, "Send Queue sweep failed");
        logBus.error(`Send Queue sweep failed: ${err?.message ?? err}`);
      });
    });

    logBus.system(`✅ Send Queue worker scheduled ("${expr}")`);
    logger.info({ expr, workerId: WORKER_ID }, "Send Queue worker scheduled");
  });
}
