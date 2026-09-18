# Robust Send Queue — Phase 1 (Durable Outbox + Worker)

Replaces the inline, synchronous `sendAsAyzenUser()` call in
`POST /ayzen-email/mailbox/send` with a durable outbox + background worker.
No retry/backoff/crash-recovery yet — that's Phase 2.

## New

- **`migrations/047_ayzen_mailbox_send_queue.sql`** — `ayzen_mailbox_send_queue`
  table (`status`, `attempts`, `next_attempt_at`, `locked_at`/`locked_by`,
  `last_error`), partial index on pending rows, FK index on `message_id`.
- **`artifacts/api-server/src/lib/mail-send-queue.ts`** — `enqueueSend(tx, messageId)`,
  `claimNextBatch()` (atomic `FOR UPDATE SKIP LOCKED` claim), `processQueueRow()`
  (same send logic `mail-schedule-cron.ts` already uses — `resolveAttachmentContent`
  + `sendAsAyzenUser`), `runSendQueueSweep()`, `startSendQueueWorker()`
  (5s poll via `node-cron`, override with `MAIL_SEND_QUEUE_CRON`).

## Changed

- **`lib/db/src/schema/ayzen-mailbox.ts`** — added `'outbox'` to
  `AYZEN_MAILBOX_SYSTEM_FOLDERS`; added `ayzenMailboxSendQueueTable` +
  types.
- **`artifacts/api-server/src/routes/ayzen-mailbox.ts`** —
  `POST /ayzen-email/mailbox/send` (immediate-send branch only; the
  `scheduledSendAt` branch is untouched): message insert/update +
  attachment insert + `enqueueSend()` now run in one `db.transaction()`,
  `folder` is `'outbox'` instead of `'sent'`, no `sendAsAyzenUser()` call
  on the request path. Response is `202 { id, queued: true,
  attachmentCount }` instead of `201 { id, resendId, attachmentCount }`.
  Added `'outbox'` to `NON_MOVE_TARGET_FOLDERS` (same reason
  `'scheduled'`/`'snoozed'` are there — it needs the worker to be the one
  to move it out).
- **`artifacts/api-server/src/index.ts`** — calls `startSendQueueWorker()`
  alongside `startMailScheduleCron()` on boot.
- **`artifacts/ayzen/src/pages/user/mailbox.tsx`** — added `'outbox'` to
  `SYSTEM_FOLDERS` / `FOLDER_ICONS` (`Loader2`) / `FOLDER_LABELS` /
  `NON_MOVE_TARGET_FOLDERS`; compose send handler shows a "Queued —
  Sending from …" toast when the response has `queued: true` instead of
  assuming the message is already Sent.

## Not done here (Phase 2)

- No retry on failed sends — a failed queue row just sits as
  `status: 'failed'`, message stays in `'outbox'`.
- No exponential backoff — `next_attempt_at` is always "now" in Phase 1.
- No crash recovery — a row a worker claimed (`status: 'sending'`) and
  never finished (process killed mid-send) stays locked forever until
  Phase 2's startup/stale-lock sweep exists.
- Scheduled Send (`lib/mail-schedule-cron.ts`) is untouched — still its
  own separate cron with its own `scheduleAttempts` retry logic; folding
  it into this queue is an optional Phase 2 cleanup step, not required.

## Before running

- Run migration 047.
- No env var required — `MAIL_SEND_QUEUE_CRON` optionally overrides the
  default 5-second poll interval.
