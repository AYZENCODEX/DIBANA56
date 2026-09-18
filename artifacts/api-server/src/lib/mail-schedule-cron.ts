/**
 * lib/mail-schedule-cron.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Scheduled Send. routes/ayzen-mailbox.ts's POST /send stores a message with
 * folder = 'scheduled' + scheduledSendAt instead of actually sending it when
 * the caller passes a future scheduledSendAt (see migrations/
 * 045_ayzen_mailbox_schedule_analytics.sql for the columns + partial index
 * this sweep reads).
 *
 * Robust Send Queue Phase 2 folded this sweep's *send* path into the
 * general queue (lib/mail-send-queue.ts): once a message becomes due, a
 * queue row's own worker does the real Resend call, with the queue's own
 * retry/backoff/crash-recovery/abandon-to-Drafts handling everything that
 * used to be this file's bespoke scheduleAttempts loop.
 *
 * Undo Send Phase 2 went a step further and folded the *detection* half in
 * too: routes/ayzen-mailbox.ts's scheduled branch now calls enqueueSend()
 * at schedule time (delayMs = scheduledSendAt - now), so a scheduled
 * message has a real 'pending' send-queue row from the moment it's
 * scheduled — the send queue's own 5-second worker (claimNextBatch() in
 * mail-send-queue.ts) picks it up the instant it's due, same as any other
 * queue row, with no separate detection step needed. reschedule/
 * cancel-schedule (routes/ayzen-mailbox.ts) push/cancel that same row
 * directly, the exact 'pending'-guarded pattern PATCH /:id/undo-send
 * already used for immediate sends — one unified guard for both send
 * paths instead of two bespoke ones.
 *
 * This file now only exists as a backstop: a message can end up
 * folder = 'scheduled' with no live queue row behind it in a couple of
 * edge cases — a row created before this Phase 2 change shipped (nothing
 * ever enqueued it), or an operator restoring an old DB snapshot. This
 * sweep finds anything like that and re-enqueues it (delay 0, i.e. "send
 * ASAP") rather than leaving it silently stuck in Scheduled forever. It
 * deliberately runs far less often than it used to (minutes, not seconds)
 * — on the normal path there's nothing here for it to find.
 */
import cron from "node-cron";
import { db, ayzenMailboxMessagesTable } from "@workspace/db";
import { eq, and, lte, sql } from "drizzle-orm";
import { logger } from "./logger";
import { logBus } from "./log-bus";
import { enqueueSend } from "./mail-send-queue";

export async function runMailScheduleSweep(): Promise<{ checked: number; queued: number }> {
  // Orphan check: folder = 'scheduled', due, and no send-queue row for it
  // that's still 'pending' or already 'sending'/'sent' — i.e. genuinely
  // nothing left tracking this message. A NOT EXISTS subquery rather than a
  // join keeps this cheap on the common case (the result set should almost
  // always be empty).
  const due = await db.select().from(ayzenMailboxMessagesTable)
    .where(and(
      eq(ayzenMailboxMessagesTable.folder, "scheduled"),
      lte(ayzenMailboxMessagesTable.scheduledSendAt, new Date()),
      sql`NOT EXISTS (
        SELECT 1 FROM ayzen_mailbox_send_queue q
        WHERE q.message_id = ${ayzenMailboxMessagesTable.id}
          AND q.status IN ('pending', 'sending', 'sent')
      )`,
    ));

  if (!due.length) return { checked: 0, queued: 0 };

  let queued = 0;
  for (const message of due) {
    await db.transaction(async (tx) => {
      await tx.update(ayzenMailboxMessagesTable).set({ scheduledSendAt: null }).where(eq(ayzenMailboxMessagesTable.id, message.id));
      await enqueueSend(tx, message.id, 0);
    });
    queued++;
  }

  logger.warn({ checked: due.length, queued }, "Scheduled Send backstop sweep: found orphaned scheduled message(s) with no live queue row — re-enqueued");
  logBus.warn(`Scheduled Send backstop: ${queued} orphaned message(s) had no send-queue row — re-enqueued for immediate send`);
  return { checked: due.length, queued };
}

let scheduled = false;

export function startMailScheduleCron(): void {
  if (scheduled) return; // guard against double-init (e.g. hot reload)
  scheduled = true;

  // Backstop cadence only (see file header) — every 5 minutes is plenty for
  // "catch anything that somehow slipped through", where the normal path
  // now goes through the 5-second send-queue worker instead.
  const expr = process.env.MAIL_SCHEDULE_CRON ?? "*/5 * * * *";
  if (!cron.validate(expr)) {
    logger.warn({ expr }, "MAIL_SCHEDULE_CRON is not a valid cron expression — Scheduled Send backstop sweep disabled");
    logBus.warn(`Scheduled Send backstop sweep disabled: invalid schedule "${expr}"`);
    return;
  }

  cron.schedule(expr, () => {
    runMailScheduleSweep().catch((err) => {
      logger.error({ err }, "Scheduled Send backstop sweep failed");
      logBus.error(`Scheduled Send backstop sweep failed: ${err?.message ?? err}`);
    });
  });

  logBus.system(`✅ Scheduled Send backstop sweep scheduled ("${expr}")`);
  logger.info({ expr }, "Scheduled Send backstop sweep scheduled");
}
